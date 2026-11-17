"use strict";
const D=JSON.parse(document.getElementById('d1').textContent);
const F=D.frames, TONES=D.tones, SITES=D.sites, FLEET=D.fleet, STARS=D.stars;
/* Every one of these strings originates in an external feed (DSN telemetry)
   or the bundled fleet/star data. None of it is trusted for direct HTML
   interpolation -- validate the shaped fields (band, direction, dish id)
   against their known format and escape everything else. */
function esc(v){
  return String(v==null?'':v).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function bandOf(v){ return /^(S|X|K|Ka)$/.test(v) ? v : '?'; }
function dirOf(v){ return v==='up'||v==='down' ? v : '?'; }
function dishOf(v){ return /^[A-Z0-9]{2,8}$/.test(v) ? v : esc(v); }
const PARTS=[['S','Soprano'],['A','Alto'],['T','Tenor'],['B','Bass'],['O','Octavist'],['I','Ison']];
const SITEN={gdscc:'Goldstone',mdscc:'Madrid',cdscc:'Canberra'};
const FMAP={}; FLEET.forEach(f=>FMAP[f.id]=f);
const PITCHES=[]; for(let p=28;p<80;p+=3)PITCHES.push(p);
// Indices of lock events in whatever F currently holds -- rebuilt every time
// F is replaced by a tape. It used to be a const taken once from the baked
// 2,788-frame demo, so on a 28-frame permalink ← and → jumped to demo indices
// far past the end of F, and render() threw on the undefined frame.
let locks=[];
function rebuildLocks(){ locks=F.map((f,n)=>f.lock?n:-1).filter(n=>n>=0); }
rebuildLocks();
const $=i=>document.getElementById(i);

let i=0,playing=true,muted=false,tone=5,step=2200,timer=null,expanded=false;
let corpusKey='lyadov';
/* Each corpus supplies only the musical fields; the sky data is shared, so
   switching overlays one track onto the frames rather than duplicating them. */
function applyCorpus(k){
  const tr=(D.tracks||{})[k]; if(!tr) return;
  corpusKey=k;
  for(let n=0;n<F.length&&n<tr.frames.length;n++) Object.assign(F[n], tr.frames[n]);
  document.querySelectorAll('#corpusPick button').forEach(b=>
    b.classList.toggle('on', b.dataset.k===k));
  lastChord=null; lastVoices='';
  logLine('sys','CORPUS  '+tr.label.toUpperCase(), F[i].t.slice(11,19));
  render(); applyAudio(F[i]);
}
const EPOCH=Date.now();
let ORBIT_YPS=0;        // simulated DAYS added per real second
let simDays=0;
let yaw=0,pitch=-14,zoom=1,drag=null,hover=null,panX=0,panY=0,mapFocus='sun';

/* ---------- audio: real choir samples, no synthesis ---------- */
let AC=null,bus=null; const BUF={}; const live={};
// The choir samples used to be inlined as a <script id="d2"> blob, which put
// them in every page load whether or not anyone pressed Power Up. They are
// base64-encoded Ogg, so they do not compress -- 2.25 MB of the payload
// shrank only to 1.65 MB, against 94 KB for the far larger frame data, and
// made up ~90% of what a visitor downloaded before the boot screen was even
// usable. Fetching them here instead means the samples are paid for once, on
// demand, by people who actually asked to hear something, and shared between
// the two decks as one cacheable asset instead of embedded twice.
//
// This runs inside the Power Up handler, AFTER the AudioContext has been
// created and resumed synchronously with the click. That order is load
// bearing for the iOS audio unlock -- nothing here may move ahead of it.
async function loadChoir(){
  const say = t => { const el=$('choirState'); if(el) el.textContent=t; };
  say('fetching choir\u2026');
  // Plain fetch, not cache:'force-cache'. Cloudflare serves assets with
  // "max-age=0, must-revalidate" plus an etag, so a repeat visit costs one
  // conditional request and a 304 rather than the 1.65 MB body. force-cache
  // would save that small round-trip at the price of pinning a visitor to a
  // stale choir forever if the samples are ever rebuilt, which is a bad trade
  // for an asset whose filename carries no version.
  const res = await fetch('choir.json');
  if(!res.ok) throw new Error('choir.json ' + res.status);
  const SAMP = await res.json();
  const keys=Object.keys(SAMP); let done=0;
  say('decoding choir: 0/' + keys.length);
  await Promise.all(keys.map(async k=>{
    const b=atob(SAMP[k]), u=new Uint8Array(b.length);
    for(let n=0;n<b.length;n++)u[n]=b.charCodeAt(n);
    BUF[k]=await AC.decodeAudioData(u.buffer);
    say('decoding choir: ' + (++done) + '/' + keys.length);
  }));
  say('choir ready');
}
window.__FV={get ac(){return AC},get live(){return live},get buf(){return BUF}};

/* ---------- live feed: connect first, fall back to the recorded frames
   already baked into F if the feed can't be reached in time. -------------- */
const NASA_FACTS=[
"Voyager 1, launched in 1977, is the most distant human-made object -- over 15 billion miles from Earth.",
"Light from the Sun takes about 8 minutes and 20 seconds to reach Earth.",
"The Deep Space Network has three complexes -- Goldstone, Madrid, Canberra -- spaced so at least one always faces deep space as Earth turns.",
"A round-trip radio signal to Mars takes between 6 and 44 minutes, depending on where the planets are.",
"The James Webb Space Telescope orbits the Sun near Earth-Sun Lagrange point 2, 1.5 million kilometres out.",
"New Horizons flew past Pluto in July 2015, nine and a half years after launch.",
"The Parker Solar Probe is the fastest human-made object, exceeding 690,000 km/h at closest approach to the Sun.",
"The Apollo Guidance Computer had a fraction of the processing power of a modern calculator.",
"The Hubble Space Telescope has operated since 1990, orbiting about 540 km above Earth.",
"Saturn's moon Titan has lakes and rivers of liquid methane and ethane.",
"The International Space Station completes an orbit of Earth roughly every 90 minutes.",
"Mars Reconnaissance Orbiter has circled Mars since 2006, longer than any other Mars orbiter.",
"The Deep Space Network's largest dishes are 70 metres across -- wide enough to cover a football field.",
"Juno reached Jupiter in 2016 on solar power alone, the first outer-planet mission not to use a nuclear generator.",
"Each Voyager probe carries a golden record of sounds and images from Earth, for any spacefaring civilization that might find it.",
"Sound doesn't travel in the vacuum of space -- every space-mission 'sound' is data converted to audio, not a real recording.",
"The Sun holds about 99.86% of the mass in the solar system.",
"OSIRIS-REx returned a sample of asteroid Bennu to Earth in September 2023.",
"A day on Venus is longer than its year: 243 Earth days to rotate once, 225 to orbit the Sun.",
"The Chandra X-ray Observatory studies some of the hottest, most energetic objects in the universe from Earth orbit.",
"Curiosity has been drilling into Mars's Gale Crater since 2012 to study the planet's history.",
"Radio signals travel at the speed of light, but deep space is so vast that light-minutes still separate us from our own spacecraft.",
"Europa, a moon of Jupiter, is thought to hold a saltwater ocean with roughly twice the water of all Earth's oceans combined.",
"The Deep Space Network went operational in 1963 and has supported every NASA interplanetary mission since.",
"New Horizons sent its Pluto flyby data home at roughly 1-2 kilobits per second -- slower than a 1990s modem.",
"The Moon drifts away from Earth at about 3.8 centimetres a year.",
"SOHO, the Solar and Heliospheric Observatory, has watched the Sun continuously since 1995.",
"A year on Neptune lasts about 165 Earth years -- it has completed only one full orbit since its discovery in 1846.",
"Curiosity's landing used a rocket-powered sky crane to lower the rover gently onto the Martian surface.",
"The Dawn spacecraft is the only mission to orbit two bodies beyond Earth: the asteroid Vesta and the dwarf planet Ceres.",
"Deep space missions are tracked by measuring the Doppler shift in their radio signal, the same effect that changes a siren's pitch as it passes.",
];
let factTimer=null;
function startFacts(){
  const el=$('factLine'); el.hidden=false;
  const shown=new Set();
  const next=()=>{
    if(shown.size>=NASA_FACTS.length) shown.clear();
    let f; do{ f=NASA_FACTS[Math.floor(Math.random()*NASA_FACTS.length)]; }while(shown.has(f));
    shown.add(f); el.textContent=f;
  };
  next(); factTimer=setInterval(next,3200);
}
function stopFacts(){ clearInterval(factTimer); $('factLine').hidden=true; }

let liveMode=false, liveSocket=null, liveBackoff=2000;
function connectLive(timeoutMs=15000){
  return new Promise(resolve=>{
    let done=false;
    const finish=v=>{ if(done)return; done=true; resolve(v); };
    let ws;
    try{ ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/live'); }
    catch(e){ finish(null); return; }
    liveSocket=ws;
    ws.onmessage=e=>{
      let msg; try{msg=JSON.parse(e.data);}catch(e){return;}
      if(msg.type==='frame'&&msg.data) finish(msg.data);
    };
    ws.onerror=()=>finish(null);
    ws.onclose=()=>finish(null);
    setTimeout(()=>finish(null), timeoutMs);
  });
}
function setLiveBadge(state){
  // state: 'live' | 'reconnecting' | 'off'
  const b=$('liveBadge'); if(!b) return;
  b.hidden=state==='off';
  b.textContent=state==='reconnecting'?'RECONNECTING':'LIVE';
  b.classList.toggle('warn',state==='reconnecting');
}
let lastFrameAt=0;
// Unbounded over a multi-hour soak, F would just grow forever in live mode --
// nothing ever trimmed it, since the baked path never needed to (that array
// is a fixed 2,788 and done). A sliding window keeps prev/next able to
// glance back through recent live history without the tab's memory growing
// for as long as it stays open.
const LIVE_WINDOW=400;
let lastFrameGap=step;
function onLiveFrame(data){
  const now=Date.now();
  if(lastFrameAt) lastFrameGap=Math.max(400,Math.min(9000,now-lastFrameAt));
  F.push(data);
  if(F.length>LIVE_WINDOW) F.splice(0,F.length-LIVE_WINDOW);
  // The picture keeps following the network while paused; the choir does
  // not. applyAudio() has no idea whether playback is paused, so without
  // this guard Pause in live mode only lasted until the next frame arrived
  // and the voices came straight back.
  i=F.length-1; render(); if(playing) applyAudio(F[i]);
  liveBackoff=2000; lastFrameAt=now;
}
// A dead publisher doesn't close the socket -- the connection to the Worker
// is fine, it's just that nothing is posting to /publish anymore, so
// onclose/onerror below never fires. Left alone that reads as the deck going
// silent and frozen on the last frame forever, exactly the "going silent or
// blank" outage. Checked on an interval rather than a
// single timeout so it keeps catching repeat stalls for the life of the tab.
let staleWatchdog=null;
function startStaleWatchdog(){
  clearInterval(staleWatchdog);
  staleWatchdog=setInterval(()=>{
    if(!liveMode||!liveSocket) return;
    if(Date.now()-lastFrameAt>30000) liveSocket.close();
  },10000);
}
function wireLiveSocket(ws){
  ws.onmessage=e=>{
    let msg; try{msg=JSON.parse(e.data);}catch(e){return;}
    if(msg.type==='frame'&&msg.data) onLiveFrame(msg.data);
  };
  // Reconnect with backoff on any drop -- a fresh WebSocket each attempt, so
  // there is never more than one live handler set at a time.
  ws.onclose=ws.onerror=()=>{
    if(!liveMode) return;
    setLiveBadge('reconnecting');
    setTimeout(()=>{
      if(!liveMode) return;
      let retry;
      try{ retry=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/live'); }
      catch(e){ return; }
      liveSocket=retry;
      retry.onopen=()=>setLiveBadge('live');
      wireLiveSocket(retry);
    }, liveBackoff);
    liveBackoff=Math.min(30000, liveBackoff*1.6);
  };
}
function nearest(n){let b=PITCHES[0];for(const p of PITCHES)if(Math.abs(p-n)<Math.abs(b-n))b=p;return b;}
function startVoice(p,note,vow,gain){
  const root=nearest(note), key=vow+'_'+root, buf=BUF[key]||BUF['ahh_'+root];
  if(!buf) return null;
  const s=AC.createBufferSource(); s.buffer=buf; s.loop=true;
  s.loopStart=0.25; s.loopEnd=buf.duration-0.25;
  s.playbackRate.value=Math.pow(2,(note-root)/12);
  const g=AC.createGain(); g.gain.value=0;
  s.connect(g); g.connect(bus); s.start();
  g.gain.linearRampToValueAtTime(gain, AC.currentTime+Math.min(2.4,(liveMode?lastFrameGap:step)/1000*.8));
  return {s,g};
}
function applyAudio(fr){
  if(!AC||muted) return;
  // atk was always sized off the baked demo's fixed playback interval, even
  // in live mode -- irrelevant there, since real frames arrive on whatever
  // cadence the publisher and the network actually deliver, not a constant.
  // A transition sized for a 2.2s step but arriving into a 500ms gap doesn't
  // clip or error, but it does start audibly stacking ramps, which is what
  // the reported choppiness during live playback actually was.
  const t=AC.currentTime, atk=Math.min(2.4,(liveMode?lastFrameGap:step)/1000*.8);
  PARTS.forEach(([p])=>{
    const note=fr.notes[p], vow=(fr.vow&&fr.vow[p])||'ahh';
    const want=note!=null;
    const cur=live[p];
    if(!want){ if(cur){cur.g.gain.cancelScheduledValues(t);cur.g.gain.setValueAtTime(cur.g.gain.value,t);
      cur.g.gain.linearRampToValueAtTime(0,t+atk); const s=cur.s; setTimeout(()=>{try{s.stop()}catch(e){}},atk*1000+300);
      delete live[p];} return; }
    const gain=(fr.expr[p]||70)/127*(p==='I'?.34:p==='O'?.3:.26);
    if(cur&&cur.note===note){ cur.g.gain.cancelScheduledValues(t);cur.g.gain.setValueAtTime(cur.g.gain.value,t);
      cur.g.gain.linearRampToValueAtTime(gain,t+atk); return; }
    if(cur){ cur.g.gain.cancelScheduledValues(t);cur.g.gain.setValueAtTime(cur.g.gain.value,t);
      cur.g.gain.linearRampToValueAtTime(0,t+atk*.7); const s=cur.s;
      setTimeout(()=>{try{s.stop()}catch(e){}},atk*1000+300); }
    const v=startVoice(p,note,vow,gain); if(v){v.note=note; live[p]=v;}
  });
}
function hush(){ if(!AC)return; const t=AC.currentTime;
  Object.keys(live).forEach(p=>{const c=live[p];c.g.gain.cancelScheduledValues(t);
    c.g.gain.setValueAtTime(c.g.gain.value,t);c.g.gain.linearRampToValueAtTime(0,t+.5);
    const s=c.s;setTimeout(()=>{try{s.stop()}catch(e){}},900);delete live[p];}); }

/* ---------- cockpit apertures ---------- */
let AP=null, apCtx=null, FOOT=null;
let apMask=null, apMW=0, apMH=0; const MSCALE=4;
function buildApertureMask(img){
  const c=document.createElement('canvas');
  c.width=AP.frame[0]; c.height=AP.frame[1];
  apCtx=c.getContext('2d',{willReadFrequently:true});
  apCtx.drawImage(img,0,0,c.width,c.height);
  // Downsampled boolean copy: getImageData per star per frame is far too slow,
  // and this is only ever asked "is this point see-through".
  apMW=Math.ceil(AP.frame[0]/MSCALE); apMH=Math.ceil(AP.frame[1]/MSCALE);
  const t=document.createElement('canvas'); t.width=apMW; t.height=apMH;
  const tc=t.getContext('2d',{willReadFrequently:true});
  tc.drawImage(img,0,0,apMW,apMH);
  const d=tc.getImageData(0,0,apMW,apMH).data;
  apMask=new Uint8Array(apMW*apMH);
  for(let i=0;i<apMW*apMH;i++) apMask[i]=d[i*4+3]<128?1:0;
}
function transparentAt(sx,sy){
  if(!apMask) return true;
  const c=coverRect();
  const x=Math.floor((sx-c.ox)/c.s/MSCALE), y=Math.floor((sy-c.oy)/c.s/MSCALE);
  if(!Number.isFinite(x)||!Number.isFinite(y)) return false;
  if(x<0||y<0||x>=apMW||y>=apMH) return false;
  return apMask[y*apMW+x]===1;
}
/* Transparent pixel in the overlay == you are looking through an aperture.
   Testing the real alpha beats any shape assumption, so the hexagon, the
   rounded terminals and anything else all just work. */
function alphaAt(sx,sy){
  if(!apCtx||!AP) return 0;
  const c=coverRect();
  const x=Math.round((sx-c.ox)/c.s), y=Math.round((sy-c.oy)/c.s);
  if(!Number.isFinite(x)||!Number.isFinite(y)) return 255;
  if(x<0||y<0||x>=AP.frame[0]||y>=AP.frame[1]) return 255;
  return apCtx.getImageData(x,y,1,1).data[3];
}
function inWindow(sx,sy){
  if(expanded) return true;          // expanded map is the whole screen
  if(!AP) return true;
  const w=apRect('porthole');
  if(sx<w.x||sx>w.x+w.w||sy<w.y||sy>w.y+w.h) return false;
  return transparentAt(sx,sy);
}
/* widest transparent run at a given y, so HUD text never rides onto the frame */
function safeSpan(yPix){
  const w=apRect('porthole'); const c=coverRect();
  let lo=null,hi=null;
  for(let x=Math.round(w.x);x<=Math.round(w.x+w.w);x+=3){
    if(alphaAt(x,yPix)<128){ if(lo===null)lo=x; hi=x; }
  }
  return lo===null?{x:w.x,w:w.w}:{x:lo+6,w:Math.max(40,hi-lo-12)};
}
function coverRect(){
  // CONTAIN, matching object-fit on the bezel. Cover cropped the console
  // edges away on any viewport that wasn't 16:9. Guard the zero-size case:
  // a hidden tab reports 0x0 and every hit-test then throws on NaN.
  const vw=Math.max(1,innerWidth), vh=Math.max(1,innerHeight);
  const fw=AP.frame[0], fh=AP.frame[1];
  const sc=Math.min(vw/fw, vh/fh) || 1;
  return {s:sc, ox:(vw-fw*sc)/2, oy:(vh-fh*sc)/2};
}
function apRect(k){
  const c=coverRect(), a=AP.apertures[k];
  return {x:c.ox+a[0]*c.s, y:c.oy+a[1]*c.s, w:a[2]*c.s, h:a[3]*c.s};
}
function layoutCockpit(){
  if(!AP) return;
  {
    const c=coverRect();
    const bz=$('bezel');
    if(bz){ bz.style.objectFit='fill';
      bz.style.left=c.ox+'px'; bz.style.top=c.oy+'px';
      bz.style.width=(AP.frame[0]*c.s)+'px'; bz.style.height=(AP.frame[1]*c.s)+'px'; }
    if(FOOT){
      const fb=$('footbezel');
      fb.style.left=c.ox+'px'; fb.style.top=(c.oy+1440*c.s)+'px';
      fb.style.width=(2560*c.s)+'px'; fb.style.height=(FOOT.frame[1]*c.s)+'px';
      const put=(el,r,pad)=>{el.style.left=(r.x+pad)+'px';el.style.top=(r.y+pad)+'px';
        el.style.width=(r.w-pad*2)+'px';el.style.height=(r.h-pad*2)+'px';};
      const lg=apRect('logbook'), tk=apRect('ticker');
      put($('logbook'), lg, 6);
      put($('ticker'),  tk, 6);
      $('logbook').style.fontSize=Math.max(7,Math.min(13,lg.h*0.075))+'px';
      $('ticker').style.fontSize=Math.max(8,Math.min(17,tk.h*0.34))+'px';
    }
  }
  const put=(el,r,pad)=>{el.style.left=(r.x+pad)+'px';el.style.top=(r.y+pad)+'px';
    el.style.width=(r.w-pad*2)+'px';el.style.height=(r.h-pad*2)+'px';
    el.style.right='auto';el.style.bottom='auto';};
  // Mobile has two readouts, not three terminals: #right (chord + voices,
  // unchanged from desktop) becomes readoutA, and a small purpose-built
  // #roB fills readoutB. #left (the full link list) and #bot (the transport
  // terminal) have no room here -- transport moves to painted hotspots
  // instead, wired further down, and #left/#bot stay in the DOM (hidden via
  // CSS) so nothing that references them by id breaks.
  put($('right'), apRect('readoutA'), 8);
  put($('roB'),   apRect('readoutB'), 8);
  const rb=apRect('readoutB');
  $('roB').style.fontSize=Math.max(8,Math.min(15,rb.h*0.11))+'px';
  // #cName carried its desktop size (23px, fixed) straight over. On the much
  // smaller readoutA aperture that was roughly 3x every other label on the
  // panel (headers and #cStack both scale to 7-8px here) -- scaled the same
  // box-relative way as #roB just above, instead of a size tuned for a
  // terminal several times this one's area.
  const ra=apRect('readoutA');
  $('cName').style.fontSize=Math.max(13,Math.min(22,ra.h*0.16))+'px';
  $('cStack').style.fontSize=Math.max(8,Math.min(13,ra.h*0.075))+'px';
  const w=apRect('porthole');
  const g=$('glass');
  g.style.display='block';
  const t=$('toast');
  t.style.top=(w.y+w.h*0.80)+'px'; t.style.left=(w.x+w.w/2)+'px';
  const gy=w.y+w.h*0.10;
  const sp=safeSpan(gy+10);
  g.style.left=sp.x+'px'; g.style.width=sp.w+'px'; g.style.top=gy+'px';
  $('top').style.display='none';
}
addEventListener('resize',()=>{layoutCockpit();layoutHotspots();});


/* ---------- permalinked moments ---------- */
// The recorder has eight days of real sky in data/events.jsonl, none of which
// a visitor could reach: you got the live moment or one fixed demo identical
// for everyone. A moment is a short passage re-performed from a recorded sky
// and served as a static file, so ?moment=<id> is a link to a specific piece
// of the archive.
//
// Re-performed, not replayed. The engine is stochastic and was not running
// deterministically back then, so this is *a* performance of that sky rather
// than the one that actually played. The builder seeds from the moment id so
// the link is stable -- something that sounded different on every visit would
// not be a permalink. The banner says so rather than letting it be assumed.
const MOMENT_ID = new URLSearchParams(location.search).get('moment');
let MOMENT = null;

// The 3 KB index, fetched once and shared: the boot screen reads it to
// describe a permalink, and the Tapes panel lists it.
let MOMENT_INDEX = null;
async function momentIndex(){
  if(MOMENT_INDEX) return MOMENT_INDEX;
  try{
    const r = await fetch('moments.json');
    if(!r.ok) return [];
    MOMENT_INDEX = (await r.json()).moments || [];
  }catch(_){ return []; }
  return MOMENT_INDEX;
}
// The time machine's hourly index, needed here only so an hour link
// (?moment=hour-...) opened on a phone gets a real boot-screen description.
let TM = null;
async function tmIndex(){
  if(TM) return TM;
  try{
    const r = await fetch('timemachine.json');
    if(!r.ok) return null;
    TM = await r.json();
  }catch(_){ return null; }
  return TM;
}
async function describeMoment(id){
  // Only the index at load time; the frames themselves wait for Power Up so a
  // permalink costs no more on first paint than any other visit.
  const m = (await momentIndex()).find(m => m.id === id);
  if(m) return m;
  if(String(id).startsWith('hour-')){
    const tm = await tmIndex();
    const h = tm && tm.hours.find(x => x.id === id);
    if(h) return { id: h.id, title: String(h.t).slice(0,13).replace('T',' ') + ':00 UTC',
      t: h.t, downlinks: h.peak, craft: h.craft,
      why: 'One hour of the recorded archive: ' + h.peak + ' downlinks at the busiest point, '
         + h.craft.length + ' spacecraft heard.' };
  }
  return null;
}

// Fetching and mounting are separate on purpose. The Tapes panel switches
// tapes on a running deck, and if the fetch fails halfway that must leave the
// deck exactly as it was -- which it cannot if F has already been emptied.
async function fetchMoment(id){
  const r = await fetch('moments/' + encodeURIComponent(id) + '.json');
  if(!r.ok) throw new Error('moment ' + r.status);
  const m = await r.json();
  if(!Array.isArray(m.frames) || !m.frames.length) throw new Error('moment has no frames');
  return m;
}
function mountMoment(m){
  MOMENT = m;
  F.length = 0; for(const f of m.frames) F.push(f);
  i = 0;
  rebuildLocks();
  return m;
}
async function loadMoment(id){ return mountMoment(await fetchMoment(id)); }

function showMomentBanner(m){
  const el = $('momentBanner'); if(!el || !m) return;
  el.innerHTML = '<b>' + esc(m.title) + '</b> \u00b7 ' +
    esc(String(m.t).slice(0,16).replace('T',' ')) + ' UTC \u00b7 ' +
    esc(m.why) +
    ' <span class="rp">Re-performed from the recorded sky, not a recording of it.</span>' +
    ' <a href="' + location.pathname + '">back to live</a>';
  el.hidden = false;
}


// A permalink should say what it is before you commit to pressing anything.
(async () => {
  if(!MOMENT_ID) return;
  const m = await describeMoment(MOMENT_ID);
  const el = $('momentIntro'); if(!el) return;
  if(!m){
    el.innerHTML = 'No recorded moment called <b>' + esc(MOMENT_ID) + '</b>. '
                 + 'Powering up will play the live sky instead.';
    el.hidden = false; return;
  }
  el.innerHTML = '<b>' + esc(m.title) + '</b>' + esc(m.why)
    + '<span class="rp">' + esc(String(m.t).slice(0,16).replace('T',' ')) + ' UTC'
    + ' \u00b7 ' + m.downlinks + ' downlink' + (m.downlinks === 1 ? '' : 's') + ' \u00b7 '
    + esc((m.craft||[]).slice(0,6).join(' ')) + '</span>';
  el.hidden = false;
})();

/* ---------- sky ---------- */
const sky=$('sky'), K=sky.getContext('2d');
function size(){const d=devicePixelRatio||1;sky.width=innerWidth*d;sky.height=innerHeight*d;
  K.setTransform(d,0,0,d,0,0);}
addEventListener('resize',size); size();

function rot(x,y,z){
  const a=yaw*Math.PI/180,b=pitch*Math.PI/180;
  let X=x*Math.cos(a)-z*Math.sin(a), Z=x*Math.sin(a)+z*Math.cos(a);
  let Y=y*Math.cos(b)-Z*Math.sin(b); Z=y*Math.sin(b)+Z*Math.cos(b);
  return [X,Y,Z];
}
function sph(lat,lon){const p=lat*Math.PI/180,l=lon*Math.PI/180;
  return [Math.cos(p)*Math.sin(l),Math.sin(p),Math.cos(p)*Math.cos(l)];}
function kelvinRGB(k){
  if(!k)return[210,225,245];
  if(k>=10000)return[170,195,255]; if(k>=7500)return[195,215,255];
  if(k>=6000)return[235,242,255]; if(k>=5000)return[255,248,235];
  if(k>=4000)return[255,225,190]; if(k>=3200)return[255,200,155];
  return [255,175,130];
}
function drawSky(fr){
  const W=innerWidth,H=innerHeight;
  let cx=W/2, cy=H/2, ap=null;
  if(AP&&!expanded){ ap=apRect('porthole'); cx=ap.x+ap.w/2; cy=ap.y+ap.h/2; }
  // The Sun sits at the origin every projected body is computed around, so
  // without this the heliocentric view can only ever be recentred on the
  // Sun itself -- zooming in on anything else just pushes it toward an edge
  // with no way to bring it back. Two-finger drag (below) moves this; single-
  // finger drag stays yaw/pitch rotation so the star sphere and the orbital
  // plane keep turning together.
  if(expanded){ cx+=panX; cy+=panY; }
  const span=ap?Math.min(ap.w,ap.h):Math.min(W,H)*0.82;
  const R=span*0.155*zoom, SR=(ap?span*1.05:Math.max(W,H)*0.60)*zoom;
  K.fillStyle='#04070D'; K.fillRect(0,0,W,H);
  starHits=[];

  // stars, real catalogue, RA/Dec on the celestial sphere
  for(const s of STARS){
    const v=sph(s.d, s.r), q=rot(v[0],v[1],v[2]);
    if(q[2]<=0) continue;
    const x=cx+q[0]*SR, y=cy-q[1]*SR;
    if(x<-20||x>W+20||y<-20||y>H+20) continue;
    if(AP&&apMask&&!inWindow(x,y)) continue;   // hidden behind the console
    const m=Math.max(.62, (6.2-s.v)*.52), a=Math.min(1,(6.9-s.v)/4.2);
    const c=kelvinRGB(s.k);
    K.fillStyle=`rgba(${c[0]},${c[1]},${c[2]},${a*.92})`;
    K.beginPath(); K.arc(x,y,m,0,7); K.fill();
    if(s.v<3.6) starHits.push({x,y,n:s.n||null,v:s.v,k:s.k,ra:s.r,dec:s.d});
    if(s.v<2.3){ K.fillStyle=`rgba(${c[0]},${c[1]},${c[2]},.13)`;
      K.beginPath(); K.arc(x,y,m*3.2,0,7); K.fill();
      if(s.n){ K.font='400 10px "IBM Plex Mono",monospace'; K.fillStyle='rgba(147,216,236,.62)';
        K.textAlign='left'; K.fillText(s.n.toUpperCase(), x+8, y+3);
        K.strokeStyle='rgba(147,216,236,.28)'; K.lineWidth=1;
        K.beginPath(); K.arc(x,y,m*4.4,0,7); K.stroke(); } }
  }

  // Earth's rotation and the sub-solar point both come from the frame's UTC.
  // Sub-solar longitude is 0 at 12:00 UTC and moves -15 deg per hour.
  const utc=(fr.t||'').slice(11,19).split(':').map(Number);
  const hrs=(utc[0]||0)+(utc[1]||0)/60+(utc[2]||0)/3600;
  const earthSpin=(hrs*15)%360;
  const subSolarLon=((180 - hrs*15)%360+360)%360;

  // graticule sphere (Earth-centred listening view only)
  if(!expanded){
  K.lineWidth=1;
  for(let la=-60;la<=60;la+=15){
    K.strokeStyle=la===0?'rgba(147,216,236,.55)':'rgba(74,106,134,.75)';
    K.beginPath(); let on=false;
    for(let lo=-180;lo<=180;lo+=3){const v=sph(la,lo),q=rot(v[0],v[1],v[2]);
      if(q[2]>0){const x=cx+q[0]*R,y=cy-q[1]*R; on?K.lineTo(x,y):K.moveTo(x,y); on=true;} else on=false;}
    K.stroke();
  }
  for(let lo=0;lo<360;lo+=15){
    K.strokeStyle='rgba(74,106,134,.62)'; K.beginPath(); let on=false;
    for(let la=-90;la<=90;la+=3){const v=sph(la,lo),q=rot(v[0],v[1],v[2]);
      if(q[2]>0){const x=cx+q[0]*R,y=cy-q[1]*R; on?K.lineTo(x,y):K.moveTo(x,y); on=true;} else on=false;}
    K.stroke();
  }
  K.strokeStyle='rgba(147,216,236,.85)'; K.lineWidth=2;
  K.beginPath(); K.arc(cx,cy,R,0,7); K.stroke();

  // Day/night. The sub-solar point projects like everything else; the night
  // side falls away from it across the disc.
  {
    const sv=sph(0, subSolarLon+earthSpin), sq=rot(sv[0],sv[1],sv[2]);
    const len=Math.hypot(sq[0],-sq[1])||1e-6;
    const ux=sq[0]/len, uy=-sq[1]/len;
    K.save();
    K.beginPath(); K.arc(cx,cy,R,0,7); K.clip();
    const gx=K.createLinearGradient(cx+ux*R, cy+uy*R, cx-ux*R, cy-uy*R);
    gx.addColorStop(0,'rgba(255,238,200,0.12)');
    gx.addColorStop(0.42,'rgba(0,0,0,0)');
    gx.addColorStop(0.58,'rgba(2,5,10,0.40)');
    gx.addColorStop(1,'rgba(2,5,10,0.78)');
    K.fillStyle=gx; K.beginPath(); K.arc(cx,cy,R,0,7); K.fill();
    K.restore();
  }
  }  // end Earth-centred view

  // HELIOCENTRIC. The earlier version hung every planet off Earth's globe,
  // which drew a geocentric solar system. The Sun is the centre; Earth is one
  // body among the rest. Angles come from Kepler on real elements, so
  // positions are true; only the radius is compressed, or Neptune would sit
  // thirty times further out than Mars and nothing inside Jupiter would be
  // visible. Radial compression keeps ordering and spacing legible.
  const BD=window.BODIES||[];
  const bodyPos={};
  const jd=window.toJD(Date.now() + simDays*86400000);
  const AUr = au => R*(0.42 + 1.62*Math.pow(Math.min(au,45)/45, 0.42));
  // Every orbit lives in the ecliptic plane (y=0) until here; rot() is the
  // exact same yaw/pitch transform the star sphere already goes through
  // above, so a body at longitude lam projects through it the same way a
  // star at some RA/Dec does. Before this, the plane was flattened by a
  // fixed *0.62 with no connection to yaw/pitch at all -- correct-looking
  // by accident only at the one pitch it happened to be tuned for, and
  // visibly wrong (misaligned against the star field) under any drag.
  const eclipticProj=(lam,rr)=>{ const q=rot(Math.cos(lam),0,Math.sin(lam));
    return {x:cx+q[0]*rr, y:cy-q[1]*rr, z:q[2]}; };
  let earthLon=0, earthScreen=null;
  // Earth focus is drawn to TRUE SCALE, the same model as the desktop deck:
  // one linear km->px factor (kmPx) for the whole frame. The earlier version
  // drew the Moon as a fixed 18px ring and put every spacecraft on schematic
  // class rings at 2-4x R, so craft really inside the Moon's orbit were drawn
  // far outside it.
  let kmPx=0, earthDiscPx=0, sunLonGeo=0, farHeader=null;
  const projKm=(x,y,z)=>{ const q=rot(x,y,z); return {x:cx+q[0]*kmPx, y:cy-q[1]*kmPx, z:q[2]}; };
  const eclipticVec=(lam,beta,rr)=>{
    const q=rot(Math.cos(beta)*Math.cos(lam),Math.sin(beta),Math.cos(beta)*Math.sin(lam));
    return {x:cx+q[0]*rr, y:cy-q[1]*rr, z:q[2]}; };
  // Low-precision lunar theory (mean longitude + largest periodic term),
  // checked against the 2024-09-18 full moon and 2024-10-02 new moon.
  const moonGeocentric=jd=>{
    const d=jd-2451545.0, r=Math.PI/180;
    const L=218.316+13.176396*d, M=134.963+13.064993*d, F=93.272+13.229350*d;
    return { lam:(((L+6.289*Math.sin(M*r))%360)+360)%360*r,
             beta:5.128*Math.sin(F*r)*r, km:385001-20905*Math.cos(M*r) };
  };
  if(expanded && mapFocus==='sun'){
    BD.forEach(b=>{
      const el=(window.ORBITS||{})[b.id]||(window.ORBITS_APPROX||{})[b.id];
      let lam, rAU;
      if(el){ const o=window.solveOrbit(el,jd); lam=o.lam; rAU=o.r; }
      else  { lam=(b.id.length*0.7)%(Math.PI*2); rAU=b.au; }   // unbound visitors
      if(b.id==='EARTH') earthLon=lam;
      const rr=AUr(rAU);
      const pr=eclipticProj(lam,rr);
      bodyPos[b.id]={x:pr.x, y:pr.y, z:pr.z, b, rr, lam, rAU, approx:!((window.ORBITS||{})[b.id])};
      if(b.id==='EARTH') earthScreen=bodyPos[b.id];
    });
  } else if(expanded && mapFocus==='earth'){
    // Earth-focus: Earth itself is the drawing origin (cx,cy, already panned
    // and zoomed like the Sun was in the other mode), so the Moon-position
    // and fleet-position math below -- all written as offsets from
    // earthScreen/cx,cy -- works unchanged. Only the *other* planets have
    // no meaning at this scale and are simply never added to bodyPos, so
    // the shared per-body drawing loop below skips them for free.
    const elE=(window.ORBITS||{}).EARTH;
    if(elE) earthLon=window.solveOrbit(elE,jd).lam;
    earthScreen={x:cx, y:cy, z:1, b:BD.find(b=>b.id==='EARTH'), rr:0, lam:earthLon, rAU:1, approx:false};
    bodyPos.EARTH=earthScreen;
    // Zoom sets how much fits: the Earth-Moon system by default (on a phone,
    // framing L1/L2 left the Moon ~32px out and MMS and Chandra unresolvable),
    // L1/L2 by zooming out, down to GEO at full zoom-in. The scale inside any
    // one frame is linear. See the desktop deck.
    const reach=Math.max(4.2e4,Math.min(4e6,5e5*Math.pow(zoom,-3.7)));
    kmPx=R*2.8/reach;
    // Floor for visibility, capped at a fifth of the Moon's drawn distance so
    // zoomed out a "minimum size" Earth can never swallow the Moon's orbit.
    earthDiscPx=Math.max(6371*kmPx, Math.min(6, 384400*kmPx*0.2));
    sunLonGeo=earthLon+Math.PI;
  }
  if(expanded){
    // The Moon has no heliocentric au of its own -- at this scale Earth's
    // real 384,400 km satellite would sit sub-pixel from Earth regardless of
    // zoom, so it's drawn as a fixed small screen-space ring around Earth's
    // already-rotated position instead of a to-scale orbit. Schematic, not
    // to scale, and says so in its own dossier.
    if(earthScreen){
      if(mapFocus==='earth'){
        // Earth focus: the Moon's real position and distance, to scale.
        const mg=moonGeocentric(jd), mp=eclipticVec(mg.lam,mg.beta,mg.km*kmPx);
        bodyPos.MOON={x:mp.x, y:mp.y, z:mp.z, b:(BD.find(b=>b.id==='MOON')),
          rr:mg.km*kmPx, lam:mg.lam, rAU:0, approx:false, satellite:true, km:mg.km};
      } else {
      const moonLam=(jd%29.53)/29.53*Math.PI*2, moonR=Math.max(18,R*0.11);
      const mp=eclipticProj(moonLam,moonR);
      const dx=mp.x-cx, dy=mp.y-cy;
      bodyPos.MOON={x:earthScreen.x+dx, y:earthScreen.y+dy, z:mp.z,
        b:(BD.find(b=>b.id==='MOON')), rr:moonR, lam:moonLam, rAU:0, approx:false, satellite:true};
      }
    }

    // orbit tracks -- sampled as a polyline through the same rotation used
    // for the body dots, rather than an analytic ellipse. A tilted ring
    // viewed under combined yaw+pitch is a rotated ellipse, not just a
    // vertically-squashed one, and this way a body can never drift off a
    // track drawn through a different transform than its own position.
    K.save();
    if(mapFocus==='sun') BD.forEach(b=>{
      if(b.sat) return;   // satellites (the Moon) get their own ring below, Earth-centred
      const P=bodyPos[b.id]; if(!P) return;
      K.strokeStyle=b.hyper?'rgba(168,139,199,.26)'
        :(b.cls==='comet'?'rgba(111,187,168,.22)':'rgba(201,162,39,.20)');
      K.setLineDash(b.hyper?[3,5]:[]); K.lineWidth=1;
      K.beginPath();
      for(let s=0;s<=48;s++){
        const pr=eclipticProj(s/48*Math.PI*2,P.rr);
        s===0?K.moveTo(pr.x,pr.y):K.lineTo(pr.x,pr.y);
      }
      K.stroke();
    });
    if(earthScreen){
      // Moon's own ring, centred on Earth's screen position rather than the Sun.
      K.strokeStyle='rgba(147,216,236,.22)'; K.setLineDash([]); K.lineWidth=1;
      K.beginPath();
      for(let s=0;s<=32;s++){
        const pr=eclipticProj(s/32*Math.PI*2, mapFocus==='earth'?384400*kmPx:bodyPos.MOON.rr);
        const x=earthScreen.x+(pr.x-cx), y=earthScreen.y+(pr.y-cy);
        s===0?K.moveTo(x,y):K.lineTo(x,y);
      }
      K.stroke();
    }
    K.setLineDash([]); K.restore();

    const BCOL={planet:'#C9A227',dwarf:'#9C8F6B',asteroid:'#7A6E5A',
                comet:'#6FBBA8',interstellar:'#A88BC7',moon:'#B8B8B0'};
    if(mapFocus==='sun'){
      // THE SUN. Glow radius was 9x sunR, reaching ~99% of the way to Earth's
      // own orbit -- Mercury and Venus sat inside visible corona, which is the
      // "scale doesn't look right" of it. 5x keeps the glow inside Mercury's
      // orbit at every zoom level, since both scale off the same R.
      const sunR=Math.max(7,R*0.11);
      const g=K.createRadialGradient(cx,cy,0,cx,cy,sunR*5);
      g.addColorStop(0,'rgba(255,255,245,1)');
      g.addColorStop(0.10,'rgba(255,241,190,.95)');
      g.addColorStop(0.24,'rgba(255,190,80,.42)');
      g.addColorStop(0.55,'rgba(255,140,40,.13)');
      g.addColorStop(1,'rgba(255,120,30,0)');
      K.fillStyle=g; K.beginPath(); K.arc(cx,cy,sunR*5,0,7); K.fill();
      K.fillStyle='#FFFDF2'; K.beginPath(); K.arc(cx,cy,sunR,0,7); K.fill();
      K.font='500 10px "IBM Plex Mono",monospace'; K.textAlign='center';
      K.fillStyle='rgba(255,220,150,.85)'; K.textBaseline='top';
      K.fillText('SOL', cx, cy+sunR+7);

      // Zoomed out far enough to read the whole system as a small cluster
      // (the "galaxy view" ask), eight-plus always-on planet labels are
      // clutter, not orientation -- they only earn their space back once
      // zoomed in close enough that Earth's own orbit is legible again.
      // Whatever's actively hovered/tapped is exempt: an intentional look
      // at one body shouldn't hide behind an ambient zoom threshold.
      const labelAlpha=Math.max(0,Math.min(1,(zoom-0.32)/0.28));
      BD.forEach(b=>{
        const P=bodyPos[b.id]; if(!P) return;
        const hv=hover===b.id, big=b.cls==='planet', isEarth=b.id==='EARTH';
        // day/night: lit hemisphere faces the Sun at the centre
        const rad=isEarth?6.5:(big?4:2.4);
        const toSun=Math.atan2(cy-P.y, cx-P.x);
        K.fillStyle='#22201B';
        K.beginPath(); K.arc(P.x,P.y,rad,0,7); K.fill();
        K.fillStyle=hv?'#fff':(isEarth?'#7FC8E8':BCOL[b.cls]||'#7A6E5A');
        K.beginPath(); K.arc(P.x,P.y,rad,toSun-Math.PI/2,toSun+Math.PI/2); K.fill();
        if(isEarth){ K.strokeStyle='rgba(147,216,236,.85)'; K.lineWidth=1.3;
          K.beginPath(); K.arc(P.x,P.y,rad+3,0,7); K.stroke(); }
        if(b.cls==='comet'||b.cls==='interstellar'){
          K.strokeStyle=(BCOL[b.cls]||'#6FBBA8')+'66'; K.lineWidth=1;
          K.beginPath(); K.moveTo(P.x,P.y);
          K.lineTo(P.x-(cx-P.x)*0.12, P.y-(cy-P.y)*0.12); K.stroke();
        }
        // Same problem as the fleet labels, worse: 23 bodies, most with long
        // names (167P/CHURYUMOV-GERASIMENKO), all labelled unconditionally,
        // clustered near the inner solar system where the mobile map has the
        // least room. The 8 real planets are what anyone actually orients by
        // and are naturally spaced on their own orbits; everything smaller
        // (asteroids, comets, interstellar visitors) gets a dot and a tap.
        if(hv||(b.cls==='planet'&&labelAlpha>0.03)){
          const a=hv?1:0.72*labelAlpha, ea=hv?1:0.95*labelAlpha;
          K.font='400 10px "IBM Plex Mono",monospace';
          K.fillStyle=hv?'#fff':(isEarth?`rgba(147,216,236,${ea})`:`rgba(201,162,39,${a})`);
          K.textAlign=P.x<cx?'right':'left'; K.textBaseline='middle';
          K.fillText(b.n.toUpperCase()+(P.approx?' *':''), P.x+(P.x<cx?-9:9), P.y);
        }
      });
    } else {
      // THE EARTH, focus mode: Earth takes the Sun's place as the drawing
      // origin and its own primary subject, sized to actually fill the
      // screen rather than sit as a 6.5px dot on the interplanetary map.
      // Lit from a fixed direction rather than a computed sub-solar angle --
      // at this scale "which way is the Sun" is a schematic choice, not a
      // measured one, same honesty as the Moon's schematic ring.
      // TO SCALE (the comment above predates this): Earth, the Moon, the
      // Lagrange points and every near-Earth orbit share one linear km->px
      // factor. Earth keeps a minimum drawn size; nothing else is enlarged.
      // Lit from the Sun's real direction.
      const eR=earthDiscPx;
      const sd=eclipticProj(sunLonGeo,1e4), toSun=Math.atan2(sd.y-cy, sd.x-cx);
      const ring=(rr,dash,col)=>{ K.save(); K.setLineDash(dash); K.strokeStyle=col; K.lineWidth=1;
        K.beginPath(); for(let s=0;s<=64;s++){ const p=eclipticProj(s/64*Math.PI*2,rr);
          s?K.lineTo(p.x,p.y):K.moveTo(p.x,p.y); } K.stroke(); K.restore(); };
      const txt=(t,x,y,align,col,font)=>{ K.font=font||'400 9px "IBM Plex Mono",monospace';
        K.fillStyle=col; K.textAlign=align; K.textBaseline='middle'; K.fillText(t,x,y); };
      const geoR=42164*kmPx;
      if(geoR>eR+12){
        ring(geoR,[1,4],'rgba(147,216,236,.30)');
        const gp=eclipticProj(sunLonGeo+Math.PI/2,geoR);
        txt('GEO',gp.x+(gp.x<cx?-6:6),gp.y,gp.x<cx?'right':'left','rgba(147,216,236,.6)');
      }
      K.fillStyle='#22201B'; K.beginPath(); K.arc(cx,cy,eR,0,7); K.fill();
      K.fillStyle='#7FC8E8'; K.beginPath(); K.arc(cx,cy,eR,toSun-Math.PI/2,toSun+Math.PI/2); K.fill();
      K.strokeStyle='rgba(147,216,236,.85)'; K.lineWidth=1.5;
      K.beginPath(); K.arc(cx,cy,eR+3,0,7); K.stroke();
      K.font='500 10px "IBM Plex Mono",monospace'; K.textAlign='center';
      K.fillStyle='rgba(147,216,236,.9)'; K.textBaseline='top';
      K.fillText('EARTH', cx, cy+eR+7);
      [[0,'L1 · sunward'],[Math.PI,'L2']].forEach(([off,t])=>{
        const p=eclipticProj(sunLonGeo+off,1.5e6*kmPx);
        K.strokeStyle='rgba(201,162,39,.6)'; K.lineWidth=1;
        K.beginPath(); K.moveTo(p.x-4,p.y); K.lineTo(p.x+4,p.y);
        K.moveTo(p.x,p.y-4); K.lineTo(p.x,p.y+4); K.stroke();
        txt(t,p.x+(p.x<cx?-7:7),p.y+12,p.x<cx?'right':'left','rgba(201,162,39,.75)');
      });
      // The Moon at true size and distance, lit by the same Sun as Earth --
      // the old code lit it toward Earth, which drew it permanently full.
      const MP=bodyPos.MOON;
      if(MP){
        const hv=hover==='MOON', mr=Math.max(4,1737.4*kmPx);
        K.fillStyle='#22201B'; K.beginPath(); K.arc(MP.x,MP.y,mr,0,7); K.fill();
        K.fillStyle=hv?'#fff':BCOL.moon;
        K.beginPath(); K.arc(MP.x,MP.y,mr,toSun-Math.PI/2,toSun+Math.PI/2); K.fill();
        txt('MOON · '+Math.round(MP.km/1000)+'k km', MP.x+(MP.x<cx?-9:9), MP.y,
            MP.x<cx?'right':'left', hv?'#fff':'rgba(184,184,176,.85)', '400 10px "IBM Plex Mono",monospace');
      }
      // Off-frame markers for things whose direction is known: L1 (sunward),
      // L2 (anti-sunward) and, at deep zoom, the Moon. See the desktop deck.
      const rect={l:20, t:70, r:innerWidth-52, b:innerHeight-175};
      const edgeMark=(p,text,col)=>{
        if(p.x>=rect.l&&p.x<=rect.r&&p.y>=rect.t&&p.y<=rect.b) return;
        const dx=p.x-cx, dy=p.y-cy; let t=Infinity;
        if(dx>0) t=Math.min(t,(rect.r-cx)/dx); if(dx<0) t=Math.min(t,(rect.l-cx)/dx);
        if(dy>0) t=Math.min(t,(rect.b-cy)/dy); if(dy<0) t=Math.min(t,(rect.t-cy)/dy);
        if(!isFinite(t)||t<=0) return;
        const ex=cx+dx*t, ey=cy+dy*t, a=Math.atan2(dy,dx);
        K.fillStyle=col; K.beginPath();
        K.moveTo(ex+Math.cos(a)*7, ey+Math.sin(a)*7);
        K.lineTo(ex+Math.cos(a+2.5)*6, ey+Math.sin(a+2.5)*6);
        K.lineTo(ex+Math.cos(a-2.5)*6, ey+Math.sin(a-2.5)*6); K.fill();
        txt(text, ex-Math.cos(a)*12, ey-Math.sin(a)*12, Math.cos(a)>0?'right':'left', col);
      };
      edgeMark(eclipticProj(sunLonGeo,1.5e6*kmPx),'L1 · 1.5M km','rgba(201,162,39,.9)');
      edgeMark(eclipticProj(sunLonGeo+Math.PI,1.5e6*kmPx),'L2 · 1.5M km','rgba(201,162,39,.9)');
      if(MP) edgeMark(MP,'MOON','rgba(184,184,176,.9)');
      const want=90/kmPx, p10=Math.pow(10,Math.floor(Math.log10(want))), mm=want/p10;
      const nice=(mm>=5?5:mm>=2?2:1)*p10, bl=nice*kmPx, bx=16, by=innerHeight-150;
      K.strokeStyle='rgba(217,230,240,.75)'; K.lineWidth=1;
      K.beginPath(); K.moveTo(bx,by-4); K.lineTo(bx,by); K.lineTo(bx+bl,by); K.lineTo(bx+bl,by-4); K.stroke();
      txt(nice.toLocaleString()+' km', bx, by-11, 'left', 'rgba(217,230,240,.85)');
      txt('TRUE SCALE', bx, by+11, 'left', 'rgba(120,140,160,.8)');
    }
  }
  window.__bodyPos=bodyPos;
  window.__earthLon=earthLon;
  if(expanded){ const sd=$('simd');
    if(sd) sd.textContent = simDays? ' · '+(simDays>=365?(simDays/365.25).toFixed(2)+' yr':simDays.toFixed(0)+' d')+' ahead':''; }

  // fleet rings
  const tracked={}, acq=new Set(fr.acq.concat(fr.lost).concat(fr.dualOn||[]).concat(fr.dualOff||[]));
  fr.links.forEach(l=>{tracked[l.sc]=l});
  // Innermost first: LEO used to sort outside HEO.
  const CLS=['leo','heo','lunar','l1','l2','inner','mars','belt','outer','kuiper','interstellar'];
  const pos={};
  // Every one of these is tracked from Earth, so in the heliocentric view they
  // cluster on Earth rather than on the Sun.
  const EP=(expanded && bodyPos.EARTH) ? bodyPos.EARTH : null;
  const ox=EP?EP.x:cx, oy=EP?EP.y:cy;
  // Earth-focus has no interplanetary distances competing for the same
  // frame, so the fleet class rings can spread out to fill it instead of
  // sitting as a small cluster tucked against one planet's dot.
  const fleetR=expanded?(mapFocus==='earth'?R*1.35:R*0.55):R;
  // Schematic class rings, not real orbital elements -- there's no Kepler
  // fit for "everything in LEO" as a group. But a fixed angle with no time
  // term at all read as broken once the planets around them started moving
  // with simDays: closer bands get a faster nominal drift, same ordering
  // real orbital speed follows (nearer = faster), without claiming any of
  // these rates are literal.
  const AU_KM=149597870.7;
  const farList=[];
  if(expanded&&mapFocus==='earth'&&EP){
    // TRUE SCALE, same placement rules as the desktop deck: real distance
    // from Earth, schematic position along the orbit.
    const perp=[-Math.sin(sunLonGeo),0,Math.cos(sunLonGeo)];
    const byCls={}; FLEET.forEach(f=>{ (byCls[f.cls]=byCls[f.cls]||[]).push(f); });
    FLEET.forEach(f=>{
      const peers=byCls[f.cls], idx=peers.indexOf(f), cnt=peers.length;
      if(f.cls==='l1'||f.cls==='l2'){
        // 1.5 million km sunward (L1) or anti-sunward (L2), spread round a
        // halo-sized ring perpendicular to the Sun line.
        const s=f.cls==='l1'?1:-1, a=idx/cnt*Math.PI*2+simDays*0.034, h=3e5;
        const x=s*1.5e6*Math.cos(sunLonGeo)+h*Math.cos(a)*perp[0];
        const z=s*1.5e6*Math.sin(sunLonGeo)+h*Math.cos(a)*perp[2];
        const p=projKm(x,h*Math.sin(a),z);
        pos[f.id]={x:p.x, y:p.y, f};
      } else if(f.cls==='lunar'&&bodyPos.MOON){
        // At the Moon, fanned a few px so each stays tappable.
        const M=bodyPos.MOON, a=idx/cnt*Math.PI*2+0.6, rp=Math.max(11,3000*kmPx);
        pos[f.id]={x:M.x+Math.cos(a)*rp, y:M.y+Math.sin(a)*rp, f};
      } else if(f.cls==='leo'||f.cls==='heo'){
        const ci=CLS.indexOf(f.cls), band=(ci+1)/CLS.length;
        const a=(ci*1.9+(idx/Math.max(1,cnt))*1.75)+0.4+simDays*(0.9/(band*9+0.5));
        let rr=f.au*AU_KM*kmPx, clamped=false;
        // Held just outside Earth's drawn limb when its true radius would
        // fall inside it, and marked; lets go once zoom resolves it.
        // Capped at 45% of the Moon's drawn distance, so a pinned craft can
        // never be drawn outside the Moon's orbit however far out you zoom.
        const pin=Math.min(earthDiscPx+7, 384400*kmPx*0.45);
        if(rr<pin){ rr=pin; clamped=true; }
        const p=eclipticProj(a,rr);
        pos[f.id]={x:p.x, y:p.y, f, clamped};
      } else farList.push(f);
    });
    // Interplanetary craft cannot be on a map that shows the Moon. On a phone
    // they are a column of tappable dots down the right edge, ordered by
    // distance, below the round buttons -- no bearing implied, since there is
    // none to show. Tap one for its name, distance and dossier.
    farList.sort((a,b)=>a.au-b.au);
    const top=222, step=Math.max(9,Math.min(15,(innerHeight-top-170)/Math.max(1,farList.length)));
    farList.forEach((f,n)=>{ pos[f.id]={x:innerWidth-29, y:top+n*step, f, far:true}; });
    farHeader={x:innerWidth-14, y:top-14};
  } else FLEET.forEach(f=>{
    const ci=CLS.indexOf(f.cls), band=(ci+1)/CLS.length;
    const idx=FLEET.filter(g=>g.cls===f.cls).indexOf(f);
    const cnt=FLEET.filter(g=>g.cls===f.cls).length;
    const spin=expanded?simDays*(0.9/(band*9+0.5)):0;
    const a=(CLS.indexOf(f.cls)*1.9 + (idx/Math.max(1,cnt))*1.75)+0.4+spin;
    const rr=fleetR*(1.45+band*1.45);
    if(expanded&&EP){
      const pr=eclipticProj(a,rr);
      pos[f.id]={x:EP.x+(pr.x-cx), y:EP.y+(pr.y-cy), f};
    } else {
      pos[f.id]={x:ox+Math.cos(a)*rr, y:oy+Math.sin(a)*rr*.62, f};
    }
  });
  // orbit bands -- same Earth-centred rotation as the fleet dots above, so a
  // craft can never drift off the ring drawn for its own class.
  if(!(expanded&&mapFocus==='earth')) CLS.forEach((c,n)=>{
    const rr=fleetR*(1.45+((n+1)/CLS.length)*1.45);
    K.strokeStyle=expanded?'rgba(60,86,110,.28)':'rgba(60,86,110,.55)'; K.lineWidth=1;
    K.beginPath();
    if(expanded&&EP){
      for(let s=0;s<=40;s++){
        const pr=eclipticProj(s/40*Math.PI*2,rr);
        const x=EP.x+(pr.x-cx), y=EP.y+(pr.y-cy);
        s===0?K.moveTo(x,y):K.lineTo(x,y);
      }
    } else K.ellipse(ox,oy,rr,rr*.62,0,0,7);
    K.stroke();
  });
  if(expanded&&mapFocus==='earth'&&EP){
    // Near-Earth orbit radii, true to scale, dashed because nominal.
    const radii=[...new Set(FLEET.filter(f=>f.cls==='leo'||f.cls==='heo').map(f=>f.au))];
    K.save(); K.setLineDash([2,4]); K.lineWidth=1; K.strokeStyle='rgba(60,86,110,.5)';
    radii.forEach(au=>{
      const rr=au*AU_KM*kmPx; if(rr<Math.min(earthDiscPx+7,384400*kmPx*0.45)) return;
      K.beginPath();
      for(let s=0;s<=48;s++){ const p=eclipticProj(s/48*Math.PI*2,rr); s?K.lineTo(p.x,p.y):K.moveTo(p.x,p.y); }
      K.stroke();
    });
    K.restore();
    if(farHeader&&farList.length){
      K.font='500 8px "IBM Plex Mono",monospace'; K.textAlign='right'; K.textBaseline='alphabetic';
      K.fillStyle='rgba(201,162,39,.85)'; K.fillText('BEYOND MAP ↓ BY DISTANCE', farHeader.x, farHeader.y);
    }
  }

  // link arcs from complexes
  const stationPos={};
  if(!expanded) Object.entries(SITES).forEach(([k,s])=>{
    const v=sph(s.lat,s.lon+earthSpin), q=rot(v[0],v[1],v[2]);
    const vis=q[2]>0, x=cx+q[0]*R, y=cy-q[1]*R;
    if(vis) stationPos[k]={x,y,k,s};
    const mine=fr.links.filter(l=>l.st===k&&l.dir==='down');
    mine.forEach(l=>{
      const P=pos[l.sc]; if(!P)return;
      const hot=acq.has(l.sc);
      K.strokeStyle=hot?'rgba(255,122,61,.9)':vis?'rgba(147,216,236,.34)':'rgba(78,101,121,.15)';
      K.lineWidth=hot?1.8:l.r>1e6?1.4:.85;
      K.beginPath(); K.moveTo(x,y);
      K.quadraticCurveTo((x+P.x)/2+(cx-(x+P.x)/2)*.3,(y+P.y)/2+(cy-(y+P.y)/2)*.3,P.x,P.y);
      K.stroke();
    });
    if(vis){
      const act=mine.length;
      K.fillStyle=act?'#93D8EC':'#31445A';
      K.beginPath(); K.arc(x,y,act?5:3,0,7); K.fill();
      if(act){K.strokeStyle='rgba(147,216,236,.3)';K.lineWidth=1;K.beginPath();
        K.arc(x,y,10+Math.sin(Date.now()/500)*3,0,7);K.stroke();}
      const dl=Math.cos((s.lon-subSolarLon)*Math.PI/180)*Math.cos(s.lat*Math.PI/180)>0;
      K.font='500 10px "IBM Plex Mono",monospace'; K.textAlign='center';
      K.fillStyle=act?'#D9E6F0':'#4E6579';
      K.fillText(s.name.toUpperCase(),x,y+17);
      K.font='400 8px "IBM Plex Mono",monospace';
      K.fillStyle=dl?'rgba(255,214,140,.75)':'rgba(110,140,170,.6)';
      K.fillText(dl?'DAY':'NIGHT',x,y+28);
    }
  });


  // craft. Same day/night treatment as the planets: a spacecraft is lit on the
  // side facing the Sun like anything else out there. In the expanded view the
  // Sun is at the centre of frame; in the Earth-centred view it is wherever the
  // sub-solar point projects to.
  let sunX=cx, sunY=cy;
  if(!expanded){
    const sv2=sph(0, subSolarLon+earthSpin), sq2=rot(sv2[0],sv2[1],sv2[2]);
    const l2=Math.hypot(sq2[0],-sq2[1])||1e-6;
    sunX=cx+(sq2[0]/l2)*R*4; sunY=cy+(-sq2[1]/l2)*R*4;
  }
  if(expanded&&mapFocus==='earth'){ const sp=eclipticProj(sunLonGeo,1e4); sunX=sp.x; sunY=sp.y; }
  FLEET.forEach(f=>{
    const P=pos[f.id], on=!!tracked[f.id], hot=acq.has(f.id), hv=hover===f.id;
    const rad=hot?5.5:on?4:2.6;
    const toSun=Math.atan2(sunY-P.y, sunX-P.x);
    const lit=hot?'#FF7A3D':on?(f.ref?'#A88BC7':'#93D8EC'):'#43607C';
    K.fillStyle=on||hot?'#1A2029':'#232A33';
    K.beginPath(); K.arc(P.x,P.y,rad,0,7); K.fill();
    K.fillStyle=lit;
    K.beginPath(); K.arc(P.x,P.y,rad,toSun-Math.PI/2,toSun+Math.PI/2); K.fill();
    if(f.ref&&on){ K.strokeStyle='rgba(168,139,199,.6)'; K.lineWidth=1;
      K.beginPath(); K.arc(P.x,P.y,7.5,0,7); K.stroke(); }
    // The porthole is much smaller than the desktop hexagon it was
    // designed for, so labelling every tracked craft the way desktop does
    // crams five or more overlapping names into a fraction of the space.
    // Dots still mark every tracked craft; a name only appears for the one
    // an acquisition/loss just happened to, or whatever is under a tap --
    // tap any dot for its full dossier instead of reading dense labels.
    if(P.clamped){ K.save(); K.setLineDash([2,2]); K.strokeStyle='rgba(147,216,236,.55)';
      K.lineWidth=1; K.beginPath(); K.arc(P.x,P.y,rad+3,0,7); K.stroke(); K.restore(); }
    if(hot||hv){
      K.font='500 11px "Barlow Condensed",sans-serif';
      K.fillStyle=hot?'#FF7A3D':'#fff';
      // The off-map column hugs the right edge, so its label must point left
      // or it runs off the screen; it also carries the distance.
      const left=P.far||P.x<cx;
      K.textAlign=left?'right':'left';
      K.fillText(f.n.toUpperCase()+(P.far?' · '+(f.au>=10?f.au.toFixed(0):f.au.toFixed(2))+' AU':''),
                 P.x+(left?-9:9), P.y+4);
    }
  });
  window.__pos=pos;
  window.__stationPos=stationPos;
}

/* ---------- footer: event log and state ticker ----------
   The split is discrete vs continuous. The logbook records things that HAPPEN
   (a pass opens, a phrase resolves, a voice enters) as timestamped lines. The
   ticker describes what IS, as one rolling sentence of present state. */
const LOG=[]; const LOGMAX=40;
let lastState=null, lastChord=null, lastVoices='', lastTone=null;
function logLine(kind,msg,t){
  const prev=LOG[LOG.length-1];
  if(prev && prev.msg===msg && prev.kind===kind) return;
  LOG.push({kind,msg,t:t||'--:--:--'});
  if(LOG.length>LOGMAX) LOG.shift();
  const w=document.querySelector('#logbook .lgw'); if(!w) return;
  w.innerHTML=LOG.slice(-LOGMAX).map((l,n,arr)=>
    `<div class="ln ${l.kind}${n===arr.length-1?' new':''}"><span class="t">${esc(l.t)}</span><span class="m">${esc(l.msg)}</span></div>`
  ).join('');
}
// Spoken to assistive tech, sparingly and on purpose. The ticker and logbook
// are already real text a screen reader can read at will, but making either of
// them a live region would be hostile: the ticker changes every frame and the
// logbook records a chord every few seconds. Acquisitions and losses are the
// events the piece itself considers significant enough to cut a phrase short,
// and they happen on hour timescales, so they are the ones worth interrupting
// for. Written in words rather than the panel's ACQ/LOS shorthand.
//
// Deliberately NOT inside updateFooter(), which returns early unless the
// footer overlay artwork has loaded -- announcements are not decoration and
// must not depend on a PNG. Guarded on the frame timestamp because render()
// runs many times per frame (panel opens, resizes, hover), and repeating
// "Psyche acquired" on every one of them would be its own kind of hostile.
let lastAnnouncedT=null;
function announceFrame(fr){
  const el=$('srlive'); if(!el || !fr) return;
  if(fr.t===lastAnnouncedT) return;
  lastAnnouncedT=fr.t;
  const nameOf=c=>((FMAP[c]||{}).n||c);
  const said=[...(fr.acq||[]).map(c=>nameOf(c)+' acquired'),
              ...(fr.lost||[]).map(c=>nameOf(c)+' signal lost')];
  if(said.length) el.textContent=said.join('. ');
}
const PARTNAME={S:'SOPRANO',A:'ALTO',T:'TENOR',B:'BASS',O:'OCTAVIST',I:'ISON'};
function updateFooter(fr){
  if(!FOOT) return;
  const t=fr.t.slice(11,19);
  fr.acq.forEach(c=>{
    const l=fr.links.find(x=>x.sc===c&&x.dir==='down');
    logLine('acq','ACQ '+((FMAP[c]||{}).n||c).toUpperCase()+(l?'  '+l.d+'  '+l.b+'-BAND':''),t);
  });
  fr.lost.forEach(c=>logLine('los','LOS '+((FMAP[c]||{}).n||c).toUpperCase(),t));
  // dualOn/dualOff are absent on the 2,788 baked demo frames (recorded
  // before this existed) -- default to empty rather than throw on replay.
  (fr.dualOn||[]).forEach(c=>logLine('dual','DUAL CARRIER '+((FMAP[c]||{}).n||c).toUpperCase(),t));
  (fr.dualOff||[]).forEach(c=>logLine('dual',((FMAP[c]||{}).n||c).toUpperCase()+' SINGLE CARRIER',t));
  if(fr.state!==lastState){
    lastState=fr.state;
    if(fr.state==='cadence')    logLine('cad','CADENCE',t);
    if(fr.state==='recitation') logLine('sys','RECITATION OPENS',t);
    if(fr.state==='intonation') logLine('sys','INTONATION',t);
  }
  const cn=chordName(fr);
  if(cn!==lastChord){ lastChord=cn; logLine('chd','CHORD  '+cn.toUpperCase(),t); }
  const vs=PARTS.filter(([p])=>fr.notes[p]!=null).map(([p])=>p).join('');
  if(vs!==lastVoices){
    const before=new Set(lastVoices.split('')), now=new Set(vs.split(''));
    now.forEach(p=>{ if(!before.has(p)) logLine('sys',PARTNAME[p]+' IN  '+nm(fr.notes[p]),t); });
    before.forEach(p=>{ if(!now.has(p)) logLine('sys',PARTNAME[p]+' OUT',t); });
    lastVoices=vs;
  }
  const T=TONES[tone];
  if(T.occasion!==lastTone){ lastTone=T.occasion;
    logLine('sys','SETTING  '+T.occasion.toUpperCase()+'  ['+T.mode.toUpperCase()+']',t); }

  const dn=fr.links.filter(l=>l.dir==='down').sort((a,b)=>b.r-a.r);
  const bits=[];
  bits.push(T.occasion.toUpperCase()+' / '+T.mode.toUpperCase());
  bits.push(fr.state.toUpperCase()+' / CHORD '+cn.toUpperCase());
  dn.slice(0,6).forEach(l=>{
    const nm2=((FMAP[l.sc]||{}).n||l.sc).toUpperCase();
    const rate=l.r>=1e6?(l.r/1e6).toFixed(2)+' MB/S':(l.r/1e3).toFixed(1)+' KB/S';
    bits.push(`${SITEN[l.st].toUpperCase()} ${dishOf(l.d)} TRACKING ${nm2} ${rate} ${l.p} DBM${l.part?' ['+PARTNAME[l.part]+']':''}`);
  });
  bits.push(fr.n+' CARRIERS / MEAN '+fr.dbm+' DBM / '+t+' UTC');
  const line=bits.join('   \u2022   ')+'   \u2022   ';
  const a=document.querySelector('#ticker .tka'), b=document.querySelector('#ticker .tkb');
  if(a && a.textContent!==line){ a.textContent=line; b.textContent=line; }
}

/* ---------- painted-control hotspots ---------- */
let HS=null, calib=false, calibStart=null;
function layoutHotspots(){
  if(!HS||!AP) return;
  const host=$('spots'); host.innerHTML='';
  const c=coverRect();
  HS.spots.forEach(sp=>{
    const [x,y,w,h]=sp.box;
    const d=document.createElement('div');
    d.className='spot '+sp.kind; d.dataset.id=sp.id;
    d.style.left=(c.ox+x*c.s)+'px'; d.style.top=(c.oy+y*c.s)+'px';
    d.style.width=(w*c.s)+'px'; d.style.height=(h*c.s)+'px';
    d.dataset.basefs=Math.max(8,h*c.s*0.52);
    if(sp.kind==='button'){ d.title=sp.label;
      d.onclick=()=>doAct(sp.act); }
    host.appendChild(d);
  });
}
function doAct(a){
  if(a==='audio') $('au').click();
  if(a==='play')  $('play').click();
  if(a==='tone'){ const t=$('tone'); t.selectedIndex=(t.selectedIndex+1)%t.options.length;
    t.dispatchEvent(new Event('change')); flashSpot('annunciator'); }
  if(a==='speed'){ const t=$('sp'); t.selectedIndex=(t.selectedIndex+1)%t.options.length;
    t.dispatchEvent(new Event('change')); flashSpot('knobSpeed'); }
  // Mobile-only: the chest unit has no scrubber, so acquisition-hopping is
  // the only way to move through the recording. Same underlying buttons the
  // desktop scrubber already drives.
  if(a==='prevAcq') $('pv').click();
  if(a==='nextAcq') $('nx').click();
}
function flashSpot(id){
  const e=document.querySelector(`.spot[data-id="${id}"]`); if(!e)return;
  e.classList.add('hit'); setTimeout(()=>e.classList.remove('hit'),450);
}
/* Measure the TEXT, not the box. scrollWidth is clamped to clientWidth, so
   comparing it against the box width is a condition that can never be
   satisfied and just shrinks the type to the floor every frame. */
function setReadout(el,value){
  if(!el) return;
  let sp=el.firstElementChild;
  if(!sp||sp.tagName!=='SPAN'){ el.textContent=''; sp=document.createElement('span'); el.appendChild(sp); }
  if(sp.textContent!==value) sp.textContent=value;
  const base=+el.dataset.basefs||12;
  let fs=base; sp.style.fontSize=fs+'px';
  const avail=el.clientWidth-8;
  if(avail<=0) return;          // hidden tab: no layout to fit against
  let guard=0;
  while(sp.offsetWidth>avail && fs>6 && guard++<40){ fs-=0.5; sp.style.fontSize=fs+'px'; }
}
function paintHotspots(fr){
  if(!HS) return;
  const q=id=>document.querySelector(`.spot[data-id="${id}"]`);
  const totalRate=fr.links.filter(l=>l.dir==='down').reduce((a,l)=>a+l.r,0);
  setReadout(q('nixieVelocity'), String(Math.round(totalRate/1000)).padStart(5,'0'));
  setReadout(q('nixieElapsed'), fr.t.slice(11,19).replace(/:/g,' '));
  setReadout(q('counter'), String(i+1).padStart(3,'0'));
  const mc=q('masterCaution'); if(mc) mc.classList.toggle('lit', !!fr.lock);
  // The four lamps on the mobile chest unit: two red (attention states),
  // two green (nominal states). No live connection exists yet -- lamp2
  // reads "no downlink this frame" as its nearest honest equivalent to a
  // stale/disconnected indicator until the WebSocket relay is wired in.
  const lamp=(id,on)=>{const e=q(id); if(e) e.classList.toggle('lit', !!on);};
  lamp('lampAcqLoss', !!fr.lock);
  lamp('lampNoSignal', fr.n===0);
  lamp('lampAudio', !muted);
  lamp('lampPlaying', playing);
}

/* calibration: drag a box over a painted control, get JSON back */
addEventListener('keydown',e=>{
  if(e.key==='h'||e.key==='H'){ calib=!calib;
    document.body.classList.toggle('calib',calib);
    console.log(calib?'CALIBRATE: drag a box over a control':'calibrate off'); }
});
addEventListener('pointerdown',e=>{ if(calib) calibStart=[e.clientX,e.clientY]; },true);
addEventListener('pointerup',e=>{
  if(!calib||!calibStart) return;
  const c=coverRect();
  const f=(px,py)=>[Math.round((px-c.ox)/c.s),Math.round((py-c.oy)/c.s)];
  const a=f(calibStart[0],calibStart[1]), b=f(e.clientX,e.clientY);
  const box=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1])];
  console.log('box: '+JSON.stringify(box));
  const t=$('toast'); t.textContent='BOX '+box.join(', '); t.classList.add('on');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'),4000);
  calibStart=null;
},true);

