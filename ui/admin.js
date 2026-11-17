"use strict";
const $=id=>document.getElementById(id);
const KEY="fv_admin_token";
const PAGE_SIZE=200;

// Paths a scanner reaches for that a real visitor to a static choir/telemetry
// site never would. Flagging these -- not filtering them out -- is the point:
// a flagged row is exactly the "is this a scanner" signal this log exists for.
// This stays a client-side, page-scoped heuristic (not a server filter)
// because it's a compound rule over path AND status together, not one
// column a single query param can express.
const SCAN_PATTERNS=[
  /wp-(login|admin|content)/i,/\.env$/i,/\.git\//i,/phpmyadmin/i,/xmlrpc\.php/i,
  /\.(php|asp|aspx|jsp)$/i,/eval-stdin/i,/\/\.\./,/cgi-bin/i,/config\.(json|yml|yaml)$/i,
  /vendor\/phpunit/i,/actuator/i,/telescope/i,/debug\/default\//i,
];
// /favicon.ico is every browser's own automatic, unprompted request against
// any site that doesn't declare one -- extremely common and not scanner
// behaviour. Flagging it would make the single most frequent false positive
// in real traffic, drowning out the genuine signal this view exists for.
const BENIGN_404 = new Set(["/favicon.ico", "/robots.txt", "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png"]);
function isSuspect(row){
  if(SCAN_PATTERNS.some(re=>re.test(row.path))) return true;
  if(BENIGN_404.has(row.path)) return false;
  if(row.status===404 && !/\.(js|css|png|jpg|woff2?|mid|opus|json)$/i.test(row.path)) return true;
  return false;
}
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

// Mirror of DECLARED_BOT_LIKE / SELF_UA_LIKE in worker/src/requestlog.js --
// the server filters on it, this labels the Bot column. Keep them in step.
const DECLARED_BOT = /bot|crawl|spider|slurp|headless|^curl\/|^wget\/|^python-(requests|urllib|httpx)\/|^aiohttp\/|^go-http-client\/|^java\/|^okhttp\/|^libwww-perl\/|^scrapy\/|^node-fetch\/|^axios\/|^undici|httpclient|zgrab|masscan|nmap|nuclei|censys|facebookexternalhit/i;
const SELF_UA = /^ison\/|^farvoices-(watchdog|export|report)\//i;
function botLabel(r){
  if(r.bot_verified) return `<span class="bot">${esc(r.bot_category||"verified")}</span>`;
  const ua=r.ua||"";
  if(!ua) return '<span class="bot">no UA</span>';
  if(SELF_UA.test(ua)) return '<span style="color:var(--faint)">self</span>';
  if(DECLARED_BOT.test(ua)) return '<span class="bot">declared</span>';
  return "";
}

let rows=[];
let flagOnly=true;          // page-scoped quick toggle, on by default (matches old default view)
let botOnly=false;          // has no matching input element, so currentParams() reads it directly
// Five minutes: the publisher posts every few seconds, so anything approaching
// this without a single row is a logging outage rather than a quiet moment.
const GAP_MS=5*60*1000;
let hasMore=false;
// Cursor-stack pagination: cursorStack[i] is the cursor that FETCHED page i.
// "Older" pushes the server's nextCursor and fetches with it. "Newer" pops
// back to the previous entry and re-fetches -- re-issuing a query the
// server already proved correct, rather than a separate reverse-direction
// endpoint that could disagree with it.
let cursorStack=[null];

function currentParams(extra){
  const p=new URLSearchParams();
  p.set("limit", PAGE_SIZE);
  const cursor=cursorStack[cursorStack.length-1];
  if(cursor!=null) p.set("cursor", cursor);
  const fields={ip:"fIp",asn:"fAsn",as_org:"fOrg",country:"fCountry",method:"fMethod",
    path:"fPath",status:"fStatus",status_min:"fStatusMin",ua:"fUa"};
  for(const[param,id]of Object.entries(fields)){
    const v=$(id).value.trim();
    if(v) p.set(param,v);
  }
  const since=$("fSince").value, until=$("fUntil").value;
  if(since) p.set("since", String(new Date(since).getTime()));
  if(until) p.set("until", String(new Date(until).getTime()));
  // Declared bots by User-Agent. The old bot=true filtered on Cloudflare's
  // verified-bot flag, which this plan never sets, so it always came back empty.
  if(botOnly) p.set("uabot","true");
  if(extra) for(const[k,v]of Object.entries(extra)) p.set(k,v);
  return p;
}

