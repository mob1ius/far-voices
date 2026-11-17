"use strict";
/* THE LOWER PORTHOLE — a second window, looking ninety degrees to port.
 *
 * Loaded after deck_cockpit.js and deck_ship.js, so their top-level globals are
 * visible here: STARS, sph, rot's inputs (yaw, pitch), kelvinRGB, apRect,
 * placeBox, fitCanvas, watchStrip, stripSeen, blip, flash, ttyEnqueue, FMAP,
 * NAV_ACT, slideList, slideTo, SHIP. Every reach into them is guarded, so a
 * missing piece costs this window a feature rather than breaking the deck.
 *
 * Why its own projection rather than reusing drawSky: the top window looks
 * along the velocity vector and this one looks to the side, which is the whole
 * point of having two. Sharing one rotation would make them two copies of the
 * same screen.
 */

const PORT = {
  bearing: 90,          // degrees off the nose: this window looks to port
  lookX: 0, lookY: 0,   // the lean, from dragging on the glass
  drag: null,
  blind: 0,             // 0 open, 1 fully drawn down
  iris: 0,              // 0 normal, 1 wide open: faint stars appear
  roll: 0,              // integrated from the ship's roll rate
  wipedUntil: 0,
  passer: null,
  nextPass: 0,
  alienAt: 0,
  seen: new Set(),
  photos: 0,
  last: performance.now(),
};

/* Twelve things that go past, with how often and what each is worth. The rare
   ones are the reason to keep looking; the common ones are the weather that
   makes the rare ones feel earned. */
const PASSERS = [
  { src: 'egg_ice.webp', w: 170, weight: 5, dur: 14, cap: 'ICE CRYSTALS · VENTED WATER, FLASH-FROZEN',
    tap: 'THE CLOUD SCATTERS' },
  { src: 'egg_bolt.webp', w: 90, weight: 5, dur: 11, cap: 'HEX BOLT AND WASHER · SOMEBODY DROPPED THIS',
    tap: 'LOST ITEM LOGGED' },
  { src: 'egg_cap.webp', w: 85, weight: 4, dur: 10, cap: 'LENS CAP · THE CAMERA IS FINE. THE CAP IS GONE.',
    tap: 'LOST ITEM LOGGED' },
  { src: 'egg_glove.webp', w: 120, weight: 4, dur: 13, cap: 'SPARE GLOVE · WAVING, APPARENTLY',
    tap: 'IT WAVES BACK' },
  { src: 'egg_clipboard.webp', w: 130, weight: 3, dur: 15, cap: 'CHECKLIST · PAGES ESCAPING ONE AT A TIME',
    tap: 'ONE PAGE STICKS TO THE GLASS' },
  { src: 'egg_sandwich.webp', w: 110, weight: 3, dur: 12, cap: 'CORNED BEEF ON RYE · GEMINI 3, 1965',
    tap: 'CONTRABAND' },
  { src: 'egg_hat.webp', w: 115, weight: 2, dur: 13, cap: 'USHANKA · TUMBLING SLOWLY, EARS OUT',
    tap: 'ШАПКА ЗА БОРТОМ' },
  { src: 'egg_sat.webp', w: 150, weight: 2, dur: 18, cap: 'DERELICT SATELLITE · ANTENNA BENT, PANELS DEAD',
    tap: 'UNTRACKED OBJECT LOGGED' },
  { src: 'egg_capsule.webp', w: 150, weight: 1, dur: 20, cap: 'REENTRY CAPSULE · CHARRED, SERIAL ILLEGIBLE',
    tap: 'NO RECORD FOUND' },
  { src: 'egg_whale.webp', w: 240, weight: 1, dur: 20, cap: 'WHALE',
    tap: 'A BOWL OF PETUNIAS FOLLOWS IT PAST' },
  { src: 'egg_alien2.webp', w: 120, weight: 1, dur: 16, cap: 'SECOND VISITOR · CARRYING A CLIPBOARD',
    tap: 'BOTH OF THEM LOOK AT YOU' },
];
const ALIEN = { src: 'egg_alien.webp', w: 150, dur: 17, cap: 'UNIDENTIFIED · FRIENDLY',
  tap: 'IT WAVES BACK, THEN PRETENDS IT DID NOT' };

const FAST = new URLSearchParams(location.search).get('eggs') === 'fast'
  || new URLSearchParams(location.search).get('ship') === 'alien';
const portImg = {};
function pimg(src) {
  if (!portImg[src]) { const im = new Image(); im.src = 'overlay/' + src; portImg[src] = im; }
  return portImg[src];
}

