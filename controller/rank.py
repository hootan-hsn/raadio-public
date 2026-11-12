"""Rotation tiers: star, 1, 0 (where every song starts), -1 and blocked.

Stored as a number in track_stats.rank: 2 = star, 1, 0, -1, -2 = blocked.

How listeners move a song (step() below):
- Every dislike adds 1 to the song's net, every like takes 1 off, and a play to the end
  takes off a little (FINISH). Net and plays both fade by half every HALF_DAYS, so old
  opinions wear off and a song can climb back.
- The tier comes from the rate, net per play: net / (plays + K). K plays' worth of
  neutral keeps a song with few plays near 0, and a song played often isn't judged
  harder just for collecting more votes.
- After a move the song starts MARGIN inside its new tier, not on the edge, and stays at
  least HOLD_DAYS (HAND_HOLD_DAYS when set by hand) before listeners can move it again.
  Moving down also needs dislikes from MIN_VOTERS different listeners.
- Each listener counts once per song per day (the controller checks; see song_votes).
- Star: many recent likes, a song pinned in the channel, or a new post. It lasts STAR_DAYS,
  then the song is tier 1. Nothing is star for good.
- Blocked stays blocked until someone changes it by hand in the studio.
"""
import hashlib
import secrets
import time

STAR, BLOCKED = 2, -2
ORDER = (STAR, 1, 0, -1, BLOCKED)             # best first
NAMES = {STAR: "star", 1: "1", 0: "0", -1: "-1", BLOCKED: "blocked"}
STAR_DAYS = 14
STAR_LOVE = 5.0                               # recent likes (each fading, see love_of) that make a star
HALF_DAYS = 30                                # net and plays fade by half in this long
K = 8.0                                       # plays' worth of neutral in every rate
DISLIKE, LIKE, FINISH = 1.0, -1.0, -0.1       # what each adds to net
# rate bands: at or below UP_AT -> 1; at or above DOWN_AT -> -1; at or above BLOCK_AT -> blocked
UP_AT, DOWN_AT, BLOCK_AT = -0.08, 0.25, 0.6
MARGIN = 0.05                                 # a moved song starts this far inside its new tier
HOLD_DAYS, HAND_HOLD_DAYS = 3, 7
MIN_VOTERS = 3                                # different listeners' dislikes to move a song down
ENTRY = {STAR: UP_AT - MARGIN, 1: UP_AT - MARGIN, 0: 0.0, -1: DOWN_AT + MARGIN, BLOCKED: BLOCK_AT}
# chance a song of this tier is in a round, and star songs' extra turns (they also get the
# priority slot every few songs, like new uploads always did)
CHANCE = {STAR: 1.0, 1: 1.0, 0: 0.6, -1: 0.25, BLOCKED: 0.0}
EXTRA_TURNS = {STAR: 1.0}
DAY = 86400


def parse(value):
    """A tier from the studio or the connector: "star", "1", "0", "-1", "blocked", or the number."""
    if isinstance(value, str):
        v = value.strip().lower().replace("−", "-").lstrip("+")
        for k, name in NAMES.items():
            if v == name:
                return k
        if v in ("ban", "banned", "block"):
            return BLOCKED
        try:
            value = int(v)
        except ValueError:
            raise ValueError("Tier must be star, 1, 0, -1 or blocked") from None
    if isinstance(value, bool) or not isinstance(value, int) or value not in NAMES:
        raise ValueError("Tier must be star, 1, 0, -1 or blocked")
    return value


def fade(value, at, now=None):
    """value as it stands now: halves every HALF_DAYS since at."""
    if not value or not at:
        return value or 0.0
    return value * 0.5 ** (max(0.0, (now or time.time()) - at) / (HALF_DAYS * DAY))


def rate(net, plays):
    return net / (max(0.0, plays) + K)


def from_rate(r):
    """1, 0, -1 or blocked, from the rate (a star or a blocked song keeps its tier: see step)."""
    if r >= BLOCK_AT:
        return BLOCKED
    if r >= DOWN_AT:
        return -1
    if r <= UP_AT:
        return 1
    return 0


def rebase(tier, plays):
    """The net that puts a song with these plays just inside tier."""
    return ENTRY[tier] * (max(0.0, plays) + K)


def set_by_hand(tier, plays, now=None):
    """A tier set in the studio: (net, star_until, hold_until)."""
    now = now or time.time()
    return (rebase(tier, plays), now + STAR_DAYS * DAY if tier == STAR else None,
            None if tier == BLOCKED else now + HAND_HOLD_DAYS * DAY)


