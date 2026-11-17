"use strict";
/* BANNERS — every touchable thing on the deck says something.
 *
 * Loaded after deck_cockpit.js, deck_ship.js and deck_porthole.js. It listens
 * on the document in the capture phase, works out which control was touched,
 * and shows a banner: what the thing is, what it did, a piece of history, a
 * nudge toward the next thing, or a joke if you keep hitting it.
 *
 * Copy rules, so this stays worth reading:
 *   - say something TRUE about real hardware wherever there is something true
 *     to say; the Apollo and Soyuz details here are all real;
 *   - hints point at another console by name and direction, because the deck
 *     is six thousand pixels tall and nobody knows what is below them;
 *   - jokes are for the fourth press, not the first;
 *   - an alarm never jokes: it says what is wrong and what fixes it.
 */

const BAN = { el: null, label: null, text: null, until: 0, lastKey: '', lastAt: 0,
  runs: new Map(), said: new Set(), clicks: [], alarmAt: 0, lastFaults: '' };

const BANNER_MS = { hint: 4200, lore: 5200, joke: 4000, warn: 6000, act: 7000 };

function bannerInit() {
  const b = document.createElement('div');
  b.id = 'banner'; b.setAttribute('role', 'status'); b.setAttribute('aria-live', 'polite');
  b.innerHTML = '<span class="blabel"></span><span class="btext"></span>';
  document.body.appendChild(b);
  BAN.el = b; BAN.label = b.querySelector('.blabel'); BAN.text = b.querySelector('.btext');
  document.addEventListener('pointerdown', bannerClick, true);
}

function banner(kind, label, text) {
  if (!text) return;
  advPush(label, text, kind);
  if (advReady()) { if (BAN.el) BAN.el.classList.remove('on'); return; }   // the strip has it
  if (!BAN.el) return;
  // Always show the newest thing. An earlier version queued banners so each
  // got its full four seconds, which meant someone poking at three controls in
  // five seconds only ever saw the first one -- the deck looked broken and the
  // other two lines were thrown away. Whatever you just touched wins.
  if (BAN.el.classList.contains('on') && BAN.text.textContent === text) return;
  BAN.el.className = 'on ' + kind;
  BAN.label.textContent = label;
  BAN.text.textContent = text;
  BAN.until = performance.now() + (BANNER_MS[kind] || 4200);
  clearTimeout(BAN.t);
  BAN.t = setTimeout(() => BAN.el.classList.remove('on'), BANNER_MS[kind] || 4200);
}


/* ---------- the advisory readout.
   The strip below the hand controller is an amber alphanumeric display. Every
   banner goes here and scrolls slowly upward, the way a real message readout
   works, instead of appearing over the deck and vanishing. The floating banner
   stays only as a fallback for the moment before this strip has loaded. */
const ADV = { cv: null, lines: [], scroll: 0, target: 0, last: performance.now(), cursor: 0 };
const ADV_KEEP = 60;

function advReady() { return !!(ADV.cv && typeof AP !== 'undefined' && AP && AP.apertures && AP.apertures.advScreen); }

function advInit(json) {
  ADV.json = json;
  if (ADV.cv) return;
  const cv = document.createElement('canvas');
  cv.id = 'advCv'; cv.className = 'stripcv'; cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  ADV.cv = cv;
  advPush('SYSTEMS', 'Advisory readout online. Touch anything on this deck and it will tell you what it is.', 'hint');
  advLayout();
}

function advLayout() {
  if (!advReady() || typeof placeBox !== 'function') return;
  placeBox(ADV.cv, apRect('advScreen'));
}

const ADV_CLEAN = t => String(t).replace(/[\u2014\u2013]/g, '-').replace(/\u00b7/g, '\u00b7');

function advPush(label, text, kind) {
  // The readout is a 1960s alphanumeric display: it has hyphens, not em dashes.
  ADV.lines.push({ label: ADV_CLEAN(label), text: ADV_CLEAN(text), kind: kind || 'hint', at: performance.now() });
  if (ADV.lines.length > ADV_KEEP) ADV.lines.splice(0, ADV.lines.length - ADV_KEEP);
  ADV.wrapped = null;
}

