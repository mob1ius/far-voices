import { timingSafeEqual } from "./auth.js";

// RelayHub: the only stateful piece of the live pipeline.
//
// One inbound path (POST /publish) accepts frames from the trusted publisher
// process, which connects outbound only.
//
// One outbound path (GET /live, upgraded to WebSocket) fans frames out to
// browsers. That socket is read-only from the browser's side: any message a
// client sends is dropped, never interpreted, never echoed.

const MAX_CLIENTS = 4000;
const MAX_FRAME_BYTES = 8 * 1024;
const PUBLISH_MAX_BODY = 16 * 1024;
const STALE_MS = 20_000; // no publish in 20s -> tell clients we are stale



// Shape-validate a frame before it ever reaches a browser. The publisher is
// trusted, but "trusted" is not the same as "never wrong" -- a bug in the
// local engine should not become a script-shaped value inside a client's DOM.
function sanitizeFrame(f) {
  if (typeof f !== "object" || f === null) return null;
  const clean = {};
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max).replace(/[<>]/g, "") : "");
  clean.t = str(f.t, 40);
  clean.state = str(f.state, 20);
  clean.lock = !!f.lock;
  clean.acq = Array.isArray(f.acq) ? f.acq.slice(0, 20).map((x) => str(x, 12)) : [];
  clean.lost = Array.isArray(f.lost) ? f.lost.slice(0, 20).map((x) => str(x, 12)) : [];
  clean.dualOn = Array.isArray(f.dualOn) ? f.dualOn.slice(0, 20).map((x) => str(x, 12)) : [];
  clean.dualOff = Array.isArray(f.dualOff) ? f.dualOff.slice(0, 20).map((x) => str(x, 12)) : [];
  clean.chord = Array.isArray(f.chord) && f.chord.length === 2
    ? [Number(f.chord[0]) || 0, str(f.chord[1], 8)] : [0, "maj"];
  clean.notes = {};
  if (f.notes && typeof f.notes === "object") {
    for (const k of ["S", "A", "T", "B", "O", "I"]) {
      const v = f.notes[k];
      clean.notes[k] = typeof v === "number" && v >= 0 && v <= 127 ? v : null;
    }
  }
  clean.expr = {};
  if (f.expr && typeof f.expr === "object") {
    for (const k of Object.keys(f.notes || {})) {
      const v = f.expr[k];
      clean.expr[k] = typeof v === "number" ? Math.max(0, Math.min(127, v)) : 0;
    }
  }
  clean.links = Array.isArray(f.links)
    ? f.links.slice(0, 60).map((l) => ({
        st: str(l.st, 8), d: str(l.d, 8), sc: str(l.sc, 12), dir: str(l.dir, 4),
        b: str(l.b, 4), r: Number(l.r) || 0, p: Number(l.p) || -160,
        part: l.part ? str(l.part, 2) : null,
      }))
    : [];
  clean.dbm = Number(f.dbm) || -160;
  clean.n = Number(f.n) || 0;
  return clean;
}

// The weekly ground report the deck's teleprinter receives. Same rule as a
// frame: the sender is trusted, the shape is still enforced, and nothing
// script-shaped survives. Moment ids are ids, never URLs -- the deck builds
// the link itself.
const MAX_REPORT_BYTES = 12 * 1024;
const PRIORITIES = new Set(["act", "watch", "info"]);
function sanitizeReport(r) {
  if (typeof r !== "object" || r === null) return null;
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max).replace(/[<>]/g, "") : "");
  const id = str(r.id, 24);
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    id,
    t: str(r.t, 40),
    title: str(r.title, 80),
    headline: str(r.headline, 120),
    thesis: str(r.thesis, 600),
    figures: list(r.figures, 6).map((f) => ({
      label: str(f && f.label, 40), value: str(f && f.value, 24), note: str(f && f.note, 80),
    })),
    sections: list(r.sections, 6).map((x) => ({
      pri: PRIORITIES.has(x && x.pri) ? x.pri : "info",
      title: str(x && x.title, 100), body: str(x && x.body, 900),
    })),
    events: list(r.events, 8).map((e) => {
      const m = str(e && e.moment, 40);
      return {
        title: str(e && e.title, 80), when: str(e && e.when, 40), why: str(e && e.why, 300),
        moment: /^[A-Za-z0-9-]+$/.test(m) ? m : null,
      };
    }),
  };
}

