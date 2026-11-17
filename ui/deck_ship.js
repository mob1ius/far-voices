"use strict";
/* THE SHIP — caution and warning, cabin thermal, body rates.
 *
 * Steps 1 to 3 of the flight manual. Loaded after deck_cockpit.js, which is a
 * classic top-level script, so its globals (AP, apRect, coverRect, blip, flash,
 * ttyEnqueue, yaw, pitch, RHC, attHold, AC, muted, gVal, rdBusy, percT) are
 * visible here and assignable from here. Every reach into that file is guarded
 * with typeof, so this file degrades to nothing rather than breaking the deck
 * if the cockpit ever stops exporting one of them.
 *
 * No new art: every control this adds is drawn in CSS and placed relative to an
 * aperture the strips already carry, so it lands in the right place at any
 * width and survives a re-layout.
 */

const SHIP = {
  caution: 0,                    // 0 none · 1 caution · 2 warning · 3 master alarm
  faults: new Map(),             // code -> ms it was raised
  rate: { p: 0, y: 0, r: 0 },    // body rates, deg/s
  rcs: 100,                      // propellant, %
  cabinC: 21,                    // cabin temperature
  heater: true,
  rateMode: true,                // stick commands rates, not attitude
  silenceUntil: 0,
  highSince: 0,                  // when rates first went above the tumble limit
  autoDamp: false,
  dumps: 3,                      // momentum dumps left in the tape reels
  last: performance.now(),
  toneAt: 0,
  hasStrip: false,
  eventAt: performance.now(),
  timerAt: 0,
  placed: false,
};

// code -> label on the caution and warning panel
const SHIP_FAULTS = {
  BUS: 'MAIN BUS', THERM: 'CABIN TEMP', ATT: 'ATT RATES', RCS: 'RCS QTY',
  O2: 'O2 FLOW', NAV: 'NAV REF', COMM: 'DOWNLINK', GUID: 'PROG ALARM',
};
const TUMBLE = 6, RATE_CAUTION = 2, HOLD_LIMIT = 0.5;

const sq = (el, cls) => { const d = document.createElement(el); d.className = cls; return d; };
const shipEl = {};

/* ---------- sound. Its own small synth on the deck's AudioContext, so the
   alarm ladder never has to edit blip()'s switch. Silent until Power Up, like
   everything else, because AC does not exist before then. */
function shipSound(kind, vol) {
  if (typeof AC === 'undefined' || !AC || (typeof muted !== 'undefined' && muted)) return;
  const t = AC.currentTime, g = AC.createGain(); g.connect(AC.destination);
  vol = vol == null ? 1 : vol;
  const env = (a, len) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(a * vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len); };
  const tone = (f0, f1, len, at, type) => { const o = AC.createOscillator(); o.type = type || 'square';
    o.frequency.setValueAtTime(f0, t + (at || 0));
    if (f1 !== f0) o.frequency.linearRampToValueAtTime(f1, t + (at || 0) + len);
    o.connect(g); o.start(t + (at || 0)); o.stop(t + (at || 0) + len + 0.02); };
  switch (kind) {
    case 'warble':                                   // two-tone caution
      env(.18, .55); tone(740, 740, .12, 0); tone(494, 494, .12, .14);
      tone(740, 740, .12, .28); tone(494, 494, .12, .42); break;
    case 'chirp-good':                               // the rate is falling
      env(.1, .12); tone(660, 990, .12, 0, 'triangle'); break;
    case 'chirp-bad':                                // you are making it worse
      env(.1, .12); tone(660, 440, .12, 0, 'triangle'); break;
    case 'thud':                                     // a thruster pulse
      env(.12, .09); tone(190, 90, .09, 0, 'sine'); break;
    case 'cold': {                                   // metal contracting
      env(.05, .09); tone(2600 + Math.random() * 900, 1800, .05, 0, 'sine'); break; }
    case 'creak':
      env(.14, .9); tone(120, 70, .9, 0, 'sawtooth'); break;
    default: break;
  }
}

// Duck the choir under an alarm rather than silencing it. The choir is the point.
function shipDuck(db) {
  if (typeof bus === 'undefined' || !bus || !bus.gain || typeof AC === 'undefined' || !AC) return;
  const want = 0.9 * Math.pow(10, -db / 20);
  bus.gain.setTargetAtTime(want, AC.currentTime, 0.25);
}

/* ---------- faults and the ladder */
function shipFault(code, on) {
  if (on && !SHIP.faults.has(code)) {
    SHIP.faults.set(code, performance.now());
    SHIP.eventAt = performance.now();
    if (typeof ttyEnqueue === 'function') ttyEnqueue('', 'CAUTION - ' + SHIP_FAULTS[code]);
  } else if (!on && SHIP.faults.has(code)) {
    SHIP.faults.delete(code);
    SHIP.eventAt = performance.now();
    if (typeof ttyEnqueue === 'function') ttyEnqueue('', SHIP_FAULTS[code] + ' RESTORED');
  }
}

