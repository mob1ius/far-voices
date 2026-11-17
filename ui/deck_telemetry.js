/* Anonymous session summary.
 *
 * The deck has roughly thirty named controls, a dozen consoles and a set of
 * things that only happen if someone goes looking. Counting is the only way to
 * learn which of them anyone actually touches. This file does that counting and
 * nothing else, under the terms /privacy.html sets out, which are the spec:
 *
 *   - no identifier of any kind: no cookie, no stored id, no fingerprint, and
 *     nothing written to or read from browser storage at any point. Counters
 *     live in the closure below and die with the tab.
 *   - one transmission, on the way out, never while someone is reading.
 *   - counts, durations and outcomes. Never typed text, never pointer
 *     coordinates, never a referrer (the request log already has that).
 *   - Global Privacy Control or Do Not Track means nothing is counted at all.
 *     Not queued and discarded: the listeners are never installed.
 *
 * The server keeps these in a store with no address column, files them against
 * the day rather than the moment, and leaves /beacon out of the request log, so
 * the two records cannot be lined up against each other afterwards.
 */
(() => {
  'use strict';

  // Opt out before anything else happens, including before any listener is
  // attached. navigator.globalPrivacyControl is the current signal; doNotTrack
  // is the older one and still worth honouring, and it has lived on three
  // different objects over the years.
  const optedOut = navigator.globalPrivacyControl === true
    || navigator.doNotTrack === '1' || window.doNotTrack === '1'
    || navigator.msDoNotTrack === '1';
  if (optedOut || !navigator.sendBeacon) return;

  const T0 = performance.now();
  const S = {
    deck: document.body.classList.contains('cockpit') ? 'desktop' : 'mobile',
    controls: {},        // stable control name -> times used
    panels: {},          // help/music/signals/time machine/map/full screen
    strips: {},          // console -> seconds in view
    order: [],           // first touch of each control, in order, capped
    eggs: {},            // named discoveries
    faults: {},          // which caution lamps lit during the visit
    errors: [],          // script errors, capped
    maxRung: 0,          // highest alarm level reached
    maxRate: 0,          // worst tumble, degrees per second
    minCabin: null,
    maxCabin: null,
    scrollStrips: 0,
    audioMs: 0,
    poweredAt: null,
    firstTouchMs: null,
    liveFallback: null,  // true when the baked demo was served instead
    wsDrops: 0,
    assetFails: 0,
    // Audio diagnostics. The deck already exposes everything needed through
    // window.__FV and the boot screen's own status line, so none of this
    // required touching the audio code to collect.
    acState: null, acRate: null, choirBuffers: null, choirState: null,
    voicesPeak: 0,
  };
  let audioOn = null;

  const bump = (bag, key) => { if (key) bag[key] = (bag[key] || 0) + 1; };

  /* ---- controls.
     On the cockpit deck, bannerKey() already maps every interactive element to
     a stable name, so the taxonomy comes free and stays in step with the deck
     rather than drifting in a list kept over here.
     The mobile deck is a different interface, not a narrow version of the same
     one: no console strips, no apertures, about a dozen controls of its own.
     bannerKey lives in deck_banners.js, which mobile does not load, and loading
     it there would be both wrong and useless since none of its patterns match
     anything on that page. So mobile gets its own small explicit map. A
     whitelist rather than "use whatever id you find", so a stray id can never
     turn into a column nobody designed. */
  const MOBILE_CONTROL = {
    go: 'powerUp', play: 'transport', au: 'audioMute', pv: 'prevEvent',
    nx: 'nextEvent', tk: 'timeline', toneList: 'tone', corpusPick: 'corpus',
    glass: 'window', mapHint: 'mapControls', btnFocus: 'mapFocus',
    obReset: 'mapReset', momentBanner: 'moment',
  };
  const mobileKey = (el) => {
    const n = el && el.closest ? el.closest('[id]') : null;
    return n && MOBILE_CONTROL[n.id] ? MOBILE_CONTROL[n.id] : null;
  };

  addEventListener('pointerdown', (e) => {
    let key = null;
    try {
      key = typeof bannerKey === 'function' ? bannerKey(e.target) : null;
    } catch { /* ignore */ }
    if (!key) key = mobileKey(e.target);
    if (!key) return;
    if (S.firstTouchMs === null) S.firstTouchMs = Math.round(performance.now() - T0);
    if (!(key in S.controls) && S.order.length < 20) S.order.push(key);
    bump(S.controls, key);
  }, { capture: true, passive: true });

  /* ---- panels and the few buttons that are not deck controls */
  // Panel buttons. The two decks name the same panels differently, so both
  // sets of ids map onto one vocabulary and the counts stay comparable.
  const PANEL = {
    helpBtn: 'manual', btnLegend: 'legend', btnMusic: 'music', btnSignals: 'signals',
    btnTime: 'timeMachine', btnMap: 'map', btnFull: 'fullScreen',
    musicBtn: 'music', sigBtn: 'signals', tapeBtn: 'tapes', mapBtn: 'map',
    btnTapes: 'tapes',
  };
  addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('button,[id]') : null;
    if (el && PANEL[el.id]) bump(S.panels, PANEL[el.id]);
  }, { capture: true, passive: true });

  /* ---- which consoles were actually looked at, and for how long. Seconds in
     view, not a hit count: scrolling past something fast is not reading it. */
  if (window.IntersectionObserver) {
    const since = new Map();
    const io = new IntersectionObserver((entries) => {
      const now = performance.now();
      for (const en of entries) {
        const name = (en.target.id || '').replace(/bezel$/, '') || 'console';
        if (en.isIntersecting) {
          if (!since.has(en.target)) since.set(en.target, now);
        } else if (since.has(en.target)) {
          S.strips[name] = Math.round(((S.strips[name] || 0) + (now - since.get(en.target)) / 1000) * 10) / 10;
          since.delete(en.target);
        }
      }
    }, { threshold: 0.25 });
    const watch = () => document.querySelectorAll('#bezel,.stripbezel').forEach((el) => io.observe(el));
    if (document.readyState === 'complete') watch();
    else addEventListener('load', watch, { once: true });
    S._closeStrips = () => {
      const now = performance.now();
      for (const [el, t] of since) {
        const name = (el.id || '').replace(/bezel$/, '') || 'console';
        S.strips[name] = Math.round(((S.strips[name] || 0) + (now - t) / 1000) * 10) / 10;
      }
      since.clear();
    };
  }

  /* ---- how far down the deck anyone got, in consoles rather than pixels,
     because pixels mean nothing once the deck scales to the viewport */
  addEventListener('scroll', () => {
    const h = document.body.scrollHeight || 1;
    const st = g('STRIPS');
    // The mobile deck is one screen, not a stack of consoles, so "how many
    // strips did they reach" is meaningless there. Measure it in tenths of the
    // page instead, which is comparable to nothing but at least is not a lie.
    const strips = S.deck === 'mobile' ? 10 : ((st && st.length) ? st.length + 1 : 15);
    const reached = Math.ceil(((scrollY + innerHeight) / h) * strips);
    if (reached > S.scrollStrips) S.scrollStrips = Math.min(strips, reached);
  }, { passive: true });

  /* ---- script errors, so breakage is findable. Message, file and line only. */
  addEventListener('error', (e) => {
    if (S.errors.length >= 5) return;
    // A capture-phase 'error' listener catches two different things: real
    // script errors, which are ErrorEvents carrying a message, and failed
    // resource loads, which are plain Events on the element that failed. The
    // second kind has no message and was being recorded as the literal string
    // "error", which is noise that tells nobody anything. Count those
    // separately instead.
    if (!(e instanceof ErrorEvent) || !e.message) { S.assetFails++; return; }
    const msg = String(e.message).slice(0, 160);
    const where = e.filename ? String(e.filename).split('/').pop() + ':' + (e.lineno || 0) : '';
    const entry = msg + (where ? ' @ ' + where : '');
    if (!S.errors.includes(entry)) S.errors.push(entry);
  }, true);

  /* ---- outcomes are read from the deck's own state at the moment of leaving,
     rather than hooked one by one. Every read is guarded: a global that moves
     or disappears must never cost anything more than a missing field. */
  // Read by identifier, never through window[] and never through eval. These
  // are `let` bindings at the top level of a classic script, which live in the
  // global lexical scope and are therefore NOT properties of window, so a
  // window[name] lookup would silently return undefined for every one of them.
  // eval would reach them and is also the one thing the site's CSP forbids
  // (script-src 'self', no unsafe-eval), so it would throw on every call.
  // Guarded identifier reads are the only form that is both correct and allowed.
  const G = {
    AC:        () => (typeof AC === 'undefined' ? undefined : AC),
    SHIP:      () => (typeof SHIP === 'undefined' ? undefined : SHIP),
    PORT:      () => (typeof PORT === 'undefined' ? undefined : PORT),
    muted:     () => (typeof muted === 'undefined' ? undefined : muted),
    liveMode:  () => (typeof liveMode === 'undefined' ? undefined : liveMode),
    tagsPulled:() => (typeof tagsPulled === 'undefined' ? undefined : tagsPulled),
    armL:      () => (typeof armL === 'undefined' ? undefined : armL),
    armR:      () => (typeof armR === 'undefined' ? undefined : armR),
    sequenceDone: () => (typeof sequenceDone === 'undefined' ? undefined : sequenceDone),
    expanded:  () => (typeof expanded === 'undefined' ? undefined : expanded),
    lightMode: () => (typeof lightMode === 'undefined' ? undefined : lightMode),
    STRIPS:    () => (typeof STRIPS === 'undefined' ? undefined : STRIPS),
  };
  const g = (name) => { try { return G[name] ? G[name]() : undefined; } catch { return undefined; } };

  function sample() {
    try {
      const ship = g('SHIP');
      if (ship) {
        if (typeof ship.cabinC === 'number') {
          S.minCabin = S.minCabin === null ? ship.cabinC : Math.min(S.minCabin, ship.cabinC);
          S.maxCabin = S.maxCabin === null ? ship.cabinC : Math.max(S.maxCabin, ship.cabinC);
        }
        if (typeof ship.caution === 'number' && ship.caution > S.maxRung) S.maxRung = ship.caution;
        if (ship.rate) {
          const m = Math.max(Math.abs(ship.rate.p || 0), Math.abs(ship.rate.y || 0), Math.abs(ship.rate.r || 0));
          if (m > S.maxRate) S.maxRate = Math.round(m * 10) / 10;
        }
        if (ship.faults && ship.faults.forEach) ship.faults.forEach((_, code) => bump(S.faults, code));
      }
      const fv = window.__FV;
      if (fv) {
        if (fv.ac) { S.acState = fv.ac.state; S.acRate = Math.round(fv.ac.sampleRate || 0); }
        if (fv.buf) S.choirBuffers = Object.keys(fv.buf).length;
        if (fv.live) {
          const n = Object.keys(fv.live).length;
          if (n > S.voicesPeak) S.voicesPeak = n;
        }
      }
      const cs = document.getElementById('choirState');
      if (cs) S.choirState = (cs.textContent || '').slice(0, 120);

      const ac = g('AC');
      if (ac && audioOn === null) { audioOn = performance.now(); S.poweredAt = Math.round(audioOn - T0); }
      if (audioOn !== null && !g('muted')) S.audioMs = Math.round(performance.now() - audioOn);
      if (S.liveFallback === null && g('AC')) S.liveFallback = g('liveMode') === false;
    } catch { /* never let sampling break the deck */ }
  }
  setInterval(sample, 2000);

  /* ---- the things worth going looking for */
  function discoveries() {
    const d = {};
    const mark = (k, v) => { if (v) d[k] = 1; };
    try {
      mark('poweredUp', g('AC'));
      mark('flagsPulled', (g('tagsPulled') || 0) >= 3);
      mark('armed', g('armL') && g('armR'));
      mark('sequence', g('sequenceDone'));
      mark('mapExpanded', g('expanded'));
      mark('night', g('lightMode') === 2);
      const port = g('PORT');
      if (port) {
        mark('portholeSeen', S.strips.port !== undefined || S.strips.porthole !== undefined);
        mark('irisOpened', port.iris > 0.5);
        mark('blindPulled', port.blind > 0.5);
        mark('photoTaken', port.photos > 0);
      }
      mark('tumbleRecovered', S.maxRate > 6 && (g('SHIP') || {}).rate
        && Math.abs(((g('SHIP') || {}).rate || {}).y || 0) < 0.5);
      mark('cabinFroze', S.minCabin !== null && S.minCabin <= -10);
      mark('alarmReached', S.maxRung >= 3);
    } catch { /* ignore */ }
    return d;
  }

  /* ---- one transmission, on the way out */
  let sent = false;
  function send() {
    if (sent) return;
    sent = true;
    sample();
    if (S._closeStrips) S._closeStrips();
    const body = {
      v: 1,
      deck: S.deck,
      sessionSec: Math.round((performance.now() - T0) / 1000),
      audioSec: Math.round(S.audioMs / 1000),
      poweredAtSec: S.poweredAt === null ? null : Math.round(S.poweredAt / 1000),
      firstTouchSec: S.firstTouchMs === null ? null : Math.round(S.firstTouchMs / 1000),
      scrollStrips: S.scrollStrips,
      liveFallback: S.liveFallback,
      viewport: innerWidth < 700 ? 'small' : innerWidth < 1300 ? 'medium' : 'large',
      dpr: Math.round((devicePixelRatio || 1) * 10) / 10,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0,
      controls: S.controls,
      panels: S.panels,
      strips: S.strips,
      order: S.order,
      faults: S.faults,
      maxRung: S.maxRung,
      maxRate: S.maxRate,
      minCabin: S.minCabin === null ? null : Math.round(S.minCabin),
      maxCabin: S.maxCabin === null ? null : Math.round(S.maxCabin),
      found: discoveries(),
      errors: S.errors,
      wsDrops: S.wsDrops,
      assetFails: S.assetFails,
      acState: S.acState,
      acRate: S.acRate,
      choirBuffers: S.choirBuffers,
      choirState: S.choirState,
      voicesPeak: S.voicesPeak,
      ua: navigator.userAgent.slice(0, 120),
    };
    try {
      const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (blob.size <= 16000) navigator.sendBeacon('/beacon', blob);
    } catch { /* a failed beacon is not worth a thrown error on the way out */ }
  }

  // pagehide is the end of a visit. visibilitychange is not: it also fires
  // when someone switches tab for two seconds and comes back, and sending
  // there unconditionally truncated real visits and filed near-empty rows for
  // them. So pagehide always sends, visibilitychange only sends as the mobile
  // fallback for a tab that is backgrounded and never formally unloaded, and
  // only once there is a visit worth recording. An empty summary is dropped
  // rather than stored: it describes nothing and would drag every average down.
  const worthSending = () => Object.keys(S.controls).length > 0 || S.scrollStrips > 1
    || S.audioMs > 0 || Object.keys(S.panels).length > 0;
  addEventListener('pagehide', () => { if (worthSending()) send(); });
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (performance.now() - T0 > 30_000 && worthSending()) send();
  });
})();

