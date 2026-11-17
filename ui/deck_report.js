"use strict";
/* GROUND REPORT — the weekly sky report, received on the teleprinter.

   Loaded after deck_cockpit.js and deck_banners.js. The hub sends the
   standing report on every /live connect (live:false) and broadcasts a new
   one the moment ground pushes it (live:true). Either way the teleprinter
   types a short announcement -- its strip is five lines tall and its queue
   keeps eight, so the body never goes through it -- and the printout becomes
   something you can tear off and read.

   The reader is a TWX sheet: canary paper, tractor-feed margins, the message
   header a real teletype circuit would print. Readability wins wherever it
   conflicts with the period: the machine printed uppercase only, so headers
   are uppercase and the body is set in mixed case, large, on a column you
   can read. Sections arrive ordered ACTION, WATCH, INFO.

   If you are on console when a report is pushed -- connected, live:true, a
   report id you have not seen -- the deck makes a fuss: beacons, banners,
   the bell, and a note from ground about your timing. The beacons flash at
   2 Hz for four seconds (under the 3-per-second limit in WCAG 2.3.1), are
   small, and are not red. With reduced motion asked for they glow steadily.

   Every string from the payload goes in with textContent. Moment links are
   built here from an id that must look like an id. */

const RPT = { data: null, seenKey: 'fv.report.seen', readKey: 'fv.report.read',
  dlg: null, lastFocus: null, egged: new Set(), tear: null };
const RPT_T0 = Date.now();

function rptStore(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }
  catch (_) { return null; }
}

/* In pan mode (narrow screens) the deck is wider than the screen, so the
   layout viewport is too: position:fixed centres on a box mostly off to the
   right. Overlays are pinned to the visual viewport instead -- what the
   person can actually see -- and follow it as they pan. */
const RPT_PINNED = new Set();
function rptPin(node) {
  RPT_PINNED.add(node); rptRepin();
}
function rptRepin() {
  const v = window.visualViewport;
  RPT_PINNED.forEach(n => {
    if (!n.isConnected) { RPT_PINNED.delete(n); return; }
    if (!v || Math.abs(v.width - innerWidth) < 2) { n.style.cssText = ''; return; }
    Object.assign(n.style, { left: v.offsetLeft + 'px', top: v.offsetTop + 'px',
      width: v.width + 'px', height: v.height + 'px', right: 'auto', bottom: 'auto' });
  });
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', rptRepin);
  visualViewport.addEventListener('scroll', rptRepin);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ---------- arrival ---------- */
function deckReport(msg) {
  const r = msg && msg.data;
  if (!r || typeof r.id !== 'string') return;
  const isNew = RPT.data?.id !== r.id;
  RPT.data = r;
  rptTearReady();
  const seen = rptStore(RPT.seenKey);
  if (msg.live && !RPT.egged.has(r.id)) {
    RPT.egged.add(r.id);
    rptStore(RPT.seenKey, r.id);
    rptIncoming(r);
    return;
  }
  if (isNew && seen !== r.id && typeof ttyReady !== 'undefined' && ttyReady) {
    // A standing report this browser has not had before: announce it quietly.
    // Marked seen only once the teleprinter can take it; if its console has
    // not loaded yet, the next connect announces it instead of losing it.
    rptStore(RPT.seenKey, r.id);
    rptAnnounce(r, false);
  }
}

function rptAnnounce(r, live) {
  if (typeof ttyEnqueue !== 'function') return;
  const acts = (r.sections || []).filter(s => s.pri === 'act').length;
  ttyEnqueue('', (live ? 'ZCZC INCOMING ' : 'MSG WAITING ') + (r.title || 'GROUND REPORT'), 'here', true);
  ttyEnqueue('', r.headline || '', '', true);
  ttyEnqueue('', acts ? `${acts} ACTION ITEM${acts > 1 ? 'S' : ''} - TEAR OFF TO READ` : 'TEAR OFF TO READ', '', true);
}

/* The printout itself is the way in: a transparent button laid over it. */
function rptTearReady() {
  if (RPT.tear) { RPT.tear.hidden = false; rptPlace(); return; }
  const cv = document.getElementById('ttyCv');
  if (!cv || !cv.parentNode) return;
  const b = el('button', 'rptTear');
  b.type = 'button';
  b.title = 'TEAR OFF — read the ground report';
  b.setAttribute('aria-label', 'Read the ground report');
  b.addEventListener('click', () => rptOpen());
  cv.parentNode.appendChild(b);
  RPT.tear = b;
  rptPlace();
}
function rptPlace() {
  if (!RPT.tear || typeof apRect !== 'function' || typeof placeBox !== 'function') return;
  try { placeBox(RPT.tear, apRect('printout')); } catch (_) {}
  const unread = RPT.data && rptStore(RPT.readKey) !== RPT.data.id;
  RPT.tear.classList.toggle('unread', !!unread);
}
addEventListener('resize', rptPlace);

/* ---------- the egg ---------- */
function rptIncoming(r) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fx = el('div', 'rptFx' + (still ? ' still' : ''));
  fx.setAttribute('aria-hidden', 'true');
  ['tl', 'tr', 'bl', 'br'].forEach(k => fx.appendChild(el('span', 'rptBeacon ' + k)));
  const strip = t => {
    const s = el('div', 'rptStrip ' + t), run = el('span', 'run');
    const words = `INCOMING TRANSMISSION  ·  ${r.title || 'GROUND REPORT'}  ·  STAND BY TELEPRINTER  ·  `;
    run.textContent = words.repeat(6);
    s.appendChild(run); return s;
  };
  fx.appendChild(strip('top')); fx.appendChild(strip('bot'));
  document.body.appendChild(fx);
  rptPin(fx);

  const live = document.getElementById('rptLive') || document.body.appendChild(el('div', 'srOnly'));
  live.id = 'rptLive'; live.setAttribute('role', 'alert');
  live.textContent = 'Incoming transmission from ground: ' + (r.title || 'report');

  if (typeof blip === 'function') { blip('bell'); setTimeout(() => blip('bell'), 600); setTimeout(() => blip('bell'), 1200); }
  if (typeof banner === 'function') banner('act', 'INCOMING', (r.title || 'Ground report') + ' arriving on the teleprinter now.');
  rptAnnounce(r, true);
  const comms = document.getElementById('ttyCv');
  if (comms && !still) comms.scrollIntoView({ behavior: 'smooth', block: 'center' });

  setTimeout(() => { fx.classList.add('done'); setTimeout(() => fx.remove(), 700); rptCommend(r); }, 4200);
}

