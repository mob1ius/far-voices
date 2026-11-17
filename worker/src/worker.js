export { SessionStats } from "./sessionstats.js";
export { RelayHub } from "./hub.js";
export { RequestLog } from "./requestlog.js";
import { EmailMessage } from "cloudflare:email";
import { timingSafeEqual } from "./auth.js";

// There used to be a User-Agent check here that sent phones to a separate,
// simpler deck. It is gone: the console itself now works on a phone. It opens
// framed on the window and pans in both directions, and it decides that from
// the viewport rather than from the User-Agent, which is the check that
// actually answers the question. A desktop browser dragged narrow gets the
// same treatment, which the old comment here noted as the known blind spot of
// doing it server-side.
//
// deck_mobile.html is still served if asked for by name. Nothing routes to it.

// The site has exactly one legitimate origin. /live and /publish are same
// purpose endpoints on that one origin, so CORS is a fixed allowlist rather
// than a reflected Origin header -- reflecting Origin on a credentialed or
// state-changing endpoint is the classic CORS misconfiguration.
const ALLOWED_ORIGINS = new Set([
  "https://farvoices.com",
  "https://www.farvoices.com",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = new Headers();
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function securityHeaders(headers) {
  // Defense in depth beyond input sanitization. Every page's script lives in
  // its own file and no page uses inline on*= handlers, so this CSP can be
  // strict for real rather than carrying the 'unsafe-inline' that makes most
  // of them decorative.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), usb=()");
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // No 'unsafe-inline'. Each page carries exactly one script and it now
      // lives in its own file, so the allowance that makes most CSPs
      // decorative is simply not needed here. The <script type="application/
      // json"> data blocks are unaffected: browsers do not execute them, so
      // script-src does not gate them -- verified in a browser before making
      // this change, since getting it wrong would have broken the deck's
      // entire dataset rather than failing loudly.
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "media-src 'self'",
      "connect-src 'self' wss://farvoices.com wss://www.farvoices.com",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  return headers;
}

// Request logging, as described on the privacy page. Fire-and-forget through
// ctx.waitUntil so a slow write never delays a response and a failed one never
// breaks the site.
//
// The site's own automated traffic is not logged, but only when it looks like
// the real thing: a recognised agent, on one of its own endpoints, that
// succeeded. A request that only claims one of these agents still gets a row.
const SELF_UA = /^(ison\/|farvoices-watchdog\/|farvoices-export\/|farvoices-report\/)/;
const SELF_PATH = /^\/(publish|status|admin\/[a-z-]+)$/;

function isSelfTraffic(request, status) {
  if (!SELF_UA.test(request.headers.get("User-Agent") || "")) return false;
  return status >= 200 && status < 300 && SELF_PATH.test(new URL(request.url).pathname);
}

// Per-visitor throttles. The bindings are optional, so a local run without
// them behaves as before. A failure of the limiter itself never blocks a
// visitor.
async function allowed(env, name, request) {
  const lim = env[name];
  if (!lim) return true;
  try {
    const { success } = await lim.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    return success;
  } catch {
    return true;
  }
}

const tooMany = () =>
  new Response("slow down", { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });

function logRequest(ctx, env, request, status) {
  if (!env.LOGS) return;
  if (isSelfTraffic(request, status)) return;
  // /beacon carries the anonymous session summary. Logging it here would write
  // the visitor's address down beside the moment that summary arrived, and the
  // summary store files rows against the day precisely so the two cannot be
  // lined up. Logging this request would hand back the join and make the whole
  // separation decorative. /privacy.html states that it is left out; this is
  // the line that makes that true.
  if (new URL(request.url).pathname === "/beacon") return;
  const cf = request.cf || {};
  const url = new URL(request.url);
  const row = {
    ip: request.headers.get("CF-Connecting-IP"),
    asn: cf.asn,
    as_org: cf.asOrganization,
    country: cf.country,
    // Kept for the stored schema; filled from the User-Agent at read time.
    bot_category: null,
    bot_verified: cf.botManagement ? !!cf.botManagement.verifiedBot : false,
    method: request.method,
    path: url.pathname,
    status,
    ua: request.headers.get("User-Agent"),
    // Origin and path only, never the query string: a referring URL's query
    // can carry a search term someone typed, a session token, or a name, and
    // none of that is any of this site's business. A malformed value is
    // dropped rather than stored raw.
    referer: (() => {
      const raw = request.headers.get("Referer");
      if (!raw) return null;
      try {
        const r = new URL(raw);
        return (r.origin + r.pathname).slice(0, 300);
      } catch {
        return null;
      }
    })(),
  };
  const id = env.LOGS.idFromName("singleton");
  const stub = env.LOGS.get(id);
  ctx.waitUntil((async () => {
    if (!(await allowed(env, "RL_LOG", request))) return;
    await stub.fetch("https://internal/log", {
      method: "POST",
      body: JSON.stringify(row),
      headers: { "content-type": "application/json" },
    });
  })().catch(() => {}));
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// The report arrives as JSON from a scheduled task. Bounded well
// under the 25 MiB limit for verified destinations; a real week is ~100 KB.
const REPORT_MAX_BYTES = 4 * 1024 * 1024;

function logsStub(env) {
  return env.LOGS.get(env.LOGS.idFromName("singleton"));
}

async function reportMeta(env) {
  const r = await logsStub(env).fetch("https://internal/meta/report");
  return r.json();
}

async function recordReport(env, meta) {
  await logsStub(env).fetch("https://internal/meta/report", {
    method: "POST", body: JSON.stringify(meta), headers: { "content-type": "application/json" },
  });
}

// Build a raw RFC 5322 message for the EmailMessage fallback path.
function mimeMessage({ from, to, subject, text, html, attachment }) {
  const b64wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
  const enc = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const bytesB64 = (s) => b64wrap(enc(s));
  const outer = "fv-mixed-" + crypto.randomUUID();
  const inner = "fv-alt-" + crypto.randomUUID();
  const lines = [
    `From: Far Voices Station Log <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${enc(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@farvoices.com>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    "",
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    "",
    `--${inner}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    bytesB64(text),
    `--${inner}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    bytesB64(html),
    `--${inner}--`,
  ];
  if (attachment) {
    lines.push(
      `--${outer}`,
      `Content-Type: ${attachment.type}; name="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      b64wrap(attachment.content_b64),
    );
  }
  lines.push(`--${outer}--`, "");
  return lines.join("\r\n");
}

// Send through the Email Service API first; if that path is not available on
// this account (it is newer than Email Routing), fall back to the original
// EmailMessage API, which has always delivered to verified destinations.
async function deliver(env, msg) {
  try {
    const r = await env.REPORT_MAIL.send({
      to: env.REPORT_TO,
      from: { email: env.REPORT_FROM, name: "Far Voices Station Log" },
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachment ? [{
        filename: msg.attachment.filename, type: msg.attachment.type,
        disposition: "attachment", content: msg.attachment.content_b64,
      }] : undefined,
    });
    return { via: "send", messageId: r && r.messageId };
  } catch (first) {
    try {
      const raw = mimeMessage({ from: env.REPORT_FROM, to: env.REPORT_TO, ...msg });
      await env.REPORT_MAIL.send(new EmailMessage(env.REPORT_FROM, env.REPORT_TO, raw));
      return { via: "EmailMessage", firstError: String(first && (first.code || first.message) || first) };
    } catch (second) {
      const err = new Error("both send paths failed");
      err.detail = {
        send: String(first && (first.code || first.message) || first),
        emailMessage: String(second && (second.code || second.message) || second),
      };
      throw err;
    }
  }
}

async function handleReportMail(request, env) {
  if (!env.REPORT_MAIL) return json({ error: "REPORT_MAIL binding missing" }, 500);
  const text = await request.text();
  if (text.length > REPORT_MAX_BYTES) return json({ error: "too large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
  const msg = {
    subject: str(body.subject, 200), html: str(body.html, REPORT_MAX_BYTES), text: str(body.text, 200_000),
  };
  const week = str(body.week, 10);
  if (!msg.subject || !msg.html || !msg.text || !week || !/^\d{4}-W\d{2}$/.test(week)) {
    return json({ error: "subject, html, text and week (YYYY-Www) are required" }, 400);
  }
  const a = body.attachment;
  if (a) {
    if (!str(a.filename, 80) || !/^[\w.-]+$/.test(a.filename) || a.type !== "text/html" || !str(a.content_b64, REPORT_MAX_BYTES)) {
      return json({ error: "attachment must be {filename, type: text/html, content_b64}" }, 400);
    }
    msg.attachment = { filename: a.filename, type: a.type, content_b64: a.content_b64 };
  }
  try {
    const result = await deliver(env, msg);
    await recordReport(env, { week, sentAt: Date.now(), via: result.via });
    return json({ ok: true, week, ...result });
  } catch (e) {
    return json({ error: e.message, detail: e.detail || null }, 502);
  }
}

// Monday 20:00 UTC: if this week's report has not gone out, say so. Mail
// only, never retries the report itself -- the report needs the operator's
// machine, and a missing one usually means that machine was asleep or off.
async function checkReportSent(env) {
  if (!env.REPORT_MAIL) return;
  const meta = await reportMeta(env);
  const sentAt = meta && meta.sentAt ? meta.sentAt : 0;
  if (Date.now() - sentAt < 20 * 3_600_000) return;
  const last = sentAt ? new Date(sentAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never";
  const note = `No weekly station report has been sent today. Last report: ${meta && meta.week ? meta.week + ", " : ""}${last}.\n\n`
    + "The report is sent by a scheduled task outside this worker. Check that the task ran.";
  try {
    await deliver(env, { subject: "Far Voices station report missed", text: note, html: `<p>${note.replace(/\n/g, "<br>")}</p>` });
  } catch {
    // Nothing further to do from a cron with no one to tell.
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkReportSent(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const respond = (resp) => {
      logRequest(ctx, env, request, resp.status);
      return resp;
    };

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request);
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return respond(new Response(null, { status: 204, headers }));
    }

    // Read-only view onto RequestLog for the site operator. A separate
    // token from PUBLISH_TOKEN on purpose: publishing telemetry frames and
    // reading visitor logs are different trust levels, and conflating them
    // would let a leaked publisher credential also expose visitor IPs.
    if (url.pathname === "/admin/logs") {
      const auth = request.headers.get("Authorization") || "";
      const expected = `Bearer ${env.ADMIN_TOKEN}`;
      if (!env.ADMIN_TOKEN || !timingSafeEqual(auth, expected)) {
        return respond(new Response("unauthorized", { status: 401 }));
      }
      const id = env.LOGS.idFromName("singleton");
      const stub = env.LOGS.get(id);
      const resp = await stub.fetch(`https://internal/query${url.search}`);
      return respond(new Response(resp.body, {
        status: resp.status,
        headers: { "content-type": "application/json" },
      }));
    }

    // Weekly station report delivery. Its own token, a third trust level:
    // REPORT_TOKEN can send one email to the operator and read when the last
    // one went out, nothing else. It cannot read visitor logs or publish.
    if (url.pathname === "/admin/report-mail" || url.pathname === "/admin/report-status") {
      const auth = request.headers.get("Authorization") || "";
      if (!env.REPORT_TOKEN || !timingSafeEqual(auth, `Bearer ${env.REPORT_TOKEN}`)) {
        return respond(new Response("unauthorized", { status: 401 }));
      }
      if (url.pathname === "/admin/report-status") {
        return respond(json(await reportMeta(env)));
      }
      if (request.method !== "POST") return respond(new Response("method not allowed", { status: 405 }));
      return respond(await handleReportMail(request, env));
    }

    // The weekly ground report for the deck's teleprinter. A fourth trust
    // level, deliberately not REPORT_TOKEN: that one mails the operator, and
    // this one puts text in front of every listener on the site. A leak of
    // either should not grant the other.
    if (url.pathname === "/admin/console-report") {
      const auth = request.headers.get("Authorization") || "";
      if (!env.CONSOLE_TOKEN || !timingSafeEqual(auth, `Bearer ${env.CONSOLE_TOKEN}`)) {
        return respond(new Response("unauthorized", { status: 401 }));
      }
      if (request.method !== "POST") return respond(new Response("method not allowed", { status: 405 }));
      const stub = env.HUB.get(env.HUB.idFromName("singleton"));
      const resp = await stub.fetch("https://internal/report-push", {
        method: "POST", body: await request.text(),
        headers: { "content-type": "application/json" },
      });
      return respond(new Response(resp.body, {
        status: resp.status, headers: { "content-type": "application/json" },
      }));
    }

    // The anonymous session summary. No token: it comes from a visitor's
    // browser. Nothing it can say is trusted, and the object behind it rebuilds
    // every field rather than storing what was sent.
    if (url.pathname === "/beacon") {
      if (request.method !== "POST") return respond(new Response("method not allowed", { status: 405 }));
      if (!env.SESSIONS) return respond(new Response(null, { status: 204 }));
      // A real beacon comes from a page on this origin. Browsers say so; a
      // script on another site cannot fake that header. Absent is allowed.
      const site = request.headers.get("Sec-Fetch-Site");
      if (site && site !== "same-origin") return respond(new Response("forbidden", { status: 403 }));
      if (!(await allowed(env, "RL_BEACON", request))) return tooMany();
      // Turn away a declared-oversized or undeclared-length body before
      // request.text() reads it.
      const len = Number(request.headers.get("content-length"));
      if (!Number.isFinite(len) || len <= 0 || len > 16_000) return respond(new Response("too large", { status: 413 }));
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName("singleton"));
      const resp = await stub.fetch("https://internal/beacon", {
        method: "POST", body: await request.text(),
        headers: { "content-type": "application/json" },
      });
      return respond(new Response(null, { status: resp.status === 204 ? 204 : resp.status }));
    }

    // Read side for the operator, behind the same token as the request log.
    if (url.pathname === "/admin/sessions" || url.pathname === "/admin/session-days") {
      const auth = request.headers.get("Authorization") || "";
      if (!env.ADMIN_TOKEN || !timingSafeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) {
        return respond(new Response("unauthorized", { status: 401 }));
      }
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName("singleton"));
      const path = url.pathname === "/admin/sessions" ? "/sessions" : "/days";
      const resp = await stub.fetch(`https://internal${path}${url.search}`);
      return respond(new Response(resp.body, {
        status: resp.status, headers: { "content-type": "application/json" },
      }));
    }

    if (url.pathname === "/live" || url.pathname === "/publish" || url.pathname === "/status") {
      if (url.pathname === "/status" && !(await allowed(env, "RL_STATUS", request))) return tooMany();
      if (url.pathname === "/live" && !(await allowed(env, "RL_LIVE", request))) return tooMany();
      if (url.pathname === "/publish") {
        // A frame is a few kilobytes. Refuse anything else before the hub
        // buffers it: no declared length, or a large one.
        const len = Number(request.headers.get("content-length"));
        if (request.method === "POST" && (!Number.isFinite(len) || len <= 0 || len > 16 * 1024)) {
          return respond(new Response("too large", { status: 413 }));
        }
      }
      // A single global hub.
      const id = env.HUB.idFromName("singleton");
      const stub = env.HUB.get(id);
      const resp = await stub.fetch(request);
      // WebSocket upgrade responses (status 101) cannot carry extra headers
      // through the standard Response path -- only decorate plain HTTP ones.
      if (resp.status === 101) { logRequest(ctx, env, request, 101); return resp; }
      const headers = new Headers(resp.headers);
      for (const [k, v] of corsHeaders(request)) headers.set(k, v);
      securityHeaders(headers);
      return respond(new Response(resp.body, { status: resp.status, headers }));
    }

    // The root path is the only one that needs a decision made for it, and
    // there is only one deck to decide on now. Anyone linking straight to
    // /deck_mobile.html still gets that file, deliberately unoverridden.
    let assetRequest = request;
    if (url.pathname === "/" || url.pathname === "/index.html") {
      assetRequest = new Request(new URL("/deck_cockpit.html", url), request);
    }

    // Everything else is the static deck, served from the assets binding.
    let resp = await env.ASSETS.fetch(assetRequest);
    // Misses reach this Worker so they can be logged; the 404 page is served
    // here, still with a 404 status.
    if (resp.status === 404) {
      if (!(await allowed(env, "RL_MISS", request))) return tooMany();
      // A bare GET: the visitor's If-None-Match or Range headers belong to the
      // path they asked for, and passed on here could turn the page into a 304.
      const page = await env.ASSETS.fetch(new URL("/404.html", url));
      if (page.ok) resp = new Response(page.body, { status: 404, headers: page.headers });
    }
    const headers = securityHeaders(new Headers(resp.headers));
    return respond(new Response(resp.body, { status: resp.status, headers }));
  },
};
