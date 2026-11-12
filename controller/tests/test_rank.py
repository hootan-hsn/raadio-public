"""Tiers: star, 1, 0, -1, blocked (rank.py)."""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rank                                                 # noqa: E402


DAY = rank.DAY
T0 = 1_800_000_000.0


def song(r=0, net=0.0, plays=0.0, at=T0, star_until=None, hold_until=None):
    return dict(rank=r, net=net, plays=plays, at=at, star_until=star_until, hold_until=hold_until)


def run(s, events, start=T0, gap=3600, voters=5):
    """events: "d" dislike-skip, "f" play to the end, "l" like; one every gap seconds."""
    now = start
    for e in events:
        now += gap
        add, played = {"d": (rank.DISLIKE, True), "f": (rank.FINISH, True), "l": (rank.LIKE, False)}[e]
        s = rank.step(s, add, played, voters, now)
    return s


def test_rate_bands():
    assert rank.from_rate(0) == 0
    assert rank.from_rate(rank.UP_AT) == 1
    assert rank.from_rate(rank.DOWN_AT) == -1
    assert rank.from_rate(rank.BLOCK_AT) == rank.BLOCKED


def test_votes_fade_by_half():
    assert rank.fade(4.0, T0, T0 + rank.HALF_DAYS * DAY) == pytest.approx(2.0)
    assert rank.fade(4.0, None, T0) == 4.0


def test_one_dislike_on_a_new_song_moves_nothing():
    s = run(song(), "d")
    assert s["rank"] == 0 and s["moved"] is None


def test_busy_song_judged_by_rate_not_count():
    # 40 plays, 6 skipped: well under a quarter, so it stays in 0 although it has 6 dislikes
    assert run(song(), "dfffffff" * 5)["rank"] in (0, 1)
    # 10 plays, 6 skipped: down
    assert run(song(), "ddddffdfdf")["rank"] == -1


def test_moving_down_needs_three_listeners():
    assert run(song(), "dddddd", voters=1)["rank"] == 0
    assert run(song(), "dddddd", voters=3)["rank"] == -1


def test_moved_song_starts_inside_its_tier_and_is_held():
    s = run(song(), "ddd")                    # (3 of 3 plays disliked: 3 / (3 + K) is past a quarter)
    assert s["rank"] == -1 and s["moved"] == 0
    assert rank.rate(s["net"], s["plays"]) == pytest.approx(rank.DOWN_AT + rank.MARGIN)
    t = s["at"]
    # loved straight after: held for HOLD_DAYS, then it can climb
    held = run(s, "l" * 8, start=t)
    assert held["rank"] == -1
    later = run(s, "l" * 8, start=t + rank.HOLD_DAYS * DAY)
    assert later["rank"] in (0, 1)


def test_old_dislikes_wear_off():
    s = run(song(), "dddddd")
    assert s["rank"] == -1
    # months later, a few plays to the end bring it back
    s = run(s, "fff", start=s["at"] + 6 * rank.HALF_DAYS * DAY)
    assert s["rank"] == 0


def test_set_by_hand_holds_longer():
    net, until, hold = rank.set_by_hand(-1, 4.0, T0)
    assert until is None and hold == T0 + rank.HAND_HOLD_DAYS * DAY
    assert rank.rate(net, 4.0) == pytest.approx(rank.DOWN_AT + rank.MARGIN)
    s = song(-1, net, 4.0, hold_until=hold)
    assert run(s, "l" * 10)["rank"] == -1                        # (listeners wait a week)
    _, until, _ = rank.set_by_hand(rank.STAR, 0, T0)
    assert until == T0 + rank.STAR_DAYS * DAY


def test_star_lasts_two_weeks_then_tier_1():
    s = song(rank.STAR, star_until=T0 + 60)
    assert rank.step(s, rank.DISLIKE, True, 9, T0)["rank"] == rank.STAR      # (dislikes don't end it early)
    after = rank.step(s, 0, False, 0, T0 + 61)
    assert after["rank"] == 1 and after["star_until"] is None and after["moved"] == rank.STAR
    assert rank.rate(after["net"], after["plays"]) == pytest.approx(rank.UP_AT - rank.MARGIN)


def test_blocked_stays_until_set_by_hand():
    s = song(rank.BLOCKED, net=-50)
    assert run(s, "l" * 20)["rank"] == rank.BLOCKED


def test_each_listener_once_a_day(tmp_path):
    with sqlite3.connect(tmp_path / "v.db") as c:
        c.execute("CREATE TABLE track_stats (telegram_msg_id INTEGER PRIMARY KEY)")
        rank.ensure_columns(c)
        assert rank.count_vote(c, 7, "1.2.3.4|abc", "dislike", T0)
        assert not rank.count_vote(c, 7, "1.2.3.4|abc", "dislike", T0 + 60)
        assert rank.count_vote(c, 7, "1.2.3.4|abc", "dislike", T0 + DAY)
        assert rank.count_vote(c, 7, "5.6.7.8|def", "dislike", T0)
        assert rank.voters(c, 7, T0 + DAY) == 2
        assert not any("1.2.3.4" in r[0] for r in c.execute("SELECT voter FROM song_votes"))   # (hashed)
        rank.prune_votes(c, T0 + (rank.HALF_DAYS + 2) * DAY)
        assert rank.voters(c, 7, T0 + (rank.HALF_DAYS + 2) * DAY) == 0


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
        assert rank.ensure_columns(c, T0) == 5
        assert rank.ensure_columns(c, T0) == 0                 # (once)
        got = dict(c.execute("SELECT telegram_msg_id, rank FROM track_stats"))
        rows = c.execute("SELECT rank, skip_score, plays_w, score_at FROM track_stats").fetchall()
    assert got == {1: 0, 2: 1, 3: 0, 4: -1, 5: rank.BLOCKED}
    for r, net, plays, at in rows:                             # (each just inside its tier)
        assert at == T0 and rank.rate(net, plays) == pytest.approx(rank.ENTRY[r])
