"""Flamingo notes: short messages listeners leave by catching a flamingo.

A listener who catches the flamingo that wanders over the radio can type a few words.
Each note is kept for two hours; once seven are waiting, the sky is full: notes then last
only an hour (older ones are cleared), new ones are refused and no flamingos come round
to be caught until there's room again. Every few minutes the station picks one and a flamingo
flies across everyone's screen skywriting it (the player reads `sky` from /now-playing).

Notes are checked against a list of words that can't be printed (English, Finglish and
Farsi to start with); studio users can see every note, edit, remove or add notes, and
manage that word list from the studio.
"""
import asyncio
import random
import re
import sqlite3
import time
import unicodedata

NOTE_TTL = 2 * 3600            # seconds a note lives...
NOTE_TTL_FULL = 3600           # ...and while the sky is full (NOTES_FULL notes waiting)
NOTE_MAX = 55                  # characters
NOTES_FULL = 7                 # notes waiting at once; then the sky is full until one expires
PER_IP_GAP = 45                # seconds between two notes from one address
PER_IP_HOUR = 8                # notes per address per hour
SKY_EVERY = (150, 360)         # seconds between two skywriting flights (random in range)
SKY_SHOW_FOR = 60              # players start a flight up to this long after it's announced

# Starting list (studio users can add and remove words). Matched as whole words; words of
# four letters or more also match as the start of a longer word (Farsi endings).
SEED_WORDS = [
    # English
    "fuck", "fucking", "fucker", "motherfucker", "fck", "shit", "bullshit", "bitch", "cunt",
    "asshole", "dick", "cock", "pussy", "whore", "slut", "bastard", "twat", "wanker",
    "nigger", "nigga", "faggot", "fag", "retard", "rape", "porn",
    # Finglish (Farsi in Latin letters)
    "kir", "kos", "kiri", "jende", "jendeh", "koskesh", "kosekesh", "madarjende",
    "nanejende", "haroomzade", "haramzade", "lashi", "jakesh", "dayoos", "gayidam",
    # Farsi
    "کیر", "کس", "کص", "کون", "عن", "جنده", "کسکش", "کصکش", "کونی", "کیری", "حرومزاده",
    "حرامزاده", "لاشی", "گاییدم", "گایید", "بیناموس", "مادرجنده", "ننه‌جنده", "جاکش",
    "دیوث", "قرمساق", "پفیوز", "کسخل", "کصخل", "خارکسده", "خارکصده",
]

_ZW = dict.fromkeys(map(ord, "​‌‍‎‏ـ﻿"), None)
_FA = str.maketrans({"ي": "ی", "ى": "ی", "ك": "ک", "ة": "ه", "أ": "ا", "إ": "ا", "آ": "ا", "ۀ": "ه"})
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"})
_LINK = re.compile(r"(https?://|www\.|\b[a-z0-9-]+\.(com|net|org|ir|io|me|xyz|info|app|link)\b|@[a-z0-9_]{3,})", re.I)


# short words also match with these endings ("my ...", "your ...", plurals)
_FA_ENDINGS = {"م", "ت", "ش", "ی", "ها", "های", "مو", "تو", "شو", "مون", "تون", "شون", "ای", "و"}
_LATIN_ENDINGS = {"s", "am", "et", "esh", "ha", "aa"}


def _endings(word: str):
    if not _is_farsi(word):
        return _LATIN_ENDINGS
    # two-letter words are common inside everyday words ("کسی" is "someone"): fewer endings
    return {"م", "ت", "ش", "ها"} if len(word) <= 2 else _FA_ENDINGS


def _is_farsi(word: str) -> bool:
    return any("\u0600" <= ch <= "\u06ff" for ch in word)


def normalize(text: str) -> str:
    """Lower case, one form for Persian letters, no hidden characters, no repeated letters
    (so "fuuuck", "f.u.c.k" or a word split with a zero-width space still match)."""
    t = unicodedata.normalize("NFKC", text or "").translate(_ZW).translate(_FA).lower()
    t = "".join(c for c in t if not unicodedata.category(c).startswith("M"))   # vowel marks
    t = t.translate(_LEET)
    return re.sub(r"(.)\1+", r"\1", t)


def tokens(text: str):
    t = normalize(text)
    words = re.findall(r"\w+", t)
    # also the letters run together, for "f u c k" / "f.u.c.k"
    joined = "".join(re.findall(r"\w", t))
    return words, joined