/* ---------- clickable stars ---------- */
let starHits=[];
sky.addEventListener('click',e=>{
  // A mouse holds still to within a pixel; a finger doesn't. 4px was
  // tuned for a pointer device and treated ordinary touch jitter during
  // an intended drag as a completed tap, popping a dossier open while
  // the user was still trying to pan. 14px is the standard tap-vs-drag
  // threshold most touch UI frameworks use.
  if(drag&&drag.moved>14) return;
  if(!inWindow(e.clientX,e.clientY)) return;
  let best=null,bd=26;
  for(const h of starHits){
    const d=Math.hypot(e.clientX-h.x,e.clientY-h.y);
    if(d<bd){bd=d;best=h;}
  }
  const sp=window.__stationPos||{};
  for(const k in sp){ if(Math.hypot(e.clientX-sp[k].x,e.clientY-sp[k].y)<20){
    openStation(k,e.clientX,e.clientY); return; } }
  // Closest match, not first-under-threshold: Earth-focus puts the Moon a
  // few pixels from Earth's own (much larger) disc, both easily within 20px
  // of a tap aimed at the Moon, and Earth sorts first in bodyPos -- a
  // first-match loop would open Earth's dossier for every tap anywhere near
  // the Moon.
  const bp=window.__bodyPos||{}; let bestBody=null,bbd=20;
  for(const k in bp){ const d=Math.hypot(e.clientX-bp[k].x,e.clientY-bp[k].y);
    if(d<bbd){bbd=d;bestBody=k;} }
  if(bestBody){ openBody(bestBody,e.clientX,e.clientY); return; }
  // spacecraft first -- they sit on the rings, stars are the backdrop
  const pos=window.__pos||{}; let sc=null,sd=24;
  for(const k in pos){const d=Math.hypot(e.clientX-pos[k].x,e.clientY-pos[k].y);
    if(d<sd){sd=d;sc=k;}}
  if(sc){ openCraft(sc,e.clientX,e.clientY); return; }
  if(!best){ const el0=$('detail'); if(el0.dataset.sticky){
      el0.classList.remove('on'); delete el0.dataset.sticky; } return; }
  const f=(window.STARFACTS||{})[best.n]||{};
  const el=$('detail'); el.classList.remove('wide'); delete el.dataset.craft;
  const hms=d=>{const h=Math.floor(d/15),m2=Math.floor((d/15-h)*60);return `${h}h ${String(m2).padStart(2,'0')}m`;};
  const dms=d=>`${d>=0?'+':'-'}${Math.floor(Math.abs(d))}°`;
  const title=best.n||`Star · mag ${best.v.toFixed(2)}`;
  el.innerHTML=`<div class="t">${title}</div>
    ${f.b?`<div class="row"><span>DESIGNATION</span><b>${f.b}</b></div>`:''}
    <div class="row"><span>APPARENT MAG</span><b>${best.v.toFixed(2)}</b></div>
    ${f.s?`<div class="row"><span>SPECTRAL TYPE</span><b>${f.s}</b></div>`:''}
    ${f.d?`<div class="row"><span>DISTANCE</span><b>~${f.d} ly</b></div>`:''}
    ${f.d?`<div class="row"><span>LEFT THE STAR</span><b>${(new Date().getFullYear()-Math.round(f.d))} AD</b></div>`:''}
    <div class="row"><span>RA / DEC</span><b>${hms(best.ra)} ${dms(best.dec)}</b></div>
    ${best.k?`<div class="row"><span>COLOUR TEMP</span><b>${best.k} K</b></div>`:''}
    ${f.n?`<div class="note">${esc(f.n)}</div>`:
      '<div class="note">Yale Bright Star Catalog. No common name. Click a labelled star for a full entry.</div>'}`;
  el.style.left=Math.min(innerWidth-250,e.clientX+16)+'px';
  el.style.top=Math.min(innerHeight-190,e.clientY+14)+'px';
  el.innerHTML+='<div class="close" title="close">&times;</div>';
  el.classList.add('on'); el.dataset.sticky='1';
  el.querySelector('.close').onclick=ev=>{ev.stopPropagation();
    el.classList.remove('on'); delete el.dataset.sticky;};
});