/* Ground notices who was on console. Everything in the note is something
   this browser already knows; none of it goes anywhere. */
function rptCommend(r) {
  const now = new Date(), mins = Math.round((Date.now() - RPT_T0) / 60000);
  const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  const day = now.toLocaleDateString('en-GB', { weekday: 'long' }).toUpperCase();
  const h = now.getHours(), dow = now.getDay();
  let tenure;
  if (mins < 2) tenure = 'Arrived on console within two minutes of the transmission. Either impeccable timing or you read the flight plan. Ground suspects the latter and approves.';
  else if (mins < 30) tenure = `On console ${mins} minutes before the report left the ground. Present, alert, and in position when it counted.`;
  else if (mins < 120) tenure = `On console ${mins} minutes before the report left the ground. That is a full watch, stood without being asked.`;
  else tenure = `On console ${Math.floor(mins / 60)} h ${mins % 60} min without a break. Commendable. The flight surgeon would like a word.`;
  let hour = '';
  if (h < 6) hour = 'Logged in before dawn, local. The night shift sees what the day shift reads about.';
  else if (h < 9) hour = 'Early watch, local. First at the console, first to know.';
  else if (h >= 22) hour = 'Late watch, local. The network never sleeps and, apparently, neither do you.';
  if (dow === 0 || dow === 6) hour += (hour ? ' ' : '') + 'On a weekend, no less.';
  let eye = '';
  if (typeof stripSeen === 'object' && stripSeen && stripSeen.commsbezel) eye = 'You had the teleprinter in view as it began to print. Attention to detail: noted.';
  else eye = 'Ground notes the teleprinter was off your screen. Attention to detail: improving.';

  const layer = el('div', 'rptLayer');
  const card = el('div', 'rptCommend');
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Note from ground');
  card.appendChild(el('div', 'rcHead', `GROUND NOTE  ·  ${day} ${hh}:${mm} LOCAL`));
  card.appendChild(el('div', 'rcStamp', 'ON CONSOLE'));
  card.appendChild(el('p', null, 'To the crew member on console when this transmission arrived:'));
  card.appendChild(el('p', null, tenure));
  if (hour) card.appendChild(el('p', null, hour));
  card.appendChild(el('p', null, eye));
  card.appendChild(el('p', 'rcSig', '— FLIGHT, FAR VOICES GROUND'));
  const row = el('div', 'rcRow');
  const read = el('button', 'rptBtn primary', 'READ THE REPORT');
  const later = el('button', 'rptBtn', 'LATER');
  read.addEventListener('click', () => { layer.remove(); rptOpen(); });
  later.addEventListener('click', () => layer.remove());
  row.append(read, later); card.appendChild(row);
  layer.appendChild(card);
  document.body.appendChild(layer);
  rptPin(layer);
  read.focus();
  setTimeout(() => { if (layer.isConnected && !card.contains(document.activeElement)) layer.remove(); }, 45000);
}

