"""
Curator tools, under /api/curator (studio users with the "curator" role only):

    GET  /api/curator/live                     listeners connected right now
    GET  /api/curator/stats?range=week&tz=...  listener history: timeline, daily rhythm,
                                               this week vs last, peaks
    (stats also has "posters": who posts the channel's songs, how many, how often they play,
    their likes and dislikes and their most liked / disliked songs; audience "likes"; and
    "listening": busiest hours, people and session lengths, overall and per country)

Listener counts come from Icecast's status page, sampled once a minute into
studio.db (table listener_samples), kept for about a year.

Where listeners are, and what they do (Audience): every playing web player asks for the
song title every 15 s, which tells us its country (geo.py). Once a minute the count per
country goes into country_hours; skip votes, skipped songs and downloads go into
audience_events with the song and the country. Only country codes are stored.

How many people and for how long (from the version that added these tables on): an unbroken
stretch of polls from one address is one session, stored only as (hour it began, country,
seconds) in listening_sessions; country_people holds, per hour and per UTC day, how many
different addresses listened and the most at once. Addresses stay in memory (for the current
day at most, to count each once) and are never written down. A household behind one address
counts as one person, and a server restart splits the sessions in progress.
"""
import asyncio
import json
import sqlite3
import time
import urllib.request
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException

from studio import get_zone

ACTIVE_FOR = 45                    # seconds a player counts as listening after its last poll
SESSION_GAP = 180                  # seconds of silence that end a session (a brief drop-out or a
                                   # throttled background tab doesn't)
BRIEF_SESSION = 30                 # seconds; shorter is someone tuning in, not listening
MAX_TRACKED = 100000               # addresses counted per hour/day, so a flood can't fill the memory
SESSION_BANDS = ((300, "lt5"), (900, "5to15"), (1800, "15to30"), (3600, "30to60"), (7200, "1to2h"), (None, "gt2h"))

SAMPLE_EVERY = 60                  # seconds between listener samples
KEEP_DAYS = 400
LIVE_CACHE = 5                     # seconds; the live tile polls every few seconds
RANGES = {                         # range -> (length, bucket size) in seconds
    "day": (86400, 300),
    "week": (7 * 86400, 1800),
    "month": (30 * 86400, 7200),
}