class FlamingoNotes:
    def __init__(self, db_path):
        self.on_event = None           # set by the controller: counts notes and flights for the studio
        self._room = None              # (when, has_room()) for a few seconds
        self.db_path = str(db_path)
        self.sky = None                 # {"id", "text", "at"}
        self.shown = {}                 # note id -> when it was last skywritten
        self.recent = {}                # ip -> [times]
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS flamingo_notes (
                             id INTEGER PRIMARY KEY AUTOINCREMENT,
                             text TEXT NOT NULL,
                             created REAL NOT NULL,
                             source TEXT NOT NULL DEFAULT 'listener')""")
            c.execute("""CREATE TABLE IF NOT EXISTS blocked_words (
                             word TEXT PRIMARY KEY)""")
            if not c.execute("SELECT 1 FROM blocked_words LIMIT 1").fetchone():
                c.executemany("INSERT OR IGNORE INTO blocked_words VALUES (?)", [(w,) for w in SEED_WORDS])
        self._words = None

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    # ---- the word list ---------------------------------------------------
    def words(self):
        with self._conn() as c:
            return [r["word"] for r in c.execute("SELECT word FROM blocked_words ORDER BY word")]

    def add_word(self, word):
        word = (word or "").strip()
        if not word or len(word) > 40:
            raise ValueError("A word of 1 to 40 letters, please")
        with self._conn() as c:
            c.execute("INSERT OR IGNORE INTO blocked_words VALUES (?)", (word,))
        self._words = None

    def remove_word(self, word):
        with self._conn() as c:
            c.execute("DELETE FROM blocked_words WHERE word = ?", (word,))
        self._words = None

    def _matchers(self):
        if self._words is None:
            self._words = [normalize(w).replace(" ", "") for w in self.words()]
            self._words = [w for w in self._words if w]
        return self._words

    def problem(self, text):
        """Why this text can't go up, or None."""
        if _LINK.search(text or ""):
            return "No links or handles, please."
        words, joined = tokens(text)
        bad = self._matchers()
        for w in words:
            for b in bad:
                if w == b or (len(b) >= 4 and w.startswith(b)) or \
                        (w.startswith(b) and w[len(b):] in _endings(b)):
                    return "That word can't fly. Try saying it another way."
        for b in bad:                        # letters spread out to dodge the list
            if len(b) >= 4 and b in joined and not any(b in w for w in words):
                return "That word can't fly. Try saying it another way."
        return None

    # ---- notes -----------------------------------------------------------
    @staticmethod
    def clean(text):
        text = re.sub(r"[\x00-\x1f\x7f]", " ", text or "")
        return re.sub(r"\s+", " ", text).strip()

    def add(self, text, ip, source="listener"):
        text = self.clean(text)
        if not text:
            raise ValueError("Write something first.")
        if len(text) > NOTE_MAX:
            raise ValueError(f"Keep it to {NOTE_MAX} letters or fewer.")
        if source == "listener":
            if not self.has_room():
                raise ValueError("The sky is full of notes right now. Try again in a while.")
            why = self.problem(text)
            if why:
                raise ValueError(why)
            now = time.time()
            times = [t for t in self.recent.get(ip, []) if now - t < 3600]
            if times and now - times[-1] < PER_IP_GAP:
                raise ValueError("The flamingos are busy. Try again in a minute.")
            if len(times) >= PER_IP_HOUR:
                raise ValueError("That's plenty for this hour. Thank you!")
            times.append(now)
            self.recent[ip] = times
            if len(self.recent) > 5000:
                self.recent = {k: v for k, v in self.recent.items() if v and now - v[-1] < 3600}
        with self._conn() as c:
            cur = c.execute("INSERT INTO flamingo_notes (text, created, source) VALUES (?, ?, ?)",
                            (text, time.time(), source))
            self._room = None
            return cur.lastrowid

    def _count(self, c, since):
        return c.execute("SELECT COUNT(*) FROM flamingo_notes WHERE created >= ?", (since,)).fetchone()[0]

    def ttl(self):
        """How long notes live right now: two hours, or one hour once the sky is full. When it
        fills up, notes older than an hour are cleared straight away."""
        now = time.time()
        with self._conn() as c:
            if self._count(c, now - NOTE_TTL) < NOTES_FULL:
                return NOTE_TTL
            c.execute("DELETE FROM flamingo_notes WHERE created < ?", (now - NOTE_TTL_FULL,))
            return NOTE_TTL_FULL if self._count(c, now - NOTE_TTL_FULL) >= NOTES_FULL else NOTE_TTL

    def has_room(self):
        """Fewer than NOTES_FULL notes waiting (the player only sends flamingos round then).
        Every listener's player asks this with each song-title check, so the answer is kept
        for 15 s (and worked out again at once when a note is added or removed)."""
        now = time.time()
        if self._room and now - self._room[0] < 15:
            return self._room[1]
        ttl = self.ttl()
        with self._conn() as c:
            room = self._count(c, now - ttl) < NOTES_FULL
        self._room = (now, room)
        return room

    def all(self):
        ttl = self.ttl()
        with self._conn() as c:
            rows = c.execute("SELECT id, text, created, source FROM flamingo_notes WHERE created >= ? "
                             "ORDER BY created DESC", (time.time() - ttl,)).fetchall()
        return [{"id": r["id"], "text": r["text"], "created": r["created"], "source": r["source"],
                 "expires": r["created"] + ttl, "flagged": bool(self.problem(r["text"]))} for r in rows]

    def edit(self, note_id, text):
        text = self.clean(text)
        if not text or len(text) > NOTE_MAX:
            raise ValueError(f"1 to {NOTE_MAX} letters, please")
        with self._conn() as c:
            n = c.execute("UPDATE flamingo_notes SET text = ? WHERE id = ?", (text, note_id)).rowcount
        if not n:
            raise KeyError(note_id)
        if self.sky and self.sky["id"] == note_id:
            self.sky = dict(self.sky, text=text)

    def remove(self, note_id):
        self._room = None
        with self._conn() as c:
            c.execute("DELETE FROM flamingo_notes WHERE id = ?", (note_id,))
        if self.sky and self.sky["id"] == note_id:
            self.sky = None

    def prune(self):
        self._room = None
        with self._conn() as c:
            c.execute("DELETE FROM flamingo_notes WHERE created < ?", (time.time() - NOTE_TTL,))
        self.ttl()                     # (clears the hour-old ones while the sky is full)

    # ---- skywriting -------------------------------------------------------
    def sky_now(self):
        """The flight to show right now, if one was announced in the last minute."""
        if self.sky and time.time() - self.sky["at"] <= SKY_SHOW_FOR:
            return self.sky
        return None

    def pick(self):
        now = time.time()
        notes = [n for n in self.all() if not n["flagged"]]
        if not notes:
            return None
        fresh = [n for n in notes if now - self.shown.get(n["id"], 0) > 1200] or notes
        n = random.choice(fresh)
        self.shown[n["id"]] = now
        self.sky = {"id": n["id"], "text": n["text"], "at": now}
        if self.on_event:
            self.on_event("flight", None)
        return self.sky

    async def run(self):
        """Background task: now and then, a flamingo skywrites one of the notes."""
        while True:
            await asyncio.sleep(random.uniform(*SKY_EVERY))
            try:
                self.prune()
                self.pick()
            except Exception as e:
                print(f"Flamingo notes: {e}")