/* ---------- build and place */
function portInit() {
  if (typeof watchStrip === 'function') watchStrip('portbezel');
  const cv = document.createElement('canvas');
  cv.id = 'portCv'; cv.className = 'stripcv deckpart'; cv.setAttribute('aria-label', 'Lower porthole');
  document.body.appendChild(cv);

  const blind = document.createElement('div');
  blind.id = 'portBlind'; blind.className = 'deckpart';
  document.body.appendChild(blind);

  const pull = document.createElement('button');
  pull.id = 'portPull'; pull.className = 'tkey deckpart';
  pull.title = 'Roller blind — drag down to cover the window';
  pull.setAttribute('aria-label', 'Window blind');
  pull.addEventListener('click', () => portBlind(PORT.blind > 0.5 ? 0 : 1));
  document.body.appendChild(pull);

  const cam = document.createElement('button');
  cam.id = 'portCam'; cam.className = 'tkey deckpart';
  cam.title = 'Camera — photograph what is outside';
  cam.setAttribute('aria-label', 'Camera');
  cam.addEventListener('click', portPhoto);
  document.body.appendChild(cam);

  cv.addEventListener('pointerdown', portDown);
  addEventListener('pointermove', portMove);
  addEventListener('pointerup', portUp);
  cv.addEventListener('dblclick', portCentre);

  PORT.nextPass = performance.now() + (FAST ? 4000 : 90000 + Math.random() * 120000);
  PORT.alienAt = performance.now() + (FAST ? 12000 : 120000 + Math.random() * 1080000);  // once, within 20 min
  portLayout();
}

function portLayout() {
  if (typeof apRect !== 'function' || !PORT_AP) return;
  const g = apRect('glass');
  placeBox($('portCv'), g);
  placeBox($('portBlind'), g);
  placeBox($('portPull'), apRect('blindPull'));
  placeBox($('portCam'), apRect('camera'));
}

/* ---------- interaction */
function portDown(e) {
  const g = apRect('glass');
  PORT.drag = { x: e.clientX, y: e.clientY, x0: PORT.lookX, y0: PORT.lookY, t: performance.now(), moved: 0 };
  $('portCv').setPointerCapture && $('portCv').setPointerCapture(e.pointerId);
  // A tap on a passer-by claims it before the drag does anything.
  if (PORT.passer) {
    const p = PORT.passer, px = g.x + p.x, py = g.y + p.y;
    if (Math.hypot(e.clientX + scrollX - px, e.clientY + scrollY - py) < p.w * 0.7) portTap();
  }
}
function portMove(e) {
  if (!PORT.drag) return;
  const dx = e.clientX - PORT.drag.x, dy = e.clientY - PORT.drag.y;
  PORT.drag.moved = Math.max(PORT.drag.moved, Math.hypot(dx, dy));
  PORT.lookX = Math.max(-15, Math.min(15, PORT.drag.x0 + dx * 0.06));
  PORT.lookY = Math.max(-12, Math.min(12, PORT.drag.y0 - dy * 0.06));
  if (PORT.drag.moved > 20 && portFrost() > 0.15) PORT.wipedUntil = performance.now() + 8000;
}
function portUp() {
  if (PORT.drag && PORT.drag.moved < 6 && performance.now() - PORT.drag.t > 350) {
    PORT.iris = PORT.iris > 0.5 ? 0 : 1;                       // press and hold: open the iris
    if (typeof flash === 'function') flash(PORT.iris ? 'IRIS OPEN · FAINT STARS' : 'IRIS STOPPED DOWN');
  }
  PORT.drag = null;
}
function portCentre() {
  // Swing toward whatever the network is actually hearing right now.
  let target = null;
  if (typeof NAV_ACT !== 'undefined' && NAV_ACT) {
    for (const st of Object.keys(NAV_ACT)) { const s = [...NAV_ACT[st]][0]; if (s) { target = s; break; } }
  }
  PORT.lookX = 0; PORT.lookY = 0;
  if (target && typeof flash === 'function') {
    const name = (FMAP[target] || {}).n || target;
    PORT.lastTarget = name.toUpperCase();
    flash('BEARING TO ' + name.toUpperCase());
    if (typeof ttyEnqueue === 'function') ttyEnqueue('', 'PORT WINDOW SLEWED TO ' + name.toUpperCase());
  } else if (typeof flash === 'function') flash('NOTHING IN CONTACT · HOLDING BEARING');
}
function portBlind(to) {
  PORT.blindTo = to;
  if (typeof blip === 'function') blip(to ? 'rip' : 'cr');
  if (typeof flash === 'function') flash(to ? 'BLIND DOWN' : 'BLIND STOWED');
}
function portTap() {
  const p = PORT.passer; if (!p || p.tapped) return;
  p.tapped = true; p.vx *= 0.55; p.spin *= 2.4;
  if (typeof blip === 'function') blip(p.def === ALIEN ? 'squeak' : 'flick');
  if (typeof flash === 'function') flash(p.def.tap);
  if (typeof ttyEnqueue === 'function') ttyEnqueue('', p.def.cap);
}

