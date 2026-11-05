"""
Raadio controller — continuous stream version.

One FFmpeg encoder stays connected to Icecast for as long as the server runs.
Each track is decoded to raw audio and piped into it, and silence fills any wait
(a slow download, a channel rescan), so listeners are never disconnected between
songs, skips are gapless, and phones with the screen off keep playing.

Settings come from .env (see .env.example). Run from the repo root:
    python -u controller/radio_controller.py
"""
import asyncio
import math
from contextlib import contextmanager
import os
import random
import re
import sqlite3
import subprocess
from datetime import datetime, UTC
import sys
import threading
import time
import traceback
from array import array
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pyrogram import Client, enums

# =====================================================================
# CONFIG  -- read from environment variables, or from a .env file.
# No secrets live in this file. See .env.example for every setting.
# =====================================================================
from pathlib import Path
from urllib.parse import quote

BASE_DIR = Path(__file__).resolve().parent.parent      # repo root


def _load_dotenv():
    """Minimal .env reader (KEY=VALUE lines). Real environment variables win."""
    for candidate in (Path.cwd() / ".env", BASE_DIR / ".env"):
        if candidate.is_file():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.split(" #", 1)[0]
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
            return


_load_dotenv()


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and (value is None or value == ""):
        raise SystemExit(f"Missing setting {name}. Add it to .env (see .env.example).")
    return value


def env_bool(name, default):
    return str(env(name, str(default))).strip().lower() in ("1", "true", "yes", "on")


def data_path(value):
    """Relative paths are resolved against the repo root, not the current folder."""
    path = Path(value)
    return path if path.is_absolute() else BASE_DIR / path


# ---- Telegram --------------------------------------------------------
API_ID = int(env("TG_API_ID", required=True))
API_HASH = env("TG_API_HASH", required=True)
SESSION_NAME = env("TG_SESSION_NAME", "radio_user")       # data/<name>.session
CHANNEL_ID = int(env("TG_CHANNEL_ID", required=True))

