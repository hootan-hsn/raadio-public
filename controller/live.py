"""
Going live from the studio, together, and the chat that's open while a show is on air.

A host presses "Go live"; other people with a studio login can then join the show (several may
share one account: it's each device that joins, under a name of its own). Listeners can't.

Built for bad lines (hosts in Iran): everything goes over the studio's normal HTTPS connection,
because WebRTC and other UDP are the first things blocked there. Each browser records its
microphone and sends it in short pieces, at a low bitrate it lowers by itself when the line
can't keep up (a new "generation" of the recording: a new decoder here). Each host's audio
waits in a small buffer of its own, which grows if their line is jittery, and is mixed in time
with the clock of the radio loop: a host whose line stalls drops out for a moment, the show
and the others don't wait for them.

Hosts hear each other through a "return": everything on air except their own voice, as low
bitrate Opus over one long HTTPS response. It's a second or two behind, not a phone call.

Recording. The server keeps what went on air, ready the moment the show ends. Meanwhile each
browser records its microphone at high quality on the device, and uploads that after the show
in small pieces that survive a dropped line (see RecordingStore); once every host's is in, they
are mixed with the show's music into the high-quality file. Everything goes after KEEP_DAYS.

    Studio (needs the studio login, HTTPS only):
    GET  /api/live?p=pid           is anyone live? {live, mine, author, hosts, music...}
    POST /api/live/start           {"title", "name", "headphones"} -> {id, p, room, ...}
    POST /api/live/{id}/join       {"name", "headphones"} -> {p, room, ...}
    POST /api/live/{id}/leave      {"p"}
    PUT  /api/live/{id}/audio      ?p=pid&g=generation: the next piece of the recording (raw bytes)
    GET  /api/live/{id}/return     ?p=pid&kbit=24: the others, as an endless Ogg Opus response
    POST /api/live/{id}/stop       ends it for everyone (the host running it, their account, a curator)
    POST /api/live/{id}/music      {"media": id, "now": bool} a song uploaded with PUT /api/media:
                                   play it right away, or add it to the queue
    POST /api/live/{id}/control    {"action": "stop" | "skip" | "talk" | "play" | "remove" | "kick", ...}
    POST /api/live/{id}/takes      {"p", "mime", "t0"} this device's high-quality recording -> {take}
    PUT  /api/live/takes/{take}/{n}?last=0|1   one piece of it (sending one twice is harmless)
    GET  /api/live/takes/{take}    {have: [n...], done}
    GET  /api/live/recordings      the recordings this login may download
    POST /api/live/recordings/{id}/link  {"kind": "air" | "mix"} -> {url}, a link good for an hour
    GET  /api/live/recordings/{id}/{kind}.m4a?t=...  the file (resumable: Range works)

Music in a live show: while a song plays the hosts' microphones are off air (their audio still
reaches each other), unless the host running the show presses Talk: then they're heard over the
song, turned down. Stop ends the song and keeps the rest of the queue waiting (Play carries on
with it); Skip goes to the next song in the queue, or back to the microphones when there isn't one.

    Everyone (also through the plain address and the Iran relays):
    GET  /api/chat?after=N         {live, room, title, host, messages: [...newer than N]}
    POST /api/chat                 {"name": "...", "text": "...", "d": device id}
"""
import asyncio
import audioop                 # (C, so mixing a few voices costs next to nothing; the image is on Python 3.12)
import json
import os
import random
import re
import secrets
import shutil
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

QUEUE_MAX = 30                 # songs waiting in a live show
QUIET_ENDS_AFTER = 20          # seconds without audio from a host's browser: they've left (nobody left: it ends)
HOSTS_MAX = 6                  # devices in one show
NAME_RE = re.compile(r"[^\w\s.'-]", re.UNICODE)
FRAME = 4                      # bytes per sample frame of the mix: 44.1 kHz, 16-bit, stereo
PCM_RATE = 44100 * FRAME
BUFFER_START = 0.5             # seconds of a host's audio held back to ride out jitter...
BUFFER_MOST = 2.0              # ...more each time their line runs dry, up to this...
BEHIND_MOST = 3.0              # ...and never further behind than this: the oldest is dropped
RETURN_KBIT = (12, 16, 24)     # what a host may ask for, to hear the others
RETURN_MUSIC = 0.5             # songs, as heard in the return (voices stay on top)
RETURN_BEHIND = 1.5            # seconds waiting for a return's encoder before pieces are dropped
KEEP_DAYS = 7                  # recordings are deleted after this
LINK_SECONDS = 3600            # a download link works this long
TAKE_PIECE_MAX = 5 * 1024 * 1024
TAKE_MAX = 400 * 1024 * 1024   # one high-quality recording (96 kbit/s for LIVE_MAX_HOURS is ~170 MB)
DISK_SPARE = 1024 ** 3         # below this much free disk nothing new is recorded
PIECE_MAX = 512 * 1024         # one piece of audio (half a second is ~6 KB; leaves lots of room)
LIVE_MAX_HOURS = 4             # a stream that's forgotten ends by itself
CHAT_MAX = 200                 # letters per message
NAME_MAX = 24
CHAT_KEEP = 300                # messages kept per stream (older ones drop off)
CHAT_GAP = 2.0                 # seconds between two messages from one device
CHAT_PER_MINUTE = 20           # messages a minute from one internet address

ROOM_FIRST = ["Pink", "Coral", "Salt", "Sunset", "Lagoon", "Velvet", "Golden", "Rose", "Amber",
              "Misty", "Wild", "Silver", "Tidal", "Quiet", "Copper", "Peach", "Dusk", "Lucky"]
ROOM_SECOND = ["Lagoon", "Marsh", "Shore", "Feather", "Wing", "Reed", "Harbour", "Tide", "Dune",
               "Flock", "Island", "Breeze", "Shallows", "Delta", "Cove", "Estuary", "Wave", "Lake"]