const ADV_INK = { hint: '#F0A81E', lore: '#E8C070', joke: '#FFD98A', warn: '#FF9A3C', act: '#FF6A4A' };

function advDraw(now) {
  if (!advReady() || typeof fitCanvas !== 'function') return;
  const r = apRect('advScreen');
  if (!r.w) return;
  const x = fitCanvas(ADV.cv, r.w, r.h), W = r.w, H = r.h;
  const fs = Math.max(9, H * 0.155), lh = fs * 1.36, padY = lh * 0.42;
  x.font = fs + 'px "IBM Plex Mono",ui-monospace,monospace';
  const cols = Math.max(20, Math.floor((W - fs * 1.4) / x.measureText('M').width));

  if (!ADV.wrapped) {                                   // re-wrap only when the log changes
    ADV.wrapped = [];
    ADV.lines.forEach(l => {
      const words = (l.label + ' \u00b7 ' + l.text).toUpperCase().split(' ');
      let cur = '';
      words.forEach(w => {
        if (cur && (cur + ' ' + w).length > cols) { ADV.wrapped.push({ s: cur, kind: l.kind }); cur = w; }
        else cur = cur ? cur + ' ' + w : w;
      });
      if (cur) ADV.wrapped.push({ s: cur, kind: l.kind });
      ADV.wrapped.push({ s: '', kind: l.kind });
    });
  }
  const rows = ADV.wrapped.length;
  const visible = (H - padY * 2) / lh;
  ADV.target = Math.max(0, rows - visible + 0.4);
  const dt = Math.min(0.1, (now - ADV.last) / 1000); ADV.last = now;
  const step = Math.min(Math.abs(ADV.target - ADV.scroll), dt * 1.1);   // about a line a second
  ADV.scroll += Math.sign(ADV.target - ADV.scroll) * step;

  x.fillStyle = '#07080A'; x.fillRect(0, 0, W, H);
  x.textBaseline = 'top';
  const top = padY - ADV.scroll * lh;
  ADV.wrapped.forEach((l, i) => {
    const y = top + i * lh;
    if (y < -lh || y > H) return;
    // phosphor fade: the top line of the window is always on its way out
    const fade = Math.max(0.25, Math.min(1, (y + lh) / (lh * 1.6)));
    x.globalAlpha = fade;
    x.fillStyle = ADV_INK[l.kind] || ADV_INK.hint;
    x.fillText(l.s, fs * 0.7, y);
    x.globalAlpha = 1;
  });
  // cursor on the last line
  if (Math.abs(ADV.target - ADV.scroll) < 0.02) {
    const y = top + (rows - 1) * lh;
    if (((now / 600) | 0) % 2 === 0 && y > -lh && y < H) {
      x.fillStyle = ADV_INK.hint;
      x.fillRect(fs * 0.7, y + fs * 0.15, fs * 0.58, fs * 0.9);
    }
  }
  // Mask the top and bottom edges: a line half-scrolled past the window should
  // fade out behind the bezel, not be sliced through the middle of its glyphs.
  const gTop = x.createLinearGradient(0, 0, 0, padY * 1.6);
  gTop.addColorStop(0, '#07080A'); gTop.addColorStop(1, 'rgba(7,8,10,0)');
  x.fillStyle = gTop; x.fillRect(0, 0, W, padY * 1.6);
  const gBot = x.createLinearGradient(0, H - padY * 1.6, 0, H);
  gBot.addColorStop(0, 'rgba(7,8,10,0)'); gBot.addColorStop(1, '#07080A');
  x.fillStyle = gBot; x.fillRect(0, H - padY * 1.6, W, padY * 1.6);

  // a faint scanline wash, because the glass is not perfect
  x.globalAlpha = 0.08; x.fillStyle = '#000';
  for (let yy = 0; yy < H; yy += 3) x.fillRect(0, yy, W, 1);
  x.globalAlpha = 1;
}

/* ---------- what each control says.
   first: the first press. lore: rotates after that. mash: 4th, 7th, 12th press
   in a row. hint: appended by seqHint() when the deck knows what you need. */
