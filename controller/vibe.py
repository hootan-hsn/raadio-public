"""
The song's "vibe" for the player's waveform: how much bass, mids and highs there are,
10 times a second, for the whole file. Worked out once per file, in the background,
while the previous song is still playing; the player fetches it from /api/wave/{key}.

One FFmpeg run at low priority decodes the file once and splits it into three bands
(each resampled as low as that band allows), written to three pipes. The loudness of every
100 ms window is worked out as the audio streams in, so memory stays small however long
the song is. Result: 3 bytes per frame (bass, mid, high, 0-255), sent as base64:
~10 KB for 4 minutes.
"""
import asyncio
import base64
import math
import os
import selectors
import subprocess
from array import array

try:                                  # C speed for the window loudness (Python <= 3.12)
    import audioop                    # deprecated, but fast and still shipped
except ImportError:                   # pragma: no cover
    audioop = None

FPS = 10
BANDS = (                             # (name, FFmpeg filter, sample rate)
    ("bass", "lowpass=f=160,lowpass=f=160", 2000),
    ("mid", "highpass=f=300,lowpass=f=2500", 8000),
    ("high", "highpass=f=4000", 16000),
)
MAX_SECONDS = 2 * 3600                # don't analyse anything absurdly long


def _rms(chunk):
    if audioop is not None:
        return audioop.rms(chunk, 2)
    s = array("h")
    s.frombytes(chunk)
    return math.sqrt(sum(x * x for x in s) / max(1, len(s)))


def _read_bands(proc, fds):
    """Read the three band pipes together (FFmpeg writes them in turns, so reading one
    at a time would stall it), turning each into window loudness as it arrives."""
    steps = [(rate // FPS) * 2 for _n, _f, rate in BANDS]       # bytes per window
    pending = [bytearray() for _ in BANDS]
    levels = [[] for _ in BANDS]
    sel = selectors.DefaultSelector()
    for i, fd in enumerate(fds):
        sel.register(fd, selectors.EVENT_READ, i)
    open_fds = len(fds)
    try:
        _pump(sel, open_fds, steps, pending, levels)
    finally:
        # this thread owns the pipes: closing them from elsewhere while select() waits
        # on them would leave it waiting forever
        sel.close()
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass
        proc.wait()                    # also reaps FFmpeg if it was killed
    return levels


def _pump(sel, open_fds, steps, pending, levels):
    while open_fds:
        for key, _ in sel.select():
            i = key.data
            data = os.read(key.fd, 65536)
            if not data:
                sel.unregister(key.fd)
                open_fds -= 1
                continue
            buf = pending[i]
            buf += data
            step = steps[i]
            whole = len(buf) - len(buf) % step
            for o in range(0, whole, step):
                levels[i].append(_rms(bytes(buf[o:o + step])))
            del buf[:whole]


def _normalise(levels):
    """0-255 per band, against that song's own loud parts (so quiet songs still move)."""
    if not levels:
        return []
    ordered = sorted(levels)
    ref = ordered[min(len(ordered) - 1, int(len(ordered) * 0.97))] or 1.0
    # square root: closer to how loud it feels than raw energy
    return [min(255, int(255 * math.sqrt(min(1.0, v / ref)))) for v in levels]


async def analyse(path):
    """{'fps', 'bands', 'frames', 'data'} for one audio file."""
    pipes = [os.pipe() for _ in BANDS[1:]]        # band 0 goes to stdout
    outs = ["pipe:1"] + [f"pipe:{w}" for _r, w in pipes]
    split = "".join(f"[s{i}]" for i in range(len(BANDS)))
    graph = f"[0:a]aformat=channel_layouts=mono,asplit={len(BANDS)}{split}"
    for i, (_n, af, rate) in enumerate(BANDS):
        graph += f";[s{i}]{af},aresample={rate}[b{i}]"
    cmd = ["nice", "-n", "15", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
           "-t", str(MAX_SECONDS), "-i", path, "-vn", "-filter_complex", graph]
    for i, out in enumerate(outs):
        cmd += ["-map", f"[b{i}]", "-f", "s16le", "-ac", "1", out]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, pass_fds=[w for _r, w in pipes])
    except OSError:
        for r, w in pipes:
            os.close(r)
            os.close(w)
        raise
    for _r, w in pipes:
        os.close(w)                               # only FFmpeg writes to these now
    # the reader thread owns (and closes) these
    fds = [os.dup(proc.stdout.fileno())] + [r for r, _w in pipes]
    proc.stdout.close()
    try:
        levels = await asyncio.to_thread(_read_bands, proc, fds)
    except asyncio.CancelledError:
        proc.kill()                               # the reader then sees the pipes close
        raise
    if proc.returncode != 0 or not all(levels):
        raise RuntimeError(f"ffmpeg couldn't read {path}")
    per_band = [_normalise(lv) for lv in levels]
    frames = min(len(b) for b in per_band)
    out = bytearray(frames * len(BANDS))
    for b, band in enumerate(per_band):
        out[b::len(BANDS)] = bytes(band[:frames])
    return {"fps": FPS, "bands": [b[0] for b in BANDS], "frames": frames,
            "data": base64.b64encode(bytes(out)).decode("ascii")}


class VibeCache:
    """Analyses files in the background and keeps the last few results."""

    def __init__(self, keep=8):
        self.keep = keep
        self.tasks = {}               # key -> asyncio.Task

    def start(self, key, path):
        """Begin analysing (no-op if this key is already known)."""
        if not key or not path or key in self.tasks:
            return
        self.tasks[key] = asyncio.create_task(self._run(key, path))
        while len(self.tasks) > self.keep:
            old = next(iter(self.tasks))
            t = self.tasks.pop(old)
            if not t.done():
                t.cancel()

    async def _run(self, key, path):
        try:
            return await analyse(path)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Vibe: couldn't analyse {key}: {e}")
            return None

    async def get(self, key, wait=20.0):
        """The result for key: waits a little if it's still being worked out."""
        task = self.tasks.get(key)
        if task is None:
            return None
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=wait)
        except TimeoutError:
            return None