def add_pcm(parts, n):
    """Mix pieces of n bytes (16-bit; a sum too loud is held at full scale, not wrapped round)."""
    out = bytes(n)
    for part in parts:
        out = audioop.add(out, part, 2)
    return out


async def _end_proc(proc):
    if proc is None:
        return
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.kill()
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(proc.wait(), 3)
    except Exception:
        pass


class Tape:
    """Writes the mix's raw audio to a file as it goes out, and never holds the show up."""

    def __init__(self, path):
        self.path, self.proc = Path(path), None

    async def start(self):
        # (fragmented, so what's there can still be played after a crash)
        self.proc = await asyncio.create_subprocess_exec(
            "nice", "-n", "10", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4", str(self.path),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)

    def write(self, data):
        p = self.proc
        if p is None or p.returncode is not None or p.stdin.is_closing():
            return
        if p.stdin.transport.get_write_buffer_size() < 30 * PCM_RATE:   # (a busy disk: lose a moment, not the show)
            p.stdin.write(data)

    async def close(self):
        p = self.proc
        if p is None:
            return
        try:
            p.stdin.close()
            await asyncio.wait_for(p.wait(), 60)
        except Exception:
            try:
                p.kill()
            except ProcessLookupError:
                pass


class RecordingStore:
    """The shows' recordings: a row each in the studio database, and a folder of files.

    air.m4a   what went on air (ready when the show ends)
    mix.m4a   the hosts' high-quality recordings and the show's music, mixed (once all are in)
    takes/    those recordings on their way in, in numbered pieces; music.m4a, the show's songs
    """

    def __init__(self, root, db_path):
        self.root, self.db_path = Path(root), str(db_path)
        self.root.mkdir(parents=True, exist_ok=True)
        self.links = {}                # token -> (recording, kind, expires)
        self.mixing = set()
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS live_recordings (
                             id TEXT PRIMARY KEY, title TEXT NOT NULL, started REAL NOT NULL, ended REAL,
                             expires REAL NOT NULL, hosts TEXT NOT NULL DEFAULT '[]', logins TEXT NOT NULL DEFAULT '[]',
                             off TEXT NOT NULL DEFAULT '[]', music_at REAL)""")
            c.execute("""CREATE TABLE IF NOT EXISTS live_takes (
                             id TEXT PRIMARY KEY, recording TEXT NOT NULL, login TEXT NOT NULL, name TEXT NOT NULL,
                             mime TEXT NOT NULL, t0 REAL NOT NULL, last INTEGER, done INTEGER NOT NULL DEFAULT 0)""")
            # a crash or restart mid-show: that show is over
            c.execute("UPDATE live_recordings SET ended = ? WHERE ended IS NULL", (time.time(),))
        self.sweep()

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _dir(self, rid):
        return self.root / rid

    @staticmethod
    def disk_ok(path):
        try:
            return shutil.disk_usage(path).free > DISK_SPARE
        except OSError:
            return True

    def create(self, title, started):
        rid = secrets.token_hex(8)
        with self._conn() as c:
            c.execute("INSERT INTO live_recordings (id, title, started, expires) VALUES (?, ?, ?, ?)",
                      (rid, title, started, started + KEEP_DAYS * 86400))
        self._dir(rid).mkdir(parents=True, exist_ok=True)
        return rid

    def add_host(self, rid, login, name):
        with self._conn() as c:
            r = c.execute("SELECT hosts, logins FROM live_recordings WHERE id = ?", (rid,)).fetchone()
            if not r:
                return
            hosts, logins = json.loads(r["hosts"]), json.loads(r["logins"])
            if name not in hosts:
                hosts.append(name)
            if login.lower() not in logins:
                logins.append(login.lower())
            c.execute("UPDATE live_recordings SET hosts = ?, logins = ? WHERE id = ?",
                      (json.dumps(hosts), json.dumps(logins), rid))

    def finish(self, rid, off, music_at):
        """The show has ended: KEEP_DAYS count from here."""
        now = time.time()
        with self._conn() as c:
            c.execute("UPDATE live_recordings SET ended = ?, expires = ?, off = ?, music_at = ? WHERE id = ?",
                      (now, now + KEEP_DAYS * 86400, json.dumps(off), music_at, rid))

    async def seal_air(self, rid):
        """The on-air file, rewritten so players can seek in it at once (the audio isn't touched)."""
        d = self._dir(rid)
        part = d / "air.part.m4a"
        if not part.exists():
            return
        tmp = d / "air.tmp.m4a"
        proc = await asyncio.create_subprocess_exec(
            "nice", "-n", "10", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(part),
            "-c", "copy", "-movflags", "+faststart", str(tmp),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        if await proc.wait() == 0 and tmp.exists():
            tmp.replace(d / "air.m4a")
            part.unlink(missing_ok=True)
        else:
            part.replace(d / "air.m4a")          # (still plays, it just can't seek so well)
            tmp.unlink(missing_ok=True)

    # ---- the hosts' high-quality recordings -------------------------------
    def new_take(self, rid, login, name, mime, t0):
        take = secrets.token_hex(8)
        with self._conn() as c:
            c.execute("INSERT INTO live_takes (id, recording, login, name, mime, t0) VALUES (?, ?, ?, ?, ?, ?)",
                      (take, rid, login, name, str(mime or "")[:60], float(t0)))
        (self._dir(rid) / "takes" / take).mkdir(parents=True, exist_ok=True)
        return take

    def _take(self, take, login):
        if not re.fullmatch(r"[0-9a-f]{16}", take or ""):
            raise LookupError("No such recording")
        with self._conn() as c:
            t = c.execute("SELECT * FROM live_takes WHERE id = ?", (take,)).fetchone()
        if not t:
            raise LookupError("That recording has expired")
        if t["login"].lower() != login.lower():
            raise PermissionError("That's someone else's recording")
        return t

    def take_state(self, take, login):
        t = self._take(take, login)
        d = self._dir(t["recording"]) / "takes" / take
        have = sorted(int(f.stem) for f in d.glob("*.piece")) if d.exists() else []
        return {"have": have, "done": bool(t["done"])}

    def put_piece(self, take, n, data, last, login):
        """Returns the recording's id once this take is complete (it may be ready to mix)."""
        t = self._take(take, login)
        if t["done"]:
            return None
        d = self._dir(t["recording"]) / "takes" / take
        if not self.disk_ok(self.root):
            raise OverflowError("The server's disk is full")
        if sum(f.stat().st_size for f in d.glob("*.piece")) + len(data) > TAKE_MAX:
            raise ValueError("That recording is too long")
        try:
            tmp = d / f"{n}.{secrets.token_hex(4)}.tmp"
            tmp.write_bytes(data)
            tmp.replace(d / f"{n}.piece")        # (whole or not at all: a dropped line can't leave half a piece)
        except FileNotFoundError:
            return None                          # (a late copy of a piece: this take has just been put together)
        with self._conn() as c:
            if last:
                c.execute("UPDATE live_takes SET last = ? WHERE id = ?", (n, take))
            lastn = c.execute("SELECT last FROM live_takes WHERE id = ?", (take,)).fetchone()["last"]
        if lastn is None or any(not (d / f"{i}.piece").exists() for i in range(lastn + 1)):
            return None
        whole = self._dir(t["recording"]) / "takes" / f"{take}.audio"
        tmp = whole.with_suffix(f".{secrets.token_hex(4)}.tmp")
        try:
            with open(tmp, "wb") as out:
                for i in range(lastn + 1):
                    out.write((d / f"{i}.piece").read_bytes())
        except FileNotFoundError:
            tmp.unlink(missing_ok=True)
            return None                          # (another request put it together first)
        tmp.replace(whole)
        shutil.rmtree(d, ignore_errors=True)
        with self._conn() as c:
            c.execute("UPDATE live_takes SET done = 1 WHERE id = ?", (take,))
        return t["recording"]

    async def mix_if_ready(self, rid):
        """Every host's recording is in, and the show is over: make the high-quality file."""
        if rid in self.mixing:
            return
        with self._conn() as c:
            r = c.execute("SELECT * FROM live_recordings WHERE id = ?", (rid,)).fetchone()
            takes = c.execute("SELECT * FROM live_takes WHERE recording = ?", (rid,)).fetchall()
        d = self._dir(rid)
        if not r or not r["ended"] or not takes or any(not t["done"] for t in takes) or (d / "mix.m4a").exists():
            return
        self.mixing.add(rid)
        try:
            off = json.loads(r["off"])
            mute = "+".join(f"between(t\\,{a:.2f}\\,{b:.2f})" for a, b in off)
            args, parts, n = [], [], 0
            for t in takes:
                args += ["-i", str(d / "takes" / f"{t['id']}.audio")]
                delay = max(0, int((t["t0"] - r["started"]) * 1000))
                f = f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={delay}:all=1"
                parts.append(f + (f",volume=0:enable='{mute}'" if mute else "") + f"[v{n}]")
                n += 1
            if (d / "music.m4a").exists():           # the songs, as they went on air
                args += ["-i", str(d / "music.m4a")]
                delay = max(0, int(((r["music_at"] or r["started"]) - r["started"]) * 1000))
                parts.append(f"[{n}:a]aresample=48000,adelay={delay}:all=1,volume=0.8[v{n}]")
                n += 1
            graph = ";".join(parts) + ";" + "".join(f"[v{i}]" for i in range(n)) + (
                f"amix=inputs={n}:duration=longest:normalize=0," if n > 1 else "anull,") + (
                "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[o]")
            tmp = d / "mix.part.m4a"
            proc = await asyncio.create_subprocess_exec(
                "nice", "-n", "15", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "1",
                *args, "-filter_complex", graph, "-map", "[o]", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", str(tmp),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, err = await proc.communicate()
            if proc.returncode == 0 and tmp.exists():
                tmp.replace(d / "mix.m4a")
                shutil.rmtree(d / "takes", ignore_errors=True)
                (d / "music.m4a").unlink(missing_ok=True)
                print(f"Live: the high-quality recording of '{r['title']}' is ready")
            else:
                tmp.unlink(missing_ok=True)
                print(f"Live: couldn't mix '{r['title']}': {err.decode(errors='replace')[-300:]}")
        finally:
            self.mixing.discard(rid)

    # ---- the list, the files, the end of them -----------------------------
    def list_for(self, login, curator=False):
        with self._conn() as c:
            rows = c.execute("SELECT * FROM live_recordings WHERE ended IS NOT NULL ORDER BY started DESC LIMIT 50").fetchall()
            takes = c.execute("SELECT recording, done FROM live_takes").fetchall()
        out = []
        for r in rows:
            if not curator and login.lower() not in json.loads(r["logins"]):
                continue
            mine = [t for t in takes if t["recording"] == r["id"]]
            d = self._dir(r["id"])
            out.append({"id": r["id"], "title": r["title"], "hosts": json.loads(r["hosts"]), "started": r["started"],
                        "ended": r["ended"], "expires": r["expires"], "air": (d / "air.m4a").exists(),
                        "mix": (d / "mix.m4a").exists(), "mixing": r["id"] in self.mixing,
                        "takes": len(mine), "takes_in": sum(1 for t in mine if t["done"])})
        return out

    def link(self, rid, kind, login, curator=False):
        if kind not in ("air", "mix"):
            raise ValueError("Unknown file")
        if not any(i["id"] == rid and i[kind] for i in self.list_for(login, curator)):
            raise LookupError("That file isn't there")
        now = time.time()
        self.links = {k: v for k, v in self.links.items() if v[2] > now}
        token = secrets.token_urlsafe(24)
        self.links[token] = (rid, kind, now + LINK_SECONDS)
        return f"/api/live/recordings/{rid}/{kind}.m4a?t={token}"

    def file_for(self, rid, kind, token):
        got = self.links.get(token or "")
        if not got or got[0] != rid or got[1] != kind or got[2] < time.time():
            raise PermissionError("This download link has expired: press Download again")
        with self._conn() as c:
            r = c.execute("SELECT title, started FROM live_recordings WHERE id = ?", (rid,)).fetchone()
        path = self._dir(rid) / f"{kind}.m4a"
        if not r or not path.exists():
            raise LookupError("That recording has expired")
        safe = "".join(ch for ch in r["title"] if ch not in '\\/:*?"<>|').strip()[:80] or "Raadio live"
        day = time.strftime("%Y-%m-%d", time.gmtime(r["started"]))
        return path, f"{safe} {day}.m4a"

    def sweep(self):
        """Everything past its KEEP_DAYS goes: the files and the rows."""
        now = time.time()
        with self._conn() as c:
            gone = [r["id"] for r in c.execute("SELECT id FROM live_recordings WHERE expires < ?", (now,))]
            for rid in gone:
                c.execute("DELETE FROM live_takes WHERE recording = ?", (rid,))
                c.execute("DELETE FROM live_recordings WHERE id = ?", (rid,))
            known = {r["id"] for r in c.execute("SELECT id FROM live_recordings")}
        for f in self.root.iterdir() if self.root.exists() else []:
            if f.is_dir() and f.name not in known:
                shutil.rmtree(f, ignore_errors=True)
        if gone:
            print(f"Live: {len(gone)} recording(s) past {KEEP_DAYS} days deleted")


class LiveStudio:
    def __init__(self, db_path, problem=None, clean=None, forget_media=None):
        self.db_path = str(db_path)
        self.problem = problem or (lambda text: None)          # the notes' word filter
        self.clean = clean or (lambda text: re.sub(r"\s+", " ", text or "").strip())
        self.session = None            # {id, user, title, room, started, last, ended, hosts, author, music...}
        self.forget_media = forget_media or (lambda media_id: None)   # (the songs go when the show ends)
        self.recent = {}               # device/ip -> [times], for rate limits
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS live_chat (
                             id INTEGER PRIMARY KEY AUTOINCREMENT,
                             stream TEXT NOT NULL, at REAL NOT NULL,
                             name TEXT NOT NULL, text TEXT NOT NULL, host INTEGER NOT NULL DEFAULT 0)""")
            c.execute("CREATE INDEX IF NOT EXISTS live_chat_stream ON live_chat (stream, id)")
            c.execute("CREATE TABLE IF NOT EXISTS live_rooms (name TEXT PRIMARY KEY, used_at REAL NOT NULL)")
            # a crash or restart mid-stream: that stream is over, so is its chat
            c.execute("DELETE FROM live_chat")
        self.recordings = RecordingStore(Path(os.path.dirname(self.db_path)) / "live_recordings", self.db_path)

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    # ---- the stream ----------------------------------------------------
    def on_air(self):
        s = self.session
        return s if s and not s["ended"] else None

    def _room_name(self):
        """A chat name never used before."""
        with self._conn() as c:
            used = {r["name"] for r in c.execute("SELECT name FROM live_rooms")}
            name = "Flamingo Lagoon"
            for _ in range(200):
                a, b = random.choice(ROOM_FIRST), random.choice(ROOM_SECOND)
                if a == b:
                    continue
                name = f"{a} {b}"
                if name not in used:
                    break
            else:                                    # all the pairs are used up: number them
                n = 2
                while f"{name} {n}" in used:
                    n += 1
                name = f"{name} {n}"
            c.execute("INSERT INTO live_rooms VALUES (?, ?)", (name, time.time()))
        return name

    # ---- the hosts -------------------------------------------------------
    def _name(self, name, login):
        name = NAME_RE.sub("", self.clean(str(name or "")))[:NAME_MAX].strip()
        return name or login

    async def _add_host(self, s, login, name):
        pid = secrets.token_hex(6)
        p = {"p": pid, "user": login, "name": self._name(name, login), "joined": time.time(), "last": time.time(),
             "gen": -1, "proc": None, "reader": None, "pcm": bytearray(), "ready": False, "target": BUFFER_START,
             "dry_at": time.time(), "ret": None}
        s["hosts"][pid] = p
        if s["rec"]:
            await asyncio.to_thread(self.recordings.add_host, s["rec"], login, p["name"])
        return p

    async def _decoder(self, p):
        """A new decoder for a host's microphone (a new recording, so a new format header)."""
        if p["reader"]:
            p["reader"].cancel()
        await _end_proc(p["proc"])
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-fflags", "+nobuffer", "-probesize", "32768", "-analyzeduration", "0",
            "-i", "pipe:0", "-vn", "-af", "aresample=async=1",
            "-f", "s16le", "-ar", "44100", "-ac", "2", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        p["proc"] = proc
        p["reader"] = asyncio.ensure_future(self._read_mic(p, proc))

    async def _read_mic(self, p, proc):
        while True:
            d = await proc.stdout.read(16384)
            if not d:
                return
            buf = p["pcm"]
            buf += d
            if len(buf) > BEHIND_MOST * PCM_RATE:     # (closer to live beats complete)
                keep = int((p["target"] + 0.5) * PCM_RATE) // FRAME * FRAME
                del buf[:(len(buf) - keep) // FRAME * FRAME]

    async def _drop_host(self, s, pid):
        p = s["hosts"].pop(pid, None)
        if not p:
            return
        if p["reader"]:
            p["reader"].cancel()
        await _end_proc(p["proc"])
        await _end_proc(p["ret"])
        print(f"Live: {p['name']} left '{s['title']}'")
        if s["author"] == pid and s["hosts"]:         # the show goes on: the longest here runs it
            s["author"] = min(s["hosts"].values(), key=lambda h: h["joined"])["p"]

    async def reap(self):
        """Hosts whose browsers have gone quiet have left."""
        s = self.on_air()
        if not s:
            return
        now = time.time()
        for pid in [k for k, p in s["hosts"].items() if now - p["last"] > QUIET_ENDS_AFTER]:
            await self._drop_host(s, pid)

    def _host(self, user, sid, pid):
        s = self.on_air()
        if not s or s["id"] != sid:
            raise LookupError("This stream has ended")
        p = s["hosts"].get(pid or "")
        if not p:
            raise LookupError("You've left this stream")
        if p["user"].lower() != user.lower():
            raise PermissionError("That's someone else's place in the stream")
        return s, p

    def host_label(self):
        s = self.on_air()
        if not s:
            return ""
        names = []
        for p in sorted(s["hosts"].values(), key=lambda h: h["joined"]):
            if p["name"] not in names:
                names.append(p["name"])
        return " & ".join(names) or s["user"]

    def hosts_state(self):
        s = self.on_air()
        if not s:
            return []
        now = time.time()
        return [{"p": p["p"], "name": p["name"], "author": p["p"] == s["author"], "ok": now - p["last"] < 3}
                for p in sorted(s["hosts"].values(), key=lambda h: h["joined"])]

    async def start(self, user, title, name=None, headphones=False):
        s = self.on_air()
        if s:
            raise ValueError(f"{self.host_label()} is live right now: join them, or try again when they're done.")
        title = re.sub(r"\s+", " ", str(title or "")).strip()[:60]
        now = time.time()
        self.session = s = {"id": secrets.token_hex(6), "user": user, "title": title or f"Live with {self._name(name, user)}",
                            "room": await asyncio.to_thread(self._room_name), "started": now, "last": now, "ended": False,
                            "headphones": bool(headphones), "hosts": {}, "author": None, "rec": None,
                            "air": None, "tune": None, "music_at": None, "off": [], "off_since": None,
                            # queue: [{qid, media, name, path, dur}]; playing: the one on air (the radio
                            # loop fills in its decoder); hold: Stop pressed, the queue waits
                            "music": {"queue": [], "playing": None, "talk": False, "hold": False,
                                      "cmd": None, "n": 0}}
        if self.recordings.disk_ok(self.recordings.root):
            s["rec"] = await asyncio.to_thread(self.recordings.create, s["title"], now)
            try:
                tape = Tape(self.recordings.root / s["rec"] / "air.part.m4a")
                await tape.start()
                s["air"] = tape
            except OSError as e:
                print(f"Live: can't record this show: {e}")
        else:
            print("Live: the disk is nearly full; this show isn't being recorded")
        p = await self._add_host(s, user, name)
        s["author"] = p["p"]
        print(f"Live: {p['name']} went live ('{s['title']}', chat '{s['room']}')")
        return s, p

    async def join(self, user, sid, name=None, headphones=False):
        s = self.on_air()
        if not s or s["id"] != sid:
            raise LookupError("This stream has ended")
        await self.reap()
        if s["headphones"] and not headphones:
            raise ValueError("This show needs everyone on headphones, or the others' voices get back into the microphones.")
        if len(s["hosts"]) >= HOSTS_MAX:
            raise ValueError(f"The show is full ({HOSTS_MAX} people).")
        p = await self._add_host(s, user, name)
        s["last"] = time.time()
        print(f"Live: {p['name']} joined '{s['title']}'")
        return s, p

    async def leave(self, user, sid, pid):
        s, p = self._host(user, sid, pid)
        await self._drop_host(s, p["p"])
        if not s["hosts"]:
            await self.stop("everyone left")

    async def feed(self, user, sid, pid, gen, data):
        s, p = self._host(user, sid, pid)
        if not data or gen < p["gen"]:             # (a late piece of a recording it has moved on from)
            return
        if gen > p["gen"]:
            p["gen"] = gen
            p["pcm"].clear()
            p["ready"] = False
            await self._decoder(p)
        now = time.time()
        s["last"] = p["last"] = now
        proc = p["proc"]
        try:
            if proc.returncode is not None:
                raise BrokenPipeError
            proc.stdin.write(data)
            await asyncio.wait_for(proc.stdin.drain(), 5)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            # (bad audio from this browser: it starts a fresh recording, nobody else notices)
            print(f"Live: the decoder stopped taking {p['name']}'s audio")
            raise BlockingIOError("Start the recording again") from None

    # ---- the mix ---------------------------------------------------------
    def take_voices(self, n):
        """For the radio loop: the next n bytes of each host whose audio is ready {pid: bytes}."""
        s = self.on_air()
        out = {}
        if not s:
            return out
        now = time.time()
        for pid, p in s["hosts"].items():
            buf = p["pcm"]
            if not p["ready"]:
                if len(buf) < p["target"] * PCM_RATE:
                    continue
                p["ready"] = True
            if len(buf) < n:                       # ran dry: hold more back from now on
                out[pid] = bytes(buf) + bytes(n - len(buf))
                buf.clear()
                p["ready"] = False
                p["target"] = min(BUFFER_MOST, p["target"] + 0.25)
                p["dry_at"] = now
                continue
            out[pid] = bytes(buf[:n])
            del buf[:n]
            if p["target"] > BUFFER_START and now - p["dry_at"] > 30:
                p["target"] = max(BUFFER_START, p["target"] - 0.1)
                p["dry_at"] = now
        return out

    def send_returns(self, voices, n, music=None):
        """What each host hears: everyone but themselves, and the song, turned down."""
        s = self.on_air()
        if not s:
            return
        soft = audioop.mul(music, 2, RETURN_MUSIC) if music else None
        for pid, p in s["hosts"].items():
            ret = p["ret"]
            if ret is None or ret.returncode is not None or ret.stdin.is_closing():
                continue
            if ret.stdin.transport.get_write_buffer_size() > RETURN_BEHIND * PCM_RATE:
                continue                           # (their line can't keep up: a jump beats falling behind)
            parts = [v for k, v in voices.items() if k != pid]
            if soft:
                parts.append(soft)
            ret.stdin.write(add_pcm(parts, n))

    async def open_return(self, user, sid, pid, kbit):
        s, p = self._host(user, sid, pid)
        await _end_proc(p["ret"])                  # (a reconnect: the new one takes over)
        kbit = min(RETURN_KBIT, key=lambda k: abs(k - kbit))
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            # (raw audio needs no analysing: by default FFmpeg sits on the first ~5 s doing it)
            "-fflags", "+nobuffer", "-probesize", "32", "-analyzeduration", "0",
            "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0", "-ac", "1", "-ar", "48000",
            "-c:a", "libopus", "-b:a", f"{kbit}k", "-application", "voip", "-frame_duration", "20",
            "-f", "ogg", "-page_duration", "100000", "-flush_packets", "1", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        p["ret"] = proc

        async def body():
            try:
                while True:
                    d = await proc.stdout.read(4096)
                    if not d:
                        return
                    yield d
            finally:
                await _end_proc(proc)
                if p["ret"] is proc:
                    p["ret"] = None
        return body()

    # ---- the recording of what went out -----------------------------------
    async def song_starting(self):
        """The show's first song: from here the songs are kept too, for the high-quality file."""
        s = self.on_air()
        if s and s["rec"] and not s["tune"]:
            try:
                tape = Tape(self.recordings.root / s["rec"] / "music.m4a")
                await tape.start()
                s["tune"], s["music_at"] = tape, time.time()
            except OSError:
                pass

    def tape(self, air, music=None, voices=True):
        """Called with everything that goes on air. music: the song in it, as it went out;
        voices: were the hosts' microphones on air (not during a song, unless Talk is on)."""
        s = self.on_air()
        if not s:
            return
        if s["air"]:
            s["air"].write(air)
        if s["tune"]:
            s["tune"].write(music if music is not None else bytes(len(air)))
        at = time.time() - s["started"]
        if voices and s["off_since"] is not None:
            s["off"].append([s["off_since"], at])
            s["off_since"] = None
        elif not voices and s["off_since"] is None:
            s["off_since"] = at

    # ---- music in the show ----------------------------------------------
    def _mine(self, user, sid, pid):
        s, p = self._host(user, sid, pid)
        if s["author"] != p["p"]:
            raise PermissionError("Only the host running the show can do that")
        return s

    def add_song(self, user, sid, pid, media_id, name, path, dur, now=False):
        s = self._mine(user, sid, pid)
        m = s["music"]
        if len(m["queue"]) >= QUEUE_MAX:
            raise ValueError(f"The queue is full ({QUEUE_MAX} songs)")
        m["n"] += 1
        item = {"qid": m["n"], "media": media_id, "name": name or "Song", "path": str(path), "dur": dur}
        if now:
            m["queue"].insert(0, item)
            m["hold"] = False
            if m["playing"]:
                m["cmd"] = "skip"          # the one playing makes way (faded out)
        else:
            m["queue"].append(item)
        return self.music_state()

    async def kick(self, user, sid, pid, who):
        s = self._mine(user, sid, pid)
        if who == pid:
            raise ValueError("That's you")
        await self._drop_host(s, who)
        return self.music_state()

    def control(self, user, sid, pid, action, qid=None, on=None):
        s = self._mine(user, sid, pid)
        m = s["music"]
        if action == "talk":
            m["talk"] = (not m["talk"]) if on is None else bool(on)
        elif action == "stop":
            m["hold"] = True
            if m["playing"]:
                m["cmd"] = "stop"
        elif action == "skip":
            m["hold"] = False
            if m["playing"]:
                m["cmd"] = "skip"
        elif action == "play":
            m["hold"] = False
        elif action == "remove":
            gone = [q for q in m["queue"] if q["qid"] == qid]
            m["queue"] = [q for q in m["queue"] if q["qid"] != qid]
            for q in gone:
                self.forget_media(q["media"])
        else:
            raise ValueError("Unknown action")
        return self.music_state()

    def next_song(self):
        """For the radio loop: the next song to play, if it's time for one."""
        s = self.on_air()
        if not s:
            return None
        m = s["music"]
        if m["playing"] or m["hold"] or not m["queue"]:
            return None
        m["playing"] = dict(m["queue"].pop(0), started=time.time())
        return m["playing"]

    def song_done(self, item):
        s = self.session
        if s and s["music"]["playing"] is item:
            s["music"]["playing"] = None
            s["music"]["cmd"] = None
        self.forget_media(item["media"])

    def music_state(self):
        s = self.on_air()
        if not s:
            return None
        m = s["music"]
        p = m["playing"]
        return {"playing": {"qid": p["qid"], "name": p["name"], "dur": p["dur"], "started": p["started"]} if p else None,
                "queue": [{"qid": q["qid"], "name": q["name"], "dur": q["dur"]} for q in m["queue"]],
                "talk": m["talk"], "hold": m["hold"]}

    def should_end(self):
        s = self.on_air()
        if not s:
            return False
        now = time.time()
        return not s["hosts"] or now - s["last"] > QUIET_ENDS_AFTER or now - s["started"] > LIVE_MAX_HOURS * 3600

    async def stop(self, why="the host ended it"):
        s = self.on_air()
        if not s:
            return
        s["ended"] = True
        for pid in list(s["hosts"]):
            p = s["hosts"][pid]
            if p["reader"]:
                p["reader"].cancel()
            await _end_proc(p["proc"])
            await _end_proc(p["ret"])
        m = s["music"]
        for q in m["queue"] + ([m["playing"]] if m["playing"] else []):
            self.forget_media(q["media"])
        m["queue"] = []
        n = await asyncio.to_thread(self._forget_chat, s["id"])
        mins = (time.time() - s["started"]) / 60
        print(f"Live: '{s['title']}' is off air after {mins:.0f} min ({why}); "
              f"chat '{s['room']}' closed, {n} messages deleted")
        if s["rec"]:
            asyncio.ensure_future(self._finish_recording(s))

    async def _finish_recording(self, s):
        if s["off_since"] is not None:
            s["off"].append([s["off_since"], time.time() - s["started"]])
        await asyncio.to_thread(self.recordings.finish, s["rec"], s["off"], s["music_at"])
        for tape in (s["tune"], s["air"]):
            if tape:
                await tape.close()
        await self.recordings.seal_air(s["rec"])
        await self.recordings.mix_if_ready(s["rec"])    # (if the hosts' recordings came in that fast)

    def _forget_chat(self, sid):
        with self._conn() as c:
            return c.execute("DELETE FROM live_chat WHERE stream = ?", (sid,)).rowcount

    # ---- the chat ------------------------------------------------------
    def messages(self, after=0):
        s = self.on_air()
        if not s:
            return []
        with self._conn() as c:
            rows = c.execute("""SELECT id, at, name, text, host FROM live_chat
                                WHERE stream = ? AND id > ? ORDER BY id DESC LIMIT 60""",
                             (s["id"], int(after or 0))).fetchall()
        return [{"id": r["id"], "at": r["at"], "name": r["name"], "text": r["text"], "host": bool(r["host"])}
                for r in reversed(rows)]

    def _limited(self, keys):
        now = time.time()
        for key, gap, per_min in keys:
            hits = [t for t in self.recent.get(key, []) if now - t < 60]
            if (hits and now - hits[-1] < gap) or len(hits) >= per_min:
                return True
        for key, _gap, _n in keys:
            self.recent[key] = [t for t in self.recent.get(key, []) if now - t < 60] + [now]
        if len(self.recent) > 5000:
            self.recent = {k: v for k, v in self.recent.items() if v and now - v[-1] < 60}
        return False

    def say(self, name, text, ip, device="", host=None):
        s = self.on_air()
        if not s:
            raise LookupError("The chat is closed: nobody is live right now.")
        text = self.clean(text)
        if not text:
            raise ValueError("Write something first.")
        if len(text) > CHAT_MAX:
            raise ValueError(f"Keep it to {CHAT_MAX} letters or fewer.")
        if host:
            name = self._name(name, host)          # (several people can share one login)
        else:
            name = self.clean(name)[:NAME_MAX] or "Listener"
            why = self.problem(name) or self.problem(text)
            if why:
                raise ValueError(why)
            if re.fullmatch(r"(?i)host|raadio|admin|studio", name):
                name = name + " (listener)"
            dev = device if re.fullmatch(r"[a-z0-9]{8,32}", device or "") else ip
            if self._limited([("d:" + dev, CHAT_GAP, CHAT_PER_MINUTE), ("ip:" + ip, 0, CHAT_PER_MINUTE * 3)]):
                raise OverflowError("Slow down a little.")
        with self._conn() as c:
            cur = c.execute("INSERT INTO live_chat (stream, at, name, text, host) VALUES (?, ?, ?, ?, ?)",
                            (s["id"], time.time(), name, text, 1 if host else 0))
            c.execute("""DELETE FROM live_chat WHERE stream = ? AND id <= ?""", (s["id"], cur.lastrowid - CHAT_KEEP))
        return {"id": cur.lastrowid}

    def state(self):
        s = self.on_air()
        if not s:
            return None
        return {"title": s["title"], "host": self.host_label(), "room": s["room"], "since": s["started"]}


def build_live_router(live: LiveStudio, current_user, get_client_ip, user_for_token, find_media=None):
    r = APIRouter()

    async def _json(request):
        try:
            data = await request.json()
        except ValueError:
            data = {}
        return data if isinstance(data, dict) else {}

    def status_of(e):
        if isinstance(e, LookupError):
            return 404
        if isinstance(e, PermissionError):
            return 403
        if isinstance(e, OverflowError):
            return 429
        return 400

    # ---- studio ----
    @r.get("/api/live")
    async def live_state(p: str = "", user=Depends(current_user)):
        s = live.on_air()
        me = s["hosts"].get(p) if s else None
        mine = bool(me and me["user"].lower() == user["username"].lower())
        author = bool(mine and s["author"] == p)
        runs = bool(s and (author or s["user"].lower() == user["username"].lower() or user.get("role") == "curator"))
        return {"live": live.state(), "now": time.time(), "id": s["id"] if s else None, "mine": mine, "author": author,
                "can_end": runs, "headphones": bool(s and s["headphones"]), "hosts": live.hosts_state(),
                "full": bool(s and len(s["hosts"]) >= HOSTS_MAX), "music": live.music_state() if author else None}

    @r.post("/api/live/start")
    async def go_live(request: Request, user=Depends(current_user)):
        data = await _json(request)
        try:
            s, p = await live.start(user["username"], data.get("title"), data.get("name"), data.get("headphones"))
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        return {"id": s["id"], "p": p["p"], "name": p["name"], "room": s["room"], "title": s["title"], "now": time.time()}

    @r.post("/api/live/{sid}/join")
    async def join(sid: str, request: Request, user=Depends(current_user)):
        data = await _json(request)
        try:
            s, p = await live.join(user["username"], sid, data.get("name"), data.get("headphones"))
        except (LookupError, ValueError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        return {"id": s["id"], "p": p["p"], "name": p["name"], "room": s["room"], "title": s["title"], "now": time.time()}

    @r.post("/api/live/{sid}/leave")
    async def leave(sid: str, request: Request, user=Depends(current_user)):
        data = await _json(request)
        try:
            await live.leave(user["username"], sid, str(data.get("p", "")))
        except (LookupError, PermissionError):
            pass
        return {"ok": True}

    @r.put("/api/live/{sid}/audio")
    async def audio(sid: str, request: Request, p: str = "", g: int = 0, user=Depends(current_user)):
        body = b""
        async for chunk in request.stream():
            body += chunk
            if len(body) > PIECE_MAX:
                raise HTTPException(413, "That piece of audio is too big")
        try:
            await live.feed(user["username"], sid, p, g, body)
        except BlockingIOError as e:
            raise HTTPException(409, str(e)) from None
        except (LookupError, PermissionError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        return {"ok": True}

    @r.get("/api/live/{sid}/return")
    async def hear_others(sid: str, p: str = "", kbit: int = 24, user=Depends(current_user)):
        try:
            body = await live.open_return(user["username"], sid, p, kbit)
        except (LookupError, PermissionError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        return StreamingResponse(body, media_type="audio/ogg",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    # ---- the recordings ----
    @r.get("/api/live/recordings")
    async def recordings(user=Depends(current_user)):
        items = await asyncio.to_thread(live.recordings.list_for, user["username"], user.get("role") == "curator")
        return {"items": items, "now": time.time()}

    @r.post("/api/live/recordings/{rid}/link")
    async def recording_link(rid: str, request: Request, user=Depends(current_user)):
        data = await _json(request)
        try:
            url = await asyncio.to_thread(live.recordings.link, rid, str(data.get("kind", "")), user["username"],
                                          user.get("role") == "curator")
        except (LookupError, ValueError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        return {"url": url}

    @r.get("/api/live/recordings/{rid}/{kind}.m4a")
    async def recording_file(rid: str, kind: str, t: str = ""):
        # (a plain link, so the browser's own download can resume: the token is the permission)
        try:
            path, name = live.recordings.file_for(rid, kind, t)
        except (LookupError, PermissionError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        return FileResponse(path, media_type="audio/mp4", filename=name, headers={"Cache-Control": "no-store"})

    @r.post("/api/live/{sid}/takes")
    async def new_take(sid: str, request: Request, user=Depends(current_user)):
        data = await _json(request)
        s = live.on_air()
        try:
            if not s or s["id"] != sid:
                raise LookupError("This stream has ended")
            if not s["rec"]:
                raise ValueError("This show isn't being recorded")
            _s, p = live._host(user["username"], sid, str(data.get("p", "")))
            take = await asyncio.to_thread(live.recordings.new_take, s["rec"], user["username"], p["name"],
                                           data.get("mime"), float(data.get("t0") or time.time()))
        except (LookupError, PermissionError, ValueError, TypeError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        return {"take": take}

    @r.get("/api/live/takes/{take}")
    async def take_state(take: str, user=Depends(current_user)):
        try:
            return await asyncio.to_thread(live.recordings.take_state, take, user["username"])
        except (LookupError, PermissionError) as e:
            raise HTTPException(status_of(e), str(e)) from None

    @r.put("/api/live/takes/{take}/{n}")
    async def take_piece(take: str, n: int, request: Request, last: int = 0, user=Depends(current_user)):
        if not 0 <= n < 100000:
            raise HTTPException(400, "Bad piece number")
        body = b""
        async for chunk in request.stream():
            body += chunk
            if len(body) > TAKE_PIECE_MAX:
                raise HTTPException(413, "That piece is too big")
        try:
            rid = await asyncio.to_thread(live.recordings.put_piece, take, n, body, bool(last), user["username"])
        except OverflowError as e:
            raise HTTPException(507, str(e)) from None
        except (LookupError, PermissionError, ValueError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        if rid:
            asyncio.ensure_future(live.recordings.mix_if_ready(rid))
        return {"ok": True}

    @r.post("/api/live/{sid}/music")
    async def add_music(sid: str, request: Request, user=Depends(current_user)):
        try:
            data = await request.json()
        except ValueError:
            data = {}
        media = (find_media or (lambda i: None))(str((data or {}).get("media", "")))
        if not media:
            raise HTTPException(404, "Upload the song first")
        try:
            return live.add_song(user["username"], sid, str((data or {}).get("p", "")), media["id"], media["name"], media["path"],
                                 media.get("duration"), bool((data or {}).get("now")))
        except (LookupError, PermissionError, ValueError) as e:
            raise HTTPException(status_of(e), str(e)) from None

    @r.post("/api/live/{sid}/control")
    async def control(sid: str, request: Request, user=Depends(current_user)):
        try:
            data = await request.json()
        except ValueError:
            data = {}
        data = data if isinstance(data, dict) else {}
        try:
            qid = int(data["qid"]) if data.get("qid") is not None else None
            if data.get("action") == "kick":
                return await live.kick(user["username"], sid, str(data.get("p", "")), str(data.get("who", "")))
            return live.control(user["username"], sid, str(data.get("p", "")), str(data.get("action", "")), qid, data.get("on"))
        except (LookupError, PermissionError, ValueError, TypeError) as e:
            raise HTTPException(status_of(e), str(e)) from None

    @r.post("/api/live/{sid}/stop")
    async def stop(sid: str, user=Depends(current_user)):
        s = live.on_air()
        if s and s["id"] == sid and (s["user"].lower() == user["username"].lower() or user.get("role") == "curator"
                                     or any(h["p"] == s["author"] and h["user"].lower() == user["username"].lower()
                                            for h in s["hosts"].values())):
            await live.stop("the host ended it" if s["user"].lower() == user["username"].lower()
                            else f"ended by {user['username']}")
        return {"ok": True}

    # ---- everyone ----
    @r.get("/api/chat")
    async def chat(after: int = 0):
        return {"live": live.state(), "messages": await asyncio.to_thread(live.messages, after)}

    @r.post("/api/chat")
    async def say(request: Request):
        try:
            data = await request.json()
        except ValueError:
            raise HTTPException(400, "Expected JSON") from None
        if not isinstance(data, dict):
            raise HTTPException(400, "Expected a JSON object")
        host = None
        auth = request.headers.get("authorization", "")
        if auth[:7].lower() == "bearer ":
            u = user_for_token(auth[7:].strip())
            host = u["username"] if u else None
        try:
            out = await asyncio.to_thread(live.say, str(data.get("name", ""))[:80], str(data.get("text", ""))[:1000],
                                          get_client_ip(request), str(data.get("d", ""))[:40], host)
        except (LookupError, ValueError, OverflowError) as e:
            raise HTTPException(status_of(e), str(e)) from None
        return out

    return r
