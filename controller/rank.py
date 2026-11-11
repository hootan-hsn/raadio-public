"""Rotation tiers: star, 1, 0 (where every song starts), -1 and blocked.

Stored as a number in track_stats.rank: 2 = star, 1, 0, -1, -2 = blocked.

- Dislikes (skip votes) push a song's score up, likes and plays to the end bring it down;
  the score decides 1 / 0 / -1, and a song disliked far enough is blocked.
- Star: many recent likes, a song pinned in the channel, or a new post. It lasts STAR_DAYS,
  then the song is tier 1. Nothing is star for good.
- Blocked stays blocked until someone changes it by hand in the studio.
- Every tier can be set by hand in the studio; a song set by hand starts from the bottom of
  that tier's score range, so listeners' likes and dislikes carry on from there.
"""
import time

STAR, BLOCKED = 2, -2
ORDER = (STAR, 1, 0, -1, BLOCKED)             # best first
NAMES = {STAR: "star", 1: "1", 0: "0", -1: "-1", BLOCKED: "blocked"}
STAR_DAYS = 14
STAR_LOVE = 5.0                               # recent likes (each fading, see love_of) that make a star
# score bands: at or below UP_AT -> 1; at or above DOWN_AT -> -1; at or above BLOCK_AT -> blocked
UP_AT, DOWN_AT, BLOCK_AT = -1.5, 1.5, 4.0
SCORE_MIN = -3.0
ANCHOR = {STAR: UP_AT, 1: UP_AT, 0: 0.0, -1: DOWN_AT, BLOCKED: BLOCK_AT}
# chance a song of this tier is in a round, and star songs' extra turns (they also get the
# priority slot every few songs, like new uploads always did)
CHANCE = {STAR: 1.0, 1: 1.0, 0: 0.6, -1: 0.25, BLOCKED: 0.0}
EXTRA_TURNS = {STAR: 1.0}


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


def from_score(score):
    """1, 0, -1 or blocked, from listeners' score (a star or a blocked song keeps its tier: see settle)."""
    if score >= BLOCK_AT:
        return BLOCKED
    if score >= DOWN_AT:
        return -1
    if score <= UP_AT:
        return 1
    return 0


def settle(rank, score, star_until, now=None):
    """The tier a song is in after its score changed, and its star end (None if not a star).
    A star stays one until its time is up (then tier 1); blocked stays blocked."""
    now = now or time.time()
    if rank == BLOCKED:
        return BLOCKED, None
    if rank == STAR:
        if star_until and star_until > now:
            return STAR, star_until
        return 1, None
    return from_score(score), None


def clamp(score):
    return max(SCORE_MIN, min(BLOCK_AT, score))


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


def ensure_columns(conn):
    """Add rank and star_until to track_stats if they aren't there yet, moving the old tiers
    over once (each song's score starts at the bottom of its new tier). Returns how many moved."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(track_stats)")}
    if not cols or "rank" in cols:
        return 0
    conn.execute("ALTER TABLE track_stats ADD COLUMN rank INTEGER DEFAULT 0")
    conn.execute("ALTER TABLE track_stats ADD COLUMN star_until REAL")
    pick = ", ".join(c if c in cols else "NULL" for c in ("tier", "is_blacklisted", "boost", "love"))
    rows = conn.execute(f"SELECT telegram_msg_id, {pick} FROM track_stats").fetchall()
    for mid, tier, bl, boost, love in rows:
        r = from_old_tier(tier, bl, boost, love)
        conn.execute("UPDATE track_stats SET rank = ?, skip_score = ?, is_blacklisted = ? WHERE telegram_msg_id = ?",
                     (r, ANCHOR[r], 1 if r == BLOCKED else 0, mid))
    return len(rows)