export class RelayHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.latest = null;
    this.lastPublish = 0;
    this.report = null;
    // One read when the object wakes; one write a week when a report lands.
    state.blockConcurrencyWhile(async () => {
      this.report = (await state.storage.get("report")) || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/publish") {
      return this.#handlePublish(request);
    }

    // Read-only, unauthenticated, deliberately: this exposes nothing that
    // every /live subscriber doesn't already receive on connect, and it
    // exists specifically so the boot screen can show a real "N in contact
    // right now" figure before Power Up without either the browser hitting
    // NASA's own feed directly (real load, multiplied by every visitor) or
    // opening a WebSocket before the visitor has asked for one.
    if (url.pathname === "/status") {
      return new Response(
        JSON.stringify({ n: this.latest ? this.latest.n : null, stale: this.#isStale() }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    }

    // Internal only: worker.js forwards here after checking CONSOLE_TOKEN.
    // There is no public route to this path.
    if (url.pathname === "/report-push") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const report = sanitizeReport(body);
      if (!report) return new Response("bad report", { status: 400 });
      const packed = JSON.stringify({ type: "report", data: report, live: true });
      if (packed.length > MAX_REPORT_BYTES) return new Response("report too large", { status: 413 });
      this.report = report;
      await this.state.storage.put("report", report);
      let sent = 0;
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(packed);
          sent++;
        } catch {
          // same as a frame: one dead socket never fails the push
        }
      }
      return new Response(JSON.stringify({ ok: true, id: report.id, clients: sent }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/live") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      if (this.state.getWebSockets().length >= MAX_CLIENTS) {
        return new Response("full", { status: 503 });
      }
      const pair = new WebSocketPair();
      // Hibernation API: the DO can evict this object from memory between
      // messages and the socket survives. Nothing here needs to run
      // continuously per-client, so this is the right primitive.
      this.state.acceptWebSocket(pair[1]);
      if (this.latest) {
        pair[1].send(JSON.stringify({ type: "frame", data: this.latest, stale: this.#isStale() }));
      }
      // The standing report, so the teleprinter has it to tear off. live:false
      // is what keeps a reconnect or a fresh visit from counting as having
      // been on console when it came in.
      if (this.report) {
        pair[1].send(JSON.stringify({ type: "report", data: this.report, live: false }));
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("not found", { status: 404 });
  }

  async #handlePublish(request) {
    // Read the body exactly once, unconditionally, before any branch that
    // could return early. Two things were tried and both broke the
    // connection for whatever request followed on the same keep-alive
    // socket: leaving the body unread on an early return, and explicitly
    // calling body.cancel() to clean it up. A single unconditional read is
    // the one pattern that measured clean across every path (bad method,
    // bad auth, oversized, malformed, and the success case).
    let text = "";
    try {
      text = await request.text();
    } catch {
      // an unreadable body is not fatal here; the checks below still apply
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const auth = request.headers.get("Authorization") || "";
    const expected = `Bearer ${this.env.PUBLISH_TOKEN}`;
    if (!this.env.PUBLISH_TOKEN || !timingSafeEqual(auth, expected)) {
      // Same response whether the token is missing, wrong, or absent from
      // the environment -- do not let the error distinguish those cases.
      return new Response("unauthorized", { status: 401 });
    }

    if (text.length > PUBLISH_MAX_BODY) return new Response("too large", { status: 413 });

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const frame = sanitizeFrame(body);
    if (!frame) return new Response("bad frame", { status: 400 });

    const packed = JSON.stringify({ type: "frame", data: frame, stale: false });
    if (packed.length > MAX_FRAME_BYTES) return new Response("frame too large", { status: 413 });

    this.latest = frame;
    this.lastPublish = Date.now();

    let sent = 0;
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(packed);
        sent++;
      } catch {
        // a dead socket here just means it will be cleaned up on its own;
        // never let one bad client fail the publish for everyone else.
      }
    }
    return new Response(JSON.stringify({ ok: true, clients: sent }), {
      headers: { "content-type": "application/json" },
    });
  }

  #isStale() {
    return !this.lastPublish || Date.now() - this.lastPublish > STALE_MS;
  }

  // Browsers never send anything on this socket. Close any that does, without
  // echoing, parsing or logging what it sent.
  async webSocketMessage(ws, _message) {
    try { ws.close(1008, "read only"); } catch { /* already closing */ }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    void ws; void code; void reason; void wasClean;
  }

  async webSocketError(ws, _error) {
    void ws;
  }
}