function shipRung(now) {
  const n = SHIP.faults.size;
  if (!n) return 0;
  const oldest = Math.min(...SHIP.faults.values());
  let rung = 1;
  if (n >= 2 || now - oldest > 20000) rung = 2;
  if (n >= 3) rung = 3;
  return rung;
}

function shipSilence() {
  if (!SHIP.faults.size) { flash('NO FAULTS'); return; }
  SHIP.silenceUntil = performance.now() + 30000;
  shipSound('thud', .5);
  flash('ALARM SILENCED · FAULT REMAINS');
  if (typeof ttyEnqueue === 'function') ttyEnqueue('', 'MASTER ALARM SILENCED - CONDITION UNCHANGED');
}

/* ---------- rates */
function shipRatesHigh() {
  const r = SHIP.rate;
  return Math.abs(r.p) > HOLD_LIMIT || Math.abs(r.y) > HOLD_LIMIT || Math.abs(r.r) > HOLD_LIMIT;
}
function shipRateMode() { return SHIP.rateMode; }
function shipMaxRate() {
  const r = SHIP.rate;
  return Math.max(Math.abs(r.p), Math.abs(r.y), Math.abs(r.r));
}
function shipThrust(axis, dir) {
  if (SHIP.rcs <= 0) { shipSound('thud', .2); flash('RCS DEPLETED'); return; }
  const before = shipMaxRate();
  SHIP.rate[axis] += dir * 0.2;
  SHIP.rcs = Math.max(0, SHIP.rcs - 0.1);
  shipSound('thud', .6);
  shipSound(shipMaxRate() < before ? 'chirp-good' : 'chirp-bad', .5);
  if (SHIP.rcs === 0 && typeof ttyEnqueue === 'function') ttyEnqueue('', 'RCS DEPLETED - USE REACTION WHEELS');
}
function shipDump() {                                  // the tape-reel momentum dump
  if (SHIP.rcs > 0) { flash('RCS AVAILABLE · REELS NOT REQUIRED'); return; }
  if (!SHIP.dumps) { flash('REELS AT REST'); return; }
  SHIP.dumps--;
  const ax = Math.abs(SHIP.rate.r) > Math.abs(SHIP.rate.y) ? 'r' : 'y';
  SHIP.rate[ax] -= Math.sign(SHIP.rate[ax]) * Math.min(1, Math.abs(SHIP.rate[ax]));
  flash('MOMENTUM DUMPED INTO THE REELS');
  if (typeof ttyEnqueue === 'function') ttyEnqueue('', 'REACTION WHEEL DUMP - ' + SHIP.dumps + ' REMAINING');
}

