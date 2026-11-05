"""
Which country a listener is in, from their IP address, without asking any outside
service per listener: a free country database is kept on disk and looked up locally.

    IP geolocation by DB-IP (https://db-ip.com), "IP to Country Lite", CC BY 4.0.

The file (~7 MB) is downloaded on first start and refreshed monthly into data/geo/.
If it can't be downloaded (no network, site down) lookups just answer None and the
studio shows those listeners as "Unknown"; nothing else is affected.

Only the two-letter country code is ever stored. IP addresses stay in memory (about a
minute to count who is listening right now, up to a day to count each person once)
and are never written to disk.
"""
import asyncio
import gzip
import ipaddress
import os
import shutil
import time
import urllib.request
from datetime import date
from functools import lru_cache
from pathlib import Path

try:
    import maxminddb
except ImportError:                    # pragma: no cover - only without the package
    maxminddb = None

URL = "https://download.db-ip.com/free/dbip-country-lite-{month}.mmdb.gz"
REFRESH_DAYS = 35


class CountryLookup:
    def __init__(self, data_dir):
        self.dir = Path(data_dir) / "geo"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "dbip-country-lite.mmdb"
        self.reader = None
        self._open()

    def _open(self):
        if maxminddb is None or not self.path.exists():
            return
        try:
            old, self.reader = self.reader, maxminddb.open_database(str(self.path))
            self.country.cache_clear()
            if old:
                old.close()
        except Exception as e:
            print(f"Geo: couldn't open {self.path.name}: {e}")

    @lru_cache(maxsize=8192)  # noqa: B019  (one lookup object for the whole life of the server)
    def country(self, ip):
        """Two-letter country code ("IR", "CA"), or None if unknown / private."""
        if not self.reader or not ip:
            return None
        try:
            addr = ipaddress.ip_address(ip)
            if addr.is_private or addr.is_loopback or addr.is_link_local:
                return None
            rec = self.reader.get(ip)
        except (ValueError, TypeError, OSError):
            return None
        if not isinstance(rec, dict):
            return None
        cc = (rec.get("country") or {}).get("iso_code")
        return cc if isinstance(cc, str) and len(cc) == 2 else None

    def _download(self):
        """Fetch this month's file (or last month's, early in the month)."""
        if maxminddb is None:
            return False
        today = date.today()
        months = [today.strftime("%Y-%m")]
        prev = date(today.year - (today.month == 1), (today.month - 2) % 12 + 1, 1)
        months.append(prev.strftime("%Y-%m"))
        for month in months:
            tmp = self.dir / "download.tmp"
            try:
                req = urllib.request.Request(URL.format(month=month), headers={"User-Agent": "raadio"})
                with urllib.request.urlopen(req, timeout=60) as r, gzip.open(r) as g, open(tmp, "wb") as f:
                    shutil.copyfileobj(g, f)
                maxminddb.open_database(str(tmp)).close()     # check it before using it
                os.replace(tmp, self.path)
                print(f"Geo: country database {month} ready")
                return True
            except Exception as e:
                print(f"Geo: couldn't get the {month} country database: {e}")
                tmp.unlink(missing_ok=True)
        return False

    async def keep_fresh(self):
        """Background task: download if missing or older than REFRESH_DAYS, check daily."""
        while True:
            try:
                stale = (not self.path.exists()
                         or time.time() - self.path.stat().st_mtime > REFRESH_DAYS * 86400)
                if stale and await asyncio.to_thread(self._download):
                    self._open()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"Geo: refresh failed: {e}")
            await asyncio.sleep(86400)