/* ---------- the reader ---------- */
const PRI_LABEL = { act: 'ACTION', watch: 'WATCH', info: 'INFO' };

function rptOpen() {
  const r = RPT.data; if (!r) return;
  rptClose();
  RPT.lastFocus = document.activeElement;
  rptStore(RPT.readKey, r.id); rptPlace();

  const back = el('div', 'rptBack');
  const sheet = el('div', 'rptSheet');
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'rptH');
  sheet.tabIndex = -1;

  const hdr = el('pre', 'rptTwx');
  const t = r.t ? new Date(r.t) : new Date();
  const z = t.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  hdr.textContent = `ZCZC FVG001 ${z}\nPRIORITY  ROUTINE\nFM  FAR VOICES GROUND\nTO  ALL STATIONS ON CONSOLE\nSUBJ  ${r.title || 'GROUND REPORT'}`;
  sheet.appendChild(hdr);

  const h = el('h2', 'rptHead', r.headline || r.title || 'Ground report'); h.id = 'rptH';
  sheet.appendChild(h);
  if (r.thesis) sheet.appendChild(el('p', 'rptThesis', r.thesis));

  if ((r.figures || []).length) {
    const fig = el('dl', 'rptFigs');
    r.figures.forEach(f => {
      const d = el('div');
      d.append(el('dt', null, f.label), el('dd', 'v', f.value), el('dd', 'n', f.note));
      fig.appendChild(d);
    });
    sheet.appendChild(fig);
  }

  (r.sections || []).forEach(s => {
    const sec = el('section', 'rptSec ' + (PRI_LABEL[s.pri] ? s.pri : 'info'));
    sec.append(el('span', 'rptStamp', PRI_LABEL[s.pri] || 'INFO'), el('h3', null, s.title), el('p', null, s.body));
    sheet.appendChild(sec);
  });

  if ((r.events || []).length) {
    sheet.appendChild(el('h3', 'rptSub', 'NOTABLE ON THE NETWORK'));
    const ol = el('ol', 'rptEvents');
    r.events.forEach(e => {
      const li = el('li');
      li.append(el('span', 'when', e.when), el('b', null, e.title), el('span', 'why', e.why));
      if (typeof e.moment === 'string' && /^[A-Za-z0-9-]+$/.test(e.moment)) {
        const a = el('a', 'rptPlay', '▶ PLAY THIS HOUR');
        a.href = '?moment=' + encodeURIComponent(e.moment);
        li.appendChild(a);
      }
      ol.appendChild(li);
    });
    sheet.appendChild(ol);
    sheet.appendChild(el('p', 'rptFoot', 'Each tape is a re-performance of the recorded sky, not a recording of what played.'));
  }

  sheet.appendChild(el('pre', 'rptTwx end', 'NNNN'));
  const close = el('button', 'rptBtn rptClose', 'FILE IT  ✕');
  close.setAttribute('aria-label', 'Close the report');
  close.addEventListener('click', rptClose);
  sheet.insertBefore(close, sheet.firstChild);

  back.appendChild(sheet);
  back.addEventListener('click', e => { if (e.target === back) rptClose(); });
  back.addEventListener('keydown', rptKeys);
  document.body.appendChild(back);
  rptPin(back);
  document.body.classList.add('rptOpen');
  RPT.dlg = back;
  sheet.focus();
}

function rptKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); rptClose(); return; }
  if (e.key !== 'Tab') return;
  const f = [...RPT.dlg.querySelectorAll('button,a[href]')];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === RPT.dlg.firstChild)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function rptClose() {
  if (!RPT.dlg) return;
  RPT.dlg.remove(); RPT.dlg = null;
  document.body.classList.remove('rptOpen');
  if (RPT.lastFocus && RPT.lastFocus.focus) RPT.lastFocus.focus();
}