const BANNERS = {
  // ---- footer and power
  powerSw: { label: 'MAIN BUS A', first: 'Main bus A. Everything on this deck runs through it, including the teleprinter and the pens.',
    lore: ['Apollo had three fuel cells feeding two buses. Losing one was survivable. Losing both was Apollo 13.',
           'With the bus open the deck runs on residual power: instruments fade, the printer stops mid-line.'],
    mash: ['The bus is not a light switch.', 'Every cycle browns out an instrument. One of them will stick.',
           'You are going to break something, and honestly, good.'] },
  hvacSw: { label: 'CABIN FAN', first: 'Cabin fan. Moving air is the only way heat leaves a body in free fall — still air will cook you sitting down.',
    lore: ['With the fan on, anything not held down starts drifting. Velcro was flown for exactly this reason.',
           'Fan on plus cabin heat off is how you freeze this ship. That is not a warning, it is an invitation.'] },
  heatSw: { label: 'CABIN HEAT', first: 'Cabin heat. Space is not cold like a freezer; it is empty. The ship radiates warmth away and never gets any back.',
    lore: ['Below 10 °C the caution lights. Below zero the glass frosts over. At −10 everything stops.',
           'Heat on with the fan off and the microwave running goes the other way: the deck starts to sweat.'] },

  // ---- guidance
  dsky: { label: 'DSKY', first: 'The guidance computer keypad. Verb is what to do, noun is what to do it to. V37E is "change program".',
    lore: ['4 KB of erasable memory and 72 KB of rope core, woven by hand at Raytheon by women who could not be paid to make a mistake.',
           'Try V16 N36 for mission time, or V35E to test every lamp on the panel.',
           'V37E 63E flies the descent program. It will also throw the 1202 alarm, exactly as it did in 1969.'],
    mash: ['The computer is buffering. It managed this in 1969 too.',
           'Ten keys in a second and a half raises a program alarm. That is authentic, not a bug.',
           'Armstrong got 1202 four times on final approach and landed anyway. You have no such excuse.'] },
  rhcGrip: { label: 'HAND CONTROLLER', first: 'The stick commands turning rates, not headings. Let go and the ship keeps turning — nothing out here slows it down.',
    lore: ['Read the three numbers under the attitude ball: pitch, yaw, roll, in degrees per second.',
           'Push against the spin, then tap the thruster buttons to trim the last half degree.'],
    mash: ['Every nudge spends propellant you cannot get back.', 'This is how spins start.'] },
  attHoldSw: { label: 'ATT HOLD', first: 'Attitude hold freezes the ship where it is pointing. It refuses to engage above half a degree per second.',
    lore: ['Hold engaged, the glass stops answering the drag and the stick goes inert. That is the ship flying, not you.'] },
  thruster: { label: 'THRUSTER', first: 'One pulse removes exactly 0.2 degrees per second and 0.1% of the propellant. Fine trim only.',
    lore: ['Follow the green cross on the attitude ball: it points where to push.',
           'At zero propellant the only thing left is the tape reels. Spin them and the ship turns the other way.'],
    mash: ['Every tap is gas overboard.', 'There is a gauge on the card reader console telling you how little is left.'] },

  // ---- flight director
  abortBtn: { label: 'ABORT', first: 'Abort. Guarded, and for good reason. The guard opens only with all three flags pulled and both arming switches up.',
    lore: ['On Apollo this handle would fire the escape tower and take the crew off the stack in under a second.'],
    mash: ['It is under a guard precisely so this cannot happen.'] },
  abortGuard: { label: 'ABORT GUARD', first: 'The guard. Red flip-covers exist because a switch you can nudge is a switch someone will nudge.' },
  clkknob: { label: 'STATION CLOCK', first: 'Drag a clock knob sideways to wind time. The globe turns under a moving sun and the tape library runs to that hour.',
    lore: ['Let go and it loads the hour you landed on — real sky from that moment, sung again.',
           'The counters below the globe show how far back you have gone: days, then hours.'] },
  masterAlarm: { label: 'MASTER ALARM', first: 'Silences the noise for thirty seconds. It does not fix anything, and the lamp stays lit.',
    lore: ['Quieting an alarm and repairing a spacecraft are different jobs. Only one counts.'],
    mash: ['Third time and the ship stops telling you things at all.'] },

  // ---- tape and archive
  transport: { label: 'TAPE TRANSPORT', first: 'The archive plays back recorded hours. Voyager-era craft really did record telemetry to tape and play it down later.',
    lore: ['Reels turning means you are hearing a past hour. Still reels mean live sky.',
           'Full rewind for ten seconds dumps momentum into the reels — the last way to stop a spin.'] },
  rotary: { label: 'ROTARY SELECTOR', first: 'The dual-concentric knob. Outer ring picks the moment, inner one steps through it.' },
  spine: { label: 'TAPE LIBRARY', first: 'One reel per hour of sky. Pull a spine and that hour loads.',
    lore: ['The date window and the day buttons on the right page through everything the recorder has kept.'],
    mash: ['They go back in one at a time, like a real library.'] },
  slideFwd: { label: 'SLIDE PROJECTOR', first: 'Every spacecraft the deck can hear has a photograph and a short history in this carousel.',
    lore: ['Photograph the lower porthole with the camera in the stowage net and your frame lands in this tray.'] },
  discBtn: { label: 'GOLDEN RECORD', first: 'The Voyager record: greetings in 55 languages, whale song, and a Bach prelude, now 24 billion kilometres out.',
    lore: ['Play it while the choir is holding a cadence and the two of them will agree for one phrase.'] },

  // ---- comms
  ttyKbd: { label: 'TELEPRINTER', first: 'Type a spacecraft name and press Enter. The archive turns to its slide and the antenna hearing it pulses.',
    lore: ['A Model 33 printed at ten characters a second and could be heard through a closed door.',
           'Type HELLO if you want to see whether anyone is home.'] },
  rbf: { label: 'REMOVE BEFORE FLIGHT', first: 'Flags like this hang off every safety pin on a real pad crew\'s checklist. Pull them all before flight — that is the whole point of them.',
    lore: ['Three pulled, both arming switches up, and the abort guard will open.'] },
  armSw: { label: 'ARM', first: 'Arming switch. Two of them, deliberately far apart, so no single hand can do it alone.' },
  hereIs: { label: 'HERE IS', first: 'The answer-back key. Press it and the machine identifies itself, the way every teleprinter on earth once did.' },

  // ---- crew and galley
  jar: { label: 'LUCKY PEANUTS', first: 'JPL has opened a jar of peanuts before every critical event since Ranger 7 finally worked in 1964, after six straight failures.',
    lore: ['This jar opens itself whenever a dish locks onto a spacecraft.'],
    mash: ['Ration discipline.', 'That is the third time. There are other people on this ship.'] },
  percBtn: { label: 'PERCOLATOR', first: 'Coffee, in a machine that cannot pour. Skylab drank it from a bag; Apollo rehydrated it and regretted it.',
    lore: ['Brew with the fan running and it will escape as a slow brown blob and cross the deck.'] },
  mwStart: { label: 'FOOD WARMER', first: 'Running it sags the whole deck for twenty seconds — one electrical bus, and this is the biggest thing on it.',
    lore: ['It also warms the cabin. Run it with the heat on and the windows start to sweat.'] },
  pencilItem: { label: 'PENCIL', first: 'NASA did not spend millions on a space pen. Fisher developed it privately; NASA bought them for about six dollars each.',
    lore: ['Put the pencil and the card back in their holders after pulling all three flags. Everything floating tidies itself away.'] },

  // ---- navigation
  globusKnob: { label: 'ГЛОБУС', first: 'A clockwork globe. Vostok and Soyuz carried one so the crew could see where they were without asking the ground.',
    lore: ['This one shows where the antennas are pointing. The drums beneath count days and hours of wound time.'] },
  cardFace: { label: 'SPACECRAFT FILE', first: 'The card file flips to whatever is being heard right now. Range, round-trip light time, and who is tracking it.',
    lore: ['Two and a half hours of round-trip light time to Voyager 1. You cannot have a conversation at that distance.'] },

  // ---- score and reader
  chartSpeed: { label: 'SCORE RECORDER', first: 'The pens are drawing the music as it happens, one colour per voice.',
    lore: ['Lift the pen during an emergency and there will be no record of it. Housekeeping, or a cover-up.'] },
  rdStart: { label: 'CARD READER', first: 'Punched cards, read at a few hundred a minute. The deck in the hopper is a real corpus of Russian chant.',
    lore: ['Run it with an empty hopper and the computer will tell you off in the manner of 1969.'] },

  // ---- porthole
  portCv: { label: 'OBSERVATION PORT', first: 'The lower window looks ninety degrees off the nose. Drag to lean, hold to open the iris, double-tap to swing toward whatever is being heard.',
    lore: ['Something drifts past every few minutes. Tap it before it goes.',
           'Apollo crews kept mistaking vented ice crystals for stars. You will too.'] },
  portCam: { label: 'CAMERA', first: 'Photographs the window and files the frame in the archive projector, stamped with the time.' },
  portPull: { label: 'BLIND', first: 'Pull it down for quiet and dark. You will miss whatever goes past while it is closed.' },
};