/* ---------- the per-frame tick, called from the cockpit's rAF loop */
function shipFrame(now) {
  const dt = Math.min(0.1, (now - SHIP.last) / 1000); SHIP.last = now;
  if (typeof AP === 'undefined' || !AP || !AP.apertures || !AP.apertures.hvacSw) return;
  if (!SHIP.placed) {
    try { shipBuild(); }
    catch (e) { console.error('shipBuild failed', e); SHIP.placed = true; }
  }

  const held = typeof RHC !== 'undefined' && RHC.held;
  const hold = typeof attHold !== 'undefined' && attHold;

  // stick -> rates, when the stick is in RATE mode and attitude hold is off
  if (held && !hold && SHIP.rateMode && SHIP.rcs > 0) {
    SHIP.rate.y += RHC.rx * 12 * dt;
    SHIP.rate.p += RHC.ry * 10 * dt;
    SHIP.rcs = Math.max(0, SHIP.rcs - 3 * dt);
  }
  if (hold) {                                          // attitude hold nulls what is left
    ['p', 'y', 'r'].forEach(a => { SHIP.rate[a] *= Math.max(0, 1 - 3 * dt); });
  }

  // rates -> the sky the whole deck is drawn from
  if (typeof yaw !== 'undefined' && (SHIP.rate.y || SHIP.rate.p)) {
    yaw += SHIP.rate.y * dt;
    pitch = Math.max(-80, Math.min(80, pitch - SHIP.rate.p * dt));
  }

  const mx = shipMaxRate();
  if (mx > TUMBLE) {
    if (!SHIP.highSince) SHIP.highSince = now;
    if (!SHIP.autoDamp && now - SHIP.highSince > 45000) {
      SHIP.autoDamp = true;
      flash('AUTO RATE DAMP ENGAGED');
      if (typeof ttyEnqueue === 'function') ttyEnqueue('', 'AUTO RATE DAMP ENGAGED - PROPELLANT EXPENDED');
    }
  } else { SHIP.highSince = 0; }
  if (SHIP.autoDamp) {
    ['p', 'y', 'r'].forEach(a => { const s = Math.sign(SHIP.rate[a]);
      SHIP.rate[a] -= s * Math.min(Math.abs(SHIP.rate[a]), 0.6 * dt); });
    SHIP.rcs = Math.max(0, SHIP.rcs - 2 * dt);
    if (shipMaxRate() < 0.4) { SHIP.autoDamp = false; SHIP.rate = { p: 0, y: 0, r: 0 }; flash('RATES NULLED'); }
  }
  document.body.classList.toggle('tumble', mx > TUMBLE);
  shipFault('ATT', mx > RATE_CAUTION);
  shipFault('RCS', SHIP.rcs < 10);

  /* ---------- cabin thermal */
  const fan = typeof fanOn !== 'undefined' && fanOn;
  // Heat on is a comfortable cabin; the fan makes it cold only with the heat
  // off. The microwave is what pushes the warm side, which is the joke.
  const oven = document.body.classList.contains('sag');
  const target = SHIP.heater ? (fan ? 19 : 22) + (oven ? 12 : 0) : (fan ? -18 : 4);
  const speed = SHIP.heater ? 0.22 : (fan ? 0.5 : 0.28);
  SHIP.cabinC += (target - SHIP.cabinC) * speed * dt * 0.6;
  SHIP.cabinC = Math.max(-20, Math.min(45, SHIP.cabinC));   // the sensor's range
  shipFault('THERM', SHIP.cabinC < 10);
  const frost = Math.max(0, Math.min(1, (10 - SHIP.cabinC) / 20));
  const sweat = Math.max(0, Math.min(1, (SHIP.cabinC - 30) / 8));
  document.documentElement.style.setProperty('--frost', frost.toFixed(3));
  document.documentElement.style.setProperty('--sweat', sweat.toFixed(3));
  document.body.classList.toggle('freezing', frost > 0.02);
  document.body.classList.toggle('frozen', SHIP.cabinC <= -10);
  document.body.classList.toggle('sweating', sweat > 0.02);
  if (typeof gVal !== 'undefined' && gVal) gVal[1] = SHIP.cabinC;   // the cabin thermometer, in Celsius
  if (frost > 0.2 && Math.random() < dt * (0.4 + frost)) shipSound('cold', 0.35);
  if (SHIP.cabinC <= -10 && !SHIP.frozenSaid) {
    SHIP.frozenSaid = true;
    if (typeof ttyEnqueue === 'function') ttyEnqueue('', 'CABIN FROZEN - CREW UNRESPONSIVE - HEAT TO RESTORE');
  }
  if (SHIP.cabinC > 0) SHIP.frozenSaid = false;

  /* ---------- the electrical bus, read from what is already running */
  const load = (document.body.classList.contains('sag') ? 1 : 0)
    + ((typeof rdBusy !== 'undefined' && rdBusy) ? 1 : 0)
    + ((typeof percT !== 'undefined' && percT) ? 1 : 0);
  const powered = typeof powerOn === 'undefined' || powerOn;
  shipFault('BUS', !powered || load >= 3);
  if (load >= 3 && Math.random() < dt * 0.6) document.body.classList.toggle('brownout', Math.random() < 0.5);

  /* ---------- the ladder */
  const rung = shipRung(now);
  const shown = now < SHIP.silenceUntil ? Math.max(0, rung - 1) : rung;
  if (shown !== SHIP.caution) {
    SHIP.caution = shown;
    document.body.classList.toggle('ship-caution', shown === 1);
    document.body.classList.toggle('ship-warning', shown === 2);
    document.body.classList.toggle('ship-alarm', shown >= 3);
    shipDuck(shown >= 3 ? 6 : shown === 2 ? 3 : 0);
  }
  if (shown && now > SHIP.toneAt && now > SHIP.silenceUntil) {
    SHIP.toneAt = now + (shown >= 3 ? 3000 : shown === 2 ? 4000 : 8000);
    if (shown >= 3) { if (typeof blip === 'function') blip('klaxon', 0.55); }
    else if (shown === 2) shipSound('warble', 0.8);
    else shipSound('warble', 0.35);
  }
  if (shown >= 3 && Math.random() < dt * 0.25) shipSound('creak', 0.4);

  shipPaint(now);
}