# ---- Files (all under data/, which Git ignores) ----------------------
DATA_DIR = data_path(env("DATA_DIR", "data"))
DB_FILE = str(data_path(env("DB_PATH", str(DATA_DIR / "radio_analytics.db"))))
DOWNLOAD_DIR = data_path(env("DOWNLOAD_DIR", str(DATA_DIR / "downloads")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ---- Icecast ---------------------------------------------------------
ICECAST_HOST = env("ICECAST_HOST", "127.0.0.1")
ICECAST_PORT = int(env("ICECAST_PORT", "8000"))
_ICECAST_PASSWORD = quote(env("ICECAST_SOURCE_PASSWORD", required=True), safe="")
_ICECAST_BASE = f"icecast://source:{_ICECAST_PASSWORD}@{ICECAST_HOST}:{ICECAST_PORT}"
ICECAST_URL = f"{_ICECAST_BASE}/radio.mp3"

BITRATE = env("MP3_BITRATE", "128k")          # MP3 mount, for older iPhones and car stereos

# ---- Opus mounts ---------------------------------------------------------
# Same audio on more Icecast mounts, same password. Listeners pick in the player:
#   /radio.opus       "HQ" (default): 64 kbps, close to CD quality, ~29 MB an hour
#   /radio-lite.opus  "Saver": 32 kbps, for slow or expensive connections, ~14 MB an hour
OPUS_ENABLED = env_bool("OPUS_ENABLED", True)
OPUS_BITRATE = env("OPUS_BITRATE", "64k")
OPUS_URL = f"{_ICECAST_BASE}/radio.opus"
OPUS_LITE_BITRATE = env("OPUS_LITE_BITRATE", "32k")   # empty = no Saver mount
OPUS_LITE_URL = f"{_ICECAST_BASE}/radio-lite.opus"
# "Saver" for devices without Opus (Safari on older Macs and iPhones): MP3 at half the rate
MP3_LITE_BITRATE = env("MP3_LITE_BITRATE", "64k")     # empty = no MP3 Saver mount
MP3_LITE_URL = f"{_ICECAST_BASE}/radio-lite.mp3"

# Relays (e.g. a server inside Iran) that re-serve the streams: their listeners are
# added to the curator's counts. Comma-separated status URLs, see relay/README.md.
RELAY_STATUS_URLS = [u.strip() for u in env("RELAY_STATUS_URLS", "").split(",") if u.strip()]

# ---- Loudness leveling ---------------------------------------------------
NORMALIZE = env_bool("NORMALIZE", True)
# How the loudness is evened out. "track" (default): each song's loudness is measured before
# it plays and it's turned up or down to the target, with a fast peak limiter on the way out
# (no added delay). "stream": the old continuous leveler (FFmpeg loudnorm), which looks 3 s
# ahead and so adds 3 s to everything a listener hears (skips, the title, the waveform).
LOUDNESS_MODE = env("LOUDNESS_MODE", "track").strip().lower()
LOUDNESS_TARGET = env("LOUDNESS_TARGET", "-14")   # LUFS; -14 like the big streaming apps (was -16: too quiet next to other audio)
LOUDNESS_RANGE = env("LOUDNESS_RANGE", "11")      # LU of dynamics kept within a track
# Opus goes out in Ogg pages of this many seconds. FFmpeg's default (1 s) held the audio back
# until a whole second had been encoded, so the stream arrived ~1 s late and in 1 s lumps.
OGG_PAGE = 0.25
# Seconds from a sound reaching the encoder to it leaving Icecast, per codec (measured with
# FFmpeg 6.1: MP3 frames go out at once; Ogg holds back about a page and a half), plus
# loudnorm's 3 s look-ahead in "stream" mode. See stream_edge().
_LEVELER_DELAY = 3.0 if (NORMALIZE and LOUDNESS_MODE == "stream") else 0.0
OUT_DELAY = {"mp3": 0.1 + _LEVELER_DELAY, "opus": 0.02 + 1.5 * OGG_PAGE + _LEVELER_DELAY}

# ---- Web API -----------------------------------------------------------
API_HOST = env("API_HOST", "127.0.0.1")       # 127.0.0.1 = only Nginx can reach it
API_PORT = int(env("API_PORT", "8080"))

# ---- Skip voting ----------------------------------------------------
SKIP_VOTES_NEEDED = 2          # different listeners (IPs) needed to skip
VOTE_WINDOW = 90               # seconds a vote stays valid
# Each device votes on its own, but one internet address can't cast more than this many
# (stops one person faking a crowd by clearing their browser)
VOTES_PER_IP = max(1, int(os.getenv("VOTES_PER_IP", "3")))
SKIP_FADE_SECONDS = 0.35       # short fade-out instead of a hard cut
PREFETCH = 2                   # songs kept downloaded and measured in line, so even skips in a row go straight on
DECODER_STALL = 10             # seconds without audio from a decoder before giving up on the file
WATCHDOG_AFTER = 8             # seconds without audio sent before the watchdog reports

# ---- Tier system ----------------------------------------------------
# skip_score >= TIER_LIMITS[i]  ->  tier i+2.   Tier 5 = banned forever.
TIER_LIMITS = (1, 2, 3, 4)       # ~4 net skips bans a song (was 8)
SKIP_PENALTY = 1.0             # added to score when a song is vote-skipped
FINISH_CREDIT = 0.5            # removed from score when a song plays to the end
LIKE_CREDIT = 0.25             # removed from score for each listener's thumbs-up (the reverse of a skip)

# ---- Raw audio between the decoders and the encoder ------------------
SAMPLE_RATE = 44100
CHANNELS = 2
FRAME = 2 * CHANNELS                        # bytes per sample frame (16-bit)
BYTES_PER_SEC = SAMPLE_RATE * FRAME         # 176,400
CHUNK = BYTES_PER_SEC // 50                 # 20 ms per write (in 100 ms steps the stream's newest
                                            # audio jumped about, and players' timing with it)
SILENCE = bytes(CHUNK)
LEAD = 1.0                                  # seconds of audio kept queued ahead of real time

TG_APP = Client(SESSION_NAME, api_id=API_ID, api_hash=API_HASH, workdir=str(DATA_DIR))

# ---- Studio (logins, uploads, the shared schedule) ---------------------
# Scheduled items cut in on time: the song on air fades out and the item plays.
from studio import Studio                 # noqa: E402  (needs DATA_DIR from above)
from studio_api import build_router       # noqa: E402
from curator import Audience, ListenerStats, Tiers, build_curator_router   # noqa: E402
from geo import CountryLookup              # noqa: E402
from vibe import VibeCache                 # noqa: E402
from notes import FlamingoNotes, build_notes_router   # noqa: E402
from live import LiveStudio, add_pcm, build_live_router     # noqa: E402

UPLOAD_MAX_MB = int(env("UPLOAD_MAX_MB", "50"))
# Sites whose pages may call the studio API from another name (the player falls back
# between raadio.xyz and raadio.run.place). Add a relay's studio name in .env if it uses one.
STUDIO_ORIGINS = ["https://raadio.xyz", "https://raadio.run.place"] + [
    o.strip().rstrip("/") for o in env("STUDIO_ORIGINS", "").split(",") if o.strip()]
STUDIO = Studio(DATA_DIR)
CLEANUP_EVERY = 3600                       # seconds between studio housekeeping runs

# =====================================================================
# STATE
# =====================================================================
current_decoder = None         # FFmpeg decoding the track on air
current_track_id = None
current_track_title = "Unknown Track"
current_track_artist = ""
current_track_started = 0.0
current_track_path = None
current_wave_key = None         # key for /api/wave/{key}: the player's waveform follows it
VIBE = VibeCache()
current_is_show = False        # a scheduled studio item is on air (can't be vote-skipped)
skip_votes = {}                # "ip|device" (or "user:name") -> (time of the vote, its weight)
song_likes = set()             # who gave the song on air a thumbs-up (one each per song)
recent_aired = []              # the songs before this one, newest first: {title, artist, started}


def _vote_weights():
    """VOTE_WEIGHTS=alice=2,bob=3: studio users whose skip vote counts more than one."""
    out = {}
    for part in os.getenv("VOTE_WEIGHTS", "").split(","):
        name, _, w = part.strip().partition("=")
        try:
            if name and int(w) > 1:
                out[name.lower()] = int(w)
        except ValueError:
            pass
    return out


VOTE_WEIGHTS = _vote_weights()


def votes_in():
    return sum(w for _t, w in skip_votes.values())
skip_requested = False
broadcaster = None


# =====================================================================
# DATABASE (track stats: plays, skips, tiers)
# =====================================================================
@contextmanager
def db():
    """One short-lived connection: commits on success, always closes. WAL (set once in
    init_db) lets the studio read while the radio writes, and a write waits up to 10 s
    for a lock instead of failing."""
    conn = sqlite3.connect(DB_FILE, timeout=10)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS play_log (
                ts INTEGER NOT NULL,
                telegram_msg_id INTEGER NOT NULL,
                reason TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS play_log_ts ON play_log (ts)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS track_stats (
                telegram_msg_id INTEGER PRIMARY KEY,
                title TEXT,
                play_count INTEGER DEFAULT 0,
                skip_count INTEGER DEFAULT 0,
                is_blacklisted INTEGER DEFAULT 0,
                tier INTEGER DEFAULT 1,
                skip_score REAL DEFAULT 0
            )
        """)
        existing = {row[1] for row in conn.execute("PRAGMA table_info(track_stats)")}
        if "tier" not in existing:
            conn.execute("ALTER TABLE track_stats ADD COLUMN tier INTEGER DEFAULT 1")
        if "skip_score" not in existing:
            conn.execute("ALTER TABLE track_stats ADD COLUMN skip_score REAL DEFAULT 0")
        if "boost" not in existing:      # curator's "play this more often" (0-3), tier unchanged
            conn.execute("ALTER TABLE track_stats ADD COLUMN boost INTEGER DEFAULT 0")
        # About each post in the channel: who posted it (the channel's signature, when the
        # channel signs posts), its hashtags, when it was posted, and when it was pinned
        # (pinned_at: kept while it stays pinned, cleared when it's unpinned)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS track_meta (
                telegram_msg_id INTEGER PRIMARY KEY,
                posted_by TEXT,
                posted_at REAL,
                tags TEXT,
                pinned_at REAL
            )
        """)


def save_track_meta(meta):
    """meta: {msg_id: {"by", "at", "tags"}} from a channel scan."""
    with db() as conn:
        conn.executemany("""
            INSERT INTO track_meta (telegram_msg_id, posted_by, posted_at, tags) VALUES (?, ?, ?, ?)
            ON CONFLICT(telegram_msg_id) DO UPDATE SET
                posted_by = excluded.posted_by, posted_at = excluded.posted_at, tags = excluded.tags
        """, [(i, m.get("by"), m.get("at"), " ".join(sorted(m.get("tags") or ()))) for i, m in meta.items()])


def remember_pins(pinned_ids, pin_dates):
    """The posts pinned right now -> {msg_id: when it was pinned}. The date comes from the
    channel's "pinned a message" notice when there is one, otherwise from when the radio
    first saw it pinned. Unpinned posts lose their date, so pinning again starts afresh."""
    now = time.time()
    with db() as conn:
        if pinned_ids:
            conn.execute("UPDATE track_meta SET pinned_at = NULL WHERE pinned_at IS NOT NULL AND telegram_msg_id NOT IN "
                         f"({','.join('?' * len(pinned_ids))})", list(pinned_ids))
        else:
            conn.execute("UPDATE track_meta SET pinned_at = NULL WHERE pinned_at IS NOT NULL")
        out = {}
        for i in pinned_ids:
            row = conn.execute("SELECT pinned_at FROM track_meta WHERE telegram_msg_id = ?", (i,)).fetchone()
            at = pin_dates.get(i) or (row[0] if row and row[0] else now)
            conn.execute("""INSERT INTO track_meta (telegram_msg_id, pinned_at) VALUES (?, ?)
                            ON CONFLICT(telegram_msg_id) DO UPDATE SET pinned_at = excluded.pinned_at""", (i, at))
            out[i] = at
    return out


def log_track_start(msg_id, title, reason="rotation"):
    """reason: why it was picked (TrackQueue.next), for the studio's most played list."""
    with db() as conn:
        now = int(time.time())
        conn.execute("INSERT INTO play_log VALUES (?, ?, ?)", (now, msg_id, reason))
        conn.execute("DELETE FROM play_log WHERE ts < ?", (now - 400 * 86400,))
        conn.execute("""
            INSERT INTO track_stats (telegram_msg_id, title, play_count)
            VALUES (?, ?, 1)
            ON CONFLICT(telegram_msg_id) DO UPDATE SET
                play_count = play_count + 1,
                title = excluded.title
        """, (msg_id, title))


def record_result(msg_id, skipped):
    """Update a track's score/tier after it was skipped or played to the end."""
    with db() as conn:
        row = conn.execute(
            "SELECT skip_score FROM track_stats WHERE telegram_msg_id = ?", (msg_id,)
        ).fetchone()
        if not row:
            return
        old = row[0] or 0.0
        score = max(0.0, old + (SKIP_PENALTY if skipped else -FINISH_CREDIT))
        tier = 1 + sum(score >= limit for limit in TIER_LIMITS)
        conn.execute(
            "UPDATE track_stats SET skip_score = ?, tier = ?, skip_count = skip_count + ?"
            + (", is_blacklisted = 1" if tier >= 5 else "") + " WHERE telegram_msg_id = ?",
            (score, tier, 1 if skipped else 0, msg_id),
        )
    print(f"Track {msg_id}: score={score}, tier={tier}{' (BANNED)' if tier >= 5 else ''}")


def load_track_info():
    """Return (banned_ids, tiers, boosts) from the database."""
    with db() as conn:
        rows = conn.execute(
            "SELECT telegram_msg_id, tier, is_blacklisted, boost FROM track_stats"
        ).fetchall()
    banned = {r[0] for r in rows if r[2] == 1 or (r[1] or 1) >= 5}
    tiers = {r[0]: (r[1] or 1) for r in rows}
    boosts = {r[0]: (r[3] or 0) for r in rows}
    return banned, tiers, boosts


# =====================================================================
# BROADCASTER: the one connection to Icecast
# =====================================================================
# The sound. SOUND=clean (the default): every song exactly as it was uploaded, only turned up
# or down to the same loudness as the others (LOUDNESS_TARGET), with a peak limiter last of
# all. Compared side by side with the songs as they play in Telegram, the station sound below
# was worse: on two songs it scooped ~3 dB out of the low mids (the body of voices and
# instruments), added treble the masters didn't have, narrowed the stereo image and added
# 2.5-4 dB more distortion and noise than everything else together; the codec itself (Opus HQ)
# changed the tone by under 0.3 dB. So it's off, but kept: SOUND=station brings it all back
# (and only then do MATCH_EQ, VINYL and VINYL_NOISE count, so old .env lines can't).
#
# SOUND=station: the station's sound, finished once on the server so every listener hears it
# on every device, and before the encoders.
#  - a gentle station EQ: a little warmth low down, less boxiness around 300 Hz; then per
#    quality, HQ gets a touch of clarity and air on top, Saver (whose top the encoder cuts)
#    gets presence in the middle instead
#  - a vinyl processor, after the idea of Sony's Walkman one: what a record on a turntable
#    adds to the sound. The tonearm's resonance (a soft, slightly ringing bump in the low
#    bass); acoustic feedback (the speakers' low end reaching the stylus again a few
#    milliseconds later, which thickens the sound); a little valve-and-groove warmth (soft,
#    mostly even harmonics, mixed in under the clean sound); the soft top end of a record and
#    a rumble filter; and, faintly, its surface: a few soft crackles and a breath of hiss.
#    VINYL=0 turns it off; VINYL_NOISE=0 keeps it but drops the surface noise.
STATION_SOUND = env("SOUND", "clean").strip().lower() == "station"
VINYL = STATION_SOUND and env_bool("VINYL", True)
VINYL_NOISE = env_bool("VINYL_NOISE", True)


def _valve(ch):
    # tanh with a small bias (the lopsidedness is the even harmonics), less its offset, scaled
    # so quiet sound passes at its own level; only the difference from the clean sound
    z = math.tanh(1.8 * 0.12)
    return f"0.5*((tanh(1.8*(val({ch})+0.12))-{z:.5f})/{1.8 * (1 - z * z):.5f}-val({ch}))"


_SOUND_CHECKED = []


def _sound_works(chain):
    """Can this server's FFmpeg run the vinyl processor? (checked once, on a moment of
    silence: an older FFmpeg missing a filter option must not keep the station off air)"""
    try:
        r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", "anullsrc=r=48000:cl=stereo", "-t", "0.3",
                            "-filter_complex", "[0:a]" + chain + "anull[o]", "-map", "[o]", "-f", "null", "-"],
                           capture_output=True, timeout=20, check=False)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def station_sound():
    """The filters every output shares (ends in a comma, or is empty)."""
    global VINYL
    if not STATION_SOUND:
        return ""
    # (measured on pink noise against 1 kHz: a smooth rise of +1.5..+2.5 dB below 100 Hz, a
    # small dip round 200-300 Hz for the mud, +0.8 dB of presence at 3 kHz, flat above. The
    # old one was lumpy down low: +2.5 dB at 45 Hz, a dip at 95, a bump at 130.)
    eq = "bass=g=1.4:f=100:t=s:w=0.6,equalizer=f=300:t=q:w=0.8:g=-1,equalizer=f=3000:t=q:w=0.9:g=0.8,"
    if VINYL and not _SOUND_CHECKED:
        _SOUND_CHECKED.append(1)
        if not _sound_works(_vinyl(eq)):
            print("Sound: this FFmpeg can't run the vinyl processor; playing without it")
            VINYL = False
    return _vinyl(eq) if VINYL else eq