/* Generic lines when a control has nothing of its own to say. */
const GENERIC_MASH = ['It is a switch. It has told you everything it knows.',
  'Repeating an input does not make the spacecraft agree with you.',
  'Somewhere a flight controller is writing your name down.',
  'This is how the 1202 alarm happened, broadly speaking.'];

/* ---------- what the ship needs next, in one line */
function seqHint() {
  if (typeof tagsPulled === 'undefined') return '';
  const flags = 3 - (tagsPulled || 0);
  const arms = (typeof armL !== 'undefined' && armL ? 1 : 0) + (typeof armR !== 'undefined' && armR ? 1 : 0);
  if (typeof sequenceDone !== 'undefined' && sequenceDone) return '';
  if (flags > 0) return 'Launch sequence: ' + flags + ' flag' + (flags > 1 ? 's' : '') + ' still to pull, on the comms console below.';
  if (arms < 2) return 'Launch sequence: flags clear. Both ARM switches on the comms console still down.';
  if (typeof attHold !== 'undefined' && attHold) return 'Launch sequence: armed and clear. Attitude hold must be off.';
  return 'Launch sequence: armed and clear. The guidance computer wants V37E 63E.';
}

/* ---------- which control was touched */
function bannerKey(el) {
  if (!el || !el.closest) return null;
  const node = el.closest('button,canvas,img,div[id],[data-ap]');
  if (!node) return null;
  const id = node.id || '';
  if (BANNERS[id]) return id;
  if (/^clkknob/.test(id)) return 'clkknob';
  if (/^rbf\d/.test(id)) return 'rbf';
  if (/^arm[LR]$/.test(id)) return 'armSw';
  if (id === 'jarWin' || id === 'jarImg') return 'jar';
  if (/^(tRew|tStop|tPlay|tFf)$/.test(id)) return 'transport';
  if (/^rot(Inner|Outer)$/.test(id)) return 'rotary';
  if (/^(slideFwd|slideRev)$/.test(id)) return 'slideFwd';
  if (/^(penLift|chartSpeed|rotSel|sSpeed|sPen)/.test(id)) return 'chartSpeed';
  if (/^(rdStart|rdStop|rdReset)$/.test(id)) return 'rdStart';
  if (/^(attHoldSw|attHoldSw2)$/.test(id)) return 'attHoldSw';
  if (/^(heatSw)$/.test(id)) return 'heatSw';
  const cls = node.className && node.className.baseVal !== undefined ? '' : String(node.className || '');
  if (/\bdkey\b/.test(cls)) return 'dsky';
  if (/\bthrhit\b/.test(cls)) return node.getAttribute('aria-label') === 'Cabin heat' ? 'heatSw' : 'thruster';
  if (/\bshipbtn\b/.test(cls)) return 'masterAlarm';
  if (/\bspine\b/.test(cls)) return 'spine';
  if (/\begg\b|\bfloater\b/.test(cls)) return 'egg';
  if (node.dataset && node.dataset.ap && BANNERS[node.dataset.ap]) return node.dataset.ap;
  return null;
}

