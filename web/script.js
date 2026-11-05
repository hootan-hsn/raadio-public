/* =====================================================================
   Raadio front end
   - Gapless two-element player that keeps playing with the screen off
   - Hardware / headset buttons through the Media Session API
   - Lite mode for old Android (real version read via UA Client Hints)
   - Studio: login, upload, recording and a shared calendar (controller /api/...)
   ===================================================================== */
(function () {
  "use strict";

  /* ---------------- Config ---------------- */
  var CONFIG = {
    // A pretend login for trying the studio: any name and password work, they never leave the
    // browser, and nothing is saved. Set to false on your own station to use real accounts.
    DEMO_LOGIN: true,
    // The demo on GitHub Pages only listens: no skip votes or notes reach the station.
    READ_ONLY: /\.github\.io$/.test(location.hostname),
    // Tried in order; the first that answers wins, the rest are fallbacks.
    HOSTS: [
      "https://raadio.xyz",
      "https://raadio.run.place"     // (the old name, same server: a second way in)
    ],
    // Opus uses ~50% less data than MP3; browsers that can't play it get MP3 automatically.
    // Opus comes in two qualities, picked with the HQ/Saver chip on the display.
    STREAM_OPUS: "/radio.opus",
    STREAM_OPUS_LITE: "/radio-lite.opus",
    STREAM_MP3: "/radio.mp3",
    STREAM_MP3_LITE: "/radio-lite.mp3",
    SKIP_PATH: "/skip",
    // The controller keeps one connection open through track changes, so the player
    // must not reconnect after a skip. Set to false only with the old per-track controller.
    CONTINUOUS_STREAM: true,
    NOW_PLAYING_PATH: "/now-playing",   // returns {"id", "title", "artist"}; set null to disable
    NOW_PLAYING_EVERY_MS: 15000,
    VOTE_WINDOW_MS: 90000,              // same as VOTE_WINDOW on the server
    CROSSFADE_MS: 400,
    // How late a listener hears the server = whatever this browser has buffered, measured
    // live, minus how far the stream runs ahead of real time (the server's `edge`; servers
    // from before it sent this as `delay`). The song title, the waveform and its progress all
    // use that, so they move with the music.
    SERVER_DELAY_S: 0,
    ANNOUNCEMENTS: [],           // e.g. [{ text: "Weekend mix", at: "2026-10-17T20:00:00Z" }]
    RECORD_MAX_MS: 10 * 60 * 1000,
    UPLOAD_MAX_MB: 50
  };

  /* ---------------- Small helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  function fmt(date, opts) {
    try { return new Intl.DateTimeFormat(undefined, opts).format(date); }
    catch (e) { return date.toLocaleString(); }
  }
  function fmtClock(d) { return fmt(d, { hour: "2-digit", minute: "2-digit" }); }
  function fmtFull(d) {
    return fmt(d, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  }
  function fmtSoon(d) {
    var now = new Date();
    var tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === now.toDateString()) return fmtClock(d);
    if (d.toDateString() === tomorrow.toDateString()) return fmt(d, { weekday: "short" }) + " " + fmtClock(d);
    if (d - now < 6 * 864e5) return fmt(d, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    return fmt(d, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function tzLabel() {
    try {
      var parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) if (parts[i].type === "timeZoneName") return parts[i].value;
    } catch (e) { /* ignore */ }
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; } catch (e) { return "local time"; }
  }
  // The picker starts at the next 5-minute mark at least 3 minutes away (e.g. 22:03 -> 22:10)
  function defaultAirTime() {
    var d = new Date(Date.now() + 3 * 60 * 1000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d;
  }
  function onIdle(fn) {
    if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 3000 });
    else setTimeout(fn, 600);
  }

  /* ---------------- Performance mode ---------------- */
  var perf = (function () {
    var listeners = [];
    var params = new URLSearchParams(location.search);
    var forced = params.get("lite");
    if (forced === "1" || forced === "0") store.set("raadio.lite", forced === "1");
    var pref = store.get("raadio.lite", null);

    // The UA string is frozen on modern Chrome ("Android 10; K", "Chrome/138.0.0.0"),
    // so a plain UA match for "Android 9" / "138.0.7204.179" never fires there.
    // This sync check only catches older browsers that still send the real version.
    var ua = navigator.userAgent;
    var m = ua.match(/Android (\d+)/);
    var oldAndroidUA = !!(m && +m[1] <= 9 && ua.indexOf("; K)") === -1);
    // Only browsers that report memory (Chrome) are judged weak by numbers: Safari doesn't
    // report it and can report a small, rounded core count on fast iPhones and Macs, which
    // used to switch every effect off there (the 3D background, glass and keys)
    var weak = !!navigator.deviceMemory &&
               (navigator.deviceMemory <= 2 || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2));

    var lite = pref !== null ? pref : !!(oldAndroidUA || weak);
    document.body.classList.toggle("lite", lite);

    function set(on, reason) {
      if (on === lite) return;
      lite = on;
      document.body.classList.toggle("lite", on);
      if (on && reason) log.add("warn", "Lite mode on (" + reason + ")");
      listeners.forEach(function (fn) { fn(on); });
    }

    // Real Android / Chrome versions via UA Client Hints (Chrome 90+).
    function refine() {
      var uad = navigator.userAgentData;
      if (pref !== null || !uad || !uad.getHighEntropyValues) return;
      uad.getHighEntropyValues(["platformVersion", "fullVersionList"]).then(function (h) {
        var android = parseInt(h.platformVersion, 10);
        var list = h.fullVersionList || [];
        var chrome = 0;
        for (var i = 0; i < list.length; i++) if (/Chrom/.test(list[i].brand)) chrome = parseInt(list[i].version, 10);
        if (uad.platform === "Android" && android > 0 && android <= 9) {
          set(true, "Android " + android + (chrome ? ", Chrome " + chrome : ""));
        }
      }).catch(function () { /* hints unavailable */ });
    }

    // If the page really can't keep up, drop the effects. Measured only after things have
    // settled (the 3D effects compile their shaders in the first seconds, which stutters on
    // any machine, Safari most of all: it used to switch the effects off on fast Macs), and
    // only if two separate checks in a row both come out slow.
    function probe() {
      if (lite || pref !== null) return;
      var slow = 0;
      function measure() {
        if (lite || document.hidden) { setTimeout(measure, 4000); return; }
        var frames = 0, start = 0, hid = false;
        function tick(t) {
          if (document.hidden) hid = true;
          if (!start) start = t;
          frames++;
          if (t - start < 2000) { requestAnimationFrame(tick); return; }
          var fps = frames * 1000 / (t - start);
          if (hid) { setTimeout(measure, 3000); return; }
          // (Safari runs at 30 fps in Low Power Mode and while recording the screen: that's fine)
          if (fps < 20) {
            if (++slow >= 3) set(true, "low frame rate, " + Math.round(fps) + " fps");
            else setTimeout(measure, 2000);
          }
        }
        requestAnimationFrame(tick);
      }
      setTimeout(measure, 4000);
    }

    return {
      isLite: function () { return lite; },
      onChange: function (fn) { listeners.push(fn); },
      refine: refine,
      probe: probe,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches
    };
  })();

  /* ---------------- Server log (studio panel C) ---------------- */
  var log = (function () {
    var el = $("server-log");
    var items = [];
    var dirty = false;
    var visible = false;

    function render() {
      dirty = false;
      var frag = document.createDocumentFragment();
      items.forEach(function (it) {
        var li = document.createElement("li");
        var t = document.createElement("time");
        t.dateTime = it.at.toISOString();
        t.textContent = fmtClock(it.at);
        var s = document.createElement("span");
        s.className = "log-" + it.type;
        s.textContent = it.text;
        li.appendChild(t); li.appendChild(s);
        frag.appendChild(li);
      });
      el.replaceChildren(frag);
    }
    return {
      add: function (type, text) {
        if (items.length && items[0].text === text) return;
        items.unshift({ type: type, text: text, at: new Date() });
        if (items.length > 3) items.length = 3;      // the strip shows exactly three
        // Only touch the DOM when the studio is showing (keeps audio transitions light)
        if (visible) onIdle(render); else dirty = true;
      },
      show: function (on) { visible = on; if (on && dirty) render(); }
    };
  })();

  /* ---------------- Theme ---------------- */
  function applyTheme() {
    var h = new Date().getHours();
    var dark = h >= 18 || h < 6;
    if (document.body.classList.contains("dark-mode") === dark && applyTheme.done) return;
    applyTheme.done = true;
    document.body.classList.toggle("dark-mode", dark);
    $("theme-color").setAttribute("content", dark ? "#1d1b18" : "#ebe7e0");
    wave.refreshColors();
  }

  /* ---------------- Hosts ---------------- */
  var hosts = (function () {
    var list = CONFIG.HOSTS.slice();
    // Opened from our own server under another name or its bare address (e.g. a new
    // domain, or the IP where a domain is blocked)? Try that address first, so the
    // stream and the API come from wherever the page itself got through.
    (function () {
      var o = location.origin;
      if (!/^https?:/.test(location.protocol) || /\.github\.io$|^localhost$|^127\./.test(location.hostname)) return;
      if (list.indexOf(o) === -1) { list.unshift(o); list.fromPage = true; }
    })();
    var idx = list.fromPage ? 0 : Math.max(0, list.indexOf(store.get("raadio.host", list[0])));

    // Asks for the stream itself (not the page: a VPN or a relay that refuses foreign
    // addresses can let the page through, or the service worker can answer it from its
    // copy, while the stream never arrives), but only its headers (HEAD): a GET hung up
    // after the headers still brought in the start of Icecast's burst, tens of KB per
    // address on every page load, on lines from Iran where every KB counts.
    function probe(host, delay) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          var ctrl = "AbortController" in window ? new AbortController() : null;
          var t = setTimeout(function () { if (ctrl) ctrl.abort(); reject(new Error("timeout")); }, 6000);
          fetch(host + CONFIG.STREAM_OPUS_LITE + "?probe=" + Date.now(), { method: "HEAD", mode: "no-cors", cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
            .then(function () { clearTimeout(t); if (ctrl) ctrl.abort(); resolve(host); })
            .catch(function (e) { clearTimeout(t); reject(e); });
        }, delay);
      });
    }

    return {
      current: function () { return list[idx]; },
      count: function () { return list.length; },
      others: function () { return list.filter(function (_, i) { return i !== idx; }); },
      next: function () { idx = (idx + 1) % list.length; store.set("raadio.host", list[idx]); return list[idx]; },
      label: function (h) { try { return new URL(h || list[idx]).hostname; } catch (e) { return h; } },
      // a relay: an address that isn't one of ours (the page opened from a relay's own domain)
      isRelay: function () { return CONFIG.HOSTS.indexOf(list[idx]) === -1; },
      pick: function () {
        if (list.length < 2 || !Promise.any) return Promise.resolve(list[idx]);
        // the last host that worked gets a head start, so most people stay where they were
        return Promise.any(list.map(function (h, i) { return probe(h, i === idx ? 0 : 400); }))
          .then(function (h) { idx = list.indexOf(h); store.set("raadio.host", h); return h; })
          .catch(function () { return list[idx]; });
      }
    };
  })();

  /* ---------------- Audio engine ----------------
     Two <audio> elements. A new connection is prepared on the idle one while the
     current one finishes its buffered audio, then they crossfade. A near-silent
     loop runs during any gap so Android keeps the page "playing" with the screen off
     (a silent page gets its timers frozen, which is why track changes stopped). */
  var engine = (function () {
    var A = new Audio(), B = new Audio();
    var cur = A, nxt = B;
    var keep = new Audio();
    var handlers = {};
    var wanted = false, connecting = false, unlocked = false;
    var gen = 0, held = null, holdTimer = null, fadeTimer = null;
    var lastTime = 0, lastAdvance = 0, lastBufEnd = 0, lastGrow = 0;
    var interrupted = 0, intTimer = 0;     // when the phone paused us (see the "pause" listener)
    var bufDelay = 7; // seconds buffered ahead (burst = start threshold + 3 s); set from the stream on each connect (resetWatch)
    // The moment being heard, on this device's clock, driven by the audio element's own
    // playback position: it moves exactly as the sound does (stops on a stall, speeds up
    // while catching up) instead of jumping whenever the delay estimate is corrected.
    // K links the two clocks and is nudged towards the estimate only very slowly.
    var hc = { el: null, k: 0, ct: -1, at: 0, shown: 0, last: 0, exact: false };
    function heardAt() {
      // (straight from the stream when it can say: bufDelay starts each new connection at the
      // burst's size on paper, which for Opus is 1.5-2 s off, and the drift below took a
      // minute to make that up: the music ran ahead of the timeline after every reconnect)
      var due = audible(cur) ? heardDue(cur) : null;
      var nowS = Date.now() / 1000, est = due != null ? due : nowS + edgeOf(cur) - bufDelay;
      if (!audible(cur)) { hc.el = null; return est; }
      var ct = cur.currentTime, t = performance.now();
      if (hc.el !== cur || ct < hc.ct - 0.5) {            // new stream: start over
        hc.el = cur; hc.k = est - ct; hc.ct = ct; hc.at = t; hc.shown = 0; hc.last = t; hc.exact = due != null;
      } else if (ct !== hc.ct) { hc.ct = ct; hc.at = t; }
      // between the element's (coarse) updates, run on at the playback rate, never far
      var run = Math.min(0.25, (t - hc.at) / 1000 * (cur.playbackRate || 1));
      var target = est - ct, dt = Math.min(0.5, (t - hc.last) / 1000 || 0);
      hc.last = t;
      if (Math.abs(target - hc.k) > 2.5) hc.k = target;    // way off (e.g. after a long stall)
      else if (due != null && !hc.exact) { hc.k = target; hc.exact = true; }   // the stream can say now: from there
      else {                                               // otherwise drift, at most 3% speed
        var step = 0.03 * dt;
        hc.k += Math.max(-step, Math.min(step, target - hc.k));
      }
      var v = hc.k + ct + run;
      if (v < hc.shown && hc.shown - v < 0.3) v = hc.shown; // never step backwards
      hc.shown = v;
      return v;
    }
    var canFade = (function () { try { var a = new Audio(); a.volume = 0.5; return a.volume === 0.5; } catch (e) { return false; } })();

    [A, B].forEach(function (el) {
      // (when this stream's data started arriving, and how big a burst came with it: see lag())
      el.addEventListener("loadstart", function () { el._t0 = 0; });
      el.addEventListener("loadedmetadata", function () {
        if (!/\/radio/.test(el.src)) return;
        // when Icecast sent the burst: just after we asked for it (on a slow line the burst
        // takes a while to arrive, and its first bytes alone made this up to 1 s late)
        var nowS = Date.now() / 1000;
        el._t0 = el._req && srv.rtt < 5 ? Math.min(nowS, el._req + srv.rtt / 2) : nowS;
        var info = streamInfo(el.src);
        el._ogg = info.ogg; el._kbit = info.kbit; el._burstBytes = info.bytes; el._burst = info.burst;
        el._edge0 = edgeOf(el);
        el._ct0 = 0;
      });
      // where its clock starts: 0, or (Chrome, Opus) the encoder's clock at the burst's start
      el.addEventListener("loadeddata", function () {
        if (!el._t0) return;
        el._ct0 = el.currentTime || 0;
        if (el._ogg && sideClock === null) sideClock = !(el._ct0 > 1);   // (on the encoder's clock: no need)
      });
      el.preload = "none";
      el.setAttribute("playsinline", "");
      el.addEventListener("ended", function () { if (el === cur && wanted && el.src !== keep.src) curDown("ended"); });
      el.addEventListener("error", function () {
        if (el === cur && wanted && el.getAttribute("src") && el.src !== keep.src) curDown("error");
      });
      // ran out of audio (slow network, dropped connection): say so at once, so the tuning
      // sound covers the gap instead of silence
      el.addEventListener("waiting", function () { if (el === cur && wanted && !connecting && el.src !== keep.src) starve(true); });
      el.addEventListener("playing", function () { if (el === cur) starve(false); });
      // The phone paused us: another app made a sound (a video, a voice message), a call came
      // in, the headphones came out. This used to count as pressing stop, so the radio stayed
      // off when the other app was done. Now it's an interruption: phones often hand the sound
      // back by themselves (then it just carries on), and otherwise it comes back the moment
      // you return to Raadio or press play on the lock screen.
      el.addEventListener("pause", function () {
        if (el !== cur || !wanted || el.ended || !el.getAttribute("src") || el.src === keep.src) return;
        if (fadeTimer || interrupted) return;
        interrupted = Date.now();
        emit("state", "paused");
        clearTimeout(intTimer);
        // not back within 20 s: let the connection go (no data used while it waits)
        intTimer = setTimeout(function () {
          if (interrupted && cur.paused) { gen++; release(cur); release(nxt); stopKeep(); connecting = false; }
        }, 20000);
      });
      el.addEventListener("play", function () {
        if (el !== cur || !interrupted) return;
        var away = Date.now() - interrupted;
        interrupted = 0; clearTimeout(intTimer);
        // handed back quickly: carry on; after a longer pause, jump back to what's on air now
        if (away > 8000) connect("resume"); else emit("state", "live");
      });
    });

    keep.loop = true;
    keep.preload = "auto";
    keep.src = silentWav();

    var starving = false;
    var stallAt = 0;
    function starve(on) {
      if (on === starving) return;
      starving = on;
      if (on) stallAt = Date.now();
      else if (stallAt) { weak.stalled(Date.now() - stallAt); stallAt = 0; }
      emit(on ? "stall" : "flow");
    }
    function emit(evt, data) { (handlers[evt] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); }
    function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }

    function silentWav() {
      var rate = 8000, n = rate;   // 1 s, 16-bit mono
      var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      function w(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
      w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, "data"); v.setUint32(40, n * 2, true);
      // ±1 LSB (about -90 dB): inaudible, but not digital silence, so the page still counts as playing
      for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, (i & 1) ? 1 : -1, true);
      return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    }

    // Opus if this browser says it can play it, MP3 otherwise. A fallback to MP3 after
    // failures lasts only until the page is reloaded: a server restart used to be enough
    // to switch a listener to MP3 for a whole day.
    store.del("raadio.codec");
    var useOpus = (function () {
      try { return !!new Audio().canPlayType('audio/ogg; codecs="opus"'); } catch (e) { return false; }
    })();
    var opusWorked = false;
    var playedHere = false;          // a stream has played from the current address (see fail)
    var QUALITY_FADE_MS = 1200;      // HQ <-> Saver: long and eased, so the change in tone isn't a step
    var everPlayed = false;          // anything has played since the page opened
    // "high" (HQ) or "saver", for Opus and MP3 alike
    var quality = store.get("raadio.quality", "high") === "saver" ? "saver" : "high";
    var prefer = quality;            // what the listener picked (quality: what's playing; see weak)
    // In Iran (the device's time zone, which a VPN doesn't change) the line abroad is long
    // and often throttled: unless the listener has picked a quality, start on Saver (half
    // the data, so the first seconds arrive sooner) and go up to HQ by itself once the stream
    // has played steadily (weak.tick), the same way as after a weak spell.
    var startLow = store.get("raadio.quality", null) === null && (function () {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tehran"; } catch (e) { return false; }
    })();
    if (startLow) quality = "saver";
    var liteWorked = false;
    function lite() { return quality === "saver"; }
    // The burst Icecast sends a new listener (deploy/icecast): what browsers wait for before
    // they start playing, plus 3 s. In seconds it's exact for MP3; Opus's bitrate varies, and
    // with the Ogg pages its bursts hold less than their bytes say: measured against the
    // encoder's clock, ~6.0 s for HQ (not 7) and ~10.1 s for Saver (not 11; 8.3-11.5 with the
    // music). Only players without that clock (Safari) go by these, and on paper they put
    // the music ~1.7 s ahead of the timeline after every HQ connection.
    function streamInfo(url) {
      var ogg = /\.opus/.test(url), small = /-lite\./.test(url);
      var kbit = ogg ? (small ? 32 : 64) : (small ? 64 : 128);
      var bytes = ogg ? (small ? 44000 : 56000) : (small ? 152000 : 176000);
      return { ogg: ogg, kbit: kbit, bytes: bytes, burst: ogg ? (small ? 10.1 : 6.0) : bytes * 8 / 1000 / kbit };
    }
    function burstSeconds() { return streamInfo(streamUrl()).burst; }
    function streamUrl() {
      var path = useOpus ? (lite() ? CONFIG.STREAM_OPUS_LITE : CONFIG.STREAM_OPUS)
                         : (lite() ? CONFIG.STREAM_MP3_LITE : CONFIG.STREAM_MP3);
      return hosts.current() + path + "?t=" + Date.now();
    }

    function release(el) {
      el._g0 = null;                   // (its side clock was for the stream it had: see openStream)
      try { el.pause(); } catch (e) { /* ignore */ }
      el.removeAttribute("src");
      try { el.load(); } catch (e) { /* ignore */ }
      el.volume = 1;
      el.playbackRate = 1;
      el.preload = "none";
    }

    function audible(el) { return !!el.getAttribute("src") && el.src !== keep.src && !el.paused && !el.ended && el.readyState >= 2; }
    function bufferedEnd(el) { try { var b = el.buffered; return b.length ? b.end(b.length - 1) : 0; } catch (e) { return 0; } }
    function ahead(el) { return Math.max(0, bufferedEnd(el) - el.currentTime); }
    // ---- Which moment is this speaker playing? ----
    // The server's /now-playing gives: `edge`, how far each stream's newest audio runs ahead
    // of its due time (the controller keeps ~1 s queued in front of real time), and `clock`,
    // when the encoder's first sample was due. started_at and the waveform are due times.
    var srv = { edge: null, clock: null, off: 0, rtt: 1e9, at: 0 };
    function edgeOf(el) {
      var e = srv.edge && (el && el._ogg ? srv.edge.opus : srv.edge.mp3);
      return typeof e === "number" ? e : -CONFIG.SERVER_DELAY_S;     // (older server: its `delay`)
    }
    // Chrome plays an Opus stream on the encoder's own clock (Ogg granule positions), so
    // currentTime + clock is exactly the due time of what's playing, however much is buffered
    // or however big the burst really was (Opus's bitrate varies). Other players start at 0.
    function onClock(el) {
      if (!el._ogg || srv.clock == null || !el._t0) return false;
      var start = srv.clock + srv.off + el._ct0;                      // the burst's first sound
      return Math.abs(start - (el._t0 + el._edge0 - el._burst)) < Math.max(5, el._burst);
    }
    // The due time (on this device's clock) of the sound under the playhead; null = unknown.
    // Otherwise from the burst: Icecast sends a new listener its burst (burstSeconds) the
    // moment it connects, ending at the stream's edge, then the stream in real time.
    // (The browser's own "buffered" can't be used: Chrome only reports the couple of seconds
    // it has unpacked, and skips were landing up to 8 s off.)
    var MP3_SHIFT = 0.015;
    function heardDue(el) {
      if (!el || !el._t0 || !(el.currentTime > 0 || (el._g0 != null && el.readyState >= 2))) return null;
      if (onClock(el)) return srv.clock + srv.off + el.currentTime;
      if (el._ogg && el._g0 != null && srv.clock != null) return srv.clock + srv.off + el._g0 + el.currentTime;   // (see openStream)
      // (MP3 really plays a little further along than its bytes say: measured against Opus's
      // exact clock; mostly the part-frame it skips at the burst's start)
      return el._t0 + el._edge0 - el._burst + (el.currentTime - el._ct0) + (el._ogg ? 0 : MP3_SHIFT);
    }
    // Safari plays Opus from 0, not on the encoder's clock (see onClock), so it can't say which
    // moment it's playing: the timeline went by the burst's size, which varies with the music,
    // and switching HQ <-> Saver couldn't be lined up (it jumped ~4.5 s). The stream itself can
    // say: a second request made together with the player's gets the very same burst from
    // Icecast (checked: every time, within 50 ms of each other), and its first audio page's
    // granule position is that moment on the encoder's clock. Read just that, and hang up.
    var sideClock = null;            // does this browser need it? (learned from its first stream)
    function hasClock(el) { return onClock(el) || (!!el._ogg && el._g0 != null && srv.clock != null); }
    function opusSamples(b, o, len) { // 48 kHz samples in one Opus packet (RFC 6716, 3.1)
      var toc = b[o], cfg = toc >> 3, c = toc & 3;
      var fs = cfg < 12 ? [480, 960, 1920, 2880][cfg & 3] : cfg < 16 ? [480, 960][cfg & 1] : [120, 240, 480, 960][cfg & 3];
      return fs * (c === 0 ? 1 : c < 3 ? 2 : len > 1 ? b[o + 1] & 63 : 1);
    }
    // where the first audio page starts on the encoder's clock (seconds), less the stream's
    // pre-skip as Chrome counts it (checked against Chrome's own clock: the same to the ms);
    // undefined: more bytes needed
    function firstPage(b) {
      var i = 0, k, skip = 312;
      while (i + 27 <= b.length) {
        if (b[i] !== 79 || b[i + 1] !== 103 || b[i + 2] !== 103 || b[i + 3] !== 83) { i++; continue; }   // "OggS"
        var n = b[i + 26], body = i + 27 + n, size = 0;
        if (body > b.length) return undefined;
        for (k = 0; k < n; k++) size += b[i + 27 + k];
        if (body + size > b.length) return undefined;
        var lo = (b[i + 6] | b[i + 7] << 8 | b[i + 8] << 16 | b[i + 9] << 24) >>> 0;
        var hi = (b[i + 10] | b[i + 11] << 8 | b[i + 12] << 16 | b[i + 13] << 24) >>> 0;
        if (size >= 12 && b[body] === 79 && b[body + 4] === 72) skip = b[body + 10] | b[body + 11] << 8;   // "OpusHead"
        if ((lo || hi) && hi < 0x80000000 && !(b[i + 5] & 1)) {        // audio, not continued from before
          var samples = 0, len = 0, o = body;
          for (k = 0; k < n; k++) {
            len += b[i + 27 + k];
            if (b[i + 27 + k] < 255) { if (len) samples += opusSamples(b, o, len); o += len; len = 0; }
          }
          return (hi * 4294967296 + lo - samples - skip) / 48000;
        }
        i = body + size;
      }
      return undefined;
    }
    function openStream(el, url) {
      el._req = Date.now() / 1000; el._g0 = null;
      el.src = url;
      if (sideClock === false || !/\.opus/.test(url) || !window.fetch || !window.AbortController) return;
      var src = el.src, ctrl = new AbortController(), buf = new Uint8Array(0), over = false;
      function done(g) {
        if (over) return;
        over = true;
        try { ctrl.abort(); } catch (e) { /* ignore */ }
        if (g != null && el.src === src) el._g0 = g;
      }
      setTimeout(function () { done(null); }, 10000);
      fetch(url.replace(/\?.*/, "") + "?c=" + Date.now(), { cache: "no-store", signal: ctrl.signal }).then(function (res) {
        if (!res.ok || !res.body || !res.body.getReader) { done(null); return; }
        var reader = res.body.getReader();
        (function more() {
          reader.read().then(function (r) {
            if (over) return;
            if (r.done) { done(null); return; }
            var b = new Uint8Array(buf.length + r.value.length);
            b.set(buf); b.set(r.value, buf.length); buf = b;
            var g = firstPage(buf);
            if (g !== undefined) done(g);
            else if (buf.length > 65536) done(null);
            else more();
          }, function () { done(null); });
        })();
      }, function () { done(null); });
    }

    // How far behind this stream's newest audio the playhead is: what has arrived here and
    // not been played yet (seconds), or -1 if unknown
    function lag(el) {
      var h = heardDue(el);
      if (h == null) return -1;
      var v = Date.now() / 1000 + edgeOf(el) - h;
      return v > 0 && v < 60 ? v : -1;
    }
    // How much must be in hand for the music to keep flowing. Chrome reads a stream 32 KB at
    // a time and stalls unless it has a whole 32 KB beyond what's playing: ~2 s of MP3 HQ,
    // ~4 s of Opus HQ (more in its quiet parts), ~8 s of Saver. Skips landing with less
    // stuttered 2-3 s into the new song.
    function safeLag(el) {
      if (!el || !el._kbit) return 3;
      var bps = el._kbit * 125;                                       // bytes per second
      if (onClock(el)) {                                              // (Opus: what it really is now)
        var dur = el._t0 + el._edge0 - (srv.clock + srv.off + el._ct0);
        if (dur > 2 && dur < 40) bps = el._burstBytes / dur;
      }
      return Math.min(14, 32768 / bps * 1.08 + 0.6);
    }

    function startKeep() { if (keep.paused) { var p = keep.play(); if (p && p.catch) p.catch(function () {}); } }
    function stopKeep() { if (!keep.paused) keep.pause(); }

    // iOS needs each element started once inside a tap; Chrome doesn't care.
    function unlock() {
      if (unlocked) return;
      unlocked = true;
      startKeep();
      var el = cur;               // the first connection goes to the other element
      if (!el.getAttribute("src")) {
        el.muted = true;
        el.src = keep.src;
        var p = el.play();
        var done = function () { el.muted = false; if (el.src === keep.src) release(el); };
        if (p && p.then) p.then(done, done); else done();
      }
    }

    function clearHold() {
      if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
      held = null;
    }

    function resetWatch() {
      var now = Date.now();
      lastTime = 0; lastAdvance = now; lastBufEnd = 0; lastGrow = now;
      bufDelay = burstSeconds();         // a new connection starts with Icecast's burst
    }

    function connect(reason) {
      if (weak.op) { clearInterval(weak.jt); weak.jt = 0; if (weak.op !== cur) release(weak.op); weak.op = null; }
      interrupted = 0; clearTimeout(intTimer);
      var my = ++gen;
      connecting = true;
      clearHold();
      if (!audible(cur)) { startKeep(); emit("state", "connecting"); }
      emit("connecting", reason);
      // After our own skip the old source needs a moment to drop off the mount
      setTimeout(function () { attempt(my, reason, 0); }, reason === "skip" ? 350 : 0);
    }

    // Head start: when a finger (or mouse button) goes down on Play, start downloading the
    // stream straight away. Playing has to wait for the tap to finish (browsers only allow
    // sound then), but by that time the connection is open and audio is arriving.
    var warmEl = null, warmAt = 0, warmTimer = 0;
    function warm() {
      if (wanted || warmEl || !navigator.onLine) return;
      var el = nxt;
      if (el === cur) return;
      release(el);
      el.preload = "auto";
      el.volume = 1;
      openStream(el, streamUrl());
      try { el.load(); } catch (e) { /* ignore */ }
      warmEl = el; warmAt = Date.now();
      clearTimeout(warmTimer);
      warmTimer = setTimeout(function () {           // pressed but never tapped (e.g. a scroll)
        if (warmEl && !wanted) { release(warmEl); }
        warmEl = null;
      }, 4000);
    }

    function attempt(my, reason, n) {
      if (my !== gen || !wanted) return;
      var el = nxt;
      if (el === cur) return;
      var warmed = warmEl === el && n === 0 && Date.now() - warmAt < 4000 && !!el.getAttribute("src");
      warmEl = null; clearTimeout(warmTimer);
      if (!warmed) {
        release(el);
        el.preload = "auto";
        el.volume = 1;
        openStream(el, streamUrl());
      }

      // Patient with a slow line (a VPN from Iran can take well over 9 s to bring in the first
      // few seconds): while data keeps arriving it waits up to 30 s; only 9 s with nothing
      // arriving counts as a failure. (Hanging up on a stream that's still coming in and
      // starting again from nothing is how a slow line used to never play at all.)
      var settled = false, began = Date.now(), lastData = began;
      function onData() { lastData = Date.now(); }
      function check() {
        var now = Date.now();
        if (now - lastData < 9000 && now - began < 30000) { timer = setTimeout(check, Math.max(500, 9000 - (now - lastData))); return; }
        fail("timeout");
      }
      var timer = setTimeout(check, 9000);
      el.addEventListener("progress", onData);
      function cleanup() { clearTimeout(timer); el.removeEventListener("canplay", ok); el.removeEventListener("error", bad); el.removeEventListener("progress", onData); }
      function ok() {
        if (settled) return; settled = true; cleanup();
        if (my !== gen) { release(el); return; }
        ready(my, el, reason);
      }
      function bad() { fail("error"); }
      function fail(why) {
        if (settled) return; settled = true; cleanup(); release(el);
        if (my !== gen || !wanted) return;
        // The Saver stream isn't on this server (yet): use HQ instead of failing
        if (lite() && !liteWorked && n + 1 >= 3) {
          quality = "high";
          emit("quality", { q: quality, fallback: true });
        }
        // Opus never played on this device and keeps failing: fall back to MP3 for good
        if (useOpus && !opusWorked && n + 1 >= 3) {
          useOpus = false;
          emit("codec", "mp3");
        }
        if (!navigator.onLine) { connecting = false; emit("state", "offline"); return; }
        // Nothing has played yet and HQ keeps timing out: start on Saver (half the data). It
        // goes back up to HQ by itself once the line has been steady (weak.tick).
        if (why === "timeout" && !everPlayed && quality === "high" && prefer === "high" && !weak.low && n + 1 >= 2) {
          weak.low = true; weak.downAt = Date.now();
          quality = "saver";
          emit("quality", { q: quality, auto: true });
          emit("autoq", { q: "saver", why: "slow" });
        }
        // A short 404 between tracks is normal; only a long run of failures means this route is
        // blocked. Before anything has played here, three failures are enough: the route is
        // most likely shut (e.g. a VPN reaching a relay in Iran that refuses foreign addresses).
        // (The list, not CONFIG.HOSTS: the page's own address is added to it, so a relay page
        // has the main server to fall back to even though CONFIG lists only one.)
        var tries = n + 1;
        if (hosts.count() > 1 && (playedHere ? tries >= 8 && tries % 4 === 0 : tries % 3 === 0)) { playedHere = false; emit("host", hosts.next()); }
        emit("retry", { n: n + 1, why: why, reason: reason });
        // Between tracks the mount is gone for under a second: poll quickly for ~2 s, then back off
        var delay = n < 6 ? 300 : Math.min(500 * Math.pow(2, n - 6), 4000);
        setTimeout(function () { attempt(my, reason, n + 1); }, delay);
      }
      el.addEventListener("canplay", ok);
      el.addEventListener("error", bad);
      if (!warmed) el.load();
      else if (el.error) bad();
      else if (el.readyState >= 3) ok();             // already had enough while the finger was down
    }

    function ready(my, el, reason) {
      var old = cur;
      var waitForTail = reason === "source-closed" && audible(old);
      if (!waitForTail) { promote(my, el, old); return; }

      // The old connection still has a few seconds buffered: let it play out, then fade.
      held = { my: my, el: el };
      var started = Date.now();
      var endAtStart = bufferedEnd(old);
      holdTimer = setInterval(function () {
        if (!held || held.my !== gen) { clearHold(); return; }
        if (bufferedEnd(old) > endAtStart + 0.75) {
          // False alarm: the old stream is still flowing. Drop the spare connection.
          clearHold(); release(el); connecting = false; resetWatch(); return;
        }
        if (!audible(old) || ahead(old) <= CONFIG.CROSSFADE_MS / 1000 + 0.15 || Date.now() - started > 15000) {
          var h = held; clearHold(); promote(h.my, h.el, old);
        }
      }, 150);
    }

    // Music coming in under the tuning sound starts quiet and swells (see the tuner);
    // browsers that won't change an element's volume (iPhone) just start at full.
    var soft = false, volTimer = 0;
    function rampVol(el, from, to, ms) {
      if (!canFade) return;
      clearInterval(volTimer);
      var s = performance.now();
      try { el.volume = from; } catch (e) { /* ignore */ }
      volTimer = setInterval(function () {
        var k = clamp((performance.now() - s) / ms, 0, 1), e = k * k * (3 - 2 * k);
        try { el.volume = from + (to - from) * e; } catch (x) { /* ignore */ }
        if (k >= 1) { clearInterval(volTimer); volTimer = 0; }
      }, 30);
    }

    function promote(my, el, old) {
      if (my !== gen || !wanted) { release(el); return; }
      if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; fadeEnd = null; }
      var fade = canFade && audible(old);
      cur = el; nxt = old;
      clearInterval(volTimer); volTimer = 0;
      el.muted = false;
      el.volume = fade ? 0 : (soft && canFade ? 0.15 : 1);
      var p = el.play(), settled = false;
      // The phone may neither start the sound nor refuse it (during a phone call, some just
      // never answer). Waiting on that left the player stuck "connecting", and the next tap
      // on Play stopped it instead of playing. Give up after a while; the next tap starts again.
      var guard = setTimeout(function () {
        if (settled || my !== gen) return;
        settled = true;
        cur = old; nxt = el; release(el);
        stop(); emit("blocked");
      }, 6000);
      Promise.resolve(p).then(function () {
        if (settled || my !== gen) return;
        settled = true; clearTimeout(guard);
        connecting = false;
        if (weak.low && !everPlayed) weak.downAt = Date.now();     // (started low: steady time counts from here)
        playedHere = true; everPlayed = true;
        if (useOpus && !opusWorked) { opusWorked = true; emit("codec", "opus"); }
        if (lite()) liteWorked = true;
        resetWatch();
        stopKeep();
        starving = false;
        if (fade) crossfade(old, el); else release(old);
        emit("state", "live");
        emit("track");
      }).catch(function (err) {
        if (settled || my !== gen) return;
        settled = true; clearTimeout(guard);
        cur = old; nxt = el; release(el);
        if (err && err.name === "NotAllowedError") { stop(); emit("blocked"); }
        else { connecting = false; connect("error"); }
      });
    }

    // ms: how long (a skip's new song: CROSSFADE_MS; HQ <-> Saver: longer, see retune). Eased
    // at both ends; the two levels always add up to one, which is right for two streams of the
    // same music lined up to the sample (it never dips or swells in the middle).
    var fadeEnd = null;
    function crossfade(from, to, ms) {
      var start = performance.now(), D = ms || CONFIG.CROSSFADE_MS;
      fadeEnd = function () { clearInterval(fadeTimer); fadeTimer = null; fadeEnd = null; to.volume = 1; release(from); };
      fadeTimer = setInterval(function () {
        var k = clamp((performance.now() - start) / D, 0, 1);
        k = k * k * (3 - 2 * k);
        to.volume = k;
        from.volume = 1 - k;
        if (k >= 1) fadeEnd();
      }, 30);
    }
    // A skip or a switch borrows the spare element: if it's still fading out, finish that
    // first (the fade's end used to let go of it, now the skip's stream, mid-skip)
    function endFade() { if (fadeEnd) fadeEnd(); }

    function curDown(reason) {
      if (held) { var h = held; clearHold(); promote(h.my, h.el, cur); return; }
      if (connecting) { startKeep(); emit("state", "connecting"); return; }
      connect(reason);
    }

    // Detects a stalled stream, and a source that closed. When the server ends a track the
    // download finishes (networkState goes IDLE) while 1-3 s of audio is still buffered,
    // which is enough time to open the next connection before anything goes quiet.
    // (Chrome only updates the buffered range in ~2 s steps, so it can't be used for this.)
    setInterval(function () {
      if (!wanted || connecting || held || !cur.getAttribute("src") || cur.paused) return;
      var now = Date.now();
      var t = cur.currentTime;
      if (t > lastTime + 0.05) { lastTime = t; lastAdvance = now; starve(false); }
      else if (rushTimer) { /* (creeping up to the new song after a skip, under the tuning sound) */ }
      else if (now - lastAdvance > 6000) { connect("stall"); return; }
      else if (now - lastAdvance > 700) starve(true);          // nothing heard for a moment
      // The download really ended only if the browser has stopped receiving AND nothing new
      // has arrived for a while AND what's left is running out. (Firefox and Safari also go
      // "idle" when they simply pause downloading because their buffer is full; reconnecting
      // then jumped the music a few seconds ahead, which sounded like the song cutting off.)
      var be = bufferedEnd(cur);
      if (be > lastBufEnd + 0.05) { lastBufEnd = be; lastGrow = now; }
      if (cur.networkState === 1 /* NETWORK_IDLE */ && now - lastGrow > 4000 && ahead(cur) < 2.5) connect("source-closed");
      // How far behind live we are: what's buffered but not played yet. Chrome updates the
      // buffered range in steps, so smooth it; ignore nonsense from browsers that report none.
      var a = lag(cur);
      if (a >= 0) bufDelay += (a - bufDelay) * 0.3;           // (exact, so it can follow closely)
      else if (bufferedEnd(cur) > 0 && (a = ahead(cur)) < 60) bufDelay += (a - bufDelay) * 0.08;
      // (No speeding up to catch up: browsers report a live stream's buffer in rough
      // steps, so it kept switching speed, and every switch made the sound drop out.)
    }, 300);

    // After a skip: what's still buffered here is the old song's tail, muted under the tuning
    // sound. Run through it at whatever speed brings the playhead to the new song's first
    // sound (`at`: that moment on this device's clock) just as enough of the new song has
    // arrived to play on without stalling (safeLag), then `done`. That's usually faster than
    // normal; straight after another skip there's little in hand and it runs slower instead
    // (muted, so the speed can't be heard). Players that won't change speed just play it out.
    // Safari won't change the speed of a stream (asked for 2x, it plays on at 1x), so there the
    // skip seeks instead: straight to the new song's first sound, as soon as Safari has a little
    // of it. Safari then holds the music, silently and under the tuning sound, until it has
    // ~5 s in hand, and goes on by itself the moment it does: the skip lands when the music
    // moves again. (Waiting for Safari's own "buffered" to show the 5 s first cost 2-3 s more:
    // it lags what has arrived and moves in 2 s steps.)
    var rateWorks = true, SEEK_NEED = 1, seekLead = 0.05;
    var rushTimer = 0;
    function rush(at, done, waited) {
      clearInterval(rushTimer); rushTimer = 0;
      var el = cur, t0 = Date.now(), finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        clearInterval(rushTimer); rushTimer = 0;
        try { el.playbackRate = 1; } catch (e) { /* ignore */ }
        var l = lag(el);
        if (l >= 0) bufDelay = l;                                        // (we're nearer live now)
        hc.el = null;                                                    // (and the heard-clock starts over from there)
        done();
      }
      if (!audible(el)) { finish(); return 0; }
      // the moment under the playhead, straight from the stream (see heardDue()), so it stays
      // exact while the speed changes
      function heard() { var h = heardDue(el); return h != null ? h : heardAt(); }
      var need = safeLag(el);
      var aim = at - 0.12;                                 // (a hair early: the hush between the songs)
      var limit = Math.max(0, at - heard()) + need + 4;    // seconds; at worst
      var probe = null, seeked = 0;
      rushTimer = setInterval(function () {
        if (el !== cur || !wanted || Date.now() - t0 > limit * 1000) { finish(); return; }
        var left = aim - heard();
        if (!rateWorks || (el._ogg && el._g0 != null)) {                // (the side clock: Safari)
          if (seeked) { if (el.currentTime > seeked + 0.1) finish(); return; }   // (playing on from there: landed)
          if (left <= 0.3) { finish(); return; }
          var to = el.currentTime + left;
          if (bufferedEnd(el) >= to + SEEK_NEED) { try { el.currentTime = to; seeked = to; } catch (e) { finish(); } }
          return;
        }
        // (does the speed take? measured over a moment of asking for well above 1x)
        if (el.playbackRate > 1.3) {
          if (!probe) probe = { ct: el.currentTime, t: performance.now() };
          else if (performance.now() - probe.t > 800) {
            var got = (el.currentTime - probe.ct) / ((performance.now() - probe.t) / 1000);
            if (got > 0.8 && got < 1.15) { rateWorks = false; setRate(el, 1); return; }   // (1x: ignored; ~0 is a stall, not this)
            probe = null;
          }
        } else probe = null;
        var have = lag(el);
        if (have < 0) have = ahead(el);
        if (left <= 0.02 && have >= need - 0.1) { finish(); return; }
        // play `left` seconds in the time it takes `have` to grow to `need` on landing:
        // rate r gets there in left/r s, by which time have + left/r - left has arrived
        var rate = Math.max(0.1, Math.min(8, Math.max(0, left) / Math.max(0.05, left + need - have)));
        try { if (Math.abs(el.playbackRate - rate) > 0.05) el.playbackRate = rate; } catch (e) { /* ignore */ }
      }, 50);
      return limit;
    }

    function setRate(el, r) { try { if (Math.abs(el.playbackRate - r) > 0.004) el.playbackRate = r; } catch (e) { /* ignore */ } }

    // ---- A weak connection: down to Saver by itself, and back to HQ once the data has flowed
    // steadily for 10 s. Both are Opus on the encoder's clock, so the new stream is lined up
    // with the one playing to the hundredth of a second and crossfaded in (as a skip lands):
    // no jump, no gap. (MP3, or a browser without that clock: a plain crossfade.)
    // Only while the listener has HQ chosen; picking Saver or HQ by hand turns it off.
    var weak = {
      low: startLow, stalls: [], last: 0, downAt: 0, upAt: 0, need: startLow ? 20000 : 10000, flaps: 0, op: null, jt: 0,
      busy: function () { return !wanted || connecting || held || !!rushTimer || !!weak.op || !audible(cur); },
      stalled: function (ms) {
        var now = Date.now();
        if (weak.busy() && !weak.low) return;
        weak.last = now;
        weak.stalls = weak.stalls.filter(function (t) { return now - t < 60000; }).concat([now]);
        if (!weak.low && prefer === "high" && quality === "high" && (ms >= 2000 || weak.stalls.length >= 2)) weak.down("stalls");
      },
      down: function (why) {
        if (weak.busy()) return;
        var now = Date.now();
        // (coming back down soon after going up: wait longer before trying again)
        if (weak.upAt && now - weak.upAt < 60000) weak.need = Math.min(120000, weak.need * 3);
        weak.low = true; weak.downAt = now; weak.stalls = [];
        retune(true);
        emit("autoq", { q: "saver", why: why });
      },
      tick: function () {
        var now = Date.now();
        if (!weak.low) { if (now - weak.upAt > 600000) weak.need = 10000; return; }
        if (prefer !== "high") { weak.low = false; return; }
        if (weak.busy() || now - Math.max(weak.last, weak.downAt) < weak.need) return;
        var net = navigator.connection;
        if (net && ((net.downlink && net.downlink < 0.35) || /(^|-)2g$/.test(net.effectiveType || ""))) return;
        weak.low = false; weak.upAt = now;
        retune(false);
        emit("autoq", { q: "high" });
      }
    };
    setInterval(weak.tick, 1000);
    if (navigator.connection && navigator.connection.addEventListener) {
      navigator.connection.addEventListener("change", function () {
        var net = navigator.connection;
        if (!weak.low && prefer === "high" && /(^|-)2g$/.test(net.effectiveType || "")) weak.down("network");
      });
    }
    // switch HQ <-> Saver keeping exactly the moment that's playing
    // (byHand: the listener tapped the chip; otherwise the weak-connection switch)
    function retune(small, byHand) {
      quality = small ? "saver" : "high";
      emit("quality", byHand ? { q: quality } : { q: quality, auto: true });
      if (!useOpus || !cur._ogg || !hasClock(cur) || !audible(cur)) { connect("quality"); return; }
      endFade();
      var op = nxt;
      if (op === cur) { connect("quality"); return; }
      setRate(cur, 1);
      release(op);
      op.preload = "auto"; op.muted = true; op.volume = 1;
      openStream(op, streamUrl());
      var my = gen, t0 = Date.now(), ok = 0;
      weak.op = op;
      var p = op.play();
      if (p && p.catch) p.catch(function () { if (weak.op === op) fail(); });
      function fail() { clearInterval(weak.jt); weak.jt = 0; weak.op = null; if (op !== cur) release(op); if (my === gen && wanted) connect("quality"); }
      function swap() {
        clearInterval(weak.jt); weak.jt = 0; weak.op = null;
        var old = cur;
        cur = op; nxt = old;
        var fade = canFade && audible(old);
        if (fade) op.volume = 0;
        op.muted = old.muted;
        if (fade) crossfade(old, op, QUALITY_FADE_MS); else release(old);
        var l = lag(op);
        if (l >= 0) bufDelay = l;
        hc.el = null;
        lastTime = 0; lastAdvance = Date.now(); lastBufEnd = 0; lastGrow = Date.now();
        if (lite()) liteWorked = true;
      }
      var seekAt = 0, seekCt = 0, hist = [];
      clearInterval(weak.jt);
      weak.jt = setInterval(function () {
        if (my !== gen || !wanted || weak.op !== op) { clearInterval(weak.jt); weak.jt = 0; if (weak.op === op) weak.op = null; if (op !== cur) release(op); return; }
        if (op.error || Date.now() - t0 > 15000) { fail(); return; }
        var hc0 = heardDue(cur), ho = heardDue(op);
        if (hc0 == null || ho == null || op.readyState < 2 || !hasClock(op)) return;
        var d = hc0 - ho;
        if (!onClock(op)) {
          // (Safari won't change speed: it's lined up by seeking instead. Ahead of the music, it
          // waits paused until the music gets there; then it jumps to the very moment that's
          // playing, within the burst it already has. Safari's playhead moves in steps of up
          // to 0.4 s and a reading is only ever late, so where each one really is: the latest
          // of the last second's readings)
          var nowS = Date.now() / 1000;
          hist.push([nowS, hc0 - nowS, ho - nowS]);
          while (nowS - hist[0][0] > 1) hist.shift();
          var mc = -1e9, mo = -1e9;
          hist.forEach(function (x) { mc = Math.max(mc, x[1]); mo = Math.max(mo, x[2]); });
          var to = mc + nowS - (srv.clock + srv.off + op._g0);         // (op's time for what's playing)
          function seekTo() {
            try { op.currentTime = to + seekLead; } catch (e) { fail(); return; }
            seekAt = Date.now(); hist = []; seekCt = op.currentTime;
            if (op.paused) { var ps = op.play(); if (ps && ps.catch) ps.catch(function () {}); }
          }
          if (Date.now() - seekAt < 1100) return;                       // (a second of readings after a seek)
          if (to < 0.05) {
            if (!op.paused) { op.pause(); t0 = Date.now() + (-to) * 1000; }
            return;
          }
          if (op.paused) { seekTo(); return; }
          if (nowS - hist[0][0] < 0.8 || op.currentTime < seekCt + 0.5) return;   // (or Safari's holding it: see SEEK_NEED)
          var dd = mc - mo;                                              // + : the new one is behind
          if (Math.abs(dd) <= 0.03 || ++ok > 4) { swap(); return; }    // (lined up, or as near as it gets)
          if (Math.abs(dd) < 0.3) seekLead = clamp(seekLead + dd, 0, 0.3);   // (Safari's own delay in a seek)
          seekTo();
          return;
        }
        // the new stream is ahead of what's playing (Saver runs further behind live than HQ's
        // burst reaches back): it waits, paused and muted, until the music gets there
        if (d < -0.6) {
          if (!op.paused) { op.pause(); t0 = Date.now() + (-d) * 1000; }
          return;
        }
        if (op.paused) { var pp = op.play(); if (pp && pp.catch) pp.catch(function () {}); return; }
        var near = 0.006;
        if (Math.abs(d) < near) {
          setRate(op, 1);
          if (++ok >= 6) swap();
          return;
        }
        ok = 0;
        setRate(op, clamp(1 + d * 2.5, 0.5, 4));
      }, 50);
    }

    function play() {
      if (wanted) {                    // interrupted by the phone: back on air
        if (interrupted && !connecting) connect("resume");
        return;
      }
      wanted = true;
      unlock();
      if (!navigator.onLine) { emit("state", "offline"); return; }
      connect("start");
    }

    function stop() {
      wanted = false;
      interrupted = 0; clearTimeout(intTimer);
      gen++;
      clearInterval(volTimer); volTimer = 0;
      starving = false;
      connecting = false;
      clearHold();
      if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; fadeEnd = null; }
      release(cur); release(nxt);
      stopKeep();
      emit("state", "idle");
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && wanted && !connecting && !audible(cur)) connect("resume");
    });
    window.addEventListener("online", function () { if (wanted && !connecting) connect("online"); emit("online"); });
    window.addEventListener("offline", function () { emit("offline"); });

    return {
      on: on,
      play: play,
      stop: stop,
      toggle: function () { if (wanted && !interrupted) stop(); else play(); },
      warm: warm,
      skip: function () { if (wanted && !CONFIG.CONTINUOUS_STREAM) connect("skip"); },
      rush: rush,
      // seconds that must be buffered here for the music to flow without stalling
      safeLag: function () { return safeLag(cur); },
      // what the server said about its streams (see srv), and its clock against ours: the
      // reply that came back fastest says it best (half its round trip is the most it's off)
      server: function (d, tSend, tRecv) {
        if (d.edge && typeof d.edge.mp3 === "number" && typeof d.edge.opus === "number") srv.edge = d.edge;
        srv.clock = typeof d.clock === "number" ? d.clock : null;
        if (typeof d.now !== "number" || !(tRecv >= tSend)) return;
        var rtt = tRecv - tSend, nowS = Date.now() / 1000;
        if (rtt <= srv.rtt + 0.03 || nowS - srv.at > 60) { srv.rtt = rtt; srv.at = nowS; srv.off = (tSend + tRecv) / 2 - d.now; }
      },
      toDevice: function (t) { return t + srv.off; },
      dbg: function () { var el = cur; return { lag: lag(el), safe: safeLag(el), onClock: onClock(el), ct0: el._ct0, ct: el.currentTime, edge0: el._edge0, burst: el._burst, srv: srv, delay: CONFIG.SERVER_DELAY_S, src: el.src, rate: el.playbackRate}; },
      isOn: function () { return wanted; },
      isPaused: function () { return !!interrupted || !audible(cur); },
      opus: function () { return useOpus; },
      // Seconds between a moment being due on the server and this listener hearing it:
      // this browser's buffer (smoothed, see the watchdog) less the stream's edge
      latency: function () { return bufDelay - edgeOf(cur); },
      // the moment this listener is hearing now, as a time on this device's clock (seconds)
      heardAt: heardAt,
      // the tuner: start the next stream quietly / swell it up / dip it under the static
      setSoft: function (on) { soft = !!on; },
      // silence the stream at once / bring it back (works on iPhone too, unlike volume)
      mute: function (on) { try { cur.muted = !!on; } catch (e) { /* ignore */ } },
      swell: function (ms) { if (audible(cur)) rampVol(cur, Math.min(cur.volume, 0.15), 1, ms); },
      duck: function (level, ms) { if (audible(cur)) rampVol(cur, cur.volume, level, ms); },
      quality: function () { return quality; },
      autoSaver: function () { return weak.low; },
      // Switch quality; while playing, the new stream crossfades in over the old one
      setQuality: function (q) {
        q = q === "saver" ? "saver" : "high";
        store.set("raadio.quality", q);
        prefer = q; weak.low = false;
        if (q === quality) { emit("quality", { q: q }); return; }
        liteWorked = false;
        // Playing: the same seamless switch the weak-connection one uses (the new stream is
        // lined up with this one and faded in under it), not a reconnect with a gap
        if (wanted && !connecting && !held && audible(cur)) {
          if (weak.op) { clearInterval(weak.jt); weak.jt = 0; if (weak.op !== cur) release(weak.op); weak.op = null; }
          retune(q === "saver", true);
          return;
        }
        quality = q;
        emit("quality", { q: q });
        if (wanted) connect("quality");
      }
    };
  })();
  window.raadioStream = { dbg: engine.dbg };   // (what the player knows about the stream, for checking)

  /* ---------------- Tuning sound ----------------
     While the player waits for the stream (first press, a reconnect, or right after a
     skip) it sounds like an old AM/FM set being tuned across the band: loud, bright
     static that surges and crackles; a whistle that swoops down and back up each time
     the dial crosses a station; and, right at the bottom of the swoop, a fragment of that
     station (a voice or a few notes of music) bursting through for a moment before the
     dial moves on. When our music arrives the dial lands on it: one last swoop down to
     silence, the static drops away and the music swells up underneath.
     Each song has its own tuning: everything that's left to chance (the colour of the
     static, where the whistle swoops, how fast the dial turns, which stations break
     through, the chord or voice they carry, the crackle) is drawn from that song's own
     number, so tuning in to a song always sounds the same, and different from any other.
     All made live with Web Audio (no sound files to download). */
  var tuning = (function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = null, out = null, nodes = null, on = false;
    var mergeTimer = 0, dialTimer = 0, surgeTimer = 0, offTimer = 0;
    var LEVEL = 0.36;              // overall level (the output trim below sets how it sits against the music)

    // ---- the song's own tuning ----
    var songNow = null, songNext = null;       // keys of the song playing and the one after it
    var rnd = Math.random, V = null;
    function hash(str) {                       // (FNV-1a, 32 bit)
      var h = 2166136261;
      for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }
    function seeded(seed) {                    // (mulberry32: small, fast, good enough for sound)
      return function () {
        seed = (seed + 0x6D2B79F5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    // a song's voice: one draw of every setting the dial uses (no song: chance, as before)
    var SCALE = [0, 2, 4, 7, 9];               // the stations' chords sit on a pentatonic scale
    function voiceFor(key) {
      rnd = key ? seeded(hash(String(key))) : Math.random;
      var r = rnd, root = 164.8 * Math.pow(2, SCALE[Math.floor(r() * 5)] / 12 + Math.floor(r() * 2));
      var minor = r() < 0.45, third = minor ? 3 : 4, fifth = r() < 0.2 ? 6 : 7;
      V = {
        tone: 900 + r() * 2800,                // the colour of the static
        toneQ: 0.5 + r() * 1.8,
        toneSpan: 1200 + r() * 2600,           // how far that colour wanders per turn of the dial
        hiss: 0.42 + r() * 0.22,
        whHi: 900 + r() * 1600, whSpan: 900 + r() * 2400,   // the whistle's top
        whLo: 30 + r() * 70,                   // ...and how low it swoops
        speed: 0.65 + r() * 0.9,               // how fast the dial turns (seconds a station)
        stations: 0.35 + r() * 0.5,            // how often a station breaks through
        talk: 0.2 + r() * 0.65,                // how many of them are voices (the rest music)
        pitch: 95 + r() * 140,                 // the voice
        chord: [root, root * Math.pow(2, third / 12), root * Math.pow(2, fifth / 12)],
        wave: ["triangle", "sine", "square"][Math.floor(r() * 3)],
        crackle: 0.08 + r() * 0.35,
        land: 0.85 + r() * 0.4                 // how slowly the dial settles on the song
      };
    }
    voiceFor(null);

    function context() {
      if (!AC) return null;
      if (!ctx) {
        try { ctx = new AC(); } catch (e) { AC = null; return null; }
        // a small, slightly overdriven radio speaker, then a limiter so nothing clips
        var drive = ctx.createWaveShaper(); drive.curve = shaper(1.6); drive.oversample = "2x";
        var speakerLo = ctx.createBiquadFilter(); speakerLo.type = "highpass"; speakerLo.frequency.value = 200;
        var speakerHi = ctx.createBiquadFilter(); speakerHi.type = "lowpass"; speakerHi.frequency.value = 5200; speakerHi.Q.value = 0.9;
        var speakerHi2 = ctx.createBiquadFilter(); speakerHi2.type = "lowpass"; speakerHi2.frequency.value = 7000;
        var limit = ctx.createDynamicsCompressor();
        limit.threshold.value = -9; limit.knee.value = 6; limit.ratio.value = 6; limit.attack.value = 0.003; limit.release.value = 0.15;
        out = ctx.createGain(); out.gain.value = 0;
        out.connect(drive); drive.connect(speakerLo); speakerLo.connect(speakerHi); speakerHi.connect(speakerHi2); speakerHi2.connect(limit);
        var trim = ctx.createGain(); trim.gain.value = 0.2;    // well under the music (noise sounds louder than it measures)
        limit.connect(trim); trim.connect(ctx.destination);
      }
      if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) { /* ignore */ } }
      return ctx;
    }
    function shaper(k) {
      var n = 1024, c = new Float32Array(n);
      for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
      return c;
    }
    var noiseBuf = null;
    function noise(c) {
      if (noiseBuf) return noiseBuf;
      var len = c.sampleRate * 3, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        var v = Math.random() * 2 - 1;
        if (Math.random() < 0.0009) v = (Math.random() < 0.5 ? -1 : 1);   // pops and ticks in the hiss
        d[i] = v;
      }
      return (noiseBuf = buf);
    }

    function build(c) {
      var t = c.currentTime, n = { all: [] };
      function keep(x) { n.all.push(x); return x; }
      // static: bright hiss whose band and level surge as the dial moves
      n.src = keep(c.createBufferSource()); n.src.buffer = noise(c); n.src.loop = true;
      n.tone = keep(c.createBiquadFilter()); n.tone.type = "peaking"; n.tone.frequency.value = V.tone; n.tone.Q.value = V.toneQ; n.tone.gain.value = 4;
      n.hiss = keep(c.createGain()); n.hiss.gain.value = V.hiss;
      n.src.connect(n.tone); n.tone.connect(n.hiss); n.hiss.connect(out);
      // the whistle: a carrier beating against the set's own oscillator
      n.wh = keep(c.createOscillator()); n.wh.type = "sine"; n.wh.frequency.value = 2000;
      n.whg = keep(c.createGain()); n.whg.gain.value = 0;
      n.wh.connect(n.whg); n.whg.connect(out);
      // a station's voice: a buzzing throat through two mouth shapes, chopped into syllables
      n.vox = keep(c.createOscillator()); n.vox.type = "sawtooth"; n.vox.frequency.value = 140;
      n.f1 = keep(c.createBiquadFilter()); n.f1.type = "bandpass"; n.f1.frequency.value = 650; n.f1.Q.value = 5;
      n.f2 = keep(c.createBiquadFilter()); n.f2.type = "bandpass"; n.f2.frequency.value = 1500; n.f2.Q.value = 7;
      n.syl = keep(c.createGain()); n.syl.gain.value = 0;
      n.vox.connect(n.f1); n.vox.connect(n.f2); n.f1.connect(n.syl); n.f2.connect(n.syl);
      // a station's music: a few notes of a chord, wobbling
      n.mus = [0, 1, 2].map(function () { var o = keep(c.createOscillator()); o.type = V.wave; o.frequency.value = 220; return o; });
      n.musg = keep(c.createGain()); n.musg.gain.value = 0;
      n.mus.forEach(function (o) { o.connect(n.musg); });
      n.st = keep(c.createGain()); n.st.gain.value = 0;      // whatever station is coming through
      n.syl.connect(n.st); n.musg.connect(n.st); n.st.connect(out);
      [n.src, n.wh, n.vox].concat(n.mus).forEach(function (s) { s.start(t); });
      return n;
    }

    function setNow(p, v, t) { p.cancelScheduledValues(t); p.setValueAtTime(v, t); }

    // one turn of the dial past a station: the whistle swoops down to nothing and back up;
    // at the bottom, sometimes, the station bursts through and the static dips
    function dial() {
      if (!on || !nodes) return;
      var c = ctx, t = c.currentTime, n = nodes;
      var d = V.speed * (0.5 + rnd() * 0.9), mid = t + d * (0.4 + rnd() * 0.2);
      var hi1 = V.whHi + rnd() * V.whSpan, hi2 = V.whHi + rnd() * V.whSpan;
      setNow(n.wh.frequency, hi1, t);
      n.wh.frequency.exponentialRampToValueAtTime(V.whLo * (0.8 + rnd() * 0.4), mid);
      n.wh.frequency.exponentialRampToValueAtTime(hi2, t + d);
      var wl = 0.16 + rnd() * 0.16;
      setNow(n.whg.gain, n.whg.gain.value, t);
      n.whg.gain.linearRampToValueAtTime(wl, t + d * 0.25);
      n.whg.gain.linearRampToValueAtTime(wl * 0.4, mid);
      n.whg.gain.linearRampToValueAtTime(wl, t + d * 0.85);
      n.whg.gain.linearRampToValueAtTime(0.01, t + d);
      setNow(n.tone.frequency, n.tone.frequency.value, t);
      n.tone.frequency.linearRampToValueAtTime(Math.max(300, V.tone - V.toneSpan / 2 + rnd() * V.toneSpan), t + d);
      if (rnd() < V.stations) station(mid, 0.18 + rnd() * 0.45);
      dialTimer = setTimeout(dial, d * 1000);
    }
    function station(at, len) {
      var n = nodes, level = 0.75 + rnd() * 0.35;
      setNow(n.st.gain, 0, at);
      n.st.gain.linearRampToValueAtTime(level, at + 0.04);
      n.st.gain.setValueAtTime(level, at + len);
      n.st.gain.linearRampToValueAtTime(0, at + len + 0.08);
      setNow(n.hiss.gain, n.hiss.gain.value, at);                // the station pushes the static down
      n.hiss.gain.linearRampToValueAtTime(0.14, at + 0.04);
      n.hiss.gain.setValueAtTime(0.14, at + len);
      n.hiss.gain.linearRampToValueAtTime(V.hiss, at + len + 0.1);
      if (rnd() < V.talk) {                                     // someone talking
        setNow(n.musg.gain, 0, at);
        var p = V.pitch * (0.85 + rnd() * 0.3);
        setNow(n.vox.frequency, p, at);
        n.vox.frequency.linearRampToValueAtTime(p * (0.85 + rnd() * 0.3), at + len);
        for (var s = at; s < at + len; s += 0.09 + rnd() * 0.1) {
          n.f1.frequency.setValueAtTime(350 + rnd() * 500, s);
          n.f2.frequency.setValueAtTime(900 + rnd() * 1500, s);
          n.syl.gain.setValueAtTime(0.25, s);
          n.syl.gain.linearRampToValueAtTime(0.9, s + 0.025);
          n.syl.gain.linearRampToValueAtTime(0.15, s + 0.08);
        }
        n.syl.gain.setValueAtTime(0, at + len + 0.08);
      } else {                                                  // a few notes of music
        setNow(n.syl.gain, 0, at);
        var up = rnd() < 0.5 ? 1 : 2, gain = V.wave === "square" ? 0.12 : 0.3;   // (a square wave is far louder)
        n.mus.forEach(function (o, i) { setNow(o.frequency, V.chord[i] * up, at); });
        setNow(n.musg.gain, gain, at);
        for (var w = at; w < at + len; w += 0.07) n.musg.gain.setValueAtTime(gain * (0.66 + rnd() * 0.5), w);
        n.musg.gain.setValueAtTime(0, at + len + 0.08);
      }
    }
    // the static never holds still: it surges and fades, and crackles now and then
    function surge() {
      if (!on || !nodes) return;
      var t = ctx.currentTime, g = nodes.hiss.gain;
      if (rnd() < V.crackle) {                                  // a crackle burst
        for (var i = 0; i < 4; i++) g.setValueAtTime(0.3 + rnd() * 0.6, t + i * 0.012);
      }
      g.setTargetAtTime(V.hiss * (0.7 + rnd() * 0.6), t + 0.05, 0.05);
      surgeTimer = setTimeout(surge, 50 + rnd() * 160);
    }
    function teardown() {
      clearTimeout(dialTimer); clearTimeout(surgeTimer);
      if (!nodes) return;
      var n = nodes; nodes = null;
      n.all.forEach(function (x) { try { if (x.stop) x.stop(); } catch (e) { /* ignore */ } try { x.disconnect(); } catch (e) { /* ignore */ } });
    }

    // start (or keep) the tuning sound; level: how loud (1 = normal). (A skip's landing stays
    // booked: a hiccup during the fast-forward used to cancel it, and the music came back
    // too soon, the old song's tail at eight times speed.)
    var quiet = false;               // the saved recording is playing (keeper): no static over it
    function start(level, toward) {
      if (quiet) return;
      clearTimeout(offTimer); offTimer = 0;
      var c = context();
      if (!c) return;
      engine.setSoft(true);
      var t = c.currentTime;
      setNow(out.gain, out.gain.value, t);
      out.gain.linearRampToValueAtTime(LEVEL * (level || 1), t + 0.12);
      if (on && nodes) return;
      on = true;
      // tuned to the song it's going to land on: the next one after a skip, else this one
      voiceFor(toward || songNow);
      if (nodes) teardown();         // (still fading out from the last song's tuning: start fresh)
      nodes = build(c);
      dial();
      surge();
    }
    // the music has arrived: land on it
    function merge(ms) {
      if (!on || !nodes) { engine.setSoft(false); return; }
      ms = Math.round((ms || 1400) * V.land);
      var t = ctx.currentTime, s = ms / 1000, n = nodes;
      clearTimeout(dialTimer); clearTimeout(surgeTimer);
      setNow(n.wh.frequency, n.wh.frequency.value, t);
      n.wh.frequency.exponentialRampToValueAtTime(30, t + s * 0.45);   // the whistle drops to zero beat
      setNow(n.whg.gain, n.whg.gain.value, t);
      n.whg.gain.linearRampToValueAtTime(0, t + s * 0.5);
      setNow(n.st.gain, 0, t);
      setNow(out.gain, out.gain.value, t);
      out.gain.setValueAtTime(out.gain.value, t + s * 0.2);
      out.gain.linearRampToValueAtTime(0, t + s * 0.75);               // the static drops away
      engine.mute(false);
      engine.swell(ms);
      engine.setSoft(false);
      on = false;
      offTimer = setTimeout(teardown, ms + 500);
    }
    function stop() {
      clearTimeout(mergeTimer); mergeTimer = 0;
      engine.setSoft(false);
      engine.mute(false);
      if (!ctx || !nodes) { on = false; return; }
      var t = ctx.currentTime;
      setNow(out.gain, out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + 0.12);
      on = false;
      clearTimeout(offTimer);
      offTimer = setTimeout(teardown, 300);
    }
    // a skip went through: tune away from the old song right now, and land on the next one
    // the moment it reaches this speaker (in `sec` seconds)
    function skip(sec) {
      start(1, songNext || (songNow ? songNow + " next" : null));
      engine.mute(true);                     // the old song's tail is gone right away
      clearTimeout(mergeTimer);
      // a fallback, in case the new song's start time never arrives (lockIn sets the real one)
      mergeTimer = setTimeout(function () { mergeTimer = 0; merge(1300); }, Math.max(0.6, sec) * 1000);
    }
    // the vote didn't skip after all: straight back to the song
    function cancelSkip() {
      if (!mergeTimer) return;
      clearTimeout(mergeTimer); mergeTimer = 0;
      merge(500);
    }
    // the new song reaches this speaker in `sec` seconds: land on it then
    function lockIn(sec) {
      if (!mergeTimer) return;
      clearTimeout(mergeTimer);
      mergeTimer = setTimeout(function () { mergeTimer = 0; merge(1300); }, Math.max(0, sec) * 1000);
    }

    // the music stops reaching us for a moment (slow or dropped connection): tune around
    // instead of going silent, and land back on it when it flows again
    engine.on("stall", function () { start(0.9); });
    engine.on("flow", function () { if (!mergeTimer) merge(900); });
    engine.on("state", function (st) {
      if (st === "connecting") start();
      else if (st === "live") { if (!mergeTimer) merge(); }
      else if (st === "idle" || st === "offline" || st === "paused") stop();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && ctx && !on && !nodes) { try { ctx.suspend(); } catch (e) { /* ignore */ } }
    });
    return { start: start, merge: merge, stop: stop, skip: skip, lockIn: lockIn, cancelSkip: cancelSkip,
             // which song is playing and which comes next (from /now-playing), to tune to
             songs: function (now, next) { songNow = now || null; songNext = next || null; },
             quiet: function (on) { quiet = !!on; if (on) { clearTimeout(mergeTimer); mergeTimer = 0; stop(); } } };
  })();


  /* ---------------- Front-face UI ---------------- */
  var ui = {
    player: $("player"),
    status: $("status"),
    onair: $("onair"),
    playBtn: $("play-btn"),
    playIcon: $("play-icon"),
    skipBtn: $("skip-btn"),
    badge: $("vote-badge"),
    songCard: $("song-card"),
    songName: $("song-name"),
    artistName: $("artist-name")
  };
  var state = "idle";

  function setStatus(text) { setText(ui.status, text); }

  function setState(next) {
    state = next;
    ui.player.classList.toggle("is-live", next === "live");
    ui.player.classList.toggle("is-connecting", next === "connecting");
    setText(ui.onair, next === "live" ? "On air" : next === "connecting" ? "Tuning" : next === "offline" ? "Offline" : next === "paused" ? "Paused" : "Off air");
    var playing = next === "live" || next === "connecting";
    // every layer of the metal icon (base, scratches, shine) switches together
    Array.prototype.forEach.call(ui.playBtn.querySelectorAll("use"), function (u) {
      u.setAttribute("href", playing ? "#i-pause" : "#i-play");
    });
    ui.playBtn.setAttribute("aria-label", playing ? "Stop" : "Play");
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (e) { /* ignore */ }
    }
    wave.setLive(next === "live");
  }

  engine.on("state", function (s) {
    setState(s);
    if (s === "live") setStatus(hosts.isRelay() ? "Playing live via relay" : "Playing live");
    else if (s === "connecting") setStatus("Tuning in…");
    else if (s === "offline") setStatus("Offline — music resumes when you reconnect");
    else if (s === "idle") setStatus("Ready to play");
    else if (s === "paused") setStatus("Paused by your phone — back when you return");
  });
  engine.on("connecting", function (reason) {
    if (reason === "skip") setStatus("Skipping…");
    else if (reason === "start") setStatus("Tuning in…");
    if (reason === "source-closed") log.add("warn", "Stream ended on its own, reconnected");
    else if (reason !== "start" && reason !== "skip" && reason !== "quality") log.add("warn", "Reconnecting (" + reason + ")");
  });
  // every drop-out goes in the studio's log strip, with how long the sound was gone, so a
  // cut-off can be matched to its cause (the connection, or the stream itself)
  (function () {
    var since = 0;
    engine.on("stall", function () { since = Date.now(); });
    engine.on("flow", function () {
      if (!since) return;
      var sec = (Date.now() - since) / 1000 + 0.7;   // (a stall is noticed 0.7 s in)
      since = 0;
      if (sec >= 1.2) log.add("warn", "Sound dropped for " + sec.toFixed(1) + " s (" + (navigator.onLine ? "data stopped arriving" : "offline") + ")");
    });
  })();
  engine.on("retry", function (r) {
    if (r.n >= 4 && state !== "live") setStatus(r.reason === "start" || r.reason === "online" || r.reason === "resume" ? "Still connecting…" : "Waiting for the next track…");
    if (r.n === 6) log.add("warn", "Stream not answering yet, still trying");
  });
  engine.on("host", function (h) { setStatus("Trying another route…"); log.add("warn", "Switched to " + hosts.label(h)); });
  engine.on("track", function () { resetVote(); log.add("ok", "Connected via " + hosts.label()); });
  engine.on("codec", function (c) {
    log.add(c === "opus" ? "ok" : "warn", c === "opus" ? "Opus stream" : "Opus not supported here, using MP3");
    showQuality();
  });

  /* ---------------- Quality chip: HQ / Saver ---------------- */
  var qualityBtn = $("quality-btn");
  function showQuality() {
    if (!qualityBtn) return;
    var saver = engine.quality() === "saver";
    var mb = engine.opus() ? { hq: 29, saver: 14 } : { hq: 58, saver: 29 };   // per hour
    setText(qualityBtn, saver ? "Saver" : "HQ");
    qualityBtn.setAttribute("aria-pressed", saver ? "false" : "true");
    qualityBtn.title = saver
      ? "Data saver: ~" + mb.saver + " MB an hour. Tap for high quality."
      : "High quality: ~" + mb.hq + " MB an hour. Tap to save data.";
    if (engine.autoSaver()) qualityBtn.title = "Weak connection: data saver for now. Back to high quality once it's steady.";
    qualityBtn.classList.toggle("is-auto", engine.autoSaver());
    qualityBtn.setAttribute("aria-label", qualityBtn.title);
  }
  if (qualityBtn) {
    qualityBtn.addEventListener("click", function () {
      engine.setQuality(engine.quality() === "saver" ? "high" : "saver");
    });
    showQuality();
  }
  engine.on("autoq", function (r) {
    showQuality();
    if (r.q === "saver") { log.add("warn", "Weak connection: switched to data saver"); setStatus("Weak connection: data saver"); }
    else { log.add("ok", "Connection steady: back to high quality"); setStatus("Back to high quality"); }
  });
  engine.on("quality", function (r) {
    showQuality();
    if (r.auto) return;
    if (r.fallback) log.add("warn", "Data saver stream not available here, using HQ");
    else {
      log.add("ok", r.q === "saver" ? "Data saver on" : "High quality on");
      if (engine.isOn()) setStatus(r.q === "saver" ? "Data saver on" : "High quality on");
    }
  });
  engine.on("blocked", function () { setStatus("Tap play to resume"); });
  engine.on("offline", function () { log.add("error", "Device went offline"); if (!engine.isOn()) setStatus("Offline"); });
  engine.on("online", function () { log.add("ok", "Back online"); if (!engine.isOn()) setStatus("Ready to play"); });

  /* ---------------- Keep the stream for later ----------------
     Hold Play for 3 seconds while it's playing: a second connection saves the stream on this
     device (IndexedDB), in one-minute pieces that are each a complete .opus file (.mp3 where
     Opus doesn't play), the last 3 hours of it. A pulsing arrow by the Play button shows it's
     saving; hold again to stop. If the live stream stops reaching this device, the radio plays
     on from what it saved (no static over it), and goes back to live by itself, with a
     crossfade, once the connection returns. */
  var keeper = (function () {
    var DB = "raadio-keep", STORE = "pieces", KEEP_S = 3 * 3600, PIECE_S = 60;
    var db = null, on = false, ctl = null, retry = 0, piece = null, heads = null, ogg = true;
    var tape = null, tapeOn = false, tapeAt = 0, deadSince = 0, ate = false, holdT = 0;
    var badge = document.createElement("span");
    badge.className = "rec-badge"; badge.hidden = true; badge.setAttribute("aria-hidden", "true");
    badge.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v11m-5-5 5 5 5-5M5 19h14"/></svg>';
    var ring = document.createElement("span");
    ring.className = "hold-ring"; ring.setAttribute("aria-hidden", "true");
    ui.playBtn.appendChild(ring);
    ui.playBtn.appendChild(badge);

    // the display shows it beside On air: "Saving" while it saves, "Tape" while it plays the
    // saved stream because the live one stopped reaching this device
    function keepChip(text) { var c = $("keep-chip"); setText(c, text); c.hidden = !text; c.classList.toggle("is-tape", text === "Tape"); }
    function open() {
      if (db) return Promise.resolve(db);
      return new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error("No storage here")); return; }
        var r = indexedDB.open(DB, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: "at" }); };
        r.onsuccess = function () { db = r.result; res(db); };
        r.onerror = function () { rej(r.error || new Error("Storage refused")); };
      });
    }
    function tx(mode, fn) {
      return open().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(STORE, mode), st = t.objectStore(STORE), out = fn(st);
          t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
          t.onerror = t.onabort = function () { rej(t.error || new Error("Storage error")); };
        });
      });
    }
    function list() { return tx("readonly", function (st) { return st.getAll(); }); }
    function save(p) {
      if (!p || !p.chunks.length || p.secs < 5) return Promise.resolve();
      var blob = new Blob((ogg ? heads : []).concat(p.chunks), { type: ogg ? "audio/ogg" : "audio/mpeg" });
      var rec = { at: p.at, secs: p.secs, ext: ogg ? "opus" : "mp3", blob: blob };
      return tx("readwrite", function (st) {
        st.put(rec);
        // the last 3 hours only
        var cut = Date.now() / 1000 - KEEP_S;
        st.openCursor().onsuccess = function (e) { var c = e.target.result; if (c && c.key < cut) { c.delete(); c.continue(); } };
      }).catch(function (e) { log.add("warn", "Couldn't save part of the stream: " + e.message); });
    }
    // what came in, split into pieces: Ogg pages (the first two are the headers every piece
    // starts with), or MP3 bytes
    var spill = new Uint8Array(0);
    function take(bytes) {
      if (!piece) piece = { at: Date.now() / 1000, chunks: [], secs: 0, g0: null, bytes: 0 };
      if (!ogg) {
        piece.chunks.push(bytes); piece.bytes += bytes.length;
        piece.secs = piece.bytes / (engine.quality() === "saver" ? 8000 : 16000);
      } else {
        var b = new Uint8Array(spill.length + bytes.length);
        b.set(spill); b.set(bytes, spill.length);
        var i = 0;
        while (i + 27 <= b.length) {
          if (b[i] !== 79 || b[i + 1] !== 103 || b[i + 2] !== 103 || b[i + 3] !== 83) { i++; continue; }   // "OggS"
          var n = b[i + 26];
          if (i + 27 + n > b.length) break;
          var len = 27 + n;
          for (var k = 0; k < n; k++) len += b[i + 27 + k];
          if (i + len > b.length) break;
          var page = b.slice(i, i + len);
          var g = 0;
          for (var j = 7; j >= 0; j--) g = g * 256 + page[6 + j];
          if (heads.length < 2) heads.push(page);
          else {
            if (piece.g0 == null) piece.g0 = g;
            piece.chunks.push(page);
            piece.secs = Math.max(0, (g - piece.g0) / 48000);
          }
          i += len;
        }
        spill = b.slice(i);
      }
      if (piece.secs >= PIECE_S) { var p = piece; piece = null; save(p); }
    }
    function connect() {
      if (!on) return;
      var opus = engine.opus(), small = engine.quality() === "saver";
      ogg = opus; heads = []; spill = new Uint8Array(0); piece = null;
      var url = hosts.current() + (opus ? (small ? CONFIG.STREAM_OPUS_LITE : CONFIG.STREAM_OPUS) : (small ? CONFIG.STREAM_MP3_LITE : CONFIG.STREAM_MP3)) + "?keep=1&t=" + Date.now();
      ctl = "AbortController" in window ? new AbortController() : null;
      fetch(url, { cache: "no-store", signal: ctl ? ctl.signal : undefined }).then(function (r) {
        if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
        var rd = r.body.getReader();
        return (function read() {
          return rd.read().then(function (x) { if (x.done || !on) return; take(x.value); return read(); });
        })();
      }).catch(function () { /* the connection dropped: try again below */ }).then(function () {
        if (piece) { var p = piece; piece = null; save(p); }
        if (on) retry = setTimeout(connect, 5000);
      });
    }
    function start() {
      if (on) return;
      open().then(function () {
        on = true; badge.hidden = false;
        ui.playBtn.classList.add("is-keeping");
        keepChip("Saving");
        setStatus("Saving the stream on this device");
        log.add("ok", "Saving the stream on this device (the last 3 hours)");
        connect();
      }).catch(function (e) { setStatus("Can't save here: " + e.message); });
    }
    function stop() {
      if (!on) return;
      on = false; badge.hidden = true;
      ui.playBtn.classList.remove("is-keeping");
      keepChip(tapeOn ? "Tape" : "");
      clearTimeout(retry);
      try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ }
      setStatus("Stopped saving");
      list().then(function (all) {
        var mins = Math.round(all.reduce(function (a, p) { return a + p.secs; }, 0) / 60);
        log.add("ok", "Stopped saving. " + mins + " min kept on this device.");
      }).catch(function () {});
    }

    // ---- hold Play for 3 s ----
    ui.playBtn.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || !engine.isOn() || engine.isPaused()) return;
      clearTimeout(holdT);
      ui.playBtn.classList.add("is-holding");
      holdT = setTimeout(function () {
        holdT = 0; ate = true;
        ui.playBtn.classList.remove("is-holding");
        if (navigator.vibrate) { try { navigator.vibrate(30); } catch (x) { /* ignore */ } }
        if (on) stop(); else start();
      }, 3000);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (n) {
      ui.playBtn.addEventListener(n, function () { clearTimeout(holdT); holdT = 0; ui.playBtn.classList.remove("is-holding"); });
    });
    ui.playBtn.addEventListener("contextmenu", function (e) { if (engine.isOn()) e.preventDefault(); });

    // ---- the connection dropped: play what was saved ----
    function playTape() {
      if (tapeOn) return;
      list().then(function (all) {
        all = all.filter(function (p) { return p.blob && p.blob.size; });
        if (!all.length || tapeOn || !engine.isOn()) return;
        all.sort(function (a, b) { return a.at - b.at; });
        tapeOn = true;
        tuning.quiet(true);
        keepChip("Tape");
        tape = tape || new Audio();
        log.add("warn", "No connection: playing what was saved on this device");
        setStatus("Offline: playing the saved stream");
        var i = Math.max(0, all.findIndex(function (p) { return p.at >= tapeAt; }));
        (function next() {
          if (!tapeOn) return;
          if (i >= all.length) i = 0;                            // (round again)
          var p = all[i++];
          tapeAt = p.at + 1;
          var url = URL.createObjectURL(p.blob);
          tape.src = url; tape.volume = 1;
          tape.onended = function () { URL.revokeObjectURL(url); next(); };
          tape.onerror = function () { URL.revokeObjectURL(url); setTimeout(next, 200); };
          var pr = tape.play();
          if (pr && pr.catch) pr.catch(function () { /* the phone said no: the live retry carries on */ });
        })();
      }).catch(function () {});
    }
    function stopTape() {
      if (!tapeOn) return;
      tapeOn = false;
      keepChip(on ? "Saving" : "");
      tuning.quiet(false);
      var t = tape, s0 = performance.now();
      (function fade() {                                     // fade out under the live stream
        var k = Math.min(1, (performance.now() - s0) / 1200);
        try { t.volume = 1 - k; } catch (e) { /* iPhone: no volume */ }
        if (k < 1) requestAnimationFrame(fade); else { t.pause(); t.removeAttribute("src"); try { t.load(); } catch (e) { /* ignore */ } }
      })();
      log.add("ok", "Back to live");
      setStatus("Back to live");
    }
    // nothing heard from live for 4 s (stalled, reconnecting or offline) while there's
    // something saved: the tape. Live flowing again: back to it.
    engine.on("stall", function () { if (!deadSince) deadSince = Date.now(); });
    engine.on("connecting", function () { if (!deadSince) deadSince = Date.now(); });
    engine.on("offline", function () { if (!deadSince) deadSince = Date.now(); });
    engine.on("flow", function () { deadSince = 0; if (tapeOn) stopTape(); });
    engine.on("state", function (st) {
      if (st === "live") { deadSince = 0; if (tapeOn) stopTape(); }
      else if (st === "idle") { deadSince = 0; if (tapeOn) { tapeOn = false; tuning.quiet(false); tape.pause(); keepChip(on ? "Saving" : ""); } }
    });
    setInterval(function () {
      if (deadSince && !tapeOn && engine.isOn() && Date.now() - deadSince > 4000) playTape();
    }, 1000);

    return {
      ateClick: function () { var a = ate; ate = false; return a; },
      isOn: function () { return on; },
      pieces: list,
      playTape: playTape,
      stopTape: stopTape
    };
  })();


  ui.playBtn.addEventListener("click", function () { if (keeper.ateClick()) return; engine.toggle(); });
  ui.playBtn.addEventListener("pointerdown", function (e) {
    if (e.button === 0 && !engine.isOn()) engine.warm();
  });

  /* ---------------- Skip voting ---------------- */
  var voting = false;
  var voted = false;

  var voteTimer = 0;
  var nowPlaying = { poll: function () {} };
  var skipping = 0;                      // a skip we caused, until the new song's start is known
  var voteState = { votes: 0, needed: 2 };   // from the last now-playing
  var nextUp = null;                         // the song lined up next, once the server has it

  function resetVote() {
    voted = false;
    clearTimeout(voteTimer);
    ui.skipBtn.setAttribute("aria-pressed", "false");
    ui.badge.hidden = true;
  }

  function markVoted(message) {
    voted = true;
    ui.skipBtn.setAttribute("aria-pressed", "true");
    var m = /(\d+)\s*\/\s*(\d+)/.exec(message || "");
    if (m) { setText(ui.badge, m[1] + "/" + m[2]); ui.badge.hidden = false; }
    // votes expire on the server too, so free the button again after the window
    clearTimeout(voteTimer);
    voteTimer = setTimeout(resetVote, CONFIG.VOTE_WINDOW_MS);
  }

  // A random id for this browser, so two devices on the same Wi-Fi count as two voters
  // (the server still allows only a few per internet address)
  function deviceId() {
    var id = store.get("raadio.device", null);
    if (!id || !/^[a-z0-9]{8,32}$/.test(id)) {
      id = "";
      var abc = "abcdefghijklmnopqrstuvwxyz0123456789";
      var rnd = window.crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(16)) : null;
      for (var i = 0; i < 16; i++) id += abc[(rnd ? rnd[i] : Math.floor(Math.random() * 256)) % abc.length];
      store.set("raadio.device", id);
    }
    return id;
  }

  function postJSON(url, ms, headers, body) {
    if (CONFIG.READ_ONLY) return Promise.resolve({ status: "error", message: "Voting and notes are off in this demo" });
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, { method: "POST", cache: "no-store", headers: headers || {}, body: body, signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        clearTimeout(t);
        return res.json().catch(function () { return { status: "error", message: "Unexpected reply (" + res.status + ")" }; });
      }, function (err) { clearTimeout(t); throw err; });
  }

  function voteSkip(source) {
    if (voting) return;
    if (!engine.isOn()) { setStatus("Press play to vote"); return; }
    if (voted) { setStatus("You voted — waiting for one more listener"); return; }
    voting = true;
    // answer the tap at once; the server's reply follows in a moment
    ui.skipBtn.classList.add("is-busy");
    ui.skipBtn.setAttribute("aria-pressed", "true");
    setStatus("Vote sent…");
    // This vote will surely skip (alone on the station, or the last one needed): tune away
    // from the old song on the tap itself instead of after the server's answer
    var myWeight = 1;
    var sure = CONFIG.CONTINUOUS_STREAM && voteState.votes + myWeight >= voteState.needed;
    if (sure) { tuning.skip(engine.latency() + 2.5); }

    var order = [hosts.current()].concat(hosts.others());
    var i = 0;
    function tryNext() {
      var host = order[i++];
      // signed in to the studio? send it along (only over HTTPS): some users' votes count double
      var auth = session && session.token && /^https:/i.test(host) ? { Authorization: "Bearer " + session.token } : null;
      return postJSON(host + CONFIG.SKIP_PATH + "?d=" + encodeURIComponent(deviceId()), 4000, auth).catch(function (err) {
        if (i < order.length && navigator.onLine) return tryNext();
        throw err;
      });
    }

    tryNext().then(function (data) {
      setStatus(data.message || "Vote sent");
      if (!data.skipped && sure) { tuning.cancelSkip(); }   // it didn't go through after all
      if (data.skipped) {
        resetVote();
        engine.skip();
        log.add("ok", "Track skipped by listeners");
        if (CONFIG.CONTINUOUS_STREAM) {
          // The server has moved on, but this speaker is still a few seconds behind it.
          // Don't make the listener sit through the old song's tail: dip it under the
          // tuning sound now, and lock on to the next song the moment it arrives here.
          var lag = engine.latency() + 1.8;      // fallback only: the real moment comes from the server
          if (!sure) { tuning.skip(lag); }
          setStatus("Skipping — tuning in…");
          // ask for the new song's exact start time straight away (and a few more times)
          skipping = Date.now();
          [300, 900, 1600, 2600, 4000].forEach(function (ms) { setTimeout(function () { if (skipping) nowPlaying.poll(); }, ms); });
          setTimeout(function () { skipping = 0; }, 6000);
        }
      }
      else if (data.status === "success" || data.status === "ignored") markVoted(data.message);
      else resetVote();
    }).catch(function () {
      resetVote();
      if (sure) { tuning.cancelSkip(); }
      setStatus(navigator.onLine ? "Skip server unreachable" : "You're offline");
      log.add("error", "Skip vote failed" + (source ? " (" + source + ")" : ""));
    }).then(function () {
      voting = false;
      ui.skipBtn.classList.remove("is-busy");
    });
  }

  ui.skipBtn.addEventListener("click", function () { voteSkip("button"); });

  // Swipe left anywhere on the radio face = next track
  (function setupSwipe() {
    var sx = 0, sy = 0, st = 0, active = false;
    ui.player.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("button, input, a, label")) return;
      active = true; sx = e.clientX; sy = e.clientY; st = performance.now();
    }, { passive: true });
    ui.player.addEventListener("pointerup", function (e) {
      if (!active) return;
      active = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (dx < -60 && Math.abs(dy) < 45 && performance.now() - st < 700) {
        if (!perf.isLite()) {
          ui.songCard.classList.add("nudge");
          setTimeout(function () { ui.songCard.classList.remove("nudge"); }, 220);
        }
        voteSkip("swipe");
      }
    }, { passive: true });
    ui.player.addEventListener("pointercancel", function () { active = false; });
  })();

  // Keyboard & hardware keys
  document.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || "";
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || document.querySelector("dialog[open]")) return;
    if (e.key === "MediaTrackNext" || e.key === "n" || e.key === "N") { e.preventDefault(); voteSkip("key"); }
    else if (e.key === "MediaPlayPause" || (e.key === " " && tag !== "BUTTON") || e.key === "k") { e.preventDefault(); engine.toggle(); }
  });

  /* ---------------- Wear: dirt and scratches where this listener taps ----------------
     Every press wears the key a little. A press leaves a faint fingerprint exactly where
     the finger landed, which darkens in slowly over a few seconds; presses in the same spot
     build up. At the same time the key's grime and the scratches on its metal icon deepen
     with the number of presses, so dirt and scratches grow together: a key pressed a few
     times looks barely used, one pressed every day looks worn. Everything starts clean
     again at the start of each month. Kept on this device only (localStorage); drawn as the
     mask of the key's grime layer (styles: .controls .neu-btn::after) and the opacity of the
     icon's scratch layers. */
  (function setupWear() {
    var KEY = "raadio.wear", MAX_PER_KEY = 40, GROW_MS = 4500;
    var keys = { skip: $("skip-btn"), play: $("play-btn"), save: $("save-btn"), auth: $("auth-btn"), guide: $("guide-icon") };
    var ICONS = { auth: true, guide: true };      // no key under them: the grime goes on the icon itself
    try { localStorage.removeItem("raadio.smudges"); } catch (e) { /* the old, fading kind */ }
    function month() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1); }
    function blank() { return { m: month(), n: { skip: 0, play: 0, save: 0, auth: 0, guide: 0 }, marks: [] }; }
    var st;
    try { st = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { st = null; }
    if (!st || typeof st !== "object" || !Array.isArray(st.marks) || !st.n) st = blank();
    function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } }
    function newMonth() { if (st.m !== month()) { st = blank(); save(); return true; } return false; }
    // how worn a key is, 0..1: slow at first, ~half after 60 presses, nearly fully after 200
    function wear(name) { return 1 - Math.exp(-(st.n[name] || 0) / 85); }

    function render(name) {
      var el = keys[name];
      if (!el) return false;
      var dark = document.body.classList.contains("dark-mode");
      if (ICONS[name]) {                          // login and guide icons: scratches and grime on the gold
        var wi = wear(name);
        Array.prototype.forEach.call(el.querySelectorAll(".k-wear--scratch"), function (u) { u.style.opacity = ((dark ? 0.2 : 0.1) + (dark ? 0.6 : 0.5) * wi).toFixed(3); });
        Array.prototype.forEach.call(el.querySelectorAll(".k-wear--grime"), function (u) { u.style.opacity = (0.08 + 0.7 * wi).toFixed(3); });
        return false;
      }
      var now = Date.now(), layers = [], growing = false;
      st.marks.forEach(function (m) {
        if (m.k !== name) return;
        var g = Math.min(1, (now - m.t) / GROW_MS);            // darkens in slowly
        if (g < 1) growing = true;
        g = g * g * (3 - 2 * g);
        var a = 0.32 * g, r = m.r || 15;
        if (a < 0.01) return;
        layers.push("radial-gradient(" + r.toFixed(1) + "px " + (r * 0.82).toFixed(1) + "px at " + m.x.toFixed(1) + "% " + m.y.toFixed(1) +
          "%, rgba(0,0,0," + a.toFixed(3) + ") 0, rgba(0,0,0," + (a * 0.6).toFixed(3) + ") 50%, rgba(0,0,0,0) 100%)");
      });
      el.style.setProperty("--smudge", layers.length ? layers.join(",") : "linear-gradient(transparent, transparent)");
      var w = wear(name);
      el.style.setProperty("--wear", w.toFixed(3));
      // the icon's scratches deepen with the same wear
      var uses = el.querySelectorAll(".metal-icon .k-layer");
      // (at night the scratches show more: there's less light on the gold to hide them)
      if (uses[0]) uses[0].style.opacity = (dark ? 0.18 + 0.62 * w : 0.05 + 0.45 * w).toFixed(3);   // scratches, always there
      if (uses[2]) uses[2].style.opacity = (dark ? 0.55 + 0.45 * w : 0.25 + 0.75 * w).toFixed(3);   // scratches catching the light
      return growing;
    }
    var growTimer = 0;
    function renderAll() {
      newMonth();
      var growing = false;
      Object.keys(keys).forEach(function (k) { growing = render(k) || growing; });
      clearTimeout(growTimer);
      if (growing) growTimer = setTimeout(renderAll, 250);
    }
    Object.keys(keys).forEach(function (name) {
      var el = keys[name];
      if (!el) return;
      el.addEventListener("pointerdown", function (e) {
        var b = el.getBoundingClientRect();
        if (!b.width || !b.height) return;
        newMonth();
        var hero = name === "play";
        st.n[name] = (st.n[name] || 0) + 1;
        st.marks.push({
          k: name, t: Date.now(),
          x: Math.max(4, Math.min(96, (e.clientX - b.left) / b.width * 100)),
          y: Math.max(4, Math.min(96, (e.clientY - b.top) / b.height * 100)),
          r: (hero ? 17 : 13) + Math.random() * 5                // fingers aren't all the same
        });
        // keep the newest prints per key (the wear itself keeps counting)
        var mine = st.marks.filter(function (m) { return m.k === name; });
        if (mine.length > MAX_PER_KEY) {
          var drop = mine[0];
          st.marks = st.marks.filter(function (m) { return m !== drop; });
        }
        save();
        renderAll();
      });
    });
    renderAll();
    setInterval(renderAll, 3600000);                             // a new month starts clean
    new MutationObserver(renderAll).observe(document.body, { attributes: true, attributeFilter: ["class"] });   // light / dark
  })();

  /* ---------------- The radio fits the screen, and the page never scrolls ----------------
     Measures the radio side as it naturally lays out. If it's taller than the space on
     screen (short phones, browser bars), it takes the next more compact step (fit-1 .. 3,
     styles: "The radio never scrolls") until it fits; then the page is locked so it
     can't be dragged up and down. Rechecked when the screen size changes. */
  (function fitRadio() {
    var de = document.documentElement, front = document.querySelector(".face--front"), stage = document.querySelector(".stage");
    if (!front || !stage) return;
    var LEVELS = ["fit-1", "fit-2", "fit-3"], timer = 0;
    function natural() {
      var was = front.style.minHeight;
      front.style.minHeight = "0px";
      var h = front.offsetHeight;
      front.style.minHeight = was;
      return h;
    }
    function room() {
      var cs = getComputedStyle(stage);
      var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      return vh - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 6;   // a little room for the float
    }
    function fit() {
      LEVELS.forEach(function (c) { de.classList.remove(c); });
      var level = 0, ok = natural() <= room();
      while (!ok && level < LEVELS.length) {
        de.classList.add(LEVELS[level++]);
        ok = natural() <= room();
      }
      de.classList.toggle("no-scroll", ok);
      if (ok) window.scrollTo(0, 0);
    }
    // The top row lines up with the display window too: the name plate's left edge on the
    // window's left edge, the login icon's drawn right edge on its right edge (each drawing
    // has a little margin inside its box, so this goes by what's actually drawn)
    var np = document.querySelector(".face--front .nameplate"), auth = $("auth-btn");
    function align() {
      var plate = front.querySelector(".plate");
      if (!plate || !plate.offsetWidth) return;
      var pr = plate.getBoundingClientRect();
      try {
        var svg = np && np.querySelector("svg"), body = svg && svg.querySelector("rect");
        if (body) {
          np.style.marginLeft = "";
          var m = body.getScreenCTM(), bb = body.getBBox();
          var left = m ? bb.x * m.a + m.e : null;
          if (left != null && Math.abs(left - pr.left) < 20) np.style.marginLeft = (parseFloat(getComputedStyle(np).marginLeft) - (left - pr.left)).toFixed(2) + "px";
        }
        var icon = auth && auth.querySelector("svg"), use = icon && icon.querySelector("use");
        if (use && auth.offsetWidth) {
          auth.style.marginRight = "";
          var m2 = use.getScreenCTM(), ub = use.getBBox();
          var right = m2 ? (ub.x + ub.width) * m2.a + m2.e : null;
          if (right != null && Math.abs(pr.right - right) < 24) auth.style.marginRight = (parseFloat(getComputedStyle(auth).marginRight) - (pr.right - right)).toFixed(2) + "px";
        }
        // and the guide book at the bottom: its drawn left edge on the window's left edge
        var gi = $("guide-icon"), gsvg = gi && !gi.hidden && gi.querySelector("svg"), guse = gsvg && gsvg.querySelector("use");
        if (guse) {
          gsvg.style.marginLeft = "0px";
          var m3 = guse.getScreenCTM(), gb = guse.getBBox();
          var gl = m3 ? gb.x * m3.a + m3.e : null;
          if (gl != null && Math.abs(gl - pr.left) < 16) gsvg.style.marginLeft = (pr.left - gl).toFixed(2) + "px";
        }
      } catch (e) { /* leave the CSS spacing */ }
    }
    var gIcon = $("guide-icon");
    if (gIcon && "MutationObserver" in window) new MutationObserver(function () { soon(); }).observe(gIcon, { attributes: true, attributeFilter: ["hidden"] });
    function soon() { clearTimeout(timer); timer = setTimeout(function () { fit(); align(); }, 120); }
    window.addEventListener("resize", soon);
    window.addEventListener("orientationchange", soon);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", soon);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(soon);
    window.addEventListener("load", soon);
    fit();
    align();
  })();

  /* ---------------- Tilt the phone, move the light ----------------
     On phones, the card's one light (the logo shine, the metal key shines, and through the
     shine the glass reflections) follows how the phone is tilted instead of sweeping on its
     own: tip it left and right and the light slides across, like a real reflection. The
     CSS sweep animations are simply held at the matching point of their 7 s loop. Whatever
     angle the phone rests at counts as the middle (it slowly re-centres), so holding it
     naturally doesn't park the light at an edge. iPhones ask once for motion access, on the
     first tap. Off on desktops, with reduced motion and in the lighter mode. */
  (function setupTilt() {
    if (!("DeviceOrientationEvent" in window)) return;
    if (!window.matchMedia || !matchMedia("(pointer: coarse)").matches) return;
    var SEL = ".face--front .np-shine, .face--front .k-shine";
    var HALF = 3500;                     // the sweeps go there (0 -> 3.5 s) and back
    var RANGE = 22;                      // degrees of tilt from one side to the middle
    var base = null, target = 0.5, shown = 0.5, live = false, anims = [], found = 0, raf = 0, lastEvent = 0, lastDraw = 0, watch = 0;

    function allowed() { return !perf.reducedMotion && !perf.isLite() && !document.hidden; }
    function screenAngle() {
      var a = (screen.orientation && typeof screen.orientation.angle === "number") ? screen.orientation.angle : (window.orientation || 0);
      return ((a % 360) + 360) % 360;
    }
    function onTilt(e) {
      if (e.gamma == null || e.beta == null) return;
      var a = screenAngle();
      // left/right tilt as the viewer sees it, whichever way the phone is turned
      var x = a === 90 ? e.beta : a === 270 ? -e.beta : a === 180 ? -e.gamma : e.gamma;
      if (Math.abs(x) > 80) return;                       // lying flat and flipping: ignore
      if (base == null) base = x;
      base += (x - base) * 0.004;                         // slowly re-centre on how it's held
      var d = Math.max(-RANGE, Math.min(RANGE, x - base));
      target = 0.5 + d / (2 * RANGE);
      lastEvent = performance.now();
      if (!live) {
        live = true; shown = target;
        // nothing coming in for a while (sensor off, page in the background): give the sweep back
        watch = setInterval(function () { if (performance.now() - lastEvent > 4000 || !allowed()) release(); }, 2000);
      }
      if (!raf && (Math.abs(target - shown) > 0.003 || !anims.length)) raf = requestAnimationFrame(step);   // first reading: take the light over
    }
    function grab() {
      anims = [];
      Array.prototype.forEach.call(document.querySelectorAll(SEL), function (el) {
        if (el.getAnimations) el.getAnimations().forEach(function (an) { anims.push(an); });
      });
      found = performance.now();
    }
    function release() {
      anims.forEach(function (an) { try { an.play(); } catch (x) { /* gone */ } });
      anims = [];
      live = false;
      base = null;
      clearInterval(watch);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    // eases the light towards the tilt at ~30 fps, and stops as soon as it has caught up
    function step(t) {
      raf = 0;
      if (!live || !allowed()) return;
      if (t - lastDraw < 30) { raf = requestAnimationFrame(step); return; }
      var dt = Math.min(100, t - (lastDraw || t - 33));
      lastDraw = t;
      if (t - found > 1000 || !anims.length) grab();                   // icons can be redrawn
      shown += (target - shown) * (1 - Math.pow(0.78, dt / 33));
      if (Math.abs(target - shown) < 0.003) shown = target;
      var at = shown * HALF;
      anims.forEach(function (an) {
        try { if (an.playState !== "paused") an.pause(); an.currentTime = at; } catch (x) { /* gone */ }
      });
      if (shown !== target) raf = requestAnimationFrame(step);
    }
    function listen() { window.addEventListener("deviceorientation", onTilt, { passive: true }); }

    // iPhones: motion access has to be asked for from a tap
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      var ask = function () {
        document.removeEventListener("click", ask, true);
        DeviceOrientationEvent.requestPermission().then(function (r) { if (r === "granted") listen(); }).catch(function () { /* said no */ });
      };
      document.addEventListener("click", ask, true);
    } else {
      listen();
    }
    document.addEventListener("visibilitychange", function () { if (document.hidden && live) release(); });
    perf.onChange(function () { if (!allowed() && live) release(); });
  })();

  /* ---------------- Sound effects for the paper and the card ----------------
     Made on the spot with Web Audio (no files): the guide's paper crinkles as each fold
     turns and creases flat at the end, and swishes as it flies to (or from) its key; the
     radio turning over to the studio whooshes past edge-on and lands with a soft knock. */
  var sfx = (function () {
    var ctx = null, out = null, noise = null;
    function setup() {
      if (ctx) { if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) { /* ignore */ } } return ctx; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 4;
      out = ctx.createGain(); out.gain.value = 1.1;
      out.connect(comp); comp.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      var d = noise.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }
    function ok() { return !perf.reducedMotion && setup(); }
    // a burst of noise through a filter, with an envelope
    function hiss(at, dur, type, f0, f1, q, peak, attack) {
      var src = ctx.createBufferSource(); src.buffer = noise;
      var flt = ctx.createBiquadFilter(); flt.type = type; flt.Q.value = q;
      flt.frequency.setValueAtTime(f0, at); flt.frequency.exponentialRampToValueAtTime(f1, at + dur);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + (attack || dur * 0.4));
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      src.connect(flt); flt.connect(g); g.connect(out);
      src.start(at, Math.random() * 0.5, dur + 0.05);
    }
    function tone(at, dur, f0, f1, peak) {
      var o = ctx.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + dur);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(out); o.start(at); o.stop(at + dur + 0.02);
    }
    return {
      // one fold of the paper turning over (folding = creased flat at the end)
      paper: function (ms, folding) {
        if (!ok()) return;
        var t = ctx.currentTime + 0.01, D = ms / 1000;
        hiss(t, D * 0.95, "lowpass", 700, 3200, 0.7, 0.07, D * 0.55);          // the sheet moving through air
        var n = Math.round(D * 26);
        for (var i = 0; i < n; i++) {                                         // crinkles, thicker toward the end
          var at = t + D * Math.pow(Math.random(), 0.7) * 0.92;
          hiss(at, 0.012 + Math.random() * 0.035, "bandpass", 2400 + Math.random() * 3800, 1800 + Math.random() * 2500, 1.6, 0.04 + Math.random() * 0.1, 0.002);
        }
        if (folding) {                                                         // pressed flat: the crease
          hiss(t + D * 0.94, 0.07, "lowpass", 1100, 400, 0.8, 0.22, 0.004);
          tone(t + D * 0.94, 0.06, 150, 90, 0.12);
        } else {
          hiss(t + D * 0.9, 0.1, "lowpass", 900, 450, 0.7, 0.18, 0.01);      // opening out: a soft flap
        }
      },
      // the folded paper flying to its key (or back out of it)
      whisk: function (ms) {
        if (!ok()) return;
        var t = ctx.currentTime + 0.01, D = (ms || 500) / 1000;
        hiss(t, D, "bandpass", 1600, 500, 1.1, 0.08, D * 0.35);
      },
      // the radio card turning over: a whoosh past edge-on, then it lands
      flip: function (ms) {
        if (!ok()) return;
        var t = ctx.currentTime + 0.01, D = (ms || 700) / 1000, mid = D * 0.43;
        hiss(t, mid, "bandpass", 300, 1700, 0.9, 0.16, mid * 0.9);
        hiss(t + mid, D - mid, "bandpass", 1700, 420, 0.9, 0.12, 0.02);
        tone(t + D, 0.09, 210, 140, 0.16);                                     // the soft knock as it settles
        hiss(t + D, 0.02, "highpass", 2500, 2000, 0.7, 0.05, 0.002);
      }
    };
  })();

  /* ---------------- Guide (first visit) ----------------
     A paper guide with moving pencil sketches; it scrolls if it's taller than the screen.
     "understand" scrolls it back to the top and folds it like real paper: the right side
     over, again, then the bottom up. The folds are a little uneven, so each one leaves a strip
     of the layer below showing; each flap lifts, throws a faint shadow, lands and settles.
     The folded paper tucks under the button and fades into the guide key at the bottom of
     the radio; tapping the key fades it out and unfolds the paper. */
  /* The guide in Farsi for listeners in Iran: the phone set to Tehran time, a phone in
     Farsi, or listening through one of the Iran relays (?lang=fa / ?lang=en to choose; a
     small switch on the paper changes it and is remembered). */
  // The guide's "Recently played": the 5 songs before this one, from /now-playing
  var guideHistory = {
    items: [], lang: null,
    set: function (list) {
      if (!Array.isArray(list)) return;
      this.items = list.slice(0, 5);
      this.render();
    },
    render: function () {
      var box = $("guide-history"), ol = $("guide-history-list");
      if (!box || !ol) return;
      box.hidden = !this.items.length;
      ol.replaceChildren();
      var ago = this.lang ? this.lang.ago : function (m) { return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m / 60) + " h ago"; };
      this.items.forEach(function (it) {
        var li = document.createElement("li"), t = document.createElement("span"), a = document.createElement("span"), w = document.createElement("span");
        t.className = "gh-title"; a.className = "gh-artist"; w.className = "gh-when";
        t.dir = a.dir = "auto";
        t.textContent = it.title || "";
        a.textContent = it.artist || "";
        var mins = typeof it.started === "number" ? Math.max(0, Math.round((Date.now() / 1000 - engine.toDevice(it.started)) / 60)) : null;
        w.textContent = mins == null ? "" : ago(mins);
        li.appendChild(t); li.appendChild(w); li.appendChild(a);
        ol.appendChild(li);
      });
    }
  };

  function guideLanguage(root) {
    var FA = {
      plaque: "راهنمای شنونده‌های تازه",
      title: "چطور گوش بدهیم",
      intro: "یک ایستگاه زنده. همه یک آهنگ را می‌شنوند و شنونده‌ها تصمیم می‌گیرند چه بماند.",
      entries: [
        ["پخش", "دکمه‌ی بزرگ را بزنید. زنده است، مثل رادیو."],
        ["رأی برای رد کردن", "انگشت رو به پایین. با رأی کافی، آهنگ برای همه رد می‌شود."],
        ["روی آنتن نگهش دارید", "انگشت رو به بالا یک رأیِ رد را پس می‌گیرد."],
        ["کیفیت بالا یا کم‌مصرف", "HQ برای صدای کامل، کم‌مصرف برای مصرف کمتر. با اتصال ضعیف خودش کم‌مصرف می‌شود و وقتی پایدار شد برمی‌گردد."],
        ["برای بعد نگهش دارید", "دکمه‌ی پخش را ۳ ثانیه نگه دارید تا پخش روی گوشی ذخیره شود (سه ساعت آخر). اگر اتصال قطع شود، از همان پخش می‌شود. برای توقف دوباره نگه دارید."],
        ["یک فلامینگو بگیرید", "روی فلامینگویی که می‌نشیند بزنید و یادداشتی برای آسمان به آن بدهید."],
        ["یک آهنگ پیشنهاد بدهید", "آن را برای ربات تلگرام ما بفرستید:"],
        ["استودیو", "درِ بالای رادیو مخصوص مجری‌هاست."]
      ],
      history: "اخیراً پخش شد",
      ago: function (m) { return m < 1 ? "همین الان" : m < 60 ? m.toLocaleString("fa") + " دقیقه پیش" : Math.floor(m / 60).toLocaleString("fa") + " ساعت پیش"; },
      studioTitle: "استودیوی شما",
      studioIn: "وارد شده‌اید. ابزارهایتان در سه بخش خانه، برنامه و زنده است.",
      hostTitle: function (u) { return "برای \u2068" + u + "\u2069"; },   // (the name kept in its own direction)
      tools: {
        record: ["ضبط", "ضبط کنید و روی آنتن بفرستید."],
        upload: ["بارگذاری", "یک فایل صوتی بفرستید."],
        schedule: ["برنامه‌ریزی", "زمان و تعداد پخش را انتخاب کنید."],
        shownotes: ["یادداشت روی برنامه‌ها", "یادداشت برای مجری‌های دیگر."],
        live: ["پخش زنده", "زنده حرف بزنید، گفت‌وگو کنید و آهنگ پخش کنید."],
        notes: ["یادداشت‌های فلامینگو", "یادداشت‌های شنونده‌ها را بخوانید، ویرایش کنید یا بفرستید."],
        numbers: ["آمار", "شنونده‌ها، کشورها، رد شدن‌ها."],
        rotation: ["چرخش آهنگ‌ها", "هر آهنگ چند وقت یک‌بار پخش شود."],
        posters: ["چه کسی آهنگ می‌گذارد", "آهنگ‌های چه کسی بیشتر دوست داشته می‌شود."]
      },
      alt: {
        hero: "رادیو آنلاین فارسی رادیو: یک رادیوی قدیمی با هدفون، صفحه‌ی گرامافون و یادداشت‌های موسیقی",
        entries: ["دکمه‌ی پخش رادیو آنلاین فارسی", "رأی برای رد کردن آهنگ در رادیو آنلاین", "نگه داشتن آهنگ محبوب روی آنتن رادیو",
                  "کیفیت بالا یا کم‌مصرف برای رادیو آنلاین فارسی", "ذخیره‌ی پخش زنده‌ی رادیو برای بعد", "فلامینگوی رادیو آنلاین با یادداشت برای آسمان",
                  "ربات تلگرام رادیو آنلاین فارسی برای پیشنهاد آهنگ", "در استودیوی رادیو برای مجری‌ها"]
      },
      sign: "این راهنما را از کتاب کوچک روی رادیو دوباره باز کنید.",
      ok: "فهمیدم",
      saver: "کم‌مصرف",
      other: "English"
    };
    var page = root.querySelector(".guide-page");
    var q = function (sel) { return root.querySelector(sel); };
    var lis = root.querySelectorAll(".guide-entries > li");
    // the English as it is in the page, to switch back to
    // (a link inside an entry stays a link: it's taken out here and put back after the text)
    var link = q(".guide-link");
    var EN = {
      plaque: (q(".sk-script") || {}).textContent, title: q(".guide-title").textContent, intro: q(".guide-intro").textContent,
      entries: Array.prototype.map.call(lis, function (li) {
        var p = li.querySelector("p").cloneNode(true);
        Array.prototype.forEach.call(p.querySelectorAll("a"), function (a) { a.remove(); });
        return [li.querySelector("b").textContent, p.textContent.trim()];
      }),
      history: (q(".guide-history-title") || {}).textContent,
      ago: function (m) { return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m / 60) + " h ago"; },
      studioTitle: "Your studio",
      studioIn: "You're signed in. Your tools are under Home, Schedule and Live.",
      hostTitle: function (u) { return "For " + u; },
      tools: {
        record: ["Record", "Record and put it on air."],
        upload: ["Upload", "Send an audio file."],
        schedule: ["Schedule", "Pick when and how often it plays."],
        shownotes: ["Notes on shows", "Notes for the other hosts."],
        live: ["Go live", "Talk live, chat, and play songs."],
        notes: ["Flamingo notes", "Read, edit or send listeners' notes."],
        numbers: ["The numbers", "Listeners, countries, skips."],
        rotation: ["Rotation", "How often each song plays."],
        posters: ["Who posts music", "Whose songs listeners like most."]
      },
      alt: {
        hero: "Raadio Persian radio online: a vintage radio with headphones, a vinyl record and music notes",
        entries: ["Play button of the free Persian radio online", "Vote to skip a song on the live radio", "Keep a favourite song on air on Raadio",
                  "HQ or data saver for Persian radio online", "Save the live radio stream for later", "Raadio flamingo carrying a note for the sky",
                  "The studio door on the radio, for hosts"]
      },
      sign: q(".guide-sign").textContent, ok: $("guide-ok").textContent, saver: (q(".ga-lbl--sv") || {}).textContent, other: "فارسی"
    };
    // The listen-only demo: only what's available there (no votes, no notes)
    if (CONFIG.READ_ONLY) lis.forEach(function (li, i) { if (i === 1 || i === 2 || i === 5) li.style.display = "none"; });
    var sw = document.createElement("button");
    sw.type = "button"; sw.className = "guide-lang";
    page.insertBefore(sw, page.firstChild);
    function apply(lang) {
      var T = lang === "fa" ? FA : EN;
      root.setAttribute("lang", lang); page.dir = lang === "fa" ? "rtl" : "ltr";
      // (the words drawn inside the sketches stay as they are: Chrome can hang laying out
      // Farsi inside those small drawings)
      q(".guide-title").textContent = T.title;
      q(".guide-intro").textContent = CONFIG.READ_ONLY ? T.intro.replace(/(;| و شنونده‌ها).*$/, ".") : T.intro;
      var who = typeof session !== "undefined" && session && session.user ? session : null;
      Array.prototype.forEach.call(lis, function (li, i) {
        if (!T.entries[i]) return;
        var studio = li.classList.contains("guide-studio") && who;
        li.querySelector("b").textContent = studio ? T.studioTitle : T.entries[i][0];
        var p = li.querySelector("p");
        p.textContent = studio ? T.studioIn : T.entries[i][1];
        if (link && li.contains(link) === false && li.classList.contains("guide-bot")) { p.appendChild(document.createTextNode(" ")); p.appendChild(link); }
      });
      // the drawings, described (keywords included) in the guide's language
      var hero = q(".guide-hero");
      if (hero && T.alt) { hero.removeAttribute("aria-hidden"); hero.setAttribute("role", "img"); hero.setAttribute("aria-label", T.alt.hero); }
      Array.prototype.forEach.call(lis, function (li, i) {
        var vg = li.querySelector(".guide-vg");
        if (!vg || !T.alt || !T.alt.entries[i]) return;
        vg.removeAttribute("aria-hidden"); vg.setAttribute("role", "img"); vg.setAttribute("aria-label", T.alt.entries[i]);
      });
      var hostBox = q(".guide-host");
      if (hostBox) {
        hostBox.hidden = !who;
        hostBox.replaceChildren();
        if (who) {
          var ICON = { record: "i-mic", upload: "i-folder", schedule: "i-calendar", shownotes: "i-edit", live: "i-live",
                       notes: "i-send", numbers: "i-eye", rotation: "i-star", posters: "i-user" };
          var keys = ["record", "upload", "schedule", "shownotes", "live", "notes"].concat(who.role === "curator" ? ["numbers", "rotation", "posters"] : []);
          var h = document.createElement("h3"); h.className = "guide-host-title"; h.textContent = T.hostTitle(who.user);
          hostBox.appendChild(h);
          var ul = document.createElement("ul"); ul.className = "guide-tools";
          keys.forEach(function (k) {
            var li = document.createElement("li");
            li.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#' + ICON[k] + '"/></svg><span><b></b> <span></span></span>';
            li.querySelector("b").textContent = T.tools[k][0];
            li.querySelector("span span").textContent = T.tools[k][1];
            ul.appendChild(li);
          });
          hostBox.appendChild(ul);
        }
      }
      if (q(".guide-history-title")) q(".guide-history-title").textContent = T.history;
      guideHistory.lang = T;
      guideHistory.render();
      q(".guide-sign").textContent = T.sign;
      $("guide-ok").textContent = T.ok;
      sw.textContent = T.other;
      sw.setAttribute("lang", lang === "fa" ? "en" : "fa");
    }
    function guess() {
      var p = new URLSearchParams(location.search).get("lang");
      if (p === "fa" || p === "en") return p;
      var kept = store.get("raadio.guide-lang", null);
      if (kept === "fa" || kept === "en") return kept;
      var tz = "";
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* ignore */ }
      var langs = (navigator.languages || [navigator.language || ""]).join(",");
      return tz === "Asia/Tehran" || /(^|,)fa\b/i.test(langs) || hosts.isRelay() ? "fa" : "en";
    }
    var now = guess();
    apply(now);
    sw.addEventListener("click", function () {
      now = now === "fa" ? "en" : "fa";
      store.set("raadio.guide-lang", now);
      apply(now);
    });
    // signing in or out changes the studio entry
    guideRefresh = function () { apply(now); };
  }
  var guideRefresh = function () {};

  /* The studio in Farsi: the switch by the radio button swaps every word in the studio
     (text, placeholders, labels) for its Farsi, and back; words the studio writes later
     (lists, messages) are swapped as they appear. Words without a Farsi stay as they are. */
  var studioLang = "en", studioLangHooks = [];   // parts that write their own words redraw on a switch
  (function studioLanguage() {
    var root = $("studio"), sw = $("st-lang");
    if (!root || !sw) return;
    var FA = {
      "Add": "افزودن", "Add a note of your own": "یادداشت خودتان را اضافه کنید", "Add to queue": "افزودن به صف",
      "Answer the chat…": "به گفتگو جواب دهید…", "Audience and reactions": "شنونده‌ها و واکنش‌ها", "Audio file": "فایل صوتی",
      "Back to radio": "بازگشت به رادیو", "Block": "مسدود کن", "Blocked words": "کلمه‌های مسدود", "Booth ready": "استودیو آماده است",
      "Broadcast queue": "صف پخش", "Broadcast schedule": "برنامه‌ی پخش", "Browse": "انتخاب", "Choose an audio file": "یک فایل صوتی انتخاب کنید",
      "Day": "روز", "Drop songs here, or tap to choose": "آهنگ‌ها را اینجا رها کنید یا بزنید تا انتخاب کنید",
      "End the stream": "پایان پخش زنده", "English or Farsi word": "کلمه‌ی انگلیسی یا فارسی", "Find a song": "پیدا کردن آهنگ",
      "Flamingo notes": "یادداشت‌های فلامینگو", "Go live": "پخش زنده", "Go live now": "همین حالا زنده شوید",
      "Highest skip rate": "بیشترین نرخ رد شدن", "Home": "خانه", "IP geolocation by": "موقعیت‌یابی IP با",
      "Listener-voted rotation": "چرخه‌ی پخش با رأی شنونده‌ها", "Listeners": "شنونده‌ها", "Listening now": "در حال شنیدن",
      "Live": "زنده", "Live mic": "میکروفون زنده", "Live on-air studio": "استودیوی پخش زنده", "Live station chat": "گفتگوی زنده‌ی ایستگاه",
      "Message to the chat": "پیام به گفتگو", "Month": "ماه", "Most downloaded": "بیشترین دانلود", "Most played": "بیشترین پخش",
      "Most skip votes": "بیشترین رأی رد", "Most skipped": "بیشترین رد شده", "My studio": "استودیوی من", "New note": "یادداشت تازه",
      "Not now": "الان نه", "Notes with these words (or ones starting with them) can't be sent. Tap a word to allow it again.":
        "یادداشت‌هایی که این کلمه‌ها (یا کلمه‌هایی که با آن‌ها شروع می‌شوند) را دارند فرستاده نمی‌شوند. برای آزاد کردن، روی کلمه بزنید.",
      "Now playing on air": "در حال پخش", "Off air": "خاموش", "On air": "روی آنتن", "Online": "آنلاین", "Play": "پخش",
      "Play now": "همین حالا پخش کن", "Play the queue": "پخش صف", "Realtime": "لحظه‌ای", "Rec": "ضبط", "Record": "ضبط",
      "Record or upload something, then put it on air at a set time.": "چیزی ضبط یا بارگذاری کنید، بعد آن را برای ساعت مشخصی روی آنتن بگذارید.",
      "Rotation": "چرخه‌ی پخش", "Schedule": "برنامه", "Send": "بفرست", "Server status": "وضعیت سرور", "Show tier": "رده را نشان بده",
      "Sign out": "خروج", "Skip": "رد کن", "Skips": "ردها", "Sort songs": "مرتب کردن آهنگ‌ها", "Start": "شروع", "Station telemetry": "آمار ایستگاه",
      "Stop": "توقف", "Stream name": "نام برنامه", "Studio": "استودیو", "Studio Dashboard": "داشبورد استودیو", "Studio Schedule": "برنامه‌ی استودیو",
      "Talk": "صحبت", "Talk to everyone listening, play songs in the show and answer the chat.": "با همه‌ی شنونده‌ها صحبت کنید، در برنامه آهنگ پخش کنید و به گفتگو جواب دهید.",
      "Talk to everyone listening, right now, and chat with them": "همین حالا با همه‌ی شنونده‌ها صحبت و گفتگو کنید",
      "The music fades out and everyone hears your microphone. A chat opens for all listeners and is deleted when you end. The radio on this device goes quiet while you're live, so your mic doesn't pick it up. You can play songs during the show: your mic goes off while one plays, unless you press Talk.":
        "موسیقی آرام قطع می‌شود و همه صدای میکروفون شما را می‌شنوند. گفتگویی برای همه‌ی شنونده‌ها باز می‌شود و وقتی تمام کنید پاک می‌شود. رادیوی این دستگاه در زمان پخش زنده ساکت می‌شود تا میکروفون آن را نگیرد. در برنامه می‌توانید آهنگ پخش کنید: وقتی آهنگی پخش می‌شود میکروفون خاموش است، مگر این‌که «صحبت» را بزنید.",
      "This week vs last": "این هفته در برابر هفته‌ی قبل",
      "Time range": "بازه‌ی زمانی", "Typical week": "یک هفته‌ی معمول", "Upload": "بارگذاری", "Use your microphone": "از میکروفون خود استفاده کنید",
      "Week": "هفته", "Busiest times": "شلوغ‌ترین زمان‌ها",
      "Skip votes": "رأی‌های رد", "Liked songs": "آهنگ‌های پسندیده", "Play or pause the radio": "پخش یا توقف رادیو", "likes": "پسند", "Songs in each tier": "آهنگ‌ها در هر رده", "average": "میانگین", "votes": "رأی", "notes": "یادداشت",
      // the server status log, empty lists and states
      "Studio ready": "استودیو آماده است", "Opus stream": "پخش Opus", "Back online": "دوباره آنلاین", "Back to live": "برگشت به پخش زنده",
      "Device went offline": "دستگاه آفلاین شد", "Removed from the schedule": "از برنامه حذف شد", "Skip vote failed": "رأی رد ثبت نشد",
      "That file isn't audio": "این فایل صوتی نیست", "Those aren't audio files": "این‌ها فایل صوتی نیستند", "The stream is ended": "پخش زنده تمام شد",
      "Track skipped by listeners": "آهنگ با رأی شنونده‌ها رد شد", "Microphone access was blocked": "دسترسی به میکروفون مسدود شد",
      "Name needs at least 2 characters": "نام باید دست‌کم 2 حرف باشد", "Stream not answering yet, still trying": "پخش هنوز جواب نمی‌دهد؛ دوباره امتحان می‌کنیم",
      "Stream ended on its own, reconnected": "پخش خودبه‌خود قطع شد و دوباره وصل شد", "Weak connection: switched to data saver": "اتصال ضعیف: کم‌مصرف شد",
      "Connection steady: back to high quality": "اتصال پایدار: برگشت به کیفیت بالا", "Data saver stream not available here, using HQ": "پخش کم‌مصرف اینجا نیست؛ کیفیت بالا پخش می‌شود",
      "Opus not supported here, using MP3": "Opus پشتیبانی نمی‌شود؛ MP3 پخش می‌شود", "A moment of the stream didn't get through (connection)": "لحظه‌ای از پخش نرسید (اتصال)",
      "No connection: playing what was saved on this device": "اتصال نیست: آنچه روی این دستگاه ذخیره شده پخش می‌شود",
      "Saving the stream on this device (the last 3 hours)": "پخش روی این دستگاه ذخیره می‌شود (3 ساعت اخیر)",
      "Saved the original recording (MP3 conversion failed)": "ضبط اصلی ذخیره شد (تبدیل به MP3 نشد)",
      "3D background unavailable in this browser": "پس‌زمینه‌ی سه‌بعدی در این مرورگر در دسترس نیست",
      "Nothing scheduled. Record or upload something to put it on air.": "برنامه‌ای نیست. چیزی ضبط یا بارگذاری کنید تا روی آنتن برود.",
      "Nothing scheduled yet": "هنوز برنامه‌ای نیست", "Starting…": "در حال شروع…", "Pause": "توقف",
      "No notes right now. Catch a flamingo while listening to leave one.": "الان یادداشتی نیست. موقع گوش دادن یک فلامینگو بگیرید تا یادداشت بگذارید.", "What's the show called? (optional)": "اسم برنامه چیست؟ (اختیاری)", "When a song is added": "وقتی آهنگی اضافه می‌شود",
      "Where they listen": "از کجا گوش می‌دهند", "Who posts music": "چه کسی موسیقی می‌گذارد", "Word to block": "کلمه برای مسدود کردن",
      "Join the broadcast": "پیوستن به پخش", "Join": "پیوستن", "Leave": "خروج", "Your name on air": "نام شما روی آنتن", "Microphone": "میکروفون",
      "Choose the phone or computer's microphone, or the one on your headphones. Bluetooth headphone microphones usually sound thinner; wired ones and the device's are clearer.": "میکروفون گوشی یا رایانه، یا میکروفون هدفون را انتخاب کنید. میکروفون هدفون بلوتوثی معمولا صدای ضعیف‌تری دارد؛ سیم‌دار و میکروفون خود دستگاه واضح‌ترند.",
      "Everyone must wear headphones (no echo between hosts)": "همه باید هدفون داشته باشند (بدون اکو بین مجری‌ها)", "I'm wearing headphones": "هدفون دارم",
      "The music fades out and everyone hears your microphone. A chat opens for all listeners and is deleted when you end. The radio on this device goes quiet while you're live, so your mic doesn't pick it up. Other hosts can join with their studio login. You can play songs during the show: microphones go off air while one plays, unless you press Talk.": "موسیقی کم می‌شود و همه صدای میکروفون شما را می‌شنوند. برای شنونده‌ها گفتگویی باز می‌شود که با پایان پخش پاک می‌شود. رادیوی این دستگاه در این مدت ساکت است تا میکروفون آن را نگیرد. مجری‌های دیگر با ورود به استودیو می‌توانند بپیوندند. می‌توانید آهنگ پخش کنید: تا آهنگ پخش می‌شود میکروفون‌ها روی آنتن نیستند، مگر اینکه «صحبت» را بزنید.",
      "This show needs everyone on headphones. Put yours on and tick the box.": "این برنامه برای همه هدفون لازم دارد. هدفون بگذارید و تیک بزنید.",
      "On air together": "با هم روی آنتن", "Mute": "بی‌صدا", "Muted": "بی‌صدا شد", "Hear the others": "شنیدن بقیه", "Hearing the others": "در حال شنیدن بقیه",
      "running the show": "گرداننده‌ی برنامه", "weak line": "خط ضعیف", "Remove": "حذف", "Show recordings": "ضبط برنامه‌ها",
      "Your line is good.": "خط شما خوب است.", "Your line is weak, so you're on air at a lower quality. The high-quality recording isn't affected.": "خط شما ضعیف است، پس با کیفیت پایین‌تر روی آنتن هستید. ضبط باکیفیت تغییری نمی‌کند.",
      "Put on headphones to hear the others: on a speaker their voices would get back into your microphone.": "برای شنیدن بقیه هدفون بگذارید: با بلندگو صدایشان دوباره وارد میکروفون می‌شود.",
      "This device can't make a high-quality recording; the on-air version will still be saved": "این دستگاه نمی‌تواند ضبط باکیفیت بسازد؛ نسخه‌ی پخش‌شده ذخیره می‌شود",
      "High quality": "کیفیت بالا", "On-air version": "نسخه‌ی پخش‌شده", "Mixing the high-quality file…": "در حال ساخت فایل باکیفیت…",
      "You're live": "شما زنده هستید", "Your mic is off while the song plays.": "تا آهنگ پخش می‌شود میکروفون شما خاموش است.",
      "downloads": "دانلود", "made by Hootan": "ساخته‌ی هوتن", "plays": "پخش", "skip votes": "رأی رد", "skipped": "رد شده", "tuning": "شنونده"
    };
    var PATTERNS = [[/^Signed in as (.+)$/, "واردشده با نام $1"], [/^Connected via (.+)$/, "وصل از طریق $1"],
      [/^Switched to (.+)$/, "تغییر به $1"], [/^Reconnecting \((.+)\)$/, "اتصال دوباره ($1)"], [/^Lite mode on \((.+)\)$/, "حالت سبک روشن شد ($1)"],
      [/^(\d+) words?$/, "$1 کلمه"], [/^(\d{1,2}:\d{2}) AM$/, "$1 ق.ظ"], [/^(\d{1,2}:\d{2}) PM$/, "$1 ب.ظ"],
      [/^Chat: (.+) · everyone listening can join$/, "گفتگو: $1 · همه‌ی شنونده‌ها می‌توانند بیایند"],
      [/^No messages yet\. Say hello to (.+)!$/, "هنوز پیامی نیست. به $1 سلام کنید!"], [/^Live with (.+)$/, "زنده با $1"],
      [/^(.+) is live: join them$/, "$1 زنده است: بپیوندید"], [/^(.+) is live$/, "$1 زنده است"],
      [/^Deleted in (\d+) days?$/, "$1 روز دیگر پاک می‌شود"], [/^Waiting for high-quality recordings: (\d+) of (\d+) in$/, "در انتظار ضبط‌های باکیفیت: $1 از $2 رسیده"],
      [/^Your high-quality recording is uploading: (\d+)%\. Keep this page open if you can; it carries on next time you open the studio\.$/, "ضبط باکیفیت شما در حال ارسال است: $1٪. اگر می‌توانید این صفحه را باز نگه دارید؛ دفعه‌ی بعد که استودیو را باز کنید ادامه پیدا می‌کند."]];
    var ATTRS = ["placeholder", "aria-label", "title"];
    var textOrig = new WeakMap(), attrOrig = new WeakMap();
    var now = "en", busy = false;

    function farsi(s) {
      var t = s.trim();
      if (!t) return null;
      var f = FA[t];
      if (!f) for (var i = 0; i < PATTERNS.length && !f; i++) if (PATTERNS[i][0].test(t)) f = t.replace(PATTERNS[i][0], PATTERNS[i][1]);
      return f ? s.replace(t, f) : null;
    }
    function swapText(n) {
      if (now === "fa") {
        var f = farsi(n.nodeValue);
        if (f !== null && f !== n.nodeValue) { textOrig.set(n, n.nodeValue); n.nodeValue = f; }
      } else if (textOrig.has(n)) { n.nodeValue = textOrig.get(n); textOrig.delete(n); }
    }
    function swapAttrs(el) {
      var kept = attrOrig.get(el) || {};
      ATTRS.forEach(function (a) {
        if (el === sw || !el.hasAttribute(a)) return;
        if (now === "fa") {
          var f = farsi(el.getAttribute(a));
          if (f !== null) { kept[a] = el.getAttribute(a); el.setAttribute(a, f); }
        } else if (a in kept) { el.setAttribute(a, kept[a]); delete kept[a]; }
      });
      attrOrig.set(el, kept);
    }
    function walk(node) {
      if (node.nodeType === 3) { swapText(node); return; }
      if (node.nodeType !== 1 || node === sw || node.tagName === "SCRIPT" || node.tagName === "STYLE") return;
      swapAttrs(node);
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
    }
    function apply(lang) {
      now = lang;
      busy = true;
      root.setAttribute("lang", lang);
      root.dir = lang === "fa" ? "rtl" : "ltr";
      walk(root);
      busy = false;
      studioLang = lang;
      studioLangHooks.forEach(function (f) { f(); });
      sw.textContent = lang === "fa" ? "EN" : "فا";
      sw.setAttribute("lang", lang === "fa" ? "en" : "fa");
    }
    // words the studio writes later, and labels it changes later (a key's "Play" / "Pause")
    new MutationObserver(function (list) {
      if (busy || now !== "fa") return;
      busy = true;
      list.forEach(function (m) {
        if (m.type === "characterData") swapText(m.target);
        else if (m.type === "attributes") swapAttrs(m.target);
        else Array.prototype.forEach.call(m.addedNodes, walk);
      });
      busy = false;
    }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

    sw.addEventListener("click", function () {
      var next = now === "fa" ? "en" : "fa";
      store.set("raadio.studio-lang", next);
      apply(next);
    });
    if (store.get("raadio.studio-lang", "en") === "fa") apply("fa");
  })();

  /* ---------------- Guide: tap a feature for a closer look ----------------
     Each entry on the guide opens a small card that grows out of it: a short looping clip
     (a pencil-sketch scene, like the guide's own drawings, with a play/pause key and a
     progress line) and a few more lines about it, in the guide's language. Esc, the ×, a tap
     outside or closing the guide puts it away. */
  (function guidePop() {
    var root = $("guide"), page = root.querySelector(".guide-page");
    var lis = Array.prototype.slice.call(root.querySelectorAll(".guide-entries > li"));
    // The clips draw a small copy of the radio itself: the cream body, the brass name plate,
    // the display (dots, HQ, On air, the status in the display's own type), the song, the wave
    // window and the three keys. The flamingo is the site's own line-art bird (flamingoArt),
    // flapping and blinking; it's built when a card opens, once flamingoArt exists.
    // The keys and the skip votes use the radio's own thumb icons (#i-like, #i-dislike).
    var KEY = { dis: [98, 117], play: [120, 117], like: [142, 117] };
    function radio(o) {
      o = o || {};
      var bars = "";
      for (var k = 0; k < 22; k++) {
        var h = 1.6 + Math.abs(Math.sin(k * 1.7) * 2.6) + (k % 3) * 0.5;
        bars += '<rect x="' + (86 + k * 3.25).toFixed(2) + '" y="' + (99.5 - h / 2).toFixed(2) + '" width="1.5" height="' + h.toFixed(2) + '" rx="0.75" class="gp-wbar' + (k < 9 ? " is-on" : "") + '"/>';
      }
      return '<g class="gp-radio">' +
        '<rect x="77" y="10" width="92" height="124" rx="13" class="gp-shadow"/>' +
        '<rect x="74" y="6" width="92" height="124" rx="13" class="gp-body"/>' +
        // name plate: brass, with the flamingo ring and RAADIO
        '<rect x="81" y="12" width="60" height="15" rx="3.5" class="gp-brass"/>' +
        '<circle cx="84" cy="15" r="0.7" class="gp-screw"/><circle cx="138" cy="15" r="0.7" class="gp-screw"/><circle cx="84" cy="24" r="0.7" class="gp-screw"/><circle cx="138" cy="24" r="0.7" class="gp-screw"/>' +
        '<ellipse cx="91" cy="22" rx="4.2" ry="1.8" class="gp-engrave"/><path d="M90 21 C88 18 90 15.5 92 16.5" class="gp-engrave"/>' +
        '<path d="M97 15 V24" class="gp-engrave"/>' +
        '<text x="99.5" y="17.6" class="gp-plate-small">EST. FREQUENCY</text><text x="99.5" y="24.2" class="gp-plate">RAADIO</text>' +
        // the door to the studio (top corner)
        '<g transform="translate(150 13)">' + (o.door || '<path d="M0 0 H7 V11 H0 Z" class="gp-door"/><path d="M-3 5.5 H4 M2 3.5 L4 5.5 L2 7.5" class="gp-doorline"/>') + '</g>' +
        // display
        '<rect x="81" y="31" width="78" height="41" rx="7" class="gp-well"/>' +
        '<circle cx="86" cy="36" r="0.9" class="gp-dot is-on"/><circle cx="89" cy="36" r="0.9" class="gp-dot"/><circle cx="92" cy="36" r="0.9" class="gp-dot"/>' +
        (o.chips || '<rect x="125" y="33.2" width="9" height="5.6" rx="1.6" class="gp-chip"/><text x="129.5" y="37.3" text-anchor="middle" class="gp-chiptext">HQ</text>') +
        (o.air != null ? o.air : '<circle cx="138.5" cy="36" r="1" class="gp-airdot"/><text x="140.5" y="37.3" class="gp-air">ON AIR</text>') +
        (o.screen || "") +
        '<path d="M86 63 H154" class="gp-scale"/><path d="M120 60.5 V65.5" class="gp-needle"/>' +
        // the song
        (o.song || '<text x="120" y="82" text-anchor="middle" class="gp-song">Gol-e Sangam</text>') +
        '<text x="120" y="88" text-anchor="middle" class="gp-artist">Googoosh</text>' +
        // wave window
        '<rect x="82" y="94" width="76" height="11" rx="5.5" class="gp-well"/>' + bars +
        // keys
        '<g class="gpa-dis"><circle cx="98" cy="117" r="6.5" class="gp-key"/><use href="#i-dislike" x="94.2" y="113.2" width="7.6" height="7.6" class="gp-thumb"/></g>' +
        '<g class="gpa-play"><circle cx="120" cy="117" r="9" class="gp-key gp-key--hero"/>' + (o.playIcon || '<path d="M117.4 113 L124.4 117 L117.4 121 Z" class="gp-keyicon"/>') + '</g>' +
        '<g class="gpa-like"><circle cx="142" cy="117" r="6.5" class="gp-key"/><use href="#i-like" x="138.2" y="113.2" width="7.6" height="7.6" class="gp-thumb"/></g>' +
        (o.extra || "") + "</g>";
    }
    function lcd(text, cls, at) { return '<text x="83.5" y="54" class="gp-lcd ' + (cls || "") + '"' + (at != null ? ' style="--at:' + at + '"' : "") + ">" + text + "</text>"; }
    function song(text, cls, at) { return '<text x="120" y="82" text-anchor="middle" class="gp-song ' + (cls || "") + '"' + (at != null ? ' style="--at:' + at + '"' : "") + ">" + text + "</text>"; }
    function finger(x, y, cls, at) {
      return '<g transform="translate(' + x + " " + y + ')"><g class="' + cls + '"' + (at != null ? ' style="--at:' + at + '"' : "") + '>' +
        '<path d="M0 0 C0 -5 5 -7 7.5 -3.5 L18 12 C20.5 16.5 19 22 14 24.5 L10.5 26" class="gp-skin"/><path d="M2.4 -3.4 Q4.2 -6.6 6.6 -4.2" class="gp-nail"/></g></g>';
    }
    function at(x, y, inner) { return '<g transform="translate(' + x + " " + y + ')">' + inner + "</g>"; }
    function bird(kind, x, y, w, h) {
      var art = typeof flamingoArt !== "undefined" ? (kind === "fly" ? flamingoArt.svgFlying("gp-fl") : flamingoArt.svgStanding("gp-fl")) : "";
      return '<svg x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" overflow="visible">' + art.replace(/^<svg /, '<svg width="100%" height="100%" ') + "</svg>";
    }
    var HEART = '<path d="M0 2 C0 -2 5 -2 5 1 C5 -2 10 -2 10 2 C10 6 5 8 5 10 C5 8 0 6 0 2Z" class="gp-heart"/>';
    var VOTE = '<circle r="6" class="gp-vote"/><use href="#i-dislike" x="-3.6" y="-3.6" width="7.2" height="7.2" class="gp-thumb"/>';
    var NOTE = '<g transform="translate(0 0)"><path d="M0 8 V0 L6 -2 V6"/><circle cx="-1.6" cy="8" r="1.8" class="gp-inkfill"/><circle cx="4.4" cy="6" r="1.8" class="gp-inkfill"/></g>';
    var WIFI = '<path d="M0 6 Q8 -2 16 6" class="gp-line"/><path d="M3.5 9 Q8 5 12.5 9" class="gp-line"/><circle cx="8" cy="12" r="1.3" class="gp-inkfill"/>';
    function clips() {
      return [
        // play: the finger taps play, Off air turns On air, sound comes out
        radio({ air: '<circle cx="138.5" cy="36" r="1" class="gp-airdot gpa-on" style="--at:0.22"/><text x="140.5" y="37.3" class="gp-air gpa-off" style="--at:0.22">OFF AIR</text><text x="140.5" y="37.3" class="gp-air gp-air--live gpa-on" style="--at:0.22">ON AIR</text>',
                screen: lcd("READY TO PLAY", "gpa-off", 0.22) + lcd("PLAYING LIVE", "gpa-on", 0.22),
                playIcon: '<path d="M117.4 113 L124.4 117 L117.4 121 Z" class="gp-keyicon gpa-off" style="--at:0.22"/><path d="M117.2 113.2 V120.8 M122.8 113.2 V120.8" class="gp-keyline gpa-on" style="--at:0.22"/>' }) +
          at(172, 70, '<path d="M0 -12 Q7 0 0 12" class="gp-line gpa-wave" style="--at:0.3"/><path d="M7 -18 Q17 0 7 18" class="gp-line gpa-wave" style="--at:0.38"/><path d="M14 -24 Q27 0 14 24" class="gp-line gpa-wave" style="--at:0.46"/>') +
          at(68, 70, '<path d="M0 -12 Q-7 0 0 12" class="gp-line gpa-wave" style="--at:0.3"/><path d="M-7 -18 Q-17 0 -7 18" class="gp-line gpa-wave" style="--at:0.38"/><path d="M-14 -24 Q-27 0 -14 24" class="gp-line gpa-wave" style="--at:0.46"/>') +
          finger(KEY.play[0] + 3, KEY.play[1] + 2, "gpa-tap", 0.2),
        // vote to skip: three votes, then the song changes for everyone
        radio({ screen: lcd("PLAYING LIVE"), song: song("Khalij-e Fars", "gpa-off", 0.62) + song("Gol-e Sangam", "gpa-on", 0.62) }) +
          at(176, 30, '<g class="gpa-pop" style="--at:0.2">' + VOTE + '</g>') + at(189, 30, '<g class="gpa-pop" style="--at:0.35">' + VOTE + '</g>') + at(202, 30, '<g class="gpa-pop" style="--at:0.5">' + VOTE + '</g>') +
          at(189, 46, '<text text-anchor="middle" class="gp-caption gpa-pop" style="--at:0.62">skipped!</text>') +
          at(176, 76, '<path d="M0 0 L8 5 L0 10 M8 0 L16 5 L8 10" class="gp-line gpa-pop" style="--at:0.62"/>') +
          finger(KEY.dis[0] + 2, KEY.dis[1] + 2, "gpa-tap3"),
        // keep it on air: thumbs-up takes a skip vote back, hearts rise
        radio({ screen: lcd("2 SKIP VOTES", "gpa-off", 0.3) + lcd("1 SKIP VOTE", "gpa-on", 0.3) }) +
          at(150, 98, '<g class="gpa-rise" style="--at:0.24">' + HEART + "</g>") + at(162, 92, '<g class="gpa-rise" style="--at:0.32">' + HEART + "</g>") + at(140, 88, '<g class="gpa-rise" style="--at:0.4">' + HEART + "</g>") +
          finger(KEY.like[0] + 2, KEY.like[1] + 2, "gpa-tap", 0.2),
        // HQ or Saver: the signal falls, HQ turns Saver, then back
        radio({ chips: '<g class="gpa-off" style="--at:0.3"><rect x="125" y="33.2" width="9" height="5.6" rx="1.6" class="gp-chip"/><text x="129.5" y="37.3" text-anchor="middle" class="gp-chiptext">HQ</text></g>' +
                       '<g class="gpa-on" style="--at:0.3"><rect x="119" y="33.2" width="15" height="5.6" rx="1.6" class="gp-chip gp-chip--saver"/><text x="126.5" y="37.3" text-anchor="middle" class="gp-chiptext gp-chiptext--saver">SAVER</text></g>',
                screen: lcd("PLAYING LIVE", "gpa-off", 0.3) + lcd("SAVING DATA", "gpa-on", 0.3) }) +
          at(186, 92, '<path d="M0 0 V-8" class="gp-sig gpa-dip" style="--at:0.2"/><path d="M8 0 V-16" class="gp-sig gpa-dip" style="--at:0.2"/><path d="M16 0 V-24" class="gp-sig gpa-dip" style="--at:0.2"/><path d="M24 0 V-32" class="gp-sig gpa-dip" style="--at:0.2"/>') +
          at(186, 100, '<text class="gp-caption">signal</text>'),
        // keep it for later: hold play 3 s, the ring fills, Saving; the line drops, Tape
        radio({ air: '<circle cx="138.5" cy="36" r="1" class="gp-airdot"/><text x="140.5" y="37.3" class="gp-air gp-air--live">ON AIR</text>' +
                     '<g class="gpk-saving"><circle cx="111" cy="36" r="1" class="gp-golddot"/><text x="113" y="37.3" class="gp-air gp-air--gold">SAVING</text></g>' +
                     '<g class="gpk-tape"><circle cx="111" cy="36" r="1" class="gp-airdot"/><text x="113" y="37.3" class="gp-air gp-air--live">TAPE</text></g>',
                chips: "",
                screen: lcd("PLAYING LIVE", "gpk-onair") + lcd("SAVING STREAM", "gpk-saving") + lcd("PLAYING TAPE", "gpk-tape"),
                extra: '<circle cx="120" cy="117" r="12" class="gp-ring gpk-ring"/>' +
                       at(128, 108, '<g class="gpa-on" style="--at:0.45"><circle r="4.4" class="gp-golddot"/><path d="M0 -2 V2 M-2 0.4 L0 2.2 L2 0.4" class="gp-white"/></g>') }) +
          at(188, 20, WIFI + '<path d="M0 0 L16 14" class="gp-redline gpa-on" style="--at:0.7"/>') +
          finger(KEY.play[0] + 3, KEY.play[1] + 2, "gpk-hold"),
        // catch a flamingo: it flies in, lands on the wave window, takes a note, writes it in the sky
        radio({ screen: lcd("PLAYING LIVE") }) +
          '<g class="gpk-fly-in">' + bird("fly", -2, -6, 46, 23) + '</g>' +
          '<g class="gpk-stand">' + bird("stand", 128, 58, 24, 38) +
            '<g class="gpa-on" style="--at:0.45"><rect x="146" y="60" width="17" height="8" rx="2.5" class="gp-paper"/><path d="M148.5 62.8 H160 M148.5 65.2 H156" class="gp-line gp-line--soft"/></g></g>' +
          '<g class="gpk-fly-out">' + bird("fly", 128, 52, 46, 23) + '<rect x="166" y="70" width="14" height="6.5" rx="2" class="gp-paper"/></g>' +
          '<path d="M172 34 C182 18 194 34 206 20" class="gp-sky gpk-sky"/><text x="172" y="14" class="gp-script gpa-on" style="--at:0.86">salam!</text>' +
          finger(142, 70, "gpa-tap", 0.35),
        // studio: the door on top opens, a mic comes out, the display says Studio
        radio({ door: '<path d="M0 0 H7 V11 H0 Z" class="gp-doorway"/><g class="gpk-door"><path d="M0 0 H7 V11 H0 Z" class="gp-door"/><circle cx="5.4" cy="5.5" r="0.7" class="gp-inkfill"/></g>',
                screen: lcd("READY TO PLAY", "gpa-off", 0.6) + lcd("STUDIO", "gpa-on", 0.6) }) +
          '<g transform="translate(176 40)"><g class="gpk-mic"><rect x="-5" y="-14" width="10" height="15" rx="5" class="gp-mic"/><path d="M-8 -6 Q0 6 8 -6 M0 0 V8 M-5 8 H5" class="gp-line"/>' +
            '<circle cx="12" cy="-12" r="2" class="gp-airdot"/><text x="16" y="-10" class="gp-air gp-air--live gp-air--big">ON AIR</text></g></g>' +
          finger(156, 22, "gpa-tap", 0.2)
      ];
    }
    var MORE = {
      en: [
        ["One tap starts the live stream; tap again to stop.", "Everyone hears the same song at the same moment, like a real radio.", "The display says On air while you're connected, and Tuning while it catches up."],
        ["Thumbs-down adds your vote to skip the song for everyone.", "When enough listeners vote, the song ends early and the next one starts.", "Songs that get skipped a lot come round less often."],
        ["Thumbs-up takes back a skip vote.", "It's how listeners shape the station together."],
        ["HQ plays the full-quality sound.", "Saver uses much less data, good on mobile data.", "On a weak connection it drops to Saver by itself, and goes back to HQ once it's steady."],
        ["While it plays, hold Play for 3 seconds: the display shows Saving.", "The last 3 hours stay on your phone.", "If the connection drops, the display shows Tape and it plays on from what it saved, then goes back to live by itself. Hold again to stop."],
        ["Now and then a flamingo flies by and lands on the radio.", "Tap it and write a short note: it carries it off and writes it in the sky for everyone listening.", "Notes are checked before they fly."],
        ["Hosts sign in through the door on top of the radio.", "In the studio they record, upload, plan shows and go live with a chat.", "Curators also see the station's numbers."]
      ],
      fa: [
        ["با یک ضربه پخش زنده شروع می‌شود؛ دوباره بزنید تا متوقف شود.", "همه در یک لحظه یک آهنگ را می‌شنوند، مثل یک رادیوی واقعی.", "تا وقتی وصل هستید نمایشگر «روی آنتن» را نشان می‌دهد."],
        ["انگشت رو به پایین رأی شما را برای رد کردن آهنگ ثبت می‌کند.", "وقتی رأی‌ها کافی شود، آهنگ زودتر تمام می‌شود و آهنگ بعدی شروع می‌شود.", "آهنگ‌هایی که زیاد رد می‌شوند کمتر پخش می‌شوند."],
        ["انگشت رو به بالا یک رأیِ رد را پس می‌گیرد.", "شنونده‌ها این‌طور با هم ایستگاه را می‌سازند."],
        ["HQ صدا را با کیفیت کامل پخش می‌کند.", "کم‌مصرف داده‌ی خیلی کمتری مصرف می‌کند؛ برای اینترنت موبایل مناسب است.", "با اتصال ضعیف خودش کم‌مصرف می‌شود و وقتی اتصال پایدار شد به HQ برمی‌گردد."],
        ["هنگام پخش، دکمه‌ی پخش را ۳ ثانیه نگه دارید؛ نمایشگر «در حال ذخیره» را نشان می‌دهد.", "سه ساعت آخر روی گوشی‌تان می‌ماند.", "اگر اتصال قطع شود، نمایشگر «نوار» را نشان می‌دهد و از همان ذخیره پخش می‌کند، بعد خودش به پخش زنده برمی‌گردد. برای توقف دوباره نگه دارید."],
        ["گاهی فلامینگویی می‌آید و روی رادیو می‌نشیند.", "رویش بزنید و یادداشت کوتاهی بنویسید؛ آن را می‌برد و برای همه‌ی شنونده‌ها در آسمان می‌نویسد.", "یادداشت‌ها پیش از پرواز بررسی می‌شوند."],
        ["مجری‌ها از درِ بالای رادیو وارد می‌شوند.", "در استودیو ضبط می‌کنند، فایل می‌فرستند، برنامه می‌چینند و با گفت‌وگو زنده پخش می‌کنند.", "گرداننده‌ها آمار ایستگاه را هم می‌بینند."]
      ]
    };
    var WORDS = { en: { close: "Close", pause: "Pause", play: "Play" },
                  fa: { close: "بستن", pause: "توقف", play: "پخش" } };
    var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    var pop = null, from = null;

    function lang() { return root.getAttribute("lang") === "fa" ? "fa" : "en"; }
    function close(back) {
      if (!pop) return;
      var p = pop, li = from;
      pop = null; from = null;
      p.classList.remove("is-in");
      if (li) li.setAttribute("aria-expanded", "false");
      setTimeout(function () { p.remove(); }, 260);
      if (back && li) li.focus();
    }
    function place(p, li) {
      var r = li.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
      var w = p.offsetWidth, h = p.offsetHeight, m = 12;
      var x = Math.max(m, Math.min(vw - w - m, r.left + r.width / 2 - w / 2));
      var below = r.bottom + 8, above = r.top - h - 8;
      var y = below + h <= vh - m ? below : above >= m ? above : Math.max(m, (vh - h) / 2);
      p.style.left = x.toFixed(0) + "px"; p.style.top = y.toFixed(0) + "px";
      // it grows out of the middle of the entry that was tapped
      p.style.transformOrigin = (r.left + r.width / 2 - x).toFixed(0) + "px " + (r.top + r.height / 2 - y).toFixed(0) + "px";
    }
    function open(li) {
      var i = lis.indexOf(li), CLIPS = clips();
      if (i < 0 || !CLIPS[i]) return;
      var again = from === li;
      close(false);
      if (again) return;
      var L = lang(), W = WORDS[L];
      var p = document.createElement("div");
      p.className = "gp";
      p.setAttribute("role", "dialog");
      p.setAttribute("aria-labelledby", "gp-title");
      p.dir = page.dir || "ltr";
      p.innerHTML =
        '<button type="button" class="gp-x"><svg class="icon"><use href="#i-close"/></svg></button>' +
        '<div class="gp-screen"><svg class="gp-clip" viewBox="30 0 180 135" aria-hidden="true">' +
        '<defs><linearGradient id="gp-brass-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d7b77c"/><stop offset="0.45" stop-color="#c39456"/><stop offset="1" stop-color="#946630"/></linearGradient></defs>' +
        '<g class="gp-scene">' + CLIPS[i] + '</g></svg>' +
        '<div class="gp-time" aria-hidden="true"><i></i></div>' +
        '<button type="button" class="gp-pp"><svg class="icon"><use href="#i-pause"/></svg></button></div>' +
        '<h3 class="gp-title" id="gp-title"></h3><ul class="gp-more"></ul>';
      // a switch (shown from its moment to the end of the loop) gets the keyframes for that moment
      Array.prototype.forEach.call(p.querySelectorAll(".gpa-on, .gpa-off"), function (el) {
        var m = Math.round(parseFloat(el.style.getPropertyValue("--at") || "0.2") * 100);
        el.style.animationName = (el.classList.contains("gpa-on") ? "gp-on-" : "gp-off-") + m;
      });
      p.querySelector(".gp-title").textContent = li.querySelector("b").textContent;
      var ul = p.querySelector(".gp-more");
      MORE[L][i].forEach(function (t) { var x = document.createElement("li"); x.textContent = t; ul.appendChild(x); });
      p.querySelector(".gp-x").setAttribute("aria-label", W.close);
      var pp = p.querySelector(".gp-pp");
      function playing(on) {
        p.classList.toggle("is-paused", !on);
        pp.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play");
        pp.setAttribute("aria-label", on ? W.pause : W.play);
      }
      playing(!still);
      pp.addEventListener("click", function () { playing(p.classList.contains("is-paused")); });
      p.querySelector(".gp-x").addEventListener("click", function () { close(true); });
      root.appendChild(p);
      place(p, li);
      pop = p; from = li;
      li.setAttribute("aria-expanded", "true");
      requestAnimationFrame(function () { requestAnimationFrame(function () { p.classList.add("is-in"); }); });
      p.querySelector(".gp-x").focus({ preventScroll: true });
    }

    lis.forEach(function (li) {
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-haspopup", "dialog");
      li.setAttribute("aria-expanded", "false");
      li.addEventListener("click", function (e) { if (!e.target.closest("a")) open(li); });
      li.addEventListener("keydown", function (e) {
        if (e.target !== li) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(li); }
      });
    });
    // a tap anywhere else, Esc, or the guide closing puts it away; scrolling the paper or
    // resizing moves it along with its entry (and puts it away once the entry scrolls out)
    document.addEventListener("pointerdown", function (e) {
      if (pop && !pop.contains(e.target) && !(from && from.contains(e.target))) close(false);
    }, true);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && pop) { e.stopPropagation(); close(true); } }, true);
    function follow() {
      if (!pop) return;
      var r = from.getBoundingClientRect(), pr = page.getBoundingClientRect();
      if (r.bottom < pr.top || r.top > pr.bottom) { close(false); return; }
      place(pop, from);
    }
    page.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    new MutationObserver(function () { if (root.hidden) close(false); }).observe(root, { attributes: true, attributeFilter: ["hidden"] });
  })();

  (function setupGuide() {
    var KEY = "raadio.guide";
    var root = $("guide"), sheet = $("guide-sheet"), page = $("guide-page"), ok = $("guide-ok"), icon = $("guide-icon");
    if (!root || !sheet || !page || !ok || !icon) return;
    var busy = false, layers = [];
    var creases = $("guide-creases");
    guideLanguage(root);
    // only "reduce motion" skips the fold: it is light enough for any phone (it used to be
    // skipped in the lighter mode too, which made the paper just vanish on some devices)
    function still() { return perf.reducedMotion; }
    function seen() { try { return localStorage.getItem(KEY) === "folded"; } catch (e) { return false; } }
    function remember() { try { localStorage.setItem(KEY, "folded"); } catch (e) { /* private mode */ } }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function play(el, frames, opts) {
      if (!el || typeof el.animate !== "function") return Promise.resolve();
      var a = el.animate(frames, Object.assign({ fill: "forwards" }, opts));
      return new Promise(function (r) { a.onfinish = r; a.oncancel = r; });
    }
    function cancelAll(el) { if (el && el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel(); }); }

    /* ---------- folding ----------
       Fold lines sit a little off-centre (A1, A2, B), so the turned flap lands short of the
       left/top edge and a strip of what's underneath stays in view. */
    var A1 = 0.56, A2 = 0.31, B = 0.55;
    // where the folds leave lines when it's opened again: the second fold also creased the
    // first flap, which lands at 2*A1 - A2 once flat; the last fold crosses the whole width
    // The lines sit on the paper itself (they scroll with it): the folds are made with the
    // paper at its top, so the cross fold is B of the visible height down from the top.
    function placeCreases() {
      if (!creases) return;
      var gl = creases.children;
      gl[0].style.left = A2 * 100 + "%"; gl[1].style.left = A1 * 100 + "%"; gl[2].style.left = (2 * A1 - A2) * 100 + "%";
      creases.style.height = page.scrollHeight + "px";
      gl[3].style.top = Math.round(B * page.clientHeight) + "px";
    }
    function creased(on) { sheet.classList.toggle("is-creased", !!on); }
    // the paper's length changes after it's laid out: switching language, and the Farsi font
    // arriving a moment later make it longer. The fold lines follow, so they run the full
    // length (they used to stop part way down in Farsi)
    if (window.ResizeObserver) {
      var grow = new ResizeObserver(function () { if (!root.hidden) placeCreases(); });
      Array.prototype.forEach.call(page.children, function (c) { if (c !== creases) grow.observe(c); });
    }
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", function () { if (!root.hidden) placeCreases(); });
    // (the paper scrolls if it's taller than the screen; just place the lines and the hint)
    function fit() {
      placeCreases();
      hint();
    }
    function steps(W, H) {
      var a1 = W * A1, a2 = W * A2, b = H * B;
      return [
        { axis: "y", flap: [a1, 0, W - a1, H], keep: [0, 0, a1, H], land: [2 * a1 - W, 0, W - a1, H] },
        { axis: "y", flap: [a2, 0, a1 - a2, H], keep: [0, 0, a2, H], land: [2 * a2 - a1, 0, a1 - a2, H] },
        { axis: "x", flap: [0, b, a2, H - b], keep: [0, 0, a2, b], land: [0, 2 * b - H, a2, H - b] }
      ];
    }
    function rect(e, r) { e.style.left = r[0] + "px"; e.style.top = r[1] + "px"; e.style.width = r[2] + "px"; e.style.height = r[3] + "px"; }
    // show only rectangle r of the page and of each folded layer (layers keep room for their shadow)
    function clipTo(r) {
      var W = sheet.clientWidth, H = sheet.clientHeight;
      function inset(x, y, w, h, room) {
        function side(v) { return v > 0.5 ? v + "px" : -room + "px"; }
        return "inset(" + side(r[1] - y) + " " + side(x + w - r[0] - r[2]) + " " + side(y + h - r[1] - r[3]) + " " + side(r[0] - x) + ")";
      }
      page.style.clipPath = inset(0, 0, W, H, 0);
      layers.forEach(function (l) { l.style.clipPath = inset(l._at[0], l._at[1], l._at[2], l._at[3], 10); });
    }
    function addLayer(st) {
      var l = document.createElement("div");
      l.className = "guide-layer guide-layer--" + st.axis;
      l._at = st.land;
      rect(l, st.land);
      sheet.appendChild(l);
      layers.push(l);
    }
    // a copy of what is showing now (the page and the layers folded so far), cut to the flap
    function snapshot(into, f) {
      var c = page.cloneNode(true);
      c.removeAttribute("id");
      Array.prototype.forEach.call(c.querySelectorAll("[id]"), function (x) { x.removeAttribute("id"); });
      c.classList.add("guide-page--copy");
      c.style.width = sheet.clientWidth + "px";
      c.style.height = sheet.clientHeight + "px";
      c.style.left = (-f[0]) + "px";
      c.style.top = (-f[1]) + "px";
      c.style.clipPath = "none";
      into.appendChild(c);
      layers.forEach(function (l) {
        var k = l.cloneNode(false);
        k.style.clipPath = "none";
        k.style.left = (l._at[0] - f[0]) + "px";
        k.style.top = (l._at[1] - f[1]) + "px";
        into.appendChild(k);
      });
    }
    function makeFlap(st) {
      var f = st.flap, flap = document.createElement("div");
      flap.className = "guide-flap guide-flap--" + st.axis;
      rect(flap, f);
      var front = document.createElement("div");
      front.className = "guide-face guide-face--front";
      snapshot(front, f);
      var back = document.createElement("div");
      back.className = "guide-face guide-face--back guide-face--plain";
      back.style.visibility = "hidden";                // shown only once the flap passes edge-on
      [front, back].forEach(function (face) { var sh = document.createElement("div"); sh.className = "guide-shade"; face.appendChild(sh); });
      flap.appendChild(front);
      flap.appendChild(back);
      sheet.appendChild(flap);
      return flap;
    }
    // One flap turning over the crease. Folding: it swings over, lands, lifts a hair and
    // settles, its shadow growing on the paper below. Unfolding: it peels up slowly, then opens.
    function turn(flap, st, folding, ms) {
      var r = st.axis === "y" ? "rotateY" : "rotateX", sign = st.axis === "y" ? -1 : 1;   // over the front
      function at(d) { return { transform: r + "(" + sign * d + "deg) translateZ(0.5px)" }; }
      var sh = flap.querySelectorAll(".guide-shade");
      var cast = document.createElement("div");
      cast.className = "guide-cast guide-cast--" + st.axis;
      rect(cast, st.land);
      sheet.insertBefore(cast, flap);
      var frames, castFrames, ease = "cubic-bezier(0.42, 0, 0.18, 1)";
      // one smooth swing each way (no bounce at the end: it read as a stutter)
      if (folding) {
        frames = [at(0), at(180)];
        castFrames = [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1, offset: 0.8 }, { opacity: 0.3 }];
        play(sh[0], [{ opacity: 0 }, { opacity: 0.4, offset: 0.5 }, { opacity: 0.4 }], { duration: ms, easing: ease });
        play(sh[1], [{ opacity: 0.3 }, { opacity: 0.3, offset: 0.5 }, { opacity: 0 }], { duration: ms, easing: ease });
      } else {
        frames = [at(180), at(0)];
        castFrames = [{ opacity: 0.3 }, { opacity: 0.9, offset: 0.2 }, { opacity: 0, offset: 0.65 }, { opacity: 0 }];
        play(sh[0], [{ opacity: 0.4 }, { opacity: 0.4, offset: 0.5 }, { opacity: 0 }], { duration: ms, easing: ease });
        play(sh[1], [{ opacity: 0 }, { opacity: 0.3, offset: 0.5 }, { opacity: 0.3 }], { duration: ms, easing: ease });
      }
      // Which side shows is switched by hand at the edge-on moment (90°), not left to
      // backface-visibility: some browsers (Safari) draw a face's own layers through it
      // anyway, which showed the printed side mirrored through the back of the paper.
      // The easing is on the whole effect, so offset 0.5 is exactly the 90° point.
      var faces = flap.querySelectorAll(".guide-face");
      // (opacity and visibility both, so no browser can show the hidden side: Firefox too)
      var first = [{ opacity: 1, visibility: "visible" }, { opacity: 1, visibility: "visible", offset: 0.5 },
                   { opacity: 0, visibility: "hidden", offset: 0.5 }, { opacity: 0, visibility: "hidden" }];
      var second = [{ opacity: 0, visibility: "hidden" }, { opacity: 0, visibility: "hidden", offset: 0.5 },
                    { opacity: 1, visibility: "visible", offset: 0.5 }, { opacity: 1, visibility: "visible" }];
      play(faces[0], folding ? first : second, { duration: ms, easing: ease });    // the printed side
      play(faces[1], folding ? second : first, { duration: ms, easing: ease });    // the back
      play(cast, castFrames, { duration: ms, easing: ease });
      return play(flap, frames, { duration: ms, easing: ease }).then(function () { cast.remove(); });
    }
    function clearLayers() {
      layers.forEach(function (l) { l.remove(); });
      layers = [];
      Array.prototype.forEach.call(sheet.querySelectorAll(".guide-flap, .guide-cast"), function (f) { f.remove(); });
      page.style.clipPath = "";
    }
    function foldedState() {
      var list = steps(sheet.clientWidth, sheet.clientHeight);
      clearLayers();
      list.forEach(addLayer);
      clipTo(list[2].keep);
    }
    function fold() {
      var list = steps(sheet.clientWidth, sheet.clientHeight), chain = Promise.resolve();
      list.forEach(function (st, i) {
        chain = chain.then(function () {
          var flap = makeFlap(st);
          clipTo(st.keep);
          sfx.paper(i ? 520 : 620, true);
          return turn(flap, st, true, i ? 520 : 620).then(function () {
            addLayer(st);
            clipTo(st.keep);
            flap.remove();
            return wait(i ? 30 : 140);      // a beat after the first fold, to see what peeks out
          });
        });
      });
      return chain;
    }
    function unfold() {
      var W = sheet.clientWidth, H = sheet.clientHeight, list = steps(W, H), chain = Promise.resolve();
      list.slice().reverse().forEach(function (st, j) {
        var i = 2 - j;
        chain = chain.then(function () {
          layers.pop().remove();
          var flap = makeFlap(st);
          flap.style.transform = st.axis === "y" ? "rotateY(-180deg)" : "rotateX(180deg)";
          sfx.paper(i ? 480 : 580, false);
          return turn(flap, st, false, i ? 480 : 580).then(function () {
            clipTo(i ? list[i - 1].keep : [0, 0, W, H]);
            flap.remove();
          });
        });
      });
      return chain.then(clearLayers);
    }

    // the page scrolls when it's taller than the screen: a soft fade at the bottom says so
    function hint() { sheet.classList.toggle("can-scroll", page.scrollHeight - page.clientHeight - page.scrollTop > 8); }
    page.addEventListener("scroll", hint, { passive: true });
    window.addEventListener("resize", function () { if (!root.hidden && !busy) fit(); });
    // folding starts from the top of the paper
    function toTop() {
      if (page.scrollTop < 2) return Promise.resolve();
      try { page.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { page.scrollTop = 0; }
      var t0 = Date.now();
      return new Promise(function (r) {
        (function check() { if (page.scrollTop < 2 || Date.now() - t0 > 700) { page.scrollTop = 0; r(); } else requestAnimationFrame(check); })();
      });
    }

    // the folded paper (the top-left A2 x B of the sheet) moving to a point on screen
    function packetTo(x, y, scale) {
      var b = sheet.getBoundingClientRect();
      var pw = b.width * A2, ph = b.height * B;
      return "translate(" + (x - (b.left + pw / 2 * scale)) + "px," + (y - (b.top + ph / 2 * scale)) + "px) scale(" + scale + ")";
    }
    function centre(el) { var b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }

    // where the guide key sits, and how small the folded paper must get to match it
    function iconSpot() {
      var was = icon.hidden;
      icon.style.visibility = "hidden";
      icon.hidden = false;
      var b = icon.getBoundingClientRect();
      icon.hidden = was;
      icon.style.visibility = "";
      var s = sheet.getBoundingClientRect();
      var k = Math.min(b.width / (s.width * A2 || 1), b.height / (s.height * B || 1));
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, k: Math.max(0.05, Math.min(1, k * 1.15)) };
    }
    function backdrop(on, ms) {
      var cs = getComputedStyle(root), blur = cs.backdropFilter || cs.webkitBackdropFilter;
      var full = { backgroundColor: cs.backgroundColor }, none = { backgroundColor: "rgba(0,0,0,0)" };
      if (blur && blur !== "none") { full.backdropFilter = full.webkitBackdropFilter = blur; none.backdropFilter = none.webkitBackdropFilter = "blur(0px)"; }
      return play(root, on ? [none, full] : [full, none], { duration: ms });
    }
    // the little sketches only move while they're on screen
    if ("IntersectionObserver" in window) {
      var inView = new IntersectionObserver(function (list) {
        list.forEach(function (en) { en.target.classList.toggle("is-seen", en.isIntersecting); });
      }, { root: page, threshold: 0.15 });
      Array.prototype.forEach.call(page.querySelectorAll(".guide-entries li, .guide-hero"), function (el) { inView.observe(el); });
    } else {
      Array.prototype.forEach.call(page.querySelectorAll(".guide-entries li, .guide-hero"), function (el) { el.classList.add("is-seen"); });
    }

    // the paper over the radio (from the moment it opens until it's folded away)
    new MutationObserver(function () { guideUp = !root.hidden; }).observe(root, { attributes: true, attributeFilter: ["hidden"] });
    guideUp = !root.hidden;
    function close(e) {
      if (busy || root.hidden) return;
      busy = true;
      remember();
      var byKeys = !e || e.type === "keydown" || e.detail === 0;   // keyboard: move focus on to the key
      var done = function () {
        root.hidden = true;
        root.classList.remove("is-folding");
        sheet.classList.remove("is-flying");
        [sheet, root, ok].forEach(cancelAll);
        clearLayers();
        icon.hidden = false;
        busy = false;
        if (byKeys) { try { icon.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }
      };
      if (still()) { play(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in" }).then(done, done); return; }
      // the button goes first, so only the paper is moving
      play(ok, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.92)" }], { duration: 180, easing: "ease-in" });
      toTop().then(function () { root.classList.add("is-folding"); return fold(); }).then(function () { return wait(120); }).then(function () {
        // the folded paper flies to the guide key, shrinking to its size, and fades into it
        var t = iconSpot();
        sheet.classList.add("is-flying");
        sfx.whisk(560);
        backdrop(false, 620);
        play(sheet, [
          { transformOrigin: "0 0", transform: "none", opacity: 1 },
          { transformOrigin: "0 0", transform: packetTo(t.x, t.y, t.k * 1.6), opacity: 1, offset: 0.7 },
          { transformOrigin: "0 0", transform: packetTo(t.x, t.y, t.k), opacity: 0 }
        ], { duration: 640, easing: "cubic-bezier(0.55, 0, 0.35, 1)" });
        return wait(430);
      }).then(function () {
        icon.hidden = false;
        play(icon, [{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
        return wait(230);
      }).then(done, done);
    }

    function open(fromIcon) {
      if (busy) return;
      busy = true;
      var start = fromIcon && !still() ? centre(icon) : null;
      root.hidden = false;
      clearLayers();
      page.scrollTop = 0;
      fit();
      var done = function () {
        root.classList.remove("is-folding");
        [sheet, root, ok, icon].forEach(cancelAll);
        icon.hidden = true;
        busy = false;
        page.scrollTop = 0;
        hint();
        try { ok.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      };
      if (!start) {
        // opened by itself (a first visit) or with reduced motion: the paper fades in and,
        // unless motion is reduced, rises into place
        creased(seen()); icon.hidden = true;
        play(root, still() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(18px) scale(0.97)" }, { opacity: 1, transform: "none" }],
             { duration: still() ? 200 : 460, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }).then(done, done);
        return;
      }
      creased(true);                                  // it was folded: the lines unfold with it
      page.scrollTop = 0;
      root.classList.add("is-folding");
      // the key fades out; the folded paper fades in where it was, comes up and unfolds
      play(icon, [{ opacity: 1 }, { opacity: 0, transform: "scale(0.7)" }], { duration: 220 });
      foldedState();
      var spot = iconSpot(), from = packetTo(start[0], start[1], spot.k);
      sfx.whisk(460);
      backdrop(true, 420);
      play(ok, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });       // the button waits for the paper
      play(sheet, [
        { transformOrigin: "0 0", transform: from, opacity: 0 },
        { transformOrigin: "0 0", transform: from, opacity: 1, offset: 0.3 },
        { transformOrigin: "0 0", transform: "none", opacity: 1 }
      ], { duration: 560, easing: "cubic-bezier(0.3, 0, 0.2, 1)" })
        .then(function () { cancelAll(sheet); icon.hidden = true; return unfold(); })
        .then(function () { return play(ok, [{ opacity: 0, transform: "scale(0.92)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "ease-out" }); })
        .then(done, done);
    }

    ok.addEventListener("click", close);
    icon.addEventListener("click", function () { open(true); });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); close(e); } });

    // ?guide (the links from the guide's own pages, /guide/ and /fa/guide/) opens it straight away
    var ask = new URLSearchParams(location.search).has("guide");
    if (seen() && !ask) icon.hidden = false;
    else setTimeout(function () { if (!flipped) open(false); }, 800);
  })();

  // Features this device can't use stay out of the guide: no flamingo ever visits with
  // reduced motion, and keeping the stream for later needs the browser's storage
  // (IndexedDB). Everything else works on every device, the weakest included.
  (function guideFit() {
    var keep = document.querySelector(".guide-entries .guide-keep"), fly = document.querySelector(".guide-entries .guide-flamingo");
    if (keep && !window.indexedDB) keep.hidden = true;
    if (fly && perf.reducedMotion) fly.hidden = true;
  })();

  // Speakers, headsets, car stereos and the lock-screen notification all go through this
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    var ms = navigator.mediaSession;
    function set(action, fn) { try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported action */ } }
    set("play", function () { engine.play(); });
    set("pause", function () { engine.stop(); });
    set("stop", function () { engine.stop(); });
    set("nexttrack", function () { voteSkip("headset"); });
    set("previoustrack", null);
    set("seekbackward", null);
    set("seekforward", null);
    set("seekto", null);
    updateMeta(ui.songName.textContent, ui.artistName.textContent);
  }
  // The lock screen, notification and car display: the song and artist, "Raadio · Live"
  // (or the show's name) underneath, and a cover made for each song: the flamingo, the
  // title and artist, and an ON AIR mark, in the radio's own colours. The plain icon stays
  // as a fallback for systems that won't take a drawn picture.
  var metaShow = false, covers = {}, coverKeys = [], metaWant = "";
  function cover(title, artist, show) {
    var key = title + "|" + artist + "|" + show;
    if (!covers[key]) covers[key] = draw(title, artist, show, key);
    return covers[key];
  }
  function draw(title, artist, show, key) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = img.onerror = function () {
        try {
          var N = 512, cv = document.createElement("canvas"), x = cv.getContext("2d");
          cv.width = cv.height = N;
          var bg = x.createLinearGradient(0, 0, N, N);
          bg.addColorStop(0, "#f4efe6"); bg.addColorStop(1, "#e2d9ca");
          x.fillStyle = bg; x.fillRect(0, 0, N, N);
          // the brass name plate across the top, with the flamingo on it
          var g = x.createLinearGradient(0, 40, 0, 190);
          g.addColorStop(0, "#d3a868"); g.addColorStop(0.5, "#b8894b"); g.addColorStop(1, "#946a33");
          x.fillStyle = g;
          rr(x, 36, 40, N - 72, 150, 26); x.fill();
          x.strokeStyle = "rgba(255,240,210,0.55)"; x.lineWidth = 3; rr(x, 37.5, 41.5, N - 75, 147, 25); x.stroke();
          if (img.naturalWidth) x.drawImage(img, 56, 52, 126, 126);
          x.fillStyle = "#4a3416";
          x.font = "800 58px Mulish, system-ui, sans-serif"; x.textBaseline = "alphabetic";
          x.fillText("RAADIO", 196, 142);
          x.font = "700 20px Mulish, system-ui, sans-serif";
          x.fillText("EST. FREQUENCY", 200, 88);
          // the song, up to two lines, then the artist
          x.fillStyle = "#26241f"; x.textBaseline = "top";
          var size = 46; x.font = "800 " + size + "px Mulish, system-ui, sans-serif";
          var lines = wrap(x, title, N - 96, 2);
          if (lines.length > 1 && x.measureText(lines[1]).width > N - 96) lines[1] = lines[1].slice(0, -1);
          var y = 236;
          lines.forEach(function (l) { x.fillText(l, 48, y); y += size + 8; });
          x.fillStyle = "#6f675c"; x.font = "600 32px Mulish, system-ui, sans-serif";
          x.fillText(wrap(x, artist, N - 96, 1)[0] || "", 48, y + 10);
          // ON AIR, like the light on the radio
          x.fillStyle = "#c2416b"; x.beginPath(); x.arc(60, 452, 10, 0, Math.PI * 2); x.fill();
          x.fillStyle = "#835d2a"; x.font = "800 22px Mulish, system-ui, sans-serif"; x.textBaseline = "middle";
          x.fillText(show ? "ON AIR · LIVE SHOW" : "ON AIR · LISTENER-VOTED RADIO", 82, 453);
          // (iPhones show small artwork more reliably: a 128 px copy goes along with it)
          var sm = document.createElement("canvas"); sm.width = sm.height = 128;
          sm.getContext("2d").drawImage(cv, 0, 0, 128, 128);
          var small = null;
          try { small = sm.toDataURL("image/png"); } catch (e) { /* ignore */ }
          cv.toBlob(function (b) {
            if (!b) { resolve(null); return; }
            var u = { big: URL.createObjectURL(b), small: small };
            // keep the last few (the lock screen may still be showing one); let older ones go
            coverKeys.push(key);
            while (coverKeys.length > 4) {
              var old = coverKeys.shift();
              Promise.resolve(covers[old]).then(function (ou) { if (ou) URL.revokeObjectURL(ou.big); });
              delete covers[old];
            }
            resolve(u);
          }, "image/png");
        } catch (e) { resolve(null); }
      };
      img.src = "icons/flamingo-512.png";
    });
    function rr(c, x0, y0, w, h, r) {
      c.beginPath(); c.moveTo(x0 + r, y0); c.arcTo(x0 + w, y0, x0 + w, y0 + h, r); c.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
      c.arcTo(x0, y0 + h, x0, y0, r); c.arcTo(x0, y0, x0 + w, y0, r); c.closePath();
    }
    function wrap(c, text, w, max) {
      var words = String(text || "").split(/\s+/), out = [], line = "";
      words.forEach(function (wd) {
        var t = line ? line + " " + wd : wd;
        if (c.measureText(t).width <= w || !line) line = t; else { out.push(line); line = wd; }
      });
      if (line) out.push(line);
      if (out.length > max) { out = out.slice(0, max); out[max - 1] = out[max - 1].replace(/\s*\S*$/, "") + "…"; }
      return out.map(function (l) { while (c.measureText(l).width > w && l.length > 2) l = l.slice(0, -2) + "…"; return l; });
    }
  }
  function updateMeta(title, artist, show) {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    if (show !== undefined) metaShow = !!show;
    var album = metaShow ? "Raadio · Live show" : "Raadio · Live radio";
    var icons = [
      { src: "icons/flamingo-192.png", sizes: "192x192", type: "image/png" },
      { src: "icons/flamingo-512.png", sizes: "512x512", type: "image/png" }
    ];
    function set(art) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: title || "Raadio", artist: artist || "Raadio", album: album,
          artwork: art ? [{ src: art.big, sizes: "512x512", type: "image/png" }]
            .concat(art.small ? [{ src: art.small, sizes: "128x128", type: "image/png" }] : []).concat(icons) : icons
        });
      } catch (e) { /* ignore */ }
    }
    var key = title + "|" + artist + "|" + metaShow;
    metaWant = key;
    set(null);
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    fonts.then(function () { return cover(title, artist, metaShow); }).then(function (u) {
      if (u && metaWant === key) set(u);                 // (still the song on air)
    });
  }

  // Live title from the backend; a new track id also frees the vote button
  /* ---------------- Save the song on air ----------------
     Shown while a song (not a studio show) is playing. The server converts it to
     AAC in .m4a (plays everywhere, ~1 MB a minute) tagged with artist, title and air date. */
  // The thumbs-up (where "save the song" used to be): the reverse of a skip vote. It takes
  // back one vote waiting to skip the song, and makes the song come round more often.
  // (name kept: the now-playing code calls saveSong.update)
  var saveSong = (function () {
    var btn = $("save-btn"), track = null, busy = false, likedId = null;
    function update(d) {
      var ok = d && typeof d.id === "number" && !d.show;
      if (ok && (!track || track.id !== d.id)) {
        track = { id: d.id, title: d.title || "" };
        if (likedId !== d.id) { btn.setAttribute("aria-pressed", "false"); btn.classList.remove("is-liked"); }
      }
      btn.hidden = !ok;
    }
    btn.addEventListener("click", function () {
      if (!track || busy) return;
      if (!engine.isOn()) { setStatus("Press play to like a song"); return; }
      if (likedId === track.id) { setStatus("You liked this one"); return; }
      var t = track;
      busy = true;
      btn.classList.add("is-busy", "is-liked");
      btn.setAttribute("aria-pressed", "true");
      postJSON(hosts.current() + CONFIG.SKIP_PATH + "?up=1&d=" + encodeURIComponent(deviceId()), 4000).then(function (data) {
        setStatus(data.message || "Liked");
        if (data.liked) {
          likedId = t.id;
          log.add("ok", data.rescued ? "Thumbs-up: took back a skip vote" : "Thumbs-up");
          nowPlaying.poll();                       // (the vote count may have gone down)
        } else { btn.classList.remove("is-liked"); btn.setAttribute("aria-pressed", "false"); }
      }).catch(function () {
        btn.classList.remove("is-liked"); btn.setAttribute("aria-pressed", "false");
        setStatus(navigator.onLine ? "Couldn't send the like" : "You're offline");
      }).then(function () { busy = false; btn.classList.remove("is-busy"); });
    });
    return { update: update };
  })();

  function setupNowPlaying() {
    if (!CONFIG.NOW_PLAYING_PATH) return;
    var lastId = null, lastTitle = "", lastLive = "", failedOnce = false;
    var pendingId = null, pendingTimer = 0;
    function show(d) {
      if (d.id != null && d.id !== lastId) {
        if (lastId !== null) resetVote();
        lastId = d.id;
      }
      saveSong.update(d);
      var liveNow = d.live && d.live.host ? d.live.host : "";
      if ((d.title && d.title !== lastTitle) || liveNow !== lastLive) {
        lastTitle = d.title || lastTitle;
        lastLive = liveNow;
        setText(ui.songName, lastTitle);
        setText(ui.artistName, d.live && d.live.host ? "Live with " + d.live.host : d.artist || "Live stream");
        updateMeta(d.title, d.artist || "Raadio", !!d.show);
      }
    }
    function poll() {
      var tSend = Date.now() / 1000, tRecv = 0;
      fetch(hosts.current() + CONFIG.NOW_PLAYING_PATH + "?t=" + Date.now() + (engine.isOn() ? "&on=1" : ""), { cache: "no-store" })
        .then(function (r) { tRecv = Date.now() / 1000; if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) {
          failedOnce = false;
          if (!d) return;
          if (typeof d.delay === "number" && d.delay >= 0 && d.delay < 10) CONFIG.SERVER_DELAY_S = d.delay;
          engine.server(d, tSend, tRecv);
          if (d.recent) guideHistory.set(d.recent);
          if (typeof d.votes === "number") voteState.votes = d.votes;
          if (typeof d.needed === "number") voteState.needed = d.needed;
          if (d.sky && typeof flamingos !== "undefined") flamingos.sky(d.sky, d.now);
          if (typeof d.notes_open === "boolean" && typeof flamingos !== "undefined" && flamingos.setOpen) flamingos.setOpen(d.notes_open);
          nextUp = d.next && d.next.title ? d.next : null;
          tuning.songs(d.id != null ? d.id + "|" + (d.title || "") : d.title, nextUp ? (nextUp.id != null ? nextUp.id + "|" : "") + nextUp.title : null);
          liveChat.set(d.live && d.live.room ? d.live : null);
          loadVibe(d);                     // the map is fetched early; it's lined up by time
          var isNew = d.id != null && d.id !== lastId && d.id !== pendingId;
          if (isNew && lastId !== null && engine.isOn() && typeof d.now === "number") {
            // The server has moved on, but this listener still hears the previous song for a
            // few seconds: show the new title when the new song actually starts here.
            var wait = d.started_at + engine.latency() - d.now;
            if (skipping) {                // our skip: run through the old song's (muted) tail and land on the new one
              skipping = 0;
              // (the fallback, should the fast-forward never finish: as long as it can take)
              tuning.lockIn(Math.max(0, wait) + engine.safeLag() + 4.5);
              pendingId = d.id;
              clearTimeout(pendingTimer);
              engine.rush(engine.toDevice(d.started_at), function () { tuning.lockIn(0.15); pendingId = null; show(d); });
              return;
            }
            if (wait > 0.2) {
              pendingId = d.id;
              clearTimeout(pendingTimer);
              pendingTimer = setTimeout(function () { pendingId = null; show(d); }, Math.min(wait, 20) * 1000);
              return;
            }
          }
          if (d.id === pendingId) return;  // still waiting for that one to be heard
          show(d);
        }).catch(function (err) {
          if (failedOnce) return;
          failedOnce = true;
          console.warn("now-playing failed:", err);
          log.add("error", "Song title unavailable (" + (err && err.message || "network") + ")");
        });
    }
    // The waveform's map for the song on air (see wave.setVibe). Not ready yet (the server
    // works it out in the background): try again a few times.
    var vibeKey = null;
    function loadVibe(d) {
      if (!d.wave || d.wave === vibeKey || typeof d.now !== "number") return;
      vibeKey = d.wave;
      var key = d.wave, start = d.started_at, offset = d.now - Date.now() / 1000;
      (function get(n) {
        fetch(hosts.current() + "/api/wave/" + encodeURIComponent(key))
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (v) {
            if (key !== vibeKey) return;
            var bin = atob(v.data), data = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
            wave.setVibe({ data: data, fps: v.fps || 10, start: start, offset: offset });
            expectEnd(start + Math.floor(data.length / 3) / (v.fps || 10));
          })
          .catch(function () { if (key === vibeKey && n < 6) setTimeout(function () { get(n + 1); }, 4000); });
      })(0);
    }

    // Ask again just as the song on air should end there (its length comes with the waveform's
    // map): the next one's start time is then known well before it reaches this speaker, so
    // the title changes right on its first note. (Every 15 s alone, the title was often
    // seconds late.)
    var endTimer = 0;
    function expectEnd(serverT) {
      clearTimeout(endTimer);
      var ms = (engine.toDevice(serverT) - Date.now() / 1000) * 1000 + 600;
      if (!(ms > 0 && ms < 3 * 3600e3)) return;
      endTimer = setTimeout(function () { poll(); endTimer = setTimeout(poll, 2500); }, ms);
    }

    nowPlaying.poll = poll;
    poll();                                              // show the title before Play is pressed
    // Keep polling while playing, even with the screen off, so the lock screen stays current.
    // While playing, a little more often than this speaker runs behind the server (when a
    // song has no map to say when it ends, that's what keeps its title on time).
    (function every() {
      var ms = engine.isOn() ? clamp((engine.latency() - 2) * 1000, 5000, CONFIG.NOW_PLAYING_EVERY_MS) : CONFIG.NOW_PLAYING_EVERY_MS;
      setTimeout(function () { if (engine.isOn() || !document.hidden) poll(); every(); }, ms);
    })();
    engine.on("track", function () { setTimeout(poll, 1500); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
  }

  /* ---------------- Wave ---------------- */
  var wave = (function () {
    var c = $("wave"), ctx = c.getContext("2d");
    var w = 1, h = 1, dpr = 1, live = false, raf = 0, last = 0;
    var colOn = "#b8894b", colOff = "rgba(95,90,81,0.22)", colBase = "rgba(95,90,81,0.34)";

    function size() {
      // Layout size, not getBoundingClientRect(): that one includes transforms, so a
      // measurement taken mid-flip (card edge-on) came out ~0 px wide and the waveform
      // was drawn one pixel wide, stretched into a solid band
      var cw = c.clientWidth, ch = c.clientHeight;
      if (!cw || !ch) return;              // not laid out yet: keep the last good size
      dpr = Math.min(window.devicePixelRatio || 1, perf.isLite() ? 1 : 2);
      w = Math.max(1, Math.round(cw * dpr));
      h = Math.max(1, Math.round(ch * dpr));
      c.width = w; c.height = h;
      draw(performance.now());
    }
    // Each song's map (vibe.py on the server): bass / mid / high, 10 frames a second.
    // The previous song's map is kept for the few seconds its tail still plays here.
    var vibes = [];                         // [{ data, fps, start, offset }] newest first
    function setVibe(v) { vibes.unshift(v); if (vibes.length > 2) vibes.length = 2; }
    function clearVibe() { vibes.length = 0; }

    function peaksFor(v, n) {
      if (v.peaks && v.peaks.length === n) return v.peaks;
      var frames = Math.floor(v.data.length / 3), out = new Array(n);
      for (var i = 0; i < n; i++) {
        var a = Math.floor(i * frames / n), b = Math.max(a + 1, Math.floor((i + 1) * frames / n)), sum = 0, top = 0;
        for (var f = a; f < b && f < frames; f++) {
          var e = v.data[f * 3] * 0.45 + v.data[f * 3 + 1] * 0.35 + v.data[f * 3 + 2] * 0.2;
          sum += e; if (e > top) top = e;
        }
        out[i] = 0.6 * sum / (b - a) + 0.4 * top;      // mostly the average, a little of the hits
      }
      // stretch between this song's own quiet and loud parts, like SoundCloud's shapes
      var sorted = out.slice().sort(function (x, y) { return x - y; });
      var lo = sorted[Math.floor(n * 0.05)] * 0.7, hi = sorted[n - 1] || 1;
      for (var j = 0; j < n; j++) {
        var x = Math.max(0, Math.min(1, (out[j] - lo) / Math.max(1, hi - lo)));
        out[j] = out[j] < 3 ? 0 : 0.07 + 0.93 * Math.pow(x, 1.35);   // true silence stays flat
      }
      v.peaks = out;
      return out;
    }
    function current() {
      // the song this listener hears now (the newest one whose start has reached them)
      for (var k = 0; k < vibes.length; k++) {
        var v = vibes[k];
        var pos = engine.heardAt() + v.offset - v.start;
        if (pos >= 0) return { v: v, pos: pos, dur: Math.floor(v.data.length / 3) / v.fps };
      }
      return null;
    }
    function clock(sec) {
      sec = Math.max(0, Math.floor(sec));
      return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
    }

    // A window onto the song's waveform, SoundCloud style: the playhead stays in the middle
    // and the song scrolls past it (heard part caramel on the left, what's coming grey on the
    // right). Each bar is BAR_S seconds of the song (about 26 s on screen); the bars right at the playhead also
    // bounce with what's playing this moment, so it feels alive, not just a progress bar.
    var BAR_S = 0.3;
    function draw() {
      ctx.clearRect(0, 0, w, h);
      // times sit at the two ends, centred on the waveform's height; the bars run between them
      var bw = 4 * dpr, gap = 2 * dpr, pitch = bw + gap;
      var lab = 38 * dpr, L = lab, R = w - lab;
      var top = 2 * dpr, bottom = h - 2 * dpr, mid = Math.round(top + (bottom - top) * 0.64);
      var cx = Math.round((L + R) / 2), fade = 26 * dpr;
      var cur = live ? current() : null;
      function edgeAt(x) { return Math.min(1, Math.max(0, Math.min(x - L, R - x - bw) / fade)); }
      function times(a, b) {
        ctx.font = "700 " + (10.5 * dpr) + "px Mulish, system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillStyle = colOn; ctx.textAlign = "left";
        ctx.fillText(a, 2 * dpr, h / 2);
        ctx.fillStyle = colBase; ctx.textAlign = "right";
        ctx.fillText(b, w - 2 * dpr, h / 2);
      }

      drawn = null;
      if (!cur) {                           // stopped / no map yet: a quiet placeholder
        var bars = Math.max(10, Math.floor((R - L + gap) / pitch)), x0 = L + ((R - L) - (bars * pitch - gap)) / 2;
        ctx.fillStyle = colOff;
        for (var i = 0; i < bars; i++) {
          var p0 = 0.16 + 0.05 * Math.sin(i * 0.9), x = x0 + i * pitch;
          ctx.globalAlpha = edgeAt(x);
          ctx.fillRect(x, mid - p0 * (mid - top), bw, p0 * (mid - top));
          ctx.globalAlpha *= 0.45;
          ctx.fillRect(x, mid + dpr, bw, p0 * (bottom - mid) * 0.7);
        }
        ctx.globalAlpha = 1;
        times("0:00", "0:00");
        return;
      }

      var n = Math.max(1, Math.ceil(cur.dur / BAR_S));
      var peaks = peaksFor(cur.v, n);
      var at = cur.pos / BAR_S;              // playhead, in bars (fractional: smooth scroll)
      drawn = { n: n, peaks: peaks, at: at, cx: cx, pitch: pitch, L: L, R: R, fade: fade, bw: bw };
      var first = Math.max(0, Math.floor(at - (cx - L) / pitch) - 1);
      var last = Math.min(n - 1, Math.ceil(at + (R - cx) / pitch) + 1);
      for (var k = first; k <= last; k++) {
        // (whole pixels and each bar's own fixed height: no shimmer as they scroll, no jumping
        // where the heard caramel meets the grey)
        var xk = Math.round(cx + (k - at) * pitch);
        var p = peaks[k];
        var up = Math.round(Math.max(2 * dpr, p * (mid - top)));
        var down = Math.round(Math.max(1 * dpr, p * (bottom - mid) * 0.8));
        var edge = edgeAt(xk);
        if (edge <= 0) continue;
        var heard = xk + bw <= cx;
        ctx.fillStyle = heard ? colOn : colBase;
        ctx.globalAlpha = edge;
        ctx.fillRect(xk, mid - up, bw, up);
        ctx.globalAlpha = edge * 0.45;
        ctx.fillRect(xk, mid + dpr, bw, down);
        if (!heard && xk < cx) {             // the bar the playhead is crossing: part caramel
          ctx.fillStyle = colOn; ctx.globalAlpha = edge;
          ctx.fillRect(xk, mid - up, cx - xk, up);
          ctx.globalAlpha = edge * 0.45;
          ctx.fillRect(xk, mid + dpr, cx - xk, down);
        }
      }
      ctx.globalAlpha = 1;
      // (no playhead line: where caramel turns grey is "now")
      times(clock(cur.pos), clock(cur.dur));
    }
    // how tall the bars are at this spot (0-1; 0 where there are none: before a song's start,
    // past its end, its silent bits), for the pool float riding on them
    var drawn = null;
    function barsAt(px) {
      if (!drawn || !live) return 0;
      var d = drawn, x = px * dpr;
      if (x < d.L || x > d.R) return 0;
      var k = Math.round(d.at + (x - d.cx) / d.pitch), lo = 0;
      for (var j = k - 1; j <= k + 1; j++) if (j >= 0 && j < d.n) lo = Math.max(lo, d.peaks[j] || 0);
      return lo;
    }
    // how visible the bars are at this spot (0-1), the way they're drawn: none where there
    // are none or they've dropped into a silence, and fading out over the window's two ends
    function seenAt(px) {
      if (!drawn || !live) return 0;
      var d = drawn, x = px * dpr;
      var edge = Math.min(1, Math.max(0, Math.min(x - d.L, d.R - x - d.bw) / d.fade));
      return edge * Math.min(1, barsAt(px) / 0.12);
    }
    var shown = true;                       // false while the studio side is facing up
    function loop(t) {
      raf = 0;
      if (!live || !shown || document.hidden) return;
      // every screen refresh, so the scroll is smooth (lite / reduced motion: ~24 fps)
      var interval = perf.isLite() || perf.reducedMotion ? 1000 / 24 : 0;
      if (t - last >= interval - 1) { last = t; draw(t); }
      raf = requestAnimationFrame(loop);
    }
    function kick() { if (!raf && live && shown && !document.hidden) raf = requestAnimationFrame(loop); }

    document.addEventListener("visibilitychange", kick);
    if ("ResizeObserver" in window) new ResizeObserver(size).observe(c);
    else window.addEventListener("resize", size);
    perf.onChange(size);

    return {
      init: size,
      barsAt: barsAt,
      seenAt: seenAt,
      setVibe: setVibe,
      clearVibe: clearVibe,
      setLive: function (on) { if (on === live) return; live = on; if (!on) draw(0); kick(); },
      // the radio side turned away / back: no drawing while nobody can see it
      setShown: function (on) { shown = on; if (on) { size(); kick(); } },
      refreshColors: function () {
        var cs = getComputedStyle(document.body);
        colOn = cs.getPropertyValue("--gold").trim() || colOn;
        colOff = cs.getPropertyValue("--wave-off").trim() || colOff;
        colBase = cs.getPropertyValue("--wave-base").trim() || colBase;
        draw(performance.now());
      }
    };
  })();
  var waveView = wave;                     // (the pool float asks it where the bars are)

  /* ---------------- Glass (three.js) ----------------
     The display and the waveform sit behind a real slab of glass, drawn with three.js
     over each panel:
       - reflection strength from the glass's index of refraction (Fresnel, n = 1.5):
         ~4% face-on, rising steeply at grazing angles and on the bevelled edges
       - thickness: light entering bends (Snell's law); the longer slanted path through
         the edges absorbs more, so the rim darkens and tints like thick glass
       - the card's one moving light reflects off the face and wraps around the bevel as
         it reaches the edge; edges split colour slightly (dispersion) and glow where
         light is trapped inside (total internal reflection)
       - the waveform's bars are refracted through the glass: they bend at the edges
       - fine scratches are dents in the surface that catch the light
     The browser can't hand page text to WebGL, so the display's text is reflected over
     and tinted, not bent. Lite mode / no WebGL: the CSS glass stays. */
  var glass = (function () {
    var VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
    var FRAG = [
      "precision highp float;",
      "varying vec2 vUv;",
      "uniform vec2 uSize; uniform float uRadius, uBevel, uThick, uIor, uBeam, uDark, uHas, uDpr;",
      "uniform vec2 uTilt; uniform vec3 uWell; uniform vec4 uCRect;",
      "uniform sampler2D uScratch, uContent;",
      "float sdRR(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }",
      // the room the glass reflects: a warm ceiling, darker floor, and the card's light strip
      "vec3 env(vec3 r, vec2 p) {",
      "  float up = clamp(r.y * 0.5 + 0.5, 0.0, 1.0);",
      "  vec3 amb = mix(vec3(0.20, 0.17, 0.13), vec3(1.0, 0.97, 0.9), smoothstep(0.15, 0.95, up));",
      "  amb *= mix(0.55, 0.22, uDark);",
      // the strip: a soft band of light above the card (CSS 115deg beam), seen in reflection
      // on the flat face the band sits exactly on the card's light line (like the logo's
      // shine); only the curved edge bends it
      "  vec2 flat0 = p / 1100.0 - uTilt;",
      "  vec2 hit = p + (r.xy / max(r.z, 0.08) - flat0) * 260.0;",
      "  vec2 bn = vec2(0.906, -0.423);",                  // the CSS 115deg beam, with y pointing up
      "  float s = dot(hit - vec2(uBeam, 0.0), bn);",
      "  float band = 0.85 * exp(-s * s / 2800.0) + 0.32 * exp(-s * s / 19000.0);",
      "  vec3 light = vec3(1.0, 0.96, 0.88) * band * mix(1.65, 0.95, uDark);",
      // a second, small key light up-left: makes the bevel catch a highlight at rest
      "  float key = pow(max(dot(normalize(r), normalize(vec3(-0.5, 0.65, 0.58))), 0.0), 20.0) * 0.55;",
      "  return amb + light + vec3(key);",
      "}",
      "float fresnel(float c, float ior) { float f0 = (ior - 1.0) / (ior + 1.0); f0 *= f0; return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }",
      "void main() {",
      "  vec2 p = (vUv - 0.5) * uSize;",
      "  vec2 hb = uSize * 0.5;",
      "  float d = sdRR(p, hb, uRadius);",
      "  if (d > 0.5) { gl_FragColor = vec4(0.0); return; }",
      "  float aa = clamp(0.5 - d, 0.0, 1.0);",
      "  vec2 sg = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);",
      "  vec2 qq = abs(p) - hb + uRadius;",
      "  vec2 g = (qq.x > 0.0 && qq.y > 0.0) ? normalize(qq) * sg : (qq.x > qq.y ? vec2(sg.x, 0.0) : vec2(0.0, sg.y));",
      // bevel: flat face inside, the surface rolls over towards the edge
      "  float t = clamp(1.0 + d / uBevel, 0.0, 1.0);",
      "  float ang = asin(clamp(t, 0.0, 0.999)) * 0.7;",    // a rounded edge, halfway between v21 and v22
      "  vec3 n = normalize(vec3(g * sin(ang), cos(ang)));",
      // scratches: dents in the surface (normal map, made below)
      "  vec4 sc = texture2D(uScratch, vUv);",
      "  sc.a *= 1.0 - smoothstep(0.0, 0.5, t);",          // scratches on the flat face, not the curved edge
      "  n = normalize(n + vec3((sc.rg - 0.5) * 2.0 * 0.25 * sc.a, 0.0));",
      // looking at it: perspective from ~1100 px away, plus the float's slight tilt
      "  vec3 v = normalize(vec3(-p / 1100.0 + uTilt, 1.0));",
      "  float ci = clamp(dot(n, v), 0.001, 1.0);",
      "  vec3 r = reflect(-v, n);",
      // reflection, with dispersion on the edges (red bends least, blue most)
      "  vec3 refl;",
      "  refl = env(r, p) * fresnel(ci, uIor);",
      "  if (t > 0.0) {",                                   // the colour split fades in over the edge
      "    vec3 rr = reflect(-v, normalize(n + vec3(g * 0.012, 0.0)));",
      "    vec3 rb = reflect(-v, normalize(n - vec3(g * 0.012, 0.0)));",
      "    vec3 split = vec3(env(rr, p).r * fresnel(ci, uIor - 0.012), env(r, p).g * fresnel(ci, uIor), env(rb, p).b * fresnel(ci, uIor + 0.018));",
      "    refl = mix(refl, split, smoothstep(0.0, 0.5, t));",
      "  }",
      // thickness: the refracted path (Snell) through the glass, and what it absorbs
      "  float si2 = 1.0 - ci * ci;",
      "  float ct = sqrt(max(0.0, 1.0 - si2 / (uIor * uIor)));",
      "  float path = uThick / max(ct, 0.18) * (1.0 + t * 1.6);",
      "  vec3 absorb = vec3(0.0022, 0.0018, 0.0028) * mix(1.0, 0.7, uDark);",   // faintly warm glass
      "  vec3 T = exp(-absorb * path) * (1.0 - fresnel(ci, uIor));",
      // light trapped inside runs along the edge: a thin bright inner rim; the very edge, seen
      // at a grazing angle, goes dark
      "  float rim = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.15, 0.55, t));",
      "  float beamNear = exp(-pow(dot(p - vec2(uBeam, 0.0), vec2(0.906, -0.423)) / 140.0, 2.0));",
      "  refl += vec3(1.0, 0.95, 0.86) * rim * 0.16 * beamNear * mix(1.0, 0.7, uDark);",   // only where the light is
      "  float edgeDark = smoothstep(0.85, 1.0, t) * 0.08;",
      // scratches catch the light only where it is
      "  refl += vec3(1.0, 0.97, 0.9) * sc.a * (0.012 + 0.32 * beamNear * beamNear) * mix(1.0, 1.4, uDark);",
      "  float dark = clamp(1.0 - (T.r + T.g + T.b) / 3.0 + edgeDark, 0.0, 0.85);",
      "  vec4 outc = vec4(refl, dark);",
      // the waveform panel: what's under the bevel is drawn here, refracted (it bends)
      "  if (uHas > 0.5 && t > 0.0) {",
      "    vec3 rd = refract(-v, n, 1.0 / uIor);",
      "    vec2 q = vec2(p.x + hb.x, hb.y - p.y) + rd.xy / max(-rd.z, 0.2) * uThick * 1.4;",
      "    vec2 cuv = (q - uCRect.xy) / uCRect.zw;",
      "    vec4 c = (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) ? vec4(0.0) : texture2D(uContent, vec2(cuv.x, 1.0 - cuv.y));",
      "    vec3 under = mix(uWell, c.rgb / max(c.a, 0.001), c.a) * T;",
      "    float cover = smoothstep(0.0, 0.12, t);",
      "    outc = vec4(mix(outc.rgb, under + refl, cover), mix(dark, 1.0, cover));",
      "  }",
      "  gl_FragColor = outc * aa;",
      "}"
    ].join("\n");

    var panels = [], running = false, raf = 0, ok = false, floatAnim = null, last = 0;
    var shineEl = null, TAN25 = Math.tan(25 * Math.PI / 180), T3 = null, recheck = false;

    // Scratches as a normal map: each scratch is a groove, its normal points across it
    function scratchTexture(THREE, w, h, count, seed) {
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var x = c.getContext("2d");
      x.fillStyle = "rgba(128,128,0,0)"; x.fillRect(0, 0, w, h);
      var s = seed;
      function rnd() { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }
      x.lineCap = "round";
      for (var i = 0; i < count; i++) {
        var x0 = rnd() * w, y0 = rnd() * h, len = (0.06 + rnd() * 0.22) * Math.max(w, h);
        var a = rnd() * Math.PI, bend = (rnd() - 0.5) * 0.6;
        var x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
        var nx = -Math.sin(a), ny = Math.cos(a);                 // across the scratch
        x.strokeStyle = "rgba(" + Math.round(128 + nx * 120) + "," + Math.round(128 - ny * 120) + ",0," + (0.25 + rnd() * 0.45).toFixed(2) + ")";
        x.lineWidth = 0.5 + rnd() * 0.6;
        x.beginPath();
        x.moveTo(x0, y0);
        x.quadraticCurveTo((x0 + x1) / 2 + nx * len * bend, (y0 + y1) / 2 + ny * len * bend, x1, y1);
        x.stroke();
      }
      var tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.premultiplyAlpha = false;
      return tex;
    }

    function cssColor(name, fallback) {
      var v = getComputedStyle(document.body).getPropertyValue(name).trim();
      var m = /^#([0-9a-f]{6})$/i.exec(v);
      if (!m) return fallback;
      var n = parseInt(m[1], 16);
      return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    }

    function make(THREE, host, opts) {
      var canvas = document.createElement("canvas");
      canvas.className = "glass-gl";
      canvas.setAttribute("aria-hidden", "true");
      host.appendChild(canvas);
      var renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
      } catch (e) { canvas.remove(); return null; }
      renderer.setClearColor(0x000000, 0);
      var scene = new THREE.Scene(), cam = new THREE.Camera();
      var uniforms = {
        uSize: { value: new THREE.Vector2(1, 1) }, uRadius: { value: 20 }, uBevel: { value: 16 },
        uThick: { value: opts.thick }, uIor: { value: 1.5 }, uBeam: { value: 0 }, uDark: { value: 0 },
        uHas: { value: opts.content ? 1 : 0 }, uDpr: { value: 1 }, uTilt: { value: new THREE.Vector2(0, 0) },
        uWell: { value: new THREE.Vector3(0.87, 0.85, 0.81) }, uCRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uScratch: { value: scratchTexture(THREE, 512, 512 * opts.aspect, opts.scratches, opts.seed) },
        uContent: { value: null }
      };
      if (opts.content) {
        var ct = new THREE.CanvasTexture(opts.content);
        ct.minFilter = THREE.LinearFilter; ct.generateMipmaps = false;
        uniforms.uContent.value = ct;
      } else {
        uniforms.uContent.value = uniforms.uScratch.value;
      }
      var mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: uniforms,
        transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      var p = { host: host, canvas: canvas, renderer: renderer, scene: scene, cam: cam, u: uniforms, opts: opts, w: 0, h: 0, visible: true };
      function size() {
        var w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) return;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        p.w = w; p.h = h;
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, false);
        uniforms.uSize.value.set(w, h);
        uniforms.uDpr.value = dpr;
        var cs = getComputedStyle(host);
        uniforms.uRadius.value = parseFloat(cs.borderTopLeftRadius) || 20;
        uniforms.uBevel.value = Math.min(uniforms.uRadius.value * 0.6, 12);
        if (opts.content) {
          var hb = host.getBoundingClientRect(), cb = opts.content.getBoundingClientRect(), k = hb.width / (host.offsetWidth || hb.width) || 1;
          uniforms.uCRect.value.set((cb.left - hb.left) / k, (cb.top - hb.top) / k, (cb.width / k) || 1, (cb.height / k) || 1);
        }
      }
      p.size = size;
      if ("ResizeObserver" in window) new ResizeObserver(size).observe(host);
      size();
      return p;
    }

    // CSS "ease-in-out" = cubic-bezier(0.42, 0, 0.58, 1): find t for x, return y
    function easeInOut(x) {
      var t = x;
      for (var i = 0; i < 6; i++) {
        var xt = 3 * (1 - t) * (1 - t) * t * 0.42 + 3 * (1 - t) * t * t * 0.58 + t * t * t - x;
        var dx = 3 * (1 - t) * (1 - t) * 0.42 + 6 * (1 - t) * t * 0.16 + 3 * t * t * 0.42;
        if (Math.abs(dx) < 1e-6) break;
        t = Math.max(0, Math.min(1, t - xt / dx));
      }
      return 3 * (1 - t) * t * t + t * t * t;
    }
    // Where the card's one light is (same timing as the CSS float: 7 s, ease-in-out):
    // from x = -15% of the card to 45% and back
    function beamPhase() {
      var ct = null;
      try { if (floatAnim && floatAnim.currentTime != null) ct = floatAnim.currentTime; } catch (e) { /* ignore */ }
      if (ct == null) ct = performance.now();
      var u = (ct % 7000) / 3500;
      if (u > 1) u = 2 - u;
      return easeInOut(u);
    }

    function frame(t) {
      raf = 0;
      if (!running || document.hidden) return;
      if (guideUp) { raf = requestAnimationFrame(frame); return; }   // hidden under the paper
      if (t - last > 1000 / 40) {
        last = t;
        // a 3D surface the phone took away while the page was in the background: new glass
        if (recheck) {
          recheck = false;
          panels = panels.map(function (p) {
            var gone = true;
            try { gone = p.renderer.getContext().isContextLost(); } catch (e) { /* treat as lost */ }
            if (!gone || !T3 || !glRebuild("glass")) return p;
            p.canvas.remove();
            try { p.renderer.dispose(); } catch (e) { /* ignore */ }
            return make(T3, p.host, p.opts) || p;
          });
        }
        var card = document.querySelector(".face--front");
        // the radio floating down for skywriting moves under the room's light: the beam
        // slides across the glass and its angle changes (see sky())
        var drop = cardDrop();
        var cb = card && card.getBoundingClientRect();
        var e = beamPhase(), dark = document.body.classList.contains("dark-mode") ? 1 : 0;
        // One light for the whole card: take it from the logo's shine and carry the same
        // slanted line (the CSS 115deg beam leans 25deg) down to each glass panel
        if (!shineEl || !shineEl.isConnected) shineEl = [].slice.call(document.querySelectorAll(".face--front rect.np-shine")).pop() || null;
        var sb = shineEl && shineEl.getBoundingClientRect();
        var useShine = sb && sb.width > 0;
        var well = cssColor("--well", [0.87, 0.85, 0.81]);
        panels.forEach(function (p) {
          if (!p.visible || !p.w) return;
          var hb = p.host.getBoundingClientRect(), k = hb.width / p.w || 1;
          var beamX;
          if (useShine) {
            var sx = (sb.left + sb.right) / 2, sy = (sb.top + sb.bottom) / 2;
            beamX = (sx - (hb.top + hb.height / 2 - sy) * TAN25 - hb.left) / k - p.w / 2;
          } else {
            beamX = cb ? ((cb.left + cb.width * (-0.15 + 0.6 * e)) - hb.left) / k - p.w / 2 : 0;
          }
          p.u.uBeam.value = beamX - drop * TAN25 * 2.4 / k;
          p.u.uTilt.value.set(0, (e - 0.5) * 0.05 - drop * 0.0012);
          p.u.uDark.value = dark;
          p.u.uWell.value.set(well[0], well[1], well[2]);
          if (p.opts.content) p.u.uContent.value.needsUpdate = true;
          p.renderer.render(p.scene, p.cam);
        });
      }
      raf = requestAnimationFrame(frame);
    }
    function start() { if (ok && !running) { running = true; raf = requestAnimationFrame(frame); } }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

    function init() {
      if (ok || perf.isLite() || perf.reducedMotion) return;
      loadThree().then(function (THREE) {
        if (ok || perf.isLite()) return;
        T3 = THREE;
        var plate = document.querySelector(".face--front .plate"), wv = document.querySelector(".face--front .wave");
        var a = plate && make(THREE, plate, { thick: 9, scratches: 9, seed: 7, aspect: 1, content: null });
        var b = wv && make(THREE, wv, { thick: 6, scratches: 5, seed: 11, aspect: 0.25, content: $("wave") });
        panels = [a, b].filter(Boolean);
        if (!panels.length) return;
        ok = true;
        var fw = document.querySelector(".float-wrap");
        try { floatAnim = fw && fw.getAnimations ? fw.getAnimations()[0] : null; } catch (e) { floatAnim = null; }
        document.body.classList.add("glass-on");
        start();
      }).catch(function () { /* no 3D library: the CSS glass stays */ });
    }
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { recheck = true; start(); } });
    perf.onChange(function () {
      if (perf.isLite()) { stop(); document.body.classList.remove("glass-on"); }
      else if (ok) { document.body.classList.add("glass-on"); start(); }
      else init();
    });
    return {
      init: init,
      // the radio side turned away / back
      setShown: function (on) { if (on) start(); else stop(); },
      resize: function () { panels.forEach(function (p) { p.size(); }); }
    };
  })();

  // Rebuilding a lost 3D surface is allowed now and then, never in a rush: with too many 3D
  // surfaces a browser takes one away to make a new one, and rebuilding eagerly made them
  // take each other's place over and over (the page then froze)
  var guideUp = false;      // the guide's paper covers the radio: the 3D glass and sky rest
  var glRebuild = (function () {
    var last = {}, count = {};
    return function (name) {
      var now = Date.now();
      if ((count[name] || 0) >= 3 || now - (last[name] || 0) < 60000) return false;
      last[name] = now; count[name] = (count[name] || 0) + 1;
      return true;
    };
  })();

  // How far the radio has floated down for skywriting at this moment (px, mid-glide too)
  function cardDrop() {
    var f = $("flip");
    if (!f || !document.body.classList.contains("is-skywriting") && !f._gliding) return 0;
    var v = (getComputedStyle(f).translate || "").split(" ");
    return parseFloat(v[1]) || 0;
  }

  /* ---------------- Ambient (Three.js, loaded only when the device can afford it) ---------------- */
  var ambient = (function () {
    var running = false, stopFn = null;
    function load() {
      if (perf.isLite() || perf.reducedMotion) return;
      // the same copy of the 3D library the glass and the keys use (whichever asks first
      // loads it; if it's already there, start straight away)
      loadThree().then(start).catch(function () { /* no 3D library: no background */ });
    }
    function start() {
      if (!window.THREE || perf.isLite() || running) return;
      var THREE = window.THREE;
      var canvas = $("ambient");
      var renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: false, powerPreference: "low-power" }); }
      catch (e) {
        // Safari sometimes refuses a 3D context while others are starting: try once more
        if (!start.retried) { start.retried = true; setTimeout(start, 2500); }
        else log.add("warn", "3D background unavailable in this browser");
        return;
      }
      running = true;
      renderer.setPixelRatio(1);
      renderer.setClearColor(0x000000, 0);
      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.set(0, 0, 12);

      var count = 90, pos = new Float32Array(count * 3);
      for (var i = 0; i < count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 24;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 24;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 16 - 4;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      var points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xb8894b, size: 0.06, transparent: true, opacity: 0.5, depthWrite: false }));
      scene.add(points);

      var grid = new THREE.Mesh(new THREE.PlaneGeometry(32, 32, 20, 20),
        new THREE.MeshBasicMaterial({ color: 0xb8894b, wireframe: true, transparent: true, opacity: 0.1 }));
      grid.rotation.x = -Math.PI / 2.2; grid.position.set(0, -4, -6);
      scene.add(grid);

      // A flock of flamingos flying together across the sky, in a loose V; when they've
      // gone, another flock comes a little later, at another height, either way.
      var FR = 12, atlasCv = flamingoArt.atlas(FR, 128, 64, flamingoArt.colors());
      var flock = [], fl = null;
      if (atlasCv) {
        var tex = new THREE.CanvasTexture(atlasCv);
        tex.repeat.set(1 / FR, 1);
        if ("colorSpace" in tex) tex.colorSpace = THREE.SRGBColorSpace;
        for (var j = 0; j < 11; j++) {
          var m = new THREE.MeshBasicMaterial({ map: tex.clone(), transparent: true, depthWrite: false, opacity: 0.8 });
          m.map.repeat.set(1 / FR, 1);
          m.map.needsUpdate = true;
          var bird = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.55), m);      // (small: far off in the sky)
          bird.visible = false;
          flock.push({ mesh: bird, phase: Math.random() * FR, rate: 0.016 + Math.random() * 0.004, k: j });
          scene.add(bird);
        }
        // light / dark: redraw the drawings in the other colours
        new MutationObserver(function () {
          var c = flamingoArt.atlas(FR, 128, 64, flamingoArt.colors());
          if (c) { atlasCv.getContext("2d").clearRect(0, 0, atlasCv.width, atlasCv.height); atlasCv.getContext("2d").drawImage(c, 0, 0); flock.forEach(function (b) { b.mesh.material.map.needsUpdate = true; }); }
        }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
      }
      var first = true;                                 // (the first flock is already in the sky on arrival)
      function halfWStart() { return 6.5 * camera.aspect + 4; }
      function newFlight(t) {
        var dir = Math.random() < 0.5 ? 1 : -1, n = 7 + Math.floor(Math.random() * 5);
        fl = { dir: dir, y: -2.5 + Math.random() * 6, z: -4 + Math.random() * 4.5, t0: t, n: n,
               speed: 0.0011 + Math.random() * 0.0005, rest: 0, lead: first ? halfWStart() : 0 };
        first = false;
        flock.forEach(function (b, i) {
          b.mesh.visible = i < n;
          b.mesh.scale.x = dir;                         // the drawing faces right
          // a loose V: the leader in front, the others behind on alternate sides
          var row = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
          b.dx = -row * 0.8; b.dy = side * row * 0.2 + (Math.random() - 0.5) * 0.08; b.dz = side * row * 0.14;
        });
      }
      function moveFlock(ts) {
        if (!flock.length) return;
        var halfW = 6.5 * camera.aspect + 4;
        if (!fl) newFlight(ts);
        if (fl.rest) { if (ts > fl.rest) newFlight(ts); return; }
        var x = -halfW + (ts - fl.t0) * fl.speed + (fl.lead || 0);              // the leader's distance along the way
        for (var i = 0; i < fl.n; i++) {
          var b = flock[i];
          var px = x + b.dx;
          b.mesh.position.set(fl.dir * px, fl.y + b.dy + Math.sin(ts * 0.0016 + i) * 0.12 + Math.sin(ts * 0.0004 + i * 1.7) * 0.1, fl.z + b.dz);
          var f = Math.floor((ts * b.rate + b.phase) % FR);       // wing beats, each bird its own timing
          b.mesh.material.map.offset.x = f / FR;
        }
        if (x - 2 * 0.8 * Math.ceil(fl.n / 2) > halfW) {     // the last one is out of sight
          flock.forEach(function (b) { b.mesh.visible = false; });
          fl.rest = ts + 1500 + Math.random() * 3000;
        }
      }

      function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
        camera.updateProjectionMatrix();
      }
      var raf = 0, last = 0;
      function tick(ts) {
        raf = 0;
        if (!running || document.hidden) return;
        raf = requestAnimationFrame(tick);
        if (ts - last < 33 || turning || guideUp) return;      // ~30 fps is plenty; paused during the flip and under the guide
        last = ts;
        var t = ts * 0.0001;
        points.rotation.y = t * 0.3;
        grid.position.y = -4 + Math.sin(t * 1.2) * 0.5;
        moveFlock(ts);
        renderer.render(scene, camera);
      }
      function wake() {
        if (!running || document.hidden) return;
        if (lost() && glRebuild("sky")) { rebuild(); return; }
        if (!raf) raf = requestAnimationFrame(tick);
      }
      // Phones take the 3D drawing surface away from pages that sit in the background for a
      // while (to save memory) and don't always give it back: the sky and the flock then
      // stayed empty until the app was reopened. Now a lost surface is replaced with a new one.
      function lost() { try { return renderer.getContext().isContextLost(); } catch (e) { return true; } }
      function rebuild() {
        stopFn();
        var fresh = canvas.cloneNode(false);
        canvas.parentNode.replaceChild(fresh, canvas);
        setTimeout(start, 300);
      }
      canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); if (raf) cancelAnimationFrame(raf); raf = 0; });
      canvas.addEventListener("webglcontextrestored", function () { if (running) { flock.forEach(function (b) { b.mesh.material.map.needsUpdate = true; }); wake(); } });
      window.addEventListener("resize", resize);
      document.addEventListener("visibilitychange", wake);
      resize(); wake();
      stopFn = function () {
        running = false; if (raf) cancelAnimationFrame(raf); raf = 0;
        window.removeEventListener("resize", resize);
        document.removeEventListener("visibilitychange", wake);
        try { renderer.dispose(); } catch (e) { /* ignore */ }
      };
    }
    perf.onChange(function (lite) { if (lite && stopFn) { stopFn(); stopFn = null; } else if (!lite && !running) load(); });
    return { load: load };
  })();

  /* ---------------- Studio API (controller, under /api/) ---------------- */
  function tzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
  }

  var api = (function () {
    var authLost = function () {};
    function base() { return hosts.current(); }
    function authHeader() { return session && session.token ? "Bearer " + session.token : ""; }

    // FastAPI errors look like {"detail": "message"}
    function fail(status, data, fallback) {
      var msg = data && typeof data.detail === "string" ? data.detail : "";
      var err = new Error(msg || fallback || "Server error (" + status + ")");
      err.status = status;
      if (status === 401 && session) authLost();
      return err;
    }

    function request(method, path, body) {
      if (session && session.demo && path.indexOf("/api/upcoming") !== 0) {
        if (method !== "GET") return Promise.reject(new Error("Demo login: nothing is saved"));
        return Promise.resolve(path === "/api/me" ? { user: session.user, role: session.role } : { items: [], words: [], ttl: 7200 });
      }
      var headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (authHeader()) headers.Authorization = authHeader();
      return fetch(base() + path, {
        method: method, headers: headers, cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body)
      }).catch(function () {
        throw new Error("Can't reach the server");
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw fail(res.status, data);
          return data;
        });
      });
    }

    // Raw file in the body (no multipart), so the progress bar is real
    // ctl (optional) gets an abort() so a cancelled flow stops the upload
    function upload(blob, name, kind, onProgress, ctl) {
      return new Promise(function (resolve, reject) {
        if (session && session.demo) { reject(new Error("Demo login: nothing is saved")); return; }
        var xhr = new XMLHttpRequest();
        if (ctl) ctl.abort = function () { xhr.abort(); };
        xhr.open("PUT", base() + "/api/media?name=" + encodeURIComponent(name) + "&kind=" + encodeURIComponent(kind));
        if (authHeader()) xhr.setRequestHeader("Authorization", authHeader());
        xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
        xhr.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        xhr.onload = function () {
          var data = null;
          try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(fail(xhr.status, data, xhr.status === 413 ? "File is too big" : ""));
        };
        xhr.onerror = function () { reject(new Error("Upload failed. Check your connection.")); };
        xhr.onabort = function () { var e = new Error("Upload cancelled"); e.cancelled = true; reject(e); };
        xhr.send(blob);
      });
    }

    return {
      get: function (p) { return request("GET", p); },
      post: function (p, b) { return request("POST", p, b === undefined ? {} : b); },
      patch: function (p, b) { return request("PATCH", p, b); },
      del: function (p) { return request("DELETE", p); },
      // A file from the API (e.g. the MP3 of a recording) as a Blob
      blob: function (p) {
        var headers = {};
        if (authHeader()) headers.Authorization = authHeader();
        return fetch(base() + p, { headers: headers, cache: "no-store" }).catch(function () {
          throw new Error("Can't reach the server");
        }).then(function (res) {
          if (res.ok) return res.blob();
          return res.json().catch(function () { return null; }).then(function (data) { throw fail(res.status, data); });
        });
      },
      upload: upload,
      onAuthLost: function (fn) { authLost = fn; }
    };
  })();

  /* ---------------- Schedules (the shared station calendar) ---------------- */
  store.del("raadio.schedules.v1");          // the old demo kept these on the device
  var schedules = (function () {
    var items = [];
    var listeners = [];
    function changed() { listeners.forEach(function (fn) { fn(); }); }
    function put(item) {
      for (var i = 0; i < items.length; i++) if (items[i].id === item.id) { items[i] = item; return; }
      items.push(item);
    }
    function path(id) { return "/api/schedule/" + encodeURIComponent(id); }
    return {
      all: function () { return items.slice(); },
      get: function (id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; },
      load: function () {
        if (!session) { items = []; changed(); return Promise.resolve(); }
        return api.get("/api/schedule").then(function (r) { items = (r && r.items) || []; changed(); });
      },
      add: function (data) { return api.post("/api/schedule", data).then(function (it) { put(it); changed(); return it; }); },
      update: function (id, patch) { return api.patch(path(id), patch).then(function (it) { put(it); changed(); return it; }); },
      remove: function (id) {
        return api.del(path(id)).then(function () {
          items = items.filter(function (it) { return it.id !== id; });
          changed();
        });
      },
      clear: function () { items = []; changed(); },
      put: function (it) { put(it); changed(); },
      onChange: function (fn) { listeners.push(fn); }
    };
  })();

  /* ---------------- "Coming up" on the black dashboard ---------------- */
  // Public list from the server, so every listener sees the same "Coming up"
  var news = (function () {
    var el = $("news-list");
    var lastKey = "";
    var upcoming = [];
    function refresh() {
      return api.get("/api/upcoming")
        .then(function (r) { upcoming = (r && r.items) || []; })
        .catch(function () { /* keep the last list */ })
        .then(render);
    }
    function render() {
      var now = new Date();
      var rows = [];
      upcoming.forEach(function (it) {
        var at = new Date(it.at);
        if (!isNaN(at.getTime()) && at >= now) rows.push({ at: at, text: it.name + (it.repeat > 1 ? " ×" + it.repeat : "") });
      });
      CONFIG.ANNOUNCEMENTS.forEach(function (a) {
        var at = new Date(a.at);
        if (!isNaN(at.getTime()) && at >= now) rows.push({ at: at, text: a.text });
      });
      rows.sort(function (a, b) { return a.at - b.at; });
      rows = rows.slice(0, 2);                 // two rows: the display keeps one fixed size

      var key = rows.map(function (r) { return r.at.getTime() + r.text; }).join("|");
      if (key === lastKey && el.childNodes.length) return;
      lastKey = key;

      var frag = document.createDocumentFragment();
      if (!rows.length) {
        var li = document.createElement("li");
        li.className = "news-empty";
        li.textContent = "Nothing scheduled yet";
        frag.appendChild(li);
      }
      rows.forEach(function (r) {
        var li = document.createElement("li");
        var t = document.createElement("time");
        t.className = "news-time";
        t.dateTime = r.at.toISOString();
        t.textContent = fmtSoon(r.at);
        t.title = fmtFull(r.at);
        var s = document.createElement("span");
        s.className = "news-text";
        var inner = document.createElement("span");
        inner.className = "mq";
        inner.textContent = r.text;
        s.appendChild(inner);
        li.appendChild(t); li.appendChild(s);
        frag.appendChild(li);
      });
      el.replaceChildren(frag);
    }
    schedules.onChange(refresh);
    setInterval(refresh, 60000);
    // the next show or announcement starting within `mins` minutes: {text, mins} or null
    function soon(mins) {
      var now = Date.now(), best = null;
      upcoming.map(function (it) { return { at: new Date(it.at).getTime(), text: it.name }; })
        .concat(CONFIG.ANNOUNCEMENTS.map(function (a) { return { at: new Date(a.at).getTime(), text: a.text }; }))
        .forEach(function (r) {
          if (isNaN(r.at) || r.at < now || r.at - now > mins * 60000) return;
          if (!best || r.at < best.at) best = r;
        });
      return best ? { text: best.text, mins: Math.max(1, Math.round((best.at - now) / 60000)) } : null;
    }
    return { render: render, refresh: refresh, soon: soon };
  })();

  /* ---------------- Live chat (while a host is live from the studio) ----------------
     The server says who's live in /now-playing ("live": {title, host, room}). While they
     are, the display shows the newest chat lines instead of "Coming up" (tap them to open
     the chat), and anyone can chat under a name of their choosing. When the stream ends the
     server deletes the chat and the display goes back to normal. Hosts chat from the
     studio (liveStudio) through the same feed and show up marked as hosts. */
  var liveChat = (function () {
    var live = null, msgs = [], lastId = 0, timer = 0, busy = false, listeners = [];
    var box = $("plate-chat"), list = $("chat-list"), form = $("chat-form"), textIn = $("chat-text"), msgEl = $("chat-msg");
    var nameBtn = $("chat-name-btn"), newsList = $("news-list"), label = $("news-label"), plateNews = $("plate-news");
    var plate = document.querySelector(".face--front .plate");
    function base() { return hosts.current(); }
    function auth() { return session && session.token && /^https:/i.test(base()) ? "Bearer " + session.token : ""; }
    function myName() {
      var n = store.get("raadio.chat-name", "");
      return n || "Listener " + (parseInt(deviceId().slice(-4), 36) % 900 + 100);
    }
    function changed() { listeners.forEach(function (fn) { fn(live, msgs); }); }
    function line(m) {
      var li = document.createElement("li");
      li.className = "chat-line" + (m.host ? " is-host" : "");
      var b = document.createElement("b"); b.className = "chat-who"; b.textContent = m.name; b.dir = "auto";
      li.appendChild(b);
      var t = document.createElement("span"); t.className = "chat-text"; t.dir = "auto"; t.textContent = m.text;
      li.appendChild(t);
      return li;
    }
    // a list of the chat (the display's, or the studio's): new lines appear at the bottom
    function renderList(el) {
      if (!el) return;
      var near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      var frag = document.createDocumentFragment();
      if (!msgs.length) {
        var e = document.createElement("li"); e.className = "chat-empty";
        e.textContent = live ? "No messages yet. Say hello to " + live.host + "!" : "The chat is closed.";
        frag.appendChild(e);
      }
      msgs.forEach(function (m) { frag.appendChild(line(m)); });
      el.replaceChildren(frag);
      if (near || el._first !== false) { el.scrollTop = el.scrollHeight; el._first = false; }
    }
    // the station display: "Coming up" becomes the chat, and the display grows to hold it
    var wasOn = false;
    function render() {
      var on = !!live;
      document.body.classList.toggle("is-host-live", on);
      if (plate) plate.classList.toggle("is-chat", on);
      plateNews.classList.toggle("is-chat", on);
      box.hidden = !on;
      newsList.hidden = on;
      setText(label, on ? "Live chat · " + live.room : "Coming up");
      setText(nameBtn, "as " + myName());
      if (on) renderList(list);
      if (on !== wasOn) {
        wasOn = on;
        list._first = true;
        if (on) renderList(list);
        try { window.dispatchEvent(new Event("resize")); } catch (e) { /* old browsers */ }   // the radio re-fits the screen
      }
      changed();
    }
    function schedule() {
      clearTimeout(timer);
      if (!live) return;
      timer = setTimeout(poll, document.hidden ? (engine.isOn() ? 15000 : 30000) : 2000);
    }
    function poll() {
      if (busy) return;
      busy = true;
      fetch(base() + "/api/chat?after=" + lastId + "&t=" + Date.now(), { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) {
          if (!d.live) { set(null); return; }
          if (!live || d.live.room !== live.room) { start(d.live); return; }
          live = d.live;
          var added = false;
          (d.messages || []).forEach(function (m) { if (m.id > lastId) { msgs.push(m); lastId = m.id; added = true; } });
          if (msgs.length > 200) msgs = msgs.slice(-200);
          if (added) render();
        })
        .catch(function () { /* try again next time */ })
        .then(function () { busy = false; schedule(); });
    }
    function start(l) {
      live = l; msgs = []; lastId = 0;
      render();
      busy = false;
      poll();
    }
    // from /now-playing (and the chat feed itself): who's live, or null
    function set(l) {
      if (l && (!live || l.room !== live.room)) { start(l); return; }
      if (l) { live = l; return; }
      if (!live) return;
      live = null; msgs = []; lastId = 0;
      clearTimeout(timer);
      if (document.activeElement === textIn) textIn.blur();
      render();
    }
    function say(text, nameOverride) {
      var headers = { "Content-Type": "application/json" };
      if (auth()) headers.Authorization = auth();
      return fetch(base() + "/api/chat", {
        method: "POST", headers: headers, cache: "no-store",
        body: JSON.stringify({ name: nameOverride || myName(), text: text, d: deviceId() })
      }).catch(function () { throw new Error("Can't reach the radio. Check your connection."); })
        .then(function (r) {
          return r.json().catch(function () { return null; }).then(function (d) {
            if (!r.ok) throw new Error(d && d.detail || "Couldn't send that");
            clearTimeout(timer); busy = false; poll();
            return d;
          });
        });
    }
    function flash(text) {
      msgEl.textContent = text; msgEl.hidden = false;
      clearTimeout(flash.t); flash.t = setTimeout(function () { msgEl.hidden = true; }, 3500);
    }
    // the name: tap "as Listener 482" to change it, right there on the display
    nameBtn.addEventListener("click", function () {
      var inp = document.createElement("input");
      inp.className = "plate-chat-input plate-chat-rename"; inp.maxLength = 24; inp.dir = "auto";
      inp.value = myName(); inp.setAttribute("aria-label", "Your name in the chat"); inp.setAttribute("enterkeyhint", "done");
      nameBtn.hidden = true;
      form.insertBefore(inp, nameBtn);
      inp.focus(); inp.select();
      var done = false;
      function end() {
        if (done) return; done = true;
        var v = inp.value.replace(/\s+/g, " ").trim().slice(0, 24);
        store.set("raadio.chat-name", v);
        inp.remove(); nameBtn.hidden = false;
        setText(nameBtn, "as " + myName());
        textIn.focus();
      }
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); end(); } if (e.key === "Escape") { inp.value = myName(); end(); } });
      inp.addEventListener("blur", end);
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = textIn.value.replace(/\s+/g, " ").trim();
      if (!text) return;
      var send = $("chat-send");
      send.disabled = true; msgEl.hidden = true;
      say(text).then(function () { textIn.value = ""; })
        .catch(function (ex) { flash(ex.message); })
        .then(function () { send.disabled = false; });
    });
    // (typing on the display shouldn't swipe to the next song or tilt anything)
    ["pointerdown", "touchstart"].forEach(function (ev) { box.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true }); });
    document.addEventListener("visibilitychange", function () { if (live && !document.hidden) { clearTimeout(timer); busy = false; poll(); } });
    return {
      set: set, say: say, poll: function () { clearTimeout(timer); busy = false; poll(); },
      state: function () { return live; }, messages: function () { return msgs.slice(); },
      onChange: function (fn) { listeners.push(fn); }, renderList: renderList
    };
  })();

  /* ---------------- Dialog helpers ---------------- */
  // A dialog given an origin (the button that opened it) grows out of that button into the
  // middle of the screen, fading in, and shrinks back into it, fading out, when it closes.
  // Every dialog opens and closes with motion: it grows out of what opened it (d._origin, or
  // else the button that was just pressed), or rises from the middle when there's neither.
  // Lite devices and reduced motion get a quick fade instead (cheap, and no movement).
  var lastPress = null;
  document.addEventListener("pointerdown", function (e) {
    lastPress = (e.target.closest && e.target.closest("button, [role=button], a, label")) || null;
  }, true);
  function popMotion(d) { return typeof d.animate === "function"; }
  function popQuiet() { return perf.reducedMotion || perf.isLite(); }
  function popFrames(d) {
    if (popQuiet()) return [{ opacity: 0 }, { opacity: 1 }];
    var src = d._origin || (lastPress && lastPress.isConnected && !d.contains(lastPress) ? lastPress : null);
    var o = src && src.getBoundingClientRect(), r = d.getBoundingClientRect();
    if (!o || !o.width) return [{ transform: "translateY(16px) scale(0.96)", opacity: 0 }, { transform: "none", opacity: 1 }];
    var dx = (o.left + o.width / 2) - (r.left + r.width / 2), dy = (o.top + o.height / 2) - (r.top + r.height / 2);
    var k = Math.max(0.08, Math.min(0.4, o.width / (r.width || 1)));
    return [{ transform: "translate(" + dx + "px," + dy + "px) scale(" + k + ")", opacity: 0 },
            { transform: "translate(" + dx * 0.2 + "px," + dy * 0.2 + "px) scale(0.9)", opacity: 1, offset: 0.6 },
            { transform: "none", opacity: 1 }];
  }
  function fadeBackdrop(d, on, ms) {
    try { d.animate({ opacity: on ? [0, 1] : [1, 0] }, { duration: ms, pseudoElement: "::backdrop", fill: "forwards" }); } catch (e) { /* older browsers */ }
  }
  function openDialog(d) {
    if (d._closing) { d._closing.cancel(); d._closing = null; }
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); }
    else d.setAttribute("open", "");
    if (popMotion(d)) {
      d.animate(popFrames(d), { duration: popQuiet() ? 160 : 380, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      fadeBackdrop(d, true, popQuiet() ? 160 : 320);
    }
  }
  function closeDialog(d) {
    if (!d.open && !d.hasAttribute("open")) return;
    function shut() {
      d._closing = null;
      if (typeof d.close === "function") { if (d.open) d.close(); }
      else d.removeAttribute("open");
      if (d.getAnimations) d.getAnimations({ subtree: false }).forEach(function (a) { a.cancel(); });
    }
    if (!popMotion(d)) { shut(); return; }
    if (d._closing) return;
    var a = d.animate(popFrames(d).reverse(), { duration: popQuiet() ? 140 : 300, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" });
    fadeBackdrop(d, false, popQuiet() ? 140 : 280);
    d._closing = a;
    a.onfinish = shut;
  }
  Array.prototype.forEach.call(document.querySelectorAll("dialog"), function (d) {
    // Esc: close the same smooth way
    d.addEventListener("cancel", function (e) { if (popMotion(d)) { e.preventDefault(); closeDialog(d); } });
    d.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) { closeDialog(d); return; }
      if (e.target !== d || d.hasAttribute("data-sticky")) return;
      var r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d);
    });
  });

  /* ---------------- Auth + flip ---------------- */
  var flipEl = $("flip");
  var front = $("player"), back = $("studio");
  var authBtn = $("auth-btn"), authIcon = $("auth-icon");
  var session = store.get("raadio.session", null);
  var flipped = false, turning = false;

  function updateAuthButton() {
    authIcon.setAttribute("href", session ? "#i-user" : "#i-login");
    // its scratches and grime follow the icon's shape
    Array.prototype.forEach.call(authBtn.querySelectorAll(".k-wear"), function (u) { u.setAttribute("href", session ? "#i-user" : "#i-login"); });
    authBtn.setAttribute("aria-label", session ? "Open my studio" : "Log in");
    setText($("greeting"), session ? "Signed in as " + session.user : "");
    if (typeof studioChrome !== "undefined") studioChrome.refresh();
    guideRefresh();
  }

  function setInert(el, on) {
    if (on) { el.setAttribute("inert", ""); el.setAttribute("aria-hidden", "true"); }
    else { el.removeAttribute("inert"); el.removeAttribute("aria-hidden"); }
  }

  // 3D flip in two halves. The card grows (or shrinks) at the halfway point, while it
  // is edge-on and invisible, so nothing is re-laid out during the animation itself;
  // the face coming in is painted at that moment too, hidden by the same edge.
  // Background animations (3D backdrop, waveform, floating) pause during the turn.
  var wrapEl = document.querySelector(".float-wrap");
  var HALF_OUT = 300, HALF_IN = 400;
  var EASE_IN = "cubic-bezier(0.5, 0, 0.75, 0)", EASE_OUT = "cubic-bezier(0.25, 1, 0.5, 1)";
  function rot(deg) { return "perspective(1600px) rotateY(" + deg + "deg)"; }

  // Safari keeps an animated layer drawn at the size it had while the card turned (edge-on,
  // a sliver), so after a turn or two the plate stayed blurry for minutes. So for the whole
  // turn the card isn't animated at all: it's held still where its float had got to, and
  // once the turn is over (and its glass has been dropped for a frame) the float starts
  // again from that same point, on a layer Safari draws afresh at full size.
  var floatAt = null;
  function holdFloat() {
    var anim = wrapEl.getAnimations ? wrapEl.getAnimations()[0] : null;
    floatAt = anim ? anim.currentTime : null;
    wrapEl.style.transform = getComputedStyle(wrapEl).transform;
    wrapEl.style.animation = "none";
    wrapEl.style.willChange = "auto";
  }
  // The radio side's drawings with masks and texture filters (the brass name plate above
  // all) are drawn by Safari into images at the size they have on screen, which mid-turn is
  // a sliver, and it kept reusing those images afterwards (the plate stayed blurry for
  // minutes). After a turn back the plate's drawing is swapped for a fresh copy, its shine
  // kept in step, and every other mask or filter is set again, so all of it is drawn anew.
  function redrawRadioSide() {
    var face = document.querySelector(".face--front");
    if (!face) return;
    var art = face.querySelector(".nameplate svg");
    if (art) {
      var was = art.querySelector(".np-shine"), anim = was && was.getAnimations ? was.getAnimations()[0] : null;
      var at = anim ? anim.currentTime : null;
      var fresh = art.cloneNode(true);
      art.replaceWith(fresh);
      if (at != null) fresh.querySelectorAll(".np-shine").forEach(function (el) {
        (el.getAnimations ? el.getAnimations() : []).forEach(function (a) { a.currentTime = at; });
      });
    }
    face.querySelectorAll("[mask], [filter]").forEach(function (el) {
      if (el.closest(".nameplate")) return;
      ["mask", "filter"].forEach(function (name) {
        var v = el.getAttribute(name);
        if (v) { el.removeAttribute(name); el.setAttribute(name, v); }
      });
    });
  }
  // While turning, the studio's radio button isn't pinned (sticky: Safari drew the pinned
  // layer mirrored, mid-turn) but held where the pin had put it, so it doesn't move or hide
  function holdRadio() {
    var r = $("back-btn");
    if (!r) return;
    r.style.position = "sticky";
    var stuck = r.offsetTop;
    r.style.position = "relative"; r.style.top = "0px";
    var free = r.offsetTop;
    r.style.position = r.style.top = "";
    $("studio").style.setProperty("--pin", (stuck - free) + "px");   // (فا beside it is pinned the same way)
  }
  function releaseFloat() {
    if (!flipped) redrawRadioSide();
    flipEl.classList.add("is-repainting");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        flipEl.classList.remove("is-repainting");
        if (turning) return;                 // (a new turn started: it holds the float itself)
        wrapEl.style.animation = wrapEl.style.willChange = wrapEl.style.transform = "";
        var anim = wrapEl.getAnimations ? wrapEl.getAnimations()[0] : null;
        if (anim && floatAt != null) anim.currentTime = floatAt;
      });
    });
  }

  function flip(toBack) {
    if (toBack === flipped || turning) return;
    if (toBack && typeof notesPanel !== "undefined") notesPanel.start();
    if (toBack && typeof liveStudio !== "undefined") liveStudio.opened();
    // birds out on the radio side fly off: the studio card is bigger and they'd stand on it
    if (toBack && typeof flamingos !== "undefined" && flamingos.away) flamingos.away();
    var animated = !perf.reducedMotion && typeof front.animate === "function";
    if (animated) sfx.flip(HALF_OUT + HALF_IN);
    turning = true;
    flipped = toBack;
    log.show(toBack);
    document.body.classList.add("is-turning");
    holdFloat();
    flipEl.classList.add("is-switching");
    if (toBack) {
      back.scrollTop = 0;
      // Fix the current height: the grown size is worked out from it
      flipEl.style.setProperty("--front-h", front.offsetHeight + "px");
      flipEl.style.height = front.offsetHeight + "px";
    } else {
      curator.closed();
    }
    holdRadio();
    var out = toBack ? front : back, inn = toBack ? back : front;
    // Radio -> studio turns one way (angles go down), studio -> radio the other way
    var dir = toBack ? -1 : 1;

    function middle() {
      // Swap faces and resize in one go, while edge-on
      flipEl.classList.toggle("is-flipped", toBack);
      wave.setShown(!toBack);
      glass.setShown(!toBack);
      wrapEl.classList.toggle("is-grown", toBack);
      flipEl.classList.toggle("is-grown", toBack);
      setInert(front, toBack);
      setInert(back, !toBack);
      var target = toBack ? $("back-btn") : authBtn;
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    }
    function finish() {
      if (!toBack) flipEl.style.height = "";
      flipEl.classList.remove("is-switching");
      document.body.classList.remove("is-turning");
      turning = false;
      curator.settled();
      if (toBack) studio.opened();
      releaseFloat();
    }
    if (!animated) { middle(); finish(); return; }

    // If a browser never reports the end of an animation, finish anyway: a flip that
    // never ends would leave the page "turning" (paused animations, buttons ignored)
    var halfDone = false, ended = false;
    function end() { if (ended) return; ended = true; inn.style.transform = ""; finish(); }
    setTimeout(function () {
      if (!halfDone) { halfDone = true; try { a1.cancel(); } catch (e) { /* ignore */ } middle(); }
      end();
    }, HALF_OUT + HALF_IN + 400);

    var a1 = out.animate([{ transform: rot(0) }, { transform: rot(dir * 90) }],
                         { duration: HALF_OUT, easing: EASE_IN, fill: "forwards" });
    a1.onfinish = function () {
      if (halfDone) return;
      halfDone = true;
      // Hold the incoming face edge-on (inline style) until its animation runs, so
      // there's never a frame where it shows flat
      inn.style.transform = rot(-dir * 90);
      middle();
      a1.cancel();
      var a2 = inn.animate([{ transform: rot(-dir * 90) }, { transform: rot(0) }],
                           { duration: HALF_IN, easing: EASE_OUT });
      a2.onfinish = end;
    };
  }

  // Get the studio ready as soon as the button looks about to be used
  ["pointerenter", "pointerdown", "focus"].forEach(function (ev) {
    authBtn.addEventListener(ev, function () { if (session) curator.prewarm(); });
  });

  authBtn.addEventListener("click", function () {
    if (session) { flip(true); return; }
    $("login-error").hidden = true;
    $("login-dialog")._origin = authBtn;          // grows out of the login button
    openDialog($("login-dialog"));
    setTimeout(function () { $("username").focus(); }, 30);
  });
  $("back-btn").addEventListener("click", function () { flip(false); });

  function signedOut(message) {
    session = null;
    store.del("raadio.session");
    updateAuthButton();
    schedules.clear();
    curator.refreshRole();
    if (flipped) flip(false);
    if (message) log.add("warn", message);
  }
  // Any 401 from the server (expired login, password changed, user removed)
  api.onAuthLost(function () { signedOut("Signed out, please log in again"); });

  // Show / hide the password. Back to hidden whenever the login window closes.
  var pwField = $("password"), pwToggle = $("pw-toggle");
  function showPassword(on) {
    pwField.type = on ? "text" : "password";
    pwToggle.setAttribute("aria-pressed", on ? "true" : "false");
    pwToggle.setAttribute("aria-label", on ? "Hide password" : "Show password");
    $("pw-icon").setAttribute("href", on ? "#i-eye-off" : "#i-eye");
  }
  pwToggle.addEventListener("pointerdown", function (e) { e.preventDefault(); });   // keep the keyboard up
  pwToggle.addEventListener("click", function () {
    var end = pwField.value.length;
    showPassword(pwField.type === "password");
    try { pwField.focus({ preventScroll: true }); pwField.setSelectionRange(end, end); } catch (e) { /* ignore */ }
  });
  $("login-dialog").addEventListener("close", function () { showPassword(false); });

  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("login-submit"), err = $("login-error");
    var user = $("username").value.trim(), pass = $("password").value;
    if (!user || !pass) {
      setText(err, user ? "Enter your password" : "Enter your username");
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    setText(btn, "Logging in…");
    err.hidden = true;
    (CONFIG.DEMO_LOGIN ? Promise.resolve({ user: user, role: "member", token: "", demo: true })
      : api.post("/api/login", { username: user, password: pass })).then(function (s) {
      session = { user: s.user, role: s.role || "member", token: s.token, at: Date.now() };
      if (s.demo) session.demo = true;
      store.set("raadio.session", session);
      $("password").value = "";
      updateAuthButton();
      closeDialog($("login-dialog"));
      log.add("ok", "Signed in as " + s.user);
      schedules.load().catch(function (ex) { log.add("error", ex.message); });
      curator.refreshRole();
      curator.prewarm();
      flip(true);
    }).catch(function (ex) {
      setText(err, ex.message || "Login failed");
      err.hidden = false;
    }).then(function () {
      btn.disabled = false;
      setText(btn, "Log in");
    });
  });

  $("logout-btn").addEventListener("click", function () {
    if (!(session && session.demo)) api.post("/api/logout").catch(function () { /* signed out locally either way */ });
    signedOut("");
  });

  /* ---------------- Studio ----------------
     Two actions (Record, Upload). Either one opens the scheduling flow straight away:
       record -> when (calendar + tuner wheels) -> repeat days -> keep a copy? -> done
       upload ->  when -> repeat days -> done
     The file uploads in the background while the time is picked. The local copy is
     dropped when the flow ends; the server deletes its copy after the last airing. */
  var studio = (function () {
    var fileInput = $("audio-upload");
    var queueList = $("queue-list");
    var dlg = $("flow");
    var steps = Array.prototype.slice.call(dlg.querySelectorAll(".step"));
    var TITLES = { record: "Recording", when: "When should it air?", repeat: "Play it again?", keep: "Keep a copy?", done: "All set" };
    var EDIT_TITLES = { when: "Change the air time", repeat: "Play it again?", done: "Saved" };
    var reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    var hour12 = (function () {
      try {
        var o = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
        return o.hourCycle ? (o.hourCycle === "h11" || o.hourCycle === "h12") : !!o.hour12;
      } catch (e) { return false; }
    })();
    var flow = null;

    function pad(n) { return String(n).padStart(2, "0"); }
    // Names on the schedule are at most 60 characters: longer file names are cut
    function shortName(s) {
      s = String(s || "").replace(/\s+/g, " ").trim();
      return s.length > 60 ? s.slice(0, 60).replace(/[\s\-_.,;:(]+$/, "") : s;
    }
    function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
    function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
    function fmtWhen(d) { return fmt(d, { weekday: "long", month: "long", day: "numeric" }) + " at " + fmtClock(d); }

    /* ---- Scheduled list ---- */
    function renderQueue() {
      var items = schedules.all().filter(function (it) { return it.nextAir; })
        .sort(function (a, b) { return a.nextAir < b.nextAir ? -1 : 1; });
      var frag = document.createDocumentFragment();
      if (!items.length) {
        var empty = document.createElement("li");
        empty.className = "queue-empty";
        empty.textContent = "Nothing scheduled. Record or upload something to put it on air.";
        frag.appendChild(empty);
      }
      items.forEach(function (it) {
        var li = document.createElement("li");
        li.className = "queue-item";
        li.dataset.id = it.id;
        var at = new Date(it.nextAir);
        var time = document.createElement("time");
        time.className = "queue-time";
        time.dateTime = it.nextAir;
        time.textContent = fmtSoon(at);
        time.title = fmtFull(at);
        var body = document.createElement("div");
        body.className = "queue-body";
        var name = document.createElement("button");      // tap the name to rename it
        name.type = "button";
        name.className = "queue-name";
        name.textContent = it.name;
        name.title = "Rename";
        name.setAttribute("aria-label", it.name + ", tap to rename");
        var meta = document.createElement("span");
        meta.className = "queue-meta";
        var left = it.remaining || 1;
        meta.appendChild(time);
        meta.appendChild(document.createTextNode(
          (left > 1 ? ", then " + (left - 1) + " more" : "") + (it.createdBy ? " · " + it.createdBy : "")));
        body.appendChild(name); body.appendChild(meta);
        // notes for the other hosts ("bring the jingle", "guest at 9"): anyone can add one
        var notes = it.notes || [];
        var nb = document.createElement("button");
        nb.type = "button";
        nb.className = "queue-notes-btn" + (openNotes[it.id] ? " is-open" : "");
        nb.setAttribute("aria-expanded", openNotes[it.id] ? "true" : "false");
        nb.textContent = notes.length ? notes.length + (notes.length === 1 ? " note" : " notes") : "Add a note";
        body.appendChild(nb);
        var del = document.createElement("button");
        del.type = "button";
        del.className = "queue-del";
        del.setAttribute("aria-label", "Delete " + it.name);
        del.innerHTML = '<svg class="icon icon--sm"><use href="#i-trash"/></svg>';
        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "queue-edit";
        edit.setAttribute("aria-label", "Edit " + it.name);
        edit.innerHTML = '<svg class="icon icon--sm"><use href="#i-edit"/></svg>';
        li.appendChild(body); li.appendChild(edit); li.appendChild(del);
        if (openNotes[it.id]) li.appendChild(notesBox(it));
        frag.appendChild(li);
      });
      queueList.replaceChildren(frag);
    }
    var openNotes = {};
    function notesBox(it) {
      var box = document.createElement("div");
      box.className = "queue-notes";
      var ul = document.createElement("ul");
      ul.className = "qn-list";
      (it.notes || []).forEach(function (n) {
        var li = document.createElement("li");
        li.dataset.note = n.id;
        var who = document.createElement("b"); who.textContent = n.author;
        var t = document.createElement("span"); t.className = "qn-text"; t.textContent = n.text; t.dir = "auto";
        li.appendChild(who); li.appendChild(t);
        var mine = session && (session.user || "").toLowerCase() === (n.author || "").toLowerCase();
        if (mine || (session && session.role === "curator")) {
          var x = document.createElement("button");
          x.type = "button"; x.className = "qn-del"; x.setAttribute("aria-label", "Remove this note");
          x.innerHTML = '<svg class="icon icon--sm"><use href="#i-close"/></svg>';
          li.appendChild(x);
        }
        ul.appendChild(li);
      });
      box.appendChild(ul);
      var f = document.createElement("form");
      f.className = "qn-add";
      var inp = document.createElement("input");
      inp.className = "input"; inp.maxLength = 300; inp.dir = "auto";
      inp.placeholder = "A note for the other hosts"; inp.setAttribute("aria-label", "Note on " + it.name);
      var b = document.createElement("button");
      b.type = "submit"; b.className = "neu-btn notes-btn"; b.textContent = "Add";
      f.appendChild(inp); f.appendChild(b);
      box.appendChild(f);
      return box;
    }
    queueList.addEventListener("submit", function (e) {
      var f = e.target.closest(".qn-add");
      if (!f) return;
      e.preventDefault();
      var id = f.closest(".queue-item").dataset.id, inp = f.querySelector("input"), text = inp.value.trim();
      if (!text) return;
      f.querySelector("button").disabled = true;
      api.post("/api/schedule/" + encodeURIComponent(id) + "/notes", { text: text }).then(function (it) {
        openNotes[id] = true;
        schedules.put(it);
        setTimeout(function () { var again = queueList.querySelector('.queue-item[data-id="' + id + '"] .qn-add input'); if (again) again.focus(); }, 0);
      }).catch(function (ex) { log.add("error", ex.message); f.querySelector("button").disabled = false; });
    });
    schedules.onChange(renderQueue);

    queueList.addEventListener("click", function (e) {
      var nt = e.target.closest(".queue-notes-btn");
      if (nt) {
        var nid = nt.closest(".queue-item").dataset.id;
        openNotes[nid] = !openNotes[nid];
        renderQueue();
        if (openNotes[nid]) { var fi = queueList.querySelector('.queue-item[data-id="' + nid + '"] .qn-add input'); if (fi) fi.focus(); }
        return;
      }
      var qd = e.target.closest(".qn-del");
      if (qd) {
        var sid = qd.closest(".queue-item").dataset.id;
        qd.disabled = true;
        api.del("/api/schedule/" + encodeURIComponent(sid) + "/notes/" + qd.closest("li").dataset.note)
          .then(function (it) { schedules.put(it); })
          .catch(function (ex) { qd.disabled = false; log.add("error", ex.message); });
        return;
      }
      var nameBtn = e.target.closest(".queue-name");
      if (nameBtn) { startRename(nameBtn); return; }
      var edit = e.target.closest(".queue-edit");
      if (edit) { openEdit(schedules.get(edit.closest(".queue-item").dataset.id)); return; }
      var del = e.target.closest(".queue-del");
      if (!del) return;
      var id = del.closest(".queue-item").dataset.id;
      if (!del.classList.contains("confirm")) {          // first tap arms, second deletes
        del.classList.add("confirm");
        del.setAttribute("aria-label", "Tap again to delete");
        setTimeout(function () { del.classList.remove("confirm"); }, 2500);
        return;
      }
      del.disabled = true;
      schedules.remove(id).then(function () {
        log.add("ok", "Removed from the schedule");
      }).catch(function (ex) {
        del.disabled = false;
        log.add("error", ex.message || "Couldn't delete");
      });
    });

    /* ---- Flow plumbing ---- */
    function showStep(name) {
      steps.forEach(function (s) { s.hidden = s.dataset.step !== name; });
      setText($("flow-title"), (flow && flow.kind === "edit" && EDIT_TITLES[name]) || TITLES[name]);
      $("flow-close").hidden = name === "done";
      flow.step = name;
    }

    // Rename inline: Enter or leaving the field saves, Esc puts the old name back
    function startRename(btn) {
      var li = btn.closest(".queue-item");
      var it = schedules.get(li.dataset.id);
      if (!it) return;
      var input = document.createElement("input");
      input.className = "queue-rename";
      input.value = it.name;
      input.maxLength = 60;
      input.setAttribute("aria-label", "New name for " + it.name);
      input.setAttribute("enterkeyhint", "done");
      btn.replaceWith(input);
      input.focus();
      input.select();
      var done = false;
      function end(save) {
        if (done) return;
        done = true;
        var value = input.value.replace(/\s+/g, " ").trim();
        if (!save || value === it.name) { renderQueue(); return; }
        if (value.length < 2) { log.add("error", "Name needs at least 2 characters"); renderQueue(); return; }
        input.disabled = true;
        schedules.update(it.id, { name: value }).then(function (upd) {
          log.add("ok", upd.name === value ? "Renamed to “" + upd.name + "”" : "Renamed to “" + upd.name + "” (name was taken)");
        }).catch(function (ex) {
          log.add("error", ex.message || "Couldn't rename");
          renderQueue();
        });
      }
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); end(true); }
        else if (e.key === "Escape") { e.preventDefault(); end(false); }
      });
      input.addEventListener("blur", function () { end(true); });
    }

    // Edit = the same when/repeat steps, pre-filled, saved with PATCH
    function openEdit(it) {
      if (!it || !it.nextAir) return;
      var next = new Date(it.nextAir);
      var base = dayStart(next).getTime();
      var offsets = [];
      (it.airTimes || []).forEach(function (s) {
        var d = new Date(s);
        if (d < next) return;                                   // already aired
        var k = Math.round((dayStart(d).getTime() - base) / 864e5);
        if (k >= 0 && k <= 6 && offsets.indexOf(k) === -1) offsets.push(k);
      });
      if (offsets.indexOf(0) === -1) offsets.unshift(0);
      openFlow("edit");
      flow.id = it.id;
      flow.name = it.name;
      flow.at = next;
      flow.offsets = offsets.sort(function (a, b) { return a - b; });
      $("flow-file").hidden = false;
      setText($("flow-file-name"), it.name);
      setText($("flow-file-state"), "Editing");
      $("flow-file-state").classList.remove("is-error");
      $("flow-bar").style.transform = "scaleX(1)";
      goWhen();
    }

    function openFlow(kind) {
      flow = { kind: kind, offsets: [0], ctl: {}, pct: 0, media: null, scheduled: false };
      $("flow-file").hidden = true;
      openDialog(dlg);
    }

    function paintFile() {
      if (!flow || !flow.name) return;
      $("flow-file").hidden = false;
      setText($("flow-file-name"), flow.name);
      var state = $("flow-file-state");
      state.classList.toggle("is-error", !!flow.uploadError);
      if (flow.uploadError) setText(state, "Upload failed");
      else if (flow.media) setText(state, "Uploaded");
      else setText(state, "Uploading " + Math.round(flow.pct * 100) + "%");
      $("flow-bar").style.transform = "scaleX(" + (flow.media ? 1 : flow.pct).toFixed(3) + ")";
    }

    function startUpload() {
      var f = flow;
      f.uploadError = null;
      f.upload = api.upload(f.blob, f.name, f.kind, function (p) { f.pct = p; if (flow === f) paintFile(); }, f.ctl)
        .then(function (media) { f.media = media; if (flow === f) paintFile(); return media; });
      f.upload.catch(function (ex) {
        if (ex.cancelled) return;
        f.uploadError = ex;
        if (flow === f) { paintFile(); log.add("error", ex.message || "Upload failed"); }
      });
      paintFile();
    }

    // Closing the dialog any way (x, Esc, auto-close) ends the flow and drops the local copy
    dlg.addEventListener("close", function () {
      var f = flow;
      flow = null;
      if (!f) return;
      stopRecording(true);
      if (!f.scheduled) {
        // Still sending: stop the upload. Fully sent: the server is saving it, so wait and delete it.
        if (f.ctl.abort && f.pct < 1) f.ctl.abort();
        // If the upload already reached the server (or finishes despite the abort), delete it
        if (f.upload) {
          f.upload.then(function (media) {
            return api.del("/api/media/" + encodeURIComponent(media.id));
          }).catch(function () { /* cancelled in time, or the server tidies up within a day */ });
        }
      }
      if (f.url) URL.revokeObjectURL(f.url);
      f.blob = null;
    });
    dlg.addEventListener("cancel", function (e) { if (flow && flow.step === "done") e.preventDefault(); });
    $("flow-close").addEventListener("click", function () { closeDialog(dlg); });

    /* ---- Record ---- */
    var rec = null, recStream = null, recChunks = [], recStart = 0, recTimer = 0;
    var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    if (!canRecord) { $("record-btn").disabled = true; setText($("record-sub"), "Not supported in this browser"); }

    function pickMime() {
      var types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
      return "";
    }
    function extFor(type) { return /mp4/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : "webm"; }

    function stopRecording(discard) {
      clearInterval(recTimer);
      if (rec && rec.state !== "inactive") {
        if (discard) rec.onstop = null;
        try { rec.stop(); } catch (e) { /* already stopped */ }
      }
      if (recStream) recStream.getTracks().forEach(function (t) { t.stop(); });   // microphone off
      recStream = null;
      if (discard) rec = null;
    }

    $("record-btn").addEventListener("click", function () {
      var btn = this;
      btn.classList.add("is-busy");
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
        btn.classList.remove("is-busy");
        openFlow("recording");
        showStep("record");
        recStream = stream;
        var mime = pickMime();
        rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 96000 }) : new MediaRecorder(stream);
        recChunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
        rec.onstop = function () {
          if (!flow) return;
          var type = rec.mimeType || "audio/webm";
          flow.blob = new Blob(recChunks, { type: type });
          flow.ext = extFor(type);
          // Shown to listeners in "Coming up", so no clock time here (the air time sits next to it)
          flow.name = session && session.user ? "Recording by " + session.user : "Studio recording";
          flow.recordedAt = new Date();
          rec = null;
          startUpload();
          goWhen();                               // straight on, no extra confirm
        };
        rec.start(1000);
        recStart = Date.now();
        setText($("rec-clock"), "00:00");
        recTimer = setInterval(function () {
          var s = Math.floor((Date.now() - recStart) / 1000);
          setText($("rec-clock"), pad(Math.floor(s / 60)) + ":" + pad(s % 60));
          if (Date.now() - recStart >= CONFIG.RECORD_MAX_MS) $("rec-stop").click();
        }, 250);
        setTimeout(function () { $("rec-stop").focus(); }, 30);
      }).catch(function () {
        btn.classList.remove("is-busy");
        log.add("error", "Microphone access was blocked");
      });
    });
    $("rec-stop").addEventListener("click", function () { stopRecording(false); });

    /* ---- Upload ---- */
    $("upload-btn").addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i.test(file.name)) {
        log.add("error", "That file isn't audio"); return;
      }
      if (file.size > CONFIG.UPLOAD_MAX_MB * 1048576) {
        log.add("error", "File is over " + CONFIG.UPLOAD_MAX_MB + " MB"); return;
      }
      openFlow("upload");
      flow.blob = file;
      flow.name = shortName(file.name.replace(/\.[a-z0-9]+$/i, ""));
      startUpload();
      goWhen();
    });

    /* ---- When: calendar + tuner ---- */
    var view = null;                               // first day of the month on screen

    function Wheel(values, label, cls, onChange) {
      var el = document.createElement("div");
      el.className = "wheel" + (cls ? " " + cls : "");
      el.tabIndex = 0;
      el.setAttribute("role", "spinbutton");
      el.setAttribute("aria-label", label);
      el.setAttribute("aria-valuemin", "0");
      el.setAttribute("aria-valuemax", String(values.length - 1));
      var list = document.createElement("div");
      list.className = "wheel-list";
      values.forEach(function (v, i) {
        var d = document.createElement("div");
        d.className = "wheel-item";
        d.textContent = v.t;
        d.dataset.i = i;
        list.appendChild(d);
      });
      el.appendChild(list);
      var items = list.children, idx = -1, settle = 0;
      function row() { return items[0] ? items[0].offsetHeight || 36 : 36; }
      function mark(i) {
        if (i === idx) return;
        if (items[idx]) items[idx].classList.remove("on");
        idx = i;
        items[i].classList.add("on");
        el.setAttribute("aria-valuenow", String(i));
        el.setAttribute("aria-valuetext", values[i].t);
      }
      function set(i, smooth) {
        i = clamp(i, 0, values.length - 1);
        el.scrollTo({ top: i * row(), behavior: smooth && !reducedMotion ? "smooth" : "auto" });
        mark(i);
        onChange(values[i].v);
      }
      el.addEventListener("scroll", function () {
        var i = clamp(Math.round(el.scrollTop / row()), 0, values.length - 1);
        if (i !== idx) {
          mark(i);
          if (navigator.vibrate) { try { navigator.vibrate(4); } catch (e) { /* no haptics */ } }
        }
        clearTimeout(settle);
        settle = setTimeout(function () { onChange(values[idx].v); }, 80);
      }, { passive: true });
      el.addEventListener("click", function (e) {
        var it = e.target.closest(".wheel-item");
        if (it) set(+it.dataset.i, true);
      });
      el.addEventListener("keydown", function (e) {
        var d = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
        if (e.key === "Home") d = -idx;
        if (e.key === "End") d = values.length - 1 - idx;
        if (d === undefined) return;
        e.preventDefault();
        set(idx + d, true);
      });
      return {
        el: el,
        setValue: function (v) {
          for (var i = 0; i < values.length; i++) if (values[i].v === v) { set(i, false); return; }
        }
      };
    }

    var tuner = null;
    function buildTuner() {
      var box = $("tuner");
      var hours = [], minutes = [];
      for (var h = 0; h < (hour12 ? 12 : 24); h++) hours.push({ v: h, t: hour12 ? String(h === 0 ? 12 : h) : pad(h) });
      for (var m = 0; m < 60; m++) minutes.push({ v: m, t: pad(m) });
      var ampm = hour12 ? [{ v: 0, t: fmt(new Date(2024, 0, 1, 9), { hour: "numeric", hour12: true }).replace(/[\d\s ]/g, "") || "AM" },
                           { v: 1, t: fmt(new Date(2024, 0, 1, 21), { hour: "numeric", hour12: true }).replace(/[\d\s ]/g, "") || "PM" }] : null;
      tuner = {
        h: Wheel(hours, "Hour", "", function (v) { tuner.hv = v; whenChanged(); }),
        m: Wheel(minutes, "Minute", "", function (v) { tuner.mv = v; whenChanged(); }),
        p: ampm ? Wheel(ampm, "AM or PM", "wheel--ampm", function (v) { tuner.pv = v; whenChanged(); }) : null,
        hv: 0, mv: 0, pv: 0
      };
      box.appendChild(tuner.h.el);
      var sep = document.createElement("span");
      sep.className = "tuner-sep";
      sep.textContent = ":";
      sep.setAttribute("aria-hidden", "true");
      box.appendChild(sep);
      box.appendChild(tuner.m.el);
      if (tuner.p) box.appendChild(tuner.p.el);
    }

    function chosenDate() {
      var h = hour12 ? tuner.hv + 12 * tuner.pv : tuner.hv;
      var d = new Date(flow.date);
      d.setHours(h, tuner.mv, 0, 0);
      return d;
    }

    function whenChanged() {
      if (!flow || flow.step !== "when" || flow.settingUp) return;
      var d = chosenDate();
      setText($("when-summary"), fmtWhen(d));
      var past = d.getTime() < Date.now() + 30000;
      $("when-error").hidden = !past;
      setText($("when-error"), past ? "Pick a time later than now" : "");
      $("when-next").disabled = past;
    }

    function renderCal() {
      var today = dayStart(new Date());
      var first = new Date(view.getFullYear(), view.getMonth(), 1);
      var days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      var lead = first.getDay();                               // Sunday-first grid
      var cells = Math.ceil((lead + days) / 7) * 7;
      setText($("cal-month"), fmt(first, { month: "long", year: "numeric" }));
      $("cal-prev").disabled = first <= new Date(today.getFullYear(), today.getMonth(), 1);
      var frag = document.createDocumentFragment();
      for (var i = 0; i < cells; i++) {
        var d = addDays(first, i - lead);
        var b = document.createElement("button");
        b.type = "button";
        b.className = "cal-day" + (d.getMonth() !== first.getMonth() ? " is-out" : "") + (sameDay(d, today) ? " is-today" : "");
        b.textContent = String(d.getDate());
        b.dataset.t = String(d.getTime());
        b.setAttribute("aria-label", fmt(d, { weekday: "long", month: "long", day: "numeric" }));
        b.setAttribute("aria-pressed", sameDay(d, flow.date) ? "true" : "false");
        if (d < today) b.disabled = true;
        frag.appendChild(b);
      }
      $("cal-grid").replaceChildren(frag);
    }

    $("cal-grid").addEventListener("click", function (e) {
      var b = e.target.closest(".cal-day");
      if (!b || b.disabled || !flow) return;
      flow.date = new Date(+b.dataset.t);
      if (flow.date.getMonth() !== view.getMonth()) view = new Date(flow.date.getFullYear(), flow.date.getMonth(), 1);
      renderCal();
      whenChanged();
    });
    $("cal-prev").addEventListener("click", function () { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); renderCal(); });
    $("cal-next").addEventListener("click", function () { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); renderCal(); });

    function goWhen() {
      if (!tuner) buildTuner();
      var week = $("cal-week");
      if (!week.childNodes.length) {
        for (var i = 0; i < 7; i++) {
          var s = document.createElement("span");
          s.textContent = fmt(new Date(2024, 0, 7 + i), { weekday: "narrow" });   // 7 Jan 2024 was a Sunday
          week.appendChild(s);
        }
      }
      var start = flow.at || defaultAirTime();
      flow.date = dayStart(start);
      view = new Date(start.getFullYear(), start.getMonth(), 1);
      showStep("when");
      renderCal();
      flow.settingUp = true;
      // the wheels have to be visible before they can scroll to a value
      requestAnimationFrame(function () {
        if (!flow) return;
        var h = start.getHours();
        tuner.h.setValue(hour12 ? h % 12 : h);
        tuner.m.setValue(start.getMinutes());
        if (tuner.p) tuner.p.setValue(h >= 12 ? 1 : 0);
        flow.settingUp = false;
        whenChanged();
      });
    }

    $("when-next").addEventListener("click", function () {
      var d = chosenDate();
      if (d.getTime() < Date.now() + 30000) { whenChanged(); return; }
      flow.at = d;
      goRepeat();
    });

    /* ---- Repeat: the chosen day plus any of the next six ---- */
    function goRepeat() {
      var at = flow.at;
      setText($("repeat-lead"), "First airing: " + fmtWhen(at));
      var frag = document.createDocumentFragment();
      for (var k = 0; k < 7; k++) {
        var d = addDays(at, k);
        var b = document.createElement("button");
        b.type = "button";
        b.className = "day-btn" + (k === 0 ? " is-first" : "");
        b.dataset.k = String(k);
        b.setAttribute("aria-pressed", flow.offsets.indexOf(k) !== -1 ? "true" : "false");
        b.setAttribute("aria-label", fmt(d, { weekday: "long", month: "long", day: "numeric" }) + (k === 0 ? ", first airing" : ""));
        if (k === 0) b.setAttribute("aria-disabled", "true");
        b.innerHTML = "<small></small><b></b>";
        b.firstChild.textContent = fmt(d, { weekday: "short" });
        b.lastChild.textContent = String(d.getDate());
        frag.appendChild(b);
      }
      $("day-row").replaceChildren(frag);
      $("repeat-error").hidden = true;
      setText($("schedule-btn"), flow.kind === "edit" ? "Save changes" : "Schedule");
      paintCount();
      showStep("repeat");
    }
    function paintCount() {
      var n = flow.offsets.length;
      setText($("repeat-count"), n === 1 ? "Plays once." : "Plays " + n + " times, at " + fmtClock(flow.at) + " each day.");
    }
    $("day-row").addEventListener("click", function (e) {
      var b = e.target.closest(".day-btn");
      if (!b || !flow) return;
      var k = +b.dataset.k;
      if (k === 0) return;                               // the first airing always stays
      var i = flow.offsets.indexOf(k);
      if (i === -1) flow.offsets.push(k); else flow.offsets.splice(i, 1);
      flow.offsets.sort(function (a, c) { return a - c; });
      b.setAttribute("aria-pressed", i === -1 ? "true" : "false");
      paintCount();
    });
    $("repeat-back").addEventListener("click", function () { goWhen(); });

    $("schedule-btn").addEventListener("click", function () {
      var f = flow, btn = this;
      if (!f) return;
      btn.disabled = true;
      $("repeat-error").hidden = true;
      if (f.kind === "edit") {
        setText(btn, "Saving…");
        schedules.update(f.id, { startsAt: f.at.toISOString(), offsets: f.offsets, tz: tzName() }).then(function () {
          log.add("ok", "Updated “" + f.name + "”");
          if (flow === f) finish();
        }).catch(function (ex) {
          if (flow !== f) return;
          setText($("repeat-error"), ex.message || "Couldn't save the changes");
          $("repeat-error").hidden = false;
        }).then(function () {
          btn.disabled = false;
          setText(btn, "Save changes");
        });
        return;
      }
      var waiting = setInterval(function () {
        if (!f.media && !f.uploadError) setText(btn, "Uploading " + Math.round(f.pct * 100) + "%");
      }, 200);
      var ready = f.uploadError ? (startUpload(), f.upload) : f.upload;    // retry a failed upload once
      ready.then(function (media) {
        return schedules.add({ mediaId: media.id, name: f.name, startsAt: f.at.toISOString(), offsets: f.offsets, tz: tzName() });
      }).then(function () {
        f.scheduled = true;
        log.add("ok", "Scheduled “" + f.name + "”");
        if (flow !== f) return;
        if (f.kind === "recording") showStep("keep"); else finish();
      }).catch(function (ex) {
        if (flow !== f) return;
        setText($("repeat-error"), ex.message || "Couldn't schedule it");
        $("repeat-error").hidden = false;
      }).then(function () {
        clearInterval(waiting);
        btn.disabled = false;
        setText(btn, "Schedule");
      });
    });

    /* ---- Keep a copy (recordings only) ---- */
    function saveBlob(f, blob, ext) {
      if (f.url) URL.revokeObjectURL(f.url);
      f.url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = f.url;
      var when = f.recordedAt || new Date();
      var stamp = when.getFullYear() + "-" + String(when.getMonth() + 1).padStart(2, "0") + "-" + String(when.getDate()).padStart(2, "0") +
                  "-" + String(when.getHours()).padStart(2, "0") + String(when.getMinutes()).padStart(2, "0");
      a.download = "raadio-" + f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + stamp + "." + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    // The server converts the recording to MP3 (plays everywhere, ~0.7 MB a minute).
    // If that fails, the original recording is saved instead.
    $("keep-yes").addEventListener("click", function () {
      var f = flow, btn = this;
      if (!f || !f.media) { finish(); return; }
      btn.disabled = true;
      $("keep-no").disabled = true;
      setText(btn.lastChild, "Preparing MP3…");
      api.blob("/api/media/" + encodeURIComponent(f.media.id) + "/mp3").then(function (mp3) {
        saveBlob(f, mp3, "mp3");
      }).catch(function () {
        if (f.blob) saveBlob(f, f.blob, f.ext || "webm");
        log.add("warn", "Saved the original recording (MP3 conversion failed)");
      }).then(function () {
        btn.disabled = false;
        $("keep-no").disabled = false;
        setText(btn.lastChild, "Save copy");
        if (flow === f) finish();
      });
    });
    $("keep-no").addEventListener("click", function () { finish(); });

    /* ---- Done: confirm, then back to the studio ---- */
    function finish() {
      var f = flow;
      var n = f.offsets.length;
      setText($("done-note"), "Airs " + fmtWhen(f.at) + (n > 1 ? ", then " + (n - 1) + " more " + (n === 2 ? "day" : "days") : "") + ".");
      showStep("done");
      setTimeout(function () {
        // revoke after the download has started
        if (flow === f) closeDialog(dlg);
        back.scrollTop = 0;
      }, 1800);
    }

    renderQueue();
    return {
      opened: function () {
        renderQueue();
        schedules.load().catch(function (ex) { log.add("error", ex.message); });
        curator.opened();
      }
    };
  })();

  /* ---------------- Scrolling text on the black display ----------------
     Text that doesn't fit moves steadily right-to-left, leaves on the left and comes
     back in from the right. Touching it holds it still. No fades at the edges. */
  var marquee = (function () {
    var SPEED = 34;                     // px per second: readable, clearly moving
    var plate = document.querySelector(".plate");
    var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    var runs = [];
    var raf = 0, last = 0, queued = false;

    function measure() {
      queued = false;
      runs.forEach(function (r) { r.el.classList.remove("mq--run"); r.el.style.transform = ""; });
      var keep = runs;
      runs = [];
      if (reduced) return;
      Array.prototype.forEach.call(plate.querySelectorAll(".mq"), function (el) {
        var box = el.parentNode;
        if (el.scrollWidth <= el.clientWidth + 1) return;            // fits: leave it alone
        var old = null;
        for (var i = 0; i < keep.length; i++) if (keep[i].el === el) old = keep[i];
        el.classList.add("mq--run");
        var r = { el: el, box: box, w: el.offsetWidth, cw: box.clientWidth, x: old ? old.x : 0, held: old ? old.held : false };
        if (r.x < -r.w) r.x = r.cw;
        if (r.x > r.cw) r.x = r.cw;
        el.style.transform = "translate3d(" + r.x + "px,0,0)";
        if (!box._mqBound) {
          box._mqBound = true;
          box.addEventListener("pointerdown", function () { runs.forEach(function (q) { if (q.box === box) q.held = true; }); });
        }
        runs.push(r);
      });
      if (runs.length && !raf) { last = 0; raf = requestAnimationFrame(tick); }
    }

    function release() { runs.forEach(function (r) { r.held = false; }); }
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);

    function tick(t) {
      raf = 0;
      if (!runs.length) return;
      var dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      if (!flipped) {
        runs.forEach(function (r) {
          if (r.held) return;
          r.x -= SPEED * dt;
          if (r.x < -r.w) r.x = r.cw;                 // gone on the left: re-enter on the right
          r.el.style.transform = "translate3d(" + r.x.toFixed(1) + "px,0,0)";
        });
      }
      raf = requestAnimationFrame(tick);
    }

    function refresh() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    }
    if (window.MutationObserver) new MutationObserver(refresh).observe(plate, { childList: true, characterData: true, subtree: true });
    if (window.ResizeObserver) new ResizeObserver(refresh).observe(plate);
    else window.addEventListener("resize", refresh);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    return { refresh: refresh };
  })();

  /* ---------------- Curator tools ----------------
     Shown to studio users with the "curator" role: live listener count, listener
     analytics drawn in 3D with Three.js (rotate / zoom / pan, tap for values, export
     as an image, or read it as a table), and the rotation tiers. */
  // three.js r159 from the site itself, not a CDN: one less address abroad (a new version
  // gets a new file name, so it can be cached for long)
  var THREE_URL = "vendor/three-r159.min.js";
  var threeReady = null;
  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (threeReady) return threeReady;
    threeReady = new Promise(function (resolve, reject) {
      var s = document.querySelector('script[src="' + THREE_URL + '"]');
      if (!s) {
        s = document.createElement("script");
        s.src = THREE_URL;
        s.async = true;
        document.head.appendChild(s);
      }
      s.addEventListener("load", function () { resolve(window.THREE); });
      s.addEventListener("error", function () { threeReady = null; reject(new Error("Couldn't load the 3D library")); });
      if (window.THREE) resolve(window.THREE);
    });
    return threeReady;
  }

  /* ---------------- The three keys, as real keycaps (Three.js) ----------------
     Round calculator-style keycaps: a soft dome-edged cap with a visible side wall, lit from
     the card's top-left light, sitting in the card. Each one is drawn by one small shared
     WebGL renderer and copied into a canvas inside its button, and only redrawn when
     something changes (a press, playing / not playing, light / dark), so it costs nothing
     while you just listen. Pressing sinks the cap into the card (the wall disappears
     into it) and the icon, the dirt and the scratches go down with it. Until the 3D library
     loads, and in the lighter mode, the same keycap is drawn in CSS. */
  var keys3d = (function () {
    var PHI = 68 * Math.PI / 180;        // how steeply we look down at the keys
    var CAP_H = 0.6, TRAVEL = 0.6;       // wall height and press depth, in key radii
    var keys = [], THREE = null, renderer = null, scene = null, cam = null, mesh = null, mat = null, ok = false;
    var lightK = null, lightFill = null, hemi = null, clip = null;
    var HEMI_L = 1.92, KEY_L = 1.92, HEMI_D = 1.39, KEY_D = 1.39;     // tuned so the top shows exactly --key-top

    function capGeometry() {
      // profile from the middle of the top, out over a rounded edge and down the wall
      var pts = [], e = 0.2, i;
      pts.push(new THREE.Vector2(0, CAP_H - 0.025));                       // a hair of dish in the top
      pts.push(new THREE.Vector2(0.55, CAP_H - 0.012));
      for (i = 0; i <= 8; i++) {                                           // the rounded top edge
        var a = (i / 8) * Math.PI / 2;
        pts.push(new THREE.Vector2(1 - e + Math.sin(a) * e, CAP_H - e + Math.cos(a) * e));
      }
      pts.push(new THREE.Vector2(1.0, 0.0));
      pts.push(new THREE.Vector2(1.03, -0.6));                             // (hidden in the card)
      return new THREE.LatheGeometry(pts.reverse(), 72);                 // bottom to top: faces point out
    }
    function color(name, fb) {
      var v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return /^#[0-9a-f]{6}$/i.test(v) ? v : fb;
    }
    function setup() {
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
      } catch (e) { return false; }
      renderer.setClearColor(0x000000, 0);
      renderer.localClippingEnabled = true;
      if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
      scene = new THREE.Scene();
      clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);               // the card's surface
      mat = new THREE.MeshStandardMaterial({ color: 0xf2efea, roughness: 0.62, metalness: 0.0, clippingPlanes: [clip] });
      mesh = new THREE.Mesh(capGeometry(), mat);
      scene.add(mesh);
      // neutral white light (the cap keeps exactly its colour on top), mostly from above and
      // the left, so the rounded edge and the wall facing us fall into soft shade and read
      // as an edge, the way the dark keys do
      hemi = new THREE.HemisphereLight(0xffffff, 0x8f8676, 1.5);
      lightK = new THREE.DirectionalLight(0xffffff, 1.5);
      // the card's one light, as the glass has it: from the top left of the screen, a little
      // in front (world: x = right, y = out of the card, -z = up the screen)
      lightK.position.set(-2.5, 2.9, -3.25);
      lightFill = new THREE.DirectionalLight(0xffffff, 0.12);
      lightFill.position.set(2.5, 2.0, 1.0);
      scene.add(hemi, lightK, lightFill);
      cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
      var d = 6;
      cam.position.set(0, CAP_H + Math.sin(PHI) * d, Math.cos(PHI) * d);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, CAP_H, 0);
      return true;
    }

    // Where the canvas sits around the button (the button is the top of the cap)
    // room around the cap for its soft shadow (too little and the shadow was cut off flat)
    var M = { side: 0.55, top: 0.2, bottom: 1.0 };
    function frame(k) {
      var W = k.el.offsetWidth, s = W / 2;                                 // px per key radius
      var topR = Math.sin(PHI);                                            // the top face, seen from above
      var up = topR + M.top, down = topR + CAP_H * Math.cos(PHI) + M.bottom;
      return { W: W, s: s, left: -(1 + M.side), right: 1 + M.side, up: up, down: down,
               cssH: (up + down) * s, offX: -M.side * s, offY: -(up - topR) * s - (k.el.offsetHeight - W * topR) / 2 };
    }
    function draw(k) {
      if (!ok || !k.el.offsetWidth) return;
      // drawn at the screen's full sharpness (up to 3x), and rendered at twice that and
      // scaled down, so the round edges are smooth even where the phone's 3D has no
      // anti-aliasing (that's what made them look pixelated)
      var gone = false;
      try { gone = renderer.getContext().isContextLost(); } catch (e) { gone = true; }
      if (gone) {                     // the phone took the 3D surface away: make a new one
        if (!glRebuild("keys")) return;
        try { renderer.dispose(); } catch (e) { /* ignore */ }
        if (!setup()) return;
      }
      var f = frame(k), dpr = Math.min(window.devicePixelRatio || 1, 3);
      var cssW = Math.round((f.right - f.left) * f.s), ch = Math.round(f.cssH);
      var pw = Math.round(cssW * dpr), ph = Math.round(ch * dpr);
      var ss = Math.max(1, Math.min(2, 1400 / Math.max(pw, ph)));
      if (k.cv.width !== pw || k.cv.height !== ph) { k.cv.width = pw; k.cv.height = ph; }
      k.cv.style.width = cssW + "px";
      k.cv.style.height = ch + "px";
      k.cv.style.left = Math.round(f.offX) + "px";          // whole pixels: no resampling blur
      k.cv.style.top = Math.round(f.offY) + "px";
      // the cap
      var dark = document.body.classList.contains("dark-mode");
      var live = k.hero && (ui.player.classList.contains("is-live") || ui.player.classList.contains("is-connecting"));
      mat.color.set(live ? color("--well", dark ? "#161512" : "#dfd9cf") : color("--key-top", dark ? "#33302a" : "#f2efea"));
      hemi.intensity = dark ? HEMI_D : HEMI_L;
      // floating down for skywriting, the keys pass under the light: it reaches them from
      // higher up the card and a touch dimmer
      var drop = cardDrop();
      lightK.position.set(-2.5, 2.9, -3.25 - drop * 0.03);
      lightK.intensity = (dark ? KEY_D : KEY_L) * (1 - Math.min(drop, 140) * 0.0012);
      var depth = Math.min(1, Math.max(k.press, live ? 0.35 : 0, k.held ? 0.5 : 0));
      if (!(f.s > 0) || !(dpr > 0)) return;
      mesh.position.y = -depth * TRAVEL * CAP_H;
      cam.left = f.left; cam.right = f.right; cam.top = f.up; cam.bottom = -f.down;
      cam.updateProjectionMatrix();
      renderer.setPixelRatio(1);
      renderer.setSize(Math.round(pw * ss), Math.round(ph * ss), false);
      renderer.render(scene, cam);
      var x = k.cv.getContext("2d");
      x.clearRect(0, 0, pw, ph);
      // the shadow on the card: soft, under the lower edge, tighter as the key goes down
      var cx = pw / 2 + f.s * dpr * 0.14, cy = (f.up + Math.sin(PHI) * 0.15 + CAP_H * Math.cos(PHI) * (1 - depth * TRAVEL)) * f.s * dpr;
      var rx = Math.max(1, f.s * dpr * (1.18 - depth * 0.12)), ry = rx * 0.55;
      x.save();
      x.translate(cx, cy); x.scale(1, ry / rx);
      var g = x.createRadialGradient(0, rx * 0.12, rx * 0.5, 0, rx * 0.12, rx);
      var a = (dark ? 0.55 : 0.3) * (1 - depth * 0.4);
      g.addColorStop(0, "rgba(40,30,15," + a + ")"); g.addColorStop(1, "rgba(40,30,15,0)");
      x.fillStyle = g; x.beginPath(); x.arc(0, rx * 0.12, rx, 0, Math.PI * 2); x.fill();
      x.restore();
      x.imageSmoothingEnabled = true;
      try { x.imageSmoothingQuality = "high"; } catch (e) { /* older browsers */ }
      x.drawImage(renderer.domElement, 0, 0, renderer.domElement.width, renderer.domElement.height, 0, 0, pw, ph);
      // the icon, dirt and scratches ride on the cap
      k.el.style.setProperty("--sink", (depth * TRAVEL * CAP_H * Math.cos(PHI) * f.s).toFixed(2) + "px");
    }
    function drawAll() { keys.forEach(draw); }

    function animate(k, to, ms) {
      var from = k.press, t0 = performance.now();
      cancelAnimationFrame(k.raf);
      (function step(t) {
        var u = Math.min(1, Math.max(0, (t - t0) / ms));   // (a frame can be stamped before t0)
        k.press = from + (to - from) * (1 - Math.pow(1 - u, 3));
        draw(k);
        if (u < 1) k.raf = requestAnimationFrame(step);
      })(t0);
    }
    function hook(el, hero) {
      var cv = document.createElement("canvas");
      cv.className = "key-cap";
      cv.setAttribute("aria-hidden", "true");
      el.insertBefore(cv, el.firstChild);
      var k = { el: el, cv: cv, hero: hero, press: 0, held: false, raf: 0 };
      el.addEventListener("pointerdown", function () { animate(k, 1, 80); });
      ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
        el.addEventListener(ev, function () { if (k.press > 0) animate(k, 0, 180); });
      });
      el.addEventListener("keydown", function (e) { if (e.key === " " || e.key === "Enter") { animate(k, 1, 60); setTimeout(function () { animate(k, 0, 160); }, 120); } });
      keys.push(k);
      return k;
    }

    function init() {
      if (ok || perf.isLite() || !window.WebGLRenderingContext) return;
      loadThree().then(function (T) {
        if (ok || perf.isLite()) return;
        THREE = T;
        if (!setup()) return;
        ok = true;
        hook(ui.skipBtn, false); hook(ui.playBtn, true); hook($("save-btn"), false);
        document.body.classList.add("keys-3d");
        drawAll();
        // redraw on the things that change how a key looks
        new MutationObserver(function () { keys.forEach(function (k) { k.held = k.el.getAttribute("aria-pressed") === "true" && !k.hero; }); drawAll(); })
          .observe(document.body, { attributes: true, attributeFilter: ["class"], subtree: false });
        new MutationObserver(drawAll).observe(ui.player, { attributes: true, attributeFilter: ["class"] });
        keys.forEach(function (k) {
          new MutationObserver(function () { k.held = k.el.getAttribute("aria-pressed") === "true" && !k.hero; draw(k); })
            .observe(k.el, { attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
        });
        if ("ResizeObserver" in window) new ResizeObserver(drawAll).observe(ui.skipBtn.parentNode);
        window.addEventListener("resize", drawAll);
      }).catch(function () { /* no 3D library: the CSS keycaps stay */ });
    }
    perf.onChange(function (lite) {
      if (lite) { document.body.classList.remove("keys-3d"); }
      else if (ok) { document.body.classList.add("keys-3d"); drawAll(); }
      else init();
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && ok) drawAll(); });
    return { init: init, redraw: drawAll };
  })();

  var curator = (function () {
    var root = $("curator");
    var range = "week", data = null, open = false;
    var livePoll = 0, statsPoll = 0, statsAt = 0, warm = null, statsKey = "";
    var openTile = null;
    var tiles = Array.prototype.slice.call(root.querySelectorAll(".an-tile"));
    function tile(name) { return root.querySelector('.an-tile[data-tile="' + name + '"]'); }

    // words and dates in the studio's language (Farsi: Persian calendar, Latin digits like the charts)
    function tr(en, fa) { return studioLang === "fa" ? fa : en; }
    function fmtL(date, opts) {
      try { return new Intl.DateTimeFormat(studioLang === "fa" ? "fa-IR-u-nu-latn" : undefined, opts).format(date); }
      catch (e) { return fmt(date, opts); }
    }
    function isCurator() { return !!(session && session.role === "curator"); }
    function n0(v) { return v == null ? "–" : (Math.round(v * 10) / 10).toLocaleString(); }
    function hourLabel(h) { return fmtL(new Date(2024, 0, 1, h), { hour: "numeric" }); }
    function dayName(i) { return fmtL(new Date(2024, 0, 1 + i), { weekday: "short" }); }   // 2024-01-01 was a Monday
    function rangeWord() { return range === "day" ? tr("today", "امروز") : range === "week" ? tr("this week", "این هفته") : tr("this month", "این ماه"); }
    function listenTime(min) {
      if (!min) return tr("0 min", "0 دقیقه");
      if (min < 120) return Math.round(min) + tr(" min", " دقیقه");
      return (min / 60 < 100 ? (Math.round(min / 6) / 10) : Math.round(min / 60)).toLocaleString() + tr(" h", " ساعت");
    }
    var regionName = (function () {
      // the device's language if it's a valid tag, else English; Persian in the Farsi studio
      var dn = null, dnFa = null;
      [navigator.language, "en"].some(function (lang) {
        try { dn = new Intl.DisplayNames([lang], { type: "region" }); return true; } catch (e) { return false; }
      });
      try { dnFa = new Intl.DisplayNames(["fa"], { type: "region" }); } catch (e) { /* (English names, then) */ }
      return function (cc) {
        if (!cc || cc === "??") return tr("Unknown", "نامشخص");
        var names = studioLang === "fa" && dnFa ? dnFa : dn;
        try { return (names && names.of(cc)) || cc; } catch (e) { return cc; }
      };
    })();
    function flag(cc) {
      if (!/^[A-Z]{2}$/.test(cc || "")) return "\u{1F310}";
      return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
    }
    function node(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    // Rough middle of each country (latitude, longitude), for the pins on the globe
    var GEO = {};
    ("AD:42.5,1.5 AE:24,54 AF:33,65 AL:41,20 AM:40,45 AO:-12.5,18.5 AR:-34,-64 AT:47.3,13.3 AU:-25,134 AZ:40.5,47.5 " +
     "BA:44,18 BD:24,90 BE:50.8,4.5 BG:42.7,25.5 BH:26,50.5 BO:-17,-65 BR:-10,-55 BY:53,28 CA:56,-106 CH:47,8 " +
     "CL:-30,-71 CN:35,105 CO:4,-72 CR:10,-84 CU:21.5,-80 CY:35,33 CZ:49.8,15.5 DE:51,10 DK:56,10 DO:19,-70.7 " +
     "DZ:28,3 EC:-2,-77.5 EE:59,26 EG:27,30 ES:40,-4 ET:8,38 FI:64,26 FR:46,2 GB:54,-2 GE:42,43.5 GH:8,-2 GR:39,22 " +
     "HK:22.3,114.2 HR:45.2,15.5 HU:47,20 ID:-5,120 IE:53,-8 IL:31.5,34.8 IN:20,77 IQ:33,44 IR:32,53 IS:65,-18 " +
     "IT:42.8,12.8 JO:31,36 JP:36,138 KE:1,38 KG:41,75 KR:37,127.5 KW:29.5,47.8 KZ:48,68 LB:33.8,35.8 LK:7,81 " +
     "LT:56,24 LU:49.8,6.1 LV:57,25 LY:25,17 MA:32,-5 MD:47,29 MX:23,-102 MY:2.5,112.5 NG:10,8 NL:52.5,5.75 NO:62,10 " +
     "NP:28,84 NZ:-41,174 OM:21,57 PA:9,-80 PE:-10,-76 PH:13,122 PK:30,70 PL:52,20 PT:39.5,-8 QA:25.5,51.25 RO:46,25 " +
     "RS:44,21 RU:60,100 SA:25,45 SE:62,15 SG:1.37,103.8 SI:46,15 SK:48.7,19.5 SY:35,38 TH:15,100 TJ:39,71 TM:40,60 " +
     "TN:34,9 TR:39,35 TW:23.5,121 UA:49,32 UG:1,32 US:38,-97 UY:-33,-56 UZ:41,64 VE:8,-66 VN:16,106 YE:15,48 ZA:-29,24")
      .split(" ").forEach(function (s) { var a = s.split(/[:,]/); GEO[a[0]] = [+a[1], +a[2]]; });

    /* ---------- data ---------- */
    function loadStats() {
      return api.get("/api/curator/stats?range=" + range + "&tz=" + encodeURIComponent(tzName())).then(function (d) {
        statsAt = Date.now();
        var key = range + "|" + JSON.stringify(d.timeline) + JSON.stringify(d.audience || null) + JSON.stringify(d.heat) + JSON.stringify(d.listening || null) + JSON.stringify(d.mostPlayed || null);
        setLive(d.live);
        if (key === statsKey && data) return;
        statsKey = key;
        data = d;
        renderAll();
      }).catch(function (ex) {
        if (ex.status === 403) { root.hidden = true; return; }
        log.add("error", ex.message || tr("Couldn't load the analytics", "آمار بارگیری نشد"));
      });
    }
    function setLive(n) {
      setText($("an-now"), n == null ? "–" : String(n));
    }
    function pollLive() {
      api.get("/api/curator/live").then(function (d) { setLive(d.listeners); }).catch(function () { /* keep the last value */ });
    }

    /* ---------- charts: flat and labeled, drawn to the size of their box ----------
       One accent (the flamingo pink, --an-mark) for the data, warm gray (--an-mark-2) for what
       it's compared with, hairline grid, the axis carrying the values that aren't labeled.
       Every mark names its value on hover and focus (<title>); the open tile has the table. */
    var SVGNS = "http://www.w3.org/2000/svg";
    function svgEl(name, attrs, text) {
      var e = document.createElementNS(SVGNS, name);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    }
    function titled(el, text) { el.appendChild(svgEl("title", {}, text)); return el; }
    function plot(box, label) {
      var w = box.clientWidth, h = box.clientHeight;
      box.replaceChildren();
      if (w < 40 || h < 30) return null;
      var s = svgEl("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h, class: "an-svg", role: "img", "aria-label": label });
      box.appendChild(s);
      return { s: s, w: w, h: h };
    }
    function niceMax(v) {
      if (!(v > 0)) return 1;
      var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
      return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].filter(function (x) { return x >= m - 1e-9; })[0] * p;
    }
    function short(v) { return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K" : String(Math.round(v * 10) / 10); }
    // the y axis: 0 and a round top, as hairlines with their numbers
    function yAxis(c, max, L, T, ph) {
      [0, max].forEach(function (v) {
        var y = T + ph - v / max * ph;
        c.s.appendChild(svgEl("line", { x1: L, x2: c.w, y1: y, y2: y, class: "an-grid" }));
        c.s.appendChild(svgEl("text", { x: L - 5, y: y + 3, "text-anchor": "end", class: "an-tick" }, short(v)));
      });
    }
    // Columns from one baseline. items: [{v, label, tip, tone}] (v null: no data there).
    // Labels along the bottom where there's room; the highest column carries its number.
    function columns(box, items, o) {
      o = o || {};
      var c = plot(box, o.label || "");
      if (!c || !items.length) return;
      var max = niceMax(Math.max.apply(null, items.map(function (it) { return it.v || 0; })));
      var L = o.noAxis ? 0 : 24, T = 14, B = 16, pw = c.w - L, ph = c.h - T - B;
      if (!o.noAxis) yAxis(c, max, L, T, ph);
      else c.s.appendChild(svgEl("line", { x1: 0, x2: c.w, y1: T + ph, y2: T + ph, class: "an-grid" }));
      var slot = pw / items.length, bw = Math.max(2, Math.min(24, slot - 2));
      var top = -1;
      items.forEach(function (it, i) { if (it.v != null && it.v > 0 && (top < 0 || it.v > items[top].v)) top = i; });
      var room = Math.max(1, Math.floor(pw / 36)), every = o.allLabels ? 1 : Math.ceil(items.length / room);
      items.forEach(function (it, i) {
        var x = L + i * slot + (slot - bw) / 2, cx = L + i * slot + slot / 2;
        if (it.v != null && it.v > 0) {
          var hgt = Math.max(1.5, it.v / max * ph), y = T + ph - hgt, r = Math.min(4, bw / 2, hgt);
          var bar = svgEl("path", { class: "an-bar" + (it.tone ? " an-bar--" + it.tone : ""),
            d: "M" + x + " " + (T + ph) + "V" + (y + r) + "Q" + x + " " + y + " " + (x + r) + " " + y +
               "H" + (x + bw - r) + "Q" + (x + bw) + " " + y + " " + (x + bw) + " " + (y + r) + "V" + (T + ph) + "Z" });
          c.s.appendChild(bar);
          if (o.valueEach || i === top) c.s.appendChild(svgEl("text", { x: cx, y: y - 4, "text-anchor": "middle", class: "an-val" }, short(it.v)));
        }
        // the hit area is the whole slot, not just the painted bar
        if (it.tip) c.s.appendChild(titled(svgEl("rect", { x: L + i * slot, y: T, width: slot, height: ph, class: "an-hit" }), it.tip));
        if (it.label && (i % every === 0 || o.allLabels)) c.s.appendChild(svgEl("text", { x: cx, y: c.h - 3, "text-anchor": "middle", class: "an-tick" }, it.label));
      });
    }
    // Lines over the same days: series [{name, values, tone}], the first is the one that matters
    // (accent), the rest are context (gray). Legend at the top, value at the end of the accent line.
    function lines(box, labels, series, label) {
      var c = plot(box, label);
      if (!c || !labels.length) return;
      var all = [];
      series.forEach(function (sr) { sr.values.forEach(function (v) { if (v != null) all.push(v); }); });
      var max = niceMax(Math.max.apply(null, all.concat([0])));
      // legend: a short stroke of each line's color, then its name (a second row if it doesn't fit)
      var lx = 24, ly = 7;
      series.forEach(function (sr) {
        var wd = 22 + sr.name.length * 5.2;
        if (lx > 24 && lx + wd > c.w) { lx = 24; ly += 13; }
        c.s.appendChild(svgEl("line", { x1: lx, x2: lx + 12, y1: ly, y2: ly, class: "an-line an-line--" + sr.tone }));
        c.s.appendChild(svgEl("text", { x: lx + 16, y: ly + 3, class: "an-key" }, sr.name));
        lx += wd;
      });
      var L = 24, T = ly + 15, B = 16, R = 6, pw = c.w - L - R, ph = c.h - T - B;
      yAxis(c, max, L, T, ph);
      function X(i) { return L + (labels.length < 2 ? pw / 2 : i / (labels.length - 1) * pw); }
      function Y(v) { return T + ph - v / max * ph; }
      series.slice().reverse().forEach(function (sr) {          // the accent drawn last, on top
        var d = "";
        sr.values.forEach(function (v, i) { if (v != null) d += (d && sr.values[i - 1] != null ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); });
        if (d) c.s.appendChild(svgEl("path", { d: d, class: "an-line an-line--" + sr.tone }));
      });
      var main = series[0], last = -1;
      main.values.forEach(function (v, i) { if (v != null) last = i; });
      if (last >= 0) {
        c.s.appendChild(svgEl("circle", { cx: X(last), cy: Y(main.values[last]), r: 4, class: "an-dot an-dot--" + main.tone }));
        // beside the dot, kept clear of the legend above the plot
        c.s.appendChild(svgEl("text", { x: X(last) - 7, y: Math.max(T + 8, Y(main.values[last]) - 7), "text-anchor": "end", class: "an-val" }, short(main.values[last])));
      }
      labels.forEach(function (lb, i) {
        c.s.appendChild(svgEl("text", { x: X(i), y: c.h - 3, "text-anchor": i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle", class: "an-tick" }, lb));
        var tip = lb + ": " + series.map(function (sr) { return sr.name + " " + (sr.values[i] == null ? "–" : short(sr.values[i])); }).join(" · ");
        var wd = pw / Math.max(1, labels.length - 1);
        c.s.appendChild(titled(svgEl("rect", { x: X(i) - wd / 2, y: T, width: wd, height: ph, class: "an-hit" }), tip));
      });
    }
    // Horizontal bars as a list: name and value on one line, the bar under them
    function hbars(box, rows, label) {
      box.replaceChildren();
      if (!rows.length) return;
      var max = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
      var ul = node("ul", "an-hb");
      ul.setAttribute("aria-label", label);
      rows.forEach(function (r) {
        var li = node("li");
        li.title = r.name + ": " + r.text;
        var nm = node("span", "an-hb-name", r.name);
        nm.dir = "auto";
        li.appendChild(nm);
        li.appendChild(node("b", "", r.text));
        var track = node("span", "an-hb-track"), fill = node("i");
        fill.style.width = Math.max(3, r.v / max * 100) + "%";
        track.appendChild(fill);
        li.appendChild(track);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    // what each bucket of a range is called on an axis, and in a tooltip
    function bucketLabel(t, i, first) {
      var d = new Date(t * 1000);
      if (range === "day") return d.getHours() % 6 === 0 || first ? fmtL(d, { hour: "numeric" }) : "";
      if (range === "week") return fmtL(d, { weekday: "narrow" });
      return d.getDate() === 1 || i % 7 === 0 ? fmtL(d, { day: "numeric", month: "short" }) : "";
    }
    function bucketName(t) {
      var d = new Date(t * 1000);
      return range === "day" ? fmtL(d, { hour: "numeric" }) : fmtL(d, { weekday: "short", day: "numeric", month: "short" });
    }

    /* ---------- tiles ---------- */
    function renderAll() {
      if (!data) return;
      var aud = data.audience || { countries: [], votes: { total: 0, series: [], top: [] }, skips: { total: 0, series: [], top: [] }, saves: { total: 0, series: [], top: [] } };
      aud.likes = aud.likes || { total: 0, series: [], top: [] };
      renderNow(aud);
      renderGlobe(aud);
      renderTime();
      renderLength();
      renderHeat();
      renderSkips(aud);
      renderLikes(aud);
      renderSaves(aud);
      renderPosters(data.posters || { people: [], unsigned: 0 });
      renderCompare();
      renderPlayed();
    }

    function renderNow(aud) {
      var live = aud.countries.filter(function (c) { return c.now > 0; }).sort(function (a, b) { return b.now - a.now; });
      setText($("an-now-sub"), tr("Average ", "میانگین ") + n0(data.average) + tr(" · peak ", " · بیشترین ") + (data.peak || 0));
      var fl = $("an-now-flags");
      fl.replaceChildren();
      live.slice(0, 5).forEach(function (c) { fl.appendChild(node("span", "", flag(c.cc))); });
      var more = $("an-now-more");
      more.replaceChildren();
      more.appendChild(node("h3", "an-h", tr("Right now", "همین حالا")));
      if (!live.length) more.appendChild(node("p", "an-empty", tr("Nobody is listening at the moment.", "الان کسی گوش نمی‌دهد.")));
      var ul = node("ul", "an-list");
      live.forEach(function (c) {
        var li = node("li");
        li.appendChild(node("span", "an-flag", flag(c.cc)));
        li.appendChild(node("span", "an-name", regionName(c.cc)));
        li.appendChild(node("b", "", String(c.now)));
        ul.appendChild(li);
      });
      more.appendChild(ul);
      if (data.peaks && data.peaks.length) {
        more.appendChild(node("h3", "an-h", tr("Busiest moments ", "شلوغ‌ترین لحظه‌های ") + rangeWord()));
        var pl = node("ul", "an-list");
        data.peaks.forEach(function (p) {
          var li = node("li");
          li.appendChild(node("span", "an-name", fmtL(new Date(p.t * 1000), { weekday: "short", hour: "numeric", minute: "2-digit" })));
          li.appendChild(node("b", "", p.listeners + (p.vsAverage ? "  ·  " + p.vsAverage + "×" : "")));
          pl.appendChild(li);
        });
        more.appendChild(pl);
      }
    }

    function renderGlobe(aud) {
      var cs = aud.countries.filter(function (c) { return c.minutes > 0 || c.now > 0; });
      hbars($("an-globe-chart"), cs.slice(0, 4).map(function (c) {
        return { name: flag(c.cc) + " " + regionName(c.cc), v: c.share, text: Math.round(c.share * 100) + "%" };
      }), tr("Share of listening time by country", "سهم زمان شنیدن به تفکیک کشور"));
      setText($("an-globe-top"), cs.length ? tr("Share of listening time", "سهم زمان شنیدن") : tr("No data yet", "هنوز داده‌ای نیست"));
      var more = $("an-globe-more");
      more.replaceChildren();
      var tbl = node("div", "an-table");
      var head = node("div", "an-tr an-tr--head");
      [tr("Country", "کشور"), tr("Listening", "شنیدن"), tr("Skip votes", "رأی رد"), tr("Downloads", "دانلود")].forEach(function (h) { head.appendChild(node("span", "", h)); });
      tbl.appendChild(head);
      cs.forEach(function (c) {
        var r = node("div", "an-tr");
        var nm = node("span", "an-name");
        nm.appendChild(node("span", "an-flag", flag(c.cc)));
        nm.appendChild(document.createTextNode(regionName(c.cc)));
        if (c.now) nm.appendChild(node("i", "an-now-pill", c.now + tr(" now", " الان")));
        r.appendChild(nm);
        var lt = node("span", "an-share");
        lt.appendChild(node("i", "", ""));
        lt.firstChild.style.width = Math.max(2, Math.round(c.share * 100)) + "%";
        lt.appendChild(node("small", "", listenTime(c.minutes) + " · " + Math.round(c.share * 100) + "%"));
        r.appendChild(lt);
        r.appendChild(node("span", "an-num", String(c.votes)));
        r.appendChild(node("span", "an-num", String(c.saves)));
        tbl.appendChild(r);
      });
      if (!cs.length) more.appendChild(node("p", "an-empty", tr("Countries appear once people listen.", "کشورها وقتی کسی گوش بدهد اینجا می‌آیند.")));
      else more.appendChild(tbl);
      renderCountryDetails(more);
    }

    /* ---------- busiest hours, people, session lengths (data.listening) ---------- */
    function slotLabel(m) {
      return fmtL(new Date(2024, 0, 1, 0, m), m % 60 ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
    }
    function slotRange(m) { return slotLabel(m) + "–" + slotLabel(m + 60); }
    function dayLabel(iso) { var p = iso.split("-"); return fmtL(new Date(+p[0], +p[1] - 1, +p[2]), { weekday: "short", month: "short", day: "numeric" }); }
    function sessionLength(sec) {
      if (sec == null) return null;
      if (sec < 60) return Math.round(sec) + tr(" sec", " ثانیه");
      if (sec < 3600) return Math.round(sec / 60) + tr(" min", " دقیقه");
      var h = Math.floor(sec / 3600), m = Math.round((sec - h * 3600) / 60);
      return h + tr(" h", " ساعت") + (m ? " " + m + tr(" min", " دقیقه") : "");
    }
    function figs(items) {
      var dl = node("dl", "an-figs");
      items.forEach(function (it) {
        var d = node("div", "an-fig");
        d.appendChild(node("dt", "", it[0]));
        d.appendChild(node("dd", "", it[1] == null ? "–" : String(it[1])));
        dl.appendChild(d);
      });
      return dl;
    }
    function peopleFigs(p) {
      return [
        [tr("People a day (average)", "نفر در روز (میانگین)"), p.perDay],
        [tr("Most people in a day", "بیشترین نفر در یک روز"), p.maxDay],
        [tr("Most at once", "بیشترین هم‌زمان"), p.peak]
      ];
    }
    function sessionFigs(s) {
      return [
        [tr("Longest", "طولانی‌ترین"), sessionLength(s.longest)],
        [tr("Shortest", "کوتاه‌ترین"), sessionLength(s.shortest)],
        [tr("Median", "میانه"), sessionLength(s.median)],
        [tr("Average", "میانگین"), sessionLength(s.mean)],
        [tr("Sessions", "نوبت شنیدن"), s.count]
      ];
    }
    // One bar per hour of the day, left to right; the busiest three solid
    function hourBars(hours) {
      var box = node("div", "an-hrs");
      var max = Math.max.apply(null, hours.map(function (h) { return h.avg; }).concat([0])) || 1;
      var tops = hours.slice().sort(function (a, b) { return b.avg - a.avg; }).slice(0, 3).map(function (h) { return h.m; });
      hours.forEach(function (h, i) {
        var col = node("span", h.avg > 0 && tops.indexOf(h.m) >= 0 ? "is-top" : "");
        col.title = slotRange(h.m) + ": " + tr(n0(h.avg) + " listening on average", "میانگین " + n0(h.avg) + " شنونده");
        var bar = node("i");
        bar.style.height = (h.avg > 0 ? Math.max(3, h.avg / max * 100) : 0) + "%";
        col.appendChild(bar);
        if (i % 6 === 0) col.appendChild(node("small", "", slotLabel(h.m)));
        box.appendChild(col);
      });
      box.setAttribute("role", "img");
      box.setAttribute("aria-label", tr("Average listeners for each hour of the day", "میانگین شنونده‌ها در هر ساعت از روز"));
      return box;
    }
    function topHours(top) {
      var ul = node("ul", "an-list an-tops");
      top.forEach(function (h) {
        var li = node("li");
        li.appendChild(node("span", "an-name", slotRange(h.m)));
        li.appendChild(node("span", "", ""));
        li.appendChild(node("b", "", tr(n0(h.avg) + " avg", "میانگین " + n0(h.avg)) + (h.people ? tr(" · up to " + h.people + (h.people === 1 ? " person" : " people"), " · تا " + h.people + " نفر") : "")));
        ul.appendChild(li);
      });
      return ul;
    }
    function zoneNote() {
      var tz = (data.listening && data.listening.tz) || "UTC", off = "";
      try {
        off = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date())
          .filter(function (p) { return p.type === "timeZoneName"; })[0].value;
      } catch (e) { /* (the name alone, then) */ }
      var name = tz + (off ? " (" + off + ")" : "");
      return node("p", "an-note", tr("Hours are in this device's time zone: " + name + ". \"Avg\" is how many were listening at that time, averaged over the period.",
        "ساعت‌ها به وقت این دستگاه است: " + name + ". «میانگین» یعنی چند نفر در آن ساعت گوش می‌دادند، به طور میانگین در این دوره."));
    }
    // Plainly what's measured since when: nothing before these dates exists
    function fromNote() {
      var ls = data.listening, day = function (ts) { return fmtL(new Date(ts * 1000), { month: "short", day: "numeric", year: "numeric" }); };
      var from = ls.sessionsFrom || ls.peopleFrom;
      return node("p", "an-note", from
        ? tr("People and session lengths have been recorded since " + day(Math.min(ls.sessionsFrom || from, ls.peopleFrom || from)) + "; nothing earlier exists. Listening hours go further back.",
             "تعداد نفرها و طول شنیدن از " + day(Math.min(ls.sessionsFrom || from, ls.peopleFrom || from)) + " ثبت می‌شود و پیش از آن داده‌ای نیست. ساعت‌های شنیدن قدیمی‌ترند.")
        : tr("People and session lengths are recorded from this update on, so there's no history for them yet. Listening hours go further back.",
             "تعداد نفرها و طول شنیدن از همین به‌روزرسانی ثبت می‌شود و هنوز سابقه‌ای ندارد. ساعت‌های شنیدن قدیمی‌ترند."));
    }
    function howCounted() {
      return node("p", "an-note", tr("From the web player only. A person is one internet address, so a household sharing one counts once. A session ends after 3 minutes without the player; a server restart splits it. Addresses are never stored.",
        "فقط از پخش‌کننده‌ی وب. هر نفر یعنی یک نشانی اینترنتی، پس خانواده‌ای با یک نشانی یک نفر حساب می‌شود. نوبت شنیدن پس از 3 دقیقه بی‌خبری از پخش‌کننده تمام می‌شود و راه‌اندازی دوباره‌ی سرور آن را دو تکه می‌کند. نشانی‌ها هرگز ذخیره نمی‌شوند."));
    }
    function renderCountryDetails(more) {
      var ls = data.listening;
      if (!ls) return;
      var was = {};
      var list = ls.countries.filter(function (c) { return c.minutes > 0 || c.sessions.count > 0; });
      Array.prototype.forEach.call(root.querySelectorAll(".an-cc[open]"), function (d) { was[d.dataset.cc] = true; });
      if (!list.length) return;
      more.appendChild(node("h3", "an-h", tr("Each country: hours, people, how long", "هر کشور: ساعت‌ها، نفرها، مدت")));
      more.appendChild(zoneNote());
      list.forEach(function (c, i) {
        var d = node("details", "an-cc");
        d.dataset.cc = c.cc;
        if (was[c.cc] || (i === 0 && !Object.keys(was).length)) d.open = true;
        var sum = node("summary");
        sum.appendChild(node("span", "an-flag", flag(c.cc)));
        sum.appendChild(node("span", "an-name", regionName(c.cc)));
        sum.appendChild(node("b", "", listenTime(c.minutes) + " · " + Math.round(c.share * 100) + "%"));
        d.appendChild(sum);
        var body = node("div", "an-cc-body");
        if (c.minutes > 0) { body.appendChild(hourBars(c.hours)); body.appendChild(topHours(c.top)); }
        body.appendChild(figs(peopleFigs(c.people).concat(sessionFigs(c.sessions))));
        d.appendChild(body);
        more.appendChild(d);
      });
      more.appendChild(fromNote());
      more.appendChild(howCounted());
    }
    // The 10 most played, this week and this month, and why the station picked each
    function whyWord(r) {
      return ({ pinned: tr("Pinned in the channel", "سنجاق‌شده در کانال"), "new": tr("Newly added", "تازه اضافه‌شده"),
                summer: tr("Summer song", "آهنگ تابستانی"),
                rotation: tr("Random rotation", "چرخش تصادفی") })[r] || r;
    }
    function playedList(items) {
      var ol = node("ol", "an-plays");
      items.forEach(function (s) {
        var li = node("li");
        var top = node("div", "an-play-top");
        var t = node("span", "an-name", s.title); t.dir = "auto";
        top.appendChild(t);
        top.appendChild(node("b", "", s.plays + "×"));
        li.appendChild(top);
        if (s.why) {
          var why = node("div", "an-play-why");
          Object.keys(s.why).sort(function (a, b) { return s.why[b] - s.why[a]; }).forEach(function (r) {
            why.appendChild(node("span", "an-why an-why--" + r, whyWord(r) + " " + s.why[r] + "×"));
          });
          li.appendChild(why);
          var bits = [s.likes + tr(s.likes === 1 ? " like" : " likes", " پسند"), s.votes + tr(s.votes === 1 ? " skip vote" : " skip votes", " رأی رد")];
          if (s.posted) bits.push(tr("added ", "افزوده ") + fmtL(new Date(s.posted * 1000), { month: "short", day: "numeric", year: "numeric" }));
          li.appendChild(node("small", "an-play-info", bits.join(" · ")));
        }
        ol.appendChild(li);
      });
      return ol;
    }
    function renderPlayed() {
      var mp = data.mostPlayed;
      if (!mp) return;
      var box = $("an-played-chart"), first = mp.week.length ? mp.week : mp.allTime;
      hbars(box, first.slice(0, 3).map(function (s) { return { name: s.title, v: s.plays, text: s.plays + "×" }; }), tr("Most played songs", "پرپخش‌ترین آهنگ‌ها"));
      setText($("an-played-sub"), mp.week.length ? tr(mp.plays.week + " plays in the last 7 days", mp.plays.week + " پخش در 7 روز اخیر") : tr("All time, until this week's list fills", "همه‌ی زمان‌ها، تا پر شدن فهرست این هفته"));
      var more = $("an-played-more");
      more.replaceChildren();
      [[tr("Last 7 days: top 10", "7 روز اخیر: 10 تای اول"), mp.week], [tr("Last 30 days: top 10", "30 روز اخیر: 10 تای اول"), mp.month]].forEach(function (sec) {
        more.appendChild(node("h3", "an-h", sec[0]));
        if (sec[1].length) more.appendChild(playedList(sec[1]));
        else more.appendChild(node("p", "an-empty", tr("Nothing recorded yet.", "هنوز چیزی ثبت نشده.")));
      });
      var day = mp.since ? fmtL(new Date(mp.since * 1000), { month: "short", day: "numeric", year: "numeric" }) : null;
      more.appendChild(node("p", "an-note", (day
        ? tr("Plays and their reasons have been recorded since " + day + "; nothing earlier exists, so the lists fill up as songs play.", "پخش‌ها و دلیلشان از " + day + " ثبت می‌شود و پیش از آن داده‌ای نیست.")
        : tr("Plays and their reasons are recorded from this update on.", "پخش‌ها و دلیلشان از همین به‌روزرسانی ثبت می‌شود."))));
      more.appendChild(node("p", "an-note", tr("Why: each play shows the slot that picked it. Random rotation is a shuffle of the whole channel. Likes never pick a song: they only cancel skip votes, which keeps it from dropping to a tier that plays less, so they're shown beside the reasons.",
        "دلیل: هر پخش نشان می‌دهد کدام نوبت آن را انتخاب کرده. چرخش تصادفی یعنی بُر زدن همه‌ی کانال. پسند هرگز آهنگی را انتخاب نمی‌کند: فقط رأی رد را خنثی می‌کند تا آهنگ به رده‌ی کم‌پخش‌تر نیفتد، برای همین کنار دلیل‌ها نشان داده می‌شود.")));
      if (mp.allTime.length) {
        more.appendChild(node("h3", "an-h", tr("All time: top 10", "همه‌ی زمان‌ها: 10 تای اول")));
        more.appendChild(playedList(mp.allTime));
      }
    }
    function renderLength() {
      var ls = data.listening, s = ls && ls.overall.sessions;
      var has = !!(s && s.count);
      setText($("an-length"), has ? sessionLength(s.median) : "–");
      setText($("an-length-unit"), tr("median", "میانه"));
      setText($("an-length-sub"), has ? tr("Longest ", "طولانی‌ترین ") + sessionLength(s.longest) : tr("Recording started", "ثبت شروع شده"));
      var names = { lt5: ["<5m", "<5د"], "5to15": ["5–15m", "5–15د"], "15to30": ["15–30m", "15–30د"], "30to60": ["30–60m", "30–60د"], "1to2h": ["1–2h", "1–2س"], gt2h: ["2h+", "2س+"] };
      var box = $("an-length-chart");
      if (has) columns(box, ls.overall.bands.map(function (b) {
        var nm = tr(names[b.band][0], names[b.band][1]);
        return { v: b.n, label: nm, tip: nm + ": " + b.n };
      }), { label: tr("Sessions by length", "نوبت‌ها به تفکیک مدت"), noAxis: true, allLabels: true });
      else box.replaceChildren();
      var more = $("an-length-more");
      more.replaceChildren();
      if (!ls) return;
      if (has) {
        more.appendChild(figs(sessionFigs(s).concat([[tr("Total in sessions", "مجموع نوبت‌ها"), sessionLength(s.total)], [tr("Tune-ins under 30 sec", "کمتر از 30 ثانیه"), s.brief]])));
        var rows = ls.countries.filter(function (c) { return c.sessions.count > 0; });
        more.appendChild(node("h3", "an-h", tr("By country", "به تفکیک کشور")));
        var tbl = node("div", "an-table an-table--len");
        var head = node("div", "an-tr an-tr--head");
        [tr("Country", "کشور"), tr("Sessions", "نوبت"), tr("Median", "میانه"), tr("Longest", "بیشترین"), tr("Shortest", "کمترین")].forEach(function (h) { head.appendChild(node("span", "", h)); });
        tbl.appendChild(head);
        rows.forEach(function (c) {
          var r = node("div", "an-tr");
          var nm = node("span", "an-name");
          nm.appendChild(node("span", "an-flag", flag(c.cc)));
          nm.appendChild(document.createTextNode(regionName(c.cc)));
          r.appendChild(nm);
          [c.sessions.count, sessionLength(c.sessions.median), sessionLength(c.sessions.longest), sessionLength(c.sessions.shortest)].forEach(function (v) { r.appendChild(node("span", "an-num", String(v))); });
          tbl.appendChild(r);
        });
        more.appendChild(tbl);
      }
      more.appendChild(fromNote());
      more.appendChild(howCounted());
    }

    // Average listeners per hour (a day) or per stretch of hours / day: one column each,
    // empty stretches left empty (nobody measured), not drawn as zero
    function renderTime() {
      setText($("an-avg"), n0(data.average));
      var bucket = data.bucket || 3600, from = data.from || 0, to = data.to || 0;
      var n = Math.max(1, Math.min(60, Math.round((to - from) / bucket)));
      var slots = [];
      for (var i = 0; i < n; i++) slots.push({ t: from + i * bucket, avg: null, max: null });
      (data.timeline || []).forEach(function (p) {
        var k = Math.floor((p.t - from) / bucket);
        if (k >= 0 && k < n) { slots[k].avg = p.avg; slots[k].max = p.max; }
      });
      var lastDay = -1, lastAt = -9;
      columns($("an-time-chart"), slots.map(function (sl, k) {
        var d = new Date(sl.t * 1000), label = "";
        if (range === "day") label = d.getHours() % 6 === 0 ? fmtL(d, { hour: "numeric" }) : "";
        else if (range === "week") {                  // one letter a day, near its middle, never crowded
          if (d.getDay() !== lastDay && d.getHours() >= 8) { lastDay = d.getDay(); if (k - lastAt >= 3) { label = fmtL(d, { weekday: "narrow" }); lastAt = k; } }
        }
        else label = k % 7 === 0 ? fmtL(d, { day: "numeric", month: "short" }) : "";
        return { v: sl.avg, label: label, tip: bucketName(sl.t) + ": " + (sl.avg == null ? tr("no data", "بدون داده") : tr(n0(sl.avg) + " on average, " + sl.max + " at most", "میانگین " + n0(sl.avg) + "، حداکثر " + sl.max)) };
      }), { label: tr("Average listeners ", "میانگین شنونده‌ها ") + rangeWord(), allLabels: range === "week" });
      setText($("an-time-sub"), tr("Most at once: ", "بیشترین هم‌زمان: ") + (data.peak || 0));
      var more = $("an-time-more");
      more.replaceChildren();
      more.appendChild(node("p", "an-note", tr("Each column is the average number of people listening " +
        (range === "day" ? "in that hour" : range === "week" ? "in that stretch of hours" : "that day") + ". Hover or tap a column for its numbers.",
        "هر ستون میانگین تعداد شنونده‌ها " + (range === "day" ? "در آن ساعت" : range === "week" ? "در آن چند ساعت" : "در آن روز") + " است. برای دیدن عددها روی ستون بزنید.")));
      var ls = data.listening;
      if (!ls || !ls.overall.minutes) return;
      var o = ls.overall;
      more.appendChild(node("h3", "an-h", tr("Busiest hours ", "شلوغ‌ترین ساعت‌های ") + rangeWord()));
      more.appendChild(hourBars(o.hours));
      more.appendChild(topHours(o.top));
      var change = o.minutesBefore ? Math.round((o.minutes - o.minutesBefore) / o.minutesBefore * 100) : null;
      more.appendChild(figs([
        [tr("Total listening", "کل زمان شنیدن"), listenTime(o.minutes)],
        [tr("Versus the period before", "نسبت به دوره‌ی قبل"), change == null ? null : (change > 0 ? "+" : "") + change + "%"],
        [tr("Quietest hour", "خلوت‌ترین ساعت"), o.quiet ? slotRange(o.quiet.m) : null],
        [tr("Busiest day", "شلوغ‌ترین روز"), o.bestDay ? dayLabel(o.bestDay.date) + " · " + listenTime(o.bestDay.minutes) : null]
      ].concat(peopleFigs(o.people))));
      more.appendChild(zoneNote());
      more.appendChild(fromNote());
    }

    // A typical week: days down the side, hours along the bottom, darker = more listeners
    function renderHeat() {
      var h = data.heat || [];
      var full = openTile === tile("heat");
      var cols = full ? 24 : 12, step = 24 / cols;
      var max = 0, busiest = null;
      h.forEach(function (row) { (row || []).forEach(function (v) { if (v > max) max = v; }); });
      var L = 30, B = 14, gap = 2, box = $("an-heat");
      // open, the box is as tall as its seven rows (squares a little wider than tall)
      box.style.height = full ? Math.round(7 * (box.clientWidth - L) / cols * 0.8 + B + 2) + "px" : "";
      var c = plot(box, tr("Average listeners by day and hour, last 4 weeks", "میانگین شنونده‌ها به تفکیک روز و ساعت، 4 هفته‌ی اخیر"));
      if (c) {
        var cw = (c.w - L) / cols, ch = Math.min(Math.max(cw * (full ? 0.8 : 1.2), full ? 0 : 13), (c.h - B) / 7);
        for (var d = 0; d < 7; d++) {
          var y = d * ch;
          c.s.appendChild(svgEl("text", { x: L - 6, y: y + ch / 2 + 3, "text-anchor": "end", class: "an-tick" },
            studioLang === "fa" ? fmtL(new Date(2024, 0, 1 + d), { weekday: "narrow" }) : dayName(d)));
          for (var k = 0; k < cols; k++) {
            var sum = 0, cnt = 0;
            for (var j = 0; j < step; j++) { var v = h[d] && h[d][k * step + j]; if (v != null) { sum += v; cnt++; } }
            var avg = cnt ? sum / cnt : null, a = avg == null || !max ? 0 : avg / max;
            var cell = svgEl("rect", { x: L + k * cw, y: y, width: Math.max(1, cw - gap), height: Math.max(1, ch - gap), rx: 2,
              class: avg == null ? "an-cell an-cell--none" : "an-cell", "fill-opacity": avg == null ? 1 : (0.12 + 0.88 * a).toFixed(3) });
            c.s.appendChild(titled(cell, dayName(d) + " " + hourLabel(k * step) + (step > 1 ? "–" + hourLabel((k * step + step) % 24) : "") + ": " +
              (avg == null ? tr("no data", "بدون داده") : tr(n0(avg) + " listeners on average", "میانگین " + n0(avg) + " شنونده"))));
            if (avg != null && (!busiest || avg > busiest.v)) busiest = { d: d, h: k * step, v: avg };
          }
        }
        ((c.w - L) < 170 ? [0, 12] : [0, 6, 12, 18]).forEach(function (hr) {
          c.s.appendChild(svgEl("text", { x: L + hr / step * cw, y: 7 * ch + 11, class: "an-tick" }, hourLabel(hr)));
        });
      }
      setText($("an-heat-sub"), busiest ? tr("Busiest: ", "شلوغ‌ترین: ") + dayName(busiest.d) + " " + hourLabel(busiest.h) : tr("No history yet", "هنوز سابقه‌ای نیست"));
      var more = $("an-heat-more");
      more.replaceChildren();
      more.appendChild(node("p", "an-note", busiest
        ? tr("Busiest: " + dayName(busiest.d) + " around " + hourLabel(busiest.h) + " (" + n0(busiest.v) + " listeners on average). From the last 4 weeks; hover or tap a square for its number.",
             "شلوغ‌ترین زمان: " + dayName(busiest.d) + " حدود " + hourLabel(busiest.h) + " (میانگین " + n0(busiest.v) + " شنونده). از 4 هفته‌ی اخیر؛ برای دیدن عدد روی هر خانه بزنید.")
        : tr("Fills in as listener history builds up.", "با جمع شدن سابقه‌ی شنونده‌ها پر می‌شود.")));
    }

    function songList(title, items, unit) {
      var wrap = document.createDocumentFragment();
      wrap.appendChild(node("h3", "an-h", title));
      if (!items.length) { wrap.appendChild(node("p", "an-empty", tr("None ", "هیچ‌کدام ") + rangeWord() + ".")); return wrap; }
      var ul = node("ol", "an-list an-list--songs");
      var max = items[0].n || 1;
      items.forEach(function (s) {
        var li = node("li");
        li.appendChild(node("span", "an-name", s.title));
        var bar = node("span", "an-share");
        bar.appendChild(node("i", ""));
        bar.firstChild.style.width = Math.round(s.n / max * 100) + "%";
        li.appendChild(bar);
        li.appendChild(node("b", "", s.n + " " + unit));
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      return wrap;
    }

    function renderSkips(aud) {
      var votes = aud.votes.total, skipped = aud.skips.total;
      setText($("an-skips"), String(votes));
      var starts = aud.buckets || [];
      columns($("an-skips-chart"), (aud.votes.series || []).map(function (v, i) {
        return { v: v, label: starts[i] ? bucketLabel(starts[i], i, i === 0) : "", tip: (starts[i] ? bucketName(starts[i]) + ": " : "") + v + tr(v === 1 ? " skip vote" : " skip votes", " رأی رد") };
      }), { label: tr("Skip votes ", "رأی‌های رد ") + rangeWord(), noAxis: true });
      var by = aud.countries.filter(function (c) { return c.votes > 0; }).sort(function (a, b) { return b.votes - a.votes; });
      var parts = by.slice(0, 3).map(function (c) { return { cc: c.cc, n: c.votes }; });
      var rest = by.slice(3).reduce(function (s, c) { return s + c.votes; }, 0);
      if (rest) parts.push({ cc: "", n: rest });
      setText($("an-skips-sub"), skipped + tr(skipped === 1 ? " song skipped" : " songs skipped", " آهنگ رد شد"));
      var more = $("an-skips-more");
      more.replaceChildren();
      more.appendChild(node("h3", "an-h", tr("Skip votes by country", "رأی رد به تفکیک کشور")));
      var bc = node("div", "an-chart an-chart--list");
      more.appendChild(bc);
      hbars(bc, parts.map(function (p) { return { name: p.cc ? flag(p.cc) + " " + regionName(p.cc) : tr("Others", "بقیه"), v: p.n, text: String(p.n) }; }), tr("Skip votes by country", "رأی رد به تفکیک کشور"));
      more.appendChild(songList(tr("Most skip votes", "بیشترین رأی رد"), aud.votes.top, tr("votes", "رأی")));
      more.appendChild(songList(tr("Skipped by listeners", "رد شده توسط شنونده‌ها"), aud.skips.top, "×"));
    }

    // Liked songs: thumbs-up over the range, the songs liked most, and likes beside skip votes
    // day by day (more likes than skip votes: the music is landing)
    function renderLikes(aud) {
      var L = aud.likes, starts = aud.buckets || [];
      setText($("an-likes"), String(L.total));
      columns($("an-likes-chart"), (L.series || []).map(function (v, i) {
        return { v: v, label: starts[i] ? bucketLabel(starts[i], i, i === 0) : "", tip: (starts[i] ? bucketName(starts[i]) + ": " : "") + v + tr(v === 1 ? " like" : " likes", " پسند") };
      }), { label: tr("Likes ", "پسندها ") + rangeWord(), noAxis: true });
      setText($("an-likes-sub"), L.top.length ? tr("Most liked: ", "محبوب‌ترین: ") + L.top[0].title : tr("No likes yet", "هنوز پسندی نیست"));
      var more = $("an-likes-more");
      more.replaceChildren();
      more.appendChild(node("h3", "an-h", tr("Likes and skip votes each day", "پسندها و رأی‌های رد در هر روز")));
      var cmp = node("div", "an-chart an-chart--pair");
      more.appendChild(cmp);
      lines(cmp, (L.series || []).map(function (v, i) { return starts[i] ? bucketLabel(starts[i], i, true) : ""; }), [
        { name: tr("Likes", "پسندها"), tone: "main", values: L.series || [] },
        { name: tr("Skip votes", "رأی‌های رد"), tone: "ref", values: aud.votes.series || [] }
      ], tr("Likes and skip votes each day", "پسندها و رأی‌های رد در هر روز"));
      var votes = aud.votes.total;
      more.appendChild(node("p", "an-note", L.total + votes
        ? tr(Math.round(L.total / (L.total + votes) * 100) + "% of listeners' reactions " + rangeWord() + " were likes (" + L.total + " likes, " + votes + " skip votes).",
             Math.round(L.total / (L.total + votes) * 100) + "٪ واکنش‌های شنونده‌ها " + rangeWord() + " پسند بود (" + L.total + " پسند، " + votes + " رأی رد).")
        : tr("No reactions yet.", "هنوز واکنشی نیست.")));
      more.appendChild(node("h3", "an-h", tr("Most liked songs", "پسندیده‌ترین آهنگ‌ها")));
      var box = node("div", "an-chart an-chart--list");
      more.appendChild(box);
      if (L.top.length) hbars(box, L.top.map(function (t) { return { name: t.title, v: t.n, text: t.n + tr(t.n === 1 ? " like" : " likes", " پسند") }; }), tr("Most liked songs", "پسندیده‌ترین آهنگ‌ها"));
      else box.appendChild(node("p", "an-empty", tr("None ", "هیچ‌کدام ") + rangeWord() + "."));
    }

    // The flamingo notes (this tile used to count downloads): how many notes listeners gave
    // the flamingos, how often one was skywritten, what's waiting to fly now, and from where
    // Who posts the channel's songs: how many, how often they're played, how listeners take
    // them ("kept": heard to the end rather than voted off). Ranked by a fair score that
    // doesn't let one lucky song win (see Tiers.posters on the server).
    function renderPosters(P) {
      var people = P.people || [];
      var songs = people.reduce(function (a, p) { return a + p.songs; }, 0);
      // in words: who listeners like most, then how many songs each person posted
      setText($("an-posters-kicker"), people.length ? tr("Most liked", "محبوب‌ترین") : "");
      setText($("an-posters"), people.length ? people[0].name : "–");
      var box = $("an-posters-chart");
      box.replaceChildren();
      if (people.length) {
        box.appendChild(node("div", "an-rank-head", tr("Songs posted", "آهنگ‌های گذاشته‌شده")));
        var ol = node("ol", "an-rank");
        people.slice().sort(function (x, y) { return y.songs - x.songs; }).slice(0, 3).forEach(function (p) {
          var li = node("li");
          var nm = node("span", "an-rank-name", p.name);
          nm.dir = "auto";                    // (a Latin name is cut at its own end in the Farsi studio)
          li.appendChild(nm);
          li.appendChild(node("b", "", String(p.songs)));
          ol.appendChild(li);
        });
        box.appendChild(ol);
      }
      setText($("an-posters-sub"), people.length
        ? tr(songs + " songs from " + people.length + (people.length === 1 ? " person" : " people"), songs + " آهنگ از " + people.length + " نفر")
        : tr("Nobody's name on the posts yet", "هنوز نام کسی روی پست‌ها نیست"));
      var more = $("an-posters-more");
      more.replaceChildren();
      // one card per person, in plain words, ranked by how much listeners like their songs
      more.appendChild(node("h3", "an-h", tr("Ranked by how much listeners like their songs", "به ترتیب علاقه‌ی شنونده‌ها به آهنگ‌هایشان")));
      if (!people.length) more.appendChild(node("p", "an-empty", tr("No signed posts yet.", "هنوز پست امضاشده‌ای نیست.")));
      else {
        var cards = node("ol", "an-people");
        people.forEach(function (p, i) {
          var li = node("li", "an-person");
          li.tabIndex = 0;
          li.setAttribute("role", "button");
          li.setAttribute("aria-expanded", "false");
          var top = node("div", "an-person-top");
          top.appendChild(node("span", "an-person-rank", String(i + 1)));
          var nm = node("b", "an-person-name", p.name);
          nm.dir = "auto";
          top.appendChild(nm);
          top.appendChild(node("span", "an-person-hint"));
          li.appendChild(top);
          var body = node("div", "an-person-body");
          li.appendChild(body);
          function line(text, soft) { return body.appendChild(node("p", "an-person-line" + (soft ? " an-person-line--soft" : ""), text)); }
          function songs(title, list, unit) {
            body.appendChild(node("div", "an-person-h", title));
            if (!list || !list.length) { line(tr("None yet", "هنوز هیچ"), true); return; }
            var ol = node("ol", "an-rank");
            list.forEach(function (s2) {
              var r = node("li");
              var t = node("bdi", "an-rank-name", s2.title);
              r.appendChild(t);
              r.appendChild(node("b", "", s2.n + " " + unit));
              ol.appendChild(r);
            });
            body.appendChild(ol);
          }
          function summary() {
            body.replaceChildren();
            line(tr(p.songs + (p.songs === 1 ? " song posted" : " songs posted") + " · " + (p.played || 0) + " played",
                    p.songs + " آهنگ گذاشته · " + (p.played || 0) + " پخش شده"));
            line(tr("Played " + p.plays + (p.plays === 1 ? " time" : " times") + " in all", "روی هم " + p.plays + " بار پخش شده"));
            var react = node("p", "an-person-line an-person-react");
            react.innerHTML = '<span><svg class="icon icon--sm" aria-hidden="true"><use href="#i-like"/></svg></span><span><svg class="icon icon--sm" aria-hidden="true"><use href="#i-dislike"/></svg></span>';
            react.firstChild.appendChild(document.createTextNode(" " + (p.likes || 0) + tr(" liked", " پسند")));
            react.lastChild.appendChild(document.createTextNode(" " + (p.dislikes || 0) + tr(" disliked", " رد")));
            body.appendChild(react);
            if (p.kept != null) {
              var pct = Math.round(p.kept * 100);
              var meter = node("div", "an-person-meter");
              var track = node("span", "an-hb-track"), fill = node("i");
              fill.style.width = pct + "%";
              track.appendChild(fill);
              meter.appendChild(track);
              meter.appendChild(node("span", "", tr(pct + "% heard to the end", pct + "٪ تا آخر شنیده شده")));
              body.appendChild(meter);
            }
            line(tr(p.saves + (p.saves === 1 ? " download" : " downloads"), p.saves + " دانلود"), true);
            li.querySelector(".an-person-hint").textContent = tr("Songs ›", "آهنگ‌ها ‹");
          }
          function detail() {
            body.replaceChildren();
            songs(tr("Most liked songs", "پسندیده‌ترین آهنگ‌ها"), p.liked, tr("likes", "پسند"));
            songs(tr("Most disliked songs", "آهنگ‌های بیشتر ردشده"), p.disliked, tr("skip votes", "رأی رد"));
            li.querySelector(".an-person-hint").textContent = tr("‹ Back", "بازگشت ›");
          }
          // a tap (or Enter / Space) switches between the summary and the songs
          function flip() {
            var open = li.getAttribute("aria-expanded") !== "true";
            li.setAttribute("aria-expanded", String(open));
            li.classList.remove("is-switching");
            void li.offsetWidth;                 // (restart the fade)
            li.classList.add("is-switching");
            if (open) detail(); else summary();
          }
          li.addEventListener("click", flip);
          li.addEventListener("keydown", function (e) {
            if (e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); flip(); }
          });
          summary();
          cards.appendChild(li);
        });
        more.appendChild(cards);
      }
      if (P.unsigned) {
        more.appendChild(node("p", "an-note", tr(P.unsigned + " song" + (P.unsigned === 1 ? " doesn't" : "s don't") +
          " say who posted it. Turn on “Sign messages” in the channel's settings and new posts carry the admin's name.",
          P.unsigned + " آهنگ نام فرستنده را ندارد. «امضای پیام‌ها» را در تنظیمات کانال روشن کنید تا پست‌های تازه نام ادمین را داشته باشند.")));
      }
    }

    function renderSaves(aud) {
      var n = aud.notes || { total: 0, series: [], flights: 0, countries: [], waiting: [] };
      var waiting = n.waiting || [];
      setText($("an-saves"), String(n.total || 0));
      setText($("an-saves-sub"), waiting.length + tr(" waiting", " در انتظار") + (n.full ? tr(" · sky full", " · آسمان پر است") : "") + " · " + (n.flights || 0) + tr(" skywritten", " بار در آسمان"));
      var starts = aud.buckets || [];
      columns($("an-saves-chart"), (n.series || []).map(function (v, i) {
        return { v: v, label: starts[i] ? bucketLabel(starts[i], i, i === 0) : "", tip: (starts[i] ? bucketName(starts[i]) + ": " : "") + v + tr(v === 1 ? " note" : " notes", " یادداشت") };
      }), { label: tr("Flamingo notes ", "یادداشت‌های فلامینگو ") + rangeWord(), noAxis: true });
      var more = $("an-saves-more");
      more.replaceChildren();
      more.appendChild(node("h3", "an-h", tr("Waiting to fly", "در انتظار پرواز")));
      if (!waiting.length) more.appendChild(node("p", "an-empty", tr("No notes right now.", "الان یادداشتی نیست.")));
      else {
        var ul = node("ul", "an-list");
        waiting.forEach(function (w) {
          var li = node("li");
          var t = node("span", "an-name", w.text); t.dir = "auto";
          li.appendChild(t);
          li.appendChild(node("b", "", Math.max(0, Math.round((Date.now() / 1000 - w.created) / 60)) + tr(" min", " دقیقه")));
          ul.appendChild(li);
        });
        more.appendChild(ul);
      }
      if ((n.countries || []).length) {
        more.appendChild(node("h3", "an-h", tr("Notes by country", "یادداشت‌ها به تفکیک کشور")));
        var cl = node("ul", "an-list");
        n.countries.forEach(function (c) {
          var li = node("li");
          li.appendChild(node("span", "an-flag", flag(c.cc)));
          li.appendChild(node("span", "an-name", regionName(c.cc)));
          li.appendChild(node("b", "", String(c.n)));
          cl.appendChild(li);
        });
        more.appendChild(cl);
      }
    }

    function renderCompare() {
      var cmp = data.compare || [];
      lines($("an-compare-chart"), cmp.map(function (c) { return fmtL(new Date(c.date + "T12:00:00"), { weekday: "narrow" }); }), [
        { name: tr("This week", "این هفته"), tone: "main", values: cmp.map(function (c) { return c.this; }) },
        { name: tr("Last week", "هفته‌ی قبل"), tone: "ref", values: cmp.map(function (c) { return c.last; }) }
      ], tr("Average listeners each day, this week and last", "میانگین شنونده‌ها در هر روز، این هفته و هفته‌ی قبل"));
      function avg(key) { var v = cmp.map(function (c) { return c[key]; }).filter(function (x) { return x != null; }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }
      var a = avg("this"), b = avg("last");
      setText($("an-compare-sub"), a != null && b ? (a >= b ? "+" : "−") + Math.abs(Math.round((a / b - 1) * 100)) + tr("% on last week", "٪ نسبت به هفته‌ی قبل") : tr("Not enough data yet", "هنوز داده‌ی کافی نیست"));
      var more = $("an-compare-more");
      more.replaceChildren();
      var tbl = node("div", "an-table an-table--3");
      var head = node("div", "an-tr an-tr--head");
      [tr("Day", "روز"), tr("This week", "این هفته"), tr("Last week", "هفته‌ی قبل")].forEach(function (h) { head.appendChild(node("span", "", h)); });
      tbl.appendChild(head);
      cmp.forEach(function (c) {
        var r = node("div", "an-tr");
        r.appendChild(node("span", "an-name", fmtL(new Date(c.date + "T12:00:00"), { weekday: "short", day: "numeric", month: "short" })));
        r.appendChild(node("span", "an-num", n0(c.this)));
        r.appendChild(node("span", "an-num", n0(c.last)));
        tbl.appendChild(r);
      });
      more.appendChild(tbl);
    }

    /* ---------- tiles: open to the details ---------- */
    tiles.forEach(function (t) {
      t.addEventListener("click", function (e) {
        if (e.target.closest(".an-more") && t === openTile) return;   // using the details
        toggle(t);
      });
      t.addEventListener("keydown", function (e) {
        if (e.target !== t) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(t); }
        else if (e.key === "Escape" && t === openTile) { e.preventDefault(); toggle(t); }
      });
    });

    // Open / close with a FLIP: every tile glides from where it was to where it lands
    function toggle(t) {
      var next = t === openTile ? null : t;
      var before = tiles.map(function (x) { return x.getBoundingClientRect(); });
      if (openTile) { openTile.classList.remove("is-open"); openTile.setAttribute("aria-expanded", "false"); }
      openTile = next;
      if (next) { next.classList.add("is-open"); next.setAttribute("aria-expanded", "true"); }
      if (data) renderAll();                          // drawn at the new size (the heat grid shows every hour when open)
      if (!perf.isLite() && !perf.reducedMotion && typeof tiles[0].animate === "function") {
        tiles.forEach(function (x, i) {
          var a = before[i], b2 = x.getBoundingClientRect();
          if (!a.width || !b2.width) return;
          var dx = a.left - b2.left, dy = a.top - b2.top, sx = a.width / b2.width, sy = a.height / b2.height;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
          x.animate([
            { transformOrigin: "0 0", transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" },
            { transformOrigin: "0 0", transform: "none" }
          ], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        });
      }
      if (next) setTimeout(function () { try { next.scrollIntoView({ block: "nearest", behavior: perf.reducedMotion ? "auto" : "smooth" }); } catch (e) { /* ignore */ } }, 200);
    }

    // range: day / week / month for every tile at once
    $("an-range").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-range]");
      if (!b || b.dataset.range === range) return;
      range = b.dataset.range;
      Array.prototype.forEach.call($("an-range").querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      loadStats();
    });

    // the charts are drawn to the size of their box: again when a box changes size
    if ("ResizeObserver" in window) {
      var redraw = 0;
      var ro = new ResizeObserver(function () {
        cancelAnimationFrame(redraw);
        redraw = requestAnimationFrame(function () { if (data) renderAll(); });
      });
      Array.prototype.forEach.call(root.querySelectorAll(".an-chart"), function (el) { ro.observe(el); });
    }

    function opened() {
      placeNotes();
      root.hidden = !isCurator();
      if (root.hidden) return;
      open = true;
      var now = Date.now();
      if (!data || now - statsAt > 60000) loadStats();
      pollLive();
      clearInterval(livePoll); clearInterval(statsPoll);
      livePoll = setInterval(function () { if (!document.hidden) pollLive(); }, 5000);
      statsPoll = setInterval(function () { if (!document.hidden) loadStats(); }, 60000);
    }
    // Background preparation: data, before the studio opens
    function prewarm() {
      if (warm || !isCurator()) return warm;
      root.hidden = false;
      placeNotes();
      warm = loadStats().catch(function () { warm = null; });
      return warm;
    }
    // Called when a flip ends
    studioLangHooks.push(function () { if (data) renderAll(); });
    function settled() { if (open && data) renderAll(); }   // (drawn to size once the card has turned)
    function closed() {
      open = false;
      clearInterval(livePoll); clearInterval(statsPoll);
    }
    function refreshRole() {
      placeNotes();
      root.hidden = !isCurator();
      if (root.hidden) { closed(); warm = null; statsKey = ""; data = null; }
    }
    return { opened: opened, closed: closed, refreshRole: refreshRole, prewarm: prewarm, settled: settled };
  })();

  /* ---------------- PWA ---------------- */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* offline support unavailable */ });
    });
  }

  /* ---------------- Init ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-tz]"), function (el) { el.textContent = tzLabel(); });
  wave.init();
  applyTheme();
  setInterval(applyTheme, 60000);
  updateAuthButton();
  news.render();
  news.refresh();
  marquee.refresh();
  setState("idle");
  setupMediaSession();
  setupNowPlaying();
  registerSW();
  log.add("ok", "Studio ready");
  // A saved login may have expired or been revoked; check it quietly
  if (session) {
    api.get("/api/me").then(function (me) {
      if (session && me && me.role && me.role !== session.role) {     // role changed on the server
        session.role = me.role;
        store.set("raadio.session", session);
      }
      return schedules.load();
    }).catch(function (ex) {
      if (ex.status !== 401) log.add("warn", ex.message);   // 401 already signed us out
    });
  }
  if (!navigator.onLine) { setState("offline"); setStatus("Offline — music resumes when you reconnect"); }
  hosts.pick();
  perf.refine();
  /* ---------------- Flamingo artwork ----------------
     One set of drawings for every flamingo on the page (the flock in the background, the
     one that lands on the radio, the one you catch, the skywriter): low-poly line drawings
     in the same thin gold as the lines of the sky.
     Made from our own outlines (lowpoly_gen2.py in the notes): flying, and standing on one
     leg. Each piece has a smooth outline ("rim", drawn a little bolder) around an even mesh
     of triangles ("lines", fainter); the pieces meet edge to edge. The eye is a gap in the
     head's mesh, so no line runs through it, and it's drawn on its own: ring, pupil, glint.
     As SVG for the page, and drawn onto a canvas for the 3D flock. */
  var flamingoArt = (function () {
    var LOWPOLY = {"fly":{"rim":"M48.6 40L59 38.8L69 37.8L78.4 37.4M50 30.5L43.8 33.3L38 37L44.3 40L50.9 42.4L57.7 43.9L64.7 44.6L71.7 44.2L78.5 42.5L84.6 39.2L88.7 38L92.8 37.2L97 36.3L101.2 35.5L105.3 34.7L109.5 33.9L113.6 34.3L117.7 33.7L121.8 32.5L126 32.7L129.4 35L126.8 29.5L122.8 27.8L118.6 27.3L114.4 28.1L110.9 30.5L106.6 31.3L102.3 32.1L98.1 32.8L93.8 33.3L89.5 33.7L85.2 33.6L83 33.6L77 30.3L70.3 28.7L63.5 28.1L56.7 28.6ZM51.9 42.1L29.9 44.1M52.1 43.5L30.1 45.5M30 44.1L8 44.9M30 45.5L8 46.3M30 43.3L31.1 44.8L30 46.3L28.9 44.8ZM55.9 43.2L31.9 46.9M56.1 44.6L32.1 48.3M32 46.9L9.6 48.3M32 48.3L9.6 49.7M32 46.1L33.1 47.6L32 49.1L30.9 47.6ZM8 45.6L3.2 44L4 45.6L3 47.4ZM9.6 49L4.8 47.8L5.6 49.4L4.6 51Z","lines":"M57.7 43.9L59 38.8L50 30.5L48.6 40L43.8 33.3L44.3 40L48.6 40L50.9 42.4L59 38.8L64.7 44.6L69 37.8L70.3 28.7M56.7 28.6L59 38.8L63.5 28.1L69 37.8L77 30.3L78.4 37.4L83 33.6L84.6 39.2L78.4 37.4L78.5 42.5M69 37.8L71.7 44.2L78.4 37.4M84.6 39.2L85.2 33.6L88.7 38L89.5 33.7L92.8 37.2L93.8 33.3L97 36.3L98.1 32.8L101.2 35.5L102.3 32.1L105.3 34.7L106.6 31.3L109.5 33.9L110.9 30.5L113.6 34.3L114.4 28.1L117.7 33.7L118.6 27.3L121.8 32.5L122.8 27.8M121.8 32.5L126.8 29.5L126 32.7"},"flyWing":{"rim":"M76 31L70 31L64 31L58 31L52 31L51.3 25.4L50.3 19.9L48.8 14.5L45.9 9.8L41.8 6L37 3L42.7 2.6L48.4 2.6L54 3.1L59.6 4.2L65 5.9L70 8.6L73.5 13.5L75.7 19.1L76.5 25Z","lines":"M75.7 19.1L66.8 22.9L76.5 25L70 31L66.8 22.9L64 31M58 31L66.8 22.9L73.5 13.5L61.7 11.7L66.8 22.9L56.1 20.9L58 31L51.3 25.4L56.1 20.9L61.7 11.7L59.6 4.2M65 5.9L61.7 11.7L70 8.6M54 3.1L61.7 11.7L48.8 14.5L56.1 20.9L50.3 19.9M54 3.1L45.9 9.8L48.4 2.6L41.8 6L42.7 2.6M54 3.1L48.8 14.5"},"stand":{"rim":"M15.4 54.6L23.2 50.6L31.2 47.4L39.4 45L47.6 43.2M56.4 50.6L50.8 56.1L43.7 59.6L36 61.6L28.1 61.7L20.2 61L12.3 60L4.4 58.8L8.6 52.8L13.3 47.1L18.7 42.1L24.9 38.1L31.9 36.1L39.3 35.9L46.4 37.6","lines":"M31.2 47.4L24.9 38.1L23.2 50.6L18.7 42.1M31.2 47.4L31.9 36.1L39.4 45L43.7 51.9L43.7 59.6M31.2 47.4L28.1 61.7L23.2 50.6L13.3 47.1L15.4 54.6L20.2 61L23.2 50.6M31.2 47.4L36 61.6L43.7 51.9L31.2 47.4M43.7 51.9L50.8 56.1M43.7 51.9L56.4 50.6L53.4 42L47.6 43.2L43.7 51.9M56.4 50.6L47.6 43.2L46.4 37.6L39.4 45L39.3 35.9M46.4 37.6L53.4 42M15.4 54.6L8.6 52.8L12.3 60L15.4 54.6"},"standLegs":{"rim":"M33 61.6L33.8 84M34.2 61.6L35 84M33.8 84L34.4 104M35 84L35.6 104M34.4 82.6L35.4 84L34.4 85.4L33.4 84ZM38.1 60.8L26.9 77.2M39.1 61.6L27.9 78M27.1 78.2L40.9 85.2M27.7 77L41.5 84M27.4 76.2L28.4 77.6L27.4 79L26.4 77.6ZM41.2 84.6L43.2 93.6L41.6 92.6L40.4 94.2L39.6 86.4ZM35 104L43.8 107.4L41.4 108L43.4 108.8L33.6 108.6L30.6 107.6ZM35 104L41.4 108","lines":""},"standWing":{"rim":"M27.4 9.4L22.6 7.3L17.4 6.2L20.2 12.2L16.4 12.6L19.6 18.8L15.8 19.6L19.4 25.8L17.2 26.8L19.2 31L21.8 34.9L25 38.2L30.9 37.4L36.7 36.6L42.6 35.8L41.8 30.6L40.4 25.5L38.1 20.7L35.2 16.3L31.7 12.5Z","lines":"M19.6 18.8L27.1 19.6L27.4 9.4L20.2 12.2L27.1 19.6L31.7 12.5M19.6 18.8L20.2 12.2L22.6 7.3M19.6 18.8L19.4 25.8L27.1 19.6L35.2 16.3L34.1 23.1L27.1 19.6L29.8 30.6L21.8 34.9M25 38.2L29.8 30.6L19.2 31L19.4 25.8L29.8 30.6L30.9 37.4M34.1 23.1L29.8 30.6L36.7 36.6L41.8 30.6L29.8 30.6L40.4 25.5L34.1 23.1L38.1 20.7"}};
    var EYE = {"fly":[116.79,29.16,1.31]};
    // the black tip of the beak
    var RIG = {"b":[51.4,44.1],"L0":[56.4,50.6],"R0":[46.4,37.6],"W":[[0,8.2],[0.08,5.0],[0.2,3.0],[0.5,2.5],[0.7,2.8],[0.79,3.3],[0.86,2.7],[0.93,1.5],[1.0,0.2]],"uL":[0.0,0.0865,0.15,0.2005,0.2495,0.2985,0.347,0.396,0.4445,0.4935,0.5425,0.591,0.6395,0.6875,0.7325,0.7725,0.809,0.843,0.877,0.9135,0.9545],"uR":[0.0,0.121,0.176,0.225,0.274,0.3225,0.3715,0.4205,0.469,0.518,0.5665,0.6155,0.664,0.7105,0.753,0.791,0.826,0.8595,0.895,0.9335,0.977],"eyeU":[0.776,0.8880000000000001],"tipU":0.9120000000000001,"hn":15,"hs":1.258,"hip":[36,61],"P":{"up":{"s":1.257,"a":[-0.562,-0.58,-0.608,-0.646,-0.695,-0.757,-0.834,-0.927,-1.039,-1.165,-1.301,-1.439,-1.569,-1.719,-2.033,-2.294,-2.459,-2.559,-2.619,-2.653,-2.669,-2.67,-2.658,-2.633,-2.594,-2.539,-2.463,-2.361,-2.23,-2.068,-1.884,-1.696,-1.603,-1.528,-1.451,-1.372,-1.288,-1.198,-1.1,-0.99,-0.865,-0.719,-0.55,-0.356,-0.14,0.055,0.21,0.384,0.571,0.762,0.951,1.131,1.301,1.459,1.549,1.624,1.714,1.821,1.945,2.085],"lean":0.0},"reach":{"s":1.114,"a":[-0.561,-0.576,-0.599,-0.629,-0.668,-0.716,-0.775,-0.846,-0.93,-1.028,-1.139,-1.258,-1.38,-1.5,-1.627,-1.476,-1.372,-1.246,-1.095,-0.917,-0.718,-0.517,-0.33,-0.17,-0.068,-0.032,0.003,0.038,0.075,0.113,0.153,0.196,0.243,0.295,0.354,0.42,0.549,0.698,0.839,0.975,1.106,1.232,1.353,1.47,1.583,1.708,1.866,2.024,2.188,2.348,2.498,2.634,2.755,2.826,2.79,2.735,2.662,2.568,2.451,2.317],"lean":5},"feed":{"s":1.397,"a":[-0.562,-0.584,-0.618,-0.664,-0.724,-0.802,-0.9,-1.019,-1.158,-1.309,-1.461,-1.607,-1.397,-1.24,-1.06,-0.853,-0.622,-0.381,-0.15,0.06,0.294,0.537,0.756,0.936,1.081,1.198,1.295,1.378,1.466,1.502,1.508,1.514,1.52,1.527,1.533,1.54,1.548,1.555,1.563,1.572,1.581,1.59,1.6,1.611,1.622,1.629,1.659,1.696,1.741,1.796,1.865,1.95,2.057,2.188,2.208,2.124,2.034,1.942,1.851,1.764],"lean":16},"dab":{"s":1.397,"a":[-0.562,-0.584,-0.618,-0.664,-0.724,-0.802,-0.9,-1.019,-1.158,-1.309,-1.461,-1.607,-1.397,-1.24,-1.06,-0.853,-0.622,-0.381,-0.15,0.06,0.294,0.537,0.756,0.936,1.081,1.198,1.295,1.378,1.466,1.502,1.508,1.514,1.52,1.527,1.533,1.54,1.548,1.555,1.563,1.572,1.581,1.591,1.607,1.627,1.651,1.673,1.719,1.774,1.837,1.91,1.996,2.096,2.215,2.356,2.381,2.299,2.209,2.117,2.026,1.939],"lean":16},"rest":{"s":1.098,"a":[-0.561,-0.576,-0.598,-0.628,-0.665,-0.712,-0.769,-0.838,-0.92,-1.015,-1.122,-1.239,-1.359,-1.478,-1.59,-1.563,-1.647,-1.832,-2.07,-2.347,-2.619,-2.849,-3.029,-3.137,-3.141,-3.125,-3.097,-3.054,-2.993,-2.91,-2.799,-2.651,-2.466,-2.256,-2.034,-1.861,-1.73,-1.611,-1.489,-1.35,-1.18,-0.964,-0.699,-0.412,-0.153,0.055,0.21,0.384,0.571,0.762,0.951,1.131,1.301,1.459,1.549,1.624,1.714,1.821,1.945,2.085],"lean":0.0},"tuck":{"s":1.041,"a":[-0.56,-0.575,-0.595,-0.622,-0.656,-0.697,-0.748,-0.809,-0.882,-0.966,-1.061,-1.167,-1.28,-1.394,-1.506,-1.622,-1.542,-1.643,-1.75,-1.856,-1.965,-2.08,-2.207,-2.345,-2.496,-2.654,-2.814,-2.966,-3.1,-3.206,-3.316,-3.43,-3.546,-3.66,-3.77,-3.874,-3.971,-4.061,-4.143,-4.221,-4.293,-4.386,-4.371,-4.325,-4.276,-4.216,-4.146,-4.07,-3.99,-3.907,-3.822,-3.748,-3.692,-3.641,-3.594,-3.553,-3.515,-3.481,-3.451,-3.425],"lean":0.0},"toss":{"s":1.257,"a":[-0.562,-0.58,-0.608,-0.646,-0.695,-0.757,-0.834,-0.927,-1.039,-1.165,-1.301,-1.439,-1.569,-1.722,-2.041,-2.31,-2.483,-2.593,-2.664,-2.709,-2.735,-2.747,-2.744,-2.727,-2.694,-2.643,-2.568,-2.466,-2.335,-2.173,-1.989,-1.801,-1.708,-1.633,-1.556,-1.477,-1.399,-1.359,-1.352,-1.367,-1.395,-1.422,-1.438,-1.435,-1.407,-1.39,-1.397,-1.361,-1.279,-1.155,-0.987,-0.807,-0.637,-0.479,-0.389,-0.314,-0.224,-0.117,0.007,0.147],"lean":-3},"walk1":{"s":1.257,"a":[-0.562,-0.58,-0.608,-0.646,-0.695,-0.757,-0.834,-0.927,-1.039,-1.165,-1.301,-1.439,-1.569,-1.716,-2.025,-2.278,-2.434,-2.522,-2.57,-2.59,-2.591,-2.577,-2.549,-2.509,-2.454,-2.384,-2.294,-2.178,-2.035,-1.863,-1.67,-1.475,-1.378,-1.301,-1.224,-1.145,-1.061,-0.971,-0.873,-0.768,-0.656,-0.53,-0.384,-0.217,-0.029,0.138,0.266,0.417,0.586,0.766,0.951,1.131,1.301,1.459,1.549,1.624,1.714,1.821,1.945,2.085],"lean":3},"walk2":{"s":1.257,"a":[-0.562,-0.58,-0.608,-0.646,-0.695,-0.757,-0.834,-0.927,-1.039,-1.165,-1.301,-1.439,-1.569,-1.718,-2.031,-2.29,-2.453,-2.551,-2.608,-2.638,-2.651,-2.649,-2.633,-2.604,-2.562,-2.503,-2.424,-2.319,-2.185,-2.021,-1.835,-1.645,-1.551,-1.476,-1.399,-1.32,-1.236,-1.146,-1.048,-0.939,-0.817,-0.676,-0.512,-0.324,-0.115,0.074,0.223,0.391,0.574,0.762,0.951,1.131,1.301,1.459,1.549,1.624,1.714,1.821,1.945,2.085],"lean":1},"sing":{"s":1.257,"a":[-0.562,-0.58,-0.608,-0.646,-0.695,-0.757,-0.834,-0.927,-1.039,-1.165,-1.301,-1.439,-1.569,-1.719,-2.033,-2.294,-2.459,-2.559,-2.619,-2.653,-2.669,-2.67,-2.658,-2.633,-2.594,-2.539,-2.463,-2.361,-2.23,-2.068,-1.884,-1.696,-1.603,-1.528,-1.451,-1.372,-1.29,-1.213,-1.14,-1.064,-0.981,-0.883,-0.765,-0.625,-0.464,-0.322,-0.216,-0.086,0.063,0.226,0.398,0.572,0.742,0.9,0.99,1.065,1.155,1.262,1.386,1.526],"lean":0.0}},"clip":"M46.4 37.6L39.3 35.9L31.9 36.1L24.9 38.1L18.7 42.1L13.3 47.1L8.6 52.8L4.4 58.8L12.3 60.0L20.2 61.0L28.1 61.7L36.0 61.6L43.7 59.6L50.8 56.1L56.4 50.6L53.4 42.0Z","rung":13,"slide":[-0.961,0.275],"chest":"M46.4 37.6L53.4 42.0L56.4 50.6"};
    var TIP = {"fly":"M126 32.7L129.4 35L126.8 29.5Z"};
    // "heart": made here rather than drawn. Inside the chest the neck is the upright one; out
    // of it, it arches up and back, over the top and forward again, and the head bows down at
    // the front. Two birds face to face: their necks are the two round lobes of a heart, their
    // bowed heads meet in its dip and their chests make its point.
    RIG.P.heart = (function () {
      var up = RIG.P.up, a = up.a.slice(0, 13), n = 32, j, k, ang;
      for (j = 0; j < n; j++) {
        k = j / (n - 1);
        ang = -3 + 4.2 * Math.pow(k, 1.4);                 // back (-3), up, over, forward and down (1.2)
        if (j < 4) { var t = (j + 1) / 5; t = t * t * (3 - 2 * t); ang = -1.57 + (ang + 1.57) * t; }   // (out of the chest smoothly)
        a.push(ang);
      }
      for (j = 0; j < RIG.hn; j++) { k = j / (RIG.hn - 1); a.push(1.3 + 0.6 * k * k * (3 - 2 * k)); }   // the head, bowed
      return { s: up.s, a: a, lean: 0 };
    })();
    function net(piece, cls) {
      var P = LOWPOLY[piece];
      return '<g class="' + (cls || "") + '"><path class="fl-net" d="' + P.lines + '"/><path class="fl-rim" d="' + P.rim + '"/></g>';
    }
    // an eye, all in the drawing's one colour: a ring and a pupil looking forward, with the
    // glint cut out of the pupil (a hole, so it shows whatever is behind); blinks now and then
    function disc(x, y, r) {
      return "M" + (x - r).toFixed(2) + " " + y.toFixed(2) + "a" + r.toFixed(2) + " " + r.toFixed(2) + " 0 1 0 " + (2 * r).toFixed(2) + " 0" +
             "a" + r.toFixed(2) + " " + r.toFixed(2) + " 0 1 0 " + (-2 * r).toFixed(2) + " 0Z";
    }
    function eye(e, scale) {
      var x = e[0], y = e[1], r = e[2] * (scale || 1), px = x + r * 0.18, py = y + r * 0.06;
      return '<g class="fl-eye" style="transform-origin:' + x + 'px ' + y + 'px"><circle class="fl-eyering" cx="' + x + '" cy="' + y + '" r="' + r + '"/>' +
             '<path class="fl-pupil" d="' + disc(px, py, r * 0.56) + disc(px - r * 0.18, py - r * 0.2, r * 0.17) + '"/></g>';
    }
    function tip(k) { return '<path class="fl-tip" d="' + TIP[k] + '"/>'; }
    // asleep: the eye shut, a little curve
    function shut(e) {
      var x = e[0], y = e[1], r = e[2];
      return '<path class="fl-eyeshut" d="M' + (x - r).toFixed(2) + " " + (y - 0.2).toFixed(2) + "Q" + x + " " + (y + r * 0.9).toFixed(2) + " " + (x + r).toFixed(2) + " " + (y - 0.2).toFixed(2) + '"/>';
    }
    // (the body rises a little on each downstroke of the wings: .fl-flybody)
    function svgFlying(cls) {
      return '<svg class="fl ' + (cls || "") + '" viewBox="0 0 140 70" aria-hidden="true">' +
        net("flyWing", "fl-wing fl-wing--far") +
        '<g class="fl-flybody">' + net("fly") + tip("fly") + hat(EYE.fly, 1.45) + eye(EYE.fly) + '</g>' +
        net("flyWing", "fl-wing fl-wing--near") + '</svg>';
    }
    // The standing bird's neck is a chain that bends. RIG has its joint on the body, the
    // widths along it, the places of the corners down each side (closer together round the
    // head) and, for each pose, the direction of every link: "up" (the S), "reach", "feed"
    // (the head upside down by the water), "dab", "toss" (swallowing), "rest" (the head on
    // its back). Outline, triangles, eye and the black tip of the beak are worked out from the
    // links, so going from one pose to another the neck really bends, like a bird's.
    function rigWidth(u) {
      var W = RIG.W;
      for (var i = 1; i < W.length; i++) {
        if (u <= W[i][0]) { var k = (u - W[i - 1][0]) / ((W[i][0] - W[i - 1][0]) || 1); k = k * k * (3 - 2 * k); return W[i - 1][1] + (W[i][1] - W[i - 1][1]) * k; }
      }
      return W[W.length - 1][1];
    }
    // a: the links' directions; s: the neck's link length; jd: the joint at the chest turned
    // (radians, + = forward); jr: the neck slid into the chest (the part inside is hidden).
    // The centre line, link by link from the joint:
    function chainXY(a, s, jd, jr) {
      jd = jd || 0; jr = jr || 0;
      var n = a.length, hn = RIG.hn, i, ux = -RIG.slide[0], uy = -RIG.slide[1];
      var X = [RIG.b[0] - ux * jr], Y = [RIG.b[1] - uy * jr], A = [];
      for (i = 0; i < n; i++) A.push(a[i] + jd);
      for (i = 0; i < n; i++) { var l = i < n - hn ? s : RIG.hs; X.push(X[i] + l * Math.cos(A[i])); Y.push(Y[i] + l * Math.sin(A[i])); }
      return { X: X, Y: Y, A: A, jr: jr };
    }
    // Two centre lines blended point by point, k(u) along the neck. For moves where turning
    // the links would swing the head right round on the way (tucking it into the back
    // feathers, where it ends up the other way round): each point just goes to its place.
    function blendXY(c1, c2, kOf) {
      var X = [], Y = [], A = [], n = c1.A.length, i, prev = null, k;
      for (i = 0; i <= n; i++) { k = kOf(i / n); X.push(c1.X[i] + (c2.X[i] - c1.X[i]) * k); Y.push(c1.Y[i] + (c2.Y[i] - c1.Y[i]) * k); }
      for (i = 0; i < n; i++) {
        var ang = Math.atan2(Y[i + 1] - Y[i], X[i + 1] - X[i]);
        if (prev === null) { while (ang - c1.A[0] > Math.PI) ang -= 2 * Math.PI; while (ang - c1.A[0] < -Math.PI) ang += 2 * Math.PI; }
        else { while (ang - prev > Math.PI) ang -= 2 * Math.PI; while (ang - prev < -Math.PI) ang += 2 * Math.PI; }
        A.push(ang); prev = ang;
      }
      return { X: X, Y: Y, A: A, jr: c1.jr + (c2.jr - c1.jr) * kOf(0) };
    }
    // The band round the centre line: its two sides at the corners' places, the tip.
    // tt: 0..1, the neck swung round to look back with the other eye
    function bandOf(ch, tt) {
      tt = tt || 0;
      var X = ch.X, Y = ch.Y, A = ch.A, n = A.length, jr = ch.jr, r = Math.min(n - 1, RIG.rung);
      var ux = -RIG.slide[0], uy = -RIG.slide[1], bx = X[0], by = Y[0];
      function dir(f) { var j = Math.max(0, Math.min(n - 1, f - 0.5)), j0 = Math.min(n - 2, Math.floor(j)); return A[j0] + (A[j0 + 1] - A[j0]) * (j - j0); }
      var a0 = dir(0), w0 = rigWidth(0);
      function side(u, sgn, end) {
        var f = u * n, k = Math.min(n - 1, Math.floor(f)), g = f - k, t = dir(f), w = rigWidth(u);
        var x = X[k] + (X[k + 1] - X[k]) * g - Math.sin(t) * w * sgn, y = Y[k] + (Y[k + 1] - Y[k]) * g + Math.cos(t) * w * sgn;
        var fa = Math.max(0, 1 - u / 0.1); fa *= fa;      // (at the chest it eases onto the corners of the joint)
        return [x + (end[0] - (bx - Math.sin(a0) * w0 * sgn)) * fa, y + (end[1] - (by + Math.cos(a0) * w0 * sgn)) * fa];
      }
      var EL = [RIG.L0[0] - ux * jr, RIG.L0[1] - uy * jr], ER = [RIG.R0[0] - ux * jr, RIG.R0[1] - uy * jr];
      var L = RIG.uL.map(function (u) { return side(u, 1, EL); }), R = RIG.uR.map(function (u) { return side(u, -1, ER); }), T = [X[n], Y[n]];
      L[0] = EL; R[0] = ER;
      if (tt) {
        // turning to look with the other eye: the slim neck and head turn round the neck's own
        // line where it leaves the thick base, as in 3D: seen from the side they narrow, then
        // open out the other way (the base, on the body, stays as it is)
        var px = X[r], py = Y[r], ex = Math.cos(A[r]), ey = Math.sin(A[r]), c = Math.cos(Math.PI * tt), ur = r / n;
        var turn = function (p, u) {
          var k = Math.max(0, Math.min(1, (u - ur) / 0.08)); k = k * k * (3 - 2 * k);
          var f = 1 + (c - 1) * k, dx = p[0] - px, dy = p[1] - py, al = dx * ex + dy * ey, pe = -dx * ey + dy * ex;
          return [px + al * ex - pe * f * ey, py + al * ey + pe * f * ex];
        };
        L = L.map(function (p, j) { return turn(p, RIG.uL[j]); });
        R = R.map(function (p, j) { return turn(p, RIG.uR[j]); });
        T = turn(T, 1);
      }
      return { L: L, R: R, tip: T, ha: A[Math.max(0, n - 9)] };
    }
    function neckShape(a, s, jd, jr, tt) { return bandOf(chainXY(a, s, jd, jr), tt); }
    function f1(v) { return Math.round(v * 10) / 10; }
    function pt(p) { return f1(p[0]) + " " + f1(p[1]); }
    var EYE_TRI = -1, EYE_R = 1.5;
    function incentre(A, B, C) {
      var la = Math.hypot(B[0] - C[0], B[1] - C[1]), lb = Math.hypot(A[0] - C[0], A[1] - C[1]), lc = Math.hypot(A[0] - B[0], A[1] - B[1]), per = la + lb + lc || 1;
      var area = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
      return [(la * A[0] + lb * B[0] + lc * C[0]) / per, (la * A[1] + lb * B[1] + lc * C[1]) / per, 2 * area / per];
    }
    // the drawing of one pose: down the sides the triangles zig-zag, L0 R0 L1 R1 ... tip
    function neckDraw(sh) {
      var L = sh.L, R = sh.R, K = L.length, i, seq = [], rim = "M" + pt(L[0]), lines = "M" + pt(R[0]);
      for (i = 0; i < K; i++) seq.push(L[i], R[i]);
      for (i = 1; i < K; i++) rim += "L" + pt(L[i]);
      rim += "L" + pt(sh.tip);
      for (i = K - 1; i >= 0; i--) rim += "L" + pt(R[i]);
      for (i = 1; i < K; i++) lines += "L" + pt(L[i]) + "L" + pt(R[i]);
      var tl = [], tr = [];
      for (i = 0; i < K; i++) { if (RIG.uL[i] >= RIG.tipU) tl.push(L[i]); if (RIG.uR[i] >= RIG.tipU) tr.push(R[i]); }
      if (!tl.length) tl.push(L[K - 1]);
      if (!tr.length) tr.push(R[K - 1]);
      var tipD = "M" + tl.map(pt).join("L") + "L" + pt(sh.tip) + "L" + tr.reverse().map(pt).join("L") + "Z";
      if (EYE_TRI < 0) {     // (once, on the upright pose: the roomiest triangle of the head)
        var best = 0;
        for (i = 0; i + 2 < seq.length; i++) {
          var u = ((i % 2 ? RIG.uR : RIG.uL)[i >> 1] + ((i + 1) % 2 ? RIG.uR : RIG.uL)[(i + 1) >> 1] + ((i + 2) % 2 ? RIG.uR : RIG.uL)[(i + 2) >> 1]) / 3;
          if (u < RIG.eyeU[0] || u > RIG.eyeU[1]) continue;
          var c = incentre(seq[i], seq[i + 1], seq[i + 2]);
          if (c[2] > best) { best = c[2]; EYE_TRI = i; }
        }
        EYE_R = Math.min(2, best * 0.86);
      }
      var e = EYE_TRI < 0 ? [sh.tip[0], sh.tip[1]] : incentre(seq[EYE_TRI], seq[EYE_TRI + 1], seq[EYE_TRI + 2]);
      return { rim: rim, lines: lines, tip: tipD, eye: [e[0], e[1]], at: sh.tip, ha: sh.ha };
    }
    var UP = neckDraw(neckShape(RIG.P.up.a, RIG.P.up.s)), HA_UP = UP.ha;
    var EYE_UP = [f1(UP.eye[0]), f1(UP.eye[1]), Math.round(EYE_R * 100) / 100];
    // sunglasses, drawn round the eye (0, 0): the near lens over it, a sliver of the far lens
    // beyond the bridge of the beak, the arm back over the head
    var SHADES = '<g class="fl-shades"><path class="fl-lens" d="M-3 -1.7H2.7Q3.2 -1.7 3.1 -1.1L2.5 1.4Q2.3 2.1 1.6 2.1H-1.9Q-2.6 2.1 -2.8 1.4L-3.4 -1.1Q-3.5 -1.7 -3 -1.7Z' +
      'M3.8 -1.5H5.5L5.1 1.1Q4.9 1.8 4.3 1.8H4.1Z"/><path class="fl-frame" d="M3.1 -1.3H3.8M-3.4 -1.1L-7.4 -2"/>' +
      '<path class="fl-glint" d="M-2 -0.8H-0.5M-1.6 0.2L0.3 -0.6"/></g>';
    // a Christmas hat (December): on the crown, just behind and above the eye, the tip
    // flopping back over the head, white fur round the brim and a bobble on the end
    function hat(e, sc) {
      return '<g class="fl-hat" transform="translate(' + f1(e[0] - 0.6) + ' ' + f1(e[1] - 0.4) + ') scale(' + (sc || 1.6) + ')">' +
        '<path class="fl-hat-red" d="M-3.4 -2.2C-3 -5.3 -1.4 -7.2 0.6 -7.4C1.6 -7.5 2.2 -6.8 1.9 -6C1.6 -5.6 1.2 -5.8 1.1 -6.2C0.4 -5.6 1.6 -3.6 2.6 -2.6Z"/>' +
        '<path class="fl-hat-fur" d="M-3.9 -2.5Q-0.6 -3.6 3 -2.9Q3.4 -1.8 3 -1.3Q-0.6 -2 -3.8 -1Q-4.3 -1.7 -3.9 -2.5Z"/>' +
        '<circle class="fl-hat-fur" cx="1.6" cy="-6.1" r="1.05"/></g>';
    }
    // (the fish only shows while the bird is fishing: it's carried crosswise at the beak's tip)
    var FISH = "M61.5 12.5L64.5 10.6L68.5 10.4L71 12L68.5 13.6L64.5 13.6ZM61.5 12.5L59 10.2L59.6 12.6L59 14.8Z" +
               "M64.5 10.6L64.5 13.6M68.5 10.4L68.5 13.6M64.5 10.6L68.5 13.6M68.5 10.4L71 12";
    function fishAt(p) { return "translate(" + f1(p[0] - 65) + " " + f1(p[1] - 12.5) + ")"; }
    // (inside the chest is hidden: whatever of the neck slides in is clipped by the body's outline)
    var clips = 0;
    function headgroup(scale) {
      var id = "fl-chest" + (++clips);
      return '<defs><clipPath id="' + id + '"><path clip-rule="evenodd" d="M-60 -60H140V180H-60Z' + RIG.clip + '"/></clipPath></defs>' +
        '<g class="fl-headgroup" clip-path="url(#' + id + ')"><g><path class="fl-net" d="' + UP.lines + '"/><path class="fl-rim" d="' + UP.rim + '"/></g>' +
        '<path class="fl-tip" d="' + UP.tip + '"/>' +
        '<g class="fl-eyeat">' + hat(EYE_UP) + eye(EYE_UP, scale) + shut(EYE_UP) + '</g>' + SHADES +
        '<g class="fl-fish" transform="' + fishAt(UP.at) + '"><path class="fl-rim" d="' + FISH + '"/></g></g>';
    }
    function svgStanding(cls) {
      // (the body can lean forward over its legs; for dancing, its wings flick open above its back)
      return '<svg class="fl ' + (cls || "") + '" viewBox="0 0 70 110" aria-hidden="true">' + net("standLegs") +
        '<g class="fl-lean"><g class="fl-wingup">' + net("standWing", "fl-wingup-far") + net("standWing") + '</g>' +
        net("stand", "fl-body") + '<path class="fl-rim fl-chest" d="' + RIG.chest + '" opacity="0"/>' + headgroup() + '</g></svg>';
    }
    // side on, for the catch window: one eye on you; now and then it swings its neck round
    // to look with the other eye, like a real bird (act(svg, "look"))
    function svgSide(cls) {
      return '<svg class="fl fl-side ' + (cls || "") + '" viewBox="0 0 70 110" aria-hidden="true">' +
        '<g class="fl-breathe">' + net("standLegs") + net("stand") + '<path class="fl-rim fl-chest" d="' + RIG.chest + '" opacity="0"/></g>' + headgroup(1.05) + '</svg>';
    }

    // Moving: everything the neck does goes through the joint at the chest. A pose is one of
    // RIG's shapes for the neck plus the joint: [shape, joint turned (degrees, + = forward),
    // slid into the chest (units), swung round to look back (0..1)]
    var POSE = {
      up: ["up", 0, 0, 0], lookL: ["up", -5, 0, 0], lookR: ["up", 7, 0.8, 0],
      bob1: ["up", -3, -0.8, 0], bob2: ["up", 6, 1, 0], upT: ["up", 0, 0, 1],
      reach: ["reach", 4, 0, 0], feed: ["feed", 6, 0, 0], dab: ["dab", 6, 0, 0], toss: ["toss", -3, 0, 0],
      rest: ["rest", -4, 8, 0],                          // nodding off: the neck folded and pulled into the chest
      tuck: ["tuck", -3, 3, 0],                          // asleep: head pushed into its back feathers, out of sight
      walk1: ["walk1", 2, -1.6, 0], walk2: ["walk2", 0, 0.9, 0],
      heart: ["heart", 0, 0, 0],                         // two of them face to face: their arched necks make a heart (RIG.P.heart)
      nuzzle: ["heart", 2.5, -0.6, 0],                   // (and they rub foreheads)
      kiss: ["up", 8, -1, 0], kissNuzzle: ["up", 10.5, -1.5, 0],   // beak to beak, leaning in (the knot of grass)
      singA: ["sing", -3, -1.2, 0], singB: ["up", 2, 0.4, 0],
      preen1: ["rest", -8, 4, 1], preen2: ["rest", -15, 6.5, 1],   // head round to its back, nibbling its feathers
      dip: ["up", 5, 1.8, 0],                            // volleyball: crouching under the ball...
      bump: ["toss", -6, -2.6, 0],                       // ...and heading it up
      startle: ["up", -8, -3, 0],                        // tapped: neck shoots up, head back
      landA: ["up", -7, -2.4, 0],                        // touching down: the neck still up from the flight...
      crouch: ["up", 9, 2.6, 0]                          // about to take off: neck drawn in, head down
    };
    // How a move goes: eased in and out, or out only, or past the pose and back ("back", a
    // little; "snap", more: quick moves have a little follow-through)
    var EASE = {
      inout: function (k) { return k * k * (3 - 2 * k); },
      out: function (k) { k = 1 - k; return 1 - k * k * k; },
      back: function (k) { var c = 1.5; k -= 1; return 1 + (c + 1) * k * k * k + c * k * k; },
      snap: function (k) { var c = 2.7; k -= 1; return 1 + (c + 1) * k * k * k + c * k * k; }
    };
    // Runs of steps: [pose, ms, mark, ease, delay, how]. delay: how far behind the chest the
    // head follows (0.2 unless said; the neck moves like a whip instead of all at once; less
    // than 0, the head leads). how: "pos" for the point-by-point blend (see blendXY). Marks:
    // "shut" eyes closed from then on, "open", "fish" a fish in its beak, "gulp" gone,
    // "shades-beak"/"shades-on", and "note"/"feather" (for the page: a note sung, a feather
    // let go). The ones that repeat go round for a while.
    var ACTS = {
      fish: [["up", 250], ["reach", 850, null, "inout", 0.3], ["feed", 750, null, "out", 0.3], ["dab", 380, null, "inout", 0.1], ["feed", 380, null, "inout", 0.1],
             ["dab", 380, null, "inout", 0.1], ["feed", 380, null, "inout", 0.1], ["reach", 650, "fish", "inout", -0.2], ["up", 760, null, "back", 0.25], ["up", 800],
             ["toss", 280, null, "out", 0.1], ["toss", 160, "gulp"], ["up", 520, null, "back", 0.2]],
      sleep: [["up", 300], ["rest", 1100, "shut", "inout", 0.25], ["tuck", 700, null, "inout", -0.35, "pos"], ["tuck", 5200],
              ["rest", 650, "open", "inout", 0.35, "pos"], ["up", 900, null, "back", 0.25]],     // (the head dives in first, and comes out last)
      walk: [], idle: [], dance: [], look: [], cheer: [],
      take: [["upT", 160, null, "inout", 0]],
      heart: [["up", 300], ["heart", 1400, null, "inout", 0.35], ["heart", 700], ["nuzzle", 480], ["heart", 480], ["nuzzle", 480], ["heart", 2800], ["up", 1000, null, "inout", 0.25]],
      kiss: [["up", 300], ["kiss", 1200, null, "inout", 0.3], ["kiss", 500], ["kissNuzzle", 420], ["kiss", 420], ["kissNuzzle", 420], ["kiss", 2800], ["up", 900, null, "inout", 0.25]],
      volley: [["up", 300]],
      bump: [["dip", 150, null, "inout", 0.1], ["bump", 130, null, "snap", 0], ["up", 430, null, "back", 0.2]],
      preen: [], sing: [],
      shades: [["up", 300, "shades-beak"], ["up", 900], ["toss", 320, null, "out", 0.1], ["toss", 120, "shades-on"], ["up", 420, null, "back", 0.2], ["up", 500]],
      startle: [["startle", 120, null, "snap", 0], ["startle", 450]],
      land: [["landA", 16, null, "inout", 0], ["up", 560, null, "back", 0.35]],     // (...settling, with a little follow-through)
      crouch: [["crouch", 300, null, "inout", 0.15]]
    };
    for (var q = 0; q < 4; q++) {
      ACTS.preen.push(["preen1", 700, null, "inout", 0.3], ["preen2", 240, null, "inout", 0.05], ["preen1", 240, null, "inout", 0.05], ["preen2", 240, "feather", "inout", 0.05],
                      ["preen1", 240, null, "inout", 0.05], ["preen2", 240, null, "inout", 0.05], ["preen1", 240, null, "inout", 0.05], ["up", 650, null, "back", 0.25], ["up", 400]);
      ACTS.sing.push(["singA", 380, "note", "back", 0.25], ["singA", 260], ["singB", 380], ["singA", 300, "note", "back", 0.25], ["singB", 420], ["up", 300]);
    }
    for (q = 0; q < 12; q++) ACTS.shades.push(["bob1", 250, null, "inout", 0.3], ["bob2", 250, null, "inout", 0.3]);     // (cool now: bobbing to the music)
    for (q = 0; q < 4; q++) ACTS.cheer.push(["bob1", 220, null, "inout", 0.3], ["bob2", 220, null, "inout", 0.3]);
    ACTS.cheer.push(["up", 400]);
    for (var w = 0; w < 30; w++) {
      ACTS.walk.push(["walk1", 230, null, "inout", 0.15], ["walk2", 230, null, "inout", 0.15]);     // (in step with fl-walk's 0.46s)
      ACTS.dance.push(["bob1", 250, null, "inout", 0.3], ["bob2", 250, null, "inout", 0.3]);       // (to the music: a whip of the neck)
    }
    for (w = 0; w < 8; w++) {
      ACTS.idle.push(["up", 1500], ["lookL", 450, null, "inout", 0.25], ["lookL", 700], ["up", 450, null, "inout", 0.25], ["up", 900],
                     ["lookR", 500, null, "inout", 0.25], ["lookR", 600], ["up", 500, null, "inout", 0.25]);
      ACTS.look.push(["up", 2600], ["upT", 240, null, "inout", 0], ["upT", 2500], ["up", 240, null, "inout", 0]);
    }
    function act(svg, name) {
      if (!svg) return;
      var st = svg._neck;
      if (!st) {
        var hg = svg.querySelector(".fl-headgroup");
        if (!hg) return;
        st = svg._neck = { a: RIG.P.up.a.slice(), s: RIG.P.up.s, lean: 0, jd: 0, jr: 0, tt: 0, at: UP.at, raf: 0, ch: null, pop: 0,
          net: hg.querySelector(".fl-net"), rim: hg.querySelector(".fl-rim"), tip: hg.querySelector(".fl-tip"),
          eye: hg.querySelector(".fl-eyeat"), fish: hg.querySelector(".fl-fish"), lean_g: svg.querySelector(".fl-lean"), chest: svg.querySelector(".fl-chest"),
          shades: hg.querySelector(".fl-shades") };
      }
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      var steps = name ? ACTS[name] : [["up", 450, "open"]];
      if (!steps) return;
      if (!name || name === "idle") svg.classList.remove("has-fish");
      if (name !== "shades" && !(name === null && svg.classList.contains("shades-on"))) svg.classList.remove("has-shades", "shades-beak", "shades-on");
      var i = -1, t0 = 0, from = null;
      if (name === "idle" || name === "dance" || name === "walk") i = Math.floor(Math.random() * (name === "idle" ? 8 : 2)) - 1;
      function mark(m) {
        if (!m) return;
        if (m === "shut") svg.classList.add("is-shut");
        else if (m === "open") svg.classList.remove("is-shut");
        else if (m === "fish") svg.classList.add("has-fish");
        else if (m === "gulp") svg.classList.remove("has-fish");
        else if (m === "shades-beak") { svg.classList.add("has-shades", "shades-beak"); }
        else if (m === "shades-on") { svg.classList.remove("shades-beak"); svg.classList.add("has-shades", "shades-on"); st.pop = performance.now(); }
        // (and the page hears of it: a note, a feather, the glint off new sunglasses...)
        try { svg.dispatchEvent(new CustomEvent("flmark", { bubbles: true, detail: m })); } catch (e) { /* old browser: no extras */ }
      }
      function next(t) {
        i++; t0 = t;
        if (i >= steps.length) return false;
        from = { a: st.a.slice(), s: st.s, lean: st.lean, jd: st.jd, jr: st.jr, tt: st.tt, ch: st.ch };
        mark(steps[i][2]);
        return true;
      }
      function draw() {
        var d = neckDraw(st.ch ? bandOf(st.ch, st.tt) : neckShape(st.a, st.s, st.jd, st.jr, st.tt));
        st.net.setAttribute("d", d.lines); st.rim.setAttribute("d", d.rim); st.tip.setAttribute("d", d.tip);
        st.eye.setAttribute("transform", "translate(" + f1(d.eye[0] - EYE_UP[0]) + " " + f1(d.eye[1] - EYE_UP[1]) + ")");
        st.fish.setAttribute("transform", fishAt(d.at));
        st.at = d.at;
        if (st.shades) {        // worn on the eye, turning with the head; or held crosswise in the beak
          var turnHead = ((d.ha - HA_UP) * 180 / Math.PI).toFixed(1);
          var pop = st.pop ? Math.max(0, 1 - (performance.now() - st.pop) / 300) : 0;       // (they land with a little bounce)
          st.shades.setAttribute("transform", svg.classList.contains("shades-beak")
            ? "translate(" + f1(d.at[0] - 1.5) + " " + f1(d.at[1] + 2.4) + ") rotate(" + (+turnHead + 64).toFixed(1) + ") scale(1.45)"
            : "translate(" + f1(d.eye[0] + 0.9) + " " + f1(d.eye[1] + 0.2 - 2.5 * pop * pop) + ") rotate(" + turnHead + ") scale(" + (1.7 * (1 + 0.4 * pop * pop)).toFixed(2) + ")");
        }
        if (st.chest) st.chest.setAttribute("opacity", Math.max(0, Math.min(1, st.jr / 4)).toFixed(2));     // (the chest's own edge, once the neck is in)
        if (st.lean_g) st.lean_g.setAttribute("transform", st.lean ? "rotate(" + st.lean.toFixed(2) + " " + RIG.hip[0] + " " + RIG.hip[1] + ")" : "");
      }
      function frame(t) {
        st.raf = 0;
        if (!svg.isConnected) return;
        if (!from && !next(t)) return;
        var s = steps[i], P = POSE[s[0]], to = RIG.P[P[0]], raw = Math.min(1, (t - t0) / s[1]);
        var ez = EASE[s[3] || "inout"], lag = s[4] == null ? 0.2 : s[4], al = Math.abs(lag), n = st.a.length, j;
        // how far along the move each part of the neck is: the chest first, the head a beat
        // behind (or the head first, when lag < 0)
        var kAt = function (u) { var d = lag >= 0 ? lag * u : al * (1 - u); return ez(Math.max(0, Math.min(1, (raw - d) / (1 - al)))); };
        var kb = kAt(0), jdT = P[1] * Math.PI / 180;
        st.s = from.s + (to.s - from.s) * kb;
        st.lean = from.lean + ((to.lean || 0) - from.lean) * kb;
        st.jd = from.jd + (jdT - from.jd) * kb;
        st.jr = from.jr + (P[2] - from.jr) * kb;
        st.tt = from.tt + (P[3] - from.tt) * kb;
        if (s[5] === "pos") {
          st.ch = blendXY(from.ch || chainXY(from.a, from.s, from.jd, from.jr), chainXY(to.a, to.s, jdT, P[2]), kAt);
          for (j = 0; j < n; j++) st.a[j] = st.ch.A[j] - st.jd;      // (as link directions too, should another move start from here)
        } else {
          st.ch = null;
          for (j = 0; j < n; j++) st.a[j] = from.a[j] + (to.a[j] - from.a[j]) * kAt(j / (n - 1));
        }
        draw();
        if (raw >= 1) {
          if (s[5] === "pos") { st.a = to.a.slice(); st.s = to.s; st.ch = null; }
          if (!next(t)) return;
        }
        st.raf = requestAnimationFrame(frame);
      }
      st.raf = requestAnimationFrame(frame);
    }
    // where the tip of its beak is now (viewBox units), for the note going into it
    function tipOf(svg) { return (svg && svg._neck && svg._neck.at) || UP.at; }
    // and where it would be in a given pose (for spacing two birds so their beaks meet)
    function tipFor(name) {
      var P = POSE[name] || POSE.up, sh = RIG.P[P[0]];
      return neckDraw(neckShape(sh.a, sh.s, P[1] * Math.PI / 180, P[2], P[3])).at;
    }
    // the furthest forward the neck and head reach in a pose (x, in the drawing's units)
    function frontFor(name) {
      var P = POSE[name] || POSE.up, sh = RIG.P[P[0]], c = chainXY(sh.a, sh.s, P[1] * Math.PI / 180, P[2]);
      return Math.max.apply(null, c.X.slice(RIG.rung)) + 1.2;      // (+ about half the head's width)
    }

    // For the 3D flock: a strip of wing-beat frames drawn on a canvas, `frames` wide
    function atlas(frames, w, h, colors) {
      var cv = document.createElement("canvas");
      cv.width = w * frames; cv.height = h;
      var x = cv.getContext("2d"), s = w / 140;
      function path(d) { try { return new Path2D(d); } catch (e) { return null; } }
      var body = { rim: path(LOWPOLY.fly.rim), lines: path(LOWPOLY.fly.lines), tip: path(TIP.fly) };
      var wing = { rim: path(LOWPOLY.flyWing.rim), lines: path(LOWPOLY.flyWing.lines) };
      if (!body.rim || !body.lines) return null;
      function draw(p) {
        x.globalAlpha *= 0.75; x.lineWidth = 0.85 / s; x.stroke(p.lines); x.globalAlpha /= 0.75;
        x.lineWidth = 1.35 / s; x.stroke(p.rim);
      }
      for (var f = 0; f < frames; f++) {
        // a real wingbeat: a quick downstroke (the first 40%), a slower recovery; the body
        // lifts a touch as the wings push down
        var u = f / frames;
        var flap = u < 0.4 ? Math.cos(Math.PI * u / 0.4) : -Math.cos(Math.PI * (u - 0.4) / 0.6);   // 1 = wings up, -1 = down
        var lift = u < 0.4 ? Math.sin(Math.PI * u / 0.4) * 1.4 : 0;
        x.save();
        x.translate(f * w, (h - 70 * s) / 2 - lift * s);
        x.scale(s, s);
        x.strokeStyle = colors.line; x.fillStyle = colors.line; x.lineJoin = "round"; x.lineCap = "round";
        function drawWing(far) {
          x.save();
          x.translate(66, 31); x.scale(1, flap * (far ? 0.75 : 1) || 0.05); x.translate(-66, -31);
          x.globalAlpha = far ? 0.55 : 1;
          draw(wing);
          x.restore();
        }
        drawWing(true);
        draw(body);
        if (body.tip) { x.globalAlpha = 0.5; x.fill(body.tip); x.globalAlpha = 1; }
        x.beginPath(); x.arc(EYE.fly[0] + 0.3, EYE.fly[1], 1.1, 0, Math.PI * 2); x.fill();     // the eye, as a dot at this size
        drawWing(false);
        x.restore();
      }
      return cv;
    }
    function colors() {
      return document.body.classList.contains("dark-mode") ? { line: "#d6ae6a" } : { line: "#b8894b" };
    }
    // the guide's pencil sketch of a flamingo uses the same drawing
    Array.prototype.forEach.call(document.querySelectorAll(".guide-lowpoly"), function (g) {
      try { g.innerHTML = net("flyWing", "ga-flap") + net("fly") + tip("fly") + eye(EYE.fly); } catch (e) { /* old browsers: no sketch */ }
    });
    return { svgFlying: svgFlying, svgStanding: svgStanding, svgSide: svgSide, act: act, tipOf: tipOf, tipFor: tipFor, frontFor: frontFor, atlas: atlas, colors: colors,
             dev: { POSE: POSE, ACTS: ACTS } };     // (dev: for the page tests, which try out poses)
  })();

  /* ---------------- Flamingos on the page ----------------
     While you listen, now and then a flamingo flies in and lands on the radio (on the
     waveform window, or the name plate) for a few seconds, then takes off again. Catch it
     (tap it) and you can give it a short note: the server keeps it for two hours (one when seven are waiting), and now
     and then a flamingo flies across everyone's screen skywriting one of the notes. */
  var flamingos = (function () {
    var layer = $("fl-layer"), back = $("fl-back"), dlg = $("catch-dialog");
    if (!layer || !dlg) return { sky: function () {} };
    var timer = 0, out = [], skyOpen = true;     // visitors on screen now (up to two)
    // How long this listener has been listening, without a break (0..1 over the first
    // 40 minutes): the longer you stay, the more flamingos come round
    var listenSince = 0;
    function loyalty() { return listenSince ? Math.min(1, (Date.now() - listenSince) / 2400000) : 0; }
    function allowed() {
      return skyOpen && !perf.reducedMotion && !document.hidden && !flipped &&
             !document.querySelector("dialog[open]") && $("guide").hidden;
    }

    // Every bird lives in a 100 x 100 box with its feet at the bottom middle; the flying and
    // the standing drawing are both in it and cross-fade, so landing and taking off are one
    // smooth change instead of a jump between two pictures of different sizes
    var BOX = 100, FW = 120, FH = 60;
    // The time of year: "xmas" (15 Dec - 2 Jan): some of them wear Christmas hats, and now
    // and then one comes by to wish everyone a merry Christmas; "nowruz"
    // (the Persian new year, 13 Mar to Sizdah Bedar, 2 Apr): now and then a black flamingo
    // comes by to wish everyone a happy Nowruz, and two of them tie grass together, the way
    // people tie sabzeh on Sizdah Bedar for a wish. (window.raadioSeason: the page tests)
    function season() {
      if (typeof window.raadioSeason === "string") return window.raadioSeason;
      var d = new Date(), m = d.getMonth() + 1, day = d.getDate();
      if ((m === 12 && day >= 15) || (m === 1 && day <= 2)) return "xmas";
      if ((m === 3 && day >= 13) || (m === 4 && day <= 2)) return "nowruz";
      return "";
    }
    // Every flamingo off the radio's screen is this one size: flying in, perched, peeking over
    // the top, circling the radio, taking off (the ones on the screen are SCREEN_S)
    var BIRD_S = 0.9;
    var LINGER = 1000;     // how much longer than it used to, each visit stays on the page
    function bez(a, c, b, t) { var u = 1 - t; return u * u * a + 2 * u * t * c + t * t * b; }
    function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    function easeIn(t) { return t * t * t; }
    function rectOf(el) { var r = el && el.getBoundingClientRect(); return r && r.width ? r : null; }
    function card() { return rectOf(document.querySelector(".face--front")); }
    function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

    // One flamingo on screen: its own button, position and animation, so two can be out at once
    function Visitor() {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "fl-bird is-flying";
      b.setAttribute("aria-label", "Catch the flamingo");
      b.innerHTML = '<span class="fl-pose fl-pose--fly">' + flamingoArt.svgFlying() + '</span>' +
                    '<span class="fl-pose fl-pose--stand">' + flamingoArt.svgStanding() + '</span>' +
                    '<span class="fl-zz" aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>';
      b.style.setProperty("--s", String(BIRD_S));
      var v = { el: b, raf: 0, x: null, y: null, t: 0, rot: 0, flip: false, s: BIRD_S, sink: 0, gliding: false, extra: "", done: false };
      if (season() === "xmas" && (Math.random() < 0.55 || window.raadioSeason === "xmas")) {
        Array.prototype.forEach.call(b.querySelectorAll("svg.fl"), function (sv) { sv.classList.add("has-hat"); });
      }
      b.addEventListener("click", function (e) { e.preventDefault(); caught(v); });
      // (each bird blinks and beats its wings in its own time, so two never move as one)
      Array.prototype.forEach.call(b.querySelectorAll(".fl-eye"), function (e) { e.style.animationDelay = (-Math.random() * 4.2).toFixed(2) + "s"; });
      var beat = (-Math.random() * 0.5).toFixed(2);
      Array.prototype.forEach.call(b.querySelectorAll(".fl-wing--near, .fl-flybody"), function (e) { e.style.animationDelay = beat + "s"; });
      Array.prototype.forEach.call(b.querySelectorAll(".fl-wing--far"), function (e) { e.style.animationDelay = (beat - 0.07).toFixed(2) + "s"; });
      // a note sung, a feather let go, the glint off new sunglasses: right on the move's cue
      b.addEventListener("flmark", function (e) {
        if (v.done) return;
        if (e.detail === "note") note(v);
        else if (e.detail === "feather") feather(v);
        else if (e.detail === "shades-on") sparkle(v);
      });
      layer.appendChild(b);
      return v;
    }
    // Feet at (x, y). `lean` (degrees) holds a set angle; without it the bird leans into its
    // path: nose down as it drops, up as it climbs. It glides, wings held out, while it's
    // coming down steadily and beats them otherwise. `s` scales it (further away, smaller).
    // Smoothing goes by time, so it looks the same at 60 or 120 frames a second.
    function place(v, x, y, flip, lean, s) {
      var now = performance.now(), dt = v.t ? Math.min(80, Math.max(1, now - v.t)) : 16;
      var k = 1 - Math.exp(-dt / (v.el.classList.contains("is-standing") ? 60 : 120));   // (on its feet it straightens up quicker)
      v.t = now;
      var want = 0, glide = false;
      if (lean !== undefined) want = lean;
      else if (v.x !== null) {
        var dx = x - v.x, dy = y - v.y;
        want = Math.abs(dx) + Math.abs(dy) > 0.3 ? Math.max(-22, Math.min(22, Math.atan2(dy, Math.abs(dx) + 0.01) * 57.3 * 0.55)) : v.rot;
        v.sink += (dy * 16 / dt - v.sink) * k;      // how fast it's coming down (px a frame, smoothed)
        glide = v.sink > (v.gliding ? 0.5 : 1.1);   // (a little hysteresis: no flickering between the two)
      }
      if (v.el.classList.contains("is-standing")) glide = false;
      if (glide !== v.gliding) { v.gliding = glide; v.el.classList.toggle("is-gliding", glide); }
      v.rot += (want - v.rot) * k;
      if (s !== undefined && Math.abs(s - v.s) > 0.002) { v.s = s; v.el.style.setProperty("--s", s.toFixed(3)); }
      // turning round: it swivels (narrowing side-on, then opening out the other way) instead
      // of flipping in one frame
      var face = flip ? -1 : 1;
      if (v.fs == null || v.x === null) v.fs = face;
      else { v.fs += (face - v.fs) * (1 - Math.exp(-dt / 55)); if (Math.abs(face - v.fs) < 0.01) v.fs = face; }
      var left = v.fs < 0;
      if (v.shownLeft !== left) { v.shownLeft = left; v.el.setAttribute("data-left", left ? "1" : ""); }
      v.x = x; v.y = y; v.flip = flip;
      v.el.style.transform = "translate(" + (x - BOX / 2).toFixed(1) + "px," + (y - BOX).toFixed(1) + "px)" +
        (v.fs !== 1 ? " scaleX(" + v.fs.toFixed(3) + ")" : "") + (Math.abs(v.rot) > 0.2 ? " rotate(" + v.rot.toFixed(1) + "deg)" : "");
    }
    // on the near side of the radio (over it) or the far side (behind it)
    function side(v, front) {
      var want = front ? layer : back;
      if (want && v.el.parentNode !== want) want.appendChild(v.el);
    }
    // standing or flying, and what it's doing ("is-flaring", "is-sleeping"...)
    function pose(v, name, extra) {
      extra = extra || "";
      var cls = "fl-bird is-" + name + (extra ? " " + extra : "") + (v.gliding && name === "flying" ? " is-gliding" : "") + (v.black ? " is-black" : "");
      if (v.el.className !== cls) { v.el.className = cls; neckFor(v, name, extra); }
    }
    // standing, everything the neck does goes through its joint at the chest: fishing, asleep,
    // walking, dancing, or just looking about; flying, it rests
    function neckFor(v, name, extra) {
      var want = null;
      if (name === "standing") {
        var map = [["is-landing", "land"], ["is-crouching", "crouch"], ["is-fishing", "fish"], ["is-sleeping", "sleep"], ["is-walking", "walk"], ["is-dancing", "dance"], ["is-shades", "shades"],
                   ["is-preening", "preen"], ["is-singing", "sing"], ["is-heart", "heart"], ["is-kiss", "kiss"], ["is-volley", "volley"]];
        want = "idle";
        for (var m = 0; m < map.length; m++) if (new RegExp("\\b" + map[m][0] + "\\b").test(extra)) { want = map[m][1]; break; }
      }
      if (want === (v.neck || null)) return;
      v.neck = want;
      try { flamingoArt.act(v.el.querySelector(".fl-pose--stand .fl"), want); } catch (e) { /* the drawing just stays as it is */ }
    }
    function has(v, c) { return v.el.classList.contains(c); }
    // the drawing that's showing, for things placed beside it (a speech bubble, stars)
    function body(v) { return rectOf(v.el.querySelector(has(v, "is-standing") ? ".fl-pose--stand" : ".fl-pose--fly")) || v.el.getBoundingClientRect(); }
    // runs steps one after another: each is [duration ms, function (k 0..1)]. Anything going
    // wrong ends the visit cleanly, so a stuck bird can never stop the visits for good.
    function run(v, steps) {
      var i = 0, t0 = performance.now();
      function frame(t) {
        v.raf = 0;
        if (v.done) return;
        try {
          var st = steps[i], k = Math.min(1, Math.max(0, (t - t0) / st[0]));
          st[1](k);
          if (k >= 1) { i++; t0 = t; if (i >= steps.length) { leave(v); return; } }
        } catch (e) { leave(v); return; }
        v.raf = requestAnimationFrame(frame);
      }
      v.raf = requestAnimationFrame(frame);
    }

    // Where it lands: the top edge of the waveform window, beside the song's name.
    // (Not the name plate: on a phone there's no room above it to see the bird.)
    // `avoid` keeps a second bird off the first one's side.
    function perch(avoid) {
      var el = document.querySelector(".face--front .wave");
      var r = rectOf(el), t = null;
      if (!r) return null;
      try { var rg = document.createRange(); rg.selectNodeContents($("song-name")); t = rectOf(rg); } catch (e) { /* ignore */ }
      var room = [];
      if (t) {
        var lo = (t.left - 34 - r.left) / r.width, hi = (t.right + 34 - r.left) / r.width;
        if (lo > 0.08) room.push([0.08, lo]);
        if (hi < 0.92) room.push([hi, 0.92]);
      }
      if (!room.length) room = [[0.06, 0.1], [0.9, 0.94]];    // a long name: right at the ends
      if (avoid != null) {
        var other = room.filter(function (g) { return (g[0] + g[1]) / 2 < 0.5 !== avoid < 0.5; });
        if (other.length) room = other;
      }
      var g = pick(room);
      return { el: el, fx: g[0] + Math.random() * (g[1] - g[0]) };
    }
    function spot(p) { var r = rectOf(p.el); return r ? { x: r.left + r.width * p.fx, y: r.top + 2 } : null; }
    // (if the page moves under a perched bird, e.g. a longer song title, it steps across to
    // its new place instead of jumping there)
    function steady(v, p) {
      var t = performance.now(), dt = v.ht ? Math.min(80, t - v.ht) : 16;
      v.ht = t;
      if (v.hx == null || Math.abs(p.x - v.hx) + Math.abs(p.y - v.hy) > 200) { v.hx = p.x; v.hy = p.y; }
      else { var k = 1 - Math.exp(-dt / 120); v.hx += (p.x - v.hx) * k; v.hy += (p.y - v.hy) * k; }
      return { x: v.hx, y: v.hy };
    }

    // What it does once it has landed
    var ACTIVITIES = [
      ["is-fishing", 16],      // dips its head down and comes up with a fish
      ["is-sleeping", 12],     // pulls its head in and dozes off
      ["is-dancing", 14],      // bobs to the music, wings flicking open
      ["is-shades", 15],       // brings a pair of sunglasses, flips them on, and is cool
      ["is-preening", 14],     // turns round to tidy its back feathers (one floats away)
      ["is-singing", 15],      // sings along: notes float up from its beak
      ["", 14]                 // just looks about
    ];
    function activity() {
      if (typeof window.raadioFlamingoAct === "string") return window.raadioFlamingoAct;   // (the page tests pick one)
      var total = 0, r, i;
      for (i = 0; i < ACTIVITIES.length; i++) total += ACTIVITIES[i][1];
      r = Math.random() * total;
      for (i = 0; i < ACTIVITIES.length; i++) { r -= ACTIVITIES[i][1]; if (r < 0) return ACTIVITIES[i][0]; }
      return "";
    }

    // 1. glides in, brakes with its wings and lands on the waveform window; fishes, sleeps,
    //    bobs to the music or looks about; crouches and springs off the other way
    function perchVisit(v, avoid) {
      var p = perch(avoid), s = p && spot(p);
      if (!s) return false;
      v.fx = p.fx;
      var vw = window.innerWidth, vh = window.innerHeight;
      var fromLeft = avoid != null ? avoid > 0.5 : Math.random() < 0.5, dir = fromLeft ? 1 : -1;
      var sx = fromLeft ? -FW : vw + FW, sy = vh * (0.06 + Math.random() * 0.28), ex = fromLeft ? vw + FW : -FW, ey = -FH - vh * 0.08;
      var act = activity(), stay = LINGER + (act === "is-fishing" ? 7400 : act === "is-sleeping" ? 9000 : act === "is-preening" ? 8200 :
                                             act === "is-shades" ? 8000 : 6000 + Math.random() * 3000);
      var talk = (act === "" || act === "is-dancing" || act === "is-shades") && Math.random() < 0.5;
      if (v.greet) { talk = true; if (act === "is-sleeping" || act === "is-fishing" || act === "is-preening") act = ""; }
      var from = null;
      side(v, true); pose(v, "flying");
      run(v, [
        [2900, function (k) {                       // the approach: fast at first, slowing all the way
          var now = spot(p) || s, e = easeOut(k);
          var cx = (sx + now.x) / 2, cy = Math.min(sy, now.y) - vh * 0.1;
          var flare = k > 0.72;                      // the last stretch: wings beating fast, nose up, legs down
          if (flare) pose(v, "flying", "is-flaring");
          // (nose up while braking, level again by the time its feet touch)
          place(v, bez(sx, cx, now.x, e), bez(sy, cy, now.y, e) + FH * 0.3 * (1 - e), dir < 0, flare ? -16 * Math.sin(Math.PI * Math.min(1, (k - 0.72) / 0.28)) : undefined);
          if (k >= 1) pose(v, "standing", "is-landing");
        }],
        [450, function (k) {                        // touches down and settles its weight
          var now = spot(p) || s;
          v.hx = now.x; v.hy = now.y;
          place(v, now.x, now.y, dir < 0, 0);
          if (k >= 1) pose(v, "standing", act);
        }],
        [stay, function (k) {
          var now = steady(v, spot(p) || s);
          place(v, now.x, now.y, dir < 0, 0);
          if (talk && k > (act === "is-shades" ? 0.35 : 0.15) && !v.bubble) say(v, v.greet || (act === "is-shades" && Math.random() < 0.5 ? "Too cool" : message()), Math.min(stay * 0.55, 5200));
          if (k >= 1) pose(v, "standing", "is-crouching");
        }],
        [320, function (k) {                        // crouches...
          var now = steady(v, spot(p) || s);
          place(v, now.x, now.y, dir < 0, 0);
          if (k >= 1) { pose(v, "flying", "is-flaring is-leaving"); from = now; }
        }],
        [2600, function (k) {                       // ...springs up, beating hard, then speeds away
          if (k > 0.35) pose(v, "flying", "is-leaving");
          var e = easeIn(k), up = Math.sin(Math.min(1, k * 2.2) * Math.PI / 2);
          place(v, bez(from.x, from.x + dir * vw * 0.18, ex, e), from.y - up * 46 + (ey - from.y + 46) * e, dir < 0, k < 0.3 ? -18 : undefined);
        }]
      ]);
      return true;
    }

    // 2. flies one circle around the radio: behind it across the top, in front of it across
    //    the bottom, then away
    // (o, for a pair flying round together: {fromLeft, lag: ms behind the leader, dr: px wider})
    function orbitVisit(v, o) {
      var r = card();
      if (!r) return false;
      o = o || {};
      var vw = window.innerWidth, vh = window.innerHeight, S = BIRD_S;
      var fromLeft = o.fromLeft != null ? o.fromLeft : Math.random() < 0.5, dr = o.dr || 0;
      function ring(th) {
        var c = card() || r;
        var cx = c.left + c.width / 2, cy = c.top + Math.min(70, c.height * 0.12);
        var rx = Math.min(c.width / 2 + 36, vw / 2 - FW * 0.32) + dr, ry = Math.max(40, Math.min(95, cy - 30)) + dr * 0.4;
        return { x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th), far: Math.sin(th) < -0.05, depth: (Math.sin(th) + 1) / 2 };
      }
      var th0 = fromLeft ? Math.PI : 0, turn = fromLeft ? 1 : -1;
      var start = { x: fromLeft ? -FW : vw + FW, y: vh * (0.1 + Math.random() * 0.12) };
      // banking: it tips its wings into the turn, most at the sides of the circle
      function put(p, movingRight, bank) {
        side(v, !p.far);
        place(v, p.x, p.y, !movingRight, bank, S);
      }
      side(v, true); pose(v, "flying", "is-orbiting");
      var exitFrom = null;
      if (o.lag) place(v, start.x, start.y, !fromLeft, 0, S);      // waits off screen a moment
      run(v, [
        [o.lag || 1, function () {}],
        [1700, function (k) {
          var e = ease(k), p = ring(th0);
          put({ x: start.x + (p.x - start.x) * e, y: start.y + (p.y - start.y) * e, far: false, depth: 0.5 }, fromLeft);
        }],
        [7000 + LINGER, function (k) {
          var th = th0 + turn * 2 * Math.PI * k, p = ring(th);
          put(p, -Math.sin(th) * turn > 0, Math.cos(th) * 9 * (p.far ? -1 : 1));
          if (k >= 1) exitFrom = p;
        }],
        [1900, function (k) {
          var e = k * k, tx = fromLeft ? vw + FW * 1.5 : -FW * 1.5, ty = -FH - vh * 0.04;
          var cx = exitFrom.x + (fromLeft ? 1 : -1) * vw * 0.35;
          put({ x: bez(exitFrom.x, cx, tx, e), y: bez(exitFrom.y, exitFrom.y - vh * 0.05, ty, e), far: false, depth: 0.5 }, fromLeft);
        }]
      ]);
      return true;
    }

    // 3. stands behind the radio and peeks over its top edge: up, a look around, down,
    //    up again a little further along, then takes off from behind it. (Drawn in front,
    //    cut off at the radio's top edge, so the part you can see can be tapped.)
    function peekVisit(v) {
      var r = card();
      if (!r || r.top < 40) return false;
      var fx1 = 0.2 + Math.random() * 0.25, fx2 = fx1 + 0.25 + Math.random() * 0.2, dir = Math.random() < 0.5 ? 1 : -1;
      var hidden = 103 * BIRD_S, shown = 55 * BIRD_S;   // how far below the top edge its feet are
      function at(fx, lift) { var c = card() || r; return { x: c.left + c.width * fx, y: c.top + hidden - (hidden - shown) * lift, top: c.top }; }
      function show(p, flip, lean) {
        place(v, p.x, p.y, flip, lean);
        var cut = Math.max(0, p.y - p.top);         // the part below the top edge is behind the radio
        v.el.style.clipPath = cut ? "inset(-30px -30px " + cut.toFixed(1) + "px -30px)" : "";
      }
      side(v, true); pose(v, "standing");
      var last = null, vw = window.innerWidth;
      run(v, [
        [900, function (k) { show(at(fx1, ease(k)), dir < 0, 0); }],
        [3000 + LINGER / 2, function () { show(at(fx1, 1), dir < 0, 0); }],
        [500, function (k) { show(at(fx1, 1 - ease(k)), dir < 0, 0); }],
        [700, function () { show(at(fx2, 0), dir > 0, 0); }],
        [800, function (k) { show(at(fx2, ease(k)), dir > 0, 0); }],
        [2600 + LINGER / 2, function (k) { var p = at(fx2, 1); show(p, dir > 0, 0); if (k >= 1) { last = p; pose(v, "flying", "is-flaring is-leaving"); } }],
        [2400, function (k) {
          if (k > 0.35) pose(v, "flying", "is-leaving");
          var e = easeIn(k), tx = dir > 0 ? vw + 80 : -80, c = card() || r;
          show({ x: last.x + (tx - last.x) * e, y: last.y - 40 - 170 * Math.sqrt(k), top: c.top }, dir < 0, k < 0.3 ? -18 : undefined);
        }]
      ]);
      return true;
    }

    // Now and then a landed flamingo has something to tell you, in a little speech bubble:
    // a show starting in a few minutes, the song coming up next, or just a word or two
    var CHAT = ["Love this one", "Turn it up!", "Tap me, leave a note", "Not for you? Skip it"];
    function message() {
      var ev = typeof news !== "undefined" && news.soon ? news.soon(12) : null;
      if (ev) return ev.text + " in " + ev.mins + " min";
      if (nextUp && Math.random() < 0.75) return "Next: " + nextUp.title;
      return pick(CHAT);
    }
    // where the tip of its beak is on the screen (the fish it can carry sits right there, so its
    // box follows the neck, the lean and which way the bird faces)
    function beakAt(v) {
      var f = has(v, "is-standing") && v.el.querySelector(".fl-pose--stand .fl-fish"), r = f && rectOf(f);
      if (r) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      var b = body(v);
      return { x: b.left + b.width * (v.el.getAttribute("data-left") === "1" ? 0.28 : 0.72), y: b.top + b.height * 0.15 };
    }
    // the bubble grows from its point, stays clear of the bird as it moves (a dotted line
    // leads back to the beak), and shrinks back into the point
    function say(v, text, ms) {
      if (!text || v.done) return;
      var bub = document.createElement("div"), words = document.createElement("span");
      bub.className = "fl-say";
      bub.setAttribute("role", "status");
      bub.dir = "auto";
      words.textContent = text;
      bub.appendChild(words);
      layer.appendChild(bub);
      v.bubble = bub;
      var bw = bub.offsetWidth, bh = bub.offsetHeight, was = "";   // (its size stays put while it's up)
      function pos() {
        if (v.done || !bub.isConnected) return;
        // Never over a bird: in front of the beak past the whole bird, else above the whole
        // bird, else behind it. A dotted line runs from the bubble's point back to the beak.
        var p = beakAt(v), b = body(v);
        var vw = window.innerWidth, vh = window.innerHeight, g = 12, x, y, side;
        var facesLeft = v.el.getAttribute("data-left") === "1";
        var ahead = facesLeft ? Math.min(p.x, b.left) - g - bw : Math.max(p.x, b.right) + g;
        var midY = Math.max(8, Math.min(vh - bh - 8, p.y - bh / 2));
        if (ahead >= 8 && ahead + bw <= vw - 8) { x = ahead; y = midY; side = facesLeft ? "r" : "l"; }
        else if (b.top - bh - g >= 8) { x = Math.max(8, Math.min(vw - bw - 8, p.x - bw / 2)); y = b.top - bh - g; side = "b"; }
        else {
          x = facesLeft ? Math.max(p.x, b.right) + g : Math.min(p.x, b.left) - g - bw;
          x = Math.max(8, Math.min(vw - bw - 8, x)); y = midY; side = facesLeft ? "l" : "r";
        }
        var tx, ty, stalk;
        if (side === "b") { tx = Math.max(11, Math.min(bw - 11, p.x - x)); ty = bh; stalk = p.y - (y + bh) - 6; }
        else { ty = Math.max(9, Math.min(bh - 9, p.y - y)); tx = side === "l" ? 0 : bw; stalk = side === "l" ? x - p.x - 6 : p.x - (x + bw) - 6; }
        var X = x.toFixed(0), Y = y.toFixed(0), TX = tx.toFixed(0), TY = ty.toFixed(0), ST = Math.max(0, stalk).toFixed(0);
        var now = side + X + "," + Y + "," + TX + "," + TY + "," + ST;
        if (now !== was) {                 // (a bird standing still costs the page nothing)
          was = now;
          bub.setAttribute("data-tail", side);
          bub.style.setProperty("--tail-x", TX + "px");
          bub.style.setProperty("--tail-y", TY + "px");
          bub.style.setProperty("--stalk", ST + "px");
          bub.style.transformOrigin = TX + "px " + TY + "px";
          bub.style.left = X + "px"; bub.style.top = Y + "px";   // (not a transform: the pop-in scale would carry it off)
        }
        requestAnimationFrame(pos);
      }
      pos();
      requestAnimationFrame(function () { requestAnimationFrame(function () { bub.classList.add("is-in"); }); });
      setTimeout(function () { bub.classList.remove("is-in"); setTimeout(function () { bub.remove(); }, 420); }, ms || 4800);
    }

    // Little things that come off a bird: a note it sings, a feather it lets go, the glint
    // off its sunglasses, a heart, a "!"
    function fx(x, y, html, cls, ms) {
      var e = document.createElement("div");
      e.className = "fl-fx " + cls;
      e.innerHTML = html;
      e.style.left = x.toFixed(0) + "px"; e.style.top = y.toFixed(0) + "px";
      layer.appendChild(e);
      setTimeout(function () { e.remove(); }, ms);
      return e;
    }
    function facing(v) { return v.el.getAttribute("data-left") === "1" ? -1 : 1; }
    function note(v) {
      var p = beakAt(v);
      var e = fx(p.x + facing(v) * 4, p.y - 6, Math.random() < 0.5 ? "♪" : "♫", "fx-note", 2000);
      e.style.setProperty("--dx", (facing(v) * (8 + Math.random() * 14)).toFixed(0) + "px");
    }
    function feather(v) {
      if (Math.random() < 0.45) return;                      // (not every nibble)
      var b = body(v), e = fx(b.left + b.width * (facing(v) > 0 ? 0.35 : 0.65), b.top + b.height * 0.4, FEATHER, "fx-feather", 3200);
      e.style.setProperty("--dx", (-facing(v) * (16 + Math.random() * 14)).toFixed(0) + "px");
    }
    function sparkle(v) { var p = beakAt(v); fx(p.x - facing(v) * 6, p.y - 13, "✦", "fx-spark", 900); }
    // two blades of grass hanging from the beaks, then tied in a knot (fx-grass animates it)
    var GRASS = '<svg viewBox="0 0 28 40"><g class="gr-apart"><path d="M12 2C11 10 7.5 20 5 37"/><path d="M16 2C17 10 20.5 20 23 37"/></g>' +
      '<g class="gr-tied"><path d="M12 2C11.5 8 17.5 11 16 15.5C14.3 20 9.8 17 12.6 13.8C15 11.2 16.6 21 7 37"/><path d="M16 2C16.5 8 10.5 11 12 15.5C13.7 20 18.2 17 15.4 13.8C13 11.2 11.4 21 21 37"/></g></svg>';
    var HEART = '<svg viewBox="0 0 24 22"><path d="M12 20.5C5.5 15.6 2 12 2 7.6 2 4.4 4.5 2 7.4 2c1.9 0 3.6 1 4.6 2.6C13 3 14.7 2 16.6 2 19.5 2 22 4.4 22 7.6c0 4.4-3.5 8-10 12.9Z"/></svg>';

    // 4. on the display: a little flamingo walks in from the edge of the radio's screen, as if
    //    it were shown on it (drawn in the screen's ink), stops for a look round, maybe a word,
    //    and walks off the other side
    var SCREEN_S = 0.52;          // every flamingo on the radio's screen, walking or playing, is this size
    // a bird on the radio's screen: only the part inside the screen shows
    function onScreen(v, p, flip, S) {
      place(v, p.x, p.y, flip, 0, S);
      var L = p.x - BOX / 2, T = p.y - BOX, R = L + BOX, B = p.y, r = p.r;
      var cl = Math.max(0, r.left + 6 - L), cr = Math.max(0, R - (r.right - 6)), ct = Math.max(0, r.top - T), cb = Math.max(0, B - r.bottom);
      if (flip) { var t = cl; cl = cr; cr = t; }            // (the bird is mirrored)
      v.el.style.clipPath = "inset(" + ct.toFixed(1) + "px " + cr.toFixed(1) + "px " + cb.toFixed(1) + "px " + cl.toFixed(1) + "px)";
    }
    function displayVisit(v) {
      var plate = document.querySelector(".face--front .plate"), r0 = rectOf(plate);
      var floorEl = plate && plate.querySelector(".plate-news");       // it walks along the line above "Coming up"
      function floor(r) { var f = rectOf(floorEl); return f ? f.top + 1 : r.bottom - 8; }
      if (!r0 || r0.width < 200) return false;
      var S = SCREEN_S, half = 30 * S, dir = Math.random() < 0.5 ? 1 : -1;
      var stopAt = 0.3 + Math.random() * 0.4;
      function spotAt(k) {
        var r = rectOf(plate) || r0;
        var x0 = dir > 0 ? r.left - half * 1.2 : r.right + half * 1.2;
        var x1 = r.left + r.width * stopAt;
        return { x: x0 + (x1 - x0) * k, y: floor(r), r: r };
      }
      function exitAt(k) {
        var r = rectOf(plate) || r0;
        var x1 = r.left + r.width * stopAt, x2 = dir > 0 ? r.right + half * 1.2 : r.left - half * 1.2;
        return { x: x1 + (x2 - x1) * k, y: floor(r), r: r };
      }
      function show(p) { onScreen(v, p, dir < 0, S); }
      side(v, true); pose(v, "standing", "is-on-display is-walking");
      var talk = Math.random() < 0.6;
      run(v, [
        [3400, function (k) { show(spotAt(easeOut(Math.min(1, k * 1.05)))); if (k >= 1) pose(v, "standing", "is-on-display"); }],
        [4200 + LINGER, function (k) {
          show(spotAt(1));
          if (talk && k > 0.12 && !v.bubble) say(v, message(), 3600 + LINGER * 0.8);
        }],
        [3400, function (k) { pose(v, "standing", "is-on-display is-walking"); show(exitAt(easeIn(k) * 0.4 + k * 0.6)); }]
      ]);
      return true;
    }

    // 7. a duet on the radio's screen: two little flamingos walk in from both edges and meet
    //    in the middle. "heart": they face each other and bend their necks over until their
    //    heads meet, a heart shape, and a heart floats up. "volley": they play volleyball,
    //    heading a ball back and forth over the screen, until one sends it flying off.
    function duoVisit(kind) {
      var plate = document.querySelector(".face--front .plate"), r0 = rectOf(plate);
      var floorEl = plate && plate.querySelector(".plate-news");
      if (!r0 || r0.width < 220) return false;
      function scr() {
        var r = rectOf(plate) || r0, f = rectOf(floorEl);
        return { r: r, y: f ? f.top + 1 : r.bottom - 8, mid: r.left + r.width / 2 };
      }
      var S = SCREEN_S, unit = 0.857 * S;
      // how far apart their feet are: for the heart, so their beaks just meet in the middle
      var close = kind === "heart" || kind === "knot";      // (beaks meeting in the middle)
      var tip = flamingoArt.tipFor(kind === "heart" ? "heart" : close ? "kiss" : "up");
      // (heart: the arched necks are its lobes, the chests its point, and the bowed heads touch
      // in its dip: spaced by the front of the head, just past the beak. Knot: beak to beak.)
      var reach = kind === "heart" ? flamingoArt.frontFor("heart") : tip[0];
      var half = close ? Math.max(22.2, reach - 35 - 0.3) * unit : Math.min(r0.width * 0.3, 92);
      var a = Visitor(), b = Visitor();
      out.push(a, b); a.kind = b.kind = "duo";
      function at(i, k, outward) {          // i: 0 the left one, 1 the right one; k: 0 (off screen) .. 1 (in place)
        var s = scr(), edge = i === 0 ? s.r.left - 40 : s.r.right + 40, spot = s.mid + (i === 0 ? -half : half);
        return { x: edge + (spot - edge) * k, y: s.y, r: s.r };
      }
      var ball = null, passes = 0, plan = kind === "volley" ? 6 + Math.floor(Math.random() * 3) : 0;   // (passes before the last shot)
      [a, b].forEach(function (v, i) {
        var inward = i === 1;               // the right one faces left (mirrored)
        side(v, true); pose(v, "standing", "is-on-display is-walking");
        run(v, [
          [3000, function (k) { onScreen(v, at(i, easeOut(Math.min(1, k * 1.05))), inward, S); if (k >= 1) pose(v, "standing", "is-on-display " + (kind === "heart" ? "is-heart" : close ? "is-kiss" : "is-volley")); }],
          [close ? 6600 + LINGER : 500 + (plan + 1) * 900 + 2600, function (k) {
            onScreen(v, at(i, 1), inward, S);
            if (kind === "heart" && i === 0 && !v.hearted && k > 0.3) {
              v.hearted = true;
              var s = scr(), h = fx(s.mid - 9, s.y - 96 * S - 24, HEART, "fx-heart", 3600);
              h.style.setProperty("--s", "1");
            }
            if (kind === "volley" && i === 0) volley(k);
            if (kind === "knot" && i === 0 && !v.tied && k > 0.15) {         // a blade of grass in each beak, tied together
              v.tied = true;
              var pa = beakAt(a), pb = beakAt(b), gx = (pa.x + pb.x) / 2, gy = Math.min(pa.y, pb.y);
              fx(gx - 8, gy - 1, GRASS, "fx-grass", 6200 + LINGER);
            }
          }],
          [3000, function (k) {               // and off they go, each back the way it came
            pose(v, "standing", "is-on-display is-walking");
            onScreen(v, at(i, 1 - easeIn(k)), !inward, S);
          }]
        ]);
      });
      // the ball: from one head to the other in an arc that stays inside the screen, its shadow
      // on the floor below it; each one crouches under it and heads it back (the ball
      // squashing on the header); the last header sends it off out of the screen, and they cheer
      var hitAt = 0, from = 0, flight = 900, shadow = null, cheered = false;
      function head(v) { var p = beakAt(v), bb = body(v); return { x: p.x - facing(v) * 6, y: bb.top + bb.height * 0.06 }; }
      function volley() {
        var now = performance.now(), s = scr();
        if (passes < 0) return;                     // (the rally's over)
        if (!ball) {
          ball = fx(0, 0, '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6"/><path d="M3 7.5C8 9 12 9 17.4 6.6M2.6 12.6C8 11.5 12.6 12.4 17 14.6M9.4 1.6C7 6 7 13 10 18.4"/></svg>', "fx-ball", 60000);
          shadow = fx(0, 0, "", "fx-shadow", 60000);
          hitAt = now + 500; from = 0;
          a.cleanup = function () { if (ball) ball.remove(); if (shadow) shadow.remove(); };
        }
        var k = (now - hitAt) / flight, last = passes >= plan;
        var A = head(from === 0 ? a : b), B = last ? { x: A.x + (from === 0 ? 1 : -1) * s.r.width * 0.45, y: s.r.top - 30 } : head(from === 0 ? b : a);
        var top = Math.max(18, Math.min(44, Math.min(A.y, B.y) - s.r.top - 16));      // (the arc's height: inside the screen)
        var e = Math.max(0, Math.min(1, k)), x = A.x + (B.x - A.x) * e;
        var y = A.y + (B.y - A.y) * e - (last ? 0 : top * Math.sin(Math.PI * e)) - 9;
        if (k < 0) { x = A.x; y = A.y - 16; }
        ball.style.left = (x - 7).toFixed(0) + "px"; ball.style.top = (y - 7).toFixed(0) + "px";
        var spin = ((now / 2.6) % 360) * (from === 0 ? 1 : -1), squash = Math.max(0, 1 - Math.abs(k) / 0.07);   // (flattened for a moment, just as it's hit)
        ball.style.transform = "rotate(" + spin.toFixed(0) + "deg) scale(" + (1 + 0.28 * squash).toFixed(2) + "," + (1 - 0.24 * squash).toFixed(2) + ")";
        ball.style.opacity = last ? Math.max(0, Math.min(1, (y - s.r.top) / 24)).toFixed(2) : "1";
        // its shadow on the floor line: smaller and fainter the higher the ball
        var hgt = Math.max(0, s.y - y), sw = Math.max(5, 16 - hgt * 0.12);
        shadow.style.left = (x - sw / 2).toFixed(0) + "px"; shadow.style.top = (s.y - 2).toFixed(0) + "px";
        shadow.style.width = sw.toFixed(0) + "px"; shadow.style.opacity = last ? "0" : Math.max(0.15, 0.55 - hgt * 0.006).toFixed(2);
        if (!last && k > 0.69 && !ball.headed) {           // the other one crouches under it and heads it
          ball.headed = true;
          flamingoArt.act((from === 0 ? b : a).el.querySelector(".fl-pose--stand .fl"), "bump");
        }
        if (k >= 1) {
          if (last) {
            ball.remove(); shadow.remove(); ball = shadow = null; passes = -1;
            if (!cheered) { cheered = true; [a, b].forEach(function (v) { flamingoArt.act(v.el.querySelector(".fl-pose--stand .fl"), "cheer"); }); }
            return;
          }
          passes++; from = 1 - from; hitAt = now; ball.headed = false;
        }
      }
      return true;
    }

    // 5. two flamingos, flying in from both sides, don't look where they're going: they
    //    crash into each other with a puff and a few loose feathers, tumble back and drop,
    //    hover there dazed with stars going round their heads, shake it off and fly back
    //    the way they came
    function crashVisit() {
      var c = card();
      if (!c) return false;
      var vw = window.innerWidth, vh = window.innerHeight;
      var mx = c.left + c.width / 2;
      var my = c.top > 90 ? c.top - 18 : c.top + c.height * 0.3;   // in the sky above the radio, or over its screen
      [Visitor(), Visitor()].forEach(function (v, i) {
        out.push(v); v.kind = "crash";
        var dir = i === 0 ? 1 : -1;                   // 0 comes from the left, 1 from the right
        var sx = dir > 0 ? -FW : vw + FW, sy = my - vh * 0.06 + (i ? 6 : -6);
        var hit = { x: mx - dir * FW * 0.36, y: my };
        var back = null, stars = null, spin = 0;
        side(v, true); pose(v, "flying");
        run(v, [
          [2300, function (k) {                       // speeding in, straight at each other
            var e = k * k * (1.6 - 0.6 * k);
            place(v, sx + (hit.x - sx) * e, sy + (hit.y - sy) * e + Math.sin(k * 9) * 3, dir < 0, 0);
            if (k >= 1 && i === 0) puff(mx, my - FH * 0.5);
          }],
          [160, function () { place(v, hit.x - dir * 3, hit.y, dir < 0, 0); }],   // contact: squashed together
          [1000, function (k) {                       // bump: knocked back, spinning, dropping
            pose(v, "flying", "is-tumbling");
            var x = hit.x - dir * 70 * Math.sin(k * Math.PI / 2);
            var y = hit.y - 30 * Math.sin(Math.min(1, k * 2) * Math.PI) + 95 * k * k;
            spin = -dir * 340 * (1 - Math.pow(1 - k, 2));
            v.rot = spin;                             // (a spin is set outright, not smoothed)
            place(v, x, y, dir < 0, spin);
            if (k >= 1) back = { x: x, y: y };
          }],
          [1500 + LINGER, function (k) {              // dazed, wobbling, stars round its head
            if (!stars) { stars = dazed(); pose(v, "flying", "is-dazed"); v.rot = spin % 360; }
            var x = back.x + Math.sin(k * 14) * 3, y = back.y + Math.sin(k * 9) * 4;
            place(v, x, y, dir < 0, Math.sin(k * 11) * 12);
            var r = body(v);
            stars.style.transform = "translate(" + (r.left + r.width * (dir < 0 ? 0.2 : 0.8) - 22).toFixed(0) + "px," + (r.top - 6).toFixed(0) + "px)";
            if (k >= 1) { stars.remove(); stars = null; pose(v, "flying", "is-leaving"); }
          }],
          [2100, function (k) {                       // off home, the way it came, a bit wobbly
            var e = k * k, tx = dir > 0 ? -FW * 1.5 : vw + FW * 1.5;
            place(v, back.x + (tx - back.x) * e, back.y - 120 * Math.sqrt(k) + Math.sin(k * 10) * 4 * (1 - k), dir > 0);
          }]
        ]);
        v.cleanup = function () { if (stars) stars.remove(); };
      });
      return true;
    }
    // 6. a pair: two flamingos fly round the radio together, one just behind the other,
    //    and away
    function pairVisit() {
      if (!card()) return false;
      var a = Visitor(), b = Visitor(), fromLeft = Math.random() < 0.5;
      out.push(a, b); a.kind = b.kind = "pair";
      orbitVisit(a, { fromLeft: fromLeft });
      orbitVisit(b, { fromLeft: fromLeft, lag: 520, dr: 16 });
      return true;
    }
    // the bump: a ring, a burst of short lines and a few feathers that drift down, turning
    var FEATHER = '<svg viewBox="0 0 24 10"><path d="M1 5C6 1 15 0 23 4C15 6 7 8 1 5Z M3 5H22 M8 3.6 6.5 5 M12 2.6 10 5 M16 2.5 14 5 M9 6.6 7 5 M13 6.6 11 5"/></svg>';
    function puff(x, y) {
      var p = document.createElement("div");
      p.className = "fl-puff";
      var html = "<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><b></b>";
      for (var f = 0; f < 4; f++) {
        var dx = (f - 1.5) * 18 + (Math.random() - 0.5) * 10, rot = Math.round(Math.random() * 360);
        html += '<u style="--dx:' + dx.toFixed(0) + 'px;--r:' + rot + 'deg;--d:' + (1.2 + Math.random() * 0.5).toFixed(2) + 's">' + FEATHER + "</u>";
      }
      p.innerHTML = html;
      p.style.transform = "translate(" + x.toFixed(0) + "px," + y.toFixed(0) + "px)";
      layer.appendChild(p);
      setTimeout(function () { p.remove(); }, 1900);
    }
    function dazed() {
      var st = document.createElement("div");
      st.className = "fl-stars";
      st.innerHTML = "<span><i>✦</i><i>✧</i><i>✦</i></span>";
      layer.appendChild(st);
      return st;
    }

    // A visit: one bird, and now and then a second one a few seconds behind it
    function visit(kind) {
      if (typeof kind !== "string") timer = 0;     // (called by the timer)
      if (out.length >= 3) return;
      if (!allowed() || !engine.isOn()) { if (!out.length) schedule(30000); return; }
      var L = loyalty(), roll = Math.random();
      if (kind === "crash" || (typeof kind !== "string" && !out.length && roll < 0.08 + 0.17 * L)) {
        if (crashVisit()) return;
        if (kind === "crash") { schedule(30000); return; }
      }
      if (kind === "pair" || (typeof kind !== "string" && !out.length && roll > 0.9 - 0.08 * L)) {
        if (pairVisit()) return;
        if (kind === "pair") { schedule(30000); return; }
      }
      var r = Math.random(), sea = season();
      if (kind === "heart" || kind === "volley" || kind === "knot" || (typeof kind !== "string" && out.length <= 1 && !out.some(function (o) { return o.kind === "duo" || o.kind === "display"; }) && r < (sea === "nowruz" ? 0.3 : 0.2))) {
        var dk = kind === "heart" || kind === "volley" || kind === "knot" ? kind
               : sea === "nowruz" && Math.random() < 0.5 ? "knot" : (Math.random() < 0.5 ? "heart" : "volley");
        if (duoVisit(dk)) return;
      }
      var v = Visitor();
      out.push(v);
      // Nowruz: now and then the one that comes is a black flamingo, with a greeting;
      // at Christmas, one in its hat to wish everyone a merry Christmas
      if (kind === "nowruz" || (sea === "nowruz" && typeof kind !== "string" && Math.random() < 0.25)) {
        v.greet = "Happy Nowruz!";
        v.el.style.setProperty("--fl-line", "var(--fl-black)");
        v.black = true;
        kind = "perch";
      } else if (kind === "xmas" || (sea === "xmas" && typeof kind !== "string" && Math.random() < 0.25)) {
        v.greet = "Merry Christmas!";
        Array.prototype.forEach.call(v.el.querySelectorAll("svg.fl"), function (sv) { sv.classList.add("has-hat"); });
        kind = "perch";
      }
      r = Math.random();
      kind = typeof kind === "string" ? kind : (r < 0.4 ? "perch" : r < 0.58 ? "orbit" : r < 0.72 ? "peek" : "display");
      if (kind === "display" && out.some(function (o) { return o !== v && (o.kind === "duo" || o.kind === "display"); })) kind = "perch";
      var first = out.length === 1 ? null : out[0];
      // the second bird keeps out of the first one's way
      if (first && first.kind === kind && kind !== "perch") kind = "perch";
      v.kind = kind;
      var ok = kind === "orbit" ? orbitVisit(v) : kind === "peek" ? peekVisit(v) : kind === "display" ? displayVisit(v) :
               perchVisit(v, first && first.fx != null ? first.fx : null);
      if (!ok && !(kind !== "perch" && perchVisit(v))) { leave(v); return; }
      if (out.length === 1 && Math.random() < 0.45 + 0.3 * L) {
        setTimeout(function () { if (out.length === 1) visit(Math.random() < 0.6 ? "perch" : Math.random() < 0.5 ? "orbit" : "display"); }, 2500 + Math.random() * 5000);
      }
    }
    function leave(v) {
      v.done = true;
      if (v.cleanup) v.cleanup();
      if (v.bubble) { v.bubble.remove(); v.bubble = null; }
      cancelAnimationFrame(v.raf); v.raf = 0;
      if (v.el.parentNode) v.el.parentNode.removeChild(v.el);
      out = out.filter(function (o) { return o !== v; });
      if (!out.length) schedule();
    }
    function leaveAll() { out.slice().forEach(leave); }
    // the gap between visits: 14-32 s when you've just tuned in, down to 7-17 s after 40 min
    function schedule(ms) {
      clearTimeout(timer);
      var L = loyalty();
      timer = setTimeout(visit, ms || (14000 - 7000 * L) + Math.random() * (18000 - 8000 * L));
    }
    engine.on("state", function (st) {
      if (st === "live" && !listenSince) listenSince = Date.now();
      if (st === "idle") listenSince = 0;
      if (st === "live" && !out.length) schedule(12000 + Math.random() * 15000);
      if (st === "idle" && out.length) leaveAll();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { if (out.length) leaveAll(); }
      else if (!out.length && engine.isOn()) schedule(2500 + Math.random() * 4500);   // back in the app: one comes by soon
    });
    // a safety net: whatever happens, visits keep coming while you listen
    setInterval(function () {
      out.forEach(function (v) { if (!v.el.isConnected) leave(v); });
      if (!out.length && engine.isOn() && !timer) schedule();
    }, 60000);

    /* ---- the flamingo pool float: now and then one drifts across the waveform window,
       bobbing on the music, and floats out the other side ---- */
    var floatTimer = 0, floatie = null, FLOAT_STEPS = 10;
    function floatLater(ms) { clearTimeout(floatTimer); floatTimer = setTimeout(floatBy, ms || 40000 + Math.random() * 70000); }
    function floatBy() {
      var wave = document.querySelector(".face--front .wave");
      if (!wave || floatie || !engine.isOn() || !allowed()) { floatLater(); return; }
      var el = document.createElement("div");
      el.className = "wave-float";
      el.setAttribute("aria-hidden", "true");
      el.innerHTML = '<img src="icons/flamingo.svg" alt="" draggable="false">';
      wave.appendChild(el);
      floatie = el;
      // mostly right to left, the way the float's flamingo faces
      var t0 = performance.now(), dur = 22000 + Math.random() * 8000, ltr = Math.random() < 0.3;
      function frame(t) {
        if (!el.isConnected) { floatie = null; return; }
        var k = (t - t0) / dur, W = wave.clientWidth, w = el.offsetWidth || 40;
        if (k >= 1 || !engine.isOn() || document.hidden) { el.remove(); floatie = null; floatLater(); return; }
        var x = ltr ? -w + (W + w) * k : W - (W + w) * k;
        // it rides on the bars: where they've gone (before a song starts, after it ends, in
        // its silences, off the window's ends) it goes with them, and comes back with them;
        // not all at once but across it, the same way the lines fade, so as the end of a
        // song scrolls under it, it's wiped away from that side to the other, bar by bar
        var cv = wave.querySelector("canvas");
        if (cv) {
          var cr = cv.getBoundingClientRect(), wr = wave.getBoundingClientRect(), x0 = wr.left + x - cr.left;
          var seen = el._seen || (el._seen = []), stops = [];
          for (var i = 0; i <= FLOAT_STEPS; i++) {
            var u = i / FLOAT_STEPS, a = waveView.seenAt(x0 + w * u);
            seen[i] = seen[i] == null ? a : seen[i] + (a - seen[i]) * 0.25;   // (no flicker on single bars)
          }
          // (flipped when it swims left to right: the mask turns with it)
          for (var j = 0; j <= FLOAT_STEPS; j++) {
            var v = seen[ltr ? FLOAT_STEPS - j : j];
            stops.push("rgba(0,0,0," + v.toFixed(3) + ") " + Math.round(j / FLOAT_STEPS * 100) + "%");
          }
          var mask = "linear-gradient(to right," + stops.join(",") + ")";
          el.style.webkitMaskImage = mask; el.style.maskImage = mask;
        }
        var bob = Math.sin(t / 620) * 2.2 + Math.sin(t / 1370) * 1.3, tilt = Math.sin(t / 900) * 5 + Math.sin(t / 2300) * 2;
        el.style.transform = "translate(" + x.toFixed(1) + "px," + bob.toFixed(1) + "px) rotate(" + tilt.toFixed(1) + "deg)" + (ltr ? " scaleX(-1)" : "");
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }
    engine.on("state", function (st) { if (st === "live" && !floatTimer && !perf.reducedMotion) floatLater(15000 + Math.random() * 25000); });

    /* ---- the catch window: the flamingo looks at you; you type; the note rolls up into
       its beak and it flies off with it ---- */
    var input = $("catch-text"), form = $("catch-form"), msg = $("catch-msg"), front = $("catch-bird"), send = $("catch-send"), flyer = $("catch-flyer");
    front.innerHTML = flamingoArt.svgSide();
    dlg.addEventListener("close", function () { flamingoArt.act(front.querySelector(".fl"), null); });
    flyer.innerHTML = flamingoArt.svgFlying();
    // Tapped: it gets a fright first (jumps, eyes wide, neck shooting up, a "!"), then it's
    // caught and the note window opens
    function caught(v) {
      if (!v || v.done || v.startled) return;
      v.startled = true;
      cancelAnimationFrame(v.raf); v.raf = 0;       // (it stops where it is)
      v.el.classList.add("is-startled");
      if (has(v, "is-flying")) v.el.classList.add("is-flaring");
      else flamingoArt.act(v.el.querySelector(".fl-pose--stand .fl"), "startle");
      var bb = body(v);
      fx(bb.left + bb.width * (facing(v) > 0 ? 0.78 : 0.22) - 5, bb.top - 20, "!", "fx-bang", 900);
      setTimeout(function () { reallyCaught(v); }, perf.reducedMotion ? 0 : 560);
    }
    function reallyCaught(v) {
      if (!v || v.done) return;
      var r = v.el.getBoundingClientRect();
      leaveAll();
      if (!engine.isOn()) return;
      msg.hidden = true;
      input.value = "";
      dlg.classList.remove("is-sent");
      dlg._origin = { getBoundingClientRect: function () { return r; } };
      openDialog(dlg);
      flamingoArt.act(front.querySelector(".fl"), "look");
      setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 380);
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || send.disabled) { input.focus(); return; }
      send.disabled = true;
      msg.hidden = true;
      postJSON(hosts.current() + "/note", 8000, { "Content-Type": "application/json" }, JSON.stringify({ text: text }))
        .then(function (d) {
          if (!d || d.status !== "success") throw new Error((d && d.message) || "The flamingo dropped it. Try again.");
          return flyAway();
        })
        .catch(function (err) {
          setText(msg, err.message || "The flamingo dropped it. Try again.");
          msg.hidden = false;
          if (typeof input.animate === "function") input.animate([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], { duration: 260 });
        })
        .then(function () { send.disabled = false; });
    });
    function flyAway() {
      // it turns to face the note (left), and the note goes into the tip of its beak
      dlg.classList.add("is-taking");
      var side = front.querySelector(".fl");
      flamingoArt.act(side, "take");
      // (where the beak will be once it has turned: the same as now, mirrored past the neck)
      var note = $("catch-note"), b = front.getBoundingClientRect(), nr = note.getBoundingClientRect(), tp = flamingoArt.tipOf(side);
      var dx = b.left + b.width * (Math.min(tp[0], 70 - tp[0] + 8) / 70) - (nr.left + nr.width / 2), dy = b.top + b.height * (tp[1] / 110) - (nr.top + nr.height / 2);
      setStatus("Your note is up in the air");
      if (perf.reducedMotion || typeof note.animate !== "function") { closeDialog(dlg); return Promise.resolve(); }
      dlg.classList.add("is-sent");
      // the note rolls up like a scroll and goes into the beak...
      var roll = note.animate([
        { transform: "none", borderRadius: "14px", opacity: 1 },
        { transform: "translate(" + dx * 0.35 + "px," + dy * 0.35 + "px) scale(0.7, 0.32) rotate(-6deg)", borderRadius: "40px", opacity: 1, offset: 0.45 },
        { transform: "translate(" + dx + "px," + dy + "px) scale(0.1, 0.07) rotate(-24deg)", borderRadius: "40px", opacity: 0.2 }
      ], { duration: 820, easing: "cubic-bezier(0.5, 0, 0.3, 1)", fill: "forwards" });
      return new Promise(function (res) { roll.onfinish = res; roll.oncancel = res; }).then(function () {
        // ...and the flamingo turns and flies off with it
        dlg.classList.add("is-flying");
        var fly = flyer.animate([
          { transform: "translate(0,0) rotate(0)" },
          { transform: "translate(60px,-40px) rotate(-8deg)", offset: 0.35 },
          { transform: "translate(320px,-260px) rotate(-14deg)", opacity: 0 }
        ], { duration: 1300, easing: "cubic-bezier(0.45, 0, 0.6, 1)", fill: "forwards" });
        return new Promise(function (res) { fly.onfinish = res; fly.oncancel = res; });
      }).then(function () {
        closeDialog(dlg);
        setTimeout(function () {
          roll.cancel();
          flyer.getAnimations().forEach(function (a) { a.cancel(); });
          dlg.classList.remove("is-sent", "is-flying", "is-taking");
        }, 400);
      });
    }

    /* ---- skywriting: a flamingo crosses the sky and a listener's note appears in its wake ---- */
    var skyLayer = $("sky-layer"), lastSky = null;
    // each flight has a number; a flight's late timers only act while it's still the latest
    // (a new note arriving just after one finished used to be wiped by the old one's clean-up)
    var flightNo = 0;
    // while the radio glides, redraw the keys so their light changes with it (the glass
    // follows by itself, it's drawn every frame)
    // the radio gliding down (px) or back up (0)
    var glideAnim = null, glideAt = 0;
    function glide(to) {
      var f = $("flip");
      if (!f || typeof f.animate !== "function") return;
      var from = glideAt;
      glideAt = to;
      if (glideAnim) glideAnim.cancel();
      glideAnim = f.animate([{ translate: "0 " + from + "px" }, { translate: "0 " + to + "px" }],
        { duration: 1600, easing: "cubic-bezier(0.45, 0, 0.25, 1)", fill: to ? "forwards" : "none" });
      if (!to) { var a = glideAnim; a.onfinish = function () { if (glideAnim === a) { a.cancel(); glideAnim = null; } }; }
    }
    function followLight() {
      var t0 = performance.now();
      (function step(t) {
        keys3d.redraw();
        if (t - t0 < 1750) requestAnimationFrame(step);
      })(t0);
    }
    function sky(s, serverNow) {
      // one flight = one note at one time: the same note flies again later as a new flight
      // (it used to be recognised by the note alone, so each note only ever flew once here)
      if (!s || !s.text || !skyLayer) return;
      var flight = s.id + "@" + s.at;
      if (flight === lastSky) return;
      var age = (serverNow || Date.now() / 1000) - s.at;
      if (age > 60 || age < -30) { lastSky = flight; return; }
      if (document.hidden || perf.reducedMotion) return;
      lastSky = flight;
      var my = ++flightNo;
      function live() { return my === flightNo; }
      var vw = window.innerWidth, ltr = !/[؀-ۿ]/.test(s.text);
      skyLayer.innerHTML = "";
      var line = document.createElement("div");
      line.className = "sky-text";
      line.dir = ltr ? "ltr" : "rtl";
      var inner = document.createElement("span");          // one piece, so Farsi letters stay joined
      inner.textContent = s.text;
      line.appendChild(inner);
      skyLayer.appendChild(line);
      skyLayer.hidden = false;
      // fit the line to the screen
      var size = 30;
      line.style.fontSize = size + "px";
      while (inner.getBoundingClientRect().width > vw * 0.9 && size > 14) { size -= 2; line.style.fontSize = size + "px"; }
      // on a wide screen, written right above the radio (on a phone, at the top: there's no room)
      var card0 = document.querySelector(".face--front"), c0 = card0 && card0.getBoundingClientRect();
      if (vw >= 720 && c0 && c0.width) {
        var lh = line.getBoundingClientRect().height;
        line.style.top = Math.max(8, Math.round(c0.top - lh - 28)) + "px";     // (if it fits, the radio needn't move)
      }
      var b = document.createElement("div");
      b.className = "sky-bird";
      b.innerHTML = flamingoArt.svgFlying();
      skyLayer.appendChild(b);
      var ir = inner.getBoundingClientRect();
      // make room: the radio floats down until the writing is clear of it, then comes back
      var card = document.querySelector(".face--front"), cr = card && card.getBoundingClientRect();
      // (on a phone it always dips a little, so you notice the sky; elsewhere only if needed)
      var drop = cr && cr.width ? Math.max(vw < 720 ? 44 : 0, Math.round(ir.bottom + 26 - cr.top)) : 0;
      if (drop && !flipped) {
        glide(Math.min(drop, 140));
        document.body.classList.add("is-skywriting");
        followLight();
      } else if (document.body.classList.contains("is-skywriting")) {
        settle();                                        // (left down by the flight before)
      }
      var y = ir.top + ir.height / 2, from = ltr ? -90 : vw + 90, to = ltr ? vw + 90 : -90, D = 9000, t0 = performance.now();
      (function step(t) {
        if (!live()) return;                            // a newer flight took over
        var k = Math.min(1, (t - t0) / D), x = from + (to - from) * k;
        b.style.transform = "translate(" + (x - 40).toFixed(1) + "px," + (y - 30 + Math.sin(k * 12) * 4).toFixed(1) + "px)" + (ltr ? "" : " scaleX(-1)");
        // the writing appears in the bird's wake, with a soft smoky edge
        var edge = ltr ? x - 24 - ir.left : ir.right - (x + 24);
        inner.style.setProperty("--p", Math.max(0, edge).toFixed(1) + "px");
        if (k < 1) requestAnimationFrame(step);
        else setTimeout(function () {
          if (!live()) return;
          line.classList.add("is-gone");
          settle();
          setTimeout(function () { if (live()) { skyLayer.hidden = true; skyLayer.innerHTML = ""; } }, 4200);
        }, 3500);
      })(t0);
    }
    // the radio floats back up into place
    function settle() {
      if (!document.body.classList.contains("is-skywriting")) return;
      var fe = $("flip");
      if (fe) { fe._gliding = true; setTimeout(function () { fe._gliding = false; keys3d.redraw(); }, 1800); }
      document.body.classList.remove("is-skywriting");
      glide(0);
      followLight();
    }

    // the server says whether the sky has room for another note (seven waiting at most):
    // while it's full, no flamingos come round to be caught
    function setOpen(on) { skyOpen = on !== false; if (!skyOpen) leaveAll(); }
    return { sky: sky, visit: visit, setOpen: setOpen, art: flamingoArt, floatBy: floatBy, away: leaveAll };
  })();
  window.raadioFlamingos = flamingos;      // (lets the page tests call a visit right away)
  window.raadioSfx = sfx;                  // (and play the sound effects on their own)

  /* ---------------- Studio: the three tabs ----------------
     Home (status, notes, numbers), Schedule (record, upload, the list) and Live. One tab
     shows at a time; the last one used is remembered on this device. Arrow keys move
     between the tabs. Starting a stream (or finding yours still on) brings Live forward. */
  (function studioTabs() {
    var root = $("studio"), tabs = Array.prototype.slice.call(root.querySelectorAll(".studio-tab"));
    function select(name, focus) {
      tabs.forEach(function (t) {
        var on = t.dataset.tab === name;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        $(t.getAttribute("aria-controls")).hidden = !on;
        if (on && focus) t.focus();
      });
      root.dataset.tab = name;
      store.set("raadio.studioTab", name);
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () {
        if (t.getAttribute("aria-selected") !== "true") { select(t.dataset.tab); root.scrollTop = 0; }
      });
      t.addEventListener("keydown", function (e) {
        var step = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
        if (step == null) return;
        if (document.dir === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) step = -step;
        e.preventDefault();
        select(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true);
      });
    });
    var panel = $("live-panel");
    new MutationObserver(function () {
      var s = panel.dataset.state;
      if ((s === "live" || s === "ready") && root.dataset.tab !== "live") select("live");
    }).observe(panel, { attributes: true, attributeFilter: ["data-state"] });
    var saved = store.get("raadio.studioTab", "home");
    select(tabs.some(function (t) { return t.dataset.tab === saved; }) ? saved : "home");
  })();

  /* ---------------- Studio: the bar and the on-air card ----------------
     Copies what the radio side already knows into the studio: the song on air (the
     "Now playing" card and the small bar above the tabs on a phone), whether it plays
     (their buttons press the radio's own play key), the listener count from the numbers,
     and the "on air" marks while a stream is on. Nothing here asks the server. */
  var studioChrome = (function () {
    var root = $("studio"), panel = $("live-panel");
    function song() {
      var name = $("song-name").textContent.trim(), artist = $("artist-name").textContent.trim();
      var air = $("onair").textContent.trim();
      setText($("st-now-song"), name); setText($("st-now-artist"), artist);
      setText($("st-mini-song"), artist && artist !== name ? name + " — " + artist : name);
      setText($("st-now-state"), air); setText($("st-mini-state"), air);
      var playing = ($("play-icon").getAttribute("href") || "") === "#i-pause";
      ["st-now-icon", "st-mini-icon"].forEach(function (id) { $(id).setAttribute("href", playing ? "#i-pause" : "#i-play"); });
      ["st-now-play", "st-mini-play"].forEach(function (id) { $(id).setAttribute("aria-label", playing ? "Pause" : "Play"); });
    }
    function tuning() {
      var n = $("an-now").textContent.trim();
      $("st-tuning").hidden = !/^\d/.test(n);
      setText($("st-tuning-n"), n);
    }
    function onAir() {
      var s = panel.dataset.state;
      root.classList.toggle("is-on-air", s === "live" || s === "watch");
      $("st-rec").hidden = s !== "live";
    }
    ["st-now-play", "st-mini-play"].forEach(function (id) {
      $(id).addEventListener("click", function () { $("play-btn").click(); });
    });
    var watch = { childList: true, characterData: true, subtree: true, attributes: true };
    ["song-name", "artist-name", "onair", "play-icon"].forEach(function (id) { new MutationObserver(song).observe($(id), watch); });
    new MutationObserver(tuning).observe($("an-now"), watch);
    new MutationObserver(onAir).observe(panel, { attributes: true, attributeFilter: ["data-state"] });
    song(); tuning(); onAir();
    return { refresh: function () {} };   // (nothing in the bar depends on who is signed in)
  })();

  /* ---------------- Studio: going live ----------------
     "Go live" asks for a name, then the browser records the microphone and sends it to the
     radio every half second; the radio fades the music out and plays the host instead.
     The panel shows the time on air, the mic level and the chat (which the host answers
     from here). The radio on this device is paused meanwhile, so the mic doesn't pick it
     up. Another host who's live: their chat shows here too (a curator can end it). */
  /* Each host's high-quality recording: made on this device while the show's on (nothing of it
     crosses a bad line during the show), kept in IndexedDB, and uploaded afterwards in small
     numbered pieces. A dropped line, a closed tab, a phone that dies: it goes on from where it
     was the next time the studio opens. */
  var liveTakes = (function () {
    var dbp = null, listeners = [], paused = false, running = false;
    var mem = { takes: {}, pieces: {} };                 // (private browsing: no database, this page's memory)
    function db() {
      if (dbp) return dbp;
      dbp = new Promise(function (ok) {
        try {
          var q = indexedDB.open("raadio-live", 1);
          q.onupgradeneeded = function () {
            q.result.createObjectStore("takes", { keyPath: "id" });
            q.result.createObjectStore("pieces", { keyPath: ["take", "n"] });
          };
          q.onsuccess = function () { ok(q.result); };
          q.onerror = function () { ok(null); };
        } catch (e) { ok(null); }
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return db().then(function (d) {
        if (!d) return null;
        return new Promise(function (ok, bad) {
          var t = d.transaction(store, mode), r = fn(t.objectStore(store));
          t.oncomplete = function () { ok(r && r.result); };
          t.onerror = t.onabort = function () { bad(t.error); };
        });
      });
    }
    function putTake(m) { mem.takes[m.id] = m; return tx("takes", "readwrite", function (s) { return s.put(m); }).catch(function () {}); }
    function allTakes() {
      return tx("takes", "readonly", function (s) { return s.getAll(); }).catch(function () { return null; }).then(function (l) {
        var by = {};
        (l || []).forEach(function (m) { by[m.id] = m; });
        Object.keys(mem.takes).forEach(function (k) { by[k] = mem.takes[k]; });
        return Object.keys(by).map(function (k) { return by[k]; });
      });
    }
    function putPiece(take, n, blob) {
      (mem.pieces[take] = mem.pieces[take] || {})[n] = blob;
      return tx("pieces", "readwrite", function (s) { return s.put({ take: take, n: n, blob: blob }); })
        .then(function (r) { if (r !== null && r !== undefined) delete mem.pieces[take][n]; }).catch(function () {});
    }
    function pieceKeys(take) {
      return tx("pieces", "readonly", function (s) { return s.getAllKeys(IDBKeyRange.bound([take, 0], [take, 1e9])); }).catch(function () { return null; }).then(function (k) {
        var ns = (k || []).map(function (x) { return x[1]; }).concat(Object.keys(mem.pieces[take] || {}).map(Number));
        return ns.filter(function (n, i) { return ns.indexOf(n) === i; }).sort(function (a, b) { return a - b; });
      });
    }
    function getPiece(take, n) {
      if (mem.pieces[take] && mem.pieces[take][n]) return Promise.resolve(mem.pieces[take][n]);
      return tx("pieces", "readonly", function (s) { return s.get([take, n]); }).then(function (r) { return r && r.blob; });
    }
    function forget(take) {
      delete mem.takes[take]; delete mem.pieces[take];
      return Promise.all([
        tx("takes", "readwrite", function (s) { return s.delete(take); }),
        tx("pieces", "readwrite", function (s) { return s.delete(IDBKeyRange.bound([take, 0], [take, 1e9])); })
      ]).catch(function () {});
    }
    function emit(p) { listeners.forEach(function (fn) { fn(p); }); }
    function pickMime() {
      var types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
      for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
      return "";
    }
    function begin(sid, p, stream, now) {
      var mime = pickMime();
      if (!mime) return null;
      // (96 kbit/s of Opus is transparent for a voice, ~43 MB an hour; AAC needs a little more)
      var rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: /mp4/.test(mime) ? 128000 : 96000 });
      var t = { rec: rec, id: null, n: 0, waiting: [], stopped: false, lost: false };
      function keep(blob) {
        if (t.id) {
          putPiece(t.id, t.n++, blob);
          putTake({ id: t.id, ended: false, at: Date.now() });   // (still being recorded: see resume)
        } else t.waiting.push(blob);
      }
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) keep(ev.data); };
      rec.onstop = function () {
        t.stopped = true;
        if (t.id) markEnded(t);
      };
      var t0 = now();
      rec.start(5000);
      (function declare(tries) {
        api.post("/api/live/" + encodeURIComponent(sid) + "/takes", { p: p, mime: mime, t0: t0 }).then(function (r) {
          t.id = r.take;
          return putTake({ id: t.id, ended: false, at: Date.now() });
        }).then(function () {
          t.waiting.forEach(keep);
          t.waiting = [];
          if (t.stopped) markEnded(t);
        }).catch(function () {
          if (tries < 20 && !t.stopped) setTimeout(function () { declare(tries + 1); }, 3000);
          else t.lost = true;                            // (the on-air version is still there)
        });
      })(0);
      return t;
    }
    function markEnded(t) {
      putTake({ id: t.id, ended: true, at: Date.now() }).then(upload);
    }
    function finish(t) {
      try { if (t.rec.state !== "inactive") t.rec.stop(); } catch (e) { /* ignore */ }
    }
    function send(take, n, blob, last) {
      return fetch(hosts.current() + "/api/live/takes/" + take + "/" + n + "?last=" + (last ? 1 : 0), {
        method: "PUT", headers: { Authorization: "Bearer " + (session && session.token), "Content-Type": "application/octet-stream" }, body: blob, cache: "no-store"
      }).then(function (r) {
        if (r.status === 404 || r.status === 403 || r.status === 400 || r.status === 413) throw Object.assign(new Error("gone"), { gone: true });
        if (!r.ok) throw new Error("HTTP " + r.status);
      });
    }
    function upload() {
      if (running || paused || !session) return;
      running = true;
      var wait = 3000;
      function step() {
        if (paused || !session) { running = false; emit(null); return; }
        allTakes().then(function (list) {
          var todo = list.filter(function (m) { return m.ended; })[0];
          if (!todo) { running = false; emit(null); return; }
          return api.get("/api/live/takes/" + todo.id).then(function (st) {
            if (st.done) return forget(todo.id);
            return pieceKeys(todo.id).then(function (ns) {
              if (!ns.length) return forget(todo.id);
              var have = {}, last = ns[ns.length - 1], i = 0;
              st.have.forEach(function (n) { have[n] = 1; });
              var left = ns.filter(function (n) { return !have[n]; });
              var total = last + 1;
              return (function next() {
                if (i >= left.length) return left.length ? forget(todo.id) : send(todo.id, last, null, true).catch(function () {}).then(function () { return forget(todo.id); });
                if (paused) return null;
                emit(Math.round((total - left.length + i) / total * 100));
                return getPiece(todo.id, left[i]).then(function (blob) {
                  return send(todo.id, left[i], blob, left[i] === last);
                }).then(function () { i++; wait = 3000; return next(); });
              })();
            });
          });
        }).then(function () { if (running) step(); }).catch(function (e) {
          if (e && (e.gone || e.status === 404 || e.status === 403)) {   // past its week, or not this login's: nothing more to do
            allTakes().then(function (l) { var m = l.filter(function (x) { return x.ended; })[0]; return m && forget(m.id); }).then(step);
            return;
          }
          wait = Math.min(30000, wait * 1.5);            // a bad line: keep trying, gently
          setTimeout(step, wait);
        });
      }
      step();
    }
    return {
      begin: begin,
      finish: finish,
      pause: function (on) { paused = on; if (!on) upload(); },   // (nothing else on the line while a show's on air)
      onProgress: function (fn) { listeners.push(fn); },
      // left from before (a closed tab, a phone that died): whatever it had goes up now
      resume: function () {
        if (paused) return;
        allTakes().then(function (list) {
          var old = list.filter(function (m) { return !m.ended && Date.now() - m.at > 60000; });   // (not one another tab's still recording)
          return Promise.all(old.map(function (m) { return putTake({ id: m.id, ended: true, at: m.at }); }));
        }).then(upload).catch(function () {});
      }
    };
  })();

  var liveStudio = (function () {
    var panel = $("live-panel"), btn = $("live-btn"), sub = $("live-sub");
    var SLICE = 400;               // ms of audio in a piece: shorter is sooner, but more requests on a bad line
    var RATES = [32000, 20000, 12000];   // on air: speech stays clear at all of these
    var me = null;                 // this device on air: {id, p, name, author, room, title, started, gen, level, rec, queue, hq, ...}
    var joining = false;           // the form is for joining a show, not starting one
    var mic = null;                // {ac, src, gain, dest, an, stream, id}: the microphone, through Web Audio so it can be swapped mid-show
    var other = null;              // someone else's (from the server)
    var clockTimer = 0, meterRaf = 0, wake = null;
    var canLive = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    function base() { return hosts.current(); }
    function authH() { return session && session.token ? "Bearer " + session.token : ""; }
    function pad2(n) { return String(n).padStart(2, "0"); }
    function state(name) {
      panel.dataset.state = name;
      panel.hidden = name === "off";
      $("live-end").hidden = name === "watch" ? !(other && other.canEnd) : false;
      setText($("live-end"), me && !me.author ? "Leave" : "End the stream");
      $("live-join").hidden = !(name === "watch" && other && !other.full && canLive);
      $("live-desk").hidden = name !== "live";
      $("live-music").hidden = !(name === "live" && me && me.author);
      btn.hidden = name !== "off";
      var h = name === "ready" ? (joining ? "Join the broadcast" : "Go live") : name === "live" ? "You're live" : name === "watch" && other ? other.host + " is live" : "Live";
      setText($("h-live"), h);
      if (name === "live" || name === "watch") liveChat.poll();
      renderChat();
    }
    function renderChat() {
      if (panel.dataset.state === "live" || panel.dataset.state === "watch") liveChat.renderList($("live-chat-list"));
      var l = liveChat.state();
      setText($("live-room"), l ? "Chat: " + l.room + " · everyone listening can join" : "Starting…");
    }
    liveChat.onChange(function (l) {
      renderChat();
      // the server says nobody is live: my stream ended there (e.g. the connection dropped)
      if (!l && me && me.confirmed) { finish("The stream ended on the radio's side"); }
      if (l && (!me || me.room !== l.room)) {
        var was = other || {};
        other = Object.assign({}, l, { id: was.id, headphones: was.headphones, full: was.full, canEnd: was.canEnd });
        if (panel.dataset.state === "off" || panel.dataset.state === "watch") { if (flipped) state("watch"); }
        offerJoin();
        if (!was.id && session && flipped) liveStudioOpened();
      }
      if (!l && !me) {
        other = null; joining = false; btn.disabled = !canLive; setText(sub, canLive ? "Talk to everyone listening, right now, and chat with them" : "Not supported in this browser");
        if (panel.dataset.state === "watch") state("off");
        loadRecordings();
      }
      if (l && me && me.room === l.room) me.confirmed = true;
    });
    if (!canLive) { btn.disabled = true; setText(sub, "Not supported in this browser"); }

    function offerJoin() {
      if (!other) return;
      btn.disabled = !canLive;
      setText(sub, other.host + " is live: join them");
    }
    function liveStudioOpened() { api.get("/api/live").then(function (r) {
      if (me || !r.live || !other) return;
      Object.assign(other, { id: r.id, headphones: r.headphones, full: r.full, canEnd: r.can_end });
      if (panel.dataset.state === "watch") state("watch");
    }).catch(function () { /* ignore */ }); }

    // ---- the microphone: through Web Audio, so it can be swapped or muted without stopping
    // the recorders (a MediaRecorder can't change its track)
    function looksLikeHeadphones(label) { return /head(phone|set)|ear(phone|bud|pod)|airpods|buds|bluetooth|هدفون|هندزفری/i.test(label || ""); }
    function micConstraints(id) {
      // (on headphones there's no echo to cancel, and cancelling it costs quality)
      var c = { echoCancellation: !$("live-phones").checked, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
      if (id) c.deviceId = { exact: id };
      return { audio: c };
    }
    function fillMics() {
      return navigator.mediaDevices.enumerateDevices().then(function (list) {
        var inputs = list.filter(function (d) { return d.kind === "audioinput"; });
        var phones = list.filter(function (d) { return looksLikeHeadphones(d.label) && (d.kind === "audioinput" || d.kind === "audiooutput"); });
        if (phones.length && !mic.phonesSeen) { mic.phonesSeen = true; $("live-phones").checked = true; updateReady(); }
        ["live-mic", "live-mic-on"].forEach(function (id) {
          var sel = $(id);
          while (sel.firstChild) sel.removeChild(sel.firstChild);
          inputs.forEach(function (d, i) {
            var o = document.createElement("option");
            o.value = d.deviceId; o.textContent = d.label || "Microphone " + (i + 1);
            sel.appendChild(o);
          });
          if (mic && mic.id) sel.value = mic.id;
          if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
        });
      }).catch(function () { /* the default one, then */ });
    }
    function openMic(id) {
      return navigator.mediaDevices.getUserMedia(micConstraints(id)).then(function (stream) {
        if (!mic) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        if (mic.src) { try { mic.src.disconnect(); } catch (e) { /* ignore */ } }
        if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); });
        var track = stream.getAudioTracks()[0], set = track && track.getSettings ? track.getSettings() : {};
        mic.stream = stream;
        mic.id = set.deviceId || id || "";
        mic.src = mic.ac.createMediaStreamSource(stream);
        mic.src.connect(mic.gain);
        return fillMics();
      });
    }
    function prepareMic(early) {
      if (mic) return Promise.resolve();
      var AC = window.AudioContext || window.webkitAudioContext;
      var ac = early || new AC();                        // (made on the tap: phones allow sound then)
      if (ac.state === "suspended" && ac.resume) ac.resume().catch(function () {});
      mic = { ac: ac, src: null, gain: ac.createGain(), dest: ac.createMediaStreamDestination(), an: ac.createAnalyser(), stream: null, id: "" };
      mic.dest.channelCount = 1;
      mic.an.fftSize = 512;
      mic.gain.connect(mic.dest);
      mic.gain.connect(mic.an);
      meter();
      return openMic("");
    }
    function closeMic() {
      if (!mic) return;
      cancelAnimationFrame(meterRaf);
      if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); });
      try { mic.ac.close(); } catch (e) { /* ignore */ }
      mic = null;
    }
    function meter() {
      var buf = new Uint8Array(mic.an.fftSize), bars = [$("live-level"), $("live-level-form")], m = mic;
      (function tick() {
        if (mic !== m) return;
        m.an.getByteTimeDomainData(buf);
        var peak = 0;
        for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        var t = "scaleX(" + Math.min(1, peak / 90).toFixed(3) + ")";
        bars[0].style.transform = t; bars[1].style.transform = t;
        meterRaf = requestAnimationFrame(tick);
      })();
    }
    function changeMic(e) {
      if (!mic) return;
      openMic(e.target.value).catch(function (ex) { log.add("error", ex.message || "Couldn't open that microphone"); fillMics(); });
    }
    $("live-mic").addEventListener("change", changeMic);
    $("live-mic-on").addEventListener("change", changeMic);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", function () { if (mic) fillMics(); });
    }

    // ---- the form ----
    function needPhones() { return joining ? !!(other && other.headphones) : $("live-need-phones").checked; }
    function updateReady() {
      var need = needPhones(), ok = !need || $("live-phones").checked;
      $("live-start").disabled = !ok || !mic;
      setText($("live-mic-hint"), need && !$("live-phones").checked
        ? "This show needs everyone on headphones. Put yours on and tick the box."
        : "Choose the phone or computer's microphone, or the one on your headphones. Bluetooth headphone microphones usually sound thinner; wired ones and the device's are clearer.");
    }
    $("live-need-phones").addEventListener("change", updateReady);
    $("live-phones").addEventListener("change", function () {
      updateReady();
      if (mic && mic.stream) openMic(mic.id).catch(function () { /* keep the one it has */ });   // (echo cancelling on or off)
    });
    function openForm(join, early) {
      joining = join;
      $("live-title").hidden = join;
      $("live-need-row").hidden = join;
      $("live-name").value = store.get("raadio.liveName", "") || (session && session.user) || "";
      setText($("live-start"), join ? "Join" : "Start");
      state("ready");
      updateReady();
      prepareMic(early).then(updateReady).catch(function (ex) {
        closeMic();
        log.add("error", ex && ex.name === "NotAllowedError" ? "Microphone access was blocked" : (ex.message || "Couldn't open the microphone"));
        state(other ? "watch" : "off");
      });
    }
    btn.addEventListener("click", function () {
      // (ask first: on a slow line the chat's news that someone's live may not have come yet)
      var AC = window.AudioContext || window.webkitAudioContext;
      var early = new AC();                              // (made on the tap: the wait below would lose it)
      if (early.state === "suspended" && early.resume) early.resume().catch(function () {});
      api.get("/api/live").then(function (r) {
        other = r.live ? Object.assign({}, r.live, { id: r.id, headphones: r.headphones, full: r.full, canEnd: r.can_end }) : null;
        if (r.live && r.full) { try { early.close(); } catch (e) { /* ignore */ } state("watch"); return; }
        mic = null;
        openForm(!!r.live, early);
      }).catch(function (ex) { try { early.close(); } catch (e) { /* ignore */ } log.add("error", ex.message); });
    });
    $("live-join").addEventListener("click", function () { openForm(true); });
    $("live-cancel").addEventListener("click", function () { closeMic(); joining = false; state(other ? "watch" : "off"); });

    function pickMime() {
      var types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
      for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
      return "";
    }
    // ---- on air: low bitrate pieces, one request at a time. What piles up while one's on its
    // way goes together in the next. If the line really can't keep up: start a new recording at
    // a lower bitrate (a new generation; the server starts a new decoder) and skip what's waiting.
    function startRecorder() {
      var gen = ++me.gen, mime = pickMime(), bits = RATES[me.level];
      var rec = mime ? new MediaRecorder(mic.dest.stream, { mimeType: mime, audioBitsPerSecond: bits }) : new MediaRecorder(mic.dest.stream);
      if (me.rec) { try { if (me.rec.state !== "inactive") me.rec.stop(); } catch (e) { /* ignore */ } }
      me.rec = rec;
      me.queue = [];
      rec.ondataavailable = function (ev) {
        if (me && gen === me.gen && ev.data && ev.data.size) { me.queue.push(ev.data); pump(); }
      };
      rec.start(SLICE);
      showLine();
    }
    function showLine() { setText($("live-line"), me && me.level > 0 ? "Your line is weak, so you're on air at a lower quality. The high-quality recording isn't affected." : "Your line is good."); }
    // (at the lowest bitrate a restart gains nothing: only after a real outage. A slow line then
    // stays on air, late, and the server's own limit keeps it from drifting further.)
    function behind() { return me.queue.length * SLICE > (me.level < RATES.length - 1 ? 4000 : 12000); }
    function pump() {
      if (!me || me.sending || !me.queue.length) return;
      if (behind() && Date.now() - me.changed > 3000) {   // falling behind
        me.changed = Date.now();
        if (me.level < RATES.length - 1) me.level++;
        startRecorder();
        return;
      }
      if (me.level > 0 && me.queue.length <= 2 && Date.now() - me.changed > 120000) {   // steady for a while: try better
        me.changed = Date.now();
        me.level--;
        startRecorder();
        return;
      }
      var blob = new Blob(me.queue), gen = me.gen, sid = me.id, tries = 0;
      me.queue = [];
      me.sending = true;
      (function send() {
        var ctrl = window.AbortController ? new AbortController() : null;
        var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
        return fetch(base() + "/api/live/" + encodeURIComponent(sid) + "/audio?p=" + encodeURIComponent(me.p) + "&g=" + gen, {
          method: "PUT", headers: { Authorization: authH(), "Content-Type": "application/octet-stream" }, body: blob, cache: "no-store",
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) {
          clearTimeout(t);
          if (r.status === 404 || r.status === 403) throw Object.assign(new Error("ended"), { ended: true });
          if (r.status === 409) throw Object.assign(new Error("again"), { again: true });
          if (!r.ok) throw new Error("HTTP " + r.status);
          me.sentOk = Date.now();
        }).catch(function (e) {
          clearTimeout(t);
          if (!me) return;
          if (e.ended) { finish("You're off air"); return; }
          if (e.again) { startRecorder(); return; }
          // (the same piece again, while this recording is still the one: a piece lost mid-recording can't be skipped)
          if (gen === me.gen && !behind()) return new Promise(function (r) { setTimeout(r, 300); }).then(function () { if (me && ++tries < 50) return send(); });
          log.add("warn", "A moment of the stream didn't get through (connection)");
        });
      })().then(function () {
        if (!me) return;
        me.sending = false;
        pump();
      });
    }
    // ---- hearing the others: Opus over one long response, decoded here so it isn't held up
    // by the browser's own buffering for streams. Played a little behind, more if the line's jittery.
    var RET_URL = "vendor/ogg-opus-decoder-1.6.14.min.js";
    function loadDecoder() {
      if (window["ogg-opus-decoder"]) return Promise.resolve();
      return new Promise(function (ok, bad) {
        var el = document.createElement("script");
        el.src = RET_URL; el.onload = ok; el.onerror = function () { bad(new Error("Couldn't load the audio decoder")); };
        document.head.appendChild(el);
      });
    }
    function startReturn() {
      stopReturn();
      if (!me || !mic) return;
      var my = me, run = { on: true, ctrl: new AbortController(), next: 0, jitter: 0.25, kbit: my.retKbit || 24 };
      my.ret = run;
      var out = mic.ac.createGain();
      out.connect(mic.ac.destination);
      run.out = out;
      loadDecoder().then(function () {
        var dec = new window["ogg-opus-decoder"].OggOpusDecoder();
        run.dec = dec;
        return dec.ready;
      }).then(function () {
        if (!run.on) return;
        return fetch(base() + "/api/live/" + encodeURIComponent(my.id) + "/return?p=" + encodeURIComponent(my.p) + "&kbit=" + run.kbit, {
          headers: { Authorization: authH() }, cache: "no-store", signal: run.ctrl.signal
        }).then(function (r) {
          if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
          var reader = r.body.getReader();
          return (function more() {
            return reader.read().then(function (got) {
              if (got.done || !run.on) return;
              return Promise.resolve(run.dec.decode(got.value)).then(function (d) {
                if (run.on && d && d.samplesDecoded) playBack(run, d);
                return more();
              });
            });
          })();
        });
      }).catch(function (e) {
        if (run.on) log.add("warn", "Lost the others' sound for a moment (" + (e.message || "connection") + ")");
      }).then(function () {
        if (run.on && me === my && my.ret === run) setTimeout(function () { if (run.on && me === my) startReturn(); }, 1500);   // the line dropped: again
      });
    }
    function playBack(run, d) {
      var ac = mic && mic.ac;
      if (!ac) return;
      var n = d.samplesDecoded, buf = ac.createBuffer(1, n, d.sampleRate), now = ac.currentTime;
      buf.copyToChannel(d.channelData[0], 0);
      if (run.next < now) {                              // ran dry: hold a little more back from now on
        if (run.next) run.jitter = Math.min(1.2, run.jitter + 0.1);
        run.next = now + run.jitter;
      } else if (run.next - now > 2.5) {                 // too far behind: this line can't carry it. Less, and start over
        if (me && me.ret === run) {
          me.retKbit = run.kbit === 24 ? 16 : 12;
          startReturn();
        }
        return;
      }
      var src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(run.out);
      src.start(run.next);
      run.next += n / d.sampleRate;
    }
    function stopReturn() {
      if (!me || !me.ret) return;
      var run = me.ret;
      me.ret = null;
      run.on = false;
      try { run.ctrl.abort(); } catch (e) { /* ignore */ }
      try { run.out.disconnect(); } catch (e) { /* ignore */ }
      try { if (run.dec && run.dec.free) run.dec.free(); } catch (e) { /* ignore */ }
    }
    function setHear(on) {
      if (!me) return;
      me.hear = on;
      var b = $("live-hear");
      b.setAttribute("aria-pressed", on ? "true" : "false");
      setText(b, on ? "Hearing the others" : "Hear the others");
      if (on) startReturn(); else stopReturn();
    }
    $("live-hear").addEventListener("click", function () {
      if (!me) return;
      if (!me.hear && !$("live-phones").checked) { log.add("warn", "Put on headphones to hear the others: on a speaker their voices would get back into your microphone."); $("live-phones").checked = true; }
      setHear(!me.hear);
    });
    $("live-mute").addEventListener("click", function () {
      if (!mic) return;
      var off = mic.gain.gain.value > 0;
      mic.gain.gain.value = off ? 0 : 1;
      var b = $("live-mute");
      b.setAttribute("aria-pressed", off ? "true" : "false");
      setText(b, off ? "Muted" : "Mute");
    });
    function renderHosts(list) {
      var ul = $("live-hosts"), frag = document.createDocumentFragment();
      (list || []).forEach(function (h) {
        var li = document.createElement("li"), dot = document.createElement("i"), nm = document.createElement("span");
        dot.className = "live-host-dot" + (h.ok ? " is-ok" : "");
        nm.textContent = h.name; nm.dir = "auto"; nm.className = "live-host-name";
        li.appendChild(dot); li.appendChild(nm);
        if (h.author || !h.ok) {
          var note = document.createElement("small");
          note.textContent = h.author ? "running the show" : "weak line";
          li.appendChild(note);
        }
        if (me && me.author && h.p !== me.p) {
          var x = document.createElement("button");
          x.type = "button"; x.className = "btn live-host-x"; x.textContent = "Remove";
          x.addEventListener("click", function () { control("kick", { who: h.p }); });
          li.appendChild(x);
        }
        frag.appendChild(li);
      });
      while (ul.firstChild) ul.removeChild(ul.firstChild);
      ul.appendChild(frag);
    }
    function noteClock(tSend, srvNow) {
      if (!me || typeof srvNow !== "number") return;
      var tRecv = Date.now() / 1000, rtt = tRecv - tSend;
      if (rtt <= (me.rtt == null ? 1e9 : me.rtt) + 0.02) { me.rtt = rtt; me.off = srvNow - (tSend + tRecv) / 2; }
    }
    $("live-ready").addEventListener("submit", function (e) {
      e.preventDefault();
      var startBtn = $("live-start");
      if (startBtn.disabled || !mic) return;
      startBtn.disabled = true;
      var name = $("live-name").value.replace(/\s+/g, " ").trim(), tSend = Date.now() / 1000, phones = $("live-phones").checked;
      store.set("raadio.liveName", name);
      var go = joining && other && other.id
        ? api.post("/api/live/" + encodeURIComponent(other.id) + "/join", { name: name, headphones: phones })
        : api.post("/api/live/start", { title: $("live-title").value, name: name, headphones: $("live-need-phones").checked });
      go.then(function (r) {
        if (engine.isOn()) engine.stop();             // the mic mustn't pick up the radio
        me = { id: r.id, p: r.p, name: r.name, room: r.room, title: r.title, started: Date.now(), author: !joining, gen: -1, level: 0,
               changed: Date.now(), rec: null, queue: [], sending: false, hear: false, off: 0, rtt: null };
        other = null;
        joining = false;
        noteClock(tSend, r.now);
        startRecorder();
        liveTakes.pause(true);
        // (some browsers may not manage a second recorder: the show goes on, with the on-air version)
        try { me.hq = liveTakes.begin(r.id, r.p, mic.dest.stream, function () { return Date.now() / 1000 + (me ? me.off : 0); }); }
        catch (err) { me.hq = null; log.add("warn", "This device can't make a high-quality recording; the on-air version will still be saved"); }
        clockTimer = setInterval(function () {
          if (!me) return;
          var t = Math.floor((Date.now() - me.started) / 1000);
          setText($("live-clock"), (t >= 3600 ? Math.floor(t / 3600) + ":" : "") + pad2(Math.floor(t / 60) % 60) + ":" + pad2(t % 60));
        }, 500);
        try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (w) { wake = w; }).catch(function () {}); } catch (err) { /* ignore */ }
        state("live");
        fillMics();
        setHear(phones);
        lastMusic = null; uploads = []; renderMusic({ playing: null, queue: [], talk: false, hold: false });
        pollMusic();
        log.add("ok", "You're live. Chat: " + r.room);
        setTimeout(function () { nowPlaying.poll && nowPlaying.poll(); liveChat.poll(); }, 1500);
      }).catch(function (ex) {
        log.add("error", ex.message || "Couldn't go live");
        if (ex.status === 409) {                         // someone went live just now: join them instead
          api.get("/api/live").then(function (r) {
            if (me || !r.live) return;
            other = Object.assign({}, r.live, { id: r.id, headphones: r.headphones, full: r.full, canEnd: r.can_end });
            openForm(true);
          }).catch(function () { /* ignore */ });
        }
      }).then(function () { startBtn.disabled = false; updateReady(); });
    });
    // this device stops (the server is told separately)
    function finish(why) {
      if (!me) return;
      var m = me;
      stopReturn();
      me = null;
      clearInterval(clockTimer); clearTimeout(musicTimer);
      try { if (m.rec && m.rec.state !== "inactive") m.rec.stop(); } catch (e) { /* ignore */ }
      if (m.hq) liveTakes.finish(m.hq);
      liveTakes.pause(false);
      closeMic();
      try { if (wake) wake.release(); } catch (e) { /* ignore */ }
      wake = null;
      setText($("live-clock"), "");
      var mb = $("live-mute"); mb.setAttribute("aria-pressed", "false"); setText(mb, "Mute");
      log.add("ok", why || "You're off air");
      state("off");
      setTimeout(function () { nowPlaying.poll && nowPlaying.poll(); liveChat.poll(); loadRecordings(); }, 800);
    }
    $("live-end").addEventListener("click", function () {
      if (me) {
        var id = me.id, p = me.p, author = me.author;
        finish(author ? "You're off air. The chat is closed." : "You've left the show");
        if (author) api.post("/api/live/" + encodeURIComponent(id) + "/stop").catch(function () { /* it ends by itself */ });
        else api.post("/api/live/" + encodeURIComponent(id) + "/leave", { p: p }).catch(function () { /* ignore */ });
        return;
      }
      if (other && other.id) {                          // a show left running on my login, or a curator ending someone's
        api.post("/api/live/" + encodeURIComponent(other.id) + "/stop").then(function () { log.add("ok", "The stream is ended"); liveChat.poll(); nowPlaying.poll(); })
          .catch(function (ex) { log.add("error", ex.message); });
        return;
      }
      state("off");
    });
    $("live-chat-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var inp = $("live-chat-text"), text = inp.value.replace(/\s+/g, " ").trim();
      if (!text) return;
      liveChat.say(text, (me && me.name) || (session && session.user)).then(function () { inp.value = ""; })
        .catch(function (ex) { log.add("error", ex.message); });
    });
    // ---- the recordings, for a week ----
    var recsTimer = 0;
    function loadRecordings() {
      clearTimeout(recsTimer);
      if (!session) return;
      api.get("/api/live/recordings").then(function (r) {
        renderRecordings(r.items || [], r.now);
        if ((r.items || []).some(function (i) { return !i.mix && (i.takes_in < i.takes || i.mixing); })) recsTimer = setTimeout(loadRecordings, 20000);
      }).catch(function () { /* next time */ });
    }
    function renderRecordings(items, nowS) {
      var ul = $("live-recs-list"), frag = document.createDocumentFragment();
      $("live-recs").hidden = !items.length && $("live-recs-up").hidden;
      items.forEach(function (i) {
        var li = document.createElement("li"), t = document.createElement("b"), meta = document.createElement("small"), btns = document.createElement("div");
        t.textContent = i.title; t.dir = "auto";
        var days = Math.max(1, Math.ceil((i.expires - nowS) / 86400));
        meta.dir = "auto";
        meta.textContent = i.hosts.join(", ");
        var left = document.createElement("small");
        left.textContent = "Deleted in " + days + (days === 1 ? " day" : " days");
        btns.className = "live-rec-btns";
        function add(kind, label, primary) {
          var b = document.createElement("button");
          b.type = "button"; b.className = "btn" + (primary ? " btn--primary" : ""); b.textContent = label;
          b.addEventListener("click", function () {
            api.post("/api/live/recordings/" + encodeURIComponent(i.id) + "/link", { kind: kind }).then(function (r) {
              var a = document.createElement("a");
              a.href = hosts.current() + r.url; a.download = ""; a.rel = "noopener";
              document.body.appendChild(a); a.click(); a.remove();
            }).catch(function (ex) { log.add("error", ex.message); });
          });
          btns.appendChild(b);
        }
        if (i.mix) add("mix", "High quality", true);
        if (i.air) add("air", "On-air version", !i.mix);
        li.appendChild(t); li.appendChild(meta); li.appendChild(left);
        if (!i.mix && (i.mixing || i.takes)) {
          var w = document.createElement("small");
          w.textContent = i.mixing || i.takes_in === i.takes ? "Mixing the high-quality file…" : "Waiting for high-quality recordings: " + i.takes_in + " of " + i.takes + " in";
          li.appendChild(w);
        }
        li.appendChild(btns);
        frag.appendChild(li);
      });
      while (ul.firstChild) ul.removeChild(ul.firstChild);
      ul.appendChild(frag);
    }
    liveTakes.onProgress(function (pct) {
      var el = $("live-recs-up");
      el.hidden = pct == null;
      if (pct != null) { setText(el, "Your high-quality recording is uploading: " + pct + "%. Keep this page open if you can; it carries on next time you open the studio."); $("live-recs").hidden = false; }
      else loadRecordings();
    });
    // ---- music in the show ----
    var when = "queue", musicTimer = 0, uploads = [];        // uploads: songs on their way up
    function setWhen(w) {
      when = w;
      $("live-when-queue").setAttribute("aria-checked", w === "queue" ? "true" : "false");
      $("live-when-now").setAttribute("aria-checked", w === "now" ? "true" : "false");
    }
    $("live-when-queue").addEventListener("click", function () { setWhen("queue"); });
    $("live-when-now").addEventListener("click", function () { setWhen("now"); });
    function fmtDur(sec) { if (!sec) return ""; sec = Math.round(sec); return Math.floor(sec / 60) + ":" + pad2(sec % 60); }
    function renderMusic(m) {
      var box = $("live-now"), ol = $("live-queue");
      var playing = m && m.playing;
      box.hidden = !playing;
      if (playing) setText($("live-now-name"), playing.name);
      var talk = !!(m && m.talk);
      $("live-music-talk").setAttribute("aria-pressed", talk ? "true" : "false");
      setText($("live-music-talk"), talk ? "Talking" : "Talk");
      setText($("live-now-hint"), talk ? "Everyone hears you over the song (turned down)." : "Your mic is off while the song plays.");
      $("live-music-play").hidden = !(m && m.hold && !playing && m.queue.length);
      ol.replaceChildren();
      uploads.forEach(function (u) {
        var li = document.createElement("li");
        li.innerHTML = '<span class="lq-n">↑</span><span class="lq-name"></span><span class="lq-state"></span>';
        li.querySelector(".lq-name").textContent = u.name;
        li.querySelector(".lq-state").textContent = u.err ? u.err : Math.round(u.p * 100) + "%";
        ol.appendChild(li);
      });
      ((m && m.queue) || []).forEach(function (q, i) {
        var li = document.createElement("li");
        li.innerHTML = '<span class="lq-n"></span><span class="lq-name" dir="auto"></span><span class="lq-state"></span>' +
          '<button type="button" class="lq-del" aria-label="Remove from the queue"><svg class="icon icon--sm"><use href="#i-close"/></svg></button>';
        li.querySelector(".lq-n").textContent = String(i + 1);
        li.querySelector(".lq-name").textContent = q.name;
        li.querySelector(".lq-state").textContent = fmtDur(q.dur);
        li.querySelector(".lq-del").addEventListener("click", function () { control("remove", { qid: q.qid }); });
        ol.appendChild(li);
      });
    }
    function control(action, extra) {
      if (!me) return Promise.resolve();
      return api.post("/api/live/" + encodeURIComponent(me.id) + "/control", Object.assign({ action: action, p: me.p }, extra || {}))
        .then(renderMusic).catch(function (ex) { log.add("error", ex.message); });
    }
    function pollMusic() {
      clearTimeout(musicTimer);
      if (!me) return;
      var tSend = Date.now() / 1000;
      api.get("/api/live?p=" + encodeURIComponent(me.p)).then(function (r) {
        if (!me) return;
        noteClock(tSend, r.now);
        if (!r.live || r.id !== me.id || !r.mine) { me.gone = (me.gone || 0) + 1; if (me.gone >= 2) finish("You're off air"); return; }
        me.gone = 0;
        me.author = r.author;
        renderHosts(r.hosts);
        $("live-music").hidden = !me.author;
        if (me.author) renderMusic(r.music);
      }).catch(function () { /* next time */ })
        .then(function () { if (me) musicTimer = setTimeout(pollMusic, 2000); });
    }
    function addSongs(files) {
      if (!me) return;
      var list = Array.prototype.filter.call(files || [], function (f) { return /^audio\//.test(f.type) || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(f.name); });
      if (!list.length) { log.add("warn", "Those aren't audio files"); return; }
      var now = when === "now";
      // one at a time, in order; with "Play now", the first plays at once and the rest queue up after it
      (function next(i) {
        if (i >= list.length || !me) return;
        var f = list[i], name = f.name.replace(/\.[a-z0-9]+$/i, "");
        var u = { name: name, p: 0 };
        uploads.push(u); renderMusic(null); pollMusic();
        api.upload(f, name, "upload", function (p) { u.p = p; renderMusic(lastMusic); }).then(function (media) {
          if (!me) return;
          return api.post("/api/live/" + encodeURIComponent(me.id) + "/music", { media: media.id, now: now && i === 0, p: me.p });
        }).then(function (m) {
          uploads.splice(uploads.indexOf(u), 1);
          if (m) { lastMusic = m; renderMusic(m); }
        }).catch(function (ex) {
          u.err = ex.message || "Couldn't add it";
          renderMusic(lastMusic);
          setTimeout(function () { var k = uploads.indexOf(u); if (k >= 0) uploads.splice(k, 1); renderMusic(lastMusic); }, 5000);
        }).then(function () { next(i + 1); });
      })(0);
    }
    var lastMusic = null;
    var _render = renderMusic;
    renderMusic = function (m) { if (m) lastMusic = m; _render(m || lastMusic); };
    $("live-file").addEventListener("change", function (e) { addSongs(e.target.files); e.target.value = ""; });
    var drop = $("live-drop");
    ["dragenter", "dragover"].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.add("is-over"); }); });
    ["dragleave", "drop"].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.remove("is-over"); }); });
    drop.addEventListener("drop", function (e) { addSongs(e.dataTransfer && e.dataTransfer.files); });
    $("live-music-stop").addEventListener("click", function () { control("stop"); });
    $("live-music-skip").addEventListener("click", function () { control("skip"); });
    $("live-music-play").addEventListener("click", function () { control("play"); });
    $("live-music-talk").addEventListener("click", function () {
      var on = $("live-music-talk").getAttribute("aria-pressed") !== "true";
      $("live-music-talk").setAttribute("aria-pressed", on ? "true" : "false");
      control("talk", { on: on });
    });

    window.addEventListener("pagehide", function () {
      if (!me) return;
      // (this device leaves; the others carry on. Its high-quality recording goes up next time.)
      try { fetch(base() + "/api/live/" + encodeURIComponent(me.id) + "/leave", { method: "POST", headers: { Authorization: authH(), "Content-Type": "application/json" }, body: JSON.stringify({ p: me.p }), keepalive: true }); } catch (e) { /* ignore */ }
    });
    return {
      watching: function () { return flipped && (panel.dataset.state === "live" || panel.dataset.state === "watch"); },
      opened: function () {
        if (!session) return;
        liveTakes.resume();
        loadRecordings();
        if (me) return;
        api.get("/api/live").then(function (r) {
          if (me) return;
          if (r.live) {
            other = Object.assign({}, r.live, { id: r.id, headphones: r.headphones, full: r.full, canEnd: r.can_end });
            if (panel.dataset.state !== "ready") state("watch");
            offerJoin();
          } else if (panel.dataset.state !== "ready") state("off");
        }).catch(function () { /* ignore */ });
      },
      isLive: function () { return !!me; }
    };
  })();

  /* ---------------- Studio: the flamingos' notes ----------------
     Every note still waiting (two hours, or one when the sky is full): edit it, remove it, send it flying now, or add one.
     And the list of words a note can't contain (English, Finglish, Farsi). */
  // Where the notes are managed: a curator has them at the bottom of the "Flamingo notes"
  // tile among the numbers (open the tile to see them); other hosts, who don't see the
  // numbers, keep them in the studio as before
  function placeNotes() {
    var p = $("notes-panel"), tileSpot = $("an-notes"), home = $("notes-home");
    if (!p || !tileSpot || !home) return;
    var inTile = !!(session && session.role === "curator");
    var into = inTile ? tileSpot : home;
    if (p.parentNode !== into) into.appendChild(p);
    p.classList.toggle("is-in-tile", inTile);
  }
  var notesPanel = (function () {
    var root = $("notes-panel");
    if (!root) return { load: function () {} };
    var list = $("notes-list"), words = $("words-list"), timer = 0;
    function ago(sec) { var m = Math.max(0, Math.round(sec / 60)); return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + " min"; }
    function render(d) {
      var frag = document.createDocumentFragment(), now = Date.now() / 1000;
      if (!d.items.length) {
        var e = document.createElement("li"); e.className = "queue-empty"; e.textContent = "No notes right now. Catch a flamingo while listening to leave one.";
        frag.appendChild(e);
      }
      d.items.forEach(function (n) {
        var li = document.createElement("li");
        li.className = "queue-item note-item" + (n.flagged ? " is-flagged" : "");
        var body = document.createElement("div"); body.className = "queue-body";
        var name = document.createElement("button"); name.type = "button"; name.className = "queue-name"; name.textContent = n.text; name.dir = "auto";
        name.title = "Change it";
        var meta = document.createElement("span"); meta.className = "queue-meta";
        meta.textContent = (n.source === "listener" ? "From a listener" : "Added by " + n.source) + " · gone in " + ago(n.expires - now) + (n.flagged ? " · has a blocked word" : "");
        body.appendChild(name); body.appendChild(meta);
        var fly = document.createElement("button"); fly.type = "button"; fly.className = "queue-edit"; fly.setAttribute("aria-label", "Fly it now"); fly.title = "Fly it now";
        fly.innerHTML = '<svg class="icon icon--sm"><use href="#i-send"/></svg>';
        var del = document.createElement("button"); del.type = "button"; del.className = "queue-del"; del.setAttribute("aria-label", "Remove"); del.title = "Remove";
        del.innerHTML = '<svg class="icon icon--sm"><use href="#i-trash"/></svg>';
        name.addEventListener("click", function () {
          var inp = document.createElement("input"); inp.className = "queue-rename"; inp.value = n.text; inp.maxLength = 55; inp.dir = "auto";
          body.replaceChild(inp, name); inp.focus(); inp.select();
          function done(save) {
            if (!inp.isConnected) return;
            var v = inp.value.trim();
            if (save && v && v !== n.text) api.patch("/api/notes/" + n.id, { text: v }).then(load).catch(function (ex) { log.add("error", ex.message); load(); });
            else load();
          }
          inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); });
          inp.addEventListener("blur", function () { done(true); });
        });
        fly.addEventListener("click", function () { api.post("/api/notes/fly/" + n.id).then(function () { log.add("ok", "Flamingo on its way with “" + n.text + "”"); }).catch(function (ex) { log.add("error", ex.message); }); });
        del.addEventListener("click", function () {
          if (!del.classList.contains("confirm")) { del.classList.add("confirm"); setTimeout(function () { del.classList.remove("confirm"); }, 2500); return; }
          api.del("/api/notes/" + n.id).then(load).catch(function (ex) { log.add("error", ex.message); });
        });
        li.appendChild(body); li.appendChild(fly); li.appendChild(del);
        frag.appendChild(li);
      });
      list.replaceChildren(frag);
      var wf = document.createDocumentFragment();
      d.words.forEach(function (w) {
        var chip = document.createElement("button"); chip.type = "button"; chip.className = "word-chip"; chip.dir = "auto";
        chip.innerHTML = "<span></span><svg class='icon'><use href='#i-close'/></svg>"; chip.firstChild.textContent = w;
        chip.setAttribute("aria-label", "Allow " + w + " again");
        chip.addEventListener("click", function () { api.del("/api/blocked-words/" + encodeURIComponent(w)).then(load).catch(function (ex) { log.add("error", ex.message); }); });
        wf.appendChild(chip);
      });
      words.replaceChildren(wf);
      setText($("words-count"), d.words.length + (d.words.length === 1 ? " word" : " words"));
    }
    function load() {
      if (!session) return Promise.resolve();
      return api.get("/api/notes").then(render).catch(function (ex) { log.add("error", "Notes: " + ex.message); });
    }
    $("note-add").addEventListener("submit", function (e) {
      e.preventDefault();
      var inp = $("note-new"), v = inp.value.trim();
      if (!v) return;
      api.post("/api/notes", { text: v }).then(function () { inp.value = ""; load(); }).catch(function (ex) { log.add("error", ex.message); });
    });
    $("word-add").addEventListener("submit", function (e) {
      e.preventDefault();
      var inp = $("word-new"), v = inp.value.trim();
      if (!v) return;
      api.post("/api/blocked-words", { word: v }).then(function () { inp.value = ""; load(); }).catch(function (ex) { log.add("error", ex.message); });
    });
    function start() { load(); clearInterval(timer); timer = setInterval(function () { if (flipped && !document.hidden) load(); }, 30000); }
    return { load: load, start: start };
  })();

  /* ---------------- Cobwebs: the installed app, left alone for a week ----------------
     Installed (opened as an app, not in a browser tab) and not listened to for 7 days or
     more: spiders have moved in. Orb webs are strung across the gaps of the radio itself,
     tied to the real edges: from the display down to the wave panel on both sides, and
     from the wave panel down between the buttons, with a cobweb in the top corner. Each is
     built like a real one: a frame, spokes out of a hub, one capture spiral wound outwards,
     sagging a little, catching the light. A light breeze sways them, and dust and a seed or
     two drift through. Listening clears them a strand at a time (the outer turns first),
     gone after about ten minutes of music. ?webs=0.9 shows them in any browser. */
  (function cobwebs() {
    var DAY = 86400000, AWAY = 7 * DAY, CLEAR_S = 600;
    var KEY = "raadio.webs", LAST = "raadio.last-listen", FIRST = "raadio.first-open";
    var app = false;
    try { app = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; } catch (e) { /* ignore */ }
    var forced = parseFloat(new URLSearchParams(location.search).get("webs"));
    var now = Date.now(), amount = parseFloat(store.get(KEY, 0)) || 0;
    if (app && !store.get(FIRST, 0)) store.set(FIRST, now);
    var last = store.get(LAST, 0) || store.get(FIRST, 0);
    var SPIDERS = "raadio.spiders", spiders = parseInt(store.get(SPIDERS, 0), 10) || 0;
    if (app && last && now - last >= AWAY) {
      // a week away: the webs are up; every further week another spider moves in (up to five)
      amount = 1;
      spiders = Math.max(spiders, Math.min(5, 1 + Math.floor((now - last - AWAY) / AWAY)));
      store.set(KEY, amount); store.set(SPIDERS, spiders);
    }
    if (!isNaN(forced)) { amount = Math.max(0, Math.min(1, forced)); spiders = Math.max(1, Math.min(5, parseInt(new URLSearchParams(location.search).get("spiders"), 10) || 1)); }
    function noteListening() { if (engine.isOn()) store.set(LAST, Date.now()); }
    if (amount <= 0.001) {
      setInterval(noteListening, 30000);
      engine.on("state", noteListening);
      return { amount: function () { return 0; } };
    }
    var card = document.querySelector(".face--front");
    var layer = document.createElement("div");
    layer.className = "webs";
    layer.setAttribute("aria-hidden", "true");
    card.appendChild(layer);
    var calm = perf.reducedMotion;

    function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
    function f(n) { return n.toFixed(1); }
    // where a ray from the hub leaves the frame
    function hit(h, a, poly) {
      var dx = Math.cos(a), dy = Math.sin(a), best = null;
      for (var i = 0; i < poly.length; i++) {
        var p = poly[i], q = poly[(i + 1) % poly.length];
        var ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        var t = ((p[0] - h[0]) * ey - (p[1] - h[1]) * ex) / den, u = ((p[0] - h[0]) * dy - (p[1] - h[1]) * dx) / den;
        if (t > 0 && u >= 0 && u <= 1 && (best === null || t < best)) best = t;
      }
      return best;
    }
    // one orb web inside a frame (points around it, in card pixels). Every thread has a
    // "t": it's there while the webs are thicker than t (spiral: outer turns go first).
    function orb(poly, seed, opts) {
      var R = rng(seed), out = [], dew = [];
      var cx = 0, cy = 0;
      poly.forEach(function (p) { cx += p[0]; cy += p[1]; });
      cx /= poly.length; cy /= poly.length;
      var hub = [cx + (R() - 0.5) * 8, cy - 3 - R() * 5];                  // a real hub sits a little high
      // the frame floats inside the gap, a little in from where it's tied; each corner hangs
      // from one or two mooring lines out to the radio's edges (anchors)
      var anchors = poly;
      poly = anchors.map(function (p) {
        var k = 0.16 + R() * 0.12;
        return [p[0] + (hub[0] - p[0]) * k + (R() - 0.5) * 4, p[1] + (hub[1] - p[1]) * k + (R() - 0.5) * 4];
      });
      poly.forEach(function (p, i) {
        var q = anchors[i];
        out.push({ d: "M" + f(p[0]) + " " + f(p[1]) + "L" + f(q[0]) + " " + f(q[1]), t: 0.02 + R() * 0.03, k: "moor" });
        if (R() < 0.55) {                                                 // a second line, splayed: a "Y"
          var nb = anchors[(i + 1) % anchors.length], u = 0.12 + R() * 0.16;
          var q2 = [q[0] + (nb[0] - q[0]) * u, q[1] + (nb[1] - q[1]) * u];
          out.push({ d: "M" + f(p[0]) + " " + f(p[1]) + "L" + f(q2[0]) + " " + f(q2[1]), t: 0.03 + R() * 0.05, k: "moor" });
        }
      });
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], b = poly[(i + 1) % poly.length];
        var mx = (a[0] + b[0]) / 2 + (hub[0] - (a[0] + b[0]) / 2) * (0.08 + R() * 0.08), my = (a[1] + b[1]) / 2 + (hub[1] - (a[1] + b[1]) / 2) * (0.08 + R() * 0.08) + 1.2;
        out.push({ d: "M" + f(a[0]) + " " + f(a[1]) + "Q" + f(mx) + " " + f(my) + " " + f(b[0]) + " " + f(b[1]), t: 0.02 + R() * 0.04, k: "frame" });
      }
      // spokes
      var n = opts.spokes, ang = [], len = [];
      for (var j = 0; j < n; j++) {
        var a2 = (j + (R() - 0.5) * 0.35) / n * Math.PI * 2;
        var L = hit(hub, a2, poly);
        if (!L || L < 6) continue;
        ang.push(a2); len.push(L * 0.985);
      }
      n = ang.length;
      if (n < 5) return { paths: [], dew: [] };
      ang.forEach(function (a3, k) {
        out.push({ d: "M" + f(hub[0]) + " " + f(hub[1]) + "L" + f(hub[0] + Math.cos(a3) * len[k]) + " " + f(hub[1] + Math.sin(a3) * len[k]), t: 0.04 + R() * 0.08, k: "spoke" });
      });
      // the hub: a few tight irregular loops
      var hubPath = "";
      for (var hl = 1; hl <= 3; hl++) {
        var hr = 1.4 * hl + R() * 0.8;
        for (var hk = 0; hk < n; hk++) {
          var aa = ang[hk], ab = ang[(hk + 1) % n];
          hubPath += (hk ? "L" : "M") + f(hub[0] + Math.cos(aa) * hr) + " " + f(hub[1] + Math.sin(aa) * hr);
          if (hk === n - 1) hubPath += "L" + f(hub[0] + Math.cos(ab) * hr) + " " + f(hub[1] + Math.sin(ab) * hr);
        }
      }
      out.push({ d: hubPath, t: 0.03, k: "hub" });
      // the capture spiral: wound outwards from a free zone round the hub, spoke to spoke,
      // at an even spacing; where a turn would cross the frame it stops (as real ones do)
      var free = Math.max(5, Math.min.apply(null, len) * 0.18), gap = opts.gap, maxL = Math.max.apply(null, len);
      var turn = 0, r = free, k2 = 0, prev = null;
      while (turn < 60) {
        var i2 = k2 % n, rr = r + (R() - 0.5) * gap * 0.4;
        var limit = len[i2] * (0.74 + ((i2 * 7919) % 13) / 100);
        var pt = rr < limit ? [hub[0] + Math.cos(ang[i2]) * rr, hub[1] + Math.sin(ang[i2]) * rr, rr] : null;
        if (prev && pt && R() > 0.05) {                                     // (now and then a strand is broken)
          // a little slack: the middle hangs towards the hub and down
          var mx2 = (prev[0] + pt[0]) / 2, my2 = (prev[1] + pt[1]) / 2;
          mx2 += (hub[0] - mx2) * 0.07; my2 += (hub[1] - my2) * 0.07 + 0.6;
          var outer = Math.max(prev[2], pt[2]) / maxL;
          out.push({ d: "M" + f(prev[0]) + " " + f(prev[1]) + "Q" + f(mx2) + " " + f(my2) + " " + f(pt[0]) + " " + f(pt[1]),
                     t: 0.1 + 0.85 * outer * (0.75 + R() * 0.25), k: "spiral" });
          if (R() < 0.07) dew.push({ x: mx2, y: my2, r: 0.6 + R() * 0.7, t: 0.1 + 0.85 * outer });
        }
        prev = pt;
        k2++;
        r += gap / n;
        if (k2 % n === 0) { turn++; if (r > maxL) break; }
      }
      // a torn spoke, hanging loose
      if (opts.loose) {
        var ka = Math.floor(R() * n), lx = hub[0] + Math.cos(ang[ka]) * len[ka] * 0.6, ly = hub[1] + Math.sin(ang[ka]) * len[ka] * 0.6;
        out.push({ d: "M" + f(lx) + " " + f(ly) + "q" + f(4 + R() * 6) + " " + f(10 + R() * 8) + " " + f(-2 + R() * 4) + " " + f(18 + R() * 14), t: 0.5 + R() * 0.3, k: "loose" });
      }
      return { paths: out, dew: dew, hub: hub };
    }
    // the frames, from where things actually are on the radio
    function frames() {
      var c = card.getBoundingClientRect();
      function rel(el) {
        if (!el || el.hidden || !el.offsetWidth) return null;
        var r = el.getBoundingClientRect();
        return { l: r.left - c.left, t: r.top - c.top, r: r.right - c.left, b: r.bottom - c.top, w: r.width, h: r.height, cx: r.left - c.left + r.width / 2, cy: r.top - c.top + r.height / 2 };
      }
      var plate = rel(card.querySelector(".plate")), wave = rel(card.querySelector(".wave"));
      var skip = rel($("skip-btn")), play = rel($("play-btn")), save = rel($("save-btn"));
      var W = c.width, out = [];
      if (plate && wave && wave.t - plate.b > 24) {
        // from the display's lower corners down to the wave panel, both sides of the title
        var wl = Math.min(110, W * 0.3), wr = Math.min(86, W * 0.24);
        out.push({ id: "pl", poly: [[plate.l + 8, plate.b - 2], [plate.l + wl, plate.b - 1], [wave.l + wl * 0.7, wave.t + 1], [wave.l + 6, wave.t + 2]], spokes: 19, gap: 5.6, loose: true, spider: false });
        out.push({ id: "pr", poly: [[plate.r - wr, plate.b - 1], [plate.r - 8, plate.b - 2], [wave.r - 6, wave.t + 2], [wave.r - wr * 0.75, wave.t + 1]], spokes: 17, gap: 5.4, loose: false, spider: true });
      }
      // under the wave panel, between the buttons
      function between(a, b, id) {
        if (!a || !b || !wave) return;
        var ra = a.w / 2, rb = b.w / 2, gx = (a.r + b.l) / 2;
        function on(btn, rad, deg) { var t = deg * Math.PI / 180; return [btn.cx + Math.cos(t) * rad * 0.98, btn.cy + Math.sin(t) * rad * 0.98]; }
        var top = wave.b + 1;
        if (a.t - top > 30) return;
        out.push({ id: id, poly: [[gx - 18, top], [gx + 18, top], on(b, rb, b.cx > gx ? -150 : -30), on(b, rb, b.cx > gx ? 160 : 20), on(a, ra, a.cx < gx ? 25 : 155), on(a, ra, a.cx < gx ? -35 : -145)],
                   spokes: 15, gap: 5, loose: false, spider: false });
      }
      between(skip, play, "bl");
      between(play, save, "br");
      // a small one in the top corner of the radio
      out.push({ id: "tl", poly: [[5, 5], [Math.min(92, W * 0.24), 4], [6, 74]], spokes: 13, gap: 5.2, loose: true, spider: false });
      return out;
    }
    var SPIDER = '<g class="web-spider-legs">' +
      '<path d="M-2.2 -1.6 L-6 -5.2 L-9 -3.6 M-2.6 -0.4 L-7.2 -2.2 L-10.2 0.2 M-2.4 0.8 L-6.6 2.6 L-8.8 6.4 M-1.8 1.8 L-4.2 5.6 L-5.2 9.4"/>' +
      '<path d="M2.2 -1.6 L6 -5.2 L9 -3.6 M2.6 -0.4 L7.2 -2.2 L10.2 0.2 M2.4 0.8 L6.6 2.6 L8.8 6.4 M1.8 1.8 L4.2 5.6 L5.2 9.4"/></g>' +
      '<ellipse class="web-spider-abdomen" cx="0" cy="4.2" rx="2.9" ry="3.6"/><ellipse cx="0" cy="-0.6" rx="2.1" ry="2.3"/>' +
      '<path class="web-spider-mark" d="M0 2.2 V6.6 M-1.2 3.6 H1.2"/>';
    var built = false, parts = [];
    function build() {
      var W = card.offsetWidth, H = card.offsetHeight;
      if (!W || !H) return;
      var svg = '<svg class="webs-svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '"><defs>' +
        // light travelling over the strands
        '<linearGradient id="web-sheen" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + W + '" y2="' + H * 0.4 + '">' +
        '<stop offset="0" class="web-c"/><stop offset="0.42" class="web-c"/><stop offset="0.5" class="web-hi"/><stop offset="0.58" class="web-c"/><stop offset="1" class="web-c"/>' +
        (calm ? "" : '<animate attributeName="x1" values="' + (-W) + ";" + W + '" dur="9s" repeatCount="indefinite"/><animate attributeName="x2" values="0;' + 2 * W + '" dur="9s" repeatCount="indefinite"/>') +
        "</linearGradient></defs>";
      // where the spiders go, in the order they move in: the first hangs on a thread from the
      // left web, the next sit in the middle of other webs or hang from them
      var PLACES = [["pl", "hang"], ["pr", "sit"], ["tl", "hang"], ["bl", "sit"], ["br", "hang"]];
      var homes = {};
      PLACES.slice(0, spiders).forEach(function (pl, k) { homes[pl[0]] = { how: pl[1], t: (0.25 + 0.55 * (spiders - 1 - k) / Math.max(1, spiders - 1)).toFixed(3) }; });
      var DR = rng(4242), dust = "";
      frames().forEach(function (fr, n) {
        var w = orb(fr.poly, 101 + n * 977, fr);
        if (!w.paths.length) return;
        var hub = w.hub, home = homes[fr.id];
        svg += '<g class="web-sway" style="transform-origin:' + f(hub[0]) + "px " + f(hub[1]) + "px;animation-duration:" + (5.5 + n * 0.9).toFixed(1) + "s;animation-delay:-" + (n * 1.3).toFixed(1) + 's">';
        w.paths.forEach(function (p) { svg += '<path class="web-' + p.k + '" data-t="' + p.t.toFixed(3) + '" d="' + p.d + '"/>'; });
        w.dew.forEach(function (d) { svg += '<circle class="web-dew" data-t="' + d.t.toFixed(3) + '" cx="' + f(d.x) + '" cy="' + f(d.y) + '" r="' + d.r.toFixed(2) + '"/>'; });
        if (home && home.how === "sit") {
          svg += '<g class="web-spider" data-t="' + home.t + '" transform="translate(' + f(hub[0]) + " " + f(hub[1] + 1) + ') rotate(' + (165 + n * 9) + ')">' + SPIDER + "</g>";
        }
        svg += "</g>";
        if (home && home.how === "hang") {
          // on its own thread from the bottom of the web, turning slowly in the breeze
          var tx = hub[0] + (fr.id === "pl" ? -6 : 4), ty = hub[1] + 6, drop = 34 + (n % 3) * 10;
          svg += '<g class="web-spider web-hanging" data-t="' + home.t + '" style="transform-origin:' + f(tx) + "px " + f(ty) + "px;animation-duration:" + (4.6 + n * 0.7).toFixed(1) + 's">' +
            '<path class="web-silk" d="M' + f(tx) + " " + f(ty) + "L" + f(tx) + " " + f(ty + drop) + '"/>' +
            '<g transform="translate(' + f(tx) + " " + f(ty + drop + 4) + ')">' + SPIDER + "</g></g>";
        }
      });
      // dust settled on the radio: more on the top edges, specks and the odd bit of lint
      ["nameplate", "plate", "wave", "skip-btn", "play-btn", "save-btn", "song-card"].forEach(function (key, ki) {
        var el = key.indexOf("-btn") > 0 ? $(key) : card.querySelector("." + key + ", #" + key);
        if (!el || el.hidden || !el.offsetWidth) return;
        var c = card.getBoundingClientRect(), r = el.getBoundingClientRect();
        var n = Math.round(Math.min(40, r.width * r.height / 1400)) + 4;
        for (var d = 0; d < n; d++) {
          var x = r.left - c.left + DR() * r.width, y = r.top - c.top + Math.pow(DR(), 1.8) * r.height;   // settles near the top
          if (key.indexOf("-btn") > 0) { var a = DR() * Math.PI * 2, rr = Math.sqrt(DR()) * r.width / 2 * 0.9; x = r.left - c.left + r.width / 2 + Math.cos(a) * rr; y = r.top - c.top + r.height / 2 + Math.sin(a) * rr * 0.9 - 2; }
          var t = (0.08 + DR() * 0.85).toFixed(3);
          if (DR() < 0.07) {
            var L = 3 + DR() * 5, ang = DR() * 6.28;
            dust += '<path class="web-lint" data-t="' + t + '" d="M' + f(x) + " " + f(y) + "q" + f(Math.cos(ang) * L / 2 + 1.5) + " " + f(Math.sin(ang) * L / 2 - 1) + " " + f(Math.cos(ang) * L) + " " + f(Math.sin(ang) * L) + '"/>';
          } else {
            dust += '<circle class="web-speck" data-t="' + t + '" cx="' + f(x) + '" cy="' + f(y) + '" r="' + (0.35 + DR() * DR() * 1.1).toFixed(2) + '" style="opacity:' + (0.25 + DR() * 0.45).toFixed(2) + '"/>';
          }
        }
      });
      svg = svg.replace("</defs>", "</defs><g class=\"web-dust\">" + dust + "</g>");
      svg += "</svg>";
      // the breeze: dust and a seed drifting across between the webs
      var drift = "";
      if (!calm) for (var m = 0; m < 7; m++) {
        var y = 8 + (m * 37 % 84), dur = 11 + (m * 5) % 9;
        drift += '<i class="web-mote' + (m % 3 === 0 ? " web-mote--seed" : "") + '" data-t="' + (0.15 + m * 0.09).toFixed(2) + '" style="top:' + y + "%;animation-duration:" + dur + "s;animation-delay:-" + (m * 2.7).toFixed(1) + 's"></i>';
      }
      layer.innerHTML = svg + drift;
      parts = Array.prototype.slice.call(layer.querySelectorAll("[data-t]"));
      built = true;
      show();
    }
    function show() {
      parts.forEach(function (el) { el.classList.toggle("is-gone", amount <= parseFloat(el.getAttribute("data-t"))); });
      layer.classList.toggle("is-clear", amount <= 0.001);
    }
    // laid out (and re-laid out when the radio changes size)
    setTimeout(build, 700);
    var rt = 0;
    window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(build, 400); });
    var lastTick = Date.now(), saved = 0;
    var timer = setInterval(function () {
      var t = Date.now(), dt = (t - lastTick) / 1000;
      lastTick = t;
      if (!engine.isOn() || document.hidden) return;
      store.set(LAST, t);
      amount = Math.max(0, amount - Math.min(dt, 5) / CLEAR_S);
      if (built) show();
      if (t - saved > 15000 || amount <= 0) { saved = t; if (isNaN(forced)) store.set(KEY, amount); }
      if (amount <= 0) {
        clearInterval(timer);
        if (isNaN(forced)) store.set(SPIDERS, 0);
        setTimeout(function () { layer.remove(); }, 4000);
      }
    }, 1000);
    return { amount: function () { return amount; }, rebuild: build };
  })();

  // The 3D glass, background and keys are decoration (three.js, ~170 KB). A slow or metered
  // line (Save-Data on, or the browser's estimate is 3G or slower) does without them, and
  // they never download while the music is starting: on a slow line (from Iran, say) they
  // used to compete with the stream's first seconds. They follow 4 s after it's on air.
  function decorAllowed() {
    var c = navigator.connection;
    return !(c && (c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType || "")));
  }
  function afterStart(fn) {
    if (state !== "connecting") { fn(); return; }
    var done = false;
    engine.on("state", function (st) { if (!done && st === "live") { done = true; setTimeout(fn, 4000); } });
  }
  onIdle(function () {
    perf.probe();
    if (!decorAllowed()) return;
    afterStart(function () { ambient.load(); glass.init(); keys3d.init(); });
  });
  // Curators: load the 3D library and draw the charts in the background, so the
  // studio opens with everything already there
  if (session) setTimeout(function () { onIdle(function () { curator.prewarm(); }); }, 1500);
})();