function openBody(id,px,py){
  const b=(window.BODIES||[]).find(x=>x.id===id); if(!b) return;
  const el=$('detail'); el.classList.add('wide'); delete el.dataset.craft;
  // A satellite's `au` is a placeholder for the heliocentric layout math
  // (see the ecliptic projection above), not a real distance -- reusing it
  // here would print "1 AU" for the Moon and a ~16 minute light time for
  // something that's really 1.3 light-seconds away.
  const km=b.sat?384400:b.au*149597870.7, rt=km/299792.458*2;
  const lt=rt>120?(rt/60).toFixed(1)+' min':rt.toFixed(1)+' s';
  el.innerHTML=`<div class="t">${esc(b.n)}</div>
    <div class="row"><span>CLASS</span><b>${b.t}</b></div>
    <div class="row"><span>NOMINAL DISTANCE</span><b>${b.sat?km.toLocaleString()+' km':b.au>=1?b.au.toFixed(2)+' AU':(km/1e6).toFixed(1)+' M km'}</b></div>
    <div class="row"><span>LIGHT ROUND TRIP</span><b>${lt}</b></div>
    ${b.hyper?'<div class="row"><span>ORBIT</span><b>hyperbolic, unbound</b></div>'
      :`<div class="row"><span>${b.sat?'ORBITS':'ORBITAL PERIOD'}</span><b>${b.sat?esc(((window.BODIES||[]).find(x=>x.id===b.sat)||{}).n||b.sat)+', '+(b.per*365).toFixed(1)+' days':b.per>=1?b.per.toLocaleString()+' yr':(b.per*365).toFixed(0)+' days'}</b></div>`}
    <div class="row"><span>RADIO LINK</span><b>none, not sonified</b></div>
    <div class="row"><span>POSITION</span><b>${b.sat?'schematic, not to scale':(window.ORBITS||{})[b.id]?'JPL elements':'approximate'}</b></div>
    <div class="sec">ABOUT</div><div class="m">${b.m}</div>
    <div class="close" title="close">&times;</div>`;
  el.dataset.sticky='1';
  el.style.left=Math.min(innerWidth-322,Math.max(6,px+16))+'px';
  el.style.top=Math.min(innerHeight-300,Math.max(6,py+14))+'px';
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  el.querySelector('.close').onclick=ev=>{ev.stopPropagation();
    el.classList.remove('on'); delete el.dataset.sticky;};
}
// Real-world location and, where we have one on hand, a real photo -- the
// three ground stations were visible and labelled on the globe already but
// had never been wired up to anything, unlike every body and craft on the
// map.
const STATION_INFO={
  gdscc:{loc:'Fort Irwin, near Barstow, California, USA',
    photo:'photos/goldstone-dss15.jpg',
    credit:'DSS-15 under the Milky Way. Courtesy NASA/JPL-Caltech.'},
  mdscc:{loc:'Robledo de Chavela, near Madrid, Spain',
    photo:'photos/mdscc-dss63.jpg',
    credit:'DSS-63, a 230-foot antenna at Madrid. Courtesy NASA.'},
  cdscc:{loc:'Tidbinbilla, near Canberra, Australia',
    photo:'photos/cdscc-dss43.jpg',
    credit:'DSS-43 by night, the 70-metre dish at Canberra. Courtesy NASA.'},
};
function openStation(k,px,py){
  const s=SITES[k]; if(!s) return;
  const info=STATION_INFO[k]||{};
  const el=$('detail'); el.classList.add('wide'); delete el.dataset.craft;
  const dishes=(s.dishes||[]).map(d=>`<div class="row"><span>${esc(d.n)}</span><b>${esc(d.type)}</b></div>`).join('');
  el.innerHTML=`<div class="t">${esc(s.name)} Complex</div>
    ${info.photo?`<img src="${info.photo}" alt="${esc(info.credit||'')}" style="width:100%;border-radius:2px;margin:6px 0;display:block">
      <div class="m" style="opacity:.6;margin-bottom:8px">${esc(info.credit||'')}</div>`:''}
    <div class="row"><span>LOCATION</span><b>${esc(info.loc||'')}</b></div>
    <div class="row"><span>COORDINATES</span><b>${s.lat.toFixed(2)}°, ${s.lon.toFixed(2)}°</b></div>
    <div class="sec">DISHES</div>
    ${dishes}
    <div class="sec">ABOUT</div><div class="m">One of the Deep Space Network's three complexes, spaced roughly 120&deg;
    apart in longitude so at least one always faces any given spacecraft as Earth turns.</div>
    <div class="close" title="close">&times;</div>`;
  el.dataset.sticky='1';
  el.style.left=Math.min(innerWidth-322,Math.max(6,px+16))+'px';
  el.style.top=Math.min(innerHeight-300,Math.max(6,py+14))+'px';
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  el.querySelector('.close').onclick=ev=>{ev.stopPropagation();
    el.classList.remove('on'); delete el.dataset.sticky;};
}
function openCraft(id,px,py){
  const f=FMAP[id]||{}, D=(window.FLEETDATA||{})[id]||{};
  const el=$('detail'); el.classList.add('wide');
  el.dataset.craft=id; el.dataset.sticky='1';
  renderCraft();
  el.style.left=Math.min(innerWidth-322,Math.max(6,px+16))+'px';
  el.style.top=Math.min(innerHeight-330,Math.max(6,py+14))+'px';
  el.classList.remove('on'); void el.offsetWidth;      // restart the holo flicker
  el.classList.add('on');
  el.querySelector('.close').onclick=ev=>{ev.stopPropagation();
    el.classList.remove('on'); delete el.dataset.sticky; delete el.dataset.craft;};
}
/* Redrawn every frame while pinned, so the signal block tracks the sky live. */
function renderCraft(){
  const el=$('detail'), id=el.dataset.craft; if(!id) return;
  const f=FMAP[id]||{}, D=(window.FLEETDATA||{})[id]||{}, fr=F[i];
  const lk=fr.links.filter(l=>l.sc===id);
  const dn=lk.find(l=>l.dir==='down'), up=lk.find(l=>l.dir==='up');
  const km=(f.au||0)*149597870.7, rt=km/299792.458*2;
  const lt=rt>7200?(rt/3600).toFixed(2)+' h':rt>120?(rt/60).toFixed(1)+' min':rt.toFixed(1)+' s';
  el.innerHTML=`<div class="t">${f.n||id}</div>
    ${D.photo?`<img src="${D.photo}" alt="${esc(D.credit||'')}" style="width:100%;border-radius:2px;margin:6px 0;display:block">
      <div class="m" style="opacity:.6;margin-bottom:8px">${esc(D.credit||'')}</div>`:''}
    <div class="row"><span>AGENCY</span><b>${D.ag||'--'}</b></div>
    <div class="row"><span>LAUNCHED</span><b>${D.yr||'--'}</b></div>
    <div class="row"><span>DESTINATION</span><b>${D.dest||f.cls||'--'}</b></div>
    <div class="sec">POSITION</div>
    <div class="row"><span>NOMINAL RANGE</span><b>${f.au>=1?f.au.toFixed(2)+' AU':km>=1e6?(km/1e6).toFixed(2)+' M km':Math.round(km).toLocaleString()+' km'}</b></div>
    <div class="row"><span>ROUND-TRIP LIGHT</span><b>${lt}</b></div>
    <div class="row"><span>ORBIT CLASS</span><b>${(f.cls||'--').toUpperCase()}</b></div>
    <div class="sec">LIVE SIGNAL</div>
    ${dn?`<div class="row"><span>DOWNLINK</span><b>${dn.r>=1e6?(dn.r/1e6).toFixed(2)+' Mb/s':(dn.r/1e3).toFixed(1)+' kb/s'}</b></div>
      <div class="row"><span>RECEIVED POWER</span><b>${dn.p} dBm</b></div>
      <div class="row"><span>ANTENNA</span><b>${dishOf(dn.d)} · ${SITEN[dn.st]}</b></div>
      <div class="row"><span>BAND</span><b>${bandOf(dn.b)}-band</b></div>
      <div class="row"><span>VOICE</span><b>${{S:'Soprano',A:'Alto',T:'Tenor',B:'Bass'}[dn.part]||'--'}</b></div>`
     :'<div class="row"><span>STATUS</span><b>no downlink this frame</b></div>'}
    ${up?`<div class="row"><span>UPLINK</span><b>${dishOf(up.d)} · ${bandOf(up.b)}-band</b></div>`:''}
    ${D.inst?`<div class="sec">INSTRUMENTS</div><div class="m">${D.inst}</div>`:''}
    ${D.m?`<div class="sec">MISSION</div><div class="m">${D.m}</div>`:''}
    <div class="close" title="close">&times;</div>`;
  const c=el.querySelector('.close');
  if(c) c.onclick=ev=>{ev.stopPropagation();el.classList.remove('on');
    delete el.dataset.sticky;delete el.dataset.craft;};
}