function bannerClick(e) {
  const key = bannerKey(e.target);
  const now = performance.now();
  BAN.clicks = BAN.clicks.filter(t => now - t < 60000);
  BAN.clicks.push(now);
  if (!key) return;

  const run = BAN.runs.get(key) || { n: 0, at: 0 };
  run.n = (now - run.at < 1600) ? run.n + 1 : 1;
  run.at = now;
  BAN.runs.set(key, run);

  const def = BANNERS[key];
  if (!def) return;

  // mashing: the fourth, seventh and twelfth press in a row
  if (run.n >= 4) {
    const pool = def.mash && def.mash.length ? def.mash : GENERIC_MASH;
    const idx = run.n >= 12 ? 2 : run.n >= 7 ? 1 : 0;
    banner('joke', def.label, pool[Math.min(idx, pool.length - 1)]);
    return;
  }

  // first press: what it is. after that: history, then a hint about what next.
  const seen = BAN.said.has(key);
  if (!seen) {
    BAN.said.add(key);
    banner('hint', def.label, def.first);
    return;
  }
  const lore = def.lore || [];
  const hint = seqHint();
  if (lore.length && (run.n % 2 === 1 || !hint)) {
    const i = (BAN.runs.get(key).lore = ((BAN.runs.get(key).lore || 0) + 1) % lore.length);
    banner('lore', def.label, lore[i]);
  } else if (hint) {
    banner('hint', 'NEXT', hint);
  } else {
    banner('lore', def.label, def.first);
  }
}