/* ---- On-screen diagnostics, for a fault that only happens on someone else's
   phone. ?diag=1 pins a small readout to the corner showing what the audio
   graph is actually doing. Opt-in by URL, so it costs nothing for anyone who
   has not asked for it, and it reads the same values the beacon sends. */
(() => {
  'use strict';
  if (new URLSearchParams(location.search).get('diag') !== '1') return;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;max-width:94vw;'
    + 'background:rgba(4,7,13,.92);color:#93D8EC;border:1px solid #1B2836;border-radius:3px;'
    + 'font:11px/1.5 ui-monospace,Menlo,monospace;padding:7px 9px;white-space:pre;'
    + 'pointer-events:none;letter-spacing:.02em';
  const add = () => document.body && document.body.appendChild(el);
  if (document.body) add(); else addEventListener('DOMContentLoaded', add, { once: true });

  let frames = 0, fps = 0, lastT = performance.now();
  const tick = () => { frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => {
    const now = performance.now();
    fps = Math.round(frames * 1000 / (now - lastT));
    frames = 0; lastT = now;
  }, 1000);

  setInterval(() => {
    const fv = window.__FV || {};
    const ac = fv.ac;
    const cs = document.getElementById('choirState');
    const n = (o) => (o ? Object.keys(o).length : 0);
    el.textContent = [
      'state   ' + (ac ? ac.state : 'no context'),
      'rate    ' + (ac ? ac.sampleRate : '-') + '  out ' + (ac && ac.destination ? ac.destination.channelCount : '-') + 'ch',
      'time    ' + (ac ? ac.currentTime.toFixed(1) : '-') + 's',
      'buffers ' + n(fv.buf) + '/36',
      'voices  ' + n(fv.live),
      'fps     ' + fps,
      'choir   ' + ((cs && cs.textContent) || '-').slice(0, 42),
    ].join('\n');
  }, 500);
})();