/* ---------- scope ---------- */
const sc=$('sc'), SX=sc.getContext('2d');
function drawScope(fr){
  const r=sc.getBoundingClientRect(), d=devicePixelRatio||1;
  if(sc.width!==Math.round(r.width*d)){sc.width=Math.round(r.width*d);sc.height=Math.round(r.height*d);}
  const W=sc.width,H=sc.height; SX.clearRect(0,0,W,H);
  SX.strokeStyle='rgba(27,40,54,.9)';SX.lineWidth=1;
  SX.beginPath();SX.moveTo(0,H/2);SX.lineTo(W,H/2);SX.stroke();
  const ns=PARTS.map(([p])=>[p,fr.notes[p]]).filter(([,n])=>n!=null);
  if(!ns.length)return;
  const base=Math.min(...ns.map(([,n])=>n));
  SX.lineWidth=2*d; SX.strokeStyle='#93D8EC'; SX.beginPath();
  for(let x=0;x<W;x++){
    let v=0;
    ns.forEach(([p,n])=>{v+=Math.sin((x/W)*Math.PI*2*Math.pow(2,(n-base)/12)*3+Date.now()/700)*((fr.expr[p]||70)/127);});
    v/=ns.length; const y=H/2-v*H*.30;
    x?SX.lineTo(x,y):SX.moveTo(x,y);
  }
  SX.stroke();
}