/* A photograph of the window goes into the archive projector as a new slide.
   This is the only thing on the deck that turns a visitor's own session into
   an object they can go back and look at. */
function portPhoto() {
  const cv = $('portCv');
  if (!cv || typeof slideList !== 'function') return;
  let url;
  try { url = cv.toDataURL('image/jpeg', 0.72); } catch (e) { return; }
  const n = ++PORT.photos;
  // Name every frame differently: seconds as well as minutes, plus the frame
  // number, so two photographs taken in the same minute are still two slides.
  const t = new Date().toISOString().slice(11, 19);
  const id = 'photo-' + n + '-' + Date.now().toString(36);
  const aim = PORT.lastTarget ? ' \u00b7 ' + PORT.lastTarget : '';
  slideList().push({ id, name: 'Port window ' + t + 'Z', photo: url,
    credit: 'Photographed from the lower porthole, frame ' + n + aim,
    ag: 'This vehicle', yr: new Date().getUTCFullYear(),
    dest: 'Frame ' + String(n).padStart(3, '0') + ' \u00b7 ' + t + 'Z' });
  if (typeof slideTo === 'function') slideTo(id);
  if (typeof blip === 'function') blip('clack');
  if (typeof flash === 'function') flash('PHOTOGRAPH · FILED IN THE ARCHIVE');
  if (typeof ttyEnqueue === 'function') ttyEnqueue('', 'PHOTOGRAPH TAKEN - SLIDE ' + n + ' ADDED');
}

/* ---------- the view */
function portFrost() {
  if (typeof SHIP === 'undefined') return 0;
  if (performance.now() < PORT.wipedUntil) return 0;
  return Math.max(0, Math.min(1, (10 - SHIP.cabinC) / 20));
}

// Same celestial sphere as the main window, rotated to this window's bearing
// and this window's lean, then rolled by the ship's own roll.
function portRot(v, a, b, r) {
  let X = v[0] * Math.cos(a) - v[2] * Math.sin(a), Z = v[0] * Math.sin(a) + v[2] * Math.cos(a);
  let Y = v[1] * Math.cos(b) - Z * Math.sin(b); Z = v[1] * Math.sin(b) + Z * Math.cos(b);
  const cr = Math.cos(r), sr = Math.sin(r);
  return [X * cr - Y * sr, X * sr + Y * cr, Z];
}