/* ---------- alarms speak for themselves, and never joke */
const FAULT_HELP = {
  BUS: ['MAIN BUS', 'Main bus open or overloaded. Close the power switch on the footer, or stop one of the appliances drawing on it.'],
  THERM: ['CABIN TEMP', 'Cabin below 10 °C. CABIN HEAT on, at the left of the guidance console. CABIN FAN off, on the footer. About a minute to come back.'],
  ATT: ['ATT RATES', 'Turning faster than 2 °/s. Push the stick against the spin, then trim with the thruster buttons until the rate readout beside the abort guard reads zero.'],
  RCS: ['RCS QTY', 'Propellant below 10%. Stop using the stick. Full rewind on the tape transport dumps momentum into the reels.'],
  O2: ['O2 FLOW', 'Oxygen flow high. Close whatever you opened.'],
  NAV: ['NAV REF', 'Attitude reference lost. Disengage attitude hold, then stop winding the globe.'],
  COMM: ['DOWNLINK', 'No spacecraft in contact. Nothing you did. The sky is genuinely quiet sometimes. It will come back.'],
  GUID: ['PROG ALARM', 'Guidance computer alarm. Press PRO to proceed, or RSET to clear it.'],
};

/* While the ship is unhappy the guidance-computer readout on the main console
   stops reporting music and reports the fault instead, with a clock: how long
   until the ladder climbs, or how long the klaxon stays silenced. A readout
   that keeps showing chord names through a master alarm is a readout nobody
   believes. */