/* ---------- render ---------- */
const NN=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const nm=n=>NN[n%12]+(Math.floor(n/12)-1);
const QUAL={M:'maj',m:'min',o:'dim','+':'aug','(5)':'open',m7:'min 7',M7:'maj 7',m3:'min',M3:'maj','7':'dom 7','ø':'half-dim'};
function chordName(fr){
  const root=(45 + fr.chord[0]) % 12;      // 45 = A2, the generator's final
  return NN[root]+' '+(QUAL[fr.chord[1]]||fr.chord[1]);
}
function render(){
  const fr=F[i], T=TONES[tone];
  $('tName').textContent=T.occasion; $('tMode').textContent=T.mode;
  $('sState').textContent=fr.state; $('sChord').textContent='+'+fr.chord[0]+fr.chord[1];
  $('chord').textContent='+'+fr.chord[0]+fr.chord[1];
  $('sN').textContent=fr.n; $('sDbm').textContent=fr.dbm;
  $('sT').textContent=fr.t.slice(11,19);
  const dOn=fr.dualOn||[], dOff=fr.dualOff||[];
  const ev=fr.acq.length?'ACQ '+fr.acq.join(' '):fr.lost.length?'LOS '+fr.lost.join(' ')
    :dOn.length?'DUAL '+dOn.join(' '):dOff.length?'SNGL '+dOff.join(' '):'nominal';
  $('sEv').textContent=ev; $('sEv').className='val '+(fr.lock?'warn':'ok');
  $('rd').textContent=String(i+1).padStart(3,'0')+'/'+F.length;
  $('fN').textContent=fr.links.length;
  $('feed').innerHTML=fr.links.map(l=>{
    const c=l.part?{S:'#93D8EC',A:'#7FC4D8',T:'#5FD6A4',B:'#FF7A3D'}[l.part]:'#31445A';
    const f=FMAP[l.sc];
    return `<div class="lk ${l.dir==='up'?'up':''}" data-sc="${esc(l.sc)}">
      <div class="p" style="color:${c}">${l.part||'&uarr;'}</div>
      <div><div class="n">${f?esc(f.n):esc(l.sc)}</div>
      <div class="m">${SITEN[l.st]} &middot; ${dishOf(l.d)} &middot; ${bandOf(l.b)}-BAND</div></div>
      <div><div class="r">${l.r>=1e6?(l.r/1e6).toFixed(1)+'M':l.r>=1e3?(l.r/1e3).toFixed(1)+'k':l.r}</div>
      <div class="db">${l.p.toFixed(0)}</div></div></div>`;}).join('');
  $('vN').textContent=PARTS.filter(([p])=>fr.notes[p]!=null).length;
  $('vx').innerHTML=PARTS.map(([p,n])=>{
    const nt=fr.notes[p],e=fr.expr[p]||0;
    return `<div class="v ${nt==null?'off':''}" data-p="${p}"><div class="nm">${n}</div>
      <div class="nt">${nt==null?'--':nm(nt)}</div>
      <div class="b"><i style="width:${nt==null?0:e/127*100}%"></i></div>
      <div class="pc">${nt==null?'':Math.round(e/127*100)}</div></div>`;}).join('');
  $('tk').querySelector('.fl').style.width=(i/(F.length-1)*100)+'%';
  $('tk').querySelector('.h').style.left=(i/(F.length-1)*100)+'%';
  if(AP){
    $('gName').textContent=T.occasion;
    $('gSub').textContent=`${T.mode} · ${fr.state} · ${Number(fr.n)||0} links · ${fr.dbm} dBm · ${fr.t.slice(11,19)}`;
    $('gEv').textContent=fr.lock?ev:'';
    $('cName').textContent=chordName(fr);
    const st=PARTS.map(([p])=>fr.notes[p]).filter(n=>n!=null).sort((a,b)=>a-b);
    $('cStack').textContent=st.length?st.map(nm).join(' · '):'silent';
    // Mobile's second readout: no room for the full link list, so this is
    // one line naming the strongest signal plus a summary line. Same source
    // data as the desktop's #feed, condensed rather than duplicated.
    const dn=fr.links.filter(l=>l.dir==='down').sort((a,b)=>b.r-a.r);
    const top=dn[0];
    const topName=top?((FMAP[top.sc]||{}).n||top.sc):'no downlink';
    $('roBn').textContent=dn.length;
    $('roBbody').innerHTML=`<div class="r1">${esc(topName)}</div>
      <div class="r2">${fr.n} link${fr.n===1?'':'s'} &middot; ${fr.dbm} dBm &middot; ${esc(fr.t.slice(11,19))}</div>`;
  }
  paintHotspots(fr);
  updateFooter(fr);
  announceFrame(fr);
  if($('detail').dataset.craft) renderCraft();
  if(!$('signals').hidden) fillSignals();
  if(!$('music').hidden) fillMusicStats(fr);
  if(fr.lock){const t=$('toast');t.textContent=ev;t.classList.add('on');
    clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('on'),1600);}
}
function adv(){ if(liveMode) return; i=(i+1)%F.length;render();applyAudio(F[i]);}
function loop(){clearInterval(timer);if(playing)timer=setInterval(adv,step);}