/* ---------- the instruments this adds, all CSS */
function shipPaint(now) {
  const r = SHIP.rate, fmt = v => (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(1).padStart(4, '0');
  if (shipEl.rate) {
    shipEl.rate.textContent = fmt(r.p) + '   ' + fmt(r.y) + '   ' + fmt(r.r);
    shipEl.rate.classList.toggle('hot', shipMaxRate() > RATE_CAUTION);
  }
  shipGauges();
  if (shipEl.lamps) {
    Object.keys(SHIP_FAULTS).forEach(code => {
      const el = shipEl.lamps[code];
      if (el) el.classList.toggle('lit', SHIP.faults.has(code));
    });
  }
  if (shipEl.fly) {
    const on = shipMaxRate() > HOLD_LIMIT;
    shipEl.fly.classList.toggle('on', on);
    if (on) {
      const k = 6;
      shipEl.fly.style.transform = 'translate(' + (-r.y * k).toFixed(1) + 'px,' + (r.p * k).toFixed(1) + 'px)';
    }
  }
  if (shipEl.mc) shipEl.mc.classList.toggle('lit', SHIP.caution >= 1);
  if (shipEl.ma) shipEl.ma.classList.toggle('lit', SHIP.caution >= 3);
  shipTimer(now);
}


/* The two faces in the ship-systems strip, drawn into the punched bezels. */
function shipGauges() {
  if (!SHIP.hasStrip || typeof fitCanvas !== 'function') return;
  const q = shipEl.rcsCv, t = shipEl.tempCv;
  if (q && q.style.width) {
    const W = parseFloat(q.style.width), H = parseFloat(q.style.height), x = fitCanvas(q, W, H);
    x.fillStyle = '#07080A'; x.fillRect(0, 0, W, H);
    const pad = H * 0.22, bw = (W - pad * 2) * SHIP.rcs / 100;
    x.fillStyle = SHIP.rcs < 25 ? '#E2622B' : '#4FA97A';
    x.shadowColor = x.fillStyle; x.shadowBlur = H * 0.3;
    x.fillRect(pad, H * 0.30, Math.max(bw, 1), H * 0.26);
    x.shadowBlur = 0;
    x.fillStyle = '#C9BFA8';
    x.font = '600 ' + Math.max(7, H * 0.2) + 'px "IBM Plex Mono",ui-monospace,monospace';
    x.textBaseline = 'top';
    x.fillText('RCS QTY', pad, H * 0.06);
    x.textAlign = 'right';
    x.fillText(SHIP.rcs.toFixed(0) + '%', W - pad, H * 0.06);
    x.textAlign = 'left';
    x.fillStyle = 'rgba(201,191,168,.55)';
    x.font = Math.max(6, H * 0.15) + 'px "IBM Plex Mono",ui-monospace,monospace';
    x.fillText(SHIP.rcs <= 0 ? 'DEPLETED - USE REELS' : SHIP.rcs < 25 ? 'REFILL BAND' : 'NOMINAL', pad, H * 0.66);
  }
  if (t && t.style.width) {
    const W = parseFloat(t.style.width), H = parseFloat(t.style.height), x = fitCanvas(t, W, H);
    x.fillStyle = '#07080A'; x.fillRect(0, 0, W, H);
    const c = SHIP.cabinC;
    const ink = c <= 0 ? '#A9D8F0' : c < 12 ? '#9FC8E6' : c > 30 ? '#FFC08A' : '#9FE6C0';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = ink; x.shadowColor = ink; x.shadowBlur = H * 0.12;
    x.font = '600 ' + Math.max(11, H * 0.34) + 'px "IBM Plex Mono",ui-monospace,monospace';
    x.fillText(c.toFixed(0) + '\u00B0C', W / 2, H * 0.44);
    x.shadowBlur = 0;
    x.fillStyle = 'rgba(201,191,168,.7)';
    x.font = Math.max(6, H * 0.13) + 'px "IBM Plex Mono",ui-monospace,monospace';
    x.fillText('CABIN', W / 2, H * 0.16);
    x.fillText(c <= -10 ? 'FROZEN' : c < 10 ? 'COLD' : c > 30 ? 'WARM' : 'NOMINAL', W / 2, H * 0.78);
  }
}

/* The event timer counts up from the last thing that happened, which is how a
   visitor discovers that the emergencies have stages at all. */
function shipTimer(now) {
  const cv = shipEl.timer;
  if (!cv || typeof fitCanvas !== 'function') return;
  if (now - (SHIP.timerAt || 0) < 200) return;              // five frames a second is plenty
  SHIP.timerAt = now;
  const w = parseFloat(cv.style.width) || 0, h = parseFloat(cv.style.height) || 0;
  if (w < 8) return;
  const x = fitCanvas(cv, w, h), R = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  const secs = Math.floor((now - (SHIP.eventAt || 0)) / 1000);
  x.clearRect(0, 0, w, h);
  // sweep hand: one turn a minute, the way a real elapsed-time clock reads
  const a = (secs % 60) / 60 * Math.PI * 2 - Math.PI / 2;
  x.strokeStyle = 'rgba(214,208,194,.22)'; x.lineWidth = Math.max(1, R * 0.03);
  for (let t = 0; t < 12; t++) {
    const ta = t / 12 * Math.PI * 2 - Math.PI / 2;
    x.beginPath();
    x.moveTo(cx + Math.cos(ta) * R * 0.82, cy + Math.sin(ta) * R * 0.82);
    x.lineTo(cx + Math.cos(ta) * R * 0.94, cy + Math.sin(ta) * R * 0.94);
    x.stroke();
  }
  x.strokeStyle = SHIP.caution >= 2 ? '#F0674F' : '#D6D0C2';
  x.lineWidth = Math.max(1.4, R * 0.05); x.beginPath();
  x.moveTo(cx, cy); x.lineTo(cx + Math.cos(a) * R * 0.78, cy + Math.sin(a) * R * 0.78); x.stroke();
  x.fillStyle = '#D6D0C2';
  x.font = '600 ' + Math.max(8, R * 0.34) + 'px "IBM Plex Mono",monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  const mm = String(Math.floor(secs / 60)).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
  x.fillText(mm + ':' + ss, cx, cy + R * 0.44);
}


/* ---------- what the printed checklist says about faults.
   Deliberately NOT in helpTopics(): the ? panel teaches the instruments, the
   checklist teaches the ship. paginate() appends these. */
function shipChecklist() {
  return [
    { sec: 'CAUTION AND WARNING', title: 'Reading the panel',
      body: 'Amber lamps on the flight panel name the system that is unhappy. One lamp is a caution. Two lamps, '
        + 'or one left alone for twenty seconds, is a warning. Three is a master alarm, with the klaxon. '
        + 'Pressing MASTER ALARM silences the tone for thirty seconds and nothing else: the lamp stays lit and '
        + 'the alarm returns until the cause is fixed.' },
    { sec: 'CAUTION AND WARNING', title: 'MAIN BUS',
      body: 'Main bus open or overloaded. Close the power switch on the footer. If it is already closed, stop one '
        + 'of the appliances drawing on it: food warmer, percolator, card reader. Running all three at once will '
        + 'brown the deck out.' },
    { sec: 'CAUTION AND WARNING', title: 'CABIN TEMP',
      body: 'Cabin below ten degrees. CABIN HEAT on, at the left of the guidance console; CABIN FAN off, on the '
        + 'footer. Then wait about a minute. Below freezing the glass ices over, and it still recovers. Heat on '
        + 'with the fan off and the food warmer running drives the other way, toward condensation.' },
    { sec: 'CAUTION AND WARNING', title: 'ATT RATES',
      body: 'Turning faster than two degrees per second. Push the hand controller against the rotation, watching '
        + 'the three numbers beside the abort guard fall toward zero, then trim with the four thruster buttons: '
        + 'each pulse removes two tenths. Under half a degree, ATT HOLD will engage and hold it there.' },
    { sec: 'CAUTION AND WARNING', title: 'RCS QTY',
      body: 'Propellant below ten percent. Stop using the stick. If it reaches zero, full rewind on the tape '
        + 'transport spins the reels and takes roughly a degree per second out of the ship, which is how reaction '
        + 'wheels work on the real thing.' },
    { sec: 'CAUTION AND WARNING', title: 'NAV REF and DOWNLINK',
      body: 'NAV REF means the attitude reference drifted: disengage ATT HOLD and stop winding the clocks. '
        + 'DOWNLINK means no spacecraft is in contact. That one is not yours to fix. The Deep Space Network is '
        + 'genuinely idle sometimes, and the lamp clears itself when the next pass begins.' },
    { sec: 'CAUTION AND WARNING', title: 'PROG ALARM',
      body: 'The guidance computer is complaining. PRO proceeds, RSET clears. Apollo 11 threw 1202 five times on '
        + 'the way down and landed anyway, because the computer was shedding work it did not need, exactly as '
        + 'designed.' },
  ];
}

/* Seconds until the ladder climbs again, or null when it is holding. */
function shipEscalateIn(now) {
  const n = SHIP.faults.size;
  if (!n || n >= 3) return null;
  if (n >= 2) return null;                       // already at warning
  const oldest = Math.min(...SHIP.faults.values());
  const left = 20000 - (now - oldest);
  return left > 0 ? Math.ceil(left / 1000) : null;
}

/* ---------- the instrument art.
   Each piece is a photographed panel cut from its green field; the live parts
   (lamps, the propellant bar, the rate numbers, the timer face) sit on top of
   it in boxes measured off the art itself, as fractions of the image, so they
   stay put at any scale. ASPECT is width/height of each file. */
const ART = {
  cw:    { src: 'overlay/cw_panel.webp',     aspect: 900 / 321 },
  ma:    { src: 'overlay/master_alarm.webp', aspect: 900 / 459 },
  rcs:   { src: 'overlay/rcs_gauge.webp',    aspect: 900 / 312 },
  rate:  { src: 'overlay/rate_bezel.webp',   aspect: 900 / 134 },
  timer: { src: 'overlay/event_timer.webp',  aspect: 876 / 900 },
  thr:   { src: 'overlay/thruster_pad.webp', aspect: 652 / 1091 },
  heatOn:  { src: 'overlay/heat_switch_on.webp',  aspect: 471 / 680 },
  heatOff: { src: 'overlay/heat_switch_off.webp', aspect: 472 / 680 },
};
// Where each lamp sits on the caution panel: six columns, two rows. The art
// engraves the legends, so the order here is the art's order, not ours.
const CW_COL = [0.115, 0.254, 0.393, 0.532, 0.670, 0.809], CW_W = 0.115;
const CW_ROW = [0.185, 0.535], CW_H = 0.20;
const CW_AT = { BUS: [0, 0], THERM: [1, 0], ATT: [2, 0], RCS: [3, 0], O2: [4, 0],
                GUID: [5, 0], NAV: [1, 1], COMM: [3, 1] };
const MA_LENS = { mc: [0.118, 0.185, 0.28, 0.55], ma: [0.615, 0.185, 0.28, 0.55] };
const RCS_WIN = [0.105, 0.355, 0.79, 0.135];
const RATE_WIN = [0.05, 0.25, 0.90, 0.34];
const TIMER_DIAL = [0.09, 0.05, 0.82, 0.75];
const THR_BTN = { 'p+1': [0.22, 0.12, 0.22, 0.125], 'p-1': [0.50, 0.12, 0.22, 0.125],
                  'y+1': [0.22, 0.285, 0.22, 0.125], 'y-1': [0.50, 0.285, 0.22, 0.125],
                  mode:  [0.34, 0.49, 0.28, 0.17] };

// Place a child box inside a parent rect using fractions of the parent.
function inBox(el, r, f) {
  if (!el) return;
  el.style.left = (r.x + r.w * f[0]) + 'px'; el.style.top = (r.y + r.h * f[1]) + 'px';
  el.style.width = (r.w * f[2]) + 'px'; el.style.height = (r.h * f[3]) + 'px';
}
function artImg(def, cls) {
  const im = new Image(); im.src = def.src; im.className = 'shipart ' + cls; im.alt = '';
  return im;
}

/* ---------- building and placing. Everything hangs off an aperture that
   already exists, so a resize re-places it with the rest of the deck. */
function shipBuild() {
  const deck = document.body;
  // Everything the ship adds is tagged .deckpart, which is what the expanded
  // map (and brownout, sag and night) dims and disables. Without it the
  // caution panel and the thruster pad stayed bright and clickable over a
  // full-screen star map while the rest of the deck faded out behind it.
  // Tagged at the END rather than in add(), because most of these elements
  // get `el.className = '...'` assigned a line or two after they are added,
  // which silently threw the class away again.
  const built = [];
  const add = el => { built.push(el); deck.appendChild(el); return el; };

  // caution and warning panel: the photograph, then one lamp per fault on top
  shipEl.cwImg = add(artImg(ART.cw, 'cw'));
  shipEl.lamps = {};
  Object.keys(SHIP_FAULTS).forEach(code => {
    const l = add(document.createElement('div'));
    l.className = 'cwlamp'; l.title = SHIP_FAULTS[code] + ' caution';
    shipEl.lamps[code] = l;
  });

  // master caution and master alarm: the photograph, with the two lenses live
  shipEl.maImg = add(artImg(ART.ma, 'ma'));
  shipEl.mc = add(document.createElement('button'));
  shipEl.mc.className = 'shipbtn'; shipEl.mc.title = 'Master caution — press to silence, the fault remains';
  shipEl.mc.setAttribute('aria-label', 'Master caution');
  shipEl.ma = add(document.createElement('button'));
  shipEl.ma.className = 'shipbtn'; shipEl.ma.title = 'Master alarm — press to silence, the fault remains';
  shipEl.ma.setAttribute('aria-label', 'Master alarm');
  [shipEl.mc, shipEl.ma].forEach(b => b.addEventListener('click', shipSilence));

  // rate readout under the ball
  shipEl.rateImg = add(artImg(ART.rate, 'rate'));
  shipEl.rate = add(document.createElement('div'));
  shipEl.rate.className = 'rateout'; shipEl.rate.title = 'Body rates, degrees per second';

  // the fly-to cross stays code-drawn: it moves, so it cannot be painted
  shipEl.fly = add(document.createElement('div'));
  shipEl.fly.className = 'flyto';

  // event timer: seconds since the last thing that happened
  shipEl.timerImg = add(artImg(ART.timer, 'timer'));
  shipEl.timer = add(document.createElement('canvas'));
  shipEl.timer.className = 'stripcv timerface';

  // thruster cluster: the photograph, with five transparent hit areas on it
  shipEl.thrImg = add(artImg(ART.thr, 'thr'));
  shipEl.thr = {};
  Object.keys(THR_BTN).forEach(k => {
    const b = add(document.createElement('button'));
    b.className = 'thrhit';
    if (k === 'mode') {
      b.title = 'Hand controller mode: rate command or direct attitude';
      b.setAttribute('aria-label', 'Hand controller mode');
      b.addEventListener('click', () => {
        SHIP.rateMode = !SHIP.rateMode;
        flash('HAND CONTROLLER · ' + (SHIP.rateMode ? 'RATE COMMAND' : 'DIRECT'));
        if (typeof blip === 'function') blip('flick');
      });
    } else {
      const axis = k[0], dir = Number(k.slice(1));
      b.title = 'Translation thruster ' + (dir > 0 ? '+' : '\u2212') + axis.toUpperCase()
        + ' — one pulse removes 0.2 deg/s';
      b.setAttribute('aria-label', 'Thruster ' + k);
      b.addEventListener('click', () => shipThrust(axis, dir));
    }
    b.addEventListener('keydown', e => { if (e.key === ' ') e.preventDefault(); });
    shipEl.thr[k] = b;
  });

  // Propellant and cabin temperature now live in the timer strip's own empty
  // bezels, drawn straight into the punched windows: no floating gauge art on
  // top of someone else's console, which is what caused every collision.
  shipEl.rcsCv = add(document.createElement('canvas'));
  shipEl.rcsCv.className = 'stripcv shipcv';
  shipEl.tempCv = add(document.createElement('canvas'));
  shipEl.tempCv.className = 'stripcv shipcv';

  // cabin heat: two photographs, one per position, and one hit area over them
  shipEl.heatOn = add(artImg(ART.heatOn, 'heat'));
  shipEl.heatOff = add(artImg(ART.heatOff, 'heat'));
  shipEl.heatOff.style.display = 'none';
  shipEl.heat = add(document.createElement('button'));
  shipEl.heat.className = 'thrhit'; shipEl.heat.title = 'CABIN HEAT';
  shipEl.heat.setAttribute('aria-label', 'Cabin heat');
  shipEl.heat.setAttribute('aria-pressed', 'true');
  shipEl.heat.addEventListener('click', () => {
    SHIP.heater = !SHIP.heater;
    shipEl.heat.setAttribute('aria-pressed', String(SHIP.heater));
    shipEl.heatOn.style.display = SHIP.heater ? '' : 'none';
    shipEl.heatOff.style.display = SHIP.heater ? 'none' : '';
    if (typeof blip === 'function') blip(SHIP.heater ? 'cr' : 'clunk');
    flash('CABIN HEAT ' + (SHIP.heater ? 'ON' : 'OFF'));
  });


  const frost = add(document.createElement('div'));
  frost.id = 'frostLayer'; frost.className = 'frostlayer';

  const rew = document.getElementById('tRew');
  if (rew) rew.addEventListener('click', () => { if (SHIP.rcs <= 0) shipDump(); });

  built.forEach(el => el.classList.add('deckpart'));
  SHIP.placed = true;      // last, so a failure part-way retries rather than leaving a half-built deck
  shipLayout();
  shipTest();
}

function shipLayout() {
  if (typeof apRect !== 'function' || typeof AP === 'undefined' || !AP || !AP.apertures) return;
  // A strip's after-hook can call this before the first frame has built the
  // ship, and then every shipEl is undefined. Throwing here killed the whole
  // module on load: SHIP.placed never became true, so no caution panel, no
  // thruster pad, no gauges, and nothing in the console to say why.
  if (!SHIP.placed || !shipEl.thr) return;
  const has = k => !!AP.apertures[k];
  const s = (typeof coverRect === 'function' ? coverRect().s : 1);

  /* Where these go was measured, not guessed. Each strip's artwork was scanned
     for panel areas with no painted hardware on them, because the first pass
     put gauges straight on top of the console's own instruments:
       guidance  a genuinely empty panel, 512 x 256 units at (128, 64)
       reader    a smaller empty panel, 192 x 126 at (320, 64)
       fdai      one free band, 330 x 60 at (2110, 320)
       footer    nothing free at all, which is why nothing lives there now
     Positions below are in each strip's OWN coordinates; strip() converts. */
  // AP.apertures holds MERGED deck coordinates: every strip's boxes have had
  // that strip's offset down the page added to them. The numbers above are in
  // each strip's own file, so the anchor has to come from that file too --
  // measuring a local point against a merged box put the first attempt a
  // whole console away.
  const strip = (json, anchor, lx, ly) => {
    if (!json || !json.apertures || !json.apertures[anchor] || !AP.apertures[anchor]) return null;
    const l = json.apertures[anchor], r = apRect(anchor);
    return { x: r.x + (lx - l[0]) * s, y: r.y + (ly - l[1]) * s };
  };
  const art = (el, def, origin, w) => {
    if (!el || !origin) return null;
    const W = w * s, H = W / def.aspect;
    el.style.left = origin.x + 'px'; el.style.top = origin.y + 'px';
    el.style.width = W + 'px'; el.style.height = H + 'px';
    el.removeAttribute('hidden');
    return { x: origin.x, y: origin.y, w: W, h: H };
  };

  // ---- guidance: the ship-systems cluster, on the empty panel left of the DSKY
  if (has('dskyDisp')) {
    const th = art(shipEl.thrImg, ART.thr, strip(typeof GUIDE !== 'undefined' ? GUIDE : null, 'dskyDisp', 140, 70), 120);
    Object.entries(THR_BTN).forEach(([k, box]) => inBox(shipEl.thr[k], th, box));

    const cw = art(shipEl.cwImg, ART.cw, strip(typeof GUIDE !== 'undefined' ? GUIDE : null, 'dskyDisp', 272, 70), 260);
    Object.entries(CW_AT).forEach(([code, [c, r]]) =>
      inBox(shipEl.lamps[code], cw, [CW_COL[c], CW_ROW[r], CW_W, CW_H]));

    const ma = art(shipEl.maImg, ART.ma, strip(typeof GUIDE !== 'undefined' ? GUIDE : null, 'dskyDisp', 272, 172), 160);
    inBox(shipEl.mc, ma, MA_LENS.mc);
    inBox(shipEl.ma, ma, MA_LENS.ma);

    const hs = art(shipEl.heatOn, ART.heatOn, strip(typeof GUIDE !== 'undefined' ? GUIDE : null, 'dskyDisp', 448, 172), 56);
    art(shipEl.heatOff, ART.heatOff, strip(typeof GUIDE !== 'undefined' ? GUIDE : null, 'dskyDisp', 448, 172), 56);
    inBox(shipEl.heat, hs, [0, 0, 1, 1]);
  }

  // ---- fdai: the rate readout, in the one free band on that strip
  if (has('fdai')) {
    const f = apRect('fdai');
    const rt = art(shipEl.rateImg, ART.rate, strip(typeof FDAI !== 'undefined' ? FDAI : null, 'fdai', 2110, 322), 330);
    inBox(shipEl.rate, rt, RATE_WIN);
    if (rt) shipEl.rate.style.fontSize = Math.max(8, rt.h * 0.42) + 'px';
    if (shipEl.fly) { const c = 44 * s;               // the fly-to cross stays on the ball
      shipEl.fly.style.left = (f.x + f.w / 2 - c / 2) + 'px'; shipEl.fly.style.top = (f.y + f.h / 2 - c / 2) + 'px';
      shipEl.fly.style.width = c + 'px'; shipEl.fly.style.height = c + 'px'; }
  }

  // ---- the ship-systems strip: its three bezels, in its own coordinates
  if (has('dial') && typeof TIMER !== 'undefined' && TIMER) {
    placeBox(shipEl.timer, apRect('dial'));
    placeBox(shipEl.rcsCv, apRect('spare1'));
    placeBox(shipEl.tempCv, apRect('spare2'));
    [shipEl.timer, shipEl.rcsCv, shipEl.tempCv].forEach(e => e && (e.style.display = ''));
    SHIP.hasStrip = true;
  }

  // Nothing is placed until the strip that owns it has loaded.
  if (shipEl.timerImg) shipEl.timerImg.style.display = 'none';
  if (!SHIP.hasStrip) [shipEl.timer, shipEl.rcsCv, shipEl.tempCv].forEach(e => e && (e.style.display = 'none'));
}

/* ---------- test entrances, in the spirit of ?eggs=fast. Nothing here is
   reachable without typing it into the address bar. */
function shipTest() {
  const q = new URLSearchParams(location.search).get('ship');
  if (!q) return;
  if (q === 'cold') { SHIP.heater = false; SHIP.cabinC = 6;
    if (shipEl.heat) shipEl.heat.classList.add('latched');
    if (typeof fanOn !== 'undefined' && !fanOn) { const h = document.getElementById('hvacSw'); if (h) h.click(); } }
  if (q === 'hot') { SHIP.cabinC = 31; }
  if (q === 'spin') { SHIP.rate = { p: 1.2, y: 7.5, r: 2.4 }; }
  if (q === 'faults') { ['BUS', 'NAV', 'COMM'].forEach(c => shipFault(c, true)); }
  if (q === 'dry') { SHIP.rcs = 4; SHIP.rate = { p: 0, y: 3.2, r: 0 }; SHIP.dumps = 3; }
  flash('SHIP TEST · ' + q.toUpperCase());
}

let shipRelayout = null;
addEventListener('resize', () => { clearTimeout(shipRelayout); shipRelayout = setTimeout(shipLayout, 120); });