def step(s, add=0.0, played=False, voters=0, now=None):
    """A song's state after one event. s: dict with rank, net, plays, at, star_until,
    hold_until. add: what the event adds to net (DISLIKE, LIKE or FINISH, times its weight);
    played: it was a play (to the end or skipped); voters: different listeners who disliked
    it lately. Returns the new state (with "moved": the old tier if it changed)."""
    now = now or time.time()
    t = s.get("rank") or 0
    net, plays = fade(s.get("net") or 0.0, s.get("at"), now), fade(s.get("plays") or 0.0, s.get("at"), now)
    net += add
    plays += 1 if played else 0
    out = {"rank": t, "net": net, "plays": plays, "at": now, "star_until": s.get("star_until"),
           "hold_until": s.get("hold_until"), "moved": None}
    if t == BLOCKED:
        return out
    if t == STAR:
        if s.get("star_until") and s["star_until"] > now:
            return out
        # (two weeks up: tier 1, starting just inside it)
        out.update(rank=1, net=rebase(1, plays), star_until=None, hold_until=now + HOLD_DAYS * DAY, moved=STAR)
        return out
    want = from_rate(rate(net, plays))
    if want == t or now < (s.get("hold_until") or 0):
        return out
    if want < t and voters < MIN_VOTERS:
        return out
    out.update(rank=want, net=rebase(want, plays), star_until=None, hold_until=now + HOLD_DAYS * DAY, moved=t)
    return out


def from_old_tier(tier, blacklisted, boost, love):
    """The old tiers (1 plays most .. 5 banned, with a 0-3 boost): a one-time move."""
    tier = tier or 1
    if blacklisted or tier >= 5:
        return BLOCKED
    if tier >= 3:
        return -1
    if tier == 2:
        return 0
    return 1 if (boost or 0) > 0 or (love or 0) >= 2 else 0


def ensure_columns(conn, now=None):
    """Add the columns the tiers need, moving older data over once: the old 1-5 tiers to
    rank, and old scores to a fading net and plays (each song just inside its tier).
    Returns how many songs moved."""
    now = now or time.time()
    cols = {r[1] for r in conn.execute("PRAGMA table_info(track_stats)")}
    if not cols:
        return 0
    moved = 0
    if "rank" not in cols:
        conn.execute("ALTER TABLE track_stats ADD COLUMN rank INTEGER DEFAULT 0")
        conn.execute("ALTER TABLE track_stats ADD COLUMN star_until REAL")
        pick = ", ".join(c if c in cols else "NULL" for c in ("tier", "is_blacklisted", "boost", "love"))
        rows = conn.execute(f"SELECT telegram_msg_id, {pick} FROM track_stats").fetchall()
        for mid, tier, bl, boost, love in rows:
            r = from_old_tier(tier, bl, boost, love)
            conn.execute("UPDATE track_stats SET rank = ?, is_blacklisted = ? WHERE telegram_msg_id = ?",
                         (r, 1 if r == BLOCKED else 0, mid))
        moved = len(rows)
    if "plays_w" not in cols:
        # (skip_score now holds the fading net; plays_w the fading plays; score_at: as of when)
        conn.execute("ALTER TABLE track_stats ADD COLUMN plays_w REAL DEFAULT 0")
        conn.execute("ALTER TABLE track_stats ADD COLUMN score_at REAL")
        conn.execute("ALTER TABLE track_stats ADD COLUMN hold_until REAL")
        pc = "play_count" if "play_count" in cols else "0"
        rows = conn.execute(f"SELECT telegram_msg_id, COALESCE(rank, 0), COALESCE({pc}, 0) FROM track_stats").fetchall()
        for mid, r, pcount in rows:
            plays = float(min(pcount, 10))
            conn.execute("UPDATE track_stats SET plays_w = ?, skip_score = ?, score_at = ? WHERE telegram_msg_id = ?",
                         (plays, rebase(r if r in ENTRY else 0, plays), now, mid))
        moved = moved or len(rows)
    conn.execute("""CREATE TABLE IF NOT EXISTS song_votes (
        telegram_msg_id INTEGER NOT NULL, voter TEXT NOT NULL, day INTEGER NOT NULL, kind TEXT NOT NULL,
        PRIMARY KEY (telegram_msg_id, voter, day, kind))""")
    return moved


def _voter_key(conn, voter):
    """A listener's address and device, hashed with a secret kept in the database: the
    table can tell votes apart but never says who listens."""
    conn.execute("CREATE TABLE IF NOT EXISTS song_votes_salt (salt TEXT NOT NULL)")
    row = conn.execute("SELECT salt FROM song_votes_salt").fetchone()
    if row is None:
        row = (secrets.token_hex(16),)
        conn.execute("INSERT INTO song_votes_salt VALUES (?)", row)
    return hashlib.sha256((row[0] + "|" + voter).encode()).hexdigest()[:20]


def count_vote(conn, msg_id, voter, kind, now=None):
    """Note this listener's like or dislike of the song today. True if it's their first
    of that kind today (only then does it count)."""
    day = int((now or time.time()) // DAY)
    return conn.execute("INSERT OR IGNORE INTO song_votes VALUES (?, ?, ?, ?)",
                        (msg_id, _voter_key(conn, voter), day, kind)).rowcount == 1


def voters(conn, msg_id, now=None):
    """Different listeners who disliked the song in the last HALF_DAYS."""
    since = int((now or time.time()) // DAY) - HALF_DAYS
    return conn.execute("SELECT COUNT(DISTINCT voter) FROM song_votes WHERE telegram_msg_id = ? "
                        "AND kind = 'dislike' AND day >= ?", (msg_id, since)).fetchone()[0]


def prune_votes(conn, now=None):
    conn.execute("DELETE FROM song_votes WHERE day < ?", (int((now or time.time()) // DAY) - HALF_DAYS,))