/* ---------- input ---------- */
// Pinch-to-zoom. The wheel handler below only ever fires for a mouse or a
// trackpad -- a real phone has no wheel event at all, so without this a
// touch user has no way to zoom the map whatsoever. Tracks every active
// pointer by id; with exactly two down, scales `zoom` by the change in the
// distance between them instead of the single-finger pan/rotate below.
const touches=new Map();
let pinchD0=null, pinchZ0=null, panMid0=null, panX0=0, panY0=0;
function pinchDist(){
  const pts=[...touches.values()]; if(pts.length<2) return null;
  return Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
}
function pinchMid(){
  const pts=[...touches.values()]; if(pts.length<2) return null;
  return {x:(pts[0].x+pts[1].x)/2, y:(pts[0].y+pts[1].y)/2};
}
sky.addEventListener('pointerdown',e=>{
  touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(touches.size===2){ pinchD0=pinchDist(); pinchZ0=zoom;
    panMid0=pinchMid(); panX0=panX; panY0=panY; drag=null; return; }
  if(touches.size>2) return;                      // a third finger: ignore
  if(!inWindow(e.clientX,e.clientY)) return;      // console is not a trackball
  drag={x:e.clientX,y:e.clientY,yaw,pitch,moved:0};sky.classList.add('drag')});