def build_notes_router(notes: "FlamingoNotes", current_user, get_client_ip):
    from fastapi import APIRouter, Depends, HTTPException, Request

    r = APIRouter()

    def bad(e):
        raise HTTPException(400, str(e))

    @r.post("/note")
    async def post_note(request: Request):
        """A listener caught a flamingo and left a note."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        try:
            ip = get_client_ip(request)
            note_id = notes.add(str((body or {}).get("text", "")), ip)
        except ValueError as e:
            return {"status": "error", "message": str(e)}
        if notes.on_event:
            notes.on_event("note", ip)          # for the studio's flamingo tile (country only)
        # a new note gets its flight soon (so the sender has a chance to see it)
        if not notes.sky_now() and random.random() < 0.5:
            asyncio.get_event_loop().call_later(random.uniform(40, 120), notes.pick)
        return {"status": "success", "id": note_id, "message": "Your note is up in the air."}

    @r.get("/api/notes")
    async def list_notes(user=Depends(current_user)):
        return {"items": notes.all(), "words": notes.words(), "ttl": 7200}

    @r.post("/api/notes")
    async def add_note(request: Request, user=Depends(current_user)):
        body = await request.json()
        try:
            note_id = notes.add(str(body.get("text", "")), "studio", source=user["username"])
        except ValueError as e:
            bad(e)
        return {"id": note_id}

    @r.patch("/api/notes/{note_id}")
    async def edit_note(note_id: int, request: Request, user=Depends(current_user)):
        body = await request.json()
        try:
            notes.edit(note_id, str(body.get("text", "")))
        except ValueError as e:
            bad(e)
        except KeyError:
            raise HTTPException(404, "That note has gone") from None
        return {"ok": True}

    @r.delete("/api/notes/{note_id}")
    async def delete_note(note_id: int, user=Depends(current_user)):
        notes.remove(note_id)
        return {"ok": True}

    @r.post("/api/notes/fly/{note_id}")
    async def fly_note(note_id: int, user=Depends(current_user)):
        """Studio: send this note across everyone's screen now."""
        for n in notes.all():
            if n["id"] == note_id:
                notes.sky = {"id": n["id"], "text": n["text"], "at": time.time()}
                notes.shown[n["id"]] = time.time()
                return {"ok": True}
        raise HTTPException(404, "That note has gone")

    @r.post("/api/blocked-words")
    async def add_word(request: Request, user=Depends(current_user)):
        body = await request.json()
        try:
            notes.add_word(str(body.get("word", "")))
        except ValueError as e:
            bad(e)
        return {"words": notes.words()}

    @r.delete("/api/blocked-words/{word}")
    async def remove_word(word: str, user=Depends(current_user)):
        notes.remove_word(word)
        return {"words": notes.words()}

    return r