def _vinyl(eq):
    arm = "highpass=f=28:p=2,"         # (the narrow +1.5 dB at 72 Hz stacked on the bass: gone)
    split = "asplit=3[vd][vf][vw];"
    # (1 ms behind: 7 ms combed the bass, a dip at 95 Hz and a bump at 130)
    feedback = "[vf]highpass=f=40,lowpass=f=260,adelay=1|1,volume=-15dB[vfb];"
    warmth = f"[vw]aeval=exprs='{_valve(0)}|{_valve(1)}':c=same,highpass=f=18[vwm];"
    parts, n = "[vd][vfb][vwm]", 3
    noise = ""
    if VINYL_NOISE:
        # (a crackle every few hundred ms on average, softened to the clicks of a clean record,
        # and hiss some 70 dB down)
        noise = ("aevalsrc=exprs='if(lt(random(0)\\,0.00005)\\,(random(1)-0.5)*0.2\\,0)+(random(2)-0.5)*0.0012'"
                 ":s=48000:c=mono,highpass=f=350,lowpass=f=5500,aformat=channel_layouts=stereo[vn];")
        parts, n = parts + "[vn]", 4
    return (eq + arm + split + feedback + warmth + noise + parts
            + f"amix=inputs={n}:duration=first:normalize=0,lowpass=f=17500:w=0.5,")


def station_finish():
    """The last touch before the peak limiter (ends in a comma). HQ and Saver get the same
    finish, so switching between them (the player crossfades one into the other) changes
    nothing but the codec's own top end; they used to differ by up to 1.5 dB. Being the
    same, it runs once for every stream, before they split (four copies of it and of the
    limiter made the same samples four times: ~6% of the encoder's work)."""
    return "treble=g=2:f=10000:t=s:w=0.6," if STATION_SOUND else ""


def encoder_command(mp3_url, opus_url=None, lite_url=None, mp3_lite_url=None):
    """One encoder: raw PCM in, MP3 (+ Opus HQ + Opus Saver + MP3 Saver) out.

    With NORMALIZE on, songs arrive already turned to the target loudness (play_file); in
    "stream" mode it's one continuous EBU R128 leveler (loudnorm) instead, which costs ~3 s of
    extra delay. Then, with SOUND=station only, a soft compressor, the station sound
    (station_sound: EQ and the vinyl processor) and the finish; always a peak limiter last. Opus goes out in short
    Ogg pages (OGG_PAGE) so it reaches listeners as steadily as MP3 does.
    """
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
           "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "-i", "pipe:0"]

    def opus(bitrate, url):
        return ["-c:a", "libopus", "-b:a", bitrate, "-vbr", "on", "-application", "audio",
                "-ar", "48000", "-content_type", "audio/ogg", "-f", "ogg",
                "-page_duration", str(int(OGG_PAGE * 1_000_000)), "-flush_packets", "1", url]

    outputs = [["-c:a", "libmp3lame", "-b:a", BITRATE, "-content_type", "audio/mpeg",
                "-f", "mp3", mp3_url]]
    if opus_url:
        outputs.append(opus(OPUS_BITRATE, opus_url))
    if lite_url:
        outputs.append(opus(OPUS_LITE_BITRATE, lite_url))
    if mp3_lite_url:
        outputs.append(["-c:a", "libmp3lame", "-b:a", MP3_LITE_BITRATE, "-content_type", "audio/mpeg",
                        "-f", "mp3", mp3_lite_url])

    if NORMALIZE and LOUDNESS_MODE == "stream":
        level = f"loudnorm=I={LOUDNESS_TARGET}:TP=-1.5:LRA={LOUDNESS_RANGE},aresample=48000,"
    elif NORMALIZE and not STATION_SOUND:
        level = "aresample=48000,"     # (songs arrive already at the target loudness: clean, see SOUND)
    elif NORMALIZE:
        # songs arrive already at the target loudness and tone (play_file); a soft compressor
        # (about 2:1 above -18 dB, slow enough not to pump) holds the music together a
        # little, the way a radio station's does (no look-ahead: nothing is held back the way
        # loudnorm's 3 s window was)
        level = "acompressor=threshold=-18dB:ratio=1.8:attack=25:release=280:knee=6:detection=rms:makeup=1.6dB,aresample=48000,"
    else:
        level = "aresample=48000,"
    # the peak limiter last of all, then one copy of the sound for each output
    graph = ("[0:a]" + level + station_sound() + station_finish()
             + "alimiter=limit=0.84:attack=5:release=60:level=disabled,"
             + f"asplit={len(outputs)}" + "".join(f"[o{k}]" for k in range(len(outputs))))
    cmd += ["-filter_complex", graph]
    for k, out in enumerate(outputs):
        cmd += ["-map", f"[o{k}]", *out]
    return cmd


def stream_edge():
    """Seconds by which each stream's newest audio, as it leaves Icecast, is ahead of its
    due time: the broadcaster keeps ~LEAD queued in front of real time, and the encoder (and
    the Opus pages) hold a little back. A listener hears a moment `edge` seconds before it's
    due, plus whatever their player has buffered."""
    lead = LEAD + CHUNK / BYTES_PER_SEC / 2      # (the queue tops up in CHUNK steps)
    return {k: round(lead - d, 3) for k, d in OUT_DELAY.items()}


class Broadcaster:
    """Feeds raw PCM into a single FFmpeg encoder at real-time speed.

    The pacing matters: Icecast doesn't slow a source down, so sending audio
    faster than real time would pile up in listeners' buffers.
    """

    def __init__(self):
        self.proc = None
        self.t0 = 0.0
        self.sent = 0
        self.last_write = 0.0          # for the watchdog

    async def start(self):
        lite = OPUS_ENABLED and bool(OPUS_LITE_BITRATE)
        cmd = encoder_command(ICECAST_URL, OPUS_URL if OPUS_ENABLED else None,
                              OPUS_LITE_URL if lite else None,
                              MP3_LITE_URL if MP3_LITE_BITRATE else None)
        self.proc = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL
        )
        self.t0 = time.monotonic()
        self.sent = 0
        print("Encoder started, streaming to Icecast"
              + (f" (/radio.mp3 {BITRATE} + /radio.opus {OPUS_BITRATE}"
                 + (f" + /radio-lite.opus {OPUS_LITE_BITRATE}" if lite else "") + ")"
                 if OPUS_ENABLED else f" (/radio.mp3 {BITRATE})")
              + (f" + /radio-lite.mp3 {MP3_LITE_BITRATE}" if MP3_LITE_BITRATE else "")
              + (f", loudness leveled to {LOUDNESS_TARGET} LUFS"
                 + (" (continuous)" if LOUDNESS_MODE == "stream" else " per track") if NORMALIZE else "")
              + (", station sound (EQ, compressor" + (", vinyl" if VINYL else "") + ")" if STATION_SOUND else ", clean sound"))

    async def _ensure(self):
        if self.proc is not None and self.proc.returncode is None:
            return
        if self.proc is not None:
            print(f"Encoder stopped (code {self.proc.returncode}); restarting in 2 s")
            await asyncio.sleep(2)
        await self.start()

    async def write(self, data: bytes):
        await self._ensure()
        ahead = self.sent / BYTES_PER_SEC - (time.monotonic() - self.t0)
        if ahead > LEAD:
            await asyncio.sleep(ahead - LEAD)
        elif ahead < -2.0:
            # The event loop stalled; carry on from now instead of bursting to catch up
            self.t0 = time.monotonic() - self.sent / BYTES_PER_SEC
        try:
            self.proc.stdin.write(data)
            await self.proc.stdin.drain()
            self.sent += len(data)
            self.last_write = time.monotonic()
        except (BrokenPipeError, ConnectionResetError):
            print("Encoder pipe closed (Icecast restarted or rejected the source?)")
            await self.stop()

    def ahead(self) -> float:
        """Seconds of audio already handed to the encoder but not yet due (up to LEAD).
        A track that starts now is really heard this much later."""
        if not self.sent:
            return 0.0
        return max(0.0, self.sent / BYTES_PER_SEC - (time.monotonic() - self.t0))

    def clock(self):
        """When the encoder's first sample was due, on this server's wall clock (None while
        it isn't running). The encoder counts samples from there, and an Opus stream carries
        that count (Ogg granule positions), which Chrome reports as the audio's currentTime:
        so a player can tell exactly which moment it is playing, whatever it has buffered."""
        if self.proc is None or self.proc.returncode is not None or not self.sent:
            return None
        return time.time() - (time.monotonic() - self.t0)

    async def pump_until(self, task, stop=None):
        """Stream silence until the task finishes (or stop() turns true)."""
        while not task.done():
            if stop is not None and stop():
                return
            await self.write(SILENCE)

    async def stop(self):
        proc, self.proc = self.proc, None
        if proc is None:
            return
        if proc.returncode is None:
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                await asyncio.wait_for(proc.wait(), 3)
            except TimeoutError:
                proc.kill()
                await proc.wait()
        # keep the exit code visible for the restart message
        self.proc = proc


def print_await_chain(task):
    """Every coroutine the task is waiting through, outermost first."""
    coro = task.get_coro()
    seen = 0
    while coro is not None and seen < 30:
        frame = getattr(coro, "cr_frame", None) or getattr(coro, "gi_frame", None)
        if frame is not None:
            print(f"  {frame.f_code.co_filename}:{frame.f_lineno} in {frame.f_code.co_name}")
        coro = getattr(coro, "cr_await", None) or getattr(coro, "gi_yieldfrom", None)
        seen += 1
    if coro is not None:
        print(f"  ... waiting on {coro!r}")
    sys.stdout.flush()