addEventListener('pointerup',e=>{
  touches.delete(e.pointerId);
  if(touches.size<2){ pinchD0=null; pinchZ0=null; panMid0=null; }
  drag=null;sky.classList.remove('drag')});
addEventListener('pointercancel',e=>{touches.delete(e.pointerId);pinchD0=null;pinchZ0=null;panMid0=null;});
addEventListener('pointermove',e=>{
  if(touches.has(e.pointerId)) touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(touches.size===2&&pinchD0){
    const d=pinchDist(); if(d) zoom=Math.max(.15,Math.min(2.6,pinchZ0*(d/pinchD0)));
    // Two-finger pan, expanded map only. One-finger drag stays yaw/pitch
    // rotation everywhere -- it's how the star sphere and the orbital plane
    // turn together -- so a heliocentric body that zoom pushes toward an
    // edge needs a second gesture to bring back, not a repurposed first one.
    if(expanded&&panMid0){ const m=pinchMid();
      if(m){ panX=Math.max(-1600,Math.min(1600,panX0+(m.x-panMid0.x)));
             panY=Math.max(-1600,Math.min(1600,panY0+(m.y-panMid0.y))); } }
    return;
  }
  if(drag){drag.moved+=Math.abs(e.movementX||0)+Math.abs(e.movementY||0);
    yaw=drag.yaw+(e.clientX-drag.x)*.28;
    pitch=Math.max(-80,Math.min(80,drag.pitch-(e.clientY-drag.y)*.22)); return;}
  if(AP&&!inWindow(e.clientX,e.clientY)){hover=null;
    if(!$('detail').dataset.sticky)$('detail').classList.remove('on'); return;}
  if($('detail').dataset.sticky) return;      // a pinned star owns the panel
  const p=window.__pos; if(!p)return; let best=null,bd=22;
  for(const k in p){const d=Math.hypot(e.clientX-p[k].x,e.clientY-p[k].y); if(d<bd){bd=d;best=k;}}
  hover=best;
  const el=$('detail');
  if(best){const f=FMAP[best], lk=F[i].links.find(l=>l.sc===best);
    const km=f.au*149597870.7, s=km/299792.458*2;
    el.innerHTML=`<div class="t">${esc(f.n)}</div>
      <div class="row"><span>CLASS</span><b>${f.cls.toUpperCase()}</b></div>
      <div class="row"><span>NOMINAL RANGE</span><b>${f.au>=1?f.au.toFixed(1)+' AU':km>=1e6?(km/1e6).toFixed(2)+'M km':Math.round(km).toLocaleString()+' km'}</b></div>
      <div class="row"><span>ROUND-TRIP LIGHT</span><b>${s>3600?(s/3600).toFixed(1)+' h':s>60?(s/60).toFixed(1)+' min':s.toFixed(1)+' s'}</b></div>
      ${lk?`<div class="row"><span>NOW ON</span><b>${dishOf(lk.d)} ${bandOf(lk.b)}</b></div>
      <div class="row"><span>DOWNLINK</span><b>${lk.r>=1e3?(lk.r/1e3).toFixed(1)+' kb/s':lk.r+' b/s'}</b></div>
      <div class="row"><span>SIGNAL</span><b>${lk.p} dBm</b></div>`
      :'<div class="row"><span>STATUS</span><b>not tracked</b></div>'}`;
    el.style.left=Math.min(innerWidth-244,e.clientX+16)+'px';
    el.style.top=Math.min(innerHeight-160,e.clientY+14)+'px'; el.classList.add('on');
  } else el.classList.remove('on');
});
sky.addEventListener('wheel',e=>{if(!inWindow(e.clientX,e.clientY))return; e.preventDefault();zoom=Math.max(.15,Math.min(2.6,zoom*(e.deltaY>0?.92:1.09)));},{passive:false});

$('go').onclick=async e=>{
  e.target.disabled=true; e.target.textContent='Connecting…';
  // Created and resumed here, synchronously in the click, before anything
  // that awaits the network -- iOS ties its audio unlock to the gesture
  // itself, and connectLive() can legitimately take up to 15s. Resuming
  // only after that meant the AudioContext could report "running" (hence a
  // real playing-audio icon in Safari's own UI) while iOS had already
  // decided too much time had passed since the actual tap to ever produce
  // sound for it -- audibly silent despite every JS-visible signal saying
  // it was fine.
  // Reused, not recreated: the choir now arrives over the network, so Power Up
  // can fail and be retried, and a fresh AudioContext per attempt orphans the
  // last one. Browsers cap how many a page may hold, so a few retries on a bad
  // connection would stop being able to make one at all. Still created and
  // resumed synchronously inside the click -- that is what the iOS unlock is
  // tied to, and nothing may move ahead of it.
  if(!AC){
    AC=new (window.AudioContext||window.webkitAudioContext)();
    bus=AC.createGain(); bus.gain.value=.9; bus.connect(AC.destination);
  }
  if(AC.state==='suspended') await AC.resume();
  startFacts();
  // Before the samples were fetched this could not realistically fail, so
  // nothing caught it -- and a rejection here leaves the button disabled on
  // "Connecting..." with no way back. Now that the choir arrives over the
  // network that is a reachable state, so say what happened and let them
  // try again rather than stranding the page.
  let firstLive = null;
  try{
    if(MOMENT_ID){
      // A permalink asked for a specific piece of the archive, so do not open
      // a live socket at all -- connecting and then immediately overwriting F
      // would race the first live frame against the moment being loaded.
      //
      // A moment that will not load is not a failure worth stranding anyone
      // over: the id may be stale, or renamed, or simply typed wrong. Fall
      // through to the live sky, which is what the boot screen already
      // promised would happen. Choir failures still surface -- those are the
      // ones that leave nothing to listen to.
      await loadChoir();
      let m = null;
      try { m = await loadMoment(MOMENT_ID); }
      catch(_){ m = null; }
      if(m){ showMomentBanner(m); }
      else { firstLive = await connectLive(); }
    } else {
      [, firstLive] = await Promise.all([loadChoir(), connectLive()]);
    }
  }catch(err){
    stopFacts();
    const el=$('choirState');
    if(el) el.textContent='could not load the choir \u2014 check your connection and try again';
    e.target.disabled=false; e.target.textContent='Power up';
    return;
  }
  stopFacts();
  if(AC.state==='suspended')await AC.resume();
  if(firstLive){
    liveMode=true; F.length=0; F.push(firstLive); i=0; lastFrameAt=Date.now();
    wireLiveSocket(liveSocket);
    setLiveBadge('live');
    startStaleWatchdog();
  }
  $('boot').classList.add('gone'); setTimeout(()=>$('boot').style.display='none',1000);
  render(); applyAudio(F[i]);
  if(!liveMode) loop();
  handleOrientation();   // covers a page loaded already rotated to landscape
};
$('play').onclick=e=>{playing=!playing;e.target.textContent=playing?'Pause':'Play';
  e.target.classList.toggle('on',playing); playing?(applyAudio(F[i]),loop()):(clearInterval(timer),hush());};
$('au').onclick=e=>{muted=!muted;e.target.textContent=muted?'Audio off':'Audio on';
  e.target.classList.toggle('alt',!muted); muted?hush():applyAudio(F[i]);};
$('sp').onchange=e=>{step=+e.target.value;loop()};
$('tone').innerHTML=TONES.map((t,n)=>`<option value="${n}" ${n===5?'selected':''}>${t.occasion}</option>`).join('');
$('tone').onchange=e=>{tone=+e.target.value;render()};
function syncToneList(){
  const rows=document.querySelectorAll('#toneList .tone-row');
  rows.forEach(r=>r.classList.toggle('sel', +r.dataset.n===tone));
}
// Tap any setting to jump straight to it, rather than stepping through all
// ten one at a time on the COMM CH. SELECT knob. Built once; TONES is static.
$('toneList').innerHTML=TONES.map((t,n)=>
  `<div class="tone-row" data-n="${n}">${esc(t.occasion)}</div>`).join('');