function render(){
  const shown = flagOnly ? rows.filter(isSuspect) : rows;
  $("stat").textContent=`${shown.length} / ${rows.length} shown this page`;
  const wrap=$("wrap");
  if(!rows.length){ wrap.innerHTML='<div class="empty">No log entries match.</div>'; return; }
  const t=document.createElement("table");
  t.innerHTML=`<thead><tr>
    <th>Time (UTC)</th><th>IP</th><th>ASN / Org</th><th>Country</th>
    <th>Method</th><th>Path</th><th>Status</th><th>Bot</th><th>User-Agent</th>
  </tr></thead><tbody></tbody>`;
  const tb=t.querySelector("tbody");
  // A gap in this log is invisible unless something draws it. On 2026-09-08 the
  // account hit the Durable Objects rows_written cap and every INSERT was
  // rejected for 9.4 hours -- the site served fine throughout (publish.py logged
  // continuous 200s), but logRequest() is fire-and-forget with .catch(()=>{}),
  // so the log simply stopped and nothing said so. Reading it afterwards you see
  // a shorter list, not a hole.
  //
  // The publisher posts a frame every few seconds around the clock, which makes
  // it a heartbeat for the log itself: any stretch longer than a few minutes with
  // no entry at all means logging stopped, not that the internet went quiet.
  let prevTs=null;
  for(const r of shown){
    if(prevTs!==null && prevTs-r.ts > GAP_MS){
      const gap=document.createElement("tr");
      gap.className="gap";
      const mins=(prevTs-r.ts)/60000;
      gap.innerHTML=`<td colspan="9">no entries for ${mins>=90?(mins/60).toFixed(1)+" hours":Math.round(mins)+" minutes"}
        \u2014 ${new Date(r.ts).toISOString().slice(0,16).replace("T"," ")} to
        ${new Date(prevTs).toISOString().slice(0,16).replace("T"," ")} UTC.
        The publisher posts continuously, so a gap this long means logging stopped, not traffic.</td>`;
      tb.appendChild(gap);
    }
    prevTs=r.ts;
    const tr=document.createElement("tr");
    if(isSuspect(r)) tr.className="suspect";
    const d=new Date(r.ts);
    const time=d.toISOString().slice(0,19).replace("T"," ");
    const okStatus=r.status>=200&&r.status<400;
    tr.innerHTML=`
      <td>${time}</td>
      <td class="ip" title="Search this IP">${esc(r.ip||"--")}</td>
      <td>${r.asn?("AS"+r.asn):"--"} <span style="color:var(--faint)">${esc(r.as_org||"")}</span></td>
      <td>${esc(r.country||"--")}</td>
      <td>${esc(r.method||"")}</td>
      <td class="path" title="Search this path">${esc(r.path||"")}${isSuspect(r)?' <span class="flag">scan-like</span>':""}</td>
      <td><span class="status ${okStatus?"ok":"err"}">${r.status}</span></td>
      <td>${botLabel(r)}</td>
      <td class="ua" title="${esc(r.ua||"")}">${esc(r.ua||"")}</td>`;
    tr.querySelector(".ip").onclick=()=>{ $("fIp").value=r.ip||""; runSearch(); };
    tr.querySelector(".path").onclick=()=>{ $("fPath").value=r.path||""; runSearch(); };
    tb.appendChild(tr);
  }
  wrap.innerHTML=""; wrap.appendChild(t);
}

async function load(){
  const token=sessionStorage.getItem(KEY); if(!token) return;
  $("stat").textContent="loading...";
  try{
    const params=currentParams();
    const r=await fetch("/admin/logs?"+params.toString(),{headers:{Authorization:"Bearer "+token}});
    if(r.status===401){ sessionStorage.removeItem(KEY); showGate("token rejected"); return; }
    // Anything else non-OK carries a reason -- show it. The server now rejects a
    // malformed numeric filter instead of quietly ignoring it, and that is only
    // an improvement if the rejection is visible: falling through to
    // `data.rows||[]` would render an empty table and call it "empty", which is
    // the same silent widening problem moved from the server to the screen.
    if(!r.ok){
      const body=await r.json().catch(()=>({}));
      rows=[]; hasMore=false; render();
      $("stat").textContent = body.error ? "rejected — "+body.error : `request failed (${r.status})`;
      $("pageStat").textContent = body.hint || "";
      $("newer").disabled = cursorStack.length<=1; $("older").disabled = true;
      return;
    }
    const data=await r.json();
    rows=data.rows||[];
    hasMore=!!data.hasMore;
    render();
    $("newer").disabled = cursorStack.length<=1;
    $("older").disabled = !hasMore;
    const pageNum=cursorStack.length;
    $("pageStat").textContent = rows.length
      ? `page ${pageNum} · ${rows.length} rows${hasMore?" · more available":""}`
      : `page ${pageNum} · empty`;
  }catch(e){ $("stat").textContent="fetch failed: "+e.message; }
}
function runSearch(){ cursorStack=[null]; load(); }

