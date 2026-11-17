// RequestLog: verbose visitor/scanner/bot logging, with a real, enforced
// retention limit rather than a platform default.
//
// Analytics Engine was the obvious first choice -- it's Cloudflare's
// purpose-built tool for exactly this -- but its retention is a fixed 90
// days with no customer control over it. The retention period here is a
// disclosed privacy commitment, not an implementation detail, so it has to
// be exact. A Durable Object with its own SQLite storage and a daily alarm
// gives precise control over deletion, and this project already pays for
// Durable Objects for RelayHub, so this adds no new product or plan tier.
//
// What gets stored, and why each field earns its place for spotting a
// scanner or a bot rather than just counting hits: the real client IP (from
// CF-Connecting-IP, which Cloudflare's edge sets itself and a client cannot
// spoof, unlike X-Forwarded-For), ASN and organisation (a scanner's traffic
// clusters by hosting provider in a way real visitors' doesn't), country,
// Cloudflare's own verified-bot category when it has one, User-Agent, method,
// path, and status. No cookies, no fingerprinting beyond what the request
// already carries, no cross-referencing with anything else.

const RETENTION_DAYS = 30;
const DEFAULT_QUERY_ROWS = 100;
const MAX_QUERY_ROWS = 1000;

// Every column an admin can filter on, and how. Equality columns take an
// exact value; "like" columns do a substring match (the only shape a
// free-text search box actually needs). Whitelisted deliberately -- this
// map is what stands between a query-string param and a column name
// dropped into SQL, so a new filter means adding a line here, never
// string-building a column name from user input.
const EQ_FILTERS = {
  ip: "ip", asn: "asn", country: "country", method: "method", status: "status",
};
const LIKE_FILTERS = {
  path: "path", ua: "ua", as_org: "as_org", bot_category: "bot_category", referer: "referer",
};

// "Declared bots": requests whose User-Agent names itself as a crawler or a
// script. It only catches what declares itself; the path-based "scan-like"
// flag in the admin view covers the rest. SQLite's LIKE is case-insensitive for ASCII, so "Googlebot" and
// "GPTBot" both match '%bot%'. Mirrored in ui/admin.js as DECLARED_BOT; keep
// the two lists in step.
const DECLARED_BOT_LIKE = [
  "%bot%", "%crawl%", "%spider%", "%slurp%", "%headless%",
  "curl/%", "wget/%", "python-requests/%", "python-urllib/%", "python-httpx/%",
  "aiohttp/%", "go-http-client/%", "java/%", "okhttp/%", "libwww-perl/%",
  "scrapy/%", "node-fetch/%", "axios/%", "undici%", "%httpclient%",
  "%zgrab%", "%masscan%", "%nmap%", "%nuclei%", "%censys%", "%facebookexternalhit%",
];
// The site's own traffic: publish.py sends farvoices.UA ("ison/0.1 ..."), the
// watchdog sends "farvoices-watchdog/1", the log export "farvoices-export/1" and
// the weekly report "farvoices-report/1". Excluded explicitly so they cannot
// start flooding this view if either UA or the pattern list changes.
const SELF_UA_LIKE = ["ison/%", "farvoices-watchdog/%", "farvoices-export/%", "farvoices-report/%"];

