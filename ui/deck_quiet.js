/* The quiet sky.
 *
 * The Deep Space Network takes maintenance windows. When it does, every dish
 * at all three complexes reports engineering work, no spacecraft is in
 * contact, and this site correctly plays nothing at all. That is the whole
 * premise working: the choir is the traffic, and there is no traffic.
 *
 * To a visitor it is indistinguishable from a broken website. They arrive from
 * a link, press Power Up, hear silence, and leave. The existing fallback does
 * not help, because it only triggers when the feed cannot be REACHED. A feed
 * that answers promptly and says "nothing is happening" is a different case
 * and nothing handled it.
 *
 * Observed live on 2026-10-06: all fifteen dishes on Engineering Sustaining,
 * Upgrades or Preventative Maintenance, zero spacecraft targets, for hours.
 * The deck showed a green LIVE badge, "Link traffic 0", and the word "silent"
 * in small type, and said nothing else.
 *
 * So: notice it, say so plainly, and offer the archive, which always has
 * something to sing. Both decks expose the same handful of globals, so this
 * one file serves the console and the phone.
 */
(() => {
  'use strict';

  const QUIET_AFTER = 15000;   // a gap between passes is normal; minutes of it is not
  const POLL = 2000;

  const read = {
    liveMode: () => (typeof liveMode === 'undefined' ? undefined : liveMode),
    AC: () => (typeof AC === 'undefined' ? undefined : AC),
    F: () => (typeof F === 'undefined' ? undefined : F),
    i: () => (typeof i === 'undefined' ? undefined : i),
  };
  const g = (k) => { try { return read[k](); } catch { return undefined; } };

  let zeroSince = null, box = null, dismissed = false, loading = false;

  function links() {
    const f = g('F'), n = g('i');
    if (!f || !f.length) return null;
    const fr = f[typeof n === 'number' ? n : f.length - 1];
    return fr && fr.links ? fr.links.length : null;
  }

  /* Pick the hour worth hearing rather than the most recent one. peak is the
     most voices that were ever singing at once, and an hour with acquisitions
     in it has cadences, which is where the music actually does something. */
  async function bestHour() {
    const res = await fetch('timemachine.json', { cache: 'no-store' });
    const d = await res.json();
    const hours = (d && d.hours) || [];
    if (!hours.length) return null;
    return hours.slice().sort((a, b) =>
      (b.peak || 0) - (a.peak || 0)
      || ((b.acq || []).length - (a.acq || []).length)
      || (a.t < b.t ? 1 : -1))[0];
  }

  function badge(quiet) {
    const el = document.getElementById('liveBadge');
    if (!el || el.hidden) return;
    if (quiet && !el.dataset.quiet) { el.dataset.quiet = '1'; el.textContent = 'LIVE · QUIET'; }
    else if (!quiet && el.dataset.quiet) { delete el.dataset.quiet; el.textContent = 'LIVE'; }
  }

  function build() {
    if (box) return box;
    box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:40;'
      + 'max-width:min(560px,92vw);background:rgba(4,7,13,.95);border:1px solid #1B2836;'
      + 'border-radius:4px;padding:14px 16px;color:#93D8EC;'
      + 'font:13px/1.6 "IBM Plex Mono",ui-monospace,Menlo,monospace;'
      + 'box-shadow:0 10px 40px rgba(0,0,0,.6)';
    box.innerHTML =
      '<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#5A6B78;'
      + 'margin-bottom:6px">Network quiet</div>'
      + '<div style="color:#8A97A3">Every dish is between passes or in maintenance, so nothing is '
      + 'being heard and the choir has nothing to sing. This is the site working, not a fault.</div>'
      + '<div style="margin-top:11px;display:flex;gap:8px;flex-wrap:wrap">'
      + '<button type="button" data-act="play" style="font:inherit;color:#04070D;background:#93D8EC;'
      + 'border:0;border-radius:3px;padding:8px 13px;cursor:pointer">Play a recorded hour</button>'
      + '<button type="button" data-act="wait" style="font:inherit;color:#93D8EC;background:none;'
      + 'border:1px solid #1B2836;border-radius:3px;padding:8px 13px;cursor:pointer">Wait it out</button>'
      + '</div>';
    box.addEventListener('click', async (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (act === 'wait') { dismissed = true; hide(); return; }
      if (act !== 'play' || loading) return;
      loading = true;
      e.target.textContent = 'Loading…';
      try {
        const h = await bestHour();
        if (h && typeof loadMoment === 'function') {
          // Leave live mode FIRST. mountMoment() replaces the frame buffer in
          // place, and the live socket keeps writing to that same buffer, so
          // loading an hour while still connected means the next live frame
          // overwrites it a second or two later and the deck goes quiet again
          // with no sign of why. goOffline() is the deck's own teardown: it
          // clears liveMode before closing the socket, which is what stops the
          // close handler reconnecting.
          if (typeof goOffline === 'function') goOffline();
          const m = await loadMoment(h.id);
          if (m && typeof showMomentBanner === 'function') showMomentBanner(m);
          if (typeof renderTape === 'function') renderTape();
          // Live mode drives itself off the socket, so the step timer is not
          // running. Start it, or the hour sits on frame zero.
          if (typeof loop === 'function' && typeof playing !== 'undefined' && playing) loop();
          dismissed = true;
          e.target.textContent = 'Play a recorded hour';   // in case it is shown again
          hide();
        } else {
          e.target.textContent = 'Archive unavailable';
        }
      } catch {
        e.target.textContent = 'Could not load, try again';
      } finally {
        loading = false;
      }
    });
    document.body.appendChild(box);
    return box;
  }

  function show() { build().style.display = ''; }
  function hide() {
    if (box) box.style.display = 'none';
    // The badge helper skips a hidden badge, so clear its marker here or a
    // deck that goes offline while quiet keeps "LIVE . QUIET" queued up for
    // whenever the badge is shown again.
    const b = document.getElementById('liveBadge');
    if (b && b.hidden && b.dataset.quiet) { delete b.dataset.quiet; b.textContent = 'LIVE'; }
  }

  setInterval(() => {
    // Only once there is sound to miss, and only against the live sky. A
    // recorded hour that happens to be quiet is the archive being honest.
    if (!g('AC') || g('liveMode') !== true) { zeroSince = null; badge(false); hide(); return; }
    const n = links();
    if (n === null) return;
    if (n > 0) {
      zeroSince = null; dismissed = false; badge(false); hide();
      return;
    }
    if (zeroSince === null) zeroSince = Date.now();
    const quiet = Date.now() - zeroSince >= QUIET_AFTER;
    badge(quiet);
    if (quiet && !dismissed) show();
  }, POLL);
})();