function portDraw(now) {
  const dt = Math.min(0.1, (now - PORT.last) / 1000); PORT.last = now;
  if (!PORT_AP || !$('portCv')) return;
  if (typeof stripSeen !== 'undefined' && stripSeen.portbezel === false) return;

  // spring the lean back when nobody is holding it
  if (!PORT.drag) { PORT.lookX *= Math.max(0, 1 - 1.6 * dt); PORT.lookY *= Math.max(0, 1 - 1.6 * dt); }
  if (PORT.blindTo != null) {
    const d = PORT.blindTo - PORT.blind;
    PORT.blind += Math.sign(d) * Math.min(Math.abs(d), 2.2 * dt);
    if (Math.abs(PORT.blindTo - PORT.blind) < 0.01) { PORT.blind = PORT.blindTo; PORT.blindTo = null; }
  }
  if (typeof SHIP !== 'undefined') PORT.roll += SHIP.rate.r * dt;

  const g = apRect('glass');
  const x = fitCanvas($('portCv'), g.w, g.h), W = g.w, H = g.h;
  const cx = W / 2, cy = H / 2;
  x.fillStyle = '#04070D'; x.fillRect(0, 0, W, H);

  const a = (yaw + PORT.bearing + PORT.lookX) * Math.PI / 180;
  const b = (pitch + PORT.lookY) * Math.PI / 180;
  const r = PORT.roll * Math.PI / 180;
  const SR = Math.max(W, H) * 0.62;
  const limit = 6.2 + PORT.iris * 1.4;                    // the iris buys you fainter stars

  if (typeof STARS !== 'undefined') {
    for (const s of STARS) {
      if (s.v > limit) continue;
      const q = portRot(sph(s.d, s.r), a, b, r);
      if (q[2] <= 0) continue;
      const px = cx + q[0] * SR, py = cy - q[1] * SR;
      if (px < -8 || px > W + 8 || py < -8 || py > H + 8) continue;
      const m = Math.max(.5, (6.2 - s.v) * .5), al = Math.min(1, (limit + .7 - s.v) / 4.2);
      const c = kelvinRGB(s.k);
      x.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${al * .92})`;
      x.beginPath(); x.arc(px, py, m, 0, 7); x.fill();
      if (s.v < 2.3) { x.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},.12)`;
        x.beginPath(); x.arc(px, py, m * 3.2, 0, 7); x.fill(); }
    }
  }

  // Earth fills the lower third whenever the Globus is looking at it.
  if (typeof mapFocus !== 'undefined' && mapFocus === 'earth') {
    const im = pimg('earth_limb.webp');
    if (im.complete && im.naturalWidth) {
      const w = W * 1.45, h = w * im.naturalHeight / im.naturalWidth;
      x.save(); x.translate(cx, H * 0.97); x.rotate(-r * 0.4);
      x.drawImage(im, -w / 2, -h * 0.55, w, h); x.restore();
    }
  }

  portPassers(x, now, dt, W, H, g);

  // frost grows in from the corners of this window too, on top of the view
  const fr = portFrost();
  if (fr > 0.02) {
    const im = pimg('frost.webp');
    if (im.complete && im.naturalWidth) { x.globalAlpha = Math.min(0.95, fr); x.drawImage(im, 0, 0, W, H); x.globalAlpha = 1; }
  }

  // the blind, drawn last because it covers everything including the weather
  if (PORT.blind > 0.002) {
    const bh = H * PORT.blind;
    const gr = x.createLinearGradient(0, 0, 0, bh);
    gr.addColorStop(0, '#2A2419'); gr.addColorStop(0.92, '#1C1811'); gr.addColorStop(1, '#0D0B07');
    x.fillStyle = gr; x.fillRect(0, 0, W, bh);
    x.strokeStyle = 'rgba(0,0,0,.65)'; x.lineWidth = 2; x.beginPath();
    x.moveTo(0, bh); x.lineTo(W, bh); x.stroke();
  }
}

/* ---------- the traffic outside */
function portPassers(x, now, dt, W, H, g) {
  const p = PORT.passer;
  if (p) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.spin * dt;
    const im = pimg(p.def.src);
    if (im.complete && im.naturalWidth) {
      const w = p.w, h = w * im.naturalHeight / im.naturalWidth;
      x.save(); x.translate(p.x, p.y); x.rotate(p.rot * Math.PI / 180);
      // a tumble streaks whatever goes past; an escape thins it to nothing
      if (typeof SHIP !== 'undefined' && Math.abs(SHIP.rate.y) > 6) { x.globalAlpha = 0.5; x.scale(1.6, 1); }
      x.drawImage(im, -w / 2, -h / 2, w, h); x.restore(); x.globalAlpha = 1;
    }
    if (p.x < -p.w * 1.5 || p.x > W + p.w * 1.5) PORT.passer = null;
    return;
  }
  // nothing funny while the ship is in real trouble
  const calm = typeof SHIP === 'undefined' || SHIP.caution < 2;
  if (!calm || now < PORT.nextPass) {
    if (now >= PORT.alienAt && PORT.alienAt && calm) { /* the alien waits for calm, it does not skip */ }
    return;
  }
  let def;
  if (PORT.alienAt && now >= PORT.alienAt) { def = ALIEN; PORT.alienAt = 0; }
  else {
    const bag = [];
    PASSERS.forEach(d => { for (let k = 0; k < d.weight; k++) bag.push(d); });
    def = bag[Math.floor(Math.random() * bag.length)];
  }
  const left = Math.random() < 0.5;
  const w = def.w * (g.w / 760);                        // scale with the window
  PORT.passer = { def, w, x: left ? -w : W + w, y: H * (0.2 + Math.random() * 0.6),
    vx: (left ? 1 : -1) * (W + w * 2) / def.dur, vy: (Math.random() - 0.5) * 6,
    rot: Math.random() * 360, spin: (Math.random() - 0.5) * 12, tapped: false };
  PORT.nextPass = now + (FAST ? 6000 : 180000 + Math.random() * 300000);
  if (!PORT.seen.has(def.src)) { PORT.seen.add(def.src); }
}

let PORT_AP = null;
function portReady(json) { PORT_AP = json; }
let portRelayout = null;
addEventListener('resize', () => { clearTimeout(portRelayout); portRelayout = setTimeout(portLayout, 120); });