$('toneList').addEventListener('click',e=>{
  const row=e.target.closest('.tone-row'); if(!row) return;
  tone=+row.dataset.n; $('tone').value=tone; syncToneList(); render();
});
syncToneList();
// locks is a one-time snapshot of lock-event indices into the baked demo
// array, built at load before live mode ever swaps F out from under it. In
// live mode those indices point at whatever now lives at that position in
// the trimmed live window -- garbage, or another craft's frame entirely --
// and F[i] going undefined threw inside render(), which permanently killed
// the requestAnimationFrame loop with no error surfaced anywhere: every
// canvas-drawn element (graticule included) froze and silently never came
// back. No equivalent "jump to next acquisition" exists for live data yet,
// so this just does nothing in live mode rather than corrupt state.
function liveNoAcq(){ const t=$('toast');t.textContent='NO RECORDED ACQUISITIONS IN LIVE MODE';
  t.classList.add('on'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'),1600); }
function flash(msg){
  const t=$('toast'); if(!t) return;
  t.textContent=msg; t.classList.add('on');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'),2600);
}
// A tape can have no lock events at all (mass-acquisition has none), and then
// locks[0] is undefined -- the same undefined-frame crash by another route.
function noLocks(){ flash('NO LOCK EVENTS ON THIS TAPE'); }
$('pv').onclick=()=>{ if(liveMode) return liveNoAcq(); if(!locks.length) return noLocks(); const p=[...locks].reverse().find(n=>n<i);i=p??locks[locks.length-1];render();applyAudio(F[i])};
$('nx').onclick=()=>{ if(liveMode) return liveNoAcq(); if(!locks.length) return noLocks(); const n=locks.find(m=>m>i);i=n??locks[0];render();applyAudio(F[i])};

/* ---------- tape archive ----------
   The phone has no room for the cockpit's tape unit, so the archive lives in
   the same panel system as Legend, Music and Signals. It does what the
   cockpit's transport keys do -- load a moment, eject back to live -- in
   place, on a running deck. Navigating to ?moment=... would be simpler and
   would throw the AudioContext away with the page; on iOS that means a
   second Power Up, and a second unlock gesture, for every tape. */
let tapeBusy=false;
function setPlaying(on){
  playing=on;
  const p=$('play'); p.textContent=on?'Pause':'Play'; p.classList.toggle('on',on);
  if(on && !liveMode) loop(); else clearInterval(timer);
}
// Leave live mode without the socket's own close handler reconnecting it:
// wireLiveSocket() only reconnects while liveMode is true, so flip that first.
function goOffline(){
  liveMode=false;
  clearInterval(staleWatchdog);
  if(liveSocket){ try{ liveSocket.close(); }catch(_){} liveSocket=null; }
  setLiveBadge('off');
}
async function tapeLoad(id){
  // Before Power Up there is no audio to lose, so a plain navigation is the
  // honest version: it lands on the boot screen describing that moment.
  if(!AC){ location.href=location.pathname+'?moment='+encodeURIComponent(id); return; }
  if(tapeBusy) return;
  tapeBusy=true;
  const entry=(await momentIndex()).find(m=>m.id===id);
  flash('LOADING · '+(entry?entry.title:id).toUpperCase());
  try{
    const m=await fetchMoment(id);
    // Only now, with the tape safely in hand, give up whatever was playing.
    if(liveMode) goOffline();
    mountMoment(m);
    history.replaceState(null,'',location.pathname+'?moment='+encodeURIComponent(id));
    showMomentBanner(m);
    setPlaying(true);
    render(); applyAudio(F[i]);
    closePanels();
  }catch(_){
    flash('THAT TAPE WOULD NOT LOAD · STILL ON THE PREVIOUS ONE');
  }finally{
    tapeBusy=false;
    if(!$('tapes').hidden) fillTapes();
  }
}
async function tapeEject(){
  if(!AC||tapeBusy||!MOMENT) return;
  tapeBusy=true;
  flash('EJECT · CONNECTING TO THE NETWORK');
  const frame=await connectLive();
  tapeBusy=false;
  // The tape stays in until live has actually delivered a frame, so a dead
  // feed costs nothing but the attempt.
  // connectLive() stores its socket in the global before it knows whether it
  // will work; on failure clear it, so liveSocket never means "we're live"
  // while we are not.
  if(!frame){
    if(liveSocket){ try{ liveSocket.close(); }catch(_){} liveSocket=null; }
    flash('LIVE FEED UNREACHABLE · TAPE STAYS IN'); return;
  }
  MOMENT=null;
  liveMode=true; F.length=0; F.push(frame); i=0; lastFrameAt=Date.now();
  rebuildLocks();
  wireLiveSocket(liveSocket);
  setLiveBadge('live');
  startStaleWatchdog();
  history.replaceState(null,'',location.pathname);
  $('momentBanner').hidden=true;
  setPlaying(true);
  render(); applyAudio(F[i]);
  if(!$('tapes').hidden) fillTapes();
}
async function fillTapes(){
  // The first open can arrive before the index has been fetched; say so
  // rather than showing an empty panel for however long that takes.
  if(!MOMENT_INDEX && $('tapeList'))
    $('tapeList').innerHTML='<p class="lead">Reading the archive index&hellip;</p>';
  const list=await momentIndex(), el=$('tapeList'), now=$('tapeNow');
  if(!el||!now) return;
  now.innerHTML=MOMENT
    ? '<span class="lbl">Loaded</span><b>'+esc(MOMENT.title)+'</b>'
      +(AC?'<button class="tbtn" id="tapeEjectBtn">Eject &middot; back to live</button>':'')
    : '<span class="lbl">Loaded</span><b>'
      +(liveMode?'Nothing &mdash; live from the network':'Nothing &mdash; recorded demo')+'</b>';
  el.innerHTML=list.length
    ? list.map((m,n)=>'<button class="tape-row'+(MOMENT&&MOMENT.id===m.id?' sel':'')
        +'" data-id="'+esc(m.id)+'">'
        +'<span class="tn">'+String(n+1).padStart(2,'0')+'</span>'
        +'<span class="tt">'+esc(m.title)+'</span>'
        +'<span class="tw">'+esc(m.why)+'</span>'
        +'<span class="tm">'+esc(String(m.t).slice(0,16).replace('T',' '))+' UTC &middot; '
        +m.downlinks+' downlink'+(m.downlinks===1?'':'s')+'</span></button>').join('')
    : '<p class="lead">The archive index did not load.</p>';
}
$('tapes').addEventListener('click',e=>{
  if(e.target.closest('#tapeEjectBtn')){ tapeEject(); return; }
  const row=e.target.closest('.tape-row'); if(row) tapeLoad(row.dataset.id);
});
// The banner's "back to live" link reloads the page without JS; with a
// running deck it ejects in place instead, for the same reason as above.
$('momentBanner').addEventListener('click',e=>{
  const a=e.target.closest('a'); if(!a||!AC||!MOMENT) return;
  e.preventDefault(); tapeEject();
});
$('tk').onclick=e=>{const r=e.currentTarget.getBoundingClientRect();
  i=Math.round((e.clientX-r.left)/r.width*(F.length-1));render();applyAudio(F[i])};
addEventListener('keydown',e=>{
  if(e.key===' '){e.preventDefault();$('play').click()}
  if(e.key==='ArrowRight')$('nx').click(); if(e.key==='ArrowLeft')$('pv').click();
});
/* every overlay opens the same way, so they all get the holo flicker */
function openPanel(id){
  ['help','music','signals','tapes'].forEach(k=>{ if(k!==id) $(k).hidden=true; });
  // closePanels() clears a pinned dossier on the way OUT; opening a panel is
  // a separate path that skips closePanels() entirely (it needs to hide the
  // other two panels but show this one, not hide all three), so the same
  // dossier leak needs clearing here too, on the way IN.
  const d=$('detail'); d.classList.remove('on','wide');
  delete d.dataset.sticky; delete d.dataset.craft;
  const el=$(id); el.hidden=false;
  // The moment banner sits above every panel (z 30 vs 14) and on a phone it
  // is tall enough to cover a panel's heading. Hide it while a panel is up
  // rather than reshuffling the stacking order everything else depends on.
  document.body.classList.add('panelopen');
  const box=el.querySelector('.holo')||el.firstElementChild;
  if(box){ box.classList.remove('in'); void box.offsetWidth; box.classList.add('in'); }
  if(id==='music') fillMusic();
  if(id==='signals') fillSignals();
  if(id==='tapes') fillTapes();
}
function closePanels(){
  ['help','music','signals','tapes'].forEach(k=>$(k).hidden=true);
  document.body.classList.remove('panelopen');
  // A pinned dossier lives in a separate system from these panels and was
  // never included here, so it kept its state (and, for Legend specifically,
  // stayed hidden but still open underneath -- Legend's opaque full-screen
  // background sits above it) while the user believed they had closed
  // everything. toggleMap() already calls this on entry, so fixing it once
  // here also closes the same gap for the expand-map path.
  const d=$('detail'); d.classList.remove('on','wide');
  delete d.dataset.sticky; delete d.dataset.craft;
}
$('helpBtn').onclick=()=>{ window.open('manual.html','fvManual','noopener'); };
$('btnLegend').onclick=()=>openPanel('help');
$('btnMusic').onclick=()=>openPanel('music');
$('btnSignals').onclick=()=>openPanel('signals');
$('btnMap').onclick=()=>{autoMapLandscape=false; toggleMap();};
$('musicBtn').onclick=()=>{ $('music').hidden?openPanel('music'):closePanels(); };
$('sigBtn').onclick=()=>{ $('signals').hidden?openPanel('signals'):closePanels(); };
$('tapeBtn').onclick=()=>{ $('tapes').hidden?openPanel('tapes'):closePanels(); };
$('btnTapes').onclick=()=>openPanel('tapes');
$('mapBtn').onclick=()=>{autoMapLandscape=false; toggleMap(); $('mapBtn').classList.toggle('on',expanded);};
$('mapHint').addEventListener('click',e=>{
  const b=e.target.closest('.ob'); if(!b) return;
  if(b.id==='obReset'){ simDays=0; return; }
  if(b.id==='btnFocus'){ toggleFocus(); return; }
  ORBIT_YPS=+b.dataset.y;
  [...document.querySelectorAll('#mapHint .ob')].forEach(x=>x.classList.toggle('on',x===b));
});
// Solar-system and Earth-local satellites differ by four or five orders of
// magnitude in distance -- one zoom range can never resolve both. Rather
// than stretch `zoom` further, this switches which body sits at the drawing
// origin: the Sun (interplanetary scale, the fleet a small cluster on
// Earth) or Earth itself (its own moon and tracked spacecraft drawn as the
// primary content, at a scale meant for actually telling LEO from lunar
// distance apart). Panning and zoom reset on switch since neither number
// means the same thing in the other frame.
function toggleFocus(){
  mapFocus=mapFocus==='sun'?'earth':'sun';
  panX=0; panY=0; zoom=1;
  $('btnFocus').textContent=mapFocus==='sun'?'Focus Earth':'Focus Solar System';
}
function toggleMap(){
  expanded=!expanded;
  panX=0; panY=0; zoom=1; mapFocus='sun'; $('btnFocus').textContent='Focus Earth';
  document.body.classList.toggle('bigmap',expanded);
  // Set this directly rather than through the class rule: the cascade was not
  // reliably applying it to the img, and this is unambiguous. Full 0, not the
  // desktop's 0.16 -- on a phone the suit-photo porthole is small enough that
  // even a dim ghost of it still framed and cramped the map into that same
  // small region instead of reading as a plain full-bleed sky. There's no
  // console worth keeping a hint of at this size; the star field is the
  // whole screen when expanded, full stop.
  const bz=$('bezel');
  if(bz){ bz.style.transition='opacity .4s'; bz.style.opacity=expanded?'0':'1'; }
  $('btnMap').textContent=expanded?'Exit map':'Expand map';
  if(expanded) closePanels();
}

// Landscape has nowhere good to put a portrait chest-unit photo: contain-fit
// shrinks the whole bezel to the shorter dimension, wasting most of the width
// as letterboxing either side, with the readouts rendered close to
// illegible. The expanded map isn't tied to that photo's aspect at all, so
// it uses the width landscape actually offers instead of wasting it. Only
// auto-close on the way back to portrait if THIS rule was what opened it --
// a map the user opened by hand, in portrait, stays open through a rotation.
let autoMapLandscape=false;
function handleOrientation(){
  const landscape=innerWidth>innerHeight;
  if(landscape){
    if(!expanded){ toggleMap(); autoMapLandscape=true; }
  } else {
    if(expanded&&autoMapLandscape) toggleMap();
    autoMapLandscape=false;
  }
}
addEventListener('resize',handleOrientation);
if(screen.orientation) screen.orientation.addEventListener('change',handleOrientation);
$('helpClose').onclick=closePanels; $('musicClose').onclick=closePanels; $('sigClose').onclick=closePanels;
$('tapesClose').onclick=closePanels;
// Backdrop taps close a panel. #tapes also has a delegated click listener
// for its rows, so this uses addEventListener rather than onclick for it --
// assigning onclick would not clobber that listener, but keeping every
// handler on one mechanism per element is less surprising.
['help','music','signals'].forEach(k=>$(k).onclick=e=>{if(e.target.id===k)closePanels();});
$('tapes').addEventListener('click',e=>{ if(e.target.id==='tapes') closePanels(); });
addEventListener('keydown',e=>{
  if(e.key==='?'||(e.key==='/'&&e.shiftKey)) $('help').hidden?openPanel('help'):closePanels();
  if(e.key==='m'||e.key==='M') $('music').hidden?openPanel('music'):closePanels();
  if(e.key==='s'||e.key==='S') $('signals').hidden?openPanel('signals'):closePanels();
  if(e.key==='t'||e.key==='T') $('tapes').hidden?openPanel('tapes'):closePanels();
  if(e.key==='Escape'){ closePanels(); if(expanded) toggleMap(); }
  if(e.key==='f'||e.key==='F') toggleMap();
});

/* The comparison table and ten-settings table are static reference data --
   fillMusic() runs once, on open. The three sighead stats are the opposite:
   what's actually sounding right now, so they redraw every frame the panel
   is open, the same way fillSignals() already does for the Signals panel. */
function fillMusicStats(fr){
  const T=TONES[tone];
  $('mSetting').textContent='№'+T.tone;
  $('mMode').textContent=T.mode;
  $('mChord').textContent=chordName(fr);
}
function fillMusic(){
  fillMusicStats(F[i]);
  document.querySelectorAll('#corpusPick button').forEach(b=>{
    b.onclick=()=>applyCorpus(b.dataset.k);
    b.classList.toggle('on', b.dataset.k===corpusKey);
  });
  $('cmpTbl').innerHTML=`
    <tr><td></td><td>chords</td><td>distinct moves</td><td>seen once</td><td>dead ends</td></tr>
    <tr><td>Lyadov 1910</td><td>941</td><td><b>73</b></td><td>21%</td><td>1.8% of traffic</td></tr>
    <tr><td>Arkhangelsky 1892</td><td>6,231</td><td><b>89</b></td><td>10%</td><td>0.3% of traffic</td></tr>`;
  $('mTones').innerHTML=TONES.map(t=>{
    const lo=t.mode_confidence==='low';
    return `<tr><td>${t.tone}</td><td>${t.occasion}</td>
      <td>${t.mode}</td>
      <td class="${lo?'lo':''}">${t.mode_confidence}</td>
      <td>${t.n_chords} chords</td><td>${t.voices} vv</td></tr>`;}).join('');
}

/* Live link budget. Redrawn on every frame while open, so it tracks the sky. */
function fillSignals(){
  if($('signals').hidden) return;
  const fr=F[i];
  const dn=fr.links.filter(l=>l.dir==='down').sort((a,b)=>b.r-a.r);
  const up=fr.links.filter(l=>l.dir==='up');
  const agg=dn.reduce((a,l)=>a+l.r,0);
  $('sigN').textContent=dn.length;
  $('sigAgg').textContent=agg>=1e6?(agg/1e6).toFixed(2)+' Mb/s':(agg/1e3).toFixed(0)+' kb/s';
  $('sigT').textContent=fr.t.slice(11,19);
  const PN={S:'Soprano',A:'Alto',T:'Tenor',B:'Bass'};
  const row=(l,isUp)=>{
    const f=FMAP[l.sc]||{}, D=(window.FLEETDATA||{})[l.sc]||{};
    const lg=Math.log10(Math.max(1,l.r));                 // 0..8ish
    const w=Math.max(3,Math.min(100,(lg/8)*100));
    const pw=Math.max(0,Math.min(1,(l.p+160)/75));        // -160..-85 dBm
    const per=(2.6-pw*1.9).toFixed(2);
    return `<div class="sigrow ${isUp?'up':''}">
      <div><div class="nm">${esc(f?f.n:l.sc)}</div><div class="sub">${D.ag||''}</div></div>
      <div class="meta">${SITEN[l.st]}<br>${dishOf(l.d)} · ${bandOf(l.b)}-BAND</div>
      <div class="sigbar"><i style="width:${w}%;opacity:${(0.35+pw*0.65).toFixed(2)}"></i>
        <u style="animation-duration:${per}s"></u></div>
      <div class="rate">${l.r>=1e6?(l.r/1e6).toFixed(2)+' Mb':l.r>=1e3?(l.r/1e3).toFixed(1)+' kb':l.r+' b'}</div>
      <div class="pw">${l.p} dBm<br><span style="color:var(--ice)">${isUp?'UP':(PN[l.part]||'--')}</span></div>
    </div>`;};
  $('sigRows').innerHTML=dn.map(l=>row(l,false)).join('')+up.map(l=>row(l,true)).join('');
}
/* Capture mode. ?shot=1 skips the audio load and boots straight to the deck so
   a headless browser can photograph it; the other params open a specific panel
   or dossier so documentation images are reproducible rather than hand-timed. */
// A real "right now" figure on the boot screen, not decoration -- the same
// downlink count every /live subscriber gets, read from the publisher's own
// last frame via a small unauthenticated status route, never a separate
// guess. Silent on any failure (stale, unreachable, or no frame published
// yet): a boot stat that sometimes shows an error would read worse than one
// that just doesn't appear.
fetch('/status').then(r=>r.ok?r.json():null).then(j=>{
  if(!j||j.stale||j.n==null) return;
  const el=$('liveStat');
  el.textContent=`Right now: ${j.n} downlink${j.n===1?'':'s'} active across the network`;
  el.hidden=false;
}).catch(()=>{});

(function shotMode(){
  const q=new URLSearchParams(location.search);
  if(!q.has('shot')) return;
  const boot=$('boot');
  const go=()=>{
    boot.classList.add('gone'); boot.style.display='none';
    if(q.has('frame')) i=Math.min(F.length-1, Math.max(0, +q.get('frame')));
    if(q.has('tone'))  { tone=+q.get('tone'); $('tone').value=tone; }
    if(q.has('corpus'))applyCorpus(q.get('corpus'));
    playing=false;
    render();
    if(q.has('map')) toggleMap();
    if(q.get('focus')==='earth') toggleFocus();
    if(q.has('panel')) openPanel(q.get('panel'));
    setTimeout(()=>{
      if(q.has('craft')){
        const p=window.__pos||{}, k=q.get('craft');
        if(p[k]) openCraft(k, p[k].x, p[k].y);
      }
      if(q.has('star')){
        const h=(starHits||[]).find(x=>x.n===q.get('star'))||starHits[0];
        if(h) sky.dispatchEvent(new MouseEvent('click',{clientX:h.x,clientY:h.y,bubbles:true}));
      }
    }, 700);
  };
  if(document.readyState==='complete') setTimeout(go,120); else addEventListener('load',()=>setTimeout(go,120));
})();

locks.forEach(n=>{const d=document.createElement('div');d.className='m';
  d.style.left=(n/(F.length-1)*100)+'%';$('tk').appendChild(d)});

fetch('overlay/mobile/mobile_overlay.json').then(r=>r.ok?r.json():null).then(j=>{
  if(!j){ $('bezel').remove(); return; }
  AP=j; document.body.classList.add('cockpit');
  const im=new Image(); im.onload=()=>{buildApertureMask(im); layoutCockpit();};
  im.src='overlay/mobile/mobile_overlay.png';
  layoutCockpit();
  fetch('overlay/mobile/hotspots.json').then(r=>r.ok?r.json():null).then(h=>{
    if(h){ HS=h; layoutHotspots(); }
  }).catch(()=>{});
}).catch(()=>{ const b=$('bezel'); if(b) b.remove(); });

let __last=performance.now();
(function tick(){
  const now=performance.now(); simDays+=ORBIT_YPS*(now-__last)/1000; __last=now;
  if(!$('boot').classList.contains('gone')){yaw+=.02;}
  drawSky(F[i]); drawScope(F[i]); requestAnimationFrame(tick); })();
render();