function alarmHud(now) {
  if (typeof SHIP === 'undefined' || typeof apRect !== 'function') return;
  let h = BAN.hud;
  if (!h) {
    h = BAN.hud = document.createElement('div');
    h.id = 'alarmHud'; h.setAttribute('aria-hidden', 'true');
    h.innerHTML = '<span class="ah1"></span><span class="ah2"></span><span class="ah3"></span>';
    document.body.appendChild(h);
  }
  const on = SHIP.caution >= 2 && AP && AP.apertures && AP.apertures.termB;
  document.body.classList.toggle('alarmhud', !!on);
  h.classList.toggle('on', !!on);
  h.classList.toggle('red', SHIP.caution >= 3);
  if (!on) return;
  const r = apRect('termB');
  h.style.left = (r.x + 10) + 'px'; h.style.top = (r.y + 10) + 'px';
  h.style.width = (r.w - 20) + 'px'; h.style.height = (r.h - 20) + 'px';
  h.style.fontSize = Math.max(8, r.h * 0.105) + 'px';

  const first = [...SHIP.faults.keys()][0];
  const help = FAULT_HELP[first] || ['FAULT', ''];
  const silent = Math.max(0, Math.ceil((SHIP.silenceUntil - now) / 1000));
  const climb = typeof shipEscalateIn === 'function' ? shipEscalateIn(now) : null;
  const n = SHIP.faults.size;
  h.querySelector('.ah1').textContent = (SHIP.caution >= 3 ? 'MASTER ALARM' : 'WARNING') + ' \u00b7 ' + help[0];
  // The readout is a small window: it gets the first sentence, the banner and
  // the printed checklist carry the rest.
  h.querySelector('.ah2').textContent = help[1].split('. ')[0] + '.';
  h.querySelector('.ah3').textContent = silent ? 'KLAXON SILENCED - RETURNS IN ' + silent + ' S'
    : climb ? 'ESCALATES IN ' + climb + ' S'
    : n > 1 ? n + ' FAULTS \u00b7 CLEAR ONE TO STEP DOWN'
    : 'HOLDING \u00b7 CLEAR THE FAULT TO SILENCE IT';
}

function bannerAlarms(now) {
  alarmHud(now);
  if (typeof SHIP === 'undefined' || !BAN.el) return;
  const key = [...SHIP.faults.keys()].sort().join(',');
  if (key !== BAN.lastFaults) {
    const added = [...SHIP.faults.keys()].filter(f => !BAN.lastFaults.split(',').includes(f));
    BAN.lastFaults = key;
    BAN.alarmAt = now;
    if (added.length) {
      const h = FAULT_HELP[added[0]];
      const climb = typeof shipEscalateIn === 'function' ? shipEscalateIn(now) : null;
      if (h) banner(SHIP.caution >= 3 ? 'act' : 'warn', h[0],
        h[1] + (climb ? '  Twenty seconds to the next level: ' + climb + ' s left.' : ''));
    } else if (!key) {
      banner('hint', 'ALL CLEAR', 'Every fault cleared. The ship is nominal.');
    }
    return;
  }
  // still unhappy: say it again, but not often enough to be nagging
  if (key && now - BAN.alarmAt > 25000) {
    BAN.alarmAt = now;
    const first = key.split(',')[0], h = FAULT_HELP[first];
    const silent = SHIP.silenceUntil > now;
    if (h) banner(SHIP.caution >= 3 ? 'act' : 'warn', h[0],
      silent ? 'Silenced, not fixed. ' + h[1] : h[1]);
  }
}

function bannerFrame(now) {
  advDraw(now);
  // Once the flags are clear the two arming switches are the next thing to
  // find, and they are small and sit on the seam between two strips. Ring them.
  if (typeof tagsPulled !== 'undefined') {
    const want = tagsPulled >= 3 && !(typeof sequenceDone !== 'undefined' && sequenceDone);
    const L = document.getElementById('armL'), R = document.getElementById('armR');
    if (L) L.classList.toggle('needed', want && typeof armL !== 'undefined' && !armL);
    if (R) R.classList.toggle('needed', want && typeof armR !== 'undefined' && !armR);
    if (want && !BAN.said.has('__arms')) {
      BAN.said.add('__arms');
      banner('hint', 'ARMING', 'Flags clear. Both ARM switches are on the comms console, at the very top edge: '
        + 'one to the right of the teleprinter, one at the far right by the flight checklist. Both up, then the abort guard opens.');
    }
  }
  if (!BAN.el) return;
  bannerAlarms(now);
  // an hour of button-pushing deserves one acknowledgement
  if (BAN.clicks.length >= 40 && !BAN.said.has('__busy')) {
    BAN.said.add('__busy');
    banner('joke', 'FLIGHT SURGEON', 'Forty inputs in a minute. Your heart rate is noted and your enthusiasm is on record.');
  }
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', bannerInit);
else bannerInit();

let advRelayout = null;
addEventListener('resize', () => { clearTimeout(advRelayout); advRelayout = setTimeout(advLayout, 120); });