def start_watchdog(loop, radio_task):
    """If no audio reaches the encoder for WATCHDOG_AFTER seconds, print where the
    radio loop is. Runs in its own thread so it works even if the event loop froze."""
    main_id = threading.main_thread().ident

    def run():
        reported = False
        while not radio_task.done():
            time.sleep(2)
            bc = broadcaster
            if not bc or not bc.last_write:
                continue
            idle = time.monotonic() - bc.last_write
            if idle < WATCHDOG_AFTER:
                reported = False
                continue
            if reported:
                continue
            reported = True
            print(f"WATCHDOG: no audio sent for {idle:.0f} s. Main thread is at:")
            frame = sys._current_frames().get(main_id)
            if frame is not None:
                traceback.print_stack(frame, file=sys.stdout)
            print("WATCHDOG: radio loop task is waiting at:")
            loop.call_soon_threadsafe(lambda: print_await_chain(radio_task))
            sys.stdout.flush()

    threading.Thread(target=run, name="watchdog", daemon=True).start()


def fade(chunk: bytes, start: float, end: float) -> bytes:
    """Linear gain ramp over 16-bit stereo PCM."""
    samples = array("h")
    samples.frombytes(chunk[: len(chunk) // FRAME * FRAME])
    frames = len(samples) // CHANNELS
    for i in range(frames):
        g = start + (end - start) * i / max(1, frames)
        for c in range(CHANNELS):
            j = i * CHANNELS + c
            samples[j] = int(samples[j] * g)
    return samples.tobytes()


# =====================================================================
# APP
# =====================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    clear_leftovers()                  # nothing is playing yet: every song file is stray
    radio_task = asyncio.create_task(live_radio_loop())

    def _died(task):
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            print("Radio loop stopped:\n" + "".join(
                traceback.format_exception(type(exc), exc, exc.__traceback__)))
            os._exit(1)          # Docker restarts the controller within seconds
    radio_task.add_done_callback(_died)
    start_watchdog(asyncio.get_running_loop(), radio_task)
    stats_task = asyncio.create_task(LISTENER_STATS.run())
    audience_task = asyncio.create_task(AUDIENCE.run())
    geo_task = asyncio.create_task(GEO.keep_fresh())
    notes_task = asyncio.create_task(NOTES.run())
    yield
    notes_task.cancel()
    stats_task.cancel()
    audience_task.cancel()
    geo_task.cancel()
    radio_task.cancel()
    if current_decoder and current_decoder.returncode is None:
        current_decoder.kill()
    if broadcaster:
        await broadcaster.stop()


app = FastAPI(lifespan=lifespan)

# Listeners' endpoints answer any site (relays, players opened under another name); the
# studio API only answers pages from our own names.
PUBLIC_PATHS = re.compile(r"^/(now-playing|skip|note)$|^/api/(upcoming|track/|wave/|chat$)")


class SplitCORS:
    def __init__(self, app):
        methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
        self.public = CORSMiddleware(app, allow_origins=["*"], allow_methods=methods, allow_headers=["*"])
        self.studio = CORSMiddleware(app, allow_origins=STUDIO_ORIGINS, allow_methods=methods, allow_headers=["*"])

    async def __call__(self, scope, receive, send):
        public = scope["type"] != "http" or PUBLIC_PATHS.match(scope["path"])
        await (self.public if public else self.studio)(scope, receive, send)


app.add_middleware(SplitCORS)


def get_client_ip(request: Request) -> str:
    # The API only listens on 127.0.0.1 behind Nginx, so these headers are
    # set by Nginx and can be trusted. Without this every vote would look
    # like it came from 127.0.0.1.
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host


studio_router, current_user = build_router(STUDIO, get_client_ip, max_upload_mb=UPLOAD_MAX_MB)
app.include_router(studio_router)
LISTENER_STATS = ListenerStats(STUDIO.db_path, f"http://{ICECAST_HOST}:{ICECAST_PORT}/status-json.xsl",
                               relays=RELAY_STATUS_URLS)
GEO = CountryLookup(DATA_DIR)
AUDIENCE = Audience(STUDIO.db_path, GEO)
NOTES = FlamingoNotes(STUDIO.db_path)       # notes listeners leave by catching a flamingo (notes.py)
NOTES.on_event = lambda kind, ip: AUDIENCE.event(kind, None, ip)
app.include_router(build_curator_router(LISTENER_STATS, Tiers(DB_FILE, TIER_LIMITS), current_user, AUDIENCE, NOTES))
app.include_router(build_notes_router(NOTES, current_user, get_client_ip))
def _forget_live_song(media_id):
    """A song played (or dropped) in a live show: its upload goes, unless it's on the schedule."""
    try:
        STUDIO.delete_media(media_id)
    except (ValueError, LookupError):
        pass
    except Exception as e:
        print(f"Live: couldn't remove a played song: {e}")


LIVE = LiveStudio(STUDIO.db_path, NOTES.problem, NOTES.clean, _forget_live_song)   # a host live from the studio, and its chat (live.py)
app.include_router(build_live_router(LIVE, current_user, get_client_ip, STUDIO.user_for_token, STUDIO.get_media))


# =====================================================================
# SAVE THE SONG ON AIR (listeners)
# The last few downloaded songs are kept for a while instead of deleted at once,
# so a listener can save the one playing (or the one that just ended).
# Converted once per song to AAC in .m4a (plays everywhere, ~1 MB a minute),
# tagged with artist, title and when it aired.
# =====================================================================
KEEP_RECENT = 3                    # songs kept on disk after they start
SAVE_BITRATE = "128k"              # AAC stereo: ~0.96 MB per minute
SAVES_PER_HOUR = 20                # per listener IP
CACHE_DIR = DATA_DIR / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
recent_tracks = {}                 # msg_id -> {path, title, artist, started}
save_lock = asyncio.Lock()         # one conversion at a time, the stream comes first
save_hits = {}                     # ip -> [timestamps]


def clear_leftovers(older_than=0.0):
    """Delete song files nothing refers to: downloads and prepared saves left behind by a
    restart, a crash or a track that was fetched but never played. Studio files live
    elsewhere (data/studio) and are never touched here."""
    keep = {os.path.realpath(r["path"]) for r in recent_tracks.values()}
    keep |= {os.path.realpath(CACHE_DIR / f"{i}.m4a") for i in recent_tracks}
    if current_track_path:
        keep.add(os.path.realpath(current_track_path))
    keep |= {os.path.realpath(got[3]) for got in map(_ready, COMING) if got}   # waiting in line
    now, freed = time.time(), 0
    for folder in (DOWNLOAD_DIR, CACHE_DIR):
        for f in folder.iterdir():
            try:
                if not f.is_file() or os.path.realpath(f) in keep:
                    continue
                st = f.stat()
                if now - st.st_mtime < older_than:
                    continue           # probably the next song, still downloading
                f.unlink()
                freed += st.st_size
            except FileNotFoundError:
                pass
            except Exception as e:
                print(f"Couldn't remove {f}: {e}")
    if freed:
        print(f"Removed {freed / 1e6:.1f} MB of leftover song files")


_sweep = {"n": 0}


def keep_recent(msg_id, path, title, artist):
    """Called when a song finishes: keep it, and drop the oldest beyond KEEP_RECENT."""
    if not path or not os.path.exists(path):
        return
    recent_tracks[msg_id] = {"path": path, "title": title, "artist": artist,
                             "started": current_track_started if current_track_id == msg_id else time.time()}
    _sweep["n"] += 1
    if _sweep["n"] % 10 == 0:
        clear_leftovers(older_than=3 * 3600)   # every 10 songs, anything stray for 3+ hours
    while len(recent_tracks) > KEEP_RECENT:
        old_id = next(iter(recent_tracks))
        old = recent_tracks.pop(old_id)
        for f in (old["path"], CACHE_DIR / f"{old_id}.m4a"):
            try:
                os.remove(f)
            except FileNotFoundError:
                pass
            except Exception as e:
                print(f"Failed to clear temp file: {e}")


def track_for_save(track_id):
    if track_id == current_track_id and current_track_path and not current_is_show:
        return {"path": current_track_path, "title": current_track_title,
                "artist": current_track_artist, "started": current_track_started}
    return recent_tracks.get(track_id)


@app.get("/api/track/{track_id}.m4a")
async def save_track(track_id: int, request: Request):
    info = track_for_save(track_id)
    if not info or not os.path.exists(info["path"]):
        raise HTTPException(404, "That song isn't available to save any more")

    ip = get_client_ip(request)
    now = time.time()
    hits = [h for h in save_hits.get(ip, []) if now - h < 3600]
    if len(hits) >= SAVES_PER_HOUR:
        raise HTTPException(429, "That's a lot of saves. Try again in a while.")
    save_hits[ip] = hits + [now]

    out = CACHE_DIR / f"{track_id}.m4a"
    async with save_lock:
        if not out.exists():
            aired = datetime.fromtimestamp(info["started"], UTC)
            tmp = CACHE_DIR / f"{track_id}.part.m4a"
            proc = await asyncio.create_subprocess_exec(
                "nice", "-n", "15", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-i", info["path"], "-vn", "-map_metadata", "-1", "-ac", "2",
                "-c:a", "aac", "-b:a", SAVE_BITRATE, "-movflags", "+faststart",
                "-metadata", f"title={info['title']}",
                "-metadata", f"artist={info['artist']}",
                "-metadata", f"date={aired:%Y-%m-%d}",
                "-metadata", f"comment=Aired on Raadio {aired:%Y-%m-%d %H:%M} UTC",
                str(tmp),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, err = await asyncio.wait_for(proc.communicate(), 120)
            except TimeoutError:
                proc.kill()
                await proc.wait()
                raise HTTPException(504, "Preparing the file took too long") from None
            if proc.returncode != 0:
                tmp.unlink(missing_ok=True)
                print(f"Save failed for {track_id}: {err.decode(errors='replace')[-300:]}")
                raise HTTPException(500, "Couldn't prepare the file")
            tmp.rename(out)

    name = " - ".join(x for x in (info["artist"], info["title"]) if x) or "Raadio"
    safe = "".join(ch for ch in name if ch not in '\\/:*?"<>|').strip()[:100] or "Raadio"
    print(f"Saved for a listener: {name}")
    rng = request.headers.get("range", "")
    if not rng or rng.replace(" ", "").startswith("bytes=0-"):   # not a resumed / partial fetch
        AUDIENCE.event("save", track_id, ip)
    return FileResponse(out, media_type="audio/mp4", filename=f"{safe}.m4a",
                        headers={"Cache-Control": "no-store"})


def track_is_playing():
    return current_decoder is not None and current_decoder.returncode is None and current_track_id


async def votes_needed():
    """Votes it takes to skip. Alone on the station (Icecast counts one listener, or can't
    say), there is nobody else to agree, so the one vote is enough and the song goes at
    once instead of waiting for a second listener who isn't there."""
    try:
        listening = await asyncio.wait_for(LISTENER_STATS.live(), 1.5)
    except Exception:
        listening = None
    if listening is not None and listening <= 1:
        return 1
    return SKIP_VOTES_NEEDED


def like_result(msg_id):
    """A thumbs-up: the song's skip score goes down a little (it climbs back toward the
    tiers that play most often), the reverse of what a skip does."""
    with db() as conn:
        row = conn.execute("SELECT skip_score FROM track_stats WHERE telegram_msg_id = ?", (msg_id,)).fetchone()
        if not row:
            return
        score = max(0.0, (row[0] or 0.0) - LIKE_CREDIT)
        tier = 1 + sum(score >= limit for limit in TIER_LIMITS)
        conn.execute("UPDATE track_stats SET skip_score = ?, tier = ? WHERE telegram_msg_id = ?", (score, tier, msg_id))


async def register_like(request: Request):
    """The thumbs-up (POST /skip?up=1: the same address as a skip vote, so Nginx and the
    relays need nothing new). It takes back one skip vote waiting on this song, so it takes
    one more listener to skip it, and makes the song come round a little more often."""
    if not track_is_playing() or current_is_show or skip_requested:
        return {"status": "error", "liked": False, "message": "Nothing to like right now."}
    client_ip = get_client_ip(request)
    device = request.query_params.get("d", "")
    if not re.fullmatch(r"[a-z0-9]{8,32}", device):
        device = "-"
    who = f"{client_ip}|{device}"
    if who in song_likes:
        return {"status": "ignored", "liked": True, "message": "You already liked this one."}
    if sum(1 for k in song_likes if k.split("|", 1)[0] == client_ip) >= VOTES_PER_IP:
        return {"status": "ignored", "liked": False, "message": "Enough likes from your network already."}
    song_likes.add(who)
    rescued = False
    if who in skip_votes:              # changed their mind: their own skip vote goes
        del skip_votes[who]
        rescued = True
    elif skip_votes:                   # otherwise the newest vote against it
        del skip_votes[max(skip_votes, key=lambda k: skip_votes[k][0])]
        rescued = True
    await asyncio.to_thread(like_result, current_track_id)
    AUDIENCE.event("like", current_track_id, client_ip)
    # (no addresses in the log: a leaked log mustn't say who listens, from Iran above all)
    print("Thumbs-up" + (" (took back a skip vote)" if rescued else ""))
    return {"status": "success", "liked": True, "rescued": rescued,
            "message": "Saved from a skip!" if rescued else "Liked. It'll come round more often."}


@app.post("/skip")
async def register_skip_vote(request: Request):
    global skip_requested

    if request.query_params.get("up") == "1":
        return await register_like(request)
    if not track_is_playing() or skip_requested:
        return {"status": "error", "skipped": False,
                "message": "No track is playing right now."}
    if current_is_show:
        return {"status": "error", "skipped": False,
                "message": "Studio shows can't be skipped."}

    now = time.time()
    for key, (ts, _w) in list(skip_votes.items()):
        if now - ts > VOTE_WINDOW:
            del skip_votes[key]

    client_ip = get_client_ip(request)
    # Signed in to the studio as someone in VOTE_WEIGHTS? That vote counts more (the player
    # only sends the sign-in over HTTPS). Their vote is theirs, whichever device it's from.
    weight, voter = 1, None
    auth = request.headers.get("authorization", "")
    if auth[:7].lower() == "bearer " and VOTE_WEIGHTS:
        user = STUDIO.user_for_token(auth[7:].strip())
        if user and user["username"].lower() in VOTE_WEIGHTS:
            weight = VOTE_WEIGHTS[user["username"].lower()]
            voter = "user:" + user["username"].lower()
    if voter is None:
        device = request.query_params.get("d", "")
        if not re.fullmatch(r"[a-z0-9]{8,32}", device):
            device = "-"               # old players: one vote per address, like before
        voter = f"{client_ip}|{device}"
        if voter not in skip_votes:
            same_ip = sum(1 for k in skip_votes if k.split("|", 1)[0] == client_ip)
            if same_ip >= VOTES_PER_IP:
                return {"status": "ignored", "skipped": False,
                        "message": "Enough votes from your network already. Waiting for someone else."}
    if voter in skip_votes:
        return {"status": "ignored", "skipped": False,
                "message": "You already voted. Waiting for one more person."}

    skip_votes[voter] = (now, weight)
    needed = await votes_needed()
    print(f"Skip vote (x{weight}): {votes_in()}/{needed}")

    AUDIENCE.event("vote", current_track_id, client_ip)
    if votes_in() >= needed:
        print(f"Skipping track globally: {current_track_title}")
        AUDIENCE.event("skip", current_track_id, None)
        skip_requested = True          # the play loop fades it out and moves on
        skip_votes.clear()
        return {"status": "success", "skipped": True,
                "message": ("Your vote counts double. Skipping!" if weight > 1 else "Enough votes. Skipping!")}

    return {"status": "success", "skipped": False,
            "message": f"Vote counted ({votes_in()}/{needed}). "
                       f"Waiting for one more listener."}


@app.get("/now-playing")
async def now_playing(request: Request):
    """What's on air. The web player uses `id` to notice track changes; it adds ?on=1
    while its audio is playing, which is how the studio counts listeners per country."""
    AUDIENCE.seen(get_client_ip(request), request.query_params.get("on") == "1")
    nxt = next_up()
    return {
        "id": current_track_id,
        "title": current_track_title,
        "artist": current_track_artist,
        "started_at": current_track_started,
        "votes": votes_in(),
        "needed": await votes_needed(),
        "show": current_is_show,
        "wave": current_wave_key,      # fetch /api/wave/{wave} for the waveform
        # the song lined up next (once it's downloaded), for the flamingo's "next up" message
        "next": ({"title": nxt["title"], "artist": nxt["artist"]}
                 if nxt and nxt["title"] and nxt["id"] != current_track_id else None),
        "now": time.time(),            # server clock, so the player can line the waveform up
        # How far each stream's newest audio runs ahead of its due time (started_at is a due
        # time), and when the encoder's first sample was due: with these a player works out
        # exactly which moment it's hearing (the title, the waveform, where a skip lands).
        "edge": stream_edge(),
        "clock": broadcaster.clock() if broadcaster else None,
        "delay": max(0.0, -stream_edge()["mp3"]),   # (the same for players from before "edge")
        "sky": NOTES.sky_now(),        # a flamingo skywriting a listener's note, for everyone
        "notes_open": NOTES.has_room(),  # room for another note: flamingos come round to be caught
        "live": LIVE.state(),          # a host live from the studio: {title, host, room, since}; the chat is open
        "recent": recent_aired,        # the 5 songs before this one, newest first (the guide's history)
        "likes": len(song_likes),
    }


@app.get("/api/wave/{key}")
async def wave(key: str):
    """Bass / mid / high levels, 10 a second, for the waveform (see vibe.py)."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key):
        raise HTTPException(404, "Unknown")
    data = await VIBE.get(key)
    if not data:
        raise HTTPException(404, "Not ready")
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=86400"})


# =====================================================================
# TRACK QUEUE
# =====================================================================
# The channel's songs, kept between rounds. A round used to re-read the whole channel
# history from Telegram (one request per 100 posts); now only posts newer than the last
# one seen are fetched, and the full list is re-read every CHANNEL_RESCAN_S (to notice
# deleted or edited posts).
CHANNEL_RESCAN_S = 6 * 3600
_channel = {"tracks": {}, "dates": {}, "meta": {}, "pins": {}, "full_at": 0.0, "max_id": 0}

# Summer songs: posts tagged #SummerBaby play about three times as often in June, July
# and August. Pinned songs get the new-upload priority for two weeks after being pinned.
SUMMER_TAG = env("SUMMER_TAG", "SummerBaby").lstrip("#").lower()
SUMMER_MONTHS = {6, 7, 8}
SUMMER_TIMES = max(1, int(env("SUMMER_TIMES", "3")))
PIN_DAYS = float(env("PIN_DAYS", "14"))
_HASHTAG = re.compile(r"#(\w+)", re.UNICODE)


def _tags_of(message):
    return {t.lower() for t in _HASHTAG.findall((message.caption or "") + " " + (message.text or ""))}


def _meta_of(message):
    return {"by": (getattr(message, "author_signature", None) or "").strip() or None,
            "at": message.date.timestamp() if message.date else 0.0,
            "tags": _tags_of(message)}


def _pin_of(message):
    """(pinned post id, when) for the channel's "pinned a message" notice, else None."""
    pinned = getattr(message, "pinned_message", None)
    if pinned is None or not getattr(message, "service", None):
        return None
    return pinned.id, (message.date.timestamp() if message.date else time.time())


def is_summer(now=None):
    return datetime.fromtimestamp(now or time.time(), UTC).month in SUMMER_MONTHS


_DASH = re.compile(r"\s+[-–—|]\s+")
_EXT = re.compile(r"\.(mp3|m4a|aac|ogg|opus|flac|wav)$", re.I)


def split_title(title, artist):
    """(title, artist), with the artist taken out of the title when a file only has
    "Artist - Song" in its title (or file name) and no artist of its own."""
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not artist and title:
        parts = _DASH.split(title, maxsplit=1)
        if len(parts) == 2 and parts[0].strip() and parts[1].strip():
            artist, title = parts[0].strip(), parts[1].strip()
    return title, artist


def _track_of(message):
    audio = message.audio
    if not audio:
        return None
    title = audio.title
    if not title and audio.file_name:                       # e.g. "Artist_-_Song_Name.mp3"
        title = _EXT.sub("", audio.file_name).replace("_", " ")
    title, artist = split_title(title, audio.performer)
    return (message.id, title or "Unnamed Track", artist)


async def channel_tracks():
    """[(msg_id, title, artist)] for every song in the channel, newest first."""
    full = not _channel["tracks"] or time.time() - _channel["full_at"] > CHANNEL_RESCAN_S
    if full:
        tracks, dates, meta, pins = {}, {}, {}, {}
        async for message in TG_APP.get_chat_history(CHANNEL_ID):
            pin = _pin_of(message)
            if pin:
                pins[pin[0]] = max(pins.get(pin[0], 0), pin[1])
            t = _track_of(message)
            if t:
                tracks[t[0]] = t
                dates[t[0]] = message.date.timestamp() if message.date else 0.0
                meta[t[0]] = _meta_of(message)
        _channel.update(tracks=tracks, dates=dates, meta=meta, pins=pins, full_at=time.time(),
                        max_id=max(tracks, default=0))
        summer = sum(1 for m in meta.values() if SUMMER_TAG in m["tags"])
        print(f"Channel scanned: {len(tracks)} songs ({summer} tagged #{SUMMER_TAG}, "
              f"{len({m['by'] for m in meta.values() if m['by']})} people signed posts)")
        await asyncio.to_thread(save_track_meta, meta)
    else:
        new = {}
        async for message in TG_APP.get_chat_history(CHANNEL_ID, limit=200):
            if message.id <= _channel["max_id"]:
                break                  # newest first: the rest is already known
            pin = _pin_of(message)
            if pin:
                _channel["pins"][pin[0]] = max(_channel["pins"].get(pin[0], 0), pin[1])
            t = _track_of(message)
            if t:
                _channel["tracks"][t[0]] = t
                _channel["dates"][t[0]] = message.date.timestamp() if message.date else time.time()
                new[t[0]] = _channel["meta"][t[0]] = _meta_of(message)
                print(f"New in the channel: {t[1]}")
        _channel["max_id"] = max(_channel["tracks"], default=0)
        if new:
            await asyncio.to_thread(save_track_meta, new)
    return sorted(_channel["tracks"].values(), key=lambda t: -t[0])


def is_summer_song(msg_id):
    return SUMMER_TAG in (_channel["meta"].get(msg_id) or {}).get("tags", ())


async def pinned_songs():
    """Songs pinned in the channel within the last PIN_DAYS, longest-pinned last."""
    if PIN_DAYS <= 0:
        return []
    ids = []
    try:
        async for m in TG_APP.search_messages(CHANNEL_ID, filter=enums.MessagesFilter.PINNED, limit=50):
            ids.append(m.id)
    except Exception as e:
        print(f"Couldn't read the channel's pinned posts: {e}")
        return []
    since = await asyncio.to_thread(remember_pins, ids, _channel["pins"])
    cutoff = time.time() - PIN_DAYS * 86400
    return [_channel["tracks"][i] for i in sorted(since, key=lambda i: -since[i])
            if i in _channel["tracks"] and since[i] >= cutoff]


def forget_track(msg_id):
    """A post that's gone (or lost its audio): stop handing it out until the next full scan."""
    _channel["tracks"].pop(msg_id, None)
    _channel["dates"].pop(msg_id, None)
    _channel["meta"].pop(msg_id, None)


async def build_track_pool():
    """Build one shuffled round from the channel's songs, leaving out banned ones."""
    banned, _, _ = await asyncio.to_thread(load_track_info)
    pool = [t for t in await channel_tracks() if t[0] not in banned]
    random.shuffle(pool)
    # In summer, each #SummerBaby song comes round SUMMER_TIMES times a round instead of once,
    # its extra turns spread over the later parts of the round (the 90-minute rule in
    # TrackQueue.next still keeps any song from coming back too soon)
    if is_summer() and SUMMER_TIMES > 1:
        summer = [t for t in pool if is_summer_song(t[0])]
        for k in range(1, SUMMER_TIMES):
            for t in summer:
                lo = len(pool) * k // SUMMER_TIMES
                pool.insert(random.randint(lo, len(pool)), t)
        if summer:
            print(f"Summer: {len(summer)} #{SUMMER_TAG} songs, each {SUMMER_TIMES}x this round")
    return pool


# New uploads get extra airtime for their first two weeks: one slips in every few songs,
# but the same new song never comes back within FRESH_GAP_MIN minutes.
FRESH_DAYS = float(os.getenv("FRESH_DAYS", "14"))
FRESH_EVERY = max(1, int(os.getenv("FRESH_EVERY", "4")))       # normal songs between new ones
FRESH_GAP_MIN = float(os.getenv("FRESH_GAP_MIN", "90"))
FRESH_SCAN_S = 600                                               # look for new uploads every 10 min


async def scan_fresh_tracks():
    """Audio posted in the channel within the last FRESH_DAYS, newest first."""
    if FRESH_DAYS <= 0:
        return []
    cutoff = time.time() - FRESH_DAYS * 86400
    # the cached channel list (only posts newer than the last one seen are fetched)
    return [t for t in await channel_tracks() if _channel["dates"].get(t[0], 0) >= cutoff]


class TrackQueue:
    """Hands out tracks one at a time, rebuilding the round when it runs out,
    and slipping a new upload in every FRESH_EVERY songs."""

    def __init__(self):
        self.pool = []
        self.last_id = None
        self.fresh = []
        self.fresh_scanned = 0.0
        self.last_played = {}          # track id -> when it was last handed out
        self.since_fresh = FRESH_EVERY # so a brand-new upload can play soon after a restart
        self.pinned = []
        self.round_seen = set()        # songs already played this round (summer songs come round more than once)
        self.reasons = {}              # track id -> why it was last picked: pinned, new, summer, rotation

    async def _pick_fresh(self):
        """A song for the priority slot: a pinned one (first), or a new upload."""
        now = time.time()
        if now - self.fresh_scanned > FRESH_SCAN_S:
            try:
                self.fresh = await scan_fresh_tracks()
                if self.fresh:
                    print(f"New uploads in their first {FRESH_DAYS:g} days: {len(self.fresh)}")
            except Exception as e:
                print(f"Couldn't scan for new uploads: {e}")
            try:
                self.pinned = await pinned_songs()
                if self.pinned:
                    print(f"Pinned in the channel (priority for {PIN_DAYS:g} days): {len(self.pinned)}")
            except Exception as e:
                print(f"Couldn't check pinned songs: {e}")
            self.fresh_scanned = now
        if not self.fresh and not self.pinned:
            return None
        banned, tiers, _ = await asyncio.to_thread(load_track_info)

        def due(t):
            return t[0] not in banned and t[0] != self.last_id and now - self.last_played.get(t[0], 0) > FRESH_GAP_MIN * 60
        # pinned by the channel: pushed even if listeners skip it (someone chose it)
        pinned = [t for t in self.pinned if due(t)]
        if pinned:
            return min(pinned, key=lambda t: self.last_played.get(t[0], 0))
        ok = [t for t in self.fresh
              if due(t) and tiers.get(t[0], 1) < 3]   # listeners keep skipping it: stop pushing
        if not ok:
            return None
        # the one that's waited longest; the newest upload first among never-played ones
        return min(ok, key=lambda t: self.last_played.get(t[0], 0))

    async def next(self):
        track = None
        if self.since_fresh >= FRESH_EVERY:
            track = await self._pick_fresh()
        if track:
            self.since_fresh = 0
            self.reasons[track[0]] = "pinned" if any(p[0] == track[0] for p in self.pinned) else "new"
            self.pool = [t for t in self.pool if t[0] != track[0]]   # don't repeat it later this round
            print(("Pinned song priority: " if any(p[0] == track[0] for p in self.pinned) else "New upload priority: ") + track[1])
        else:
            # (a summer song's extra turns: once everything left this round was heard in the
            # last FRESH_GAP_MIN, drop those repeats rather than play one again so soon)
            now = time.time()
            if self.pool and not any(now - self.last_played.get(t[0], 0) > FRESH_GAP_MIN * 60 for t in self.pool):
                self.pool = [t for t in self.pool if t[0] not in self.round_seen]
            while not self.pool:
                self.round_seen = set()
                self.pool = await build_track_pool()
                if not self.pool:
                    print("No playable tracks found (or all are banned). Retrying in 15 s")
                    await asyncio.sleep(15)
                elif len(self.pool) > 1 and self.pool[0][0] == self.last_id:
                    self.pool.append(self.pool.pop(0))   # no back-to-back repeat across rounds
            # skip past anything heard in the last FRESH_GAP_MIN (e.g. a new upload just pushed in)
            now = time.time()
            i = next((k for k, t in enumerate(self.pool)
                      if now - self.last_played.get(t[0], 0) > FRESH_GAP_MIN * 60), 0)
            track = self.pool.pop(i)
            self.round_seen.add(track[0])
            self.since_fresh += 1
            self.reasons[track[0]] = ("summer" if is_summer() and is_summer_song(track[0]) else "rotation")
        self.last_id = track[0]
        self.last_played[track[0]] = time.time()
        return track


_GAIN_CACHE = {}


# Each song's tone, evened out a little: its bass (below ~150 Hz) and treble (above ~6 kHz)
# against its middle, measured in the same pass as its loudness, are nudged half-way toward a
# well-balanced master's, at most MATCH_EQ_MAX dB, with gentle shelves. A dull, muddy upload
# gets some air; a harsh, thin one is calmed; one that's already balanced is left alone.
MATCH_EQ = STATION_SOUND and env_bool("MATCH_EQ", True)   # (only with SOUND=station)
MATCH_EQ_MAX = 3.0
EQ_TARGET = {"low": 3.0, "high": -5.0}     # dB against the 500 Hz-4 kHz band
_EQ_CACHE = {}


def track_eq(path):
    """The shelves for this song (FFmpeg filters, joined), or "" (call after track_gain)."""
    bands = _EQ_CACHE.get(path)
    if not MATCH_EQ or not bands:
        return ""
    low, mid, high = bands
    out = []
    for name, val, f, key in (("bass", low, 120, "low"), ("treble", high, 8000, "high")):
        if val < -70 or mid < -70:
            continue                   # (silent there: nothing to judge by)
        g = max(-MATCH_EQ_MAX, min(MATCH_EQ_MAX, 0.5 * (EQ_TARGET[key] - (val - mid))))
        if abs(g) >= 0.3:
            out.append(f"{name}=g={g:.1f}:f={f}:t=s:w=0.7")
    return ",".join(out)


def song_filters(path, gain):
    """The decoder's filters for a song: its loudness, then its tone (-af ... or nothing)."""
    parts = ([f"volume={gain:.2f}dB"] if abs(gain) > 0.05 else []) + ([track_eq(path)] if track_eq(path) else [])
    return ["-af", ",".join(parts)] if parts else []


def known_gain(path):
    """track_gain's answer when nothing needs measuring, else None."""
    if not NORMALIZE or LOUDNESS_MODE == "stream":
        return 0.0
    return _GAIN_CACHE.get(path)


async def track_gain(path: str) -> float:
    """dB to turn this file up or down by to reach LOUDNESS_TARGET (EBU R128 integrated
    loudness, measured with one quick FFmpeg pass while the previous song is playing).
    The same pass measures its tone for track_eq."""
    if not NORMALIZE or LOUDNESS_MODE == "stream":
        return 0.0
    if path in _GAIN_CACHE:
        return _GAIN_CACHE[path]
    gain = 0.0
    try:
        # Low priority and one thread: the live encoder must never wait for this. (Run at
        # normal priority it competed with the stream for the CPU and caused drop-outs.)
        # Long studio items are judged on their first 10 minutes, so a show starts on time.
        bands = ("[b]lowpass=f=150,lowpass=f=150,astats=measure_overall=RMS_level:measure_perchannel=none[o1];"
                 "[c]highpass=f=500,lowpass=f=4000,astats=measure_overall=RMS_level:measure_perchannel=none[o2];"
                 "[d]highpass=f=6000,highpass=f=6000,astats=measure_overall=RMS_level:measure_perchannel=none[o3]")
        proc = await asyncio.create_subprocess_exec(
            "nice", "-n", "15", "ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-threads", "1",
            "-t", "600", "-i", path, "-vn",
            "-filter_complex", "[0:a]aformat=channel_layouts=mono,asplit=4[a][b][c][d];[a]ebur128=framelog=quiet[o0];" + bands,
            *[x for k in range(4) for x in ("-map", f"[o{k}]", "-f", "null", "-")],
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _out, err = await asyncio.wait_for(proc.communicate(), 90)
        text = err.decode("utf-8", "replace")
        found = re.findall(r"I:\s*(-?[0-9.]+)\s*LUFS", text)
        if found:
            measured = float(found[-1])
            if measured > -70:
                gain = max(-12.0, min(12.0, float(LOUDNESS_TARGET) - measured))
        # (the three bands, in the order the filters were made: low, middle, high)
        rms = sorted((int(n), float(v)) for n, v in re.findall(r"Parsed_astats_(\d+) @ [^\]]*\] RMS level dB: (-?[0-9.]+|-inf)", text.replace("-inf", "-999")))
        if len(rms) == 3:
            _EQ_CACHE[path] = tuple(v for _n, v in rms)
            if len(_EQ_CACHE) > 200:
                _EQ_CACHE.clear()
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"Loudness: couldn't measure {os.path.basename(path)} ({e}); playing it as is")
    if len(_GAIN_CACHE) > 200:
        _GAIN_CACHE.clear()
    _GAIN_CACHE[path] = gain
    return gain


async def fetch_next(queue: TrackQueue):
    """Pick the next track and download it. Runs in the background while music plays."""
    msg_id, title, artist = await queue.next()
    message = await TG_APP.get_messages(CHANNEL_ID, msg_id)
    if not message or not message.audio:
        forget_track(msg_id)
        raise RuntimeError(f"Message {msg_id} has no audio any more")
    want = getattr(message.audio, "file_size", 0) or 0
    for _attempt in range(3):
        path = await TG_APP.download_media(message.audio.file_id, file_name=str(DOWNLOAD_DIR) + "/")
        # a download cut short plays as a song that suddenly stops: check it's all there
        got = os.path.getsize(path) if path and os.path.exists(path) else 0
        if not want or got >= want:
            break
        print(f"Download of {msg_id} came in short ({got} of {want} bytes); trying again")
        try:
            os.remove(path)
        except OSError:
            pass
    else:
        raise RuntimeError(f"Track {msg_id} wouldn't download completely")
    await track_gain(path)             # its loudness, measured before it plays
    VIBE.start(str(msg_id), path)      # the waveform's data (one heavy job at a time, not both at once)
    return msg_id, title, artist, path


_fetching = {"failed": 0}             # fetches that failed in a row


async def fetch_after(prev, queue: TrackQueue):
    """fetch_next, once the song before it in line is ready: one download at a time, and
    the songs picked in the order they'll play. One broken song is passed over at once;
    after several in a row it waits a moment each time, so a Telegram outage isn't
    hammered (nor the log flooded)."""
    if prev is not None:
        await asyncio.wait({prev})
    if _fetching["failed"] > 1:
        await asyncio.sleep(3)
    try:
        got = await fetch_next(queue)
    except Exception:
        _fetching["failed"] += 1
        raise
    _fetching["failed"] = 0
    return got


def top_up(queue: TrackQueue):
    """Keep PREFETCH songs coming."""
    while len(COMING) < PREFETCH:
        COMING.append(asyncio.create_task(fetch_after(COMING[-1] if COMING else None, queue)))


# =====================================================================
# PLAY LOOP
# =====================================================================
async def stop_decoder(dec):
    """Stop an FFmpeg decoder and reap it, without ever hanging.

    On Python 3.12, Process.wait() only returns once the stdout pipe has closed.
    We read the decoder at real-time speed, so asyncio has paused that pipe with
    audio still in it; after a skip or a cut-in it would never close and wait()
    hung forever, silencing the station. So: kill, read off what's left, then wait
    with a time limit."""
    if dec.returncode is None:
        try:
            dec.kill()
        except ProcessLookupError:
            pass

    async def drain():
        while await dec.stdout.read(1 << 16):
            pass

    try:
        await asyncio.wait_for(drain(), 3)
    except (TimeoutError, Exception):
        pass
    try:
        await asyncio.wait_for(dec.wait(), 3)
    except TimeoutError:
        print(f"Decoder {dec.pid} didn't exit in time; moving on")


async def play_file(bc: Broadcaster, path: str, interruptible=True):
    """Decode one file into the broadcaster.

    Returns 'finished', 'skipped' (listener vote), 'interrupted' (a scheduled
    studio item is due) or 'failed'. Studio items play with interruptible=False.
    """
    global current_decoder, skip_requested

    # (songs were measured while downloading, so they start at once; a studio item is
    # measured now, with the stream kept going on silence meanwhile)
    gain = known_gain(path)
    if gain is None:
        measuring = asyncio.ensure_future(track_gain(path))
        await bc.pump_until(measuring)
        gain = measuring.result()
    level = song_filters(path, gain)
    dec = await asyncio.create_subprocess_exec(
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", path, "-vn",                      # -vn: ignore embedded cover art
        *level,
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "pipe:1",
        stdout=asyncio.subprocess.PIPE,
    )
    current_decoder = dec
    rest = b""
    outcome = "finished"
    try:
        while True:
            cut_in = interruptible and (STUDIO.has_due() or LIVE.on_air() is not None)
            if skip_requested or cut_in:
                # read a little more, fade it out, then stop this track
                want = int(SKIP_FADE_SECONDS * BYTES_PER_SEC) // FRAME * FRAME
                tail = rest
                while len(tail) < want:
                    more = await dec.stdout.read(want - len(tail))
                    if not more:
                        break
                    tail += more
                if tail:
                    await bc.write(fade(tail, 1.0, 0.0))
                outcome = "interrupted" if cut_in else "skipped"
                break

            try:
                data = await asyncio.wait_for(dec.stdout.read(CHUNK), DECODER_STALL)
            except TimeoutError:
                print(f"Decoder gave no audio for {DECODER_STALL} s on {path}; moving on")
                outcome = "failed"
                break
            if not data:
                break
            data = rest + data
            cut = len(data) // FRAME * FRAME      # never split a sample frame
            rest = data[cut:]
            if cut:
                await bc.write(data[:cut])
    finally:
        await stop_decoder(dec)
        current_decoder = None
        skip_requested = False

    if outcome == "finished" and dec.returncode != 0:
        print(f"Decoder exited with code {dec.returncode} on {path}")
        outcome = "failed"
    return outcome


COMING = []                    # the songs being readied to go on next, in order (fetch_after tasks)


def _ready(task):
    """A fetch's (id, title, artist, path) once it has worked, else None."""
    if task.done() and not task.cancelled() and task.exception() is None:
        return task.result()
    return None


def next_up():
    """The song going on next, once it's downloaded ({id, title, artist}), else None (the
    wandering flamingo tells listeners)."""
    got = _ready(COMING[0]) if COMING else None
    return {"id": got[0], "title": got[1], "artist": got[2]} if got else None


def set_now_playing(track_id, title, artist, show, wave_key=None, lead=0.0):
    """lead: audio of the previous item still queued ahead of real time (Broadcaster.ahead()),
    so started_at is when this item's first sound is actually due, not when it was chosen.
    Players use it to switch the title, the waveform and the skip's tuning sound exactly
    when the new song reaches them."""
    global current_track_id, current_track_title, current_track_artist
    global current_track_started, current_is_show, current_wave_key
    # the one ending goes on the "recently played" list (songs and shows, not the gaps)
    if current_track_id is not None and current_track_id != track_id and current_track_title \
            and current_track_title != "Unknown Track":
        recent_aired.insert(0, {"title": current_track_title, "artist": current_track_artist,
                                "started": current_track_started, "show": current_is_show})
        del recent_aired[5:]
    song_likes.clear()
    current_wave_key = wave_key
    current_track_id = track_id
    current_track_title = title
    current_track_artist = artist
    current_track_started = time.time() + max(0.0, lead)
    current_is_show = show
    skip_votes.clear()


async def play_show(bc: Broadcaster, airing):
    """Play one scheduled studio item, `repeat` times in a row. Nothing interrupts it."""
    path = airing["path"]
    if not os.path.exists(path):
        print(f"Studio: file for '{airing['name']}' is missing, skipping it")
        return
    late = time.time() - airing["at"]
    print(f"On air (studio): {airing['name']} x{airing['repeat']}"
          + (f", {late:.0f} s late" if late > 5 else ""))
    wave_key = f"show-{airing['schedule_id']}"
    VIBE.start(wave_key, path)          # ready a few seconds in; the player waits for it
    for i in range(airing["repeat"]):
        set_now_playing(f"show-{airing['schedule_id']}-{int(airing['at'])}-{i}",
                        airing["name"], "Raadio Studio", show=True, wave_key=wave_key, lead=bc.ahead())
        try:
            outcome = await play_file(bc, path, interruptible=False)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Studio: streaming error on '{airing['name']}': {e}")
            break
        if outcome == "failed":
            print(f"Studio: FFmpeg couldn't decode '{airing['name']}' ({path})")
            break
    set_now_playing(None, "Unknown Track", "", show=False)


async def play_live(bc: Broadcaster):
    """A show live from the studio: the hosts' microphones, mixed, instead of music.

    Each host's audio waits in its own small buffer (live.py), and this loop takes the next
    20 ms of each in time with the broadcaster's clock: a host whose line stalls is silent for
    a moment, and nobody else waits for them.

    The host running the show can also play songs: then the song goes out instead of the
    microphones (faded in, and out when they stop or skip it), unless they press Talk, and
    the hosts are heard over it with the song turned down. Each song is measured for loudness
    while it waits."""
    s = LIVE.on_air()
    if not s:
        return
    show_id = f"live-{s['id']}"
    label = LIVE.host_label()
    set_now_playing(show_id, s["title"], label, show=True, lead=bc.ahead())
    m = s["music"]
    song = None                        # {item, dec, rest, t}
    duck = 1.0
    fade_in = 0.3
    check_at = 0.0

    async def end_song(fade_out):
        nonlocal song
        if fade_out:
            want = int(SKIP_FADE_SECONDS * BYTES_PER_SEC) // FRAME * FRAME
            tail = song["rest"]
            while len(tail) < want:
                more = await song["dec"].stdout.read(want - len(tail))
                if not more:
                    break
                tail += more
            tail = tail[:len(tail) // FRAME * FRAME]
            if tail:
                tail = fade(tail, duck if m["talk"] else 1.0, 0.0)
                LIVE.tape(tail, music=tail, voices=False)
                await bc.write(tail)
        await stop_decoder(song["dec"])
        LIVE.song_done(song["item"])
        song = None
        if LIVE.on_air() is s:
            set_now_playing(show_id, s["title"], LIVE.host_label(), show=True, lead=bc.ahead())

    try:
        while LIVE.on_air() is s:
            if time.time() >= check_at:    # (about once a second)
                check_at = time.time() + 1
                await LIVE.reap()
                if LIVE.should_end():
                    await LIVE.stop("no sound from any host's browser for a while" if time.time() - s["last"] > 5
                                    else "it reached the time limit")
                    break
                if song is None and LIVE.host_label() != label:
                    label = LIVE.host_label()
                    set_now_playing(show_id, s["title"], label, show=True, lead=bc.ahead())
            for q in m["queue"]:       # each waiting song is measured for loudness meanwhile
                if "gain" not in q:
                    q["gain"] = asyncio.ensure_future(track_gain(q["path"]))
            if song is None:
                item = LIVE.next_song()
                if item:
                    g = item.get("gain")
                    gain = g.result() if g is not None and g.done() and not g.exception() else 0.0
                    level = song_filters(item["path"], gain)
                    dec = await asyncio.create_subprocess_exec(
                        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", item["path"], "-vn",
                        *level, "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "pipe:1",
                        stdout=asyncio.subprocess.PIPE)
                    song = {"item": item, "dec": dec, "rest": b"", "t": 0.0}
                    await LIVE.song_starting()
                    print(f"Live: '{s['title']}' plays '{item['name']}'")
                    set_now_playing(f"{show_id}-{item['qid']}", item["name"], LIVE.host_label(), show=True, lead=bc.ahead())

            if song is not None:
                if m["cmd"]:                       # Stop or Skip: a short fade, then the next thing
                    m["cmd"] = None
                    await end_song(True)
                    continue
                try:
                    data = await asyncio.wait_for(song["dec"].stdout.read(CHUNK), DECODER_STALL)
                except TimeoutError:
                    data = b""
                if not data:                       # the song ended
                    await end_song(False)
                    continue
                data = song["rest"] + data
                cut = len(data) // FRAME * FRAME
                song["rest"] = data[cut:]
                chunk = data[:cut]
                if not chunk:
                    continue
                secs = cut / BYTES_PER_SEC
                if song["t"] < fade_in:
                    chunk = fade(chunk, song["t"] / fade_in, min(1.0, (song["t"] + secs) / fade_in))
                song["t"] += secs
                # the microphones: the hosts always hear each other, the listeners only with Talk on
                voices = LIVE.take_voices(cut)
                LIVE.send_returns(voices, cut, music=chunk)
                target = 0.3 if m["talk"] else 1.0
                duck += max(-0.06, min(0.06, target - duck))      # (turned down and up over ~0.25 s)
                music = fade(chunk, duck, duck) if duck < 0.999 else chunk
                out = add_pcm(list(voices.values()) + [music], cut) if m["talk"] else music
                LIVE.tape(out, music=music, voices=m["talk"])
                await bc.write(out)
                continue

            voices = LIVE.take_voices(CHUNK)
            LIVE.send_returns(voices, CHUNK)
            out = add_pcm(voices.values(), CHUNK)
            LIVE.tape(out)
            await bc.write(out)
    finally:
        if song is not None:
            await stop_decoder(song["dec"])
            LIVE.song_done(song["item"])
        for q in m["queue"]:
            g = q.get("gain")
            if g is not None and not g.done():
                g.cancel()
    set_now_playing(None, "Unknown Track", "", show=False)


async def live_radio_loop():
    global broadcaster

    broadcaster = bc = Broadcaster()
    queue = TrackQueue()
    st = {"last_cleanup": 0.0}

    async with TG_APP:
        await bc.start()
        top_up(queue)
        while True:
            try:
                await radio_step(bc, queue, st)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never let one bad step kill the station: log it, keep the stream alive, go on
                print("Radio loop error (continuing):\n" + traceback.format_exc())
                await bc.pump_until(asyncio.create_task(asyncio.sleep(2)))


async def radio_step(bc: Broadcaster, queue: TrackQueue, st):
    """One pass of the play loop: a due studio item, or the next song."""
    global current_track_path
    if time.time() - st["last_cleanup"] > CLEANUP_EVERY:
        st["last_cleanup"] = time.time()
        try:
            STUDIO.cleanup()
            await asyncio.to_thread(LIVE.recordings.sweep)
        except Exception as e:
            print(f"Studio cleanup failed: {e}")

    # 0. A host live from the studio comes before everything (a scheduled item that falls
    #    due meanwhile plays when they're done)
    if LIVE.on_air():
        await play_live(bc)
        return

    # 1. Scheduled studio items always go first
    if STUDIO.has_due():
        airings = STUDIO.take_due()
        if not airings:
            # Shouldn't happen; never spin without yielding (that would freeze the stream)
            STUDIO.invalidate()
            await bc.write(SILENCE)
            return
        for airing in airings:
            await play_show(bc, airing)
        try:
            STUDIO.cleanup()        # deletes items (and files) after their last airing
        except Exception as e:
            print(f"Studio cleanup failed: {e}")
        return

    # 2. Music: the first song in line (waiting for it if it isn't ready, unless a show
    #    falls due meanwhile)
    top_up(queue)
    pending = COMING[0]
    await bc.pump_until(pending, stop=lambda: STUDIO.has_due() or LIVE.on_air() is not None)
    if not pending.done():
        return
    COMING.pop(0)
    top_up(queue)                      # the next one starts coming while this one plays
    try:
        msg_id, title, artist, path = pending.result()
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"Could not prepare the next track: {e}")
        return                         # (on to the next in line, ready or coming)

    set_now_playing(msg_id, title, artist, show=False, wave_key=str(msg_id), lead=bc.ahead())
    current_track_path = path
    print(f"Streaming: {artist + ' - ' if artist else ''}{title}")
    await asyncio.to_thread(log_track_start, msg_id, title, queue.reasons.get(msg_id, "rotation"))

    try:
        outcome = await play_file(bc, path)
        if outcome == "skipped":
            await asyncio.to_thread(record_result, msg_id, True)
        elif outcome == "finished":
            await asyncio.to_thread(record_result, msg_id, False)
        elif outcome == "interrupted":
            print(f"Faded out track {msg_id} for " + ("a host going live" if LIVE.on_air() else "a scheduled studio item"))
        else:
            print(f"Decoder failed on track {msg_id}; not counted")
    finally:
        keep_recent(msg_id, path, title, artist)


async def start_servers():
    import uvicorn
    # Bound to 127.0.0.1 so only Nginx can reach the API
    config = uvicorn.Config(app, host=API_HOST, port=API_PORT)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(start_servers())
