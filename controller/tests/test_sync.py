"""Everyone hears the same moment (SYNC in radio_controller.py): the station runs ahead, a
skip is a cut every player jumps at, and the song on air is the one being heard."""
import os
import sys
import time
from pathlib import Path

for k, v in (("TG_API_ID", "1"), ("TG_API_HASH", "x"), ("TG_CHANNEL_ID", "1"), ("ICECAST_SOURCE_PASSWORD", "x")):
    os.environ.setdefault(k, v)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import radio_controller as rc                               # noqa: E402

SEC = rc.BYTES_PER_SEC


class Running:
    returncode = None


def station(ahead=25.0, played=100.0):
    """A broadcaster `played` s into its stream, with `ahead` s written beyond that."""
    bc = rc.Broadcaster()
    bc.proc = Running()
    bc.t0 = time.monotonic() - played
    bc.sent = int((played + ahead) * SEC)
    return bc


def test_a_cut_jumps_everyone_and_the_station_runs_ahead_again():
    bc = station()
    now = time.time()
    c0 = bc.clock0()
    assert abs(bc.due_of(bc.pos()) - (now + 25)) < 0.05      # the newest audio: heard in 25 s
    early = 101.0                                            # (heard a second from now)
    before = bc.due_of(early)
    k = bc.cut(now + 1.5)
    assert abs(k["from"] - 101.5) < 0.05 and abs(k["to"] - 125) < 0.01
    assert abs(k["shift"] - 23.5) < 0.05
    assert abs(bc.due_of(bc.pos()) - (now + 1.5)) < 0.05     # what comes next is heard at the cut
    assert abs(bc.ahead() - 1.5) < 0.05                      # ...so it writes ahead again at once
    assert abs(bc.clock0() - c0) < 0.01                      # players count from the same clock
    assert abs(bc.due_of(early) - before) < 0.01             # what's heard before the cut: as it was


def test_no_cut_when_nothing_is_ahead():
    bc = station(ahead=1.0)
    assert bc.cut(time.time() + 1.5) is None


def test_the_song_on_air_is_the_one_heard():
    bc = station(ahead=0.5)
    rc.broadcaster = bc
    rc._timeline.clear()
    try:
        rc.set_now_playing("a", "Song A", "", show=False)
        assert rc.current_track_id != "a"                     # (heard in half a second)
        time.sleep(0.6)
        rc.heard_tick()
        assert rc.current_track_id == "a"
        bc.sent += int(20 * SEC)                              # 20 s of it written...
        rc.set_now_playing("b", "Song B", "", show=False)     # ...and the next one starts
        assert rc.current_track_id == "a"                     # still A: B is heard in ~20 s
        assert rc.heard_next()["id"] == "b"
        at = time.time() + 0.05
        rc.station_cut(at, rc.heard_next()["s"])              # a skip of A: everyone jumps to B
        time.sleep(0.1)
        rc.heard_tick()
        assert rc.current_track_id == "b"
        assert abs(rc.current_track_started - at) < 0.02
    finally:
        rc.broadcaster = None
        rc._timeline.clear()
