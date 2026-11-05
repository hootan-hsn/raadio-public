"""
Raadio studio: user accounts, uploaded audio and the shared on-air schedule.

Standard library only, so the user CLI (manage_users.py) can use it too.
The web API on top of this lives in studio_api.py.

Everything is stored under DATA_DIR:
    studio.db             users, login sessions, media, schedules
    studio/media/<id>     the uploaded and recorded audio files
"""
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, UTC
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SESSION_DAYS = 30            # a login stays valid this long
GRACE_SECONDS = 15 * 60      # a show missed (server down) still airs if at most this late
MAX_REPEAT = 50              # "Play times" upper limit, same as the web form
NOTE_MAX = 300                 # letters in a note on a scheduled item
NOTES_PER_ITEM = 30
MAX_NAME = 120
SHOW_NAME_MIN = 2            # names on the schedule (shown to listeners in "Coming up")
SHOW_NAME_MAX = 60
MIN_PASSWORD = 8
MAX_OFFSET = 6               # extra airings: any of the 6 days after the first
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
MEDIA_ID_RE = re.compile(r"^[a-f0-9]{16}$")
KINDS = ("upload", "recording")
ROLES = ("member", "curator")     # curators also get the tier and analytics tools


# =====================================================================
# Passwords (scrypt, built into Python)
# =====================================================================
_SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        check = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                               n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(digest)))
        return hmac.compare_digest(check.hex(), digest)
    except (ValueError, TypeError):
        return False


_DUMMY_HASH = None


