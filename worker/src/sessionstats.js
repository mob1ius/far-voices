// SessionStats: the anonymous session summaries described on /privacy.html.
//
// Deliberately a second Durable Object rather than another table inside
// RequestLog. The separation is the point and it is structural, not a
// convention someone has to remember:
//
//   - there is no ip column here, so there is nowhere for an address to end up
//     even by accident;
//   - rows are filed against the DAY, not the moment. Two records that share a
//     millisecond can be lined up against each other, and then keeping them in
//     separate places was only decoration. A day is 86,400 seconds wide and a
//     launch day has thousands of sessions in it;
//   - the Worker leaves /beacon out of the request log entirely, so the IP that
//     carried a summary is never written down next to the time it arrived.
//
// Because none of this is personal data, it has no retention alarm. The counts
// are the long record: they are what answers "what did people do in launch
// week" in a year's time, when the request log that week is long gone.

const MAX_BODY = 16_000;
const MAX_KEYS = 80;
// A busy day is thousands of sessions. Past this many in one UTC day further
// summaries are dropped, so a flood cannot grow the store without limit.
const DAY_CAP = 60_000;

export class SessionStats {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = this.#init();
  }

  async #init() {
    await this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        deck TEXT,
        session_sec INTEGER,
        audio_sec INTEGER,
        scroll_strips INTEGER,
        max_rung INTEGER,
        summary TEXT NOT NULL
      )
    `);
    await this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_day ON sessions(day)`,
    );
  }

  // Everything that lands here came from a visitor's browser, so nothing is
  // trusted: the shape is rebuilt field by field rather than stored as sent.
  // That caps what a forged beacon can do to filling the table with numbers,
  // and it guarantees that a field nobody designed for cannot appear later in
  // an export and surprise somebody.
  static #clean(b) {
    const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v)
      ? Math.max(lo, Math.min(hi, Math.round(v))) : null);
    const str = (v, max, allow) => {
      if (typeof v !== "string") return null;
      const t = v.slice(0, max);
      return allow.test(t) ? t : null;
    };
    const counts = (o) => {
      const out = {};
      if (!o || typeof o !== "object") return out;
      for (const k of Object.keys(o).slice(0, MAX_KEYS)) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) continue;
        const n = num(o[k], 0, 100_000);
        if (n !== null) out[k] = n;
      }
      return out;
    };
    const names = (a) => (Array.isArray(a) ? a.slice(0, 20)
      .filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x)) : []);
    const lines = (a) => (Array.isArray(a) ? a.slice(0, 5)
      .filter((x) => typeof x === "string").map((x) => x.slice(0, 200)) : []);

    return {
      v: 1,
      deck: str(b.deck, 10, /^(desktop|mobile)$/),
      sessionSec: num(b.sessionSec, 0, 86_400),
      audioSec: num(b.audioSec, 0, 86_400),
      poweredAtSec: num(b.poweredAtSec, 0, 86_400),
      firstTouchSec: num(b.firstTouchSec, 0, 86_400),
      scrollStrips: num(b.scrollStrips, 0, 40),
      liveFallback: typeof b.liveFallback === "boolean" ? b.liveFallback : null,
      viewport: str(b.viewport, 10, /^(small|medium|large)$/),
      dpr: num(b.dpr, 0, 10),
      reducedMotion: b.reducedMotion ? 1 : 0,
      controls: counts(b.controls),
      panels: counts(b.panels),
      strips: counts(b.strips),
      found: counts(b.found),
      faults: counts(b.faults),
      order: names(b.order),
      maxRung: num(b.maxRung, 0, 3),
      maxRate: num(b.maxRate, 0, 1000),
      minCabin: num(b.minCabin, -60, 80),
      maxCabin: num(b.maxCabin, -60, 80),
      errors: lines(b.errors),
      wsDrops: num(b.wsDrops, 0, 1000),
      assetFails: num(b.assetFails, 0, 1000),
      // Audio diagnostics, added to chase a phone-only fault. These describe a
      // browser rather than a person, and the UA is already in the request log.
      acState: str(b.acState, 20, /^[a-z]+$/),
      acRate: num(b.acRate, 0, 400000),
      choirBuffers: num(b.choirBuffers, 0, 500),
      choirState: str(b.choirState, 120, /^[\x20-\x7E\u2026]*$/),
      voicesPeak: num(b.voicesPeak, 0, 64),
      ua: str(b.ua, 120, /^[\x20-\x7E]*$/),
    };
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/beacon" && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return new Response("too large", { status: 413 });
      let body;
      try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
      if (!body || typeof body !== "object") return new Response("bad body", { status: 400 });

      const s = SessionStats.#clean(body);
      // Day granularity, UTC, and nothing finer is stored anywhere on this row.
      const day = new Date().toISOString().slice(0, 10);
      if (this.capDay !== day) {
        this.capDay = day;
        this.capN = [...this.state.storage.sql.exec(`SELECT COUNT(*) AS n FROM sessions WHERE day = ?`, day)][0].n;
      }
      if (this.capN >= DAY_CAP) return new Response(null, { status: 204 });
      await this.state.storage.sql.exec(
        `INSERT INTO sessions (day, deck, session_sec, audio_sec, scroll_strips, max_rung, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        day, s.deck, s.sessionSec, s.audioSec, s.scrollStrips, s.maxRung, JSON.stringify(s),
      );
      this.capN++;
      return new Response(null, { status: 204 });
    }

    // Read side, for the operator's own rollups. Whole days only, because a
    // narrower window is not a question this store exists to answer.
    if (url.pathname === "/sessions" && request.method === "GET") {
      const day = url.searchParams.get("day");
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return new Response(JSON.stringify({ error: "day=YYYY-MM-DD required" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      const rows = [...this.state.storage.sql.exec(
        `SELECT summary FROM sessions WHERE day = ? ORDER BY id`, day,
      )].map((r) => JSON.parse(r.summary));
      return new Response(JSON.stringify({ day, count: rows.length, sessions: rows }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/days" && request.method === "GET") {
      const rows = [...this.state.storage.sql.exec(
        `SELECT day, COUNT(*) AS n FROM sessions GROUP BY day ORDER BY day`,
      )];
      return new Response(JSON.stringify({ days: rows }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }
}