function showGate(msg){
  $("wrap").innerHTML=`<div class="gate">
    <p>${msg?esc(msg)+" -- try again.":"Enter the admin token to view request logs."}</p>
    <input id="token" type="password" placeholder="ADMIN_TOKEN" autofocus>
    <div><button class="primary" id="enter">Enter</button></div>
  </div>`;
  $("filterBar").hidden=true; $("pagebar").hidden=true;
  wireGate();
}
function wireGate(){
  const go=()=>{ const v=$("token").value.trim(); if(!v)return;
    sessionStorage.setItem(KEY,v);
    $("filterBar").hidden=false; $("pagebar").hidden=false;
    load(); };
  $("enter").onclick=go;
  $("token").addEventListener("keydown",e=>{ if(e.key==="Enter") go(); });
}
wireGate();

// The three preset chips are mutually exclusive shortcuts for the status/bot
// filters specifically -- each one owns clearing the other two's fields so
// switching between them can't silently combine "errors" with "declared
// bots only" from a leftover previous click. "Flagged" is a separate axis
// (a page-scoped heuristic, not a server filter) and stays independent of
// all three, including "All" -- clicking All clears it too, since a button
// with that label showing a silently-filtered page would be the confusing
// outcome, not the honest one.
function setChip(id){
  for(const c of ["pAll","pErr","pBot"]) $(c).classList.toggle("on", c===id);
}
$("pAll").onclick=()=>{ setChip("pAll"); $("fStatus").value=""; $("fStatusMin").value="";
  $("fMethod").value=""; botOnly=false;
  flagOnly=false; $("pFlag").classList.remove("on");
  runSearch(); };
$("pErr").onclick=()=>{ setChip("pErr"); $("fStatus").value=""; $("fStatusMin").value="400";
  botOnly=false; runSearch(); };
$("pBot").onclick=()=>{ setChip("pBot"); $("fStatus").value=""; $("fStatusMin").value="";
  botOnly=true; runSearch(); };
$("pFlag").onclick=e=>{ flagOnly=!flagOnly; e.target.classList.toggle("on",flagOnly); render(); };

$("search").onclick=runSearch;
for(const id of ["fIp","fAsn","fOrg","fCountry","fPath","fStatus","fStatusMin","fUa"])
  $(id).addEventListener("keydown",e=>{ if(e.key==="Enter") runSearch(); });
$("fMethod").onchange=runSearch;
// The date inputs were in buildParams() and in clear(), but wired to nothing:
// the Enter handler above covers only the text fields, so picking a time range
// and waiting produced silence until you happened to search something else.
// datetime-local fires change on commit, which is exactly the moment to run.
$("fSince").onchange=runSearch;
$("fUntil").onchange=runSearch;
$("clear").onclick=()=>{
  for(const id of ["fIp","fAsn","fOrg","fCountry","fPath","fStatus","fStatusMin","fUa","fSince","fUntil"])
    $(id).value="";
  $("fMethod").value="";
  setChip("pAll"); botOnly=false;
  runSearch();
};
$("refresh").onclick=()=>load();
$("signout").onclick=()=>{ sessionStorage.removeItem(KEY); rows=[]; showGate(); };
$("newer").onclick=()=>{ if(cursorStack.length>1){ cursorStack.pop(); load(); } };
$("older").onclick=()=>{ if(hasMore && rows.length){ cursorStack.push(rows[rows.length-1].id); load(); } };

let timer=null;
$("auto").onchange=e=>{
  clearInterval(timer);
  if(e.target.checked) timer=setInterval(()=>{
    // Auto-refresh only makes sense pinned to the newest page -- refreshing
    // an older page out from under someone mid-review would just be
    // confusing, and cursors for a page that's since scrolled off the
    // retention window could start returning nothing anyway.
    if(cursorStack.length===1) load();
  },15000);
};

if(sessionStorage.getItem(KEY)){ $("filterBar").hidden=false; $("pagebar").hidden=false; load(); }