def _dummy_hash():
    # Checked when the username doesn't exist, so a wrong name takes as long as a wrong password
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_hex(8))
    return _DUMMY_HASH


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# =====================================================================
# Time helpers
# =====================================================================
def get_zone(name):
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def parse_time(value) -> float:
    """ISO 8601 string ('2026-10-17T20:00:00.000Z') or epoch seconds -> epoch seconds."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str) or not value:
        raise ValueError("startsAt is missing")
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError("startsAt isn't a valid date") from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def iso(ts):
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z")


def air_times(starts_at: float, offsets, tz_name: str):
    """Every air time of an item: the first one, plus the same wall-clock time
    on each chosen following day (offset 1 = next day ... 6). Summer/winter
    time changes keep the local time, as listeners would expect."""
    tz = get_zone(tz_name)
    start = datetime.fromtimestamp(starts_at, tz)
    out = []
    for k in sorted(set(offsets) | {0}):
        if k == 0:
            out.append(starts_at)
            continue
        d = start.date() + timedelta(days=k)
        out.append(datetime(d.year, d.month, d.day, start.hour, start.minute,
                            start.second, tzinfo=tz).timestamp())
    return out


def next_occurrence(starts_at: float, offsets, tz_name: str, after: float):
    """First air time strictly after `after`, or None when the item is finished."""
    for t in air_times(starts_at, offsets, tz_name):
        if t > after:
            return t
    return None


def _weekly_days_to_offsets(starts_at, days, tz_name):
    """Migration: old weekly items become the matching days of their first week."""
    if not days:
        return [0]
    tz = get_zone(tz_name)
    start = datetime.fromtimestamp(starts_at, tz)
    found = [k for k in range(7)
             if ((start.date() + timedelta(days=k)).weekday() + 1) % 7 in days]
    return found or [0]


# =====================================================================
# Studio store
# =====================================================================
class Studio:
    def __init__(self, data_dir):
        data_dir = Path(data_dir)
        self.db_path = data_dir / "studio.db"
        self.media_dir = data_dir / "studio" / "media"
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self._due_cache = None          # (computed_at, [(next_air, schedule_id), ...])
        self._init_db()

    # ---- database ----------------------------------------------------
    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_db(self):
        with self._conn() as c:
            c.execute("PRAGMA journal_mode = WAL")
            c.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    pw_hash TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS media (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    duration REAL,
                    uploaded_by TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY,
                    media_id TEXT NOT NULL REFERENCES media(id),
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    starts_at REAL NOT NULL,
                    tz TEXT NOT NULL,
                    repeat INTEGER NOT NULL,
                    days TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    last_aired_at REAL
                );
            """)
            # notes any host can leave on a scheduled item (go with it when it's deleted)
            c.execute("""CREATE TABLE IF NOT EXISTS schedule_notes (
                             id INTEGER PRIMARY KEY AUTOINCREMENT,
                             schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
                             author TEXT NOT NULL, text TEXT NOT NULL, at REAL NOT NULL)""")
            ucols = {r[1] for r in c.execute("PRAGMA table_info(users)")}
            if "role" not in ucols:
                c.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'")
            cols = {r[1] for r in c.execute("PRAGMA table_info(schedules)")}
            if "offsets" not in cols:
                c.execute("ALTER TABLE schedules ADD COLUMN offsets TEXT")
            for r in c.execute("SELECT id, starts_at, days, tz FROM schedules "
                               "WHERE offsets IS NULL").fetchall():
                offs = _weekly_days_to_offsets(r["starts_at"], json.loads(r["days"]), r["tz"])
                c.execute("UPDATE schedules SET offsets = ? WHERE id = ?", (json.dumps(offs), r["id"]))

    # ---- users -------------------------------------------------------
    @staticmethod
    def _check_password(password):
        if len(password) < MIN_PASSWORD:
            raise ValueError(f"Password needs at least {MIN_PASSWORD} characters")

    def add_user(self, username, password):
        username = (username or "").strip()
        if not USERNAME_RE.match(username):
            raise ValueError("Username: 2-32 letters, numbers, dots, dashes or underscores")
        self._check_password(password)
        try:
            with self._conn() as c:
                c.execute("INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)",
                          (username, hash_password(password), time.time()))
        except sqlite3.IntegrityError:
            raise ValueError(f"User {username} already exists") from None

    def set_password(self, username, password):
        self._check_password(password)
        with self._conn() as c:
            row = c.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if not row:
                raise LookupError(f"No user called {username}")
            c.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(password), row["id"]))
            c.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))   # log out everywhere

    def set_role(self, username, role):
        if role not in ROLES:
            raise ValueError(f"Role must be one of: {', '.join(ROLES)}")
        with self._conn() as c:
            if c.execute("UPDATE users SET role = ? WHERE username = ?", (role, username)).rowcount == 0:
                raise LookupError(f"No user called {username}")

    def remove_user(self, username):
        with self._conn() as c:
            if c.execute("DELETE FROM users WHERE username = ?", (username,)).rowcount == 0:
                raise LookupError(f"No user called {username}")

    def list_users(self):
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT username, role, created_at FROM users ORDER BY username")]

    def authenticate(self, username, password):
        """Returns {'id', 'username'} or None. Takes the same time either way."""
        with self._conn() as c:
            row = c.execute("SELECT id, username, role, pw_hash FROM users WHERE username = ?",
                            ((username or "").strip(),)).fetchone()
        if row is None:
            verify_password(password or "", _dummy_hash())
            return None
        if not verify_password(password or "", row["pw_hash"]):
            return None
        return {"id": row["id"], "username": row["username"], "role": row["role"]}

    def create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._conn() as c:
            c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            c.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)",
                      (_token_hash(token), user_id, now, now + SESSION_DAYS * 86400))
        return token, now + SESSION_DAYS * 86400

    def user_for_token(self, token):
        if not token:
            return None
        with self._conn() as c:
            row = c.execute("""
                SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ?
            """, (_token_hash(token), time.time())).fetchone()
        return dict(row) if row else None

    def end_session(self, token):
        with self._conn() as c:
            c.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))

    # ---- media -------------------------------------------------------
    @staticmethod
    def new_media_id():
        return secrets.token_hex(8)

    def media_path(self, media_id):
        if not MEDIA_ID_RE.match(media_id or ""):
            raise ValueError("Bad media id")
        return self.media_dir / media_id

    @staticmethod
    def clean_name(name, fallback="Untitled"):
        name = re.sub(r"\s+", " ", str(name or "")).strip()[:MAX_NAME]
        return name or fallback

    def add_media(self, media_id, name, kind, size, duration, username):
        if kind not in KINDS:
            kind = "upload"
        with self._conn() as c:
            c.execute("INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?)",
                      (media_id, self.clean_name(name), kind, size, duration, username, time.time()))
        return {"id": media_id, "name": self.clean_name(name), "kind": kind,
                "size": size, "duration": duration}

    def get_media(self, media_id):
        """An upload: {id, name, duration, path}, or None."""
        try:
            path = self.media_path(media_id)
        except ValueError:
            return None
        with self._conn() as c:
            r = c.execute("SELECT id, name, duration FROM media WHERE id = ?", (media_id,)).fetchone()
        if not r or not path.is_file():
            return None
        return {"id": r["id"], "name": r["name"], "duration": r["duration"], "path": path}

    def _delete_media_if_unused(self, c, media_id):
        if c.execute("SELECT 1 FROM schedules WHERE media_id = ?", (media_id,)).fetchone():
            return
        c.execute("DELETE FROM media WHERE id = ?", (media_id,))
        try:
            self.media_path(media_id).unlink(missing_ok=True)
        except ValueError:
            pass

    def delete_media(self, media_id):
        """Drop an upload that was never scheduled (the user cancelled)."""
        path = self.media_path(media_id)                    # validates the id
        with self._conn() as c:
            if c.execute("SELECT 1 FROM schedules WHERE media_id = ?", (media_id,)).fetchone():
                raise ValueError("That audio is on the schedule; delete the schedule item instead")
            if c.execute("DELETE FROM media WHERE id = ?", (media_id,)).rowcount == 0:
                raise LookupError("No such upload")
        path.unlink(missing_ok=True)

    # ---- schedules ---------------------------------------------------
    # An item airs at starts_at, and again at the same local time on each chosen
    # following day ("offsets", 1-6). After its last airing it is deleted, file and all.
    @staticmethod
    def _offsets(r):
        return json.loads(r["offsets"] or "[0]")

    def _row_to_item(self, r, now=None):
        now = now or time.time()
        offsets = self._offsets(r)
        times = air_times(r["starts_at"], offsets, r["tz"])
        after = max(r["last_aired_at"] or 0, now - 1)
        return {
            "id": r["id"],
            "mediaId": r["media_id"],
            "name": r["name"],
            "kind": r["kind"],
            "startsAt": iso(r["starts_at"]),
            "tz": r["tz"],
            "repeat": r["repeat"],
            "offsets": offsets,
            "airTimes": [iso(t) for t in times],
            "remaining": sum(1 for t in times if t > after),
            "nextAir": iso(next_occurrence(r["starts_at"], offsets, r["tz"], after)),
            "createdBy": r["created_by"],
            "duration": r["duration"],
            "notes": self._notes_for(r["id"]),
        }

    # ---- notes on scheduled items (any host) ---------------------------
    def _notes_for(self, sid):
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT id, author, text, at FROM schedule_notes WHERE schedule_id = ? ORDER BY id", (sid,))]

    def add_schedule_note(self, sid, author, text):
        text = re.sub(r"\s+", " ", str(text or "")).strip()
        if not text:
            raise ValueError("Write something first")
        if len(text) > NOTE_MAX:
            raise ValueError(f"Keep a note to {NOTE_MAX} characters")
        if any(ord(ch) < 32 for ch in text):
            raise ValueError("A note can't contain control characters")
        with self._conn() as c:
            if not c.execute("SELECT 1 FROM schedules WHERE id = ?", (sid,)).fetchone():
                raise LookupError("That item isn't on the schedule any more")
            if c.execute("SELECT COUNT(*) FROM schedule_notes WHERE schedule_id = ?", (sid,)).fetchone()[0] >= NOTES_PER_ITEM:
                raise ValueError(f"That item has {NOTES_PER_ITEM} notes already; remove one first")
            c.execute("INSERT INTO schedule_notes (schedule_id, author, text, at) VALUES (?, ?, ?, ?)",
                      (sid, author, text, time.time()))
        return self.get_schedule(sid)

    def remove_schedule_note(self, sid, note_id, user):
        """Its author can remove a note; so can a curator."""
        with self._conn() as c:
            row = c.execute("SELECT author FROM schedule_notes WHERE id = ? AND schedule_id = ?",
                            (note_id, sid)).fetchone()
            if not row:
                raise LookupError("That note is gone already")
            if row["author"].lower() != user["username"].lower() and user.get("role") != "curator":
                raise PermissionError("Only whoever wrote a note (or a curator) can remove it")
            c.execute("DELETE FROM schedule_notes WHERE id = ?", (note_id,))
        return self.get_schedule(sid)

    _SELECT = """SELECT s.*, m.duration FROM schedules s JOIN media m ON m.id = s.media_id"""

    def list_schedules(self):
        with self._conn() as c:
            rows = c.execute(self._SELECT).fetchall()
        items = [self._row_to_item(r) for r in rows]
        items.sort(key=lambda it: it["nextAir"] or "~")       # finished ones last
        return items

    def get_schedule(self, sid):
        with self._conn() as c:
            r = c.execute(self._SELECT + " WHERE s.id = ?", (sid,)).fetchone()
        if not r:
            raise LookupError("That item isn't on the schedule any more")
        return self._row_to_item(r)

    @staticmethod
    def _clean_fields(data, partial=False):
        """Validate schedule fields from the web form. Returns only what was given."""
        out = {}
        if "startsAt" in data or not partial:
            out["starts_at"] = parse_time(data.get("startsAt"))
        if "repeat" in data or not partial:
            try:
                out["repeat"] = max(1, min(MAX_REPEAT, int(data.get("repeat", 1))))
            except (TypeError, ValueError):
                raise ValueError("Play times must be a number") from None
        if "offsets" in data or not partial:
            offs = data.get("offsets") or [0]
            if not isinstance(offs, list) or not all(
                    isinstance(d, int) and not isinstance(d, bool) and 0 <= d <= MAX_OFFSET for d in offs):
                raise ValueError(f"Repeat days must be 0-{MAX_OFFSET} days after the first airing")
            out["offsets"] = sorted(set(offs) | {0})
        if "tz" in data or not partial:
            out["tz"] = str(get_zone(data.get("tz")))
        if "name" in data:
            name = re.sub(r"\s+", " ", str(data.get("name") or "")).strip()
            if len(name) < SHOW_NAME_MIN:
                raise ValueError(f"Name needs at least {SHOW_NAME_MIN} characters")
            if len(name) > SHOW_NAME_MAX:            # long file names are cut, not refused
                name = name[:SHOW_NAME_MAX].rstrip(" -_.,;:(")
            if any(ord(ch) < 32 for ch in name):
                raise ValueError("Name can't contain control characters")
            out["name"] = name
        return out

    @staticmethod
    def _unique_name(c, name, exclude_id=None):
        """Same name as another item on the schedule? Add (2), (3)..."""
        taken = {r["name"].lower() for r in c.execute(
            "SELECT name FROM schedules WHERE id != ?", (exclude_id or "",))}
        if name.lower() not in taken:
            return name
        n = 2
        while True:
            suffix = f" ({n})"
            candidate = name[:SHOW_NAME_MAX - len(suffix)].rstrip() + suffix
            if candidate.lower() not in taken:
                return candidate
            n += 1

    def create_schedule(self, username, data):
        fields = self._clean_fields(data)
        media_id = data.get("mediaId")
        now = time.time()
        if fields["starts_at"] < now - 60:
            raise ValueError("Pick a time later than now")
        sid = secrets.token_hex(8)
        with self._conn() as c:
            media = c.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
            if not media:
                raise ValueError("Upload the audio first")
            name = fields.get("name") or self.clean_name(media["name"])[:SHOW_NAME_MAX].rstrip()
            name = self._unique_name(c, name)
            c.execute("""INSERT INTO schedules (id, media_id, name, kind, starts_at, tz, repeat,
                                                days, offsets, created_by, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)""", (
                sid, media_id, name, media["kind"],
                fields["starts_at"], fields["tz"], fields["repeat"], json.dumps(fields["offsets"]),
                username, now, now))
        self.invalidate()
        return self.get_schedule(sid)

    def update_schedule(self, sid, data):
        fields = self._clean_fields(data, partial=True)
        if not fields:
            return self.get_schedule(sid)
        self.get_schedule(sid)                                  # 404 if gone
        if "starts_at" in fields and fields["starts_at"] < time.time() - 60:
            raise ValueError("Pick a time later than now")
        cols = {k: (json.dumps(v) if k == "offsets" else v) for k, v in fields.items()}
        if "starts_at" in cols or "offsets" in cols:
            cols["last_aired_at"] = None          # a new time counts as not aired yet
        cols["updated_at"] = time.time()
        with self._conn() as c:
            if "name" in cols:
                cols["name"] = self._unique_name(c, cols["name"], exclude_id=sid)
            sets = ", ".join(f"{k} = ?" for k in cols)
            c.execute(f"UPDATE schedules SET {sets} WHERE id = ?", (*cols.values(), sid))
        self.invalidate()
        return self.get_schedule(sid)

    def delete_schedule(self, sid):
        with self._conn() as c:
            row = c.execute("SELECT media_id FROM schedules WHERE id = ?", (sid,)).fetchone()
            if not row:
                raise LookupError("That item isn't on the schedule any more")
            c.execute("DELETE FROM schedules WHERE id = ?", (sid,))
            self._delete_media_if_unused(c, row["media_id"])
        self.invalidate()

    def upcoming(self, limit=5, now=None):
        """Next air time of each scheduled item, soonest first, for 'Coming up'."""
        now = now or time.time()
        rows = []
        with self._conn() as c:
            for r in c.execute("SELECT * FROM schedules"):
                after = max(r["last_aired_at"] or 0, now - 1)
                at = next_occurrence(r["starts_at"], self._offsets(r), r["tz"], after)
                if at is not None:
                    rows.append((at, {"at": iso(at), "name": r["name"], "repeat": r["repeat"]}))
        rows.sort(key=lambda x: x[0])
        return [r for _, r in rows[:limit]]

    # ---- playback ----------------------------------------------------
    def invalidate(self):
        self._due_cache = None

    def next_due_at(self, now=None):
        """Earliest air time not yet played (cached; called ten times a second)."""
        now = now or time.time()
        if self._due_cache is None or now - self._due_cache[0] > 60:
            items = []
            with self._conn() as c:
                for r in c.execute(self._SELECT):          # same rows take_due() uses
                    after = max(r["last_aired_at"] or 0, now - GRACE_SECONDS)
                    at = next_occurrence(r["starts_at"], self._offsets(r), r["tz"], after)
                    if at is not None:
                        items.append((at, r["id"]))
            items.sort()
            self._due_cache = (now, items)
        items = self._due_cache[1]
        return items[0][0] if items else None

    def has_due(self, now=None):
        now = now or time.time()
        at = self.next_due_at(now)
        return at is not None and at <= now

    def take_due(self, now=None):
        """Mark every due air time as aired and return what should play, oldest first.

        Air times more than GRACE_SECONDS late (the server was down) are skipped,
        so nothing plays long after its slot.
        """
        now = now or time.time()
        out = []
        with self._conn() as c:
            for r in c.execute(self._SELECT).fetchall():
                after = max(r["last_aired_at"] or 0, now - GRACE_SECONDS)
                at = next_occurrence(r["starts_at"], self._offsets(r), r["tz"], after)
                if at is None or at > now:
                    continue
                c.execute("UPDATE schedules SET last_aired_at = ? WHERE id = ?", (at, r["id"]))
                out.append({
                    "schedule_id": r["id"],
                    "at": at,
                    "name": r["name"],
                    "repeat": r["repeat"],
                    "path": str(self.media_dir / r["media_id"]),
                })
        self.invalidate()
        out.sort(key=lambda x: x["at"])
        return out

    def cleanup(self, now=None):
        """Delete items that have nothing left to air (file included), and stray uploads.

        Called right after studio items play, so a file disappears once its last
        airing is done. Never call it while a studio item is playing.
        """
        now = now or time.time()
        removed = 0
        with self._conn() as c:
            for r in c.execute("SELECT * FROM schedules").fetchall():
                after = max(r["last_aired_at"] or 0, now - GRACE_SECONDS)
                if next_occurrence(r["starts_at"], self._offsets(r), r["tz"], after) is not None:
                    continue
                aired = r["last_aired_at"] is not None
                c.execute("DELETE FROM schedules WHERE id = ?", (r["id"],))
                self._delete_media_if_unused(c, r["media_id"])
                removed += 1
                print(f"Studio: '{r['name']}' "
                      + ("finished its last airing" if aired else "was missed while the server was down")
                      + ", file deleted")
            # Uploads that never got scheduled (closed tab mid-way): drop after a day
            for r in c.execute("""SELECT id FROM media WHERE created_at < ? AND id NOT IN
                                  (SELECT media_id FROM schedules)""", (now - 86400,)).fetchall():
                self._delete_media_if_unused(c, r["id"])
            c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        # Files with no database row (a crash mid-upload)
        with self._conn() as c:
            known = {r["id"] for r in c.execute("SELECT id FROM media")}
        for f in self.media_dir.iterdir():
            if f.name not in known and now - f.stat().st_mtime > 3600:
                f.unlink(missing_ok=True)
        if removed:
            self.invalidate()
        return removed
