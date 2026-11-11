"""Tiers: star, 1, 0, -1, blocked (rank.py)."""
import sqlite3
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rank                                                 # noqa: E402


def test_score_bands():
    assert rank.from_score(0) == 0
    assert rank.from_score(rank.UP_AT) == 1
    assert rank.from_score(rank.DOWN_AT) == -1
    assert rank.from_score(rank.BLOCK_AT) == rank.BLOCKED


def test_star_lasts_two_weeks_then_tier_1():
    now = time.time()
    assert rank.settle(rank.STAR, 3.0, now + 60, now) == (rank.STAR, now + 60)   # (dislikes don't end it early)
    assert rank.settle(rank.STAR, 0.0, now - 1, now) == (1, None)
    assert rank.settle(rank.STAR, 0.0, None, now) == (1, None)


def test_blocked_stays_until_set_by_hand():
    assert rank.settle(rank.BLOCKED, rank.SCORE_MIN, None) == (rank.BLOCKED, None)


def test_parse():
    assert [rank.parse(v) for v in ("star", "1", "+1", "0", "-1", "−1", "blocked", "banned", 2, -2)] == \
        [rank.STAR, 1, 1, 0, -1, -1, rank.BLOCKED, rank.BLOCKED, rank.STAR, rank.BLOCKED]
    for bad in ("5", 3, "x", True):
        with pytest.raises(ValueError):
            rank.parse(bad)


def test_old_tiers_move_once(tmp_path):
    db = tmp_path / "r.db"
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE track_stats (telegram_msg_id INTEGER PRIMARY KEY, tier INTEGER, "
                  "is_blacklisted INTEGER, boost INTEGER, skip_score REAL)")
        c.executemany("INSERT INTO track_stats VALUES (?, ?, ?, ?, 0)",
                      [(1, 1, 0, 0), (2, 1, 0, 2), (3, 2, 0, 0), (4, 4, 0, 0), (5, 5, 1, 0)])
        assert rank.ensure_columns(c) == 5
        assert rank.ensure_columns(c) == 0                     # (once)
        got = dict(c.execute("SELECT telegram_msg_id, rank FROM track_stats"))
    assert got == {1: 0, 2: 1, 3: 0, 4: -1, 5: rank.BLOCKED}