class ListenerStats:
    def __init__(self, db_path, status_url,
                 mounts=("/radio.mp3", "/radio.opus", "/radio-lite.opus", "/radio-lite.mp3"), relays=()):
        self.db_path = str(db_path)
        self.status_url = status_url
        self.mounts = mounts
        self.relays = list(relays)       # status URLs of relay servers (relay/README.md)
        self._live = (0.0, None)
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS listener_samples (
                             ts INTEGER PRIMARY KEY,
                             listeners INTEGER NOT NULL)""")

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    # ---- reading Icecast ---------------------------------------------
    def _count(self, url):
        """{mount: listeners} from one Icecast status page, or None if it didn't answer."""
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                raw = r.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
        except Exception:
            return None
        sources = data.get("icestats", {}).get("source", [])
        if isinstance(sources, dict):            # Icecast sends one mount as an object
            sources = [sources]
        counts = {}
        for s in sources:
            url_ = s.get("listenurl", "")
            for m in self.mounts:
                if url_.endswith(m):
                    try:
                        counts[m] = counts.get(m, 0) + int(s.get("listeners", 0))
                    except (TypeError, ValueError):
                        pass
        return counts

    def _fetch(self):
        """Total listeners on our mounts, or None if our own Icecast didn't answer.

        A relay pulls each mount once (only while it has listeners), so each of
        those pulls shows up here as one listener: swap it for the relay's real count.
        """
        main = self._count(self.status_url)
        if main is None:
            return None
        total = sum(main.values())
        for url in self.relays:
            relay = self._count(url)
            if relay:
                total += sum(relay.values()) - sum(1 for n in relay.values() if n > 0)
        return max(0, total)

    async def live(self):
        at, value = self._live
        if value is None or time.time() - at > LIVE_CACHE:
            value = await asyncio.to_thread(self._fetch)
            self._live = (time.time(), value)
        return value

    async def run(self):
        """Background task: one sample a minute, on the minute."""
        last_prune = 0.0
        while True:
            await asyncio.sleep(SAMPLE_EVERY - time.time() % SAMPLE_EVERY + 0.5)
            try:
                value = await asyncio.to_thread(self._fetch)
                if value is None:
                    continue
                self._live = (time.time(), value)
                ts = int(time.time()) // SAMPLE_EVERY * SAMPLE_EVERY
                with self._conn() as c:
                    c.execute("INSERT OR REPLACE INTO listener_samples VALUES (?, ?)", (ts, value))
                    if time.time() - last_prune > 86400:
                        c.execute("DELETE FROM listener_samples WHERE ts < ?",
                                  (int(time.time()) - KEEP_DAYS * 86400,))
                        last_prune = time.time()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"Listener sampling failed: {e}")

    # ---- analytics ---------------------------------------------------
    def stats(self, rng="week", tz_name="UTC", now=None):
        now = int(now or time.time())
        length, bucket = RANGES.get(rng, RANGES["week"])
        tz = get_zone(tz_name)
        since = now - length
        with self._conn() as c:
            rows = c.execute("SELECT ts, listeners FROM listener_samples WHERE ts >= ? ORDER BY ts",
                             (min(since, now - 14 * 86400),)).fetchall()
        in_range = [(r["ts"], r["listeners"]) for r in rows if r["ts"] >= since]

        # Timeline: average and peak per bucket; empty buckets stay empty (gaps, not zeros)
        buckets = {}
        for ts, n in in_range:
            b = ts // bucket * bucket
            buckets.setdefault(b, []).append(n)
        timeline = [{"t": b, "avg": round(sum(v) / len(v), 2), "max": max(v)}
                    for b, v in sorted(buckets.items())]

        # Daily rhythm: average listeners for each hour of the day, local time
        hours = [[] for _ in range(24)]
        for ts, n in in_range:
            hours[datetime.fromtimestamp(ts, tz).hour].append(n)
        rhythm = [{"hour": h, "avg": round(sum(v) / len(v), 2) if v else None,
                   "max": max(v) if v else None} for h, v in enumerate(hours)]

        # This week vs last week: daily average for the last 7 local days and the 7 before
        today = datetime.fromtimestamp(now, tz).date()
        per_day = {}
        for ts, n in ((r["ts"], r["listeners"]) for r in rows):
            per_day.setdefault(datetime.fromtimestamp(ts, tz).date(), []).append(n)

        def day_avg(d):
            v = per_day.get(d)
            return round(sum(v) / len(v), 2) if v else None
        compare = []
        for i in range(6, -1, -1):
            d = today - timedelta(days=i)
            compare.append({"date": d.isoformat(), "this": day_avg(d),
                            "last": day_avg(d - timedelta(days=7))})

        # Peaks: the three busiest moments, at least 6 hours apart (separate busy periods)
        values = [n for _, n in in_range]
        average = round(sum(values) / len(values), 2) if values else 0
        gap = max(3 * bucket, 6 * 3600) if rng != "day" else 3 * bucket
        peaks = []
        for p in sorted(timeline, key=lambda x: (-x["max"], -x["avg"], x["t"])):
            if len(peaks) == 3:
                break
            if all(abs(p["t"] - q["t"]) >= gap for q in peaks):
                peaks.append(p)
        peaks = [{"t": p["t"], "listeners": p["max"],
                  "vsAverage": round(p["max"] / average, 1) if average else None} for p in peaks]

        # A typical week: average listeners for each weekday x hour over the last 4 weeks
        with self._conn() as c:
            heat_rows = c.execute("SELECT ts, listeners FROM listener_samples WHERE ts >= ?",
                                  (now - 28 * 86400,)).fetchall()
        cells = [[[0, 0] for _ in range(24)] for _ in range(7)]
        for r in heat_rows:
            d = datetime.fromtimestamp(r["ts"], tz)
            cell = cells[d.weekday()][d.hour]
            cell[0] += r["listeners"]
            cell[1] += 1
        heat = [[round(c0 / c1, 2) if c1 else None for c0, c1 in day] for day in cells]

        return {
            "heat": heat,                      # [monday..sunday][hour]
            "range": rng if rng in RANGES else "week",
            "bucket": bucket,
            "from": since,
            "to": now,
            "average": average,
            "peak": max(values) if values else 0,
            "samples": len(values),
            "timeline": timeline,
            "rhythm": rhythm,
            "compare": compare,
            "peaks": peaks,
        }