export class RequestLog {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = this.#init();
  }

  async #init() {
    await this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ip TEXT,
        asn INTEGER,
        as_org TEXT,
        country TEXT,
        bot_category TEXT,
        bot_verified INTEGER,
        method TEXT,
        path TEXT,
        status INTEGER,
        ua TEXT
      )
    `);
    await this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_ts ON requests(ts)`,
    );
    // Referer, added after the table already existed. SQLite has no
    // ADD COLUMN IF NOT EXISTS, so this reads the schema and only adds the
    // column when it is missing. Unlike DROPPING a column, ADD is a metadata
    // change: it does not rewrite the stored rows and so does not cost a
    // billed write each, which is what made the idx_ip backfill expensive.
    //
    // This is the field that answers "which post actually worked". Without it
    // a launch is unattributable: the traffic arrives and nothing says from
    // where. Stored as origin plus path with the query string removed, by the
    // Worker, before it ever reaches this object.
    const cols = [...this.state.storage.sql.exec(`PRAGMA table_info(requests)`)];
    if (!cols.some((c) => c.name === "referer")) {
      await this.state.storage.sql.exec(`ALTER TABLE requests ADD COLUMN referer TEXT`);
    }
    // No index on ip: each index doubles the write cost of every insert, and
    // building one over a populated table backfills every existing row.

    await this.state.storage.sql.exec(`DROP INDEX IF EXISTS idx_ip`);
    // The alarm is what actually enforces the 30-day promise. Set it once;
    // fetch() below reschedules it after every run, so it survives the DO
    // being evicted and revived between requests.
    const existing = await this.state.storage.getAlarm();
    if (existing === null) await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/log" && request.method === "POST") {
      let row;
      try {
        row = await request.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      await this.state.storage.sql.exec(
        `INSERT INTO requests (ts, ip, asn, as_org, country, bot_category,
                               bot_verified, method, path, status, ua, referer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        Date.now(),
        str(row.ip, 45),
        num(row.asn),
        str(row.as_org, 120),
        str(row.country, 8),
        str(row.bot_category, 40),
        row.bot_verified ? 1 : 0,
        str(row.method, 10),
        str(row.path, 300),
        num(row.status),
        str(row.ua, 300),
        str(row.referer, 300),
      );
      return new Response(null, { status: 204 });
    }

    // One small record: when the weekly report last went out. Kept here
    // rather than in a new KV namespace because this object already exists;
    // it costs one storage write a week.
    if (url.pathname === "/meta/report") {
      if (request.method === "POST") {
        const m = await request.json();
        await this.state.storage.put("report", {
          week: typeof m.week === "string" ? m.week.slice(0, 10) : null,
          sentAt: Number(m.sentAt) || Date.now(),
          via: typeof m.via === "string" ? m.via.slice(0, 20) : null,
        });
        return new Response(null, { status: 204 });
      }
      const meta = (await this.state.storage.get("report")) || { week: null, sentAt: null, via: null };
      return new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/query" && request.method === "GET") {
      return this.#handleQuery(url);
    }

    return new Response("not found", { status: 404 });
  }

  // Every numeric parameter goes through here so a malformed one is an error
  // rather than a silently dropped filter. The old shape was
  // `if (Number.isFinite(n)) { ...push the filter... }`, which meant
  // `status=1 OR 1=1` or a plain typo like `status=40o` produced NaN, skipped
  // the WHERE clause entirely, and returned UNFILTERED rows that look exactly
  // like filtered ones. Not an injection -- the value never reaches SQL -- but
  // in a tool whose whole job is "show me only these requests", quietly
  // widening the query is the worst possible failure mode.
  static #numeric(p, name, bad) {
    const raw = p.get(name);
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) { bad.push(name); return null; }
    return n;
  }

  // Keyset (id-based) pagination rather than OFFSET: this table gets a new
  // row every few seconds, so an OFFSET computed against "now" drifts under
  // you as soon as a newer row lands between two page loads -- classic
  // skipped-or-duplicated-row bug. `id` is autoincrement and strictly
  // ordered with `ts`, so "id < cursor" is a stable, O(log n) seek to
  // exactly where the previous page ended, no matter how much gets
  // inserted in between.
  //
  // Only one direction (older) is implemented server-side. A "previous
  // page" endpoint needs its own comparison/sort/re-reverse and is easy to
  // get subtly wrong -- and unnecessary, since the client already saw
  // every cursor it used to get here. Going back is just re-issuing the
  // same query with the second-to-last cursor off its own history stack,
  // which is simpler and cannot disagree with what the server already
  // proved was correct the first time.
  async #handleQuery(url) {
    const p = url.searchParams;
    const bad = [];
    const num = (name) => RequestLog.#numeric(p, name, bad);
    const limitRaw = num("limit");
    const limit = Math.min(MAX_QUERY_ROWS, Math.max(1, limitRaw ?? DEFAULT_QUERY_ROWS));
    const cursor = num("cursor");

    const where = [];
    const args = [];

    if (cursor !== null) { where.push("id < ?"); args.push(cursor); }
    const since = num("since");
    if (since !== null) { where.push("ts >= ?"); args.push(since); }
    const until = num("until");
    if (until !== null) { where.push("ts <= ?"); args.push(until); }

    for (const [param, col] of Object.entries(EQ_FILTERS)) {
      const v = p.get(param);
      if (!v) continue;
      if (col === "asn" || col === "status") {
        const n = num(param);
        if (n !== null) { where.push(`${col} = ?`); args.push(n); }
      } else {
        where.push(`${col} = ?`);
        args.push(v);
      }
    }
    for (const [param, col] of Object.entries(LIKE_FILTERS)) {
      const v = p.get(param);
      if (!v) continue;
      // Escape the wildcard characters SQLite's LIKE itself understands
      // (%, _) plus the escape character, so a search for a literal "%" or
      // "_" in a UA string can't widen the match into something the user
      // didn't ask for.
      const escaped = v.replace(/[\\%_]/g, (m) => `\\${m}`);
      where.push(`${col} LIKE ? ESCAPE '\\'`);
      args.push(`%${escaped}%`);
    }
    // An empty UA is itself a strong scanner signal, so it counts. It is tested
    // on its own branch because `ua NOT LIKE x` is NULL, not true, when ua is
    // NULL -- folding it into the exclusion clause would silently drop exactly
    // the rows most worth seeing.
    if (p.get("uabot") === "true") {
      const match = DECLARED_BOT_LIKE.map(() => "ua LIKE ?").join(" OR ");
      const notSelf = SELF_UA_LIKE.map(() => "ua NOT LIKE ?").join(" AND ");
      where.push(`((ua IS NULL OR ua = '') OR ((${match}) AND ${notSelf}))`);
      args.push(...DECLARED_BOT_LIKE, ...SELF_UA_LIKE);
    }

    // Separate from the exact-match `status` in EQ_FILTERS above -- "was
    // this one specific request a 404" and "show me every error" are
    // different questions, and status codes are the one column where a
    // range genuinely means something (there's no meaningful "ip between
    // x and y").
    const statusMin = num("status_min");
    if (statusMin !== null) { where.push("status >= ?"); args.push(statusMin); }
    const statusMax = num("status_max");
    if (statusMax !== null) { where.push("status <= ?"); args.push(statusMax); }

    // One extra row fetched, never returned, just to know whether the page
    // that got cut off actually continues -- cheaper than a second COUNT
    // query and exact regardless of which filters are active.
    if (bad.length) {
      return new Response(JSON.stringify({
        error: "non-numeric value for: " + bad.join(", "),
        hint: "these parameters take a number; a bad one is rejected rather than ignored, "
            + "so a filtered view is never silently wider than it looks",
      }), { status: 400, headers: { "content-type": "application/json" } });
    }

    const sql = `SELECT id, ts, ip, asn, as_org, country, bot_category, bot_verified, referer,
                        method, path, status, ua
                 FROM requests
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY id DESC
                 LIMIT ?`;
    args.push(limit + 1);

    const all = [...this.state.storage.sql.exec(sql, ...args)];
    const hasMore = all.length > limit;
    const rows = hasMore ? all.slice(0, limit) : all;

    return new Response(JSON.stringify({
      rows,
      retentionDays: RETENTION_DAYS,
      nextCursor: rows.length ? rows[rows.length - 1].id : null,
      hasMore,
    }), { headers: { "content-type": "application/json" } });
  }

  async alarm() {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    await this.state.storage.sql.exec(`DELETE FROM requests WHERE ts < ?`, cutoff);
    // Once a day is enough for a 30-day window; being late by a few hours
    // doesn't matter and this way a revived-but-idle DO isn't woken hourly
    // for nothing.
    await this.state.storage.setAlarm(Date.now() + 86_400_000);
  }
}