class Audience:
    """Countries of listeners, and skip votes / skips / downloads per song and country."""

    def __init__(self, db_path, geo):
        self.db_path = str(db_path)
        self.geo = geo                     # geo.CountryLookup (or anything with .country(ip))
        self.active = {}                   # ip -> (last poll, country)  (memory only)
        self.saved = {}                    # (ip, track) -> time, so a re-download isn't counted twice
        self.open = {}                     # ip -> [first poll, last poll, country]  (memory only)
        self.heard = {3600: {}, 86400: {}}  # span -> {its start: {country: {ips}}}  (memory only)
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS country_hours (
                             hour INTEGER NOT NULL, cc TEXT NOT NULL, minutes INTEGER NOT NULL,
                             PRIMARY KEY (hour, cc))""")
            c.execute("""CREATE TABLE IF NOT EXISTS audience_events (
                             ts INTEGER NOT NULL, kind TEXT NOT NULL,
                             track_id INTEGER, cc TEXT)""")
            c.execute("CREATE INDEX IF NOT EXISTS audience_events_ts ON audience_events (ts)")
            c.execute("""CREATE TABLE IF NOT EXISTS listening_sessions (
                             hour INTEGER NOT NULL, cc TEXT NOT NULL, seconds INTEGER NOT NULL)""")
            c.execute("CREATE INDEX IF NOT EXISTS listening_sessions_hour ON listening_sessions (hour)")
            c.execute("""CREATE TABLE IF NOT EXISTS country_people (
                             start INTEGER NOT NULL, span INTEGER NOT NULL, cc TEXT NOT NULL,
                             people INTEGER NOT NULL, peak INTEGER NOT NULL,
                             PRIMARY KEY (start, span, cc))""")

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _cc(self, ip):
        try:
            return self.geo.country(ip) or "??"
        except Exception:
            return "??"

    # ---- collecting ----------------------------------------------------
    def seen(self, ip, listening):
        """A player asked for the song title; listening = its audio is playing."""
        if listening and ip:
            now = time.time()
            cc = self._cc(ip)
            self.active[ip] = (now, cc)
            s = self.open.get(ip)
            if s and now - s[1] <= SESSION_GAP:
                s[1] = now
            elif not s:
                self.open[ip] = [now, now, cc]
            # (a stale one is closed by the next sweep, which then lets this address start again)
            for span, starts in self.heard.items():
                by_cc = starts.setdefault(int(now) // span * span, {})
                for key in (cc, "*"):
                    ips = by_cc.setdefault(key, set())
                    if len(ips) < MAX_TRACKED:
                        ips.add(ip)

    def live_countries(self):
        cut = time.time() - ACTIVE_FOR
        out = {}
        for t, cc in self.active.values():
            if t >= cut:
                out[cc] = out.get(cc, 0) + 1
        return out

    def event(self, kind, track_id, ip):
        """kind: "vote" (a skip vote), "skip" (a song skipped by votes), "like" (a thumbs-up), "save" (a download),
        "note" (a note given to a caught flamingo), "flight" (a note skywritten)."""
        now = time.time()
        if kind == "save":
            key = (ip, track_id)
            if now - self.saved.get(key, 0) < 3600:
                return                     # the same person fetching the same song again
            self.saved[key] = now
            if len(self.saved) > 5000:
                self.saved = {k: v for k, v in self.saved.items() if now - v < 3600}
        try:
            with self._conn() as c:
                c.execute("INSERT INTO audience_events VALUES (?, ?, ?, ?)",
                          (int(now), kind, track_id, self._cc(ip) if ip else None))
        except Exception as e:
            print(f"Audience: couldn't record {kind}: {e}")

    def _close_sessions(self, c, now, everything=False):
        """Write down sessions nobody has polled for a while (all of them when shutting down)."""
        for ip, (first, last, cc) in list(self.open.items()):
            if everything or now - last > SESSION_GAP:
                c.execute("INSERT INTO listening_sessions VALUES (?, ?, ?)",
                          (int(first) // 3600 * 3600, cc, int(last - first)))
                del self.open[ip]

    def _count_people(self, c, now, at_once):
        """Different addresses so far this hour and this UTC day, and the most at once."""
        at_once = dict(at_once, **{"*": sum(at_once.values())}) if at_once else {}
        upsert = """INSERT INTO country_people VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (start, span, cc) DO UPDATE SET
                        people = MAX(people, excluded.people), peak = MAX(peak, excluded.peak)"""
        for span, starts in self.heard.items():
            current = int(now) // span * span
            for start, by_cc in list(starts.items()):
                for cc, ips in by_cc.items():
                    c.execute(upsert, (start, span, cc, len(ips), at_once.get(cc, 0) if start == current else 0))
                if start != current:       # that hour or day is over: its count is final
                    del starts[start]

    def _sweep(self, now, counts=None, everything=False):
        with self._conn() as c:
            self._close_sessions(c, now, everything)
            self._count_people(c, now, counts or {})

    async def run(self):
        """Background task: once a minute, add each country's listeners to this hour."""
        last_prune = 0.0
        while True:
            await asyncio.sleep(SAMPLE_EVERY - time.time() % SAMPLE_EVERY + 1.0)
            try:
                counts = self.live_countries()
                cut = time.time() - ACTIVE_FOR
                self.active = {ip: v for ip, v in self.active.items() if v[0] >= cut}
                hour = int(time.time()) // 3600 * 3600
                self._sweep(time.time(), counts)
                with self._conn() as c:
                    for cc, n in counts.items():
                        c.execute("""INSERT INTO country_hours VALUES (?, ?, ?)
                                     ON CONFLICT (hour, cc) DO UPDATE SET minutes = minutes + ?""",
                                  (hour, cc, n, n))
                    if time.time() - last_prune > 86400:
                        old = int(time.time()) - KEEP_DAYS * 86400
                        c.execute("DELETE FROM country_hours WHERE hour < ?", (old,))
                        c.execute("DELETE FROM audience_events WHERE ts < ?", (old,))
                        c.execute("DELETE FROM listening_sessions WHERE hour < ?", (old,))
                        c.execute("DELETE FROM country_people WHERE start < ?", (old,))
                        last_prune = time.time()
            except asyncio.CancelledError:
                try:                       # shutting down: keep what the listeners so far did
                    self._sweep(time.time(), everything=True)
                except Exception as e:
                    print(f"Audience: couldn't save sessions: {e}")
                raise
            except Exception as e:
                print(f"Audience sampling failed: {e}")

    def listening(self, rng="week", tz_name="UTC", now=None):
        """Per country and overall: which hours are busiest, how many people, for how long.

        Hours are clock times in the asked-for zone. Records are per UTC hour, so in a zone like
        Tehran's (+3:30) a slot starts at half past: each slot says its own minute of the day."""
        now = int(now or time.time())
        length, _ = RANGES.get(rng, RANGES["week"])
        tz = get_zone(tz_name)
        since = now - length
        first_h = since // 3600 * 3600
        with self._conn() as c:
            minutes = c.execute("SELECT hour, cc, minutes FROM country_hours WHERE hour >= ?", (first_h,)).fetchall()
            before = c.execute("SELECT SUM(minutes) AS m FROM country_hours WHERE hour >= ? AND hour < ?",
                               (first_h - length, first_h)).fetchone()["m"]
            oldest = c.execute("SELECT MIN(hour) AS h FROM country_hours").fetchone()["h"]
            sessions = c.execute("SELECT cc, seconds FROM listening_sessions WHERE hour >= ?", (first_h,)).fetchall()
            people = c.execute("SELECT start, span, cc, people, peak FROM country_people WHERE start >= ?",
                               (since // 86400 * 86400,)).fetchall()
            counted_from = c.execute("SELECT MIN(start) AS s FROM country_people").fetchone()["s"]
            timed_from = c.execute("SELECT MIN(hour) AS h FROM listening_sessions").fetchone()["h"]

        def slot(ts):
            d = datetime.fromtimestamp(ts, tz)
            return d.hour * 60 + d.minute

        # How many times each clock hour came round since records began (quiet ones count as 0)
        start_h = max(first_h, oldest) if oldest else first_h
        rounds = {}
        for h in range(start_h, now, 3600):
            rounds[slot(h)] = rounds.get(slot(h), 0) + 1

        groups = {"*": {"minutes": 0, "slots": {}, "days": {}, "people": {}, "lens": [], "perDay": [], "peak": 0, "peakAt": None}}

        def group(cc):
            return groups.setdefault(cc, {"minutes": 0, "slots": {}, "days": {}, "people": {}, "lens": [], "perDay": [], "peak": 0, "peakAt": None})
        for r in minutes:
            if r["hour"] < start_h:
                continue
            s, day = slot(r["hour"]), datetime.fromtimestamp(r["hour"], tz).date().isoformat()
            for g in (group(r["cc"]), groups["*"]):
                g["minutes"] += r["minutes"]
                g["slots"][s] = g["slots"].get(s, 0) + r["minutes"]
                g["days"][day] = g["days"].get(day, 0) + r["minutes"]
        for r in sessions:
            group(r["cc"])["lens"].append(r["seconds"])
            groups["*"]["lens"].append(r["seconds"])
        for r in people:
            g = group(r["cc"])
            if r["span"] == 86400:
                g["perDay"].append(r["people"])
            elif r["start"] >= first_h:
                s = slot(r["start"])
                g["people"][s] = max(g["people"].get(s, 0), r["people"])
                if r["peak"] > g["peak"]:
                    g["peak"], g["peakAt"] = r["peak"], r["start"]

        def describe(g):
            hours = [{"m": s, "avg": round(g["slots"].get(s, 0) / 60 / rounds[s], 2),
                      "people": g["people"].get(s)} for s in sorted(rounds)]
            busy = sorted((h for h in hours if h["avg"] > 0), key=lambda h: (-h["avg"], h["m"]))
            best_day = max(g["days"].items(), key=lambda kv: (kv[1], kv[0])) if g["days"] else None
            return {"minutes": g["minutes"], "hours": hours, "top": busy[:3],
                    "bestDay": {"date": best_day[0], "minutes": best_day[1]} if best_day else None,
                    "people": {"perDay": round(sum(g["perDay"]) / len(g["perDay"]), 1) if g["perDay"] else None,
                               "maxDay": max(g["perDay"]) if g["perDay"] else None,
                               "peak": g["peak"] or None, "peakAt": g["peakAt"]},
                    "sessions": session_figures(g["lens"])}

        everyone = groups.pop("*")
        overall = describe(everyone)
        overall["quiet"] = min(overall["hours"], key=lambda h: (h["avg"], h["m"])) if everyone["minutes"] else None
        overall["minutesBefore"] = (before or 0) if oldest and oldest <= first_h - length else None
        bands = {name: 0 for _, name in SESSION_BANDS}
        for v in everyone["lens"]:
            if v >= BRIEF_SESSION:
                bands[next(n for top, n in SESSION_BANDS if top is None or v < top)] += 1
        overall["bands"] = [{"band": n, "n": bands[n]} for _, n in SESSION_BANDS]
        total = everyone["minutes"]
        countries = []
        for cc, g in groups.items():
            row = describe(g)
            row.update(cc=cc, share=round(g["minutes"] / total, 4) if total else 0)
            countries.append(row)
        countries.sort(key=lambda r: (-r["minutes"], r["cc"]))
        return {"tz": getattr(tz, "key", None) or "UTC", "overall": overall, "countries": countries,
                "hoursFrom": start_h if oldest else None, "peopleFrom": counted_from, "sessionsFrom": timed_from}

    def reactions_since(self, since, ids):
        """{track_id: {"like": n, "vote": n}} for these songs since a moment."""
        out = {}
        ids = [int(i) for i in ids][:100]
        with self._conn() as c:
            for r in c.execute(f"""SELECT track_id, kind, COUNT(*) AS n FROM audience_events
                                   WHERE ts >= ? AND kind IN ('like', 'vote')
                                     AND track_id IN ({','.join('?' * len(ids))})
                                   GROUP BY track_id, kind""", (since, *ids)):
                out.setdefault(r["track_id"], {})[r["kind"]] = r["n"]
        return out

    def per_song(self):
        """{track_id: {"saves": n, "votes": n, "likes": n}} over all time, for the studio's song
        list and who posts what (votes: skip votes, the thumbs-down; likes: thumbs-up)."""
        out = {}
        key = {"save": "saves", "vote": "votes", "like": "likes"}
        with self._conn() as c:
            for r in c.execute("""SELECT track_id, kind, COUNT(*) AS n FROM audience_events
                                  WHERE track_id IS NOT NULL AND kind IN ('save', 'vote', 'like')
                                  GROUP BY track_id, kind"""):
                out.setdefault(r["track_id"], {"saves": 0, "votes": 0, "likes": 0})[key[r["kind"]]] = r["n"]
        return out

    # ---- reporting -----------------------------------------------------
    def report(self, rng="week", tz_name="UTC", titles=None, now=None):
        now = int(now or time.time())
        length, _ = RANGES.get(rng, RANGES["week"])
        tz = get_zone(tz_name)
        since = now - length
        with self._conn() as c:
            minutes = c.execute("""SELECT cc, SUM(minutes) AS m FROM country_hours
                                   WHERE hour >= ? GROUP BY cc""", (since // 3600 * 3600,)).fetchall()
            events = c.execute("SELECT ts, kind, track_id, cc FROM audience_events WHERE ts >= ?",
                               (since,)).fetchall()

        # buckets for the little charts: hours for a day, otherwise local days
        if rng == "day":
            nb = 24
            def bucket(ts):
                return min(nb - 1, max(0, (ts - since) * nb // length))
            starts = [since + i * length // nb for i in range(nb)]
        else:
            nb = length // 86400
            today = datetime.fromtimestamp(now, tz).date()
            first = today - timedelta(days=nb - 1)
            def bucket(ts):
                return min(nb - 1, max(0, (datetime.fromtimestamp(ts, tz).date() - first).days))
            starts = [int(datetime.combine(first + timedelta(days=i), datetime.min.time(), tz).timestamp())
                      for i in range(nb)]

        live = self.live_countries()
        per_cc = {}
        for r in minutes:
            per_cc.setdefault(r["cc"], {"cc": r["cc"], "minutes": 0, "votes": 0, "saves": 0, "now": 0})
            per_cc[r["cc"]]["minutes"] = r["m"]
        for cc, n in live.items():
            per_cc.setdefault(cc, {"cc": cc, "minutes": 0, "votes": 0, "saves": 0, "now": 0})["now"] = n

        kinds = {k: {"total": 0, "series": [0] * nb, "songs": {}} for k in ("vote", "skip", "save", "like", "note", "flight")}
        note_cc = {}
        for e in events:
            k = kinds.get(e["kind"])
            if not k:
                continue
            k["total"] += 1
            k["series"][bucket(e["ts"])] += 1
            if e["track_id"] is not None:
                k["songs"][e["track_id"]] = k["songs"].get(e["track_id"], 0) + 1
            cc = e["cc"] or "??"
            if e["kind"] == "note":
                note_cc[cc] = note_cc.get(cc, 0) + 1
            if e["kind"] in ("vote", "save"):
                row = per_cc.setdefault(cc, {"cc": cc, "minutes": 0, "votes": 0, "saves": 0, "now": 0})
                row["votes" if e["kind"] == "vote" else "saves"] += 1

        ids = set()
        for k in kinds.values():
            ids.update(k["songs"])
        names = (titles(ids) if titles and ids else {}) or {}

        def top(k, n=8):
            items = sorted(kinds[k]["songs"].items(), key=lambda kv: (-kv[1], kv[0]))[:n]
            return [{"id": i, "title": names.get(i) or f"Track {i}", "n": v} for i, v in items]

        total_min = sum(r["minutes"] for r in per_cc.values()) or 0
        countries = sorted(per_cc.values(), key=lambda r: (-r["minutes"], -r["now"], r["cc"]))
        for r in countries:
            r["share"] = round(r["minutes"] / total_min, 4) if total_min else 0
        return {
            "buckets": starts,
            "countries": countries,
            "votes": {"total": kinds["vote"]["total"], "series": kinds["vote"]["series"], "top": top("vote")},
            "skips": {"total": kinds["skip"]["total"], "series": kinds["skip"]["series"], "top": top("skip")},
            "saves": {"total": kinds["save"]["total"], "series": kinds["save"]["series"], "top": top("save")},
            "likes": {"total": kinds["like"]["total"], "series": kinds["like"]["series"], "top": top("like")},
            "notes": {"total": kinds["note"]["total"], "series": kinds["note"]["series"],
                      "flights": kinds["flight"]["total"],
                      "countries": [{"cc": k, "n": v} for k, v in sorted(note_cc.items(), key=lambda kv: -kv[1])]},
        }


def session_figures(seconds):
    """Lengths of a list of sessions. Under BRIEF_SESSION is tuning in: counted, not measured."""
    real = sorted(v for v in seconds if v >= BRIEF_SESSION)
    out = {"count": len(real), "brief": len(seconds) - len(real)}
    if real:
        mid = len(real) // 2
        out.update(longest=real[-1], shortest=real[0], mean=round(sum(real) / len(real)),
                   median=real[mid] if len(real) % 2 else round((real[mid - 1] + real[mid]) / 2),
                   total=sum(real))
    return out


class Tiers:
    """Read and change the rotation tier of each song (track_stats in the radio database)."""

    def __init__(self, db_file, tier_limits, on_change=None):
        self.db_file = db_file
        self.limits = tier_limits            # skip_score needed for tiers 2, 3, 4, 5
        self.on_change = on_change

    def _conn(self):
        conn = sqlite3.connect(self.db_file, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def posters(self, per_song=None):
        """Who posts the channel's songs (the channel's signature on each post): how many songs
        each has posted and how many of those have played, how often they're played, how
        listeners take them (likes, dislikes = skip votes, downloads), and each person's three
        most liked and most disliked songs.

        "kept" is the share of plays heard to the end (not voted off), pulled a little towards
        the station's average for people with few plays, so one lucky song doesn't top the
        list; saves (downloads) count in their favour too."""
        per_song = per_song or {}
        with self._conn() as c:
            try:
                rows = c.execute("""SELECT m.telegram_msg_id AS id, m.posted_by AS by, s.title,
                                           COALESCE(s.play_count, 0) AS plays, COALESCE(s.skip_count, 0) AS skips
                                    FROM track_meta m LEFT JOIN track_stats s ON s.telegram_msg_id = m.telegram_msg_id
                                    WHERE m.posted_at IS NOT NULL""").fetchall()
            except sqlite3.OperationalError:          # (no channel scan yet)
                return {"people": [], "unsigned": 0}
        people, unsigned = {}, 0
        for r in rows:
            if not r["by"]:
                unsigned += 1
                continue
            p = people.setdefault(r["by"], {"name": r["by"], "songs": 0, "played": 0, "plays": 0, "skips": 0, "saves": 0,
                                            "likes": 0, "dislikes": 0, "best": None, "_best": -1, "_songs": []})
            p["songs"] += 1
            p["played"] += 1 if r["plays"] else 0
            p["plays"] += r["plays"]
            p["skips"] += r["skips"]
            got = per_song.get(r["id"]) or {}
            saves, likes, dislikes = got.get("saves", 0), got.get("likes", 0), got.get("votes", 0)
            p["saves"] += saves
            p["likes"] += likes
            p["dislikes"] += dislikes
            p["_songs"].append((r["title"] or f"Track {r['id']}", likes, dislikes))
            liked = (r["plays"] - r["skips"]) + 3 * saves
            if r["plays"] and liked > p["_best"]:
                p["_best"], p["best"] = liked, r["title"] or f"Track {r['id']}"
        all_plays = sum(p["plays"] for p in people.values())
        all_skips = sum(p["skips"] for p in people.values())
        avg = (all_plays - all_skips) / all_plays if all_plays else 0.8
        PRIOR = 10                                    # plays' worth of "average" each person starts with
        out = []
        for p in people.values():
            p.pop("_best")
            songs = p.pop("_songs")
            def top(i):
                ranked = sorted((s for s in songs if s[i] > 0), key=lambda s: (-s[i], s[0].lower()))[:3]
                return [{"title": s[0], "n": s[i]} for s in ranked]
            p["liked"], p["disliked"] = top(1), top(2)
            plays = p["plays"]
            p["kept"] = round((plays - p["skips"]) / plays, 3) if plays else None
            score = (plays - p["skips"] + PRIOR * avg) / (plays + PRIOR)
            p["score"] = round(min(1.0, score + 0.02 * min(10, p["saves"])), 3)
            out.append(p)
        out.sort(key=lambda p: (-p["score"], -p["plays"], p["name"].lower()))
        return {"people": out, "unsigned": unsigned}

    def most_played(self, reactions=None, now=None):
        """The 10 most played songs of the last 7 and 30 days with why each was picked (play_log,
        recorded from the version that added it), and of all time (no reasons exist for those)."""
        now = int(now or time.time())
        with self._conn() as c:
            try:
                log = c.execute("SELECT ts, telegram_msg_id AS id, reason FROM play_log WHERE ts >= ?",
                                (now - 30 * 86400,)).fetchall()
                since = c.execute("SELECT MIN(ts) AS t FROM play_log").fetchone()["t"]
            except sqlite3.OperationalError:          # (nothing played since the table was added)
                log, since = [], None
            ids = {r["id"] for r in log}
            names = {r["telegram_msg_id"]: r for r in c.execute(
                "SELECT telegram_msg_id, title, tier, boost FROM track_stats")}
            try:
                posted = {r["telegram_msg_id"]: r["posted_at"] for r in c.execute(
                    "SELECT telegram_msg_id, posted_at FROM track_meta WHERE posted_at IS NOT NULL")}
            except sqlite3.OperationalError:
                posted = {}
            ever = c.execute("""SELECT telegram_msg_id AS id, title, play_count AS n FROM track_stats
                                WHERE play_count > 0 ORDER BY play_count DESC, title LIMIT 10""").fetchall()

        def top(days):
            cut = now - days * 86400
            songs = {}
            for r in log:
                if r["ts"] >= cut:
                    why = songs.setdefault(r["id"], {})
                    why[r["reason"]] = why.get(r["reason"], 0) + 1
            ranked = sorted(songs.items(), key=lambda kv: (-sum(kv[1].values()), kv[0]))[:10]
            react = reactions(cut, [i for i, _ in ranked]) if reactions and ranked else {}
            out = []
            for i, why in ranked:
                info = names.get(i)
                got = react.get(i) or {}
                out.append({"id": i, "title": (info["title"] if info else None) or f"Track {i}",
                            "plays": sum(why.values()), "why": why, "posted": posted.get(i),
                            "tier": (info["tier"] if info else 1) or 1, "boost": (info["boost"] if info else 0) or 0,
                            "likes": got.get("like", 0), "votes": got.get("vote", 0)})
            return out
        return {"week": top(7), "month": top(30), "since": since, "plays": {"week": sum(1 for r in log if r["ts"] >= now - 7 * 86400), "month": len(log)},
                "allTime": [{"id": r["id"], "title": r["title"] or f"Track {r['id']}", "plays": r["n"]} for r in ever],
                "tracked": len(ids)}

    def titles(self, ids):
        """{id: title} for these songs."""
        ids = [int(i) for i in ids][:500]
        if not ids:
            return {}
        with self._conn() as c:
            rows = c.execute(f"SELECT telegram_msg_id AS id, title FROM track_stats WHERE telegram_msg_id IN "
                             f"({','.join('?' * len(ids))})", ids).fetchall()
        return {r["id"]: r["title"] for r in rows}


def build_curator_router(stats: ListenerStats, tiers: Tiers, current_user, audience: "Audience" = None, notes=None):
    router = APIRouter(prefix="/api/curator")

    def curator(user=Depends(current_user)):
        if user.get("role") != "curator":
            raise HTTPException(403, "Only curators can use this")
        return user

    @router.get("/live")
    async def live(user=Depends(curator)):
        return {"listeners": await stats.live(), "at": time.time()}

    @router.get("/stats")
    async def get_stats(range: str = "week", tz: str = "UTC", user=Depends(curator)):
        data = await asyncio.to_thread(stats.stats, range, tz)
        data["live"] = await stats.live()
        if audience is not None:
            data["audience"] = await asyncio.to_thread(audience.report, range, tz, tiers.titles)
            data["listening"] = await asyncio.to_thread(audience.listening, range, tz)
        if notes is not None:
            waiting = await asyncio.to_thread(notes.all)
            data.setdefault("audience", {}).setdefault("notes", {})["waiting"] = [
                {"text": n["text"], "created": n["created"], "source": n["source"]} for n in waiting]
            data["audience"]["notes"]["full"] = not await asyncio.to_thread(notes.has_room)
        per = await asyncio.to_thread(audience.per_song) if audience is not None else {}
        data["posters"] = await asyncio.to_thread(tiers.posters, per)
        data["mostPlayed"] = await asyncio.to_thread(tiers.most_played, audience.reactions_since if audience is not None else None)
        return data

    return router
