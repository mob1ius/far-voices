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
  if(READER) readerSync();          // the card reader's decks follow, whichever control changed it
}
const EPOCH=Date.now();
let ORBIT_YPS=0;        // simulated DAYS added per real second
let simDays=0;
let yaw=0,pitch=-14,zoom=1,drag=null,hover=null,mapFocus='sun';

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
      else if(msg.type==='report'&&typeof deckReport==='function') deckReport(msg);
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
    else if(msg.type==='report'&&typeof deckReport==='function') deckReport(msg);   // deck_report.js
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
let AP=null, apCtx=null, TIMER=null, FOOT=null, TAPE=null, SCORE=null, GALLEY=null, NAV=null, COMMS=null, CREW=null, GUIDE=null, LIBRARY=null, FDAI=null, READER=null, ARCHIVE=null;
let apMask=null, apMW=0, apMH=0; const MSCALE=4;
// The cockpit photo's own height, before anything is stacked under it.
const COCKPIT_H=1440;
/* Strips stack under the cockpit, top to bottom, in this order. Each is a
   2560-wide photo whose apertures are authored in its own local space; the
   loader shifts them into the combined frame. A strip whose JSON is missing
   is skipped and the ones below it close up, instead of the old hand-nested
   fetches where one failure took every later strip down with it. Adding a
   strip is one entry here plus its own layout code in layoutCockpit(). */
const STRIPS=[
  // Guidance sits right under the window it steers.
  {json:'overlay/guidance.json', png:'overlay/guidance_overlay.webp', img:'guidebezel',
   show:['dskyCv','dskyLamps','dskyKeys','refCv','rhcGrip','rhcScope','attHoldSw','attHoldSw2','attLampCol'],
   ready:j=>{ GUIDE=j; }, after:()=>guideInit()},
  // The attitude ball sits beside the stick that flies it.
  // The advisory readout: every banner scrolls through here, directly below
  // the hand controller that causes most of them.
  {json:'overlay/advisory.json', png:'overlay/advisory_overlay.webp', img:'advbezel',
   show:[],
   ready:j=>{ if(typeof advInit==='function') advInit(j); },
   after:()=>{ if(typeof advLayout==='function') advLayout(); }},
  {json:'overlay/fdai.json', png:'overlay/fdai_overlay.webp', img:'fdaibezel',
   show:['fdaiCv','clockG','clockM','clockC','fLampG','fLampM','fLampC','abortBtn','abortGuard','clkknobG','clkknobM','clkknobC'],
   ready:j=>{ FDAI=j; }, after:()=>fdaiInit()},
  // Ship systems: the event timer, propellant and cabin temperature, in the
  // bezels this strip was drawn with.
  {json:'overlay/timer.json', png:'overlay/timer_overlay.webp', img:'timerbezel',
   show:[],
   ready:j=>{ TIMER=j; },
   after:()=>{ if(typeof shipLayout==='function') shipLayout(); }},
  {json:'overlay/footer.json', png:'overlay/footer_overlay.png', img:'footbezel',
   show:['logbook','ticker','powerSw','hvacSw'], ready:j=>{ FOOT=j; }},
  {json:'overlay/tape.json', png:'overlay/tape_overlay.png', img:'tapebezel',
   show:['reelA','reelB','momentIndex','momentCounter','tRew','tStop','tPlay','tFf',
         'rotOuter','rotInner','rotMarks'],
   ready:j=>{ TAPE=j; }, after:()=>renderTape()},
  // The library shelves the tapes the deck above it plays.
  {json:'overlay/library.json', png:'overlay/library_overlay.webp', img:'librarybezel',
   show:['libDate','libShelf','libPrev','libNext','retBar'],
   ready:j=>{ LIBRARY=j; }, after:()=>libInit()},
  {json:'overlay/score.json', png:'overlay/score_overlay.png', img:'scorebezel',
   show:['scoreCanvas','scoreSetting','scoreTone','sSpeed','sPen'],
   ready:j=>{ SCORE=j; }, after:()=>{ layoutScore(); scoreLastKey=''; scoreWrite(F[i]); }},
  // The harmony's card reader sits under the chart it changes.
  {json:'overlay/reader.json', png:'overlay/reader_overlay.webp', img:'readerbezel',
   show:['feedCv','gaugeP','gaugeT','gaugeC','gaugeO','deckL','deckA','rdStart','rdStop','rdReset','rdLamp'],
   ready:j=>{ READER=j; }, after:()=>readerInit()},
  {json:'overlay/galley.json', png:'overlay/galley_overlay.png', img:'galleybezel',
   show:['galMw','galGlow','galStart','galCab'], ready:j=>{ GALLEY=j; }, after:()=>layoutGalley()},
  {json:'overlay/nav.json', png:'overlay/nav_overlay.webp', img:'navbezel',
   show:['navGlobe','lampG','lampM','lampC','globusKnob','cardWin','knobPrev','knobNext','drumCvA','drumCvB'],
   ready:j=>{ NAV=j; }, after:()=>navInit()},
  // Slides of the spacecraft whose cards are in the file above it.
  {json:'overlay/archive.json', png:'overlay/archive_overlay.webp', img:'archivebezel',
   show:['slideCv','beam','slideFwd','slideRev','discBtn','caseGlass','coverBtn'],
   ready:j=>{ ARCHIVE=j; }, after:()=>archiveInit()},
  {json:'overlay/comms.json', png:'overlay/comms_overlay.webp', img:'commsbezel',
   show:['ttyCv','tapeCv','hereIs','pageWin','ckTabs','rbf1','rbf2','rbf3','ttyKbd','armL','armR'],
   ready:j=>{ COMMS=j; }, after:()=>commsInit()},
  {json:'overlay/crew.json', png:'overlay/shelf_overlay.webp', img:'crewbezel',
   show:['jarWin','perkGlow','steam','mugSteam','percBtn','mugBtn','pencilItem','cardItem'],
   ready:j=>{ CREW=j; }, after:()=>crewInit()},
  // The lower porthole. Its own window on the same sky, looking ninety degrees
  // to port, plus whatever drifts past outside. deck_porthole.js builds its own
  // elements, so there is nothing to reveal here.
  {json:'overlay/porthole.json', png:'overlay/porthole_overlay.webp', img:'portbezel',
   show:[],
   ready:j=>{ if(typeof portReady==='function') portReady(j); },
   after:()=>{ if(typeof portInit==='function') portInit(); }},
];
function buildApertureMask(img){
  const c=document.createElement('canvas');
  // COCKPIT_H, not AP.frame[1]: the strips' JSON usually lands before this
  // PNG does, and by then the frame has grown to the whole stack -- sizing
  // the mask to that stretched the cockpit photo down the page and moved
  // every see-through test off the glass it belongs to.
  c.width=AP.frame[0]; c.height=COCKPIT_H;
  apCtx=c.getContext('2d',{willReadFrequently:true});
  apCtx.drawImage(img,0,0,c.width,c.height);
  // Downsampled boolean copy: getImageData per star per frame is far too slow,
  // and this is only ever asked "is this point see-through".
  apMW=Math.ceil(AP.frame[0]/MSCALE); apMH=Math.ceil(COCKPIT_H/MSCALE);
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
  if(x<0||y<0||x>=AP.frame[0]||y>=COCKPIT_H) return 255;
  return apCtx.getImageData(x,y,1,1).data[3];
}
function inWindow(sx,sy){
  if(expanded) return true;          // expanded map is the whole screen
  if(!AP) return true;
  const w=apRect('window');
  if(sx<w.x||sx>w.x+w.w||sy<w.y||sy>w.y+w.h) return false;
  return transparentAt(sx,sy);
}
/* widest transparent run at a given y, so HUD text never rides onto the frame */
function safeSpan(yPix){
  const w=apRect('window'); const c=coverRect();
  let lo=null,hi=null;
  for(let x=Math.round(w.x);x<=Math.round(w.x+w.w);x+=3){
    if(alphaAt(x,yPix)<128){ if(lo===null)lo=x; hi=x; }
  }
  return lo===null?{x:w.x,w:w.w}:{x:lo+6,w:Math.max(40,hi-lo-12)};
}
/* ---------- PAN MODE: the console on a phone.
   The deck is 2560 units wide and the desktop rule is "fit that to the
   viewport". On a 375px phone that gives a scale of 0.146, which renders a
   working spacecraft console at the size of a postage stamp: legible as a
   picture, useless as an instrument.
   Pan mode changes the basis. Instead of fitting the whole deck across, it
   fits the WINDOW across, with a margin of bezel either side so the hexagon
   is framed rather than bleeding off the edges, and lets the deck overflow in
   both directions for the viewer to swipe around.
   The important property is that this is a scale change and nothing else. No
   CSS transform, no second coordinate space. Every aperture, hit test, canvas
   and gauge on the deck is computed in page pixels from coverRect().s, so they
   all keep working at the new scale with no special cases anywhere. A
   transform wrapper would have been the obvious approach and would have broken
   every hit test on the deck, because pgX/pgY read page coordinates. */
const WINDOW_FRAME = 1.34;      // window width plus a third, so bezel frames it
let panMode = false;
function wantPanMode(){
  const q = new URLSearchParams(location.search).get('deck');
  if(q === 'console') return true;
  if(q === 'wide') return false;
  return (document.documentElement.clientWidth || innerWidth) < 700;
}
function panScale(vw){
  // The window aperture lives in the cockpit overlay, which is loaded before
  // any strip. Until it is there, fall back to the desktop rule.
  const w = AP && AP.apertures && AP.apertures.window ? AP.apertures.window[2] : null;
  if(!w) return null;
  return vw / (w * WINDOW_FRAME);
}

function coverRect(){
  // WIDTH-FILL. The deck spans the window edge to edge and the page scrolls
  // down through the strips. CONTAIN on the whole stack had to fit three
  // strips into one screen and left wide black bars either side, which
  // only got worse with each strip added. Everything the deck positions,
  // and every hit test, is in PAGE coordinates, so there is no offset here:
  // (0,0) is the top-left of the cockpit photo and of the document.
  // clientWidth, not innerWidth: a classic scrollbar is not deck. Guard the
  // zero-size case: a hidden tab reports 0 and hit tests then throw on NaN.
  const vw=Math.max(1,document.documentElement.clientWidth||innerWidth);
  if(panMode && !expanded){
    const s=panScale(vw);
    if(s) return {s, ox:0, oy:0};
  }
  return {s:vw/AP.frame[0] || 1, ox:0, oy:0};
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
      bz.style.width=(2560*c.s)+'px'; bz.style.height=(1440*c.s)+'px'; }
    STRIPS.forEach(st=>{
      const im=st.j&&$(st.img); if(!im) return;
      im.style.left='0px'; im.style.top=(st.top*c.s)+'px';
      im.style.width=(2560*c.s)+'px'; im.style.height=(st.j.frame[1]*c.s)+'px';
    });
    // The page is exactly as tall as the stacked deck. Every deck layer is
    // absolute, so this is what gives the scrollbar its length.
    const pageH=Math.ceil(AP.frame[1]*c.s)+'px';
    document.body.style.height=pageH; $('spots').style.height=pageH;
    // In pan mode the deck is wider than the viewport. Absolutely positioned
    // children do extend the scrollable overflow area, but body's own width
    // still reports the viewport, which several things read. Set it.
    const pageW=Math.ceil(AP.frame[0]*c.s)+'px';
    document.body.style.width = panMode ? pageW : '';
    $('spots').style.width = panMode ? pageW : '';
    size();
    if(FOOT){
      const put=(el,r,pad)=>{el.style.left=(r.x+pad)+'px';el.style.top=(r.y+pad)+'px';
        el.style.width=(r.w-pad*2)+'px';el.style.height=(r.h-pad*2)+'px';};
      const lg=apRect('logbook'), tk=apRect('ticker');
      put($('logbook'), lg, 6);
      put($('ticker'),  tk, 6);
      $('logbook').style.fontSize=Math.max(7,Math.min(13,lg.h*0.075))+'px';
      $('ticker').style.fontSize=Math.max(8,Math.min(17,tk.h*0.34))+'px';
    }
    if(TAPE){
      const box=(el,r)=>{el.style.left=r.x+'px';el.style.top=r.y+'px';
        el.style.width=r.w+'px';el.style.height=r.h+'px';};
      box($('reelA'), apRect('reelA'));
      box($('reelB'), apRect('reelB'));
      const mi=apRect('momentIndex'), mc=apRect('momentCounter');
      box($('momentIndex'), mi); box($('momentCounter'), mc);
      $('momentIndex').style.fontSize=Math.max(9,Math.min(19,mi.h*0.115))+'px';
      $('momentCounter').style.fontSize=Math.max(9,Math.min(22,mc.h*0.20))+'px';
      // The two rotary zones are concentric, so they are sized from the
      // centre out and floored at a real target size rather than just
      // scaled: at this strip's usual scale the painted outer ring is about
      // six pixels wide, and a six-pixel ring is not something anyone can
      // click. The floors keep the inner knob at 26px and the outer disc at
      // 46px whatever the viewport does, which puts the ring's grabbable
      // band at ten pixels all the way round.
      const knob=(el,r,min)=>{
        if(!el) return;
        const d=Math.max(min,r.w), cx=r.x+r.w/2, cy=r.y+r.h/2;
        el.style.left=(cx-d/2)+'px'; el.style.top=(cy-d/2)+'px';
        el.style.width=d+'px'; el.style.height=d+'px';
      };
      ['tRew','tStop','tPlay','tFf'].forEach(id=>{ const k=$(id); if(k) box(k, apRect(id)); });
      knob($('rotOuter'), apRect('rotary'), 46);
      knob($('rotInner'), apRect('rotaryInner'), 26);
      const rk=apRect('rotary'), sv=$('rotMarks');
      if(sv){ sv.style.left=rk.x+'px'; sv.style.top=rk.y+'px';
              sv.style.width=rk.w+'px'; sv.style.height=rk.h+'px'; }
    }
  }
  const put=(el,r,pad)=>{el.style.left=(r.x+pad)+'px';el.style.top=(r.y+pad)+'px';
    el.style.width=(r.w-pad*2)+'px';el.style.height=(r.h-pad*2)+'px';
    el.style.right='auto';el.style.bottom='auto';};
  put($('left'),  apRect('termA'), 10);
  put($('right'), apRect('termB'), 10);
  const c=apRect('termC');
  const b=$('bot'); b.style.left=(c.x+10)+'px'; b.style.top=(c.y+10)+'px';
  b.style.width=(c.w-20)+'px'; b.style.height=(c.h-20)+'px'; b.style.right='auto';
  b.style.bottom='auto'; b.style.flexWrap='wrap'; b.style.alignContent='flex-start';
  const w=apRect('window');
  const g=$('glass');
  g.style.display='block';
  placeToast();
  const gy=w.y+w.h*0.10;
  const sp=safeSpan(gy+10);
  g.style.left=sp.x+'px'; g.style.width=sp.w+'px'; g.style.top=gy+'px';
  $('top').style.display='none';
  layoutScore(); layoutGalley(); layoutNav(); layoutComms(); layoutCrew(); layoutGuide(); layoutLibrary(); layoutFdai(); layoutReader(); layoutArchive(); layoutLinks();
  // Same transform as everything above, so it has to move with it.
  layoutHotspots();
}
addEventListener('resize',()=>{layoutCockpit();layoutHotspots();});
/* On a phone the deck opens looking at the window rather than at the top-left
   corner of a console four times wider than the screen. Horizontally centred on
   the hexagon; vertically placed so the window sits a little above centre,
   which is where a real one is and leaves the panel below it in shot. */
let centred = false;
function centreOnWindow(force){
  if(!panMode || (centred && !force) || !AP || !AP.apertures || !AP.apertures.window) return;
  const w = apRect('window');
  // documentElement.clientWidth/Height, not innerWidth/innerHeight. The two
  // disagree whenever the document scrolls in a direction the window does not
  // expect, and innerWidth then reports the content box rather than the visual
  // viewport, which made this compute a negative offset and clamp to zero: the
  // deck opened on its own top-left corner instead of the window. coverRect()
  // already reads clientWidth for exactly this reason.
  const de = document.documentElement;
  const vw = de.clientWidth || innerWidth;
  const vh = de.clientHeight || innerHeight;
  const x = Math.max(0, w.x + w.w / 2 - vw / 2);
  const y = Math.max(0, w.y + w.h / 2 - vh * 0.42);
  scrollTo({ left: x, top: y, behavior: 'instant' });
  // Belt and braces. scrollTo with an options object is the modern form and is
  // what every current browser wants, but it is also the form most likely to be
  // quietly ignored by an embedded or emulated viewport. Setting scrollLeft and
  // scrollTop directly on the scrolling element is the older, blunter path, and
  // costs nothing when the first call already worked.
  const se = document.scrollingElement || document.documentElement;
  if (Math.round(se.scrollLeft) !== Math.round(x)) se.scrollLeft = x;
  if (Math.round(se.scrollTop) !== Math.round(y)) se.scrollTop = y;
  centred = true;
}

/* The deck's scale is clientWidth / 2560, and clientWidth changes for
   reasons a resize event never reports. layoutCockpit() sets body height
   from the stacked strips, so a strip arriving late can bring the vertical
   scrollbar into existence: clientWidth drops by its width, every painted
   console redraws at the new scale, and every hit region, gauge and switch
   stays behind at the old one until something else happens to re-lay them.
   Pinch zoom does the same. So watch the element the scale is read from and
   re-lay the deck whenever the scale it yields actually changes. Comparing
   the scale, not the observed box, is what stops this feeding back on
   itself: the relayout may toggle the scrollbar again, but the second pass
   computes the same scale and stops. */
if(typeof ResizeObserver==='function'){
  let lastScale=0, pending=0;
  const reflow=()=>{
    if(!AP) return;
    const want=wantPanMode();
    if(want!==panMode){
      panMode=want;
      document.documentElement.classList.toggle('panmode',panMode);
      centred=false;
    }
    const s=coverRect().s;
    if(Math.abs(s-lastScale)<1e-6) return;
    lastScale=s;
    layoutCockpit(); layoutHotspots();
    if(typeof shipLayout==='function') shipLayout();
    if(typeof advLayout==='function') advLayout();
    if(typeof portLayout==='function') portLayout();
    centreOnWindow();
  };
  new ResizeObserver(()=>{ cancelAnimationFrame(pending); pending=requestAnimationFrame(reflow); })
    .observe(document.documentElement);
}
// The toast stays fixed to the viewport -- a transport key pressed down at
// the tape unit has to show its message there, not on a window scrolled
// out of sight -- so it follows the glass while the glass is on screen and
// holds at the nearest edge when it is not.
function placeToast(){
  if(!AP) return;
  const w=apRect('window'), t=$('toast');
  t.style.top=Math.max(70,Math.min(innerHeight-60,w.y+w.h*0.80-scrollY))+'px';
  t.style.left=(w.x+w.w/2)+'px';
}
addEventListener('scroll',placeToast,{passive:true});


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
// describe a permalink, and the transport keys read it to know what the
// previous and next tapes are.
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
// The time machine's hourly index, fetched once.
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
function hourTitle(t){ return String(t).slice(0,13).replace('T',' ') + ':00 UTC'; }
async function describeMoment(id){
  // Only the index at load time; the frames themselves wait for Power Up so a
  // permalink costs no more on first paint than any other visit.
  const m = (await momentIndex()).find(m => m.id === id);
  if(m) return m;
  // An hour from the time machine is a real tape too, but it is not in the
  // curated index -- without this its link said "no recorded moment called
  // hour-..." on the boot screen and then played it anyway after Power Up.
  if(String(id).startsWith('hour-')){
    const tm = await tmIndex();
    const h = tm && tm.hours.find(x => x.id === id);
    if(h) return { id: h.id, title: hourTitle(h.t), t: h.t, downlinks: h.peak, craft: h.craft,
      why: 'One hour of the recorded archive: ' + h.peak + ' downlinks at the busiest point, '
         + h.craft.length + ' spacecraft heard.' };
  }
  return null;
}

// Fetching and mounting are separate on purpose. The transport keys switch
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
  // The tape unit says all of this in the panel itself, so the banner is only
  // the fallback for when tape.json did not load -- two copies of the same
  // sentence on screen is worse than either one alone.
  if(TAPE) return;
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


// The tape unit is hardware, so it is always on the panel -- what changes is
// what it says. Live, it reads as an idle transport with no tape loaded; on a
// permalink it names the moment and the reels turn. That distinction is the
// whole reason for the object: "am I hearing now, or then" should be legible
// without reading a word.
function renderTape(){
  if(!TAPE) return;
  const idx=$('momentIndex'), cnt=$('momentCounter');
  if(!idx||!cnt) return;
  if(MOMENT){
    idx.innerHTML='<span class="mt">'+esc(MOMENT.title)+'</span>'
                 +'<span class="mw">'+esc(MOMENT.why)+'</span>';
    const when=String(MOMENT.t||'').slice(0,16).replace('T',' ');
    cnt.innerHTML='<span class="lbl">ARCHIVE</span>'+esc(when)
                 +'<span class="lbl">'+(i+1)+' / '+F.length+'</span>';
    document.body.classList.add('tapeplaying');
  } else {
    idx.innerHTML='<span class="idle">no tape loaded &mdash; '
                 +(liveMode?'live from the network':'recorded demo')
                 +' &middot; &#9654;&#9654;&#9654; loads one</span>';
    cnt.innerHTML='<span class="lbl">ARCHIVE</span>--:--<span class="lbl">'
                 +(liveMode?'LIVE':'DEMO')+'</span>';
    document.body.classList.remove('tapeplaying');
  }
  // Latches: which mode the transport is in, shown on the keys themselves.
  const lit=(id,on)=>{ const k=$(id); if(k) k.classList.toggle('latched',on); };
  lit('tPlay', !!MOMENT && playing);
  lit('tStop', liveMode);
}

/* ---------- TRANSPORT ----------
   The four keys under the TRANSPORT legend, driving the archive:
   REW / FFWD step through moments.json, STOP ejects back to the live
   network, PLAY is the deck's own play/pause. Everything switches in place.
   Navigating to ?moment=... would be simpler and would throw away the
   AudioContext with the page, forcing a second Power Up for every tape --
   and on iOS a second unlock gesture -- which is not what a transport is. */
let tapeBusy=false;
function pressFlash(el){
  if(!el) return;
  el.classList.add('pressed');
  clearTimeout(el._p); el._p=setTimeout(()=>el.classList.remove('pressed'),170);
}
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
// Presses are counted synchronously and drained by one worker. The first
// version checked a busy flag, awaited the index, and only then set the flag
// -- so two quick presses both got past the check, both read the same current
// tape, and both loaded the same next one: double-tapping FFWD moved one tape,
// not two. Dropping presses while busy would be the opposite mistake. Counting
// them means a burst lands exactly as far as it was pressed, and a press that
// arrives mid-fetch becomes the next hop rather than vanishing.
let shuttleSteps=0, shuttleRunning=false;
function tapeShuttle(dir){
  if(!AC){ flash('POWER UP FIRST'); return; }
  if(tapeBusy) return;                    // an eject is in flight
  shuttleSteps+=dir;
  if(!shuttleRunning) runShuttle();
}
async function runShuttle(){
  shuttleRunning=true;
  try{
    // With an hour from the time machine loaded, the shuttle moves through
    // time -- the previous or next hour -- instead of through the eight
    // curated tapes.
    const hourMode=!!(MOMENT&&MOMENT.hour);
    const list=hourMode?(((await tmIndex())||{}).hours||[]):await momentIndex();
    if(!list.length){ shuttleSteps=0; flash('NO TAPES IN THE ARCHIVE'); return; }
    while(shuttleSteps!==0){
      const steps=shuttleSteps; shuttleSteps=0;
      const at=MOMENT?list.findIndex(m=>m.id===MOMENT.id):-1;
      let k;
      if(hourMode&&at>=0){
        // Time does not wrap: past either end of the archive, it stops there.
        k=Math.max(0,Math.min(list.length-1,at+steps));
        if(k===at){ flash(steps>0?'END OF THE ARCHIVE':'START OF THE ARCHIVE'); break; }
      }else{
        // From live (or the demo) there is no current tape: the first FFWD
        // loads the first, the first REW the last, the way a shuttle wraps.
        const raw=at<0?(steps>0?steps-1:list.length+steps):at+steps;
        k=((raw%list.length)+list.length)%list.length;
      }
      const next=list[k];
      const label=next.title||hourTitle(next.t);
      flash((steps>0?'FFWD':'REW')+' · '+label.toUpperCase()
            +' · '+(k+1)+'/'+list.length);
      try{
        const m=await fetchMoment(next.id);
        // Only now, with the tape safely in hand, give up whatever was playing.
        if(liveMode) goOffline();
        mountMoment(m);
        history.replaceState(null,'',location.pathname+'?moment='+encodeURIComponent(next.id));
        setPlaying(true);
        render(); applyAudio(F[i]);
      }catch(_){
        shuttleSteps=0;
        flash('THAT TAPE WOULD NOT LOAD · STILL ON THE PREVIOUS ONE');
      }
    }
  }finally{ shuttleRunning=false; }
}
async function tapeEject(){
  if(!AC){ flash('POWER UP FIRST'); return; }
  if(tapeBusy||shuttleRunning) return;
  if(!MOMENT){ flash(liveMode?'NO TAPE LOADED · ALREADY LIVE':'NO TAPE LOADED'); return; }
  tapeBusy=true;
  flash('EJECT · CONNECTING TO THE NETWORK');
  const frame=await connectLive();
  tapeBusy=false;
  // Same rule as a shuttle: the tape stays in until live has actually
  // delivered a frame, so a dead feed costs nothing but the attempt.
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
  setPlaying(true);
  render(); applyAudio(F[i]);
}
[['tRew',()=>tapeShuttle(-1)],['tFf',()=>tapeShuttle(1)],
 ['tStop',()=>tapeEject()],['tPlay',()=>$('play').click()]].forEach(([id,fn])=>{
  const k=$(id); if(!k) return;
  k.addEventListener('click',()=>{ pressFlash(k); fn(); });
  // Space stays with the global pause, the same rule the rotary knob follows.
  k.addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); });
});

/* ---------- ROTARY ----------
   The tape unit's far-right control is a dual-concentric knob: an inner knob
   with one index mark and an outer ring with a separate one. Two marks means
   two parameters, so it drives two rotors -- inner the treble, outer the
   bass, which is the split a real rotating-speaker cabinet has and the one
   the two rings on that kind of knob conventionally control.

   Why this effect belongs on this console and not just on any console: a
   rotating source doppler-shifts what it radiates, and doppler is not
   decoration here. It is how the Deep Space Network measures a spacecraft's
   velocity -- the shift on the carrier IS the ranging data. Putting a
   doppler control on the playback deck is the one audio effect this project
   can claim as literal rather than borrowed.

   It is a Leslie, deliberately. The first version capped the fast rate at
   under half a real cabinet's to keep clear of the Hammond sound; the call
   was made the other way, so the detents are now the cabinet's own --
   CHORALE and TREMOLO -- at the cabinet's own rates. The rate table stays in
   one place so that call is one edit to revisit.

   Depths are physical rather than tuned by ear. Doppler scales with rotor
   speed, so a fixed delay swing gives almost no pitch bend at CHORALE and
   the full wobble at TREMOLO, as the real thing does: 0.45ms at 6.8Hz is
   about a 1.9% bend, the figure for a horn of ~15cm radius. The drum is a
   rotating baffle, not a horn, so it bends less and throbs less, and it is
   heavy -- it takes about three times as long to wind up and coast down. */
const ROT_DETENTS=['OFF','CHORALE','TREMOLO'];
const ROT_ANGLE=[-52,0,52];              // knob position for each detent
const ROT_XOVER=800;                     // Hz, the cabinet's own crossover
const ROTORS={
  // rates in Hz per detent; ramp is the spin-up/coast-down time in seconds
  inner:{part:'treble horn',rates:[0,0.83,6.8],ramp:1.0,doppler:0.00045,pan:0.80,amp:0.32},
  outer:{part:'bass drum',  rates:[0,0.67,5.8],ramp:3.0,doppler:0.00030,pan:0.50,amp:0.20},
};
let ROTSET={inner:0,outer:0}, ROTFX=null;

// Built once, synchronously, in the same block that creates the AudioContext.
// Not lazily on first knob click: node construction is cheap, and the iOS
// unlock rule (context created and resumed inside the gesture, nothing ahead
// of it) is easier to keep correct with one construction site than two.
function buildRotary(){
  // Parallel dry and wet rather than routing everything through the
  // crossover with the depths at zero. A lowpass and a highpass at the same
  // corner do not sum flat -- Butterworth Q leaves a dip right at the
  // crossover -- so an "OFF" that still went through the filters would
  // quietly recolour the choir for everyone who never touches the knob.
  // This way OFF is the untouched signal, and there is no disconnect to
  // click on the way in or out.
  const dry=AC.createGain(), wet=AC.createGain();
  dry.gain.value=1; wet.gain.value=0;
  bus.connect(dry); dry.connect(AC.destination);
  bus.connect(wet);
  // A cosine is a sine a quarter-cycle ahead. OscillatorNode has no phase
  // control, but a two-coefficient PeriodicWave gives one for free, and the
  // quarter-turn offset between where a rotating horn is loudest and where
  // it is furthest to one side is what stops the effect sounding like plain
  // tremolo with a pan bolted on.
  const cosine=AC.createPeriodicWave(Float32Array.from([0,1]),
                                     Float32Array.from([0,0]));
  const rotors={};
  for(const name of Object.keys(ROTORS)){
    const spec=ROTORS[name];
    const filt=AC.createBiquadFilter();
    filt.type=(name==='outer')?'lowpass':'highpass';
    filt.frequency.value=ROT_XOVER;
    wet.connect(filt);
    const dly=AC.createDelay(0.05); dly.delayTime.value=0.004;
    const pan=AC.createStereoPanner();
    const amp=AC.createGain(); amp.gain.value=1;
    filt.connect(dly); dly.connect(pan); pan.connect(amp);
    amp.connect(AC.destination);
    const lfoA=AC.createOscillator(); lfoA.type='sine';
    const lfoB=AC.createOscillator(); lfoB.setPeriodicWave(cosine);
    lfoA.frequency.value=0; lfoB.frequency.value=0;
    const dDep=AC.createGain(), aDep=AC.createGain(), pDep=AC.createGain();
    dDep.gain.value=0; aDep.gain.value=0; pDep.gain.value=0;
    lfoA.connect(dDep); dDep.connect(dly.delayTime);   // doppler
    lfoA.connect(aDep); aDep.connect(amp.gain);        // amplitude
    lfoB.connect(pDep); pDep.connect(pan.pan);         // stereo sweep
    lfoA.start(); lfoB.start();
    // The whole node set, not just the params applyRotary() writes to: the
    // amp is the last stage before the destination, so keeping it reachable
    // is what makes the rotary's actual output level measurable from the
    // console instead of only inferable from gain values.
    rotors[name]={spec,filt,dly,pan,amp,lfoA,lfoB,dDep,aDep,pDep};
  }
  ROTFX={dry,wet,rotors};
}

function applyRotary(){
  if(!ROTFX||!AC) return;
  const t=AC.currentTime, any=ROTSET.inner>0||ROTSET.outer>0;
  const ramp=(p,v,secs)=>{ p.cancelScheduledValues(t); p.setValueAtTime(p.value,t);
                           p.linearRampToValueAtTime(v,t+secs); };
  let longest=0.25;
  for(const name of Object.keys(ROTORS)){
    const r=ROTFX.rotors[name], s=r.spec, d=ROTSET[name];
    longest=Math.max(longest,s.ramp);
    // Rotors have mass: they wind up and coast down rather than snapping to
    // a rate, and the bass rotor takes longer than the treble one. The mark
    // on the panel uses the same two durations for its CSS transition, so
    // the knob and the sound settle together.
    ramp(r.lfoA.frequency,s.rates[d],s.ramp);
    ramp(r.lfoB.frequency,s.rates[d],s.ramp);
    ramp(r.dDep.gain,d?s.doppler:0,s.ramp);
    ramp(r.aDep.gain,d?s.amp:0,s.ramp);
    ramp(r.pDep.gain,d?s.pan:0,s.ramp);
  }
  // Engaging crossfades quickly; disengaging takes the slow rotor's coast-down
  // time, so the wet path fades out while it is still spinning to a stop
  // rather than being cut off mid-turn.
  // 0.95 rather than 1: amplitude modulation peaks above unity, and the
  // headroom costs about half a decibel nobody can hear next to the effect.
  ramp(ROTFX.dry.gain,any?0:1,any?0.25:longest);
  ramp(ROTFX.wet.gain,any?0.95:0,any?0.25:longest);
}

function rotaryLabel(name){
  const s=ROTORS[name], d=ROT_DETENTS[ROTSET[name]];
  return 'Leslie '+s.part+': '+d+'. Activate to change.';
}
function renderRotary(){
  [['inner','markInner','rotInner'],['outer','markOuter','rotOuter']]
  .forEach(([name,markId,btnId])=>{
    const mk=$(markId), b=$(btnId);
    if(mk){ mk.style.transform='rotate('+ROT_ANGLE[ROTSET[name]]+'deg)';
            mk.classList.toggle('spinning',ROTSET[name]>0); }
    if(b) b.setAttribute('aria-label',rotaryLabel(name));
  });
}
function setRotary(name,d){
  d=Math.max(0,Math.min(ROT_DETENTS.length-1,d));
  if(d===ROTSET[name]) return;
  ROTSET[name]=d;
  renderRotary();
  applyRotary();
  // The knob turns whether or not the audio is running, and the setting is
  // picked up when Power Up builds the graph -- a control that refuses to
  // move until you have done something else first reads as broken.
  const s=AC?'':' · power up to hear it';
  flash('LESLIE · '+ROTORS[name].part+' '+ROT_DETENTS[d]+s);
}
// A click steps round the detents; the wheel turns the ring the pointer is
// over, up for faster and down for slower, and stops at the ends like a real
// detented control instead of wrapping.
function nudgeRotary(name){ setRotary(name,(ROTSET[name]+1)%ROT_DETENTS.length); }
function wheelRotary(name,e){
  e.preventDefault();
  setRotary(name,ROTSET[name]+(e.deltaY<0?1:-1));
}
function flash(msg){
  const t=$('toast'); if(!t) return;
  t.textContent=msg; t.classList.add('on');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'),2600);
}
$('rotInner').addEventListener('click',()=>nudgeRotary('inner'));
$('rotOuter').addEventListener('click',()=>nudgeRotary('outer'));
// passive:false, or preventDefault is ignored and the page scrolls as well.
$('rotInner').addEventListener('wheel',e=>wheelRotary('inner',e),{passive:false});
$('rotOuter').addEventListener('wheel',e=>wheelRotary('outer',e),{passive:false});
// Space belongs to the transport, everywhere, with no exceptions -- the help
// panel promises "Space pauses" and a control that quietly takes that away
// once it has been touched is worse than one that never had the shortcut.
// A <button> natively activates on Space as well as Enter, so a focused knob
// would have fought the global handler; suppressing Space here means the
// window handler pauses exactly as it always did, and Enter still works,
// which is the keyboard path a button is expected to have anyway.
['rotInner','rotOuter'].forEach(id=>$(id).addEventListener('keydown',e=>{
  if(e.key===' ') e.preventDefault();
}));
renderRotary();

/* ---------- sky ---------- */
const sky=$('sky'), K=sky.getContext('2d');
// Expanded map, or no cockpit at all: the sky is the viewport. On the deck it
// is a page-positioned canvas covering just the cockpit photo, so it scrolls
// with the glass it is seen through -- a fixed canvas re-aimed from a scroll
// handler would lag the photo by a frame on every wheel tick.
let SKY_W=0, SKY_H=0;
function size(){
  const de=document.documentElement, d=devicePixelRatio||1;
  let w, h;
  if(AP&&!expanded){ const c=coverRect(); w=Math.round(AP.frame[0]*c.s); h=Math.round(COCKPIT_H*c.s); }
  else { w=de.clientWidth||innerWidth; h=de.clientHeight||innerHeight; }
  // Setting a canvas's size clears it, and layoutCockpit calls this often.
  if(w===SKY_W&&h===SKY_H&&sky.width===Math.round(w*d)) return;
  SKY_W=w; SKY_H=h;
  sky.width=Math.round(w*d); sky.height=Math.round(h*d);
  sky.style.width=w+'px'; sky.style.height=h+'px';
  K.setTransform(d,0,0,d,0,0);
}
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
  const W=SKY_W,H=SKY_H;
  let cx=W/2, cy=H/2, ap=null;
  if(AP&&!expanded){ ap=apRect('window'); cx=ap.x+ap.w/2; cy=ap.y+ap.h/2; }
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
  // Shared by both the heliocentric body labels and the fleet labels below --
  // zoomed out far enough to read the whole system as a small cluster, every
  // always-on label (planets, and any spacecraft with a current downlink) is
  // clutter, not orientation. Only meaningful once expanded; the small
  // porthole view was never part of this ask and keeps every label it always had.
  const labelAlpha=expanded?Math.max(0,Math.min(1,(zoom-0.32)/0.28)):1;
  // Shared between the body loop below and the spacecraft loop further down
  // -- both draw canvas labels onto the same crowded field (Mercury and a
  // nearby spacecraft label butting up against each other with no gap was
  // the case that showed this), so collision-avoidance has to see both sets
  // at once rather than each loop only dodging its own labels.
  const mapLabels=[];
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
  // Earth focus is drawn to TRUE SCALE: one linear km->px factor (kmPx) for
  // the whole frame, set in the Earth-focus branch below. The earlier version
  // drew the Moon as a fixed 18px ring and put every spacecraft on schematic
  // class rings at 2-4x R, so MMS -- really at ~60,000 km, a sixth of the way
  // to the Moon -- was drawn about twenty times farther out than the Moon.
  let kmPx=0, earthDiscPx=0, sunLonGeo=0, farHeader=null;
  // A point at (x,y,z) km in ecliptic coordinates, through the same yaw/pitch
  // rotation as everything else on the map.
  const projKm=(x,y,z)=>{ const q=rot(x,y,z); return {x:cx+q[0]*kmPx, y:cy-q[1]*kmPx, z:q[2]}; };
  const eclipticVec=(lam,beta,rr)=>{
    const q=rot(Math.cos(beta)*Math.cos(lam),Math.sin(beta),Math.cos(beta)*Math.sin(lam));
    return {x:cx+q[0]*rr, y:cy-q[1]*rr, z:q[2]}; };
  // The Moon's geocentric ecliptic position: mean longitude plus the largest
  // periodic term, the usual low-precision lunar theory. Checked against real
  // dates: at the 2024-09-18 full moon the Moon-Sun elongation comes out at
  // 179.4 deg, at the 2024-10-02 new moon 359.9 deg, and it puts that October
  // Moon at 405,900 km -- near apogee, which is why that eclipse was annular.
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
    // Earth-focus: Earth itself is the drawing origin (cx,cy), so the
    // Moon-position and fleet-position math below -- all written as offsets
    // from earthScreen/cx,cy -- works unchanged. The other planets simply
    // never get a bodyPos entry, so the shared per-body loop below skips
    // them for free.
    const elE=(window.ORBITS||{}).EARTH;
    if(elE) earthLon=window.solveOrbit(elE,jd).lam;
    earthScreen={x:cx, y:cy, z:1, b:BD.find(b=>b.id==='EARTH'), rr:0, lam:earthLon, rAU:1, approx:false};
    bodyPos.EARTH=earthScreen;
    // One linear scale for the whole frame. What zoom changes is how much
    // fits: the reach -- the distance that lands at 2.8R -- runs log-linearly
    // with zoom. The default frames the Earth-Moon system (reach 500,000 km,
    // Moon at ~2.2R): framing L1/L2 by default put the Moon ~78px out on a
    // desktop and ~32px on a phone, too tight to resolve MMS, Chandra and
    // TESS at their true distances inside it. Zooming out ~6 notches reaches
    // ~4 million km, which brings L1 and L2 on frame; full zoom-in reaches
    // ~42,000 km (geostationary orbit). Kept apart from zoom itself, which also
    // sizes the star sphere and the label fade and was tuned for its 0.15-2.6
    // range; widening that range would break both.
    const reach=Math.max(4.2e4,Math.min(4e6,5e5*Math.pow(zoom,-3.7)));
    kmPx=R*2.8/reach;
    // True size, with a floor so the planet never shrinks to nothing -- but
    // the floor is never more than a fifth of the Moon's drawn distance.
    // Zoomed out to bring L1/L2 on frame the Moon is only ~17px away (7px on
    // a phone), and a fixed 6px Earth would all but swallow its orbit.
    earthDiscPx=Math.max(6371*kmPx, Math.min(6, 384400*kmPx*0.2));
    // Seen from Earth the Sun is opposite Earth's heliocentric longitude.
    sunLonGeo=earthLon+Math.PI;
  }
  if(expanded){
    // The Moon has no heliocentric au of its own -- at this scale Earth's
    // real 384,400 km satellite would sit sub-pixel from Earth regardless of
    // zoom, so it's drawn as a fixed small screen-space ring around Earth's
    // already-rotated position instead of a to-scale orbit. Schematic, not
    // to scale, and says so in its own dossier.
    if(earthScreen){
      // 9px put the Moon's dot overlapping Earth's own 6.5px-radius disc --
      // correct distance-wise (both are schematic anyway) but unreadable as
      // a separate body. Enough clearance to read as two dots, still tucked
      // in close rather than looking like its own planet.
      if(mapFocus==='earth'){
        // Earth focus: the Moon's real position and real distance on the
        // shared true scale. (The schematic ring below is kept only for the
        // heliocentric view, where 384,400 km really is sub-pixel.)
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
        // In Earth focus the ring is the Moon's mean distance, to scale.
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

      // Dots draw immediately (true orbital position, never adjusted); labels
      // are collected into mapLabels and placed in one shared pass once every
      // label on the field -- bodies and spacecraft alike -- has been queued.
      // Near-Earth asteroids in particular land close enough together at this
      // radial compression that their labels landed on top of each other
      // (Bennu/Apophis was the reported case) -- nothing here ever gave a
      // second label anywhere to go but exactly where the first one already was.
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
        if(!hv&&labelAlpha<=0.03) return;   // faded out at this zoom, not hovered
        const align=P.x<cx?'right':'left';
        const a=hv?1:0.72*labelAlpha, ea=hv?1:0.95*labelAlpha;
        mapLabels.push({x:P.x+(P.x<cx?-9:9), y:P.y, align,
          text:b.n.toUpperCase()+(P.approx?' *':''),
          font:'400 10px "IBM Plex Mono",monospace',
          color:hv?'#fff':(isEarth?`rgba(147,216,236,${ea})`:`rgba(201,162,39,${a})`)});
      });
    } else {
      // THE EARTH, focus mode, TO SCALE. Earth, the Moon, the Lagrange points
      // and every near-Earth orbit share one linear km->px factor, so every
      // distance on this view is a real ratio. Earth keeps a minimum drawn
      // size (earthDiscPx) so it never vanishes at low zoom; nothing else is
      // enlarged. Lit from the Sun's real direction, which in this view is
      // opposite Earth's heliocentric longitude.
      const eR=earthDiscPx;
      const sd=eclipticProj(sunLonGeo,1e4), toSun=Math.atan2(sd.y-cy, sd.x-cx);
      const ring=(rr,dash,col)=>{ K.save(); K.setLineDash(dash); K.strokeStyle=col; K.lineWidth=1;
        K.beginPath(); for(let s=0;s<=64;s++){ const p=eclipticProj(s/64*Math.PI*2,rr);
          s?K.lineTo(p.x,p.y):K.moveTo(p.x,p.y); } K.stroke(); K.restore(); };
      // Geostationary orbit, 42,164 km from Earth's centre, once it resolves.
      const geoR=42164*kmPx;
      if(geoR>eR+12){
        ring(geoR,[1,4],'rgba(147,216,236,.30)');
        const gp=eclipticProj(sunLonGeo+Math.PI/2,geoR);
        mapLabels.push({x:gp.x+(gp.x<cx?-6:6), y:gp.y, align:gp.x<cx?'right':'left',
          text:'GEO · 35,786 km up', font:'400 9px "IBM Plex Mono",monospace',
          color:'rgba(147,216,236,.6)'});
      }
      K.fillStyle='#22201B'; K.beginPath(); K.arc(cx,cy,eR,0,7); K.fill();
      K.fillStyle='#7FC8E8'; K.beginPath(); K.arc(cx,cy,eR,toSun-Math.PI/2,toSun+Math.PI/2); K.fill();
      K.strokeStyle='rgba(147,216,236,.85)'; K.lineWidth=1.5;
      K.beginPath(); K.arc(cx,cy,eR+3,0,7); K.stroke();
      K.font='500 10px "IBM Plex Mono",monospace'; K.textAlign='center';
      K.fillStyle='rgba(147,216,236,.9)'; K.textBaseline='top';
      K.fillText('EARTH', cx, cy+eR+7);
      // Sun-Earth L1 and L2, each 1.5 million km out: L1 toward the Sun, L2
      // directly away. SOHO, ACE, WIND, DSCOVR, IMAP and SWFO work at L1;
      // JWST, Euclid and Roman at L2.
      [[0,'L1 · 1.5 M km sunward'],[Math.PI,'L2 · 1.5 M km anti-sunward']].forEach(([off,t])=>{
        const p=eclipticProj(sunLonGeo+off,1.5e6*kmPx);
        K.strokeStyle='rgba(201,162,39,.6)'; K.lineWidth=1;
        K.beginPath(); K.moveTo(p.x-4,p.y); K.lineTo(p.x+4,p.y);
        K.moveTo(p.x,p.y-4); K.lineTo(p.x,p.y+4); K.stroke();
        mapLabels.push({x:p.x+(p.x<cx?-8:8), y:p.y+13, align:p.x<cx?'right':'left',
          text:t, font:'400 9px "IBM Plex Mono",monospace', color:'rgba(201,162,39,.75)'});
      });
      // The Moon, at its true size and distance, lit from the same Sun as
      // Earth. The old code lit it toward Earth, which drew it permanently full.
      const MP=bodyPos.MOON;
      if(MP){
        const hv=hover==='MOON', mr=Math.max(4,1737.4*kmPx);
        K.fillStyle='#22201B'; K.beginPath(); K.arc(MP.x,MP.y,mr,0,7); K.fill();
        K.fillStyle=hv?'#fff':BCOL.moon;
        K.beginPath(); K.arc(MP.x,MP.y,mr,toSun-Math.PI/2,toSun+Math.PI/2); K.fill();
        mapLabels.push({x:MP.x+(MP.x<cx?-9:9), y:MP.y, align:MP.x<cx?'right':'left',
          text:'MOON · '+Math.round(MP.km).toLocaleString()+' km',
          font:'400 10px "IBM Plex Mono",monospace',
          color:hv?'#fff':'rgba(184,184,176,.85)'});
      }
      // Off-frame markers. With the Earth-Moon system filling the default
      // frame, L1 and L2 lie outside it (and at deep zoom, the Moon does too).
      // Their direction IS known -- sunward, anti-sunward, the Moon's real
      // longitude -- so an arrow on the frame edge points the true way, unlike
      // the interplanetary craft, whose bearing is not known and get none.
      const rect={l:40, t:70, r:W-210, b:H-150};
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
        mapLabels.push({x:ex-Math.cos(a)*12, y:ey-Math.sin(a)*12, align:Math.cos(a)>0?'right':'left',
          text, font:'400 9px "IBM Plex Mono",monospace', color:col});
      };
      const nL1=FLEET.filter(f=>f.cls==='l1').length, nL2=FLEET.filter(f=>f.cls==='l2').length;
      edgeMark(eclipticProj(sunLonGeo,1.5e6*kmPx),'L1 · 1.5 M km · '+nL1+' craft','rgba(201,162,39,.9)');
      edgeMark(eclipticProj(sunLonGeo+Math.PI,1.5e6*kmPx),'L2 · 1.5 M km · '+nL2+' craft','rgba(201,162,39,.9)');
      if(MP) edgeMark(MP,'MOON · '+Math.round(MP.km).toLocaleString()+' km','rgba(184,184,176,.9)');
      // Scale bar: the largest round distance under ~120px at this zoom.
      const want=120/kmPx, p10=Math.pow(10,Math.floor(Math.log10(want))), mm=want/p10;
      const nice=(mm>=5?5:mm>=2?2:1)*p10, bl=nice*kmPx, bx=28, by=H-128;
      K.strokeStyle='rgba(217,230,240,.75)'; K.lineWidth=1;
      K.beginPath(); K.moveTo(bx,by-4); K.lineTo(bx,by); K.lineTo(bx+bl,by); K.lineTo(bx+bl,by-4); K.stroke();
      K.font='400 9px "IBM Plex Mono",monospace'; K.textAlign='left'; K.textBaseline='bottom';
      K.fillStyle='rgba(217,230,240,.85)'; K.fillText(nice.toLocaleString()+' km', bx, by-6);
      K.fillStyle='rgba(120,140,160,.8)'; K.textBaseline='top';
      K.fillText('TRUE SCALE · one linear scale for Earth, Moon and orbits', bx, by+5);
    }
  }
  window.__bodyPos=bodyPos;
  window.__earthLon=earthLon;
  if(expanded){ const sd=$('simd');
    if(sd) sd.textContent = simDays? ' · '+(simDays>=365?(simDays/365.25).toFixed(2)+' yr':simDays.toFixed(0)+' d')+' ahead':''; }

  // fleet rings
  const tracked={}, acq=new Set(fr.acq.concat(fr.lost).concat(fr.dualOn||[]).concat(fr.dualOff||[]));
  fr.links.forEach(l=>{tracked[l.sc]=l});
  // Innermost first. LEO used to sort outside HEO, which put the band
  // nearest the ground outside the one that reaches a sixth of the way to the Moon.
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
    // TRUE SCALE. Each craft sits at its real distance from Earth on the same
    // linear scale as the Moon, so the order the eye reads is the order in
    // space: LEO < GEO < MMS < Chandra < TESS < Moon < L1/L2. FLEET carries a
    // nominal distance, not an ephemeris, so where a craft is ALONG its orbit
    // is schematic; how far out it is, is real.
    const perp=[-Math.sin(sunLonGeo),0,Math.cos(sunLonGeo)];
    const byCls={}; FLEET.forEach(f=>{ (byCls[f.cls]=byCls[f.cls]||[]).push(f); });
    FLEET.forEach(f=>{
      const peers=byCls[f.cls], idx=peers.indexOf(f), cnt=peers.length;
      if(f.cls==='l1'||f.cls==='l2'){
        // L1 is 1.5 million km sunward, L2 the same distance directly away.
        // Each craft flies a halo orbit a few hundred thousand km across round
        // its point, so they are spread on a ring of that size perpendicular
        // to the Sun line; position within the halo is not tracked.
        const s=f.cls==='l1'?1:-1, a=idx/cnt*Math.PI*2+simDays*0.034, h=3e5;
        const x=s*1.5e6*Math.cos(sunLonGeo)+h*Math.cos(a)*perp[0];
        const z=s*1.5e6*Math.sin(sunLonGeo)+h*Math.cos(a)*perp[2];
        const p=projKm(x,h*Math.sin(a),z);
        pos[f.id]={x:p.x, y:p.y, f};
      } else if(f.cls==='lunar'&&bodyPos.MOON){
        // Lunar orbiters are AT the Moon. Their orbits are a few thousand km
        // across -- sub-pixel here -- so they are fanned a few pixels round
        // the Moon's real position to stay individually clickable.
        const M=bodyPos.MOON, a=idx/cnt*Math.PI*2+0.6, rp=Math.max(11,3000*kmPx);
        pos[f.id]={x:M.x+Math.cos(a)*rp, y:M.y+Math.sin(a)*rp, f};
      } else if(f.cls==='leo'||f.cls==='heo'){
        const ci=CLS.indexOf(f.cls), band=(ci+1)/CLS.length;
        const a=(ci*1.9+(idx/Math.max(1,cnt))*1.75)+0.4+simDays*(0.9/(band*9+0.5));
        let rr=f.au*AU_KM*kmPx, clamped=false;
        // A true radius inside Earth's drawn disc (which has a minimum size)
        // would put the craft inside the planet. It is held just outside the
        // limb instead, marked as below the map's resolution, and lets go on
        // its own once zooming in makes the real radius resolvable.
        // The pin is also capped, at 45% of the Moon's drawn distance: a fixed
        // 13px pin put MMS, Chandra and TESS OUTSIDE the Moon when zoomed out
        // far enough to see L1/L2 -- the very error this view was rebuilt to
        // remove. Capped, unresolvable craft merge into a cluster inside the
        // Moon's orbit instead; MMS really is at 16% of it, TESS at 58%.
        const pin=Math.min(earthDiscPx+7, 384400*kmPx*0.45);
        if(rr<pin){ rr=pin; clamped=true; }
        const p=eclipticProj(a,rr);
        pos[f.id]={x:p.x, y:p.y, f, clamped};
      } else farList.push(f);
    });
    // Everything else is interplanetary -- hundreds to tens of thousands of
    // lunar distances out -- so no scale that still shows the Moon can hold
    // it. Listed at the edge by distance instead, and deliberately NOT placed
    // at a bearing: FLEET has no direction for these craft, and an arrow
    // pointing somewhere would claim one.
    farList.sort((a,b)=>a.au-b.au);
    const top=235, step=Math.max(11,Math.min(15,(H-top-150)/Math.max(1,farList.length)));
    farList.forEach((f,n)=>{ pos[f.id]={x:W-176, y:top+n*step, f, far:true}; });
    farHeader={x:W-182, y:top-26};
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
  // Schematic class bands everywhere except Earth focus, which draws true
  // nominal radii below instead.
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
    // The near-Earth craft's orbit radii, true to scale. Dashed because the
    // radius is nominal and the position along it is not tracked.
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
      K.font='500 9px "IBM Plex Mono",monospace'; K.textAlign='left'; K.textBaseline='alphabetic';
      K.fillStyle='rgba(201,162,39,.85)'; K.fillText('BEYOND THIS MAP', farHeader.x, farHeader.y);
      K.fillStyle='rgba(120,140,160,.8)';
      K.fillText('distance only · direction not tracked', farHeader.x, farHeader.y+12);
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
  // In Earth focus the Sun is not at the centre of frame; it is far off in
  // the direction of its geocentric longitude.
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
    // Held outside Earth's limb because its true radius is below this zoom's
    // resolution -- say so with a dashed halo rather than pass it off as real.
    if(P.clamped){ K.save(); K.setLineDash([2,2]); K.strokeStyle='rgba(147,216,236,.55)';
      K.lineWidth=1; K.beginPath(); K.arc(P.x,P.y,rad+3,0,7); K.stroke(); K.restore(); }
    // The off-map distance list is only readable with its labels, so those
    // are always on; everything else keeps the tracked/hover rule.
    if((on||hv||P.far)&&(hv||hot||P.far||labelAlpha>0.03)){
      const a=hv||hot?1:P.far?(on?0.95:0.6):0.85*labelAlpha;
      const dist=P.far?' · '+(f.au>=10?f.au.toFixed(0):f.au.toFixed(2))+' AU':'';
      mapLabels.push({x:P.x+(P.x<cx?-9:9), y:P.y, align:P.x<cx?'right':'left',
        text:f.n.toUpperCase()+dist, font:'500 11px "Barlow Condensed",sans-serif',
        color:hot?'#FF7A3D':hv?'#fff':`rgba(217,230,240,${a})`});
    }
  });
  // One collision pass over every label queued above, bodies and spacecraft
  // together -- greedy vertical separation: within a label-line's height and
  // roughly the same horizontal band, push the later one down until it
  // clears the ones already placed. Sorting by y first means each label only
  // ever needs to check labels already placed, not the whole set.
  const LINE_H=11;
  mapLabels.sort((a,b)=>a.y-b.y);
  mapLabels.forEach((l,i)=>{
    for(let j=0;j<i;j++){
      const o=mapLabels[j];
      if(o.align!==l.align || Math.abs(o.x-l.x)>110) continue;
      if(l.y-o.y<LINE_H) l.y=o.y+LINE_H;
    }
  });
  K.textBaseline='middle';
  mapLabels.forEach(l=>{
    K.font=l.font; K.fillStyle=l.color; K.textAlign=l.align;
    K.fillText(l.text, l.x, l.y);
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
  ttyEnqueue(t,msg,kind);             // the teleprinter types the same log
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
// Positions the painted-control hotspots. Called from layoutCockpit(), so it
// runs every time the combined frame changes -- which it does twice after
// load, as footer.json and then tape.json stack their strips under the
// console. It used to run only when hotspots.json arrived and on resize, so
// whenever that fetch beat the tape strip (the tape fetch is chained behind
// the footer's, so it usually did) every control was placed at the old,
// larger scale: measured 40-69px off at 1440x900, and stayed there until the
// window was resized. Elements are created once and moved after that, so a
// relayout never blanks the readouts or drops a lit lamp.
function layoutHotspots(){
  if(!HS||!AP) return;
  const host=$('spots');
  const c=coverRect();
  HS.spots.forEach(sp=>{
    const [x,y,w,h]=sp.box;
    let d=host.querySelector(`.spot[data-id="${sp.id}"]`);
    if(!d){
      d=document.createElement('div');
      d.className='spot '+sp.kind; d.dataset.id=sp.id;
      if(sp.kind==='button'){ d.title=sp.label; d.onclick=()=>doAct(sp.act); }
      host.appendChild(d);
    }
    d.style.left=(c.ox+x*c.s)+'px'; d.style.top=(c.oy+y*c.s)+'px';
    d.style.width=(w*c.s)+'px'; d.style.height=(h*c.s)+'px';
    d.dataset.basefs=Math.max(8,h*c.s*0.52);
  });
}
function doAct(a){
  if(a==='audio') $('au').click();
  if(a==='play')  $('play').click();
  if(a==='tone'){ const t=$('tone'); t.selectedIndex=(t.selectedIndex+1)%t.options.length;
    t.dispatchEvent(new Event('change')); flashSpot('annunciator'); }
  if(a==='speed'){ const t=$('sp'); t.selectedIndex=(t.selectedIndex+1)%t.options.length;
    t.dispatchEvent(new Event('change')); flashSpot('knobSpeed'); }
  if(a==='light'){ cycleLight(); flashSpot('knobLight'); }
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
}

/* calibration: drag a box over a painted control, get JSON back */
addEventListener('keydown',e=>{
  if(typingIn(e)) return;
  if(e.key==='h'||e.key==='H'){ calib=!calib;
    document.body.classList.toggle('calib',calib);
    console.log(calib?'CALIBRATE: drag a box over a control':'calibrate off'); }
});
addEventListener('pointerdown',e=>{ if(calib) calibStart=[pgX(e),pgY(e)]; },true);
addEventListener('pointerup',e=>{
  if(!calib||!calibStart) return;
  const c=coverRect();
  const f=(px,py)=>[Math.round((px-c.ox)/c.s),Math.round((py-c.oy)/c.s)];
  const a=f(calibStart[0],calibStart[1]), b=f(pgX(e),pgY(e));
  const box=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1])];
  console.log('box: '+JSON.stringify(box));
  const t=$('toast'); t.textContent='BOX '+box.join(', '); t.classList.add('on');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'),4000);
  calibStart=null;
},true);

/* Page coordinates for a pointer event. Not e.pageX: a synthetic event
   (the ?star= permalink dispatches one) reports pageX equal to clientX
   whatever the scroll, and the deck hit-tests in page space. */
const pgX=e=>e.clientX+scrollX, pgY=e=>e.clientY+scrollY;

/* ---------- clickable stars ---------- */
let starHits=[];
sky.addEventListener('click',e=>{
  if(drag&&drag.moved>4) return;
  if(!inWindow(pgX(e),pgY(e))) return;
  let best=null,bd=26;
  for(const h of starHits){
    const d=Math.hypot(pgX(e)-h.x,pgY(e)-h.y);
    if(d<bd){bd=d;best=h;}
  }
  const sp=window.__stationPos||{};
  for(const k in sp){ if(Math.hypot(pgX(e)-sp[k].x,pgY(e)-sp[k].y)<20){
    openStation(k,pgX(e),pgY(e)); return; } }
  // Closest match, not first-under-threshold: Earth-focus puts the Moon a
  // few pixels from Earth's own (much larger) disc, both easily within 20px
  // of a click aimed at the Moon, and Earth sorts first in bodyPos -- a
  // first-match loop would open Earth's dossier for every click anywhere
  // near the Moon.
  const bp=window.__bodyPos||{}; let bestBody=null,bbd=20;
  for(const k in bp){ const d=Math.hypot(pgX(e)-bp[k].x,pgY(e)-bp[k].y);
    if(d<bbd){bbd=d;bestBody=k;} }
  if(bestBody){ openBody(bestBody,pgX(e),pgY(e)); return; }
  // spacecraft first -- they sit on the rings, stars are the backdrop
  const pos=window.__pos||{}; let sc=null,sd=24;
  for(const k in pos){const d=Math.hypot(pgX(e)-pos[k].x,pgY(e)-pos[k].y);
    if(d<sd){sd=d;sc=k;}}
  if(sc){ openCraft(sc,pgX(e),pgY(e)); return; }
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
  el.style.left=Math.min(innerWidth-250,pgX(e)+16)+'px';
  el.style.top=Math.min(scrollY+innerHeight-190,pgY(e)+14)+'px';
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
  el.style.top=Math.min(scrollY+innerHeight-300,Math.max(6,py+14))+'px';
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
  el.style.top=Math.min(scrollY+innerHeight-300,Math.max(6,py+14))+'px';
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
  el.style.top=Math.min(scrollY+innerHeight-330,Math.max(6,py+14))+'px';
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
  }
  paintHotspots(fr);
  updateFooter(fr);
  announceFrame(fr);
  if(TAPE) renderTape();
  if(SCORE) scoreWrite(fr);
  if(NAV||COMMS||CREW||GUIDE||LIBRARY||FDAI||READER||ARCHIVE) stripsFrame(fr);
  if($('detail').dataset.craft) renderCraft();
  if(!$('signals').hidden) fillSignals();
  if(!$('music').hidden) fillMusicStats(fr);
  if(fr.lock){const t=$('toast');t.textContent=ev;t.classList.add('on');
    clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('on'),1600);}
}
function adv(){ if(liveMode) return; i=(i+1)%F.length;render();applyAudio(F[i]);}
function loop(){clearInterval(timer);if(playing)timer=setInterval(adv,step);}

/* ---------- input ---------- */
sky.addEventListener('pointerdown',e=>{
  if(attHold) return;                       // attitude held: the glass does not answer
  // In pan mode one finger moves the deck. Dragging the sky as well would do
  // both at once: the console slides under you while the stars wheel the other
  // way, which reads as a bug rather than a feature. Looking around is still
  // there, on the expanded map, which is full screen on a phone anyway.
  if(panMode && e.pointerType === 'touch') return;
  if(!inWindow(pgX(e),pgY(e))) return;      // console is not a trackball
  drag={x:pgX(e),y:pgY(e),yaw,pitch,moved:0};sky.classList.add('drag')});
addEventListener('pointerup',()=>{drag=null;sky.classList.remove('drag')});
addEventListener('pointermove',e=>{
  if(drag){drag.moved+=Math.abs(e.movementX||0)+Math.abs(e.movementY||0);
    yaw=drag.yaw+(pgX(e)-drag.x)*.28;
    pitch=Math.max(-80,Math.min(80,drag.pitch-(pgY(e)-drag.y)*.22)); return;}
  // #sky is a full-page canvas with only a window-sized hole showing through
  // the console photo, so a blanket cursor:grab on it turned the pointer into
  // a drag handle over the entire top console -- everywhere except the glass
  // it promised a drag that inWindow() then refused. Carry the grab cursor on
  // a class driven by the same test that gates the drag itself, so the two can
  // never disagree.
  const inw = !AP || inWindow(pgX(e),pgY(e));
  sky.classList.toggle('inwin',inw && !attHold);
  if(!inw){hover=null;
    if(!$('detail').dataset.sticky)$('detail').classList.remove('on'); return;}
  if($('detail').dataset.sticky) return;      // a pinned star owns the panel
  const p=window.__pos; if(!p)return; let best=null,bd=22;
  for(const k in p){const d=Math.hypot(pgX(e)-p[k].x,pgY(e)-p[k].y); if(d<bd){bd=d;best=k;}}
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
    el.style.left=Math.min(innerWidth-244,pgX(e)+16)+'px';
    el.style.top=Math.min(scrollY+innerHeight-160,pgY(e)+14)+'px'; el.classList.add('on');
  } else el.classList.remove('on');
});
// On the scrolling deck a plain wheel over the window must scroll the page:
// the glass is most of the first screen, and a page you cannot scroll with
// the pointer over it is a trap. Pinch (which browsers deliver as a
// ctrl+wheel) and ctrl/cmd+wheel still zoom, and so does a plain wheel on
// the expanded map or on a deck short enough not to scroll.
let zoomHinted=false;
sky.addEventListener('wheel',e=>{
  if(!inWindow(pgX(e),pgY(e))) return;
  const scrolls=document.documentElement.scrollHeight>innerHeight+2;
  if(!expanded&&scrolls&&!e.ctrlKey&&!e.metaKey){
    if(!zoomHinted){ zoomHinted=true; flash('PINCH OR CTRL + SCROLL TO ZOOM'); }
    return;
  }
  e.preventDefault();zoom=Math.max(.15,Math.min(2.6,zoom*(e.deltaY>0?.92:1.09)));
},{passive:false});

/* Keep the display awake once the deck is powered up. A tab that is only
   playing audio does not stop a display from sleeping, so a deck left running
   on a second monitor went dark on the screen saver's schedule, which is the
   one thing a thing meant to be left running must not do. The browser drops
   the lock by itself whenever the tab is hidden, so it is asked for again each
   time the deck comes back into view. A browser without the API, or one that
   refuses (battery saver does), simply carries on as before. */
let wakeLock=null;
async function keepAwake(){
  if(!('wakeLock' in navigator) || wakeLock || document.visibilityState!=='visible') return;
  try{
    wakeLock=await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release',()=>{ wakeLock=null; });
  }catch(_){ wakeLock=null; }
}
document.addEventListener('visibilitychange',()=>{ if(AC && document.visibilityState==='visible') keepAwake(); });

$('go').onclick=async e=>{
  e.target.disabled=true; e.target.textContent='Connecting…';
  // Created and resumed here, synchronously in the click, before anything
  // that awaits the network -- browsers tie the audio unlock to the gesture
  // itself, and connectLive() can legitimately take up to 15s. Resuming
  // only after that meant the AudioContext could report "running" while the
  // browser had already decided too much time had passed since the actual
  // click to ever produce sound for it -- audibly silent despite every
  // JS-visible signal saying it was fine. Most visible on iOS Safari, which
  // enforces this far more strictly than desktop Chrome does.
  // Reused, not recreated: the choir now arrives over the network, so Power Up
  // can fail and be retried, and a fresh AudioContext per attempt orphans the
  // last one. Browsers cap how many a page may hold, so a few retries on a bad
  // connection would stop being able to make one at all. Still created and
  // resumed synchronously inside the click -- that is what the iOS unlock is
  // tied to, and nothing may move ahead of it.
  if(!AC){
    AC=new (window.AudioContext||window.webkitAudioContext)();
    bus=AC.createGain(); bus.gain.value=.9;
    // The bus no longer reaches the destination directly: buildRotary()
    // owns that connection so the dry path and the rotary's wet path are
    // the same crossfade. With both rotors at OFF the dry gain is 1 and the
    // wet is 0, so this is bit-for-bit what it was before the knob existed.
    buildRotary(); applyRotary();
  }
  keepAwake();
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
      if(m){ showMomentBanner(m); renderTape(); }
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
};
$('play').onclick=e=>{playing=!playing;e.target.textContent=playing?'Pause':'Play';
  e.target.classList.toggle('on',playing); playing?(applyAudio(F[i]),loop()):(clearInterval(timer),hush());
  // A paused tape never renders again, so the PLAY latch has to be told now.
  renderTape();};
$('au').onclick=e=>{muted=!muted;e.target.textContent=muted?'Audio off':'Audio on';
  e.target.classList.toggle('alt',!muted); muted?hush():applyAudio(F[i]);};
$('sp').onchange=e=>{step=+e.target.value;loop()};
$('tone').innerHTML=TONES.map((t,n)=>`<option value="${n}" ${n===5?'selected':''}>${t.occasion}</option>`).join('');
$('tone').onchange=e=>{tone=+e.target.value;render()};
// locks is a one-time snapshot of lock-event indices into the baked demo
// array, built at load before live mode ever swaps F out from under it. In
// live mode those indices point at whatever now lives at that position in
// the trimmed live window -- garbage, or another craft's frame entirely --
// and F[i] going undefined threw inside render(), which permanently killed
// the requestAnimationFrame loop with no error surfaced anywhere: every
// canvas-drawn element froze and silently never came back. No equivalent
// "jump to next acquisition" exists for live data yet, so this just does
// nothing in live mode rather than corrupt state.
function liveNoAcq(){ const t=$('toast');t.textContent='NO RECORDED ACQUISITIONS IN LIVE MODE';
  t.classList.add('on'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('on'),1600); }
// A tape can have no lock events at all (mass-acquisition has none), and then
// locks[0] is undefined -- the same undefined-frame crash by another route.
function noLocks(){ flash('NO LOCK EVENTS ON THIS TAPE'); }
$('pv').onclick=()=>{ if(liveMode) return liveNoAcq(); if(!locks.length) return noLocks(); const p=[...locks].reverse().find(n=>n<i);i=p??locks[locks.length-1];render();applyAudio(F[i])};
$('nx').onclick=()=>{ if(liveMode) return liveNoAcq(); if(!locks.length) return noLocks(); const n=locks.find(m=>m>i);i=n??locks[0];render();applyAudio(F[i])};
$('tk').onclick=e=>{const r=e.currentTarget.getBoundingClientRect();
  i=Math.round((e.clientX-r.left)/r.width*(F.length-1));render();applyAudio(F[i])};
addEventListener('keydown',e=>{
  if(typingIn(e)) return;
  if(e.key===' '){e.preventDefault();$('play').click()}
  if(e.key==='ArrowRight')$('nx').click(); if(e.key==='ArrowLeft')$('pv').click();
  if(e.key===']'){ pressFlash($('tFf')); tapeShuttle(1); }
  if(e.key==='['){ pressFlash($('tRew')); tapeShuttle(-1); }
});
/* every overlay opens the same way, so they all get the holo flicker */
function openPanel(id){
  ['help','music','signals','tmach'].forEach(k=>{ if(k!==id) $(k).hidden=true; });
  const el=$(id); el.hidden=false;
  // The moment banner (z 30) sits over the panels (z 14). It only shows when
  // tape.json failed to load, but then it covers a panel's heading -- hide it
  // while a panel is up, same fix as the mobile deck.
  document.body.classList.add('panelopen');
  const box=el.querySelector('.holo')||el.firstElementChild;
  if(box){ box.classList.remove('in'); void box.offsetWidth; box.classList.add('in'); }
  if(id==='music') fillMusic();
  if(id==='signals') fillSignals();
  if(id==='tmach') fillTm();
}
function closePanels(){ ['help','music','signals','tmach'].forEach(k=>$(k).hidden=true);
  document.body.classList.remove('panelopen');
  $('signals').classList.remove('docked'); }
// Signals is the one panel worth keeping up while looking at the expanded
// map -- watching live link bars is the point, not a detour away from the
// sky. Docked mode reuses the exact same markup and fillSignals() call as
// the modal, just repositioned by CSS, so it can only ever show what the
// modal shows. Legend and Music stay full-screen regardless: reading either
// while the map draws underneath has no use.
function toggleSignalsDock(){
  const el=$('signals');
  if(!el.hidden && el.classList.contains('docked')){ el.hidden=true; el.classList.remove('docked'); return; }
  $('help').hidden=true; $('music').hidden=true;
  el.classList.add('docked'); el.hidden=false;
  const box=el.querySelector('.holo');
  if(box){ box.classList.remove('in'); void box.offsetWidth; box.classList.add('in'); }
  fillSignals();
}
/* The circled question mark opens the flight manual, in its own tab so the
   choir keeps singing behind it. Legend keeps the short panel, which teaches
   the instruments; the manual teaches the ship. */
function openManual(){ window.open('manual.html','fvManual','noopener'); }
$('helpBtn').onclick=openManual;
$('btnLegend').onclick=()=>openPanel('help');
$('btnMusic').onclick=()=>openPanel('music');
$('btnSignals').onclick=()=>{ expanded?toggleSignalsDock():openPanel('signals'); };
$('btnMap').onclick=()=>toggleMap();
$('mapHint').addEventListener('click',e=>{
  const b=e.target.closest('.ob'); if(!b) return;
  if(b.id==='obReset'){ simDays=0; return; }
  if(b.id==='btnFocus'){ toggleFocus(); return; }
  ORBIT_YPS=+b.dataset.y;
  [...document.querySelectorAll('#mapHint .ob')].forEach(x=>x.classList.toggle('on',x===b));
});
// Solar-system and Earth-local satellites differ by four or five orders of
// magnitude in distance -- one zoom range can never resolve both. This
// switches which body sits at the drawing origin: the Sun (interplanetary
// scale, the fleet a small cluster on Earth) or Earth itself (its own moon
// and tracked spacecraft drawn as the primary content, at a scale meant for
// actually telling LEO from lunar distance apart). Zoom resets on switch
// since the same number means a very different thing in the other frame.
function toggleFocus(){
  mapFocus=mapFocus==='sun'?'earth':'sun';
  zoom=1;
  $('btnFocus').textContent=mapFocus==='sun'?'Focus Earth':'Focus Solar System';
}
let mapScrollY=0;
function toggleMap(){
  expanded=!expanded;
  zoom=1; mapFocus='sun'; $('btnFocus').textContent='Focus Earth';
  document.body.classList.toggle('bigmap',expanded);
  // Set this directly rather than through the class rule: the cascade was not
  // reliably applying it to the img, and this is unambiguous. #footbezel is
  // the same kind of img as #bezel (the bottom console photo, not the #bot
  // HUD text drawn over it) and was missing from here entirely -- #bot
  // itself faded to the class rule correctly, but the bright photo sitting
  // underneath it never did, which is what actually read as "the bottom
  // console doesn't grey out."
  const fade=el=>{ if(el){ el.style.transition='opacity .5s'; el.style.opacity=expanded?'0.16':'1'; } };
  fade($('bezel')); STRIPS.forEach(st=>fade($(st.img)));
  // The expanded map is a fixed, viewport-sized canvas while every hit test
  // is in page coordinates, which agree only at scroll 0 -- so the page goes
  // to the top and stays there while the map is up, and returns to wherever
  // the visitor was afterwards.
  const root=document.documentElement;
  if(expanded){ mapScrollY=scrollY; root.classList.add('maplock'); scrollTo({top:0,behavior:'instant'}); }
  else { root.classList.remove('maplock'); scrollTo({top:mapScrollY,behavior:'instant'}); }
  size(); placeToast();
  $('btnMap').textContent=expanded?'Exit map':'Expand map';
  // Both directions, not just entering: leaving map mode with the signals
  // dock still up would otherwise strand it there, docked-styled, over the
  // now-restored cockpit.
  closePanels();
}
$('helpClose').onclick=closePanels; $('musicClose').onclick=closePanels; $('sigClose').onclick=closePanels;

/* Full screen. The deck already fills the window's width; this also takes
   the browser's own chrome away. The page still scrolls in full screen. */
{
  const b=$('btnFull');
  if(!document.fullscreenEnabled) b.hidden=true;
  b.onclick=()=>{
    if(document.fullscreenElement) document.exitFullscreen().catch(()=>{});
    else document.documentElement.requestFullscreen().catch(()=>{});
  };
  document.addEventListener('fullscreenchange',()=>{
    b.textContent=document.fullscreenElement?'Exit full screen':'Full screen'; });
}

/* ---------- TIME MACHINE ----------
   Every complete hour of the archive as a searchable, sortable table. Rows
   are hourly snapshots in the moment format, so loading one is the same
   in-place tape load the transport keys use -- no reload, no second Power Up
   -- and the address bar follows, so each hour is a link. */
const TM_FILTER={acq:false,lost:false,dual:false,curated:false};
const CX_NAMES={gdscc:'goldstone',mdscc:'madrid',cdscc:'canberra'};
let tmSort={key:'t',dir:-1};            // newest first
// Global single-key shortcuts (Space, M, S, F, [, ], T, ?) must not fire while
// someone is typing a search: "mro" would otherwise open the Music panel.
function typingIn(e){ return !!(e.target&&e.target.closest&&e.target.closest('input,textarea')); }
function fmtRate(bps){ return !bps?'--':bps>=1e6?(bps/1e6).toFixed(1)+' Mb/s':Math.round(bps/1e3)+' kb/s'; }
async function tapeLoadId(id){
  if(!AC){ location.href=location.pathname+'?moment='+encodeURIComponent(id); return; }
  if(tapeBusy||shuttleRunning) return;
  tapeBusy=true;
  const h=TM&&TM.hours.find(x=>x.id===id);
  flash('LOADING · '+(h?hourTitle(h.t):id).toUpperCase());
  try{
    const m=await fetchMoment(id);
    // As everywhere else: the tape in hand before whatever was playing goes.
    if(liveMode) goOffline();
    mountMoment(m);
    history.replaceState(null,'',location.pathname+'?moment='+encodeURIComponent(id));
    setPlaying(true);
    render(); applyAudio(F[i]);
    closePanels();
  }catch(_){
    flash('THAT HOUR WOULD NOT LOAD · STILL ON THE PREVIOUS TAPE');
  }finally{ tapeBusy=false; }
}
async function fillTm(){
  const tm=await tmIndex();
  if(!tm){ $('tmTable').innerHTML='<p class="tmempty">The archive index did not load.</p>'; return; }
  $('tmN').textContent=tm.hours.length;
  $('tmFrom').textContent=String(tm.archiveFrom).slice(5,16).replace('T',' ');
  $('tmTo').textContent=String(tm.archiveTo).slice(5,16).replace('T',' ');
  renderTm();
  $('tmQ').focus();
}
function renderTm(){
  const tm=TM; if(!tm) return;
  const terms=$('tmQ').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows=tm.hours.filter(h=>{
    if(TM_FILTER.acq&&!h.acq.length) return false;
    if(TM_FILTER.lost&&!h.lost.length) return false;
    if(TM_FILTER.dual&&!h.dual) return false;
    if(TM_FILTER.curated&&!h.moment) return false;
    if(!terms.length) return true;
    // Every term has to match somewhere, so "vgr1 madrid" narrows rather than widens.
    const hay=[hourTitle(h.t), h.t.slice(5,10), ...h.craft, ...h.stations,
               ...h.stations.map(s=>CX_NAMES[s]||''), h.tone, h.moment||''].join(' ').toLowerCase();
    return terms.every(t=>hay.includes(t));
  });
  const val={t:h=>h.t, peak:h=>h.peak, craft:h=>h.craft.length,
             events:h=>h.acq.length+h.lost.length+(h.dual?1:0), rate:h=>h.maxRate, faint:h=>h.faint};
  const get=val[tmSort.key], dir=tmSort.dir;
  rows.sort((a,b)=>{
    const x=get(a), y=get(b);
    if(x==null||y==null) return (x==null)-(y==null);        // unknowns always last
    return (x<y?-1:x>y?1:0)*dir;
  });
  const maxPeak=Math.max(1,...tm.hours.map(h=>h.peak));
  const cur=MOMENT&&MOMENT.id;
  const cols=[['t','Hour (UTC)'],['peak','Downlinks'],['craft','Spacecraft'],[null,'Complexes'],
              ['events','Events'],['rate','Fastest'],['faint','Faintest dBm'],[null,'']];
  const head=cols.map(([k,l])=>k
    ? `<th data-k="${k}" class="${tmSort.key===k?'sorted':''}">${l}${tmSort.key===k?(dir>0?' ▲':' ▼'):''}</th>`
    : `<th>${l}</th>`).join('');
  const body=rows.map(h=>`<tr data-id="${esc(h.id)}" class="${h.id===cur?'cur':''}">
    <td><button class="tmgo" data-id="${esc(h.id)}">${esc(h.t.slice(0,10))} <b>${esc(h.t.slice(11,13))}:00</b></button></td>
    <td class="pk">${h.peak}<i style="width:${Math.round(h.peak/maxPeak*56)}px"></i></td>
    <td class="sc">${esc(h.craft.slice(0,9).join(' '))}${h.craft.length>9?` <span class="more">+${h.craft.length-9}</span>`:''}</td>
    <td class="cx">${['gdscc','mdscc','cdscc'].map(s=>`<b class="${h.stations.includes(s)?'on':''}" title="${CX_NAMES[s]}">${s[0].toUpperCase()}</b>`).join('')}</td>
    <td class="ev">${h.acq.length?`<span class="a" title="acquired: ${esc(h.acq.join(', '))}">▲${h.acq.length}</span> `:''}${h.lost.length?`<span class="l" title="lost: ${esc(h.lost.join(', '))}">▼${h.lost.length}</span> `:''}${h.dual?'<span class="d">DUAL</span>':''}</td>
    <td class="num">${fmtRate(h.maxRate)}</td>
    <td class="num">${h.faint==null?'--':Math.round(h.faint)}</td>
    <td class="star" title="${h.moment?'contains a curated moment':''}">${h.moment?'★':''}</td></tr>`).join('');
  $('tmTable').innerHTML=rows.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '<p class="tmempty">No hours match. Every search term has to match, so try fewer.</p>';
  $('tmStat').textContent=rows.length+' of '+tm.hours.length+' hours';
}
$('tmTable').addEventListener('click',e=>{
  const th=e.target.closest('th[data-k]');
  if(th){
    const k=th.dataset.k;
    // Newest, busiest, fastest first by default -- except faintest, where
    // "first" means the weakest signal, which is the most negative number.
    tmSort=tmSort.key===k?{key:k,dir:-tmSort.dir}:{key:k,dir:k==='faint'?1:-1};
    renderTm(); return;
  }
  const tr=e.target.closest('tr[data-id]');
  if(tr) tapeLoadId(tr.dataset.id);
});
$('tmQ').addEventListener('input',renderTm);
document.querySelectorAll('.tmchip').forEach(b=>b.addEventListener('click',()=>{
  const f=b.dataset.f; TM_FILTER[f]=!TM_FILTER[f]; b.classList.toggle('on',TM_FILTER[f]); renderTm();
}));
$('btnTime').onclick=()=>openPanel('tmach');
$('tmClose').onclick=closePanels;
$('tmach').addEventListener('click',e=>{ if(e.target.id==='tmach') closePanels(); });
['help','music','signals'].forEach(k=>$(k).onclick=e=>{if(e.target.id===k)closePanels();});
addEventListener('keydown',e=>{
  // Escape still closes a panel from inside the search box; nothing else does.
  if(typingIn(e)&&e.key!=='Escape') return;
  if(e.key==='?'||(e.key==='/'&&e.shiftKey)) openManual();
  if(e.key==='m'||e.key==='M') $('music').hidden?openPanel('music'):closePanels();
  if(e.key==='s'||e.key==='S') $('signals').hidden?openPanel('signals'):closePanels();
  if(e.key==='t'||e.key==='T') $('tmach').hidden?openPanel('tmach'):closePanels();
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
        if(h) sky.dispatchEvent(new MouseEvent('click',{clientX:h.x-scrollX,clientY:h.y-scrollY,bubbles:true}));
      }
    }, 700);
  };
  if(document.readyState==='complete') setTimeout(go,120); else addEventListener('load',()=>setTimeout(go,120));
})();

locks.forEach(n=>{const d=document.createElement('div');d.className='m';
  d.style.left=(n/(F.length-1)*100)+'%';$('tk').appendChild(d)});

fetch('overlay/cockpit_overlay.json').then(r=>r.ok?r.json():null).then(j=>{
  if(!j){ $('bezel').remove(); return; }
  AP=j; document.body.classList.add('cockpit');
  panMode = wantPanMode();
  document.documentElement.classList.toggle('panmode', panMode);
  document.documentElement.classList.add('deckscroll');
  // One combined frame: the cockpit on top, then each strip in STRIPS order,
  // fetched together and stacked once. Strip apertures are authored in
  // strip-local space, so each is shifted down by everything above it.
  Promise.all(STRIPS.map(st=>fetch(st.json).then(r=>r.ok?r.json():null).catch(()=>null)))
  .then(js=>{
    let off=COCKPIT_H;
    STRIPS.forEach((st,k)=>{
      const sj=js[k]; if(!sj) return;
      st.j=sj; st.top=off;
      Object.entries(sj.apertures).forEach(([id,v])=>{
        AP.apertures[id]=[v[0], v[1]+off, v[2], v[3]];
      });
      off+=sj.frame[1];
      let im=$(st.img);
      if(!im){ im=document.createElement('img'); im.id=st.img; im.className='stripbezel';
        im.alt=''; document.body.appendChild(im); }
      im.hidden=false; im.src=st.png;
      // Loading is async and can finish after a map toggle -- match whatever
      // state expanded is in right now rather than assuming this came first.
      im.style.opacity=expanded?'0.16':'1';
      // removeAttribute, not .hidden=false: #rotMarks is an <svg>, and SVG
      // elements have no hidden property -- assigning it is a silent no-op.
      (st.show||[]).forEach(id=>{ const e=$(id); if(e) e.removeAttribute('hidden'); });
      // One strip's hook must never take the rest of the deck down with it.
      // A throw here aborts the whole forEach, so every strip below this one
      // silently loses its ready and after hooks: that is how a single bad
      // reference in the ship module left the footer, tape, score, reader,
      // archive, comms and porthole consoles unwired with nothing on screen
      // to say why.
      try{ if(st.ready) st.ready(sj); }catch(e){ console.error('strip ready failed',st.json,e); }
    });
    AP.frame=[AP.frame[0], off];
    layoutCockpit();
    STRIPS.forEach(st=>{ try{ if(st.j&&st.after) st.after(); }catch(e){ console.error('strip after failed',st.json,e); } });
    centreOnWindow();
    // Reveal the console in one go, once every photo in it has loaded and
    // decoded -- with a ceiling, so one slow image cannot keep it dark.
    const art=[$('bezel'), ...STRIPS.filter(st=>st.j).map(st=>$(st.img))].filter(Boolean);
    const loaded=img=>(img.complete&&img.naturalWidth ? Promise.resolve() : new Promise(r=>{
        img.addEventListener('load',r,{once:true}); img.addEventListener('error',r,{once:true}); }))
      .then(()=>img.decode?img.decode().catch(()=>{}):null);
    Promise.race([Promise.all(art.map(loaded)), new Promise(r=>setTimeout(r,6000))])
      .then(()=>document.body.classList.add('deckready'));
  });
  // Belt and braces: nothing that goes wrong above may leave the deck hidden.
  setTimeout(()=>document.body.classList.add('deckready'), 9000);
  const im=new Image(); im.onload=()=>{buildApertureMask(im); layoutCockpit();};
  im.src='overlay/cockpit_overlay.png';
  layoutCockpit();
  fetch('overlay/hotspots.json').then(r=>r.ok?r.json():null).then(h=>{
    if(h){ HS=h; layoutHotspots(); }
  }).catch(()=>{});
}).catch(()=>{ const b=$('bezel'); if(b) b.remove(); });

/* ---------- SCORE RECORDER ----------
   A six-pen strip-chart recorder writing the choir as it sings. The paper
   is pre-printed with a grand staff; each voice has its own pen and ink
   (the colours of the reservoir caps painted on the strip), and every
   chord is written at the pen on the right, so the music reads left to
   right with the newest chord at the pen. Between chords each pen holds its
   line and steps to the next pitch, the trace a real recorder draws on a
   stepped signal, over which the noteheads are inked.

   One chord is one beat and four beats a bar -- the chant is unmetered, so
   the bar is the recorder's timing mark, not a claim about the music -- and
   the window holds two bars. The paper advances one beat per frame interval:
   the playback speed on a tape, the measured gap between frames when live.
   It stops when playback stops, as a chart does when the pens are lifted.

   Spelled with the deck's own note names (NN), with accidentals on each
   note rather than a key signature: a recorder has no key. The octavist is
   written an octave up with an 8 beneath, as Russian scores print it, which
   keeps it on the bass staff instead of five ledger lines below it. */
const INK={S:'#8B1E24',A:'#B5621A',T:'#6C681E',B:'#3A5A88',O:'#693A86',I:'#1F1F1F'};
const SC_BEATS=4, SC_MEASURES=2;
// [letter C=0..B=6, accidental] for each pitch class, matching NN.
const SC_SPELL=[[0,0],[0,1],[1,0],[2,-1],[2,0],[3,0],[3,1],[4,0],[5,-1],[5,0],[6,-1],[6,0]];
const scoreCv=$('scoreCanvas'), SCX=scoreCv.getContext('2d');
let scoreHist=[], scoreSeq=0, scoreClock=0, scoreLastKey='', scoreCW=0, scoreCH=0;
let scoreLastNow=performance.now(), scoreLastSetting='', scoreLastTone='';
const penY={};
function scoreSettingName(){ const tr=(D.tracks||{})[corpusKey]; return tr&&tr.label?tr.label:corpusKey; }
function scoreStep(){ return liveMode?Math.max(400,lastFrameGap||step):step; }
function layoutScore(){
  if(!SCORE) return;
  const box=(el,r)=>{ el.style.left=r.x+'px'; el.style.top=r.y+'px';
    el.style.width=r.w+'px'; el.style.height=r.h+'px'; };
  const r=apRect('score'), d=devicePixelRatio||1;
  box(scoreCv,r);
  const w=Math.round(r.w*d), h=Math.round(r.h*d);
  if(scoreCv.width!==w||scoreCv.height!==h){ scoreCv.width=w; scoreCv.height=h; }
  scoreCW=r.w; scoreCH=r.h;
  const a=apRect('settingWin'), b=apRect('toneWin');
  box($('scoreSetting'),a); box($('scoreTone'),b);
  $('scoreSetting').dataset.basefs=$('scoreTone').dataset.basefs=Math.max(8,a.h*0.46);
  box($('sSpeed'),apRect('chartSpeed')); box($('sPen'),apRect('penLift'));
  scoreReadouts(true);
}
function scoreReadouts(force){
  const T=TONES[tone], s=scoreSettingName(), t=T.mode+T.tone;
  if(!force&&s===scoreLastSetting&&t===scoreLastTone) return false;
  scoreLastSetting=s; scoreLastTone=t;
  setReadout($('scoreSetting'), s.toUpperCase());
  setReadout($('scoreTone'), 'TONE '+T.tone+' · '+T.mode.toUpperCase());
  return true;
}
function scoreWrite(fr){
  if(!SCORE) return;
  const key=i+'|'+fr.t+'|'+JSON.stringify(fr.notes)+'|'+tone+'|'+corpusKey;
  if(key===scoreLastKey) return;
  scoreLastKey=key;
  // A change of setting or tone is annotated on the paper where it
  // happened, the way an operator pencils a note on a running chart.
  const T=TONES[tone];
  const mark=(scoreReadouts(false)||!scoreHist.length)
    ? scoreSettingName().toUpperCase()+' · TONE '+T.tone+' · '+T.mode.toUpperCase() : null;
  scoreHist.push({seq:scoreSeq++, at:scoreClock, notes:Object.assign({},fr.notes),
    state:fr.state, t:fr.t.slice(11,16), mark});
  if(scoreHist.length>24) scoreHist.shift();
}
function scoreSpell(p,n){
  const up=p==='O'?12:0, m=n+up, [L,acc]=SC_SPELL[((m%12)+12)%12];
  return {pos:Math.max(12,Math.min(42,(Math.floor(m/12)-1)*7+L)), acc, oct:!!up};
}
function drawScore(){
  if(!SCORE||!scoreCW) return;
  const now=performance.now(), dt=Math.min(250,now-scoreLastNow); scoreLastNow=now;
  if(playing&&powerOn) scoreClock+=dt;             // the chart stops with the bus
  $('sPen').classList.toggle('latched',!playing);
  const d=devicePixelRatio||1, W=scoreCW, H=scoreCH, X=SCX;
  X.setTransform(d,0,0,d,0,0);
  // hs = half a staff space. The window spans diatonic positions 11.5-42.5:
  // enough for the soprano's top ledger and the timing marks under the
  // bass staff, and no more, because the window is only ~100px tall.
  const hs=H/31, y=pos=>(42.5-pos)*hs;
  const ML=Math.max(24,hs*7.5), penX=W-Math.max(12,W*0.03);
  const beatW=(penX-ML)/(SC_BEATS*SC_MEASURES+0.5);
  // paper, under the same warm cabin light as the spools either side
  X.fillStyle='#E2D5B4'; X.fillRect(0,0,W,H);
  const last=scoreHist[scoreHist.length-1];
  const prog=last?Math.min(1,(scoreClock-last.at)/scoreStep()):0;
  const colX=e=>penX-((last.seq-e.seq)+prog)*beatW;
  // printed chart grid: faint beat rules that travel with the paper
  X.strokeStyle='rgba(160,96,72,.16)'; X.lineWidth=1;
  if(last) for(let k=-1;k<SC_BEATS*SC_MEASURES+2;k++){
    const gx=penX-(k+prog)*beatW+beatW*0.5; if(gx<0||gx>W) continue;
    X.beginPath(); X.moveTo(gx,0); X.lineTo(gx,H); X.stroke(); }
  // printed staves, rust ink
  X.strokeStyle='rgba(140,72,52,.78)'; X.lineWidth=Math.max(.8,hs*.12);
  [30,32,34,36,38,18,20,22,24,26].forEach(p=>{ X.beginPath(); X.moveTo(0,y(p)); X.lineTo(W,y(p)); X.stroke(); });
  const ink=(p,a)=>{ const c=INK[p]; const r=parseInt(c.slice(1,3),16),g=parseInt(c.slice(3,5),16),b=parseInt(c.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`; };
  const vis=scoreHist.filter(e=>colX(e)>-beatW);
  // bar lines and the timing marks under them
  X.font=`${Math.max(7,hs*2.1)}px "IBM Plex Mono",monospace`; X.textBaseline='bottom';
  vis.forEach(e=>{
    if(e.seq%SC_BEATS) return;
    const bx=colX(e)-beatW*0.5; if(bx<ML*0.6) return;
    X.strokeStyle='rgba(35,28,24,.78)'; X.lineWidth=Math.max(.8,hs*.16);
    X.beginPath(); X.moveTo(bx,y(38)); X.lineTo(bx,y(18)); X.stroke();
    X.fillStyle='rgba(120,64,46,.8)'; X.textAlign='left'; X.fillText(e.t+'Z',bx+2,H-1);
  });
  // pen traces: each voice holds its pitch to the next chord, then steps
  PARTS.forEach(([p])=>{
    X.strokeStyle=ink(p,.42); X.lineWidth=Math.max(.7,hs*.28); X.beginPath();
    let open=false;
    vis.forEach((e,k)=>{
      const n=e.notes[p]; if(n==null){ open=false; return; }
      const yy=y(scoreSpell(p,n).pos), x0=colX(e), nx=vis[k+1]?colX(vis[k+1]):penX;
      if(open) X.lineTo(x0,yy); else X.moveTo(x0,yy);
      X.lineTo(nx,yy); open=true;
    });
    X.stroke();
  });
  // noteheads, ledger lines, accidentals, fermatas, annotations
  vis.forEach(e=>{
    const x=colX(e);
    const heads=PARTS.map(([p])=>e.notes[p]==null?null:Object.assign({p},scoreSpell(p,e.notes[p])))
      .filter(Boolean).sort((a,b)=>a.pos-b.pos);
    heads.forEach((h,k)=>{ h.dx=(k&&h.pos-heads[k-1].pos<=1&&!heads[k-1].dx)?hs*2.5:0; });
    heads.forEach(h=>{
      const hx=x+h.dx, hy=y(h.pos);
      X.strokeStyle='rgba(140,72,52,.75)'; X.lineWidth=Math.max(.6,hs*.12);
      const led=[]; if(h.pos>=40) for(let q=40;q<=h.pos;q+=2) led.push(q);
      if(h.pos<=16) for(let q=16;q>=h.pos;q-=2) led.push(q);
      if(h.pos===28) led.push(28);
      led.forEach(q=>{ X.beginPath(); X.moveTo(hx-hs*1.9,y(q)); X.lineTo(hx+hs*1.9,y(q)); X.stroke(); });
      X.save(); X.translate(hx,hy); X.rotate(-0.35);
      X.beginPath(); X.ellipse(0,0,hs*1.3,hs*.92,0,0,Math.PI*2);
      if(e.state==='recitation'){ X.strokeStyle=ink(h.p,.95); X.lineWidth=Math.max(.8,hs*.34); X.stroke(); }
      else { X.fillStyle=ink(h.p,.95); X.fill(); }
      X.restore();
      if(h.acc){ X.fillStyle=ink(h.p,.9); X.font=`${hs*3.1}px "Apple Symbols","Segoe UI Symbol","Noto Music",serif`;
        X.textAlign='center'; X.textBaseline='middle'; X.fillText(h.acc>0?'♯':'♭',hx-hs*2.9,hy-(h.acc<0?hs*.5:0)); }
      if(h.oct){ X.fillStyle=ink(h.p,.8); X.font=`${hs*2}px "IBM Plex Mono",monospace`;
        X.textAlign='center'; X.textBaseline='top'; X.fillText('8',hx,hy+hs*1.2); }
    });
    if(e.state==='cadence'){
      const fy=y(40.6); X.strokeStyle=X.fillStyle='rgba(35,28,24,.8)'; X.lineWidth=Math.max(.8,hs*.22);
      X.beginPath(); X.arc(x,fy,hs*1.5,Math.PI,0); X.stroke();
      X.beginPath(); X.arc(x,fy-hs*.25,hs*.3,0,Math.PI*2); X.fill();
    }
    if(e.mark&&x>ML){
      X.strokeStyle='rgba(120,64,46,.55)'; X.lineWidth=1; X.setLineDash([2,2]);
      X.beginPath(); X.moveTo(x,hs*2.6); X.lineTo(x,y(38)); X.stroke(); X.setLineDash([]);
      X.fillStyle='rgba(110,58,40,.9)'; X.font=`${Math.max(7,hs*2.1)}px "IBM Plex Mono",monospace`;
      X.textAlign='left'; X.textBaseline='top'; X.fillText(e.mark,x+2,1);
    }
  });
  // the pen carriage: six nibs riding their voices, lifted while stopped
  X.strokeStyle='rgba(70,70,76,.5)'; X.lineWidth=1;
  X.beginPath(); X.moveTo(penX,0); X.lineTo(penX,H); X.stroke();
  const ease=1-Math.exp(-dt/70), lift=playing?0:hs*1.2;
  PARTS.forEach(([p],k)=>{
    const n=last&&last.notes[p];
    const target=n==null?hs*(1.2+k*1.1):y(scoreSpell(p,n).pos);
    penY[p]=penY[p]==null?target:penY[p]+(target-penY[p])*ease;
    const px=penX+lift, py=penY[p], nb=hs*1.5;
    X.globalAlpha=n==null||!playing?.45:1;
    X.strokeStyle=ink(p,.8); X.lineWidth=Math.max(1,hs*.3);
    X.beginPath(); X.moveTo(px+nb,py); X.lineTo(W,py-hs*(k-2.5)*.6); X.stroke();
    X.fillStyle=INK[p]; X.beginPath(); X.moveTo(px,py); X.lineTo(px+nb,py-nb*.55);
    X.lineTo(px+nb,py+nb*.55); X.closePath(); X.fill();
    X.globalAlpha=1;
  });
  // printed on the glass, not the paper: brace and clefs stay put while the
  // chart runs under them, fading the oldest ink out as it passes.
  const g=X.createLinearGradient(ML*0.55,0,ML+beatW*0.6,0);
  g.addColorStop(0,'rgba(226,213,180,1)'); g.addColorStop(1,'rgba(226,213,180,0)');
  X.fillStyle='#E2D5B4'; X.fillRect(0,0,ML*0.55,H); X.fillStyle=g; X.fillRect(ML*0.55,0,ML*0.45+beatW*0.6,H);
  X.strokeStyle='rgba(140,72,52,.78)'; X.lineWidth=Math.max(.8,hs*.12);
  [30,32,34,36,38,18,20,22,24,26].forEach(p=>{ X.beginPath(); X.moveTo(0,y(p)); X.lineTo(ML,y(p)); X.stroke(); });
  X.strokeStyle='rgba(35,28,24,.85)'; X.lineWidth=Math.max(1,hs*.2);
  X.beginPath(); X.moveTo(hs*1.2,y(38)); X.lineTo(hs*1.2,y(18)); X.stroke();
  X.fillStyle='rgba(35,28,24,.9)'; X.textAlign='left'; X.textBaseline='alphabetic';
  X.font=`${hs*7.4}px "Apple Symbols","Segoe UI Symbol","Noto Music",serif`;
  X.fillText('𝄞',hs*2.2,y(29.2));
  X.font=`${hs*5.2}px "Apple Symbols","Segoe UI Symbol","Noto Music",serif`;
  X.fillText('𝄢',hs*2.4,y(21.6));
  // the window's own shadow falling onto the paper
  const sh=X.createLinearGradient(0,0,0,hs*2.4);
  sh.addColorStop(0,'rgba(20,12,6,.38)'); sh.addColorStop(1,'rgba(20,12,6,0)');
  X.fillStyle=sh; X.fillRect(0,0,W,hs*2.4);
}
$('sSpeed').addEventListener('click',()=>{
  const t=$('sp'); t.selectedIndex=(t.selectedIndex+1)%t.options.length;
  t.dispatchEvent(new Event('change'));
  pressFlash($('sSpeed'));
  flash('CHART SPEED  '+t.options[t.selectedIndex].text+' PER CHORD'+(liveMode?'  (TAPES ONLY)':''));
});
$('sPen').addEventListener('click',()=>{ pressFlash($('sPen')); $('play').click(); });
// Space stays the global pause, as on the transport keys and the rotary.
['sSpeed','sPen'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));

/* ---------- GALLEY ----------
   Purely for fun. The microwave's window and the cabinet's opening are cut
   out of the strip; behind them sit photographs of the lit oven interior
   and the stores shelves, and the cabinet door is its own panel so it can
   slide. START lights the oven for MW_SECONDS and dings; the door handle
   unlatches the door and runs it into the bulkhead, stopping short so the
   handle is still there to pull it back. The sounds go straight to the
   speakers, around the choir's rotary, and only once audio is on. */
const MW_SECONDS=20;
let mwTimer=null;
function layoutGalley(){
  if(!GALLEY) return;
  const box=(el,r)=>{ el.style.left=r.x+'px'; el.style.top=r.y+'px';
    el.style.width=r.w+'px'; el.style.height=r.h+'px'; };
  const w=apRect('mwWindow');
  box($('galMw'),w); box($('galCab'),apRect('cabOpening')); box($('galStart'),apRect('mwStart'));
  box($('galGlow'),{x:w.x-w.w*0.45, y:w.y-w.h*0.7, w:w.w*1.9, h:w.h*2.4});
}
function galSound(kind){
  if(!AC||muted) return;
  const t=AC.currentTime, out=AC.createGain(); out.connect(AC.destination);
  if(kind==='ding'){
    out.gain.setValueAtTime(0.0001,t); out.gain.exponentialRampToValueAtTime(0.12,t+0.01);
    out.gain.exponentialRampToValueAtTime(0.0001,t+2.2);
    [[1568,1],[2349,.35],[3136,.15]].forEach(([f,a])=>{
      const o=AC.createOscillator(), g=AC.createGain(); o.frequency.value=f; g.gain.value=a;
      o.connect(g).connect(out); o.start(t); o.stop(t+2.3); });
    return;
  }
  // hiss: the door's pneumatics; clunk: a latch or a heavy button
  const len=kind==='hiss'?0.9:0.12;
  const b=AC.createBuffer(1,Math.ceil(AC.sampleRate*len),AC.sampleRate), d=b.getChannelData(0);
  for(let k=0;k<d.length;k++) d[k]=Math.random()*2-1;
  const s=AC.createBufferSource(), f=AC.createBiquadFilter(); s.buffer=b;
  f.type=kind==='hiss'?'highpass':'lowpass'; f.frequency.value=kind==='hiss'?2500:320;
  out.gain.setValueAtTime(kind==='hiss'?0.05:0.25,t); out.gain.exponentialRampToValueAtTime(0.0001,t+len);
  s.connect(f).connect(out); s.start(t);
}
function mwSet(on){
  clearTimeout(mwTimer);
  $('galMw').classList.toggle('on',on); $('galGlow').classList.toggle('on',on);
  galleyDraw(on);                      // the oven pulls on the same bus as everything else
  const b=$('galStart'); b.classList.toggle('latched',on); b.setAttribute('aria-pressed',String(on));
  if(on) mwTimer=setTimeout(()=>{ mwSet(false); galSound('ding');
    flash('DING · BEEF STEW, CHICKEN AND RICE: WARM'); }, MW_SECONDS*1000);
}
$('galStart').addEventListener('click',()=>{
  pressFlash($('galStart')); galSound('clunk');
  const on=!$('galMw').classList.contains('on'); mwSet(on);
  flash(on?'FOOD WARMER ON · 0:'+MW_SECONDS:'FOOD WARMER OFF');
});
function cabSet(open){
  const c=$('galCab'), h=$('galHandle');
  if(c.classList.contains('open')===open) return;
  h.setAttribute('aria-expanded',String(open));
  h.setAttribute('aria-label','Beverage stores door: slide '+(open?'closed':'open'));
  if(open){
    c.classList.add('latch'); galSound('clunk');
    setTimeout(()=>{ c.classList.remove('latch'); c.classList.add('open'); galSound('hiss'); },200);
    flash('BEVERAGE STORES OPEN · ONE JAR HAS WORKED LOOSE');
  } else {
    c.classList.remove('open'); galSound('hiss');
    setTimeout(()=>{ c.classList.add('latch'); galSound('clunk');
      setTimeout(()=>c.classList.remove('latch'),220); },1150);
  }
}
$('galHandle').addEventListener('click',()=>cabSet(!$('galCab').classList.contains('open')));
['galStart','galHandle'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));

/* ---------- NAVIGATION · COMMUNICATIONS · CREW STATION ----------
   The three strips under the galley. Shared pieces first. */
function placeBox(el,r){ if(!el) return; el.style.left=r.x+'px'; el.style.top=r.y+'px';
  el.style.width=r.w+'px'; el.style.height=r.h+'px'; }
function fitCanvas(cv,w,h){
  const d=devicePixelRatio||1, W=Math.max(1,Math.round(w*d)), H=Math.max(1,Math.round(h*d));
  if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; }
  const x=cv.getContext('2d'); x.setTransform(d,0,0,d,0,0); return x;
}
// Which strips are on screen: the globe only renders, and the teleprinter
// only clatters, while someone can see it.
const stripSeen={};
const stripObs=('IntersectionObserver' in window)
  ? new IntersectionObserver(es=>es.forEach(e=>{ stripSeen[e.target.id]=e.isIntersecting; }),{rootMargin:'120px'})
  : null;
function watchStrip(id){ const el=$(id); if(el&&stripObs) stripObs.observe(el); else stripSeen[id]=true; }
// Small mechanical sounds, straight to the speakers like the galley's, and
// only once audio is on.
let noiseBuf=null;
function blip(kind,vol){
  if(!AC||muted) return;
  vol=vol==null?1:vol;
  const t=AC.currentTime, g=AC.createGain(); g.connect(AC.destination);
  const env=(a,len)=>{ g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(a*vol,t+0.004);
    g.gain.exponentialRampToValueAtTime(0.0001,t+len); };
  const tone=(f0,f1,len)=>{ const o=AC.createOscillator(); o.frequency.setValueAtTime(f0,t);
    if(f1!==f0) o.frequency.exponentialRampToValueAtTime(f1,t+len); o.connect(g); o.start(t); o.stop(t+len+0.02); };
  const noise=(len,type,f,q)=>{
    if(!noiseBuf){ noiseBuf=AC.createBuffer(1,AC.sampleRate,AC.sampleRate);
      const d=noiseBuf.getChannelData(0); for(let k=0;k<d.length;k++) d[k]=Math.random()*2-1; }
    const s=AC.createBufferSource(), fl=AC.createBiquadFilter(); s.buffer=noiseBuf;
    fl.type=type; fl.frequency.value=f; fl.Q.value=q||1; s.connect(fl).connect(g); s.start(t,Math.random()*0.5,len+0.02); };
  switch(kind){
    case 'tick':  env(.025,.014); noise(.014,'highpass',1800); break;   // one typebar
    case 'cr':    env(.07,.09);   noise(.09,'lowpass',500); break;      // carriage return
    case 'bell':  env(.05,1.1);   tone(2637,2637,1.1); tone(3951,3951,.6); break;
    case 'flick': env(.05,.05);   noise(.05,'bandpass',3200,2); break;  // a card
    case 'page':  env(.05,.16);   noise(.16,'bandpass',1400,.8); break; // a page
    case 'pop':   env(.12,.11);   tone(760,170,.11); break;             // a lid
    case 'rip':   env(.09,.3);    noise(.3,'bandpass',1900,.6); break;  // Velcro, a flag
    case 'blup':  env(.05,.08);   tone(210+Math.random()*120,360,.08); break;
    case 'key':   env(.07,.035);  noise(.035,'lowpass',900); break;     // a DSKY key
    case 'squeak':env(.06,.2);    tone(1150,1750,.09); tone(1750,1300,.2); break; // a rubber duck
    case 'clack': env(.1,.14);    noise(.14,'lowpass',650); tone(180,90,.08); break; // a slide dropping
    case 'klaxon': {                                                    // the abort klaxon
      g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.05*vol,t+0.02);
      g.gain.setValueAtTime(0.05*vol,t+1.5); g.gain.exponentialRampToValueAtTime(0.0001,t+1.7);
      const o=AC.createOscillator(), lp=AC.createBiquadFilter(); o.type='square'; lp.type='lowpass'; lp.frequency.value=2200;
      for(let k=0;k<8;k++) o.frequency.setValueAtTime(k%2?523:392,t+k*0.2);
      o.connect(lp).connect(g); o.start(t); o.stop(t+1.75); break; }
  }
}
// A typewriter face with a real one's unevenness: each character sits a
// hair off the line and takes a slightly different amount of ink.
function typeLine(x,s,px,py,size,ink){
  x.font=`${size}px "Courier New",Courier,monospace`; x.textAlign='left'; x.textBaseline='alphabetic';
  const cw=x.measureText('M').width; let h=2166136261;
  for(let k=0;k<s.length;k++){
    h=Math.imul(h^s.charCodeAt(k),16777619)>>>0;
    x.fillStyle=ink.replace('A',(0.84+0.16*((h&255)/255)).toFixed(2));   // was 0.66: too faint to read
    x.fillText(s[k],px+k*cw,py+((((h>>>8)&255)/255)-0.5)*size*0.07);
  }
  return cw;
}
let stripsKey='';
function stripsFrame(fr){
  const k=i+'|'+fr.t; if(k===stripsKey) return; stripsKey=k;
  const acq=(fr.acq||[]).filter(c=>FMAP[c]);
  if(NAV){
    const act={}; fr.links.forEach(l=>{ (act[l.st]=act[l.st]||new Set()).add(l.sc); }); NAV_ACT=act;
    NAV_ST.forEach(([st,id])=>{ const n=act[st]?act[st].size:0, el=$(id);
      el.classList.toggle('lit',n>0);
      el.title=((SITES[st]||{}).name||st).toUpperCase()+(n?' · '+n+' SPACECRAFT':' · NOT TRACKING'); });
    if(acq.length) flipTo(cardList().indexOf(acq[0])); else drawCard();
    globeLast=0; drawDrums();
  }
  if(CREW&&acq.length&&!jarOpen){ jarSet(true); clearTimeout(jarAuto); jarAuto=setTimeout(()=>jarSet(false),6000); }
  if(GUIDE) dskyFrame(fr);
  if(LIBRARY) libMark();
  if(FDAI) fdaiFrame(fr);
  if(READER) readerFrame(fr);
  if(ARCHIVE&&acq.length) slideTo(acq[0]);
}

/* NAVIGATION. The ГЛОБУС is the clockwork globe Vostok and Soyuz carried
   to show the crew where they were. This one shows the ground instead: the
   real Earth, turning under the Sun's real light for the frame's own time
   (so a tape from the archive shows that hour's Earth), seen from a fixed
   mid-morning point so the dawn line stays in view. Each Deep Space Network
   complex glows on the globe and on its lamp while it has a spacecraft --
   the three sit about 120 degrees apart so that one always does. */
const NAV_ST=[['gdscc','lampG'],['mdscc','lampM'],['cdscc','lampC']];
const NAV_COL=['rgba(255,179,71,A)','rgba(108,255,142,A)','rgba(255,90,60,A)'], NAV_ABBR=['GDS','MAD','CAN'];
const GLOBE_LAT=18*Math.PI/180;
let NAV_ACT={}, globeTex=null, globeCache=null, globeSpin=null, globeLast=0;
let cardIdx=0, cardOrder=[], cardBg=null;
// Low-precision Sun: declination and the longitude it stands over, good to a
// fraction of a degree, which on a globe this size is under a pixel.
function subsolar(ms){
  const d=ms/86400000-10957.5;                                 // days from J2000.0
  const g=(357.529+0.98560028*d)*Math.PI/180, q=280.459+0.98564736*d;
  const L=(q+1.915*Math.sin(g)+0.020*Math.sin(2*g))*Math.PI/180;
  const e=(23.439-0.00000036*d)*Math.PI/180;
  const dec=Math.asin(Math.sin(e)*Math.sin(L)), ra=Math.atan2(Math.cos(e)*Math.sin(L),Math.cos(L));
  const gmst=(((18.697374558+24.06570982441908*d)%24)+24)%24*15*Math.PI/180;
  let lon=ra-gmst; lon-=Math.floor((lon+Math.PI)/(2*Math.PI))*2*Math.PI;
  return {dec,lon};
}
function navInit(){
  if(!globeTex){ globeTex={ready:false}; const im=new Image();
    im.onload=()=>{ const c=document.createElement('canvas'); c.width=1024; c.height=512;
      const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(im,0,0,1024,512);
      globeTex={ready:true,w:1024,h:512,px:new Uint32Array(x.getImageData(0,0,1024,512).data.buffer)}; globeLast=0; };
    im.src='overlay/globe_tex.jpg'; }
  if(!cardBg){ cardBg=new Image(); cardBg.onload=()=>drawCard(); cardBg.src='overlay/card_blank.jpg'; }
  watchStrip('navbezel'); layoutNav(); stripsKey=''; stripsFrame(F[i]);
}
function layoutNav(){
  if(!NAV) return;
  placeBox($('navGlobe'),apRect('globe')); globeCache=null; globeLast=0;
  NAV_ST.forEach(([,id])=>placeBox($(id),apRect(id)));
  ['globusKnob','knobPrev','knobNext'].forEach(id=>placeBox($(id),apRect(id)));
  placeBox($('cardWin'),apRect('cardFace'));
  drawCard();
}
function drawGlobe(){
  if(!NAV||!globeTex||!globeTex.ready) return;
  const now=performance.now();
  if(!globeSpin&&(!stripSeen.navbezel||now-globeLast<125)) return;   // 8 fps: it turns 15 degrees an hour
  globeLast=now;
  const cv=$('navGlobe'), r=apRect('globe'), d=devicePixelRatio||1;
  const W=Math.max(8,Math.round(r.w*d)), H=Math.max(8,Math.round(r.h*d));
  if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; globeCache=null; }
  const R=Math.floor(Math.min(W,H)*0.47), cx=Math.round(W/2), cy=Math.round(H/2), TWO=Math.PI*2;
  if(!globeCache){
    // Everything about each pixel that does not change as the Earth turns
    // is worked out once per size: its latitude, how far east of the
    // centre it is, and the limb shading.
    const sp=Math.sin(GLOBE_LAT), cp=Math.cos(GLOBE_LAT), N=(2*R+1)*(2*R+1);
    const la=new Float32Array(N), sl=new Float32Array(N), cl=new Float32Array(N), dl=new Float32Array(N),
          sh=new Float32Array(N), ix=new Int32Array(N);
    let m=0;
    for(let py=-R;py<=R;py++) for(let px=-R;px<=R;px++){
      const x=px/R, y=-py/R, rr=x*x+y*y; if(rr>1) continue;
      const z=Math.sqrt(1-rr), lat=Math.asin(Math.max(-1,Math.min(1,z*sp+y*cp)));
      la[m]=lat; sl[m]=Math.sin(lat); cl[m]=Math.cos(lat); dl[m]=Math.atan2(x,z*cp-y*sp);
      sh[m]=0.5+0.5*Math.pow(z,0.55); ix[m]=(cy+py)*W+(cx+px); m++;
    }
    const img=cv.getContext('2d').createImageData(W,H);
    globeCache={m,la,sl,cl,dl,sh,ix,img,buf:new Uint32Array(img.data.buffer)};
  }
  const G=globeCache, T=globeTex, buf=G.buf;
  let spin=0;
  if(globeSpin){ const p=Math.min(1,(now-globeSpin)/6000);
    spin=(p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2)*TWO; if(p>=1) globeSpin=null; }
  const sun=subsolar(windTarget());               // winding a clock turns the Earth under the Sun
  const lon0=sun.lon-1.05-spin, sd=Math.sin(sun.dec), cd=Math.cos(sun.dec);
  buf.fill(0xFF0E0B09);
  for(let k=0;k<G.m;k++){
    const lo=lon0+G.dl[k];
    let u=(lo+Math.PI)/TWO; u-=Math.floor(u);
    const tx=(u*T.w)|0, ty=Math.min(T.h-1,Math.max(0,((0.5-G.la[k]/Math.PI)*T.h)|0));
    const c=T.px[ty*T.w+tx];
    const cz=G.sl[k]*sd+G.cl[k]*cd*Math.cos(lo-sun.lon);
    const day=cz>0.07?1:cz<-0.07?0:(cz+0.07)/0.14;
    const f=G.sh[k]*(0.24+0.76*day), nb=1+0.35*(1-day);
    const rr=Math.min(255,(c&255)*f*(0.9+0.1*day))|0, gg=Math.min(255,((c>>>8)&255)*f)|0,
          bb=Math.min(255,((c>>>16)&255)*f*nb)|0;
    buf[G.ix[k]]=(0xFF000000|(bb<<16)|(gg<<8)|rr)>>>0;
  }
  const x=cv.getContext('2d'); x.setTransform(1,0,0,1,0,0); x.putImageData(G.img,0,0);
  const sp0=Math.sin(GLOBE_LAT), cp0=Math.cos(GLOBE_LAT), ts=now/1000;
  NAV_ST.forEach(([st],n)=>{
    const s=SITES[st]; if(!s) return;
    const phi=s.lat*Math.PI/180, dlam=s.lon*Math.PI/180-lon0;
    if(sp0*Math.sin(phi)+cp0*Math.cos(phi)*Math.cos(dlam)<0.02) return;       // far side
    const X=cx+R*Math.cos(phi)*Math.sin(dlam), Y=cy-R*(cp0*Math.sin(phi)-sp0*Math.cos(phi)*Math.cos(dlam));
    const col=NAV_COL[n], na=(NAV_ACT[st]||{size:0}).size;
    if(na){
      const pr=(ts*0.8+n*0.33)%1;
      x.strokeStyle=col.replace('A',(0.9*(1-pr)).toFixed(2)); x.lineWidth=1.4*d;
      x.beginPath(); x.arc(X,Y,(3+9*pr)*d,0,TWO); x.stroke();
      x.fillStyle=col.replace('A','.95'); x.font=`600 ${7.5*d}px "IBM Plex Mono",monospace`;
      x.textAlign='left'; x.textBaseline='middle'; x.fillText(NAV_ABBR[n]+' '+na,X+6*d,Y);
    }
    x.fillStyle=col.replace('A',na?'1':'.55'); x.beginPath(); x.arc(X,Y,(na?2.4:1.6)*d,0,TWO); x.fill();
  });
  // the instrument's fixed crosshair, then the glass dome over it all
  x.strokeStyle='rgba(12,10,8,.55)'; x.lineWidth=d;
  x.beginPath(); x.moveTo(cx-R,cy); x.lineTo(cx+R,cy); x.moveTo(cx,cy-R); x.lineTo(cx,cy+R); x.stroke();
  x.beginPath(); x.arc(cx,cy,R*0.08,0,TWO); x.stroke();
  const gl=x.createRadialGradient(cx-R*0.45,cy-R*0.5,R*0.05,cx-R*0.3,cy-R*0.35,R*1.1);
  gl.addColorStop(0,'rgba(255,250,235,.28)'); gl.addColorStop(0.35,'rgba(255,250,235,.06)'); gl.addColorStop(1,'rgba(255,250,235,0)');
  x.fillStyle=gl; x.beginPath(); x.arc(cx,cy,R,0,TWO); x.fill();
  const rim=x.createRadialGradient(cx,cy,R*0.8,cx,cy,R*1.02);
  rim.addColorStop(0,'rgba(0,0,0,0)'); rim.addColorStop(1,'rgba(0,0,0,.55)');
  x.fillStyle=rim; x.beginPath(); x.arc(cx,cy,R*1.02,0,TWO); x.fill();
}
function cardList(){
  if(!cardOrder.length) cardOrder=FLEET.slice().sort((a,b)=>a.n.localeCompare(b.n)).map(f=>f.id);
  return cardOrder;
}
function cardId(){ const l=cardList(), n=l.length; return l[((cardIdx%n)+n)%n]; }
// One typed card per spacecraft, on the blank card from the art: the name
// above the red rule, four facts on alternate blue rules (every rule would
// be too small to read), and a red stamp while the craft is in contact.
function drawCard(){
  if(!NAV) return;
  const r=apRect('cardFace'), cv=$('cardCv'), x=fitCanvas(cv,r.w,r.h), W=r.w, H=r.h;
  x.clearRect(0,0,W,H);
  if(cardBg&&cardBg.complete&&cardBg.naturalWidth) x.drawImage(cardBg,0,0,W,H);
  else { x.fillStyle='#E9DFC6'; x.fillRect(0,0,W,H); }
  const id=cardId(), f=FMAP[id]||{}, fd=(window.FLEETDATA||{})[id]||{}, ink='rgba(26,30,48,A)';
  // the tab: paint out the letter the art came with, stamp this card's
  x.fillStyle='rgb(158,171,142)'; x.fillRect(W*0.15,H*0.018,W*0.07,H*0.1);
  x.fillStyle='rgba(58,64,56,.9)'; x.font=`600 ${H*0.085}px "Courier New",Courier,monospace`;
  x.textAlign='center'; x.textBaseline='middle'; x.fillText((f.n||id).charAt(0).toUpperCase(),W*0.183,H*0.07);
  const fs=Math.max(6.5,H*0.105);
  x.font=`${fs}px "Courier New",Courier,monospace`;
  const cols=Math.floor(W*0.9/x.measureText('M').width);
  typeLine(x,(f.n||id).toUpperCase().slice(0,cols-6),W*0.06,H*0.225,fs*1.12,ink);
  const pos=cardList().indexOf(id)+1;
  typeLine(x,pos+'/'+cardList().length,W*0.84,H*0.225,fs*0.8,ink);
  const km=(f.au||0)*149597870.7, rt=km/299792.458*2;
  const rng=f.au>=1?f.au.toFixed(1)+' AU':km>=1e6?(km/1e6).toFixed(2)+' M KM':Math.round(km).toLocaleString('en-US')+' KM';
  const lt=rt>7200?(rt/3600).toFixed(1)+' H':rt>120?(rt/60).toFixed(1)+' MIN':rt.toFixed(1)+' S';
  const lk=F[i].links.find(l=>l.sc===id&&l.dir==='down')||F[i].links.find(l=>l.sc===id);
  const lines=['RANGE '+rng+'  R/T '+lt, ((fd.ag||'--')+(fd.yr?'  '+fd.yr:'')).toUpperCase(),
    (fd.dest||f.cls||'').toUpperCase(),
    lk?'NOW  '+String(SITEN[lk.st]||lk.st||'').toUpperCase()+' '+dishOf(lk.d):'NOW  NOT TRACKED'];
  [0.419,0.577,0.735,0.893].forEach((b,k)=>typeLine(x,lines[k].slice(0,cols),W*0.06,H*(b-0.012),fs,ink));
  if(lk){
    x.save(); x.translate(W*0.76,H*0.63); x.rotate(-0.2);
    x.strokeStyle=x.fillStyle='rgba(170,30,30,.55)'; x.lineWidth=Math.max(1,H*0.014);
    x.font=`700 ${H*0.1}px "Courier New",Courier,monospace`; x.textAlign='center'; x.textBaseline='middle';
    const tw=x.measureText('IN CONTACT').width;
    x.strokeRect(-tw/2-H*0.04,-H*0.08,tw+H*0.08,H*0.16); x.fillText('IN CONTACT',0,H*0.005);
    x.restore();
  }
}
function flipTo(k){
  const n=cardList().length; if(!n) return;
  k=((k%n)+n)%n;
  if(k===((cardIdx%n)+n)%n){ drawCard(); return; }
  const cv=$('cardCv'), fl=$('cardFlip'), r=apRect('cardFace');
  fitCanvas(fl,r.w,r.h); const fx=fl.getContext('2d'); fx.setTransform(1,0,0,1,0,0);
  fx.clearRect(0,0,fl.width,fl.height); fx.drawImage(cv,0,0);
  cardIdx=k; drawCard();
  fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go'); blip('flick');
}
$('knobPrev').addEventListener('click',()=>{ pressFlash($('knobPrev')); flipTo(cardIdx-1); });
$('knobNext').addEventListener('click',()=>{ pressFlash($('knobNext')); flipTo(cardIdx+1); });
$('cardWin').addEventListener('click',()=>{ const r=apRect('cardFace'); openCraft(cardId(),r.x+r.w*0.55,r.y-40); });
$('globusKnob').addEventListener('click',()=>{ pressFlash($('globusKnob')); globeSpin=performance.now();
  blip('flick'); flash('ГЛОБУС · ONE DAY IN SIX SECONDS'); });

/* COMMUNICATIONS. The teleprinter types the logbook at a Model 33's ten
   characters a second (thirty when it falls behind), in the only character
   set the machine had -- uppercase ASCII -- punching each character into
   the paper tape beside it with even parity, and ringing its bell for an
   acquisition. Off screen it prints instantly and silently so it is current
   when you scroll to it. */
var ttyReady=false;                         // var: logLine can run before this section has
const TTY={q:[],lines:[],cur:'',col:0,next:0,lfAt:-1e9,width:40,tape:[],dirty:true};
function ttyClean(s){
  return String(s).toUpperCase().replace(/·/g,'-').replace(/[—–]/g,'-').replace(/♯/g,'#').replace(/♭/g,'B')
    .replace(/[^\x20-\x5F]/g,'?');
}
function ttyEnqueue(t,msg,kind,keep){
  if(!ttyReady) return;
  TTY.q.push({s:ttyClean((t&&t!=='--:--:--'?t+' ':'')+msg), bell:kind==='acq'||kind==='here', keep:!!keep});
  // Over eight, the oldest routine line goes first. A kept line (a message
  // from ground, deck_report.js) is never the one dropped for chatter.
  while(TTY.q.length>8){ const k=TTY.q.findIndex(it=>!it.keep); if(k<0) break; TTY.q.splice(k,1); }
}
function ttyPunch(ch){
  const c=ch.charCodeAt(0)&127; let p=0; for(let b=c;b;b>>=1) p^=b&1;
  TTY.tape.push(c|(p<<7)); if(TTY.tape.length>700) TTY.tape.splice(0,TTY.tape.length-700);
}
function ttyStep(now){
  if(!COMMS||!ttyReady||!powerOn) return;          // no bus, no printer
  const seen=stripSeen.commsbezel;
  for(let guard=0;guard<400;guard++){
    if(!TTY.cur){ if(!TTY.q.length) return; const it=TTY.q.shift(); TTY.cur=it.s; TTY.col=0;
      if(it.bell&&seen) blip('bell'); }
    if(seen&&now<TTY.next) return;
    ttyPunch(TTY.cur[TTY.col++]); TTY.dirty=true;
    if(seen){ blip('tick'); TTY.next=now+1000/(TTY.q.length>2?30:10); }
    if(TTY.col>=TTY.cur.length||TTY.col>=TTY.width){
      TTY.lines.push(TTY.cur.slice(0,TTY.col)); if(TTY.lines.length>40) TTY.lines.shift();
      TTY.cur=TTY.cur.slice(TTY.col); TTY.col=0; ttyPunch('\r'); ttyPunch('\n');
      if(seen){ TTY.lfAt=now; blip('cr'); TTY.next=now+220; }
    }
    if(seen) return;
  }
}
function drawTty(){
  if(!COMMS||!stripSeen.commsbezel) return;
  const now=performance.now(), since=now-TTY.lfAt, rolling=since>=0&&since<180;
  if(!TTY.dirty&&!rolling) return;
  TTY.dirty=false;
  const r=apRect('printout'), x=fitCanvas($('ttyCv'),r.w,r.h), W=r.w, H=r.h;
  x.fillStyle='#ECE2C0'; x.fillRect(0,0,W,H);
  const fs=Math.max(7,H/5.6), lp=fs*1.16, pad=W*0.04;
  x.font=`${fs}px "Courier New",Courier,monospace`; const cw=x.measureText('M').width;
  TTY.width=Math.max(16,Math.floor((W-2*pad)/cw));
  const base=H-lp*0.55+(rolling?lp*(1-(now-TTY.lfAt)/180):0), ink='rgba(34,30,40,A)';
  typeLine(x,TTY.cur.slice(0,TTY.col),pad,base,fs,ink);
  for(let k=TTY.lines.length-1,n=1;k>=0&&base-n*lp>-lp;k--,n++) typeLine(x,TTY.lines[k],pad,base-n*lp,fs,ink);
  const hx=pad+TTY.col*cw;                              // the typebox, and its ribbon
  x.fillStyle='rgba(40,38,36,.85)'; x.fillRect(hx-1,base-fs*0.9,cw+2,fs*1.15);
  x.fillStyle='rgba(150,30,30,.55)'; x.fillRect(hx-1,base+fs*0.25,cw+2,fs*0.18);
  const g=x.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'rgba(30,20,10,.45)'); g.addColorStop(0.18,'rgba(30,20,10,0)');
  g.addColorStop(0.86,'rgba(30,20,10,0)'); g.addColorStop(1,'rgba(30,20,10,.35)');
  x.fillStyle=g; x.fillRect(0,0,W,H);
  drawPunch();
}
// Eight-level tape: eight data holes across it with the small feed track
// between the third and fourth, one column per character, newest at the
// punch on the right.
function drawPunch(){
  const r=apRect('punchTape'), x=fitCanvas($('tapeCv'),r.w,r.h), W=r.w, H=r.h;
  x.fillStyle='#0C0A08'; x.fillRect(0,0,W,H);
  const th=H*0.62, ty=(H-th)/2, pitch=th/10;
  const g=x.createLinearGradient(0,ty,0,ty+th);
  g.addColorStop(0,'#D9BF93'); g.addColorStop(.5,'#EBD6AE'); g.addColorStop(1,'#CDB285');
  x.fillStyle=g; x.fillRect(0,ty,W,th);
  x.fillStyle='#16110C';
  const hole=(hx,hy,rr)=>{ x.beginPath(); x.arc(hx,hy,rr,0,Math.PI*2); x.fill(); };
  const tp=TTY.tape, lanes=[0,1,2,4,5,6,7,8];
  for(let k=0,n=Math.ceil(W/pitch)+1;k<n;k++){
    const hx=W-pitch*(k+0.8); hole(hx,ty+pitch*4,pitch*0.2);
    const b=tp[tp.length-1-k]; if(b==null) continue;
    for(let bit=0;bit<8;bit++) if(b&(1<<bit)) hole(hx,ty+pitch*(lanes[bit]+0.5+(lanes[bit]>3?0.5:0)),pitch*0.34);
  }
}
let pageBg=null, pageIdx=0, pagesCache=null, pagesKey='';
// The flight checklist is this deck's own help, typeset page by page from
// the Help panel so the two never disagree.
function helpTopics(){
  const out=[]; let sec='GENERAL';
  document.querySelectorAll('#help .hsec, #help dl').forEach(el=>{
    if(el.classList.contains('hsec')){ sec=el.textContent.trim().toUpperCase(); return; }
    el.querySelectorAll('dt').forEach(dt=>{ const dd=dt.nextElementSibling;
      if(dd&&dd.tagName==='DD') out.push({sec,title:dt.textContent.trim().toUpperCase(),
        body:dd.textContent.replace(/\s+/g,' ').trim().toUpperCase()}); });
  });
  return out;
}
function paginate(W,H){
  const key=Math.round(W)+'x'+Math.round(H); if(pagesCache&&pagesKey===key) return pagesCache;
  const x=$('pageCv').getContext('2d'), fs=Math.max(7.5,H*0.078);
  x.font=`${fs}px "Courier New",Courier,monospace`;
  const cols=Math.max(12,Math.floor(W*0.78/x.measureText('M').width)), rows=Math.max(3,Math.floor(H*0.58/(fs*1.22)));
  // The printed checklist carries one section the ? panel does not: what to do
  // when a caution lights. The panel teaches the instruments; this teaches the
  // ship, and the ship is not something a first-time visitor should be handed.
  const extra=(typeof shipChecklist==='function')?shipChecklist():[];
  const topics=helpTopics().concat(extra), secs=[...new Set(topics.map(t=>t.sec))];
  const pages=[{cover:true,lines:['CLICK THE PAGE TO TURN IT.','LEFT EDGE TURNS BACK.','TABS JUMP TO A SECTION:']
    .concat(secs.map((s,k)=>' '+(k+1)+'. '+s)).slice(0,rows)}];
  topics.forEach((tp,ti)=>{
    const lines=[]; let cur='';
    tp.body.split(' ').forEach(w=>{ if(cur&&(cur+' '+w).length>cols){ lines.push(cur); cur=w; } else cur=cur?cur+' '+w:w; });
    if(cur) lines.push(cur);
    const parts=Math.ceil(lines.length/rows);
    for(let k=0;k<lines.length;k+=rows)
      pages.push({sec:tp.sec,title:tp.title,topic:ti,lines:lines.slice(k,k+rows),part:k/rows+1,parts});
  });
  pagesCache=pages; pagesKey=key;
  document.querySelectorAll('#ckTabs .cktab').forEach((b,k)=>{ const s=secs[tabSec(secs.length,k)];
    b.title=s?'FLIGHT CHECKLIST — '+s:'FLIGHT CHECKLIST'; b.setAttribute('aria-label',b.title); });
  return pages;
}
function drawPage(){
  if(!COMMS) return;
  const r=apRect('ckPage'), x=fitCanvas($('pageCv'),r.w,r.h), W=r.w, H=r.h;
  if(pageBg&&pageBg.complete&&pageBg.naturalWidth) x.drawImage(pageBg,0,0,W,H);
  else { x.fillStyle='#EFEBDD'; x.fillRect(0,0,W,H); }
  const pages=paginate(W,H), n=pages.length; pageIdx=((pageIdx%n)+n)%n;
  // Darker than a real carbon copy on purpose: this page is read on a screen,
  // at a fifth of the size the original form was printed at.
  const p=pages[pageIdx], ink='rgba(12,13,20,A)', fs=Math.max(7.5,H*0.078), hs=fs*0.82;
  x.font=`${hs}px "Courier New",Courier,monospace`; const hcw=x.measureText('M').width;
  const fit=(s,w)=>s.length*hcw>w?s.slice(0,Math.max(1,Math.floor(w/hcw)-1))+'.':s;
  // the printed form's header boxes: section, title, page, of
  typeLine(x,fit(p.cover?'CONTENTS':p.sec,W*0.16),W*0.085,H*0.228,hs,ink);
  typeLine(x,fit(p.cover?'FLIGHT CHECKLIST':p.title+(p.parts>1?' ('+p.part+'/'+p.parts+')':''),W*0.54),W*0.255,H*0.228,hs,ink);
  typeLine(x,fit(String(pageIdx+1),W*0.045),W*0.812,H*0.228,hs,ink);
  typeLine(x,fit('OF '+n,W*0.09),W*0.862,H*0.228,hs,ink);
  typeLine(x,fit('FAR VOICES  DECK OPERATIONS',W*0.5),W*0.14,H*0.302,hs*0.9,ink);
  const lp=fs*1.22, y=H*0.40+fs*0.2;
  if(!p.cover&&p.part===1) typeLine(x,String(p.topic+1),W*0.078,y,fs,ink);
  p.lines.forEach((s,k)=>typeLine(x,s,W*0.14,y+k*lp,fs,ink));
}
function flipPage(k){
  const n=(pagesCache||[]).length||1; k=((k%n)+n)%n; if(k===pageIdx) return;
  const fl=$('pageFlip'), r=apRect('ckPage'); fitCanvas(fl,r.w,r.h);
  const fx=fl.getContext('2d'); fx.setTransform(1,0,0,1,0,0); fx.clearRect(0,0,fl.width,fl.height); fx.drawImage($('pageCv'),0,0);
  pageIdx=k; drawPage(); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go'); blip('page');
}
// The five tabs are spread evenly down the sections, so they reach the
// lower consoles too rather than only the first five.
function tabSec(n,k){ return n<=5?Math.min(k,n-1):Math.round(k*(n-1)/4); }
function pageTab(k){
  const pages=pagesCache||[], secs=[...new Set(pages.filter(p=>!p.cover).map(p=>p.sec))];
  const at=secs.length?pages.findIndex(p=>p.sec===secs[tabSec(secs.length,k)]):Math.round(k*pages.length/5);
  flipPage(Math.max(0,at));
}
let tagsPulled=0, tagTimer=null;
function layoutTags(){
  const s=coverRect().s, meta=(COMMS&&COMMS._tags)||[];
  ['ring1','ring2','ring3'].forEach((rk,k)=>{
    const el=$('rbf'+(k+1)), m=meta[k]||{gx:.5,gy:.06,ar:.2}, rg=apRect(rk);
    const h=250*s, w=h*m.ar, gx=rg.x+rg.w/2, gy=rg.y+rg.h*0.82;
    el.style.width=w+'px'; el.style.height=h+'px';
    el.style.left=(gx-w*m.gx)+'px'; el.style.top=(gy-h*m.gy)+'px';
    el.style.transformOrigin=(m.gx*100)+'% '+(m.gy*100)+'%';
  });
}
// A pulled flag does not fall -- there is no down. It is let go of where it
// hung and drifts off, tumbling slowly, until it leaves the screen.
function pullTag(el){
  if(el.classList.contains('pulled')) return;
  const r=el.getBoundingClientRect(), w=parseFloat(el.style.width)||r.width, h=parseFloat(el.style.height)||r.height;
  const ang=Math.random()*Math.PI*2, sp=25+Math.random()*35;
  launchFloater({src:el.querySelector('img').getAttribute('src'), w, h,
    x:r.left+scrollX+r.width/2-w/2, y:r.top+scrollY+r.height/2-h/2, vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp,
    rot:0, vr:(Math.random()-.5)*50, label:'A REMOVE BEFORE FLIGHT flag, drifting away'});
  el.classList.add('pulled'); blip('rip',0.7); tagsPulled++;
  const left=3-tagsPulled;
  flash(left?'REMOVE BEFORE FLIGHT · '+left+' TO GO':'ALL FLAGS REMOVED · CLEARED FOR FLIGHT');
  clearTimeout(tagTimer); tagTimer=setTimeout(reinstallTags,120000);
}
// The ground crew puts the flags back -- but only while nobody is looking.
function reinstallTags(){
  if(stripSeen.commsbezel){ tagTimer=setTimeout(reinstallTags,15000); return; }
  document.querySelectorAll('.rbf.pulled').forEach(el=>el.classList.remove('pulled')); tagsPulled=0;
}
function commsInit(){
  if(!pageBg){ pageBg=new Image(); pageBg.onload=()=>drawPage(); pageBg.src='overlay/checklist_page.jpg'; }
  if(!ttyReady){ ttyReady=true;
    TTY.lines=['FAR VOICES TELEPRINTER - READY'].concat(LOG.slice(-4).map(l=>ttyClean((l.t||'')+' '+l.msg))); }
  const host=$('ckTabs');
  if(!host.children.length) for(let k=0;k<5;k++){ const b=document.createElement('button');
    b.className='cktab'; b.addEventListener('click',()=>pageTab(k)); host.appendChild(b); }
  watchStrip('commsbezel'); layoutComms();
}
function layoutComms(){
  if(!COMMS) return;
  placeBox($('ttyCv'),apRect('printout')); placeBox($('tapeCv'),apRect('punchTape'));
  placeBox($('hereIs'),apRect('hereIs')); placeBox($('pageWin'),apRect('ckPage')); placeBox($('ckTabs'),apRect('ckTabs'));
  layoutTags(); TTY.dirty=true; pagesCache=null; drawPage();
  if(typeof rptPlace==='function') rptPlace();          // the report's tear-off sits on the printout
}
$('hereIs').addEventListener('click',()=>{ pressFlash($('hereIs'));
  ttyEnqueue('','FAR VOICES  DSN CHORAL TELEMETRY  FARVOICES.COM','here'); });
$('pageWin').addEventListener('click',e=>{ const r=e.currentTarget.getBoundingClientRect();
  flipPage(pageIdx+(e.detail&&(e.clientX-r.left)<r.width*0.25?-1:1)); });
['rbf1','rbf2','rbf3'].forEach(id=>$(id).addEventListener('click',()=>pullTag($(id))));

/* CREW STATION. JPL has opened a jar of peanuts before critical events
   since Ranger 7 finally worked in 1964, after six failures; this jar pops
   its lid on every acquisition. The percolator brews on a click, and the
   pencil and checklist card will not stay on their Velcro. */
let jarOpen=false, jarAuto=null, percT=null, percBub=null, velcroNagged=false;
const DRIFT={pencilItem:{dx:-160,dy:-95,rot:-16}, cardItem:{dx:-150,dy:70,rot:13}};
function crewInit(){ new Image().src='overlay/jar_open.webp'; layoutCrew();
  ['pencilItem','cardItem'].forEach((id,k)=>{ clearTimeout($(id)._t); $(id)._t=setTimeout(()=>driftStart(id),7000+k*6000); }); }
function layoutCrew(){
  if(!CREW) return;
  document.documentElement.style.setProperty('--s',coverRect().s);
  const c=apRect('cubby'); placeBox($('jarWin'),c);
  const img=$('jarImg'), h=c.h*0.98, w=h*429/725;
  img.style.height=h+'px'; img.style.width=w+'px'; img.style.left=(c.w/2-w/2)+'px'; img.style.top=(c.h-h)+'px';
  placeBox($('perkGlow'),apRect('perkKnob')); placeBox($('percBtn'),apRect('percolator')); placeBox($('mugBtn'),apRect('mug'));
  const sp=apRect('spout'), mg=apRect('mug');
  placeBox($('steam'),{x:sp.x-sp.w*0.6,y:sp.y-sp.h*2.4,w:sp.w*2.2,h:sp.h*2.6});
  placeBox($('mugSteam'),{x:mg.x+mg.w*0.05,y:mg.y-mg.h*0.95,w:mg.w*0.62,h:mg.h});
  const home=(id,key,ar,scale)=>{ const b=apRect(key), w2=b.w*scale, h2=w2*ar;
    placeBox($(id),{x:b.x+b.w/2-w2/2,y:b.y+b.h/2-h2/2,w:w2,h:h2}); };
  home('pencilItem','pencilHome',77/620,1); home('cardItem','cardHome',295/470,1.08);
}
function jarSet(open){
  if(open===jarOpen) return; jarOpen=open;
  const img=$('jarImg'); img.src=open?'overlay/jar_open.webp':'overlay/jar_closed.webp';
  img.classList.remove('pop'); void img.offsetWidth; img.classList.add('pop');
  blip(open?'pop':'flick'); $('jarWin').setAttribute('aria-pressed',String(open));
}
$('jarWin').addEventListener('click',()=>{ clearTimeout(jarAuto); const o=!jarOpen; jarSet(o);
  flash(o?'LUCKY PEANUTS · OPEN BEFORE CRITICAL EVENTS':'LID BACK ON · LUCK CONSERVED'); });
function percSet(on){
  clearTimeout(percT); clearTimeout(percBub);
  $('perkGlow').classList.toggle('on',on); $('steam').classList.toggle('on',on);
  if(on){ const b=()=>{ blip('blup'); percBub=setTimeout(b,180+Math.random()*420); }; b();
    percT=setTimeout(()=>percSet(false),12000); }
}
$('percBtn').addEventListener('click',()=>{ const on=!$('perkGlow').classList.contains('on'); percSet(on);
  flash(on?'PERCOLATING · TWELVE CUPS, ZERO GRAVITY':'PERCOLATOR OFF'); });
$('mugBtn').addEventListener('click',()=>{ const s=$('mugSteam'); s.classList.add('on');
  clearTimeout(s._t); s._t=setTimeout(()=>s.classList.remove('on'),4000); flash('NO BEVERAGES ON CONSOLE'); });
function driftStart(id){
  const el=$(id), d=DRIFT[id]; if(!el||el.dataset.adrift) return;
  const j=0.7+Math.random()*0.5;
  el.style.transition='transform 48s cubic-bezier(.25,.6,.35,1)';
  el.style.transform=`translate(calc(var(--s) * ${Math.round(d.dx*j)}px),calc(var(--s) * ${Math.round(d.dy*j)}px)) rotate(${(d.rot*j).toFixed(1)}deg)`;
  el.dataset.adrift='1';
}
function driftHome(id){
  const el=$(id), was=!!el.dataset.adrift;
  el.style.transition='transform .45s cubic-bezier(.2,.9,.3,1.2)'; el.style.transform='none'; delete el.dataset.adrift;
  if(was){ blip('rip'); if(!velcroNagged){ velcroNagged=true; flash('RESTRAIN ALL ITEMS'); } }
  clearTimeout(el._t); el._t=setTimeout(()=>driftStart(id),25000+Math.random()*20000);
}
['pencilItem','cardItem'].forEach(id=>$(id).addEventListener('click',()=>driftHome(id)));
// Space stays the global pause on every one of these, as on the transport keys.
['globusKnob','knobPrev','knobNext','cardWin','hereIs','pageWin','rbf1','rbf2','rbf3','jarWin','percBtn','mugBtn',
 'pencilItem','cardItem'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));

/* GUIDANCE. The DSKY works the way the Apollo one did -- VERB, two digits,
   NOUN, two digits, ENTR -- with its real lamp test (V35), its real alarm
   display (V05 N09), program change by V37, and a handful of nouns that
   read this deck instead of a spacecraft. The display is drawn as the
   machine's green electroluminescent seven-segment digits, unlit segments
   faintly visible as they were. Too many keys too fast is an executive
   overflow: PROG ALARM 1202. */
const DSKY_AMBER=new Set(['TEMP','GIMBAL LOCK','PROG','RESTART','TRACKER','ALT','VEL']);
const DS={prog:'00',verb:'',noun:'',r:['','',''],mode:null,await:null,monitor:null,flashVN:false,
  testUntil:0,compUntil:0,uplinkUntil:0,trackerUntil:0,restartUntil:0,oprErr:false,keyRel:false,
  progAlarm:false,lastAlarm:0,altvel:false,progLock:false,keys:[],last:0};
const SEG={'0':'abcdef','1':'bc','2':'abged','3':'abgcd','4':'fgbc','5':'afgcd','6':'afgedc','7':'abc',
  '8':'abcdefg','9':'abcdfg','-':'g','+':'g'};
function seg7(x,ch,px,py,w,h,on,off){
  const t=Math.max(1,w*0.18), g=t*0.35, hh=h/2;
  const S7={a:[px+g,py,w-2*g,t], d:[px+g,py+h-t,w-2*g,t], g:[px+g,py+hh-t/2,w-2*g,t],
    f:[px,py+g,t,hh-g*1.5], b:[px+w-t,py+g,t,hh-g*1.5], e:[px,py+hh+g*0.5,t,hh-g*1.5], c:[px+w-t,py+hh+g*0.5,t,hh-g*1.5]};
  const lit=SEG[ch]||'';
  for(const k in S7){ x.fillStyle=lit.includes(k)?on:off; const s=S7[k]; x.fillRect(s[0],s[1],s[2],s[3]); }
  if(ch==='+'){ x.fillStyle=on; x.fillRect(px+w/2-t/2,py+h*0.22,t,h*0.56); }
}
const fmt5=v=>(v<0?'-':'+')+String(Math.min(99999,Math.abs(Math.round(v)))).padStart(5,'0');
function monitorValues(n){
  const fr=F[i];
  if(n==='N36'){ const t=fr.t; return ['+000'+t.slice(11,13),'+000'+t.slice(14,16),'+0'+t.slice(17,19)+'00']; }
  if(n==='N50'){ const dn=fr.links.filter(l=>l.dir==='down'), sc=new Set(fr.links.map(l=>l.sc));
    const best=dn.length?Math.max(...dn.map(l=>l.p)):0;
    return [fmt5(dn.length),fmt5(sc.size),fmt5(best*10)]; }
  if(n==='N43'){ const c={}; fr.links.forEach(l=>{ c[l.st]=(c[l.st]||0)+1; });
    const st=Object.keys(c).sort((a,b)=>c[b]-c[a])[0], s=SITES[st];
    return s?[fmt5(s.lat*100),fmt5(s.lon*100),fmt5(c[st])]:['+00000','+00000','+00000']; }
  if(n==='N09') return [DS.lastAlarm?'+0'+DS.lastAlarm:'+00000','+00000','+00000'];
  return ['','',''];
}
function oprErr(){ DS.oprErr=true; DS.mode=null; DS.await=null; }
function alarm1202(){
  DS.progAlarm=true; DS.lastAlarm=1202; DS.verb='05'; DS.noun='09'; DS.flashVN=true; DS.monitor=null;
  DS.r=['+01202','+00000','+00000'];
  flash('PROG ALARM 1202 · EXECUTIVE OVERFLOW');
  setTimeout(()=>{ if(DS.progAlarm) flash("HOUSTON: WE'RE GO ON THAT ALARM"); },3200);
}
function dskyProgram(p){
  if(p==='00'){ DS.prog='00'; if(!liveMode) tapeEject(); return; }
  const k=+p;
  if(k>=1&&k<=8){ momentIndex().then(list=>{ const m=list[k-1]; if(!m) return oprErr(); DS.prog=p; tapeLoadId(m.id); }); return; }
  if(p==='63'){
    // Apollo 11's descent, in miniature: braking phase, the landing radar's
    // ALT and VEL lamps, and then the alarm everyone remembers.
    DS.prog='63'; DS.progLock=true; DS.altvel=true; flash('P63 · BRAKING PHASE'); checkSequence();
    setTimeout(alarm1202,3500);
    setTimeout(()=>{ DS.altvel=false; DS.progLock=false; },14000);
    return;
  }
  oprErr();
}
function dskyEnter(){
  if(DS.await==='prog'){ const p=(DS.noun||'').padStart(2,'0'); DS.await=null; DS.mode=null; dskyProgram(p); return; }
  const v=DS.verb, n=DS.noun; DS.mode=null; DS.keyRel=false;
  if(v==='35'){ DS.testUntil=performance.now()+5000; return; }
  if(v==='37'){ DS.await='prog'; DS.mode='noun'; DS.noun=''; return; }
  if(v==='34'){ DS.monitor=null; DS.r=['','','']; return; }
  if(['05','06','16'].includes(v)&&['09','36','43','50'].includes(n)){
    if(v==='16') DS.monitor='N'+n; else { DS.monitor=null; DS.r=monitorValues('N'+n); }
    return;
  }
  oprErr();
}
function dskyKey(k,btn){
  const now=performance.now();
  if(btn) pressFlash(btn); blip('key'); DS.compUntil=now+250;
  DS.keys=DS.keys.filter(t=>now-t<1500); DS.keys.push(now);
  if(DS.keys.length>=10&&!DS.progAlarm){ DS.keys=[]; alarm1202(); return; }
  if(/^[0-9]$/.test(k)){
    if(DS.mode==='verb'){ if(DS.verb.length>=2) return oprErr(); DS.verb+=k; }
    else if(DS.mode==='noun'){ if(DS.noun.length>=2) return oprErr(); DS.noun+=k; }
    else oprErr();
    return;
  }
  switch(k){
    case 'VERB': DS.mode='verb'; DS.verb=''; DS.flashVN=false; if(DS.monitor) DS.keyRel=true; break;
    case 'NOUN': DS.mode='noun'; DS.noun=''; DS.flashVN=false; break;
    case 'ENTR': dskyEnter(); break;
    case 'CLR':  if(DS.mode==='verb') DS.verb=''; else if(DS.mode==='noun') DS.noun=''; break;
    case 'RSET': DS.oprErr=false; DS.progAlarm=false; DS.flashVN=false; DS.testUntil=0; break;
    case 'PRO':  if(DS.progAlarm){ DS.progAlarm=false; DS.flashVN=false; flash('PROCEED'); } break;
    case 'KEYREL': DS.keyRel=false; break;
    default: oprErr();                                   // + and - with nothing to sign
  }
}
function dskyFrame(fr){
  const now=performance.now(); DS.compUntil=now+300;
  if(liveMode) DS.uplinkUntil=now+700;
  if(fr.acq&&fr.acq.length) DS.trackerUntil=now+4000;
  if(!DS.progLock&&!DS.await){
    if(liveMode||!MOMENT) DS.prog='00';
    else if(MOMENT.hour) DS.prog='80';
    else { const k=(MOMENT_INDEX||[]).findIndex(m=>m.id===MOMENT.id); DS.prog=k>=0?String(k+1).padStart(2,'0'):'80'; }
  }
}
function dskyDraw(){
  if(!GUIDE||!stripSeen.guidebezel) return;
  const now=performance.now(); if(now-DS.last<90) return; DS.last=now;
  const test=now<DS.testUntil, blink=Math.floor(now/400)%2===0;
  if(DS.monitor) DS.r=monitorValues(DS.monitor);
  const r=apRect('dskyDisp'), x=fitCanvas($('dskyCv'),r.w,r.h), W=r.w, H=r.h;
  x.fillStyle='#060906'; x.fillRect(0,0,W,H);
  const on='#5CFF8A', off='rgba(60,255,120,.07)', lab='rgba(92,255,138,.85)';
  const comp=test||now<DS.compUntil;
  x.fillStyle=comp?on:'rgba(60,255,120,.08)'; x.fillRect(W*0.02,H*0.07,W*0.15,H*0.36);
  x.fillStyle=comp?'#062010':'rgba(92,255,138,.22)'; x.font=`600 ${H*0.12}px "IBM Plex Mono",monospace`;
  x.textAlign='center'; x.textBaseline='middle'; x.fillText('COMP',W*0.095,H*0.18); x.fillText('ACTY',W*0.095,H*0.32);
  const dw=W*0.043, dh=H*0.26;
  const pair=(label,val,px,flashing)=>{
    x.fillStyle=lab; x.font=`600 ${H*0.1}px "IBM Plex Mono",monospace`; x.textAlign='left'; x.textBaseline='top';
    x.fillText(label,px,H*0.03);
    const v=test?'88':(flashing&&!blink?'  ':(val||'').padStart(2,' '));
    for(let k=0;k<2;k++) seg7(x,v[k]===' '?'':v[k],px+k*dw*1.3,H*0.17,dw,dh,on,off);
  };
  pair('PROG',DS.prog,W*0.22,false);
  pair('VERB',DS.verb,W*0.47,DS.mode==='verb'||DS.flashVN);
  pair('NOUN',DS.noun,W*0.72,DS.mode==='noun'||DS.flashVN);
  x.fillStyle='rgba(92,255,138,.35)'; x.fillRect(W*0.02,H*0.52,W*0.96,Math.max(1,H*0.012));
  const rw=W*0.041, rh=H*0.3;
  for(let n=0;n<3;n++){ const v=test?'+88888':(DS.r[n]||''), px0=W*0.02+n*W*0.33;
    for(let k=0;k<6;k++) seg7(x,v[k]||'',px0+k*rw*1.25,H*0.6,rw,rh,on,off); }
  const state={'UPLINK ACTY':now<DS.uplinkUntil,
    'TEMP':!!($('perkGlow')&&$('perkGlow').classList.contains('on')),      // the percolator, obviously
    'GIMBAL LOCK':Math.abs(pitch)>=79, 'STBY':!AC, 'PROG':DS.progAlarm, 'KEY REL':DS.keyRel,
    'RESTART':now<DS.restartUntil, 'OPR ERR':DS.oprErr, 'TRACKER':now<DS.trackerUntil,
    'ALT':DS.altvel&&blink, 'VEL':DS.altvel&&!blink};
  [...$('dskyLamps').children].forEach(d=>d.classList.toggle('on',test||!!state[d.dataset.n]));
}
// The reference card clipped beside it, typed like everything else.
function drawRef(){
  if(!GUIDE) return;
  const r=apRect('refCard'), x=fitCanvas($('refCv'),r.w,r.h), W=r.w, H=r.h; x.clearRect(0,0,W,H);
  const fs=Math.max(5.5,H/10.8), lp=H/9.4, ink='rgba(30,28,40,A)';
  ['V35 E        LAMP TEST','V16 N36 E    TIME H M S','V16 N50 E    NETWORK','V06 N43 E    BUSIEST DSN',
   'V37 E 00 E   P00 LIVE','V37 E 01-08 E  TAPES','V37 E 63 E   LANDING','V05 N09 E    ALARMS']
    .forEach((s,k)=>typeLine(x,s,W*0.07,H*0.17+k*lp,fs,ink));
}
/* The rotational hand controller commands a RATE, as the real one did: the
   star map keeps turning while the stick is off centre and stops when it is
   let go. The window can be scrolled out of view, so a scope beside the
   stick shows it while you fly. */
const RHC={held:false,rx:0,ry:0,sx:0,sy:0,last:performance.now(),scopeUntil:0};
function guideInit(){
  watchStrip('guidebezel');
  const L=$('dskyLamps');
  if(!L.children.length) (GUIDE._lamps||[]).forEach(nm=>{ const d=document.createElement('div');
    d.className='dlamp'+(DSKY_AMBER.has(nm)?' amber':''); d.dataset.n=nm; L.appendChild(d); });
  const K=$('dskyKeys');
  if(!K.children.length) Object.keys(GUIDE.apertures).filter(k=>k.startsWith('key_')).forEach(ak=>{
    const nm=ak.slice(4), b=document.createElement('button'), label=nm==='KEYREL'?'KEY REL':nm;
    b.className='dkey'+(nm==='VERB'||nm==='NOUN'?' relabel':''); b.dataset.ap=ak;
    if(nm==='VERB'||nm==='NOUN') b.textContent=nm;
    b.title='DSKY '+label; b.setAttribute('aria-label','DSKY '+label);
    b.addEventListener('click',()=>dskyKey(nm,b));
    b.addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); });
    K.appendChild(b);
  });
  DS.restartUntil=performance.now()+3000;
  layoutGuide(); stripsKey='';
}
function layoutGuide(){
  if(!GUIDE) return;
  placeBox($('dskyCv'),apRect('dskyDisp')); DS.last=0;
  [...$('dskyLamps').children].forEach((d,k)=>placeBox(d,apRect('lamp'+k)));
  [...$('dskyKeys').children].forEach(b=>{ const r=apRect(b.dataset.ap); placeBox(b,r);
    b.style.fontSize=Math.max(6,r.h*0.27)+'px'; });
  placeBox($('refCv'),apRect('refCard')); drawRef();
  const s=coverRect().s, hole=apRect('rhcHole'), h=150*s, w=h*258/883;
  placeBox($('rhcGrip'),{x:hole.x+hole.w/2-w/2, y:hole.y+hole.h/2+10*s-h, w, h});
  const ar=apRect('rhcArea'), sz=190*s;
  placeBox($('rhcScope'),{x:ar.x-sz-12*s, y:ar.y+ar.h/2-sz/2, w:sz, h:sz});
}
function rhcPose(){
  $('rhcGrip').style.transform=`rotate(${(RHC.rx*16).toFixed(1)}deg) scaleY(${(1-Math.abs(RHC.ry)*0.14).toFixed(3)})`;
}
function rhcTick(now){
  const dt=Math.min(0.1,(now-RHC.last)/1000); RHC.last=now;
  if(!GUIDE) return;
  // In RATE mode the stick commands body rates and deck_ship.js integrates them;
  // in ATT mode it moves the sky directly, the way it always did.
  const rateCmd=(typeof shipRateMode==='function'&&shipRateMode());
  if(RHC.held&&!attHold&&!rateCmd){ yaw+=RHC.rx*55*dt; pitch=Math.max(-80,Math.min(80,pitch-RHC.ry*40*dt)); }
  const sc=$('rhcScope');
  if(RHC.held||now<RHC.scopeUntil) drawRhcScope();
  else if(sc.classList.contains('on')) sc.classList.remove('on');
}
function drawRhcScope(){
  const cv=$('rhcScope'), sz=parseFloat(cv.style.width)||100, x=fitCanvas(cv,sz,sz), c=sz/2;
  cv.classList.add('on');
  x.fillStyle='#000'; x.fillRect(0,0,sz,sz);
  if(AP&&!expanded){
    const w=apRect('window'), d=devicePixelRatio||1, side=Math.min(w.w,w.h)*0.9;
    x.save(); x.beginPath(); x.arc(c,c,c,0,Math.PI*2); x.clip();
    x.drawImage(sky,(w.x+w.w/2-side/2)*d,(w.y+w.h/2-side/2)*d,side*d,side*d,0,0,sz,sz); x.restore();
  }
  x.strokeStyle='rgba(92,255,138,.55)'; x.lineWidth=1;
  x.beginPath(); x.arc(c,c,c*0.62,0,Math.PI*2); x.moveTo(c-c*0.2,c); x.lineTo(c+c*0.2,c); x.moveTo(c,c-c*0.2); x.lineTo(c,c+c*0.2); x.stroke();
  x.fillStyle='rgba(92,255,138,.9)'; x.font=`600 ${Math.max(7,sz*0.07)}px "IBM Plex Mono",monospace`; x.textAlign='center';
  x.textBaseline='top'; x.fillText('ATT',c,sz*0.07);
  x.textBaseline='bottom'; x.fillText('Y '+Math.round(((yaw%360)+360)%360)+'  P '+Math.round(pitch),c,sz*0.94);
}
{
  const g=$('rhcGrip');
  g.addEventListener('pointerdown',e=>{ e.preventDefault(); try{ g.setPointerCapture(e.pointerId); }catch(_){}
    RHC.held=true; RHC.sx=e.clientX; RHC.sy=e.clientY; g.classList.add('held'); blip('flick'); });
  g.addEventListener('pointermove',e=>{ if(!RHC.held) return;
    RHC.rx=Math.max(-1,Math.min(1,(e.clientX-RHC.sx)/60)); RHC.ry=Math.max(-1,Math.min(1,(e.clientY-RHC.sy)/60)); rhcPose(); });
  const rel=()=>{ if(!RHC.held) return; RHC.held=false; RHC.rx=RHC.ry=0; g.classList.remove('held'); rhcPose();
    RHC.scopeUntil=performance.now()+900; };
  ['pointerup','pointercancel','lostpointercapture'].forEach(ev=>g.addEventListener(ev,rel));
  g.addEventListener('keydown',e=>{ const k={ArrowLeft:[-4,0],ArrowRight:[4,0],ArrowUp:[0,4],ArrowDown:[0,-4]}[e.key];
    if(e.key===' ') e.preventDefault();
    if(!k) return; e.preventDefault(); yaw+=k[0]; pitch=Math.max(-80,Math.min(80,pitch+k[1]));
    RHC.scopeUntil=performance.now()+900; });
}

/* TAPE LIBRARY. Every recorded hour as a canister on the shelf, sixteen at
   a time (the art has sixteen); the spines are the strip's own pixels, lifted
   out as buttons so a canister can be drawn off the shelf. The hour playing
   now stands proud of the others. */
const LIB={page:-1,pages:1,per:16};
function libInit(){
  watchStrip('librarybezel');
  const sh=$('libShelf');
  if(!sh.children.length) for(let k=0;k<LIB.per;k++){
    const b=document.createElement('button'); b.className='spine'; b.innerHTML='<span class="slab"></span>';
    b.addEventListener('click',()=>libPull(k)); b.addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); });
    sh.appendChild(b);
  }
  layoutLibrary(); tmIndex().then(()=>libFill(true));
}
function layoutLibrary(){
  if(!LIBRARY) return;
  const s=coverRect().s, st=STRIPS.find(z=>z.img==='librarybezel'), top=((st&&st.top)||0)*s, lb=LIBRARY._label||[0.14,0.16,0.73,0.35];
  const dw=apRect('dateWin'); placeBox($('libDate'),dw); $('libDate').style.fontSize=Math.max(7,dw.h*0.32)+'px';
  placeBox($('libPrev'),apRect('prevDay')); placeBox($('libNext'),apRect('nextDay'));
  [...$('libShelf').children].forEach((b,k)=>{
    const r=apRect('spine'+k); if(!r) return; placeBox(b,r);
    b.style.backgroundImage='url(overlay/library_overlay.webp)';
    b.style.backgroundSize=(2560*s)+'px '+(400*s)+'px';
    b.style.backgroundPosition=(-r.x)+'px '+(-(r.y-top))+'px';
    const l=b.firstChild; l.style.left=(lb[0]*100)+'%'; l.style.top=(lb[1]*100)+'%';
    l.style.width=(lb[2]*100)+'%'; l.style.height=(lb[3]*100)+'%'; l.style.fontSize=Math.max(6,r.w*0.2)+'px';
  });
}
function libFill(initial){
  // Shelves are counted back from the newest hour, so the shelf you land on
  // is full and any short shelf is the oldest one.
  const hrs=(TM&&TM.hours)||[], per=LIB.per, n=hrs.length; LIB.pages=Math.max(1,Math.ceil(n/per));
  if(initial||LIB.page<0){ const cur=MOMENT&&MOMENT.id, at=cur?hrs.findIndex(h=>h.id===cur):-1;
    LIB.page=at>=0?LIB.pages-1-Math.floor((n-1-at)/per):LIB.pages-1; }
  LIB.page=Math.max(0,Math.min(LIB.pages-1,LIB.page));
  const end=n-(LIB.pages-1-LIB.page)*per, sl=hrs.slice(Math.max(0,end-per),end);
  [...$('libShelf').children].forEach((b,k)=>{
    const h=sl[k], l=b.firstChild; b.dataset.id=h?h.id:''; b.classList.toggle('empty',!h);
    if(h){ const t=h.t;
      l.innerHTML=`<span>${t.slice(5,7)}·${t.slice(8,10)}</span><b>${t.slice(11,13)}Z</b>`;
      b.title=hourTitle(t)+' · '+h.peak+' downlinks at peak · '+h.craft.length+' spacecraft'
        +(h.acq.length?' · '+h.acq.length+' acquired':'')+(h.lost.length?' · '+h.lost.length+' lost':'');
      b.setAttribute('aria-label','Load '+hourTitle(t)); b.tabIndex=0; }
    else { l.innerHTML='<b>--</b>'; b.title=''; b.removeAttribute('aria-label'); b.tabIndex=-1; }
  });
  if(sl.length){ const a=sl[0].t, z=sl[sl.length-1].t;
    $('libDate').innerHTML=`<b>${a.slice(5,10)}</b><span>${a.slice(11,13)}Z – ${z.slice(5,10)!==a.slice(5,10)?z.slice(8,10)+'/':''}${z.slice(11,13)}Z</span>`; }
  else $('libDate').innerHTML='<b>-- --</b>';
  libMark();
}
function libMark(){
  const cur=MOMENT&&MOMENT.id;
  [...$('libShelf').children].forEach(b=>b.classList.toggle('loaded',!!cur&&b.dataset.id===cur));
}
function libPull(k){
  const b=$('libShelf').children[k], id=b&&b.dataset.id; if(!id) return;
  b.classList.add('out'); blip('flick'); setTimeout(()=>b.classList.remove('out'),600);
  tapeLoadId(id);
}
function libStep(d){
  const p=LIB.page+d;
  if(p<0||p>=LIB.pages){ flash(d<0?'START OF THE ARCHIVE':'END OF THE ARCHIVE'); return; }
  LIB.page=p; libFill(false); blip('flick');
}
$('libPrev').addEventListener('click',()=>{ pressFlash($('libPrev')); libStep(-1); });
$('libNext').addEventListener('click',()=>{ pressFlash($('libNext')); libStep(1); });
['libPrev','libNext'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));

/* FLIGHT DIRECTOR & STATION TIME. The attitude ball is the Apollo FDAI
   "8-ball": sky above the horizon, ground below, pitch circles and heading
   meridians, rolled by the star map's own heading and pitch -- so flying
   the hand controller beside it turns the ball as it turns the sky. The
   three clocks keep each complex's real local time (for the time of
   whatever is playing), drawn as white-on-black aviation dials, and each
   lamp lights while its complex has a spacecraft. */
const CLK=[['gdscc','clockG','fLampG','America/Los_Angeles','#FFB347','GDS'],
           ['mdscc','clockM','fLampM','Europe/Madrid','#6CFF8E','MAD'],
           ['cdscc','clockC','fLampC','Australia/Sydney','#FF5A3C','CAN']];     // Canberra keeps Sydney time
const CLK_FMT=CLK.map(c=>new Intl.DateTimeFormat('en-GB',{timeZone:c[3],hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));
let fdaiLast=0, fdaiKey='', clkFrameAt=performance.now(), abortT=null;
function fdaiInit(){ watchStrip('fdaibezel'); CLK.forEach(c=>$(c[2]).style.setProperty('--lc',c[4])); layoutFdai(); stripsKey=''; }
function layoutFdai(){
  if(!FDAI) return;
  placeBox($('fdaiCv'),apRect('fdai')); fdaiKey=''; fdaiLast=0;
  CLK.forEach(([,cv,lp])=>{ placeBox($(cv),apRect(cv)); placeBox($(lp),apRect(lp)); });
  placeBox($('abortBtn'),apRect('abortBtn')); placeBox($('abortGuard'),apRect('abortGuard'));
}
function clockParts(k,ms){
  const p=CLK_FMT[k].formatToParts(new Date(ms)), g=t=>+((p.find(x=>x.type===t)||{}).value||0);
  return [g('hour'),g('minute'),g('second')];
}
function fdaiFrame(fr){
  clkFrameAt=performance.now();
  const act={}; fr.links.forEach(l=>{ (act[l.st]=act[l.st]||new Set()).add(l.sc); });
  const ms=Date.parse(fr.t)||Date.now();
  CLK.forEach(([st,,lp],k)=>{ const n=act[st]?act[st].size:0, [h,m]=clockParts(k,ms), el=$(lp);
    el.classList.toggle('lit',n>0);
    el.title=((SITES[st]||{}).name||st).toUpperCase()+' · '+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')
      +' LOCAL · '+(n?n+' SPACECRAFT':'NOT TRACKING'); });
}
// The frame's time, running on between frames so the second hands sweep.
function clockTime(){ const base=Date.parse(F[i].t)||Date.now();
  return base+windHours*3600000+Math.min(liveMode?10000:step,performance.now()-clkFrameAt); }
function fdaiDraw(){
  if(!FDAI||!stripSeen.fdaibezel) return;
  const now=performance.now(); if(now-fdaiLast<100) return; fdaiLast=now;
  const key=yaw.toFixed(1)+'|'+pitch.toFixed(1);
  if(key!==fdaiKey){ fdaiKey=key; drawBall(); }
  const ms=clockTime();
  CLK.forEach((c,k)=>drawClock(k,ms));
}
function drawBall(){
  const r=apRect('fdai'), cv=$('fdaiCv'), d=devicePixelRatio||1;
  const W=Math.max(8,Math.round(r.w*d)), H=Math.max(8,Math.round(r.h*d));
  if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; }
  const x=cv.getContext('2d'); x.setTransform(1,0,0,1,0,0);
  const R=Math.floor(Math.min(W,H)*0.45), cx=Math.round(W/2), cy=Math.round(H/2), TWO=Math.PI*2;
  const p=pitch*Math.PI/180, hd=yaw*Math.PI/180, cp=Math.cos(p), sp=Math.sin(p);
  const img=x.createImageData(W,H), buf=new Uint32Array(img.data.buffer); buf.fill(0xFF070605);
  for(let py=-R;py<=R;py++) for(let px=-R;px<=R;px++){
    const nx=px/R, ny=-py/R, rr=nx*nx+ny*ny; if(rr>1) continue;
    const nz=Math.sqrt(1-rr), s=0.5+0.5*Math.pow(nz,0.6), sky=ny*cp+nz*sp>0;
    const rC=(sky?214:48)*s|0, gC=(sky?208:43)*s|0, bC=(sky?194:38)*s|0;
    buf[(cy+py)*W+(cx+px)]=(0xFF000000|(bC<<16)|(gC<<8)|rC)>>>0;
  }
  x.putImageData(img,0,0);
  // world point -> view: heading about the vertical, then pitch about the horizontal
  const ch=Math.cos(-hd), shd=Math.sin(-hd);
  const proj=(lat,lon)=>{ const la=lat*Math.PI/180, lo=lon*Math.PI/180;
    const wx=Math.cos(la)*Math.sin(lo), wy=Math.sin(la), wz=Math.cos(la)*Math.cos(lo);
    const x1=wx*ch+wz*shd, z1=-wx*shd+wz*ch;
    return [cx+R*x1, cy-R*(wy*cp-z1*sp), wy*sp+z1*cp]; };
  const path=(pts,col,wd)=>{ x.strokeStyle=col; x.lineWidth=wd; x.beginPath(); let on=false;
    pts.forEach(q=>{ if(q[2]<=0.02){ on=false; return; } if(on) x.lineTo(q[0],q[1]); else { x.moveTo(q[0],q[1]); on=true; } });
    x.stroke(); };
  x.save(); x.beginPath(); x.arc(cx,cy,R,0,TWO); x.clip();
  for(const la of [-60,-30,30,60]){ const pts=[]; for(let lo=0;lo<=360;lo+=5) pts.push(proj(la,lo));
    path(pts,la>0?'rgba(40,36,32,.55)':'rgba(222,216,202,.45)',Math.max(1,d*0.8)); }
  { const pts=[]; for(let lo=0;lo<=360;lo+=4) pts.push(proj(0,lo)); path(pts,'rgba(20,18,16,.9)',Math.max(1.5,d*1.4)); }
  for(let lo=0;lo<360;lo+=30){ const pts=[]; for(let la=-84;la<=84;la+=4) pts.push(proj(la,lo));
    path(pts,'rgba(120,112,100,.55)',Math.max(1,d*0.7)); }
  x.font=`600 ${Math.max(7,R*0.13)}px "IBM Plex Mono",monospace`; x.textAlign='center'; x.textBaseline='middle';
  for(let lo=0;lo<360;lo+=30){ const q=proj(7,lo); if(q[2]>0.25){ x.fillStyle='rgba(30,27,24,.85)'; x.fillText(String(lo/10),q[0],q[1]); } }
  const hdDeg=((yaw%360)+360)%360;
  for(const la of [-60,-30,30,60]){ const q=proj(la,hdDeg); if(q[2]>0.25){ x.fillStyle=la>0?'rgba(30,27,24,.85)':'rgba(232,226,212,.8)';
    x.fillText(String(Math.abs(la)),q[0]+R*0.13,q[1]); } }
  x.restore();
  // the fixed aircraft symbol, then the glass
  x.strokeStyle='#FF9A3D'; x.lineWidth=Math.max(2,d*2.2); x.lineCap='round';
  x.beginPath(); x.moveTo(cx-R*0.55,cy); x.lineTo(cx-R*0.18,cy); x.lineTo(cx-R*0.08,cy+R*0.1);
  x.moveTo(cx+R*0.55,cy); x.lineTo(cx+R*0.18,cy); x.lineTo(cx+R*0.08,cy+R*0.1); x.stroke();
  x.fillStyle='#FF9A3D'; x.beginPath(); x.arc(cx,cy,Math.max(2,R*0.035),0,TWO); x.fill();
  const gl=x.createRadialGradient(cx-R*0.4,cy-R*0.45,R*0.05,cx-R*0.25,cy-R*0.3,R*1.1);
  gl.addColorStop(0,'rgba(255,250,235,.22)'); gl.addColorStop(0.4,'rgba(255,250,235,.04)'); gl.addColorStop(1,'rgba(255,250,235,0)');
  x.fillStyle=gl; x.beginPath(); x.arc(cx,cy,R,0,TWO); x.fill();
  const rim=x.createRadialGradient(cx,cy,R*0.82,cx,cy,R*1.02); rim.addColorStop(0,'rgba(0,0,0,0)'); rim.addColorStop(1,'rgba(0,0,0,.6)');
  x.fillStyle=rim; x.beginPath(); x.arc(cx,cy,R*1.02,0,TWO); x.fill();
}
function drawClock(k,ms){
  const c=CLK[k], r=apRect(c[1]), x=fitCanvas($(c[1]),r.w,r.h), W=r.w, H=r.h, TWO=Math.PI*2;
  const R=Math.min(W,H)*0.47, cx=W/2, cy=H/2;
  x.clearRect(0,0,W,H); x.fillStyle='#0b0a09'; x.beginPath(); x.arc(cx,cy,R,0,TWO); x.fill();
  for(let t=0;t<60;t++){ const a=t/60*TWO, big=t%5===0, r0=R*(big?0.8:0.87), r1=R*0.93;
    x.strokeStyle=big?'rgba(236,230,214,.9)':'rgba(236,230,214,.42)'; x.lineWidth=big?Math.max(1,R*0.035):Math.max(.6,R*0.014);
    x.beginPath(); x.moveTo(cx+Math.sin(a)*r0,cy-Math.cos(a)*r0); x.lineTo(cx+Math.sin(a)*r1,cy-Math.cos(a)*r1); x.stroke(); }
  x.fillStyle='rgba(236,230,214,.92)'; x.textAlign='center'; x.textBaseline='middle';
  x.font=`600 ${R*0.2}px "Barlow Condensed","Arial Narrow",sans-serif`;
  for(let h=1;h<=12;h++){ const a=h/12*TWO; x.fillText(String(h),cx+Math.sin(a)*R*0.64,cy-Math.cos(a)*R*0.64); }
  const [hh,mm,s0]=clockParts(k,ms), ss=s0+(ms%1000)/1000;
  x.font=`600 ${R*0.11}px "IBM Plex Mono",monospace`; x.fillStyle='rgba(236,230,214,.5)';
  x.fillText(c[5],cx,cy-R*0.34); x.fillText(hh<12?'AM':'PM',cx,cy+R*0.36);
  const hand=(a,len,wd,col,tail)=>{ x.strokeStyle=col; x.lineWidth=wd; x.lineCap='round'; x.beginPath();
    x.moveTo(cx-Math.sin(a)*R*tail,cy+Math.cos(a)*R*tail); x.lineTo(cx+Math.sin(a)*R*len,cy-Math.cos(a)*R*len); x.stroke(); };
  hand(((hh%12)+mm/60)/12*TWO,0.5,Math.max(2,R*0.07),'rgba(236,230,214,.95)',0.1);
  hand((mm+ss/60)/60*TWO,0.76,Math.max(1.5,R*0.05),'rgba(236,230,214,.95)',0.12);
  hand(ss/60*TWO,0.82,Math.max(1,R*0.018),'#FF7A3D',0.18);
  x.fillStyle='#FF7A3D'; x.beginPath(); x.arc(cx,cy,Math.max(1.5,R*0.045),0,TWO); x.fill();
  const gl=x.createRadialGradient(cx-R*0.4,cy-R*0.45,R*0.05,cx-R*0.25,cy-R*0.3,R*1.05);
  gl.addColorStop(0,'rgba(255,250,235,.16)'); gl.addColorStop(0.4,'rgba(255,250,235,.03)'); gl.addColorStop(1,'rgba(255,250,235,0)');
  x.fillStyle=gl; x.beginPath(); x.arc(cx,cy,R,0,TWO); x.fill();
}
// ABORT: the lunar module's abort buttons sat under guards. Lift this one
// first; press it and the klaxon goes, and nothing else happens.
function guardSet(open){
  const g=$('abortGuard'); if(g.classList.contains('open')===open) return;
  g.classList.toggle('open',open); g.setAttribute('aria-expanded',String(open));
  g.setAttribute('aria-label',open?'Close the ABORT guard':'Lift the ABORT guard');
  blip(open?'flick':'cr'); clearTimeout(abortT);
  if(open) abortT=setTimeout(()=>guardSet(false),10000);            // spring-loaded: it closes itself
}
$('abortGuard').addEventListener('click',()=>{
  if(!$('abortGuard').classList.contains('open')&&!abortReady()){
    blip('cr');
    flash('SAFED · CLEAR THE THREE FLAGS AND ARM BOTH SWITCHES ON COMMS');
    return;
  }
  guardSet(!$('abortGuard').classList.contains('open'));
});
$('abortBtn').addEventListener('click',()=>{
  if(!$('abortGuard').classList.contains('open')) return;
  const b=$('abortBtn'); b.classList.add('lit'); blip('klaxon'); flash('ABORT INHIBITED · NICE TRY');
  clearTimeout(b._t); b._t=setTimeout(()=>b.classList.remove('lit'),1800);
  clearTimeout(abortT); abortT=setTimeout(()=>guardSet(false),4000);
});
['abortGuard','abortBtn'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));

/* PROGRAM LOAD & ENVIRONMENT. The harmony is software, so it loads the way
   software did: from a deck of punched cards. Lyadov's deck and
   Arkhangelsky's stand on the ledge and the one in use sits in the stacker.
   Click the other and it drops into the hopper, the reader clatters through
   it, and the choir changes books -- through applyCorpus, the same switch as
   the Music panel, so the two always agree. The gauges read the cabin:
   pressure near 5 psi (what the Apollo cabin ran at), a temperature the
   galley and percolator push up, CO2 rising with the number of voices
   singing (red above 7.6 mm Hg, the Apollo caution level), and O2 flow
   surging on each acquisition. */
const RD_DECKS={lyadov:['deckL','slot1','LYADOV','OP.61 · 1910'], arkhangelsky:['deckA','slot2','ARKHANGELSKY','VOL.1 · 1892']};
// gaugeT reads Celsius over the range the cabin can actually reach: the ship
// systems drive it from -20 to +45, and the old 40-100 F scale pegged the
// needle at its bottom stop the moment the cabin went cold.
const GAUGES=[['gaugeP','PSIA',0,8,[0,2,4,6,8],null],['gaugeT','°C',-20,45,[-20,0,20,45],null],
              ['gaugeC','MM HG',0,15,[0,5,10,15],7.6],['gaugeO','LB/HR',0,1,[0,0.5,1],null]];
let rdBusy=false, rdFeed=0, rdClatter=null, rdLast=0, rdVoices=0, o2Spike=0, feedIdle=false;
const gVal=[5,21,3,0.32];
function readerInit(){
  watchStrip('readerbezel');
  Object.entries(RD_DECKS).forEach(([k,[id]])=>{ const el=$(id);
    if(!el._wired){ el._wired=true; el.addEventListener('click',()=>readerLoad(k));
      el.addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }); } });
  layoutReader();
}
function layoutReader(){
  if(!READER) return;
  placeBox($('feedCv'),apRect('feed')); feedIdle=false; rdLast=0;
  GAUGES.forEach(g=>placeBox($(g[0]),apRect(g[0])));
  ['rdStart','rdStop','rdReset','rdLamp'].forEach(id=>placeBox($(id),apRect(id)));
  const lb=READER._deckLabel||[0.04,0.205,0.81,0.125];
  Object.values(RD_DECKS).forEach(([id,,a,b])=>{ const l=$(id).querySelector('.dlab');
    l.style.left=lb[0]*100+'%'; l.style.top=lb[1]*100+'%'; l.style.width=lb[2]*100+'%'; l.style.height=lb[3]*100+'%';
    l.innerHTML=`<b>${a}</b><i>${b}</i>`; });
  readerSync(true);
}
function readerSync(force){
  if(!READER||(rdBusy&&!force)) return;
  Object.entries(RD_DECKS).forEach(([k,[id,slot]])=>{ const el=$(id), on=k===corpusKey;
    placeBox(el,apRect(on?'inStacker':slot)); el.classList.toggle('loaded',on);
    el.setAttribute('aria-label',(on?'Loaded: ':'Load ')+el.dataset.name);
    el.title=on?'In the reader: '+el.dataset.name:'Load '+el.dataset.name; });
}
function readerRun(done){
  rdFeed=performance.now(); $('rdLamp').classList.add('lit'); clearInterval(rdClatter);
  rdClatter=setInterval(()=>blip('tick',1.8),45);
  setTimeout(()=>{ clearInterval(rdClatter); rdClatter=null; rdFeed=0; $('rdLamp').classList.remove('lit'); if(done) done(); },1600);
}
function readerLoad(k){
  const tr=(D.tracks||{})[k]; if(!READER||rdBusy||!tr) return;
  const name=String(tr.label||k).toUpperCase();
  if(k===corpusKey){ rdBusy=true; readerRun(()=>{ rdBusy=false; }); flash('READING · '+name); return; }
  rdBusy=true;
  const dk=$(RD_DECKS[k][0]), old=$(RD_DECKS[corpusKey][0]);
  [dk,old].forEach(e=>e.classList.add('moving'));
  placeBox(dk,apRect('inHopper')); placeBox(old,apRect(RD_DECKS[corpusKey][1])); old.classList.remove('loaded');
  blip('flick');
  setTimeout(()=>readerRun(()=>{
    applyCorpus(k); placeBox(dk,apRect('inStacker')); dk.classList.add('loaded'); blip('cr');
    flash('PROGRAM LOAD · '+name);
    setTimeout(()=>{ [dk,old].forEach(e=>e.classList.remove('moving')); rdBusy=false; readerSync(); },650);
  }),650);
}
$('rdStart').addEventListener('click',()=>{ pressFlash($('rdStart')); readerLoad(corpusKey); });
$('rdStop').addEventListener('click',()=>{ pressFlash($('rdStop')); flash(rdBusy?'CARDS IN THE FEED · CANNOT STOP':'READER IDLE'); });
$('rdReset').addEventListener('click',()=>{ pressFlash($('rdReset')); if(!rdBusy) flash('READER RESET'); });
['rdStart','rdStop','rdReset'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));
function readerFrame(fr){
  rdVoices=PARTS.filter(([p])=>fr.notes[p]!=null).length;
  if(fr.acq&&fr.acq.length) o2Spike=0.38;
}
function drawFeed(now){
  const r=apRect('feed'), x=fitCanvas($('feedCv'),r.w,r.h), W=r.w, H=r.h;
  x.fillStyle='#070605'; x.fillRect(0,0,W,H);
  if(!rdFeed){ feedIdle=true; x.fillStyle='rgba(217,196,154,.07)'; x.fillRect(0,H*0.42,W,H*0.16); return; }
  feedIdle=false;
  const cw=W*0.42, off=((now-rdFeed)/1000*W*3.2)%(cw*1.02);
  for(let k=-1;k<4;k++){
    const cx=-cw+off+k*cw*1.02; x.fillStyle='#D9C49A'; x.fillRect(cx,H*0.16,cw*0.96,H*0.68);
    x.fillStyle='rgba(40,30,20,.75)';
    for(let c=0;c<24;c++) for(let q=0;q<4;q++) if((c*7+q*3+k*11)%5===0) x.fillRect(cx+cw*0.05+c*cw*0.037,H*0.24+q*H*0.13,cw*0.018,H*0.07);
  }
  const g=x.createLinearGradient(0,0,W,0);
  g.addColorStop(0,'rgba(7,6,5,.85)'); g.addColorStop(.12,'rgba(7,6,5,0)'); g.addColorStop(.88,'rgba(7,6,5,0)'); g.addColorStop(1,'rgba(7,6,5,.85)');
  x.fillStyle=g; x.fillRect(0,0,W,H);
}
function drawGauge(g,v){
  const [id,unit,lo,hi,marks,red]=g, r=apRect(id), x=fitCanvas($(id),r.w,r.h), W=r.w, H=r.h, TWO=Math.PI*2;
  const R=Math.min(W,H)*0.46, cx=W/2, cy=H/2, a0=-0.75*Math.PI, span=1.5*Math.PI;
  const ang=val=>a0+span*Math.max(0,Math.min(1,(val-lo)/(hi-lo)));
  const pt=(a,rad)=>[cx+Math.sin(a)*rad,cy-Math.cos(a)*rad];
  x.clearRect(0,0,W,H); x.fillStyle='#0b0a09'; x.beginPath(); x.arc(cx,cy,R,0,TWO); x.fill();
  if(red!=null){ x.strokeStyle='rgba(220,50,40,.85)'; x.lineWidth=Math.max(2,R*0.07); x.beginPath();
    x.arc(cx,cy,R*0.84,ang(red)-Math.PI/2,ang(hi)-Math.PI/2); x.stroke(); }
  for(let k=0;k<=20;k++){ const a=a0+span*k/20, big=k%5===0, [x0,y0]=pt(a,R*(big?0.72:0.79)), [x1,y1]=pt(a,R*0.88);
    x.strokeStyle=big?'rgba(236,230,214,.9)':'rgba(236,230,214,.4)'; x.lineWidth=big?Math.max(1,R*0.03):Math.max(.6,R*0.014);
    x.beginPath(); x.moveTo(x0,y0); x.lineTo(x1,y1); x.stroke(); }
  x.fillStyle='rgba(236,230,214,.9)'; x.textAlign='center'; x.textBaseline='middle';
  x.font=`600 ${R*0.17}px "Barlow Condensed","Arial Narrow",sans-serif`;
  marks.forEach(m=>{ const [tx,ty]=pt(ang(m),R*0.55); x.fillText(String(m),tx,ty); });
  x.font=`600 ${R*0.12}px "IBM Plex Mono",monospace`; x.fillStyle='rgba(236,230,214,.5)'; x.fillText(unit,cx,cy+R*0.45);
  const a=ang(v), [tx,ty]=pt(a,R*0.8), [bx,by]=pt(a+Math.PI,R*0.15);
  x.strokeStyle='rgba(236,230,214,.95)'; x.lineWidth=Math.max(1.5,R*0.04); x.lineCap='round';
  x.beginPath(); x.moveTo(bx,by); x.lineTo(tx,ty); x.stroke();
  const [ox,oy]=pt(a,R*0.62); x.strokeStyle='#FF7A3D'; x.beginPath(); x.moveTo(ox,oy); x.lineTo(tx,ty); x.stroke();
  x.fillStyle='#2a2724'; x.beginPath(); x.arc(cx,cy,Math.max(2,R*0.08),0,TWO); x.fill();
  const gl=x.createRadialGradient(cx-R*0.4,cy-R*0.45,R*0.05,cx-R*0.25,cy-R*0.3,R*1.05);
  gl.addColorStop(0,'rgba(255,250,235,.16)'); gl.addColorStop(0.4,'rgba(255,250,235,.03)'); gl.addColorStop(1,'rgba(255,250,235,0)');
  x.fillStyle=gl; x.beginPath(); x.arc(cx,cy,R,0,TWO); x.fill();
}
function readerDraw(now){
  if(!READER||!stripSeen.readerbezel) return;
  if(rdFeed||!feedIdle) drawFeed(now);
  if(now-rdLast<100) return; rdLast=now;
  const t=now/1000, on=id=>$(id).classList.contains('on'), heat=(on('galMw')?7:0)+(on('perkGlow')?4:0);
  o2Spike*=0.97;
  const tgt=[5.0+Math.sin(t*0.7)*0.04+Math.sin(t*2.3)*0.02, 71.5+heat+Math.sin(t*0.11)*0.8,
             1.6+rdVoices*0.95+Math.sin(t*0.9)*0.15, 0.32+Math.sin(t*0.37)*0.04+o2Spike];
  gVal.forEach((v,k)=>{ gVal[k]=v+(tgt[k]-v)*(k===1?0.03:0.12); });   // temperature creeps; the rest respond
  GAUGES.forEach((g,k)=>drawGauge(g,gVal[k]));
}

/* ARCHIVE & ARTIFACTS. A carousel slide projector holds a slide for every
   spacecraft, in the card file's order, and the three DSN dishes: the
   photographs the dossiers already carry, credited on the slide, and a blue
   title card where there is none, as presentations of the day did. It turns
   to a craft when that craft is acquired. Beside it, the Voyager Golden
   Record: click it to turn it at 16 2/3 rpm, the speed it plays at. The
   disc turns under a fixed sheen, so the reflection stays put while the
   grooves go round, as on a real turntable. */
let SLIDES=null, slideIdx=0, slideAt=0, slideDirty=true;
const slideCache={};
function slideList(){
  if(SLIDES) return SLIDES;
  const FD=window.FLEETDATA||{};
  SLIDES=cardList().map(id=>({id,name:(FMAP[id]||{}).n||id,photo:(FD[id]||{}).photo,credit:(FD[id]||{}).credit,
    ag:(FD[id]||{}).ag, yr:(FD[id]||{}).yr, dest:(FD[id]||{}).dest}));
  Object.entries(STATION_INFO).forEach(([k,s])=>SLIDES.push({id:k,name:((SITES[k]||{}).name||k)+' complex',
    photo:s.photo,credit:s.credit,ag:'Deep Space Network',dest:s.loc}));
  return SLIDES;
}
function slideImg(src){
  let im=slideCache[src];
  if(!im){ im=new Image(); im.onload=()=>{ slideDirty=true; }; im.src=src; slideCache[src]=im; }
  return im;
}
function archiveInit(){
  watchStrip('archivebezel');
  const l=slideList(); slideIdx=Math.max(0,l.findIndex(s=>s.id==='VGR1'));
  layoutArchive();
}
function layoutArchive(){
  if(!ARCHIVE) return;
  const sc=apRect('screen'), ln=apRect('lens');
  placeBox($('slideCv'),sc);
  const bx=ln.x+ln.w/2, ly=ln.y+ln.h/2-sc.y, b=$('beam');
  placeBox(b,{x:bx,y:sc.y,w:Math.max(1,sc.x-bx),h:sc.h});
  b.style.clipPath=`polygon(0 ${ly-2}px,100% 0,100% 100%,0 ${ly+2}px)`;
  placeBox($('slideFwd'),apRect('fwd')); placeBox($('slideRev'),apRect('rev'));
  placeBox($('discBtn'),apRect('disc')); placeBox($('caseGlass'),apRect('caseGlass')); placeBox($('coverBtn'),apRect('cover'));
  slideDirty=true;
}
function slideGo(k){
  const n=slideList().length; slideIdx=((k%n)+n)%n; slideAt=performance.now(); slideDirty=true;
  const b=$('beam'); b.classList.remove('flick'); void b.offsetWidth; b.classList.add('flick');
  if(stripSeen.archivebezel) blip('clack');
  const nx=slideList()[(slideIdx+1)%n]; if(nx.photo) slideImg(nx.photo);   // the next slide, ready in the tray
}
function slideTo(id){ const k=slideList().findIndex(s=>s.id===id); if(k>=0&&k!==slideIdx) slideGo(k); }
function drawSlide(now){
  const r=apRect('screen'), x=fitCanvas($('slideCv'),r.w,r.h), W=r.w, H=r.h, t=now-slideAt;
  x.fillStyle='#0a0908'; x.fillRect(0,0,W,H);
  if(t<170){ x.fillStyle='rgba(255,236,200,.14)'; x.fillRect(0,0,W,H); slideDirty=true; return; }   // the gate, empty
  const s=slideList()[slideIdx], jit=t<420?(Math.random()-.5)*2:0;
  const fontC=`"Barlow Condensed","Arial Narrow",sans-serif`, mono=`"IBM Plex Mono",monospace`;
  if(s.photo){
    const im=slideImg(s.photo);
    if(im.complete&&im.naturalWidth){
      const sc=Math.max(W/im.naturalWidth,H/im.naturalHeight), dw=im.naturalWidth*sc, dh=im.naturalHeight*sc;
      x.drawImage(im,(W-dw)/2+jit,(H-dh)/2+jit,dw,dh);
      x.fillStyle='rgba(255,210,150,.07)'; x.fillRect(0,0,W,H);
    } else slideDirty=true;
    x.fillStyle='rgba(8,7,6,.62)'; x.fillRect(0,H*0.82,W,H*0.18);
    x.fillStyle='rgba(240,234,220,.95)'; x.textAlign='left'; x.textBaseline='middle';
    x.font=`600 ${Math.max(8,H*0.075)}px ${fontC}`; x.fillText(s.name.toUpperCase(),W*0.03,H*0.87);
    x.font=`${Math.max(6,H*0.045)}px ${mono}`; x.fillStyle='rgba(240,234,220,.7)';
    let cr=s.credit||''; while(cr&&x.measureText(cr).width>W*0.94) cr=cr.slice(0,-2);
    if(cr!==(s.credit||'')) cr=cr.replace(/\s*\S*$/,'')+'…';
    x.fillText(cr,W*0.03,H*0.945);
  } else {
    x.fillStyle='#1B2D48'; x.fillRect(0,0,W,H);
    x.fillStyle='rgba(236,240,248,.95)'; x.textAlign='center'; x.textBaseline='middle';
    x.font=`600 ${Math.max(9,H*0.14)}px ${fontC}`; x.fillText(s.name.toUpperCase(),W/2+jit,H*0.38+jit);
    x.font=`${Math.max(6,H*0.06)}px ${mono}`; x.fillStyle='rgba(236,240,248,.75)';
    x.fillText([s.ag,s.yr].filter(Boolean).join(' · ').toUpperCase(),W/2,H*0.53);
    if(s.dest) x.fillText(String(s.dest).toUpperCase().slice(0,44),W/2,H*0.62);
    x.font=`${Math.max(5,H*0.045)}px ${mono}`; x.fillStyle='rgba(236,240,248,.45)';
    x.fillText('NO PHOTOGRAPH ON FILE',W/2,H*0.84);
  }
  x.font=`${Math.max(5,H*0.04)}px ${mono}`; x.fillStyle='rgba(240,234,220,.45)'; x.textAlign='right'; x.textBaseline='top';
  x.fillText(String(slideIdx+1).padStart(2,'0')+'/'+slideList().length,W*0.97,H*0.03);
  // the lamp's hot centre and the fall-off at the corners
  const g=x.createRadialGradient(W/2,H/2,Math.min(W,H)*0.1,W/2,H/2,Math.max(W,H)*0.7);
  g.addColorStop(0,'rgba(255,240,210,.07)'); g.addColorStop(1,'rgba(0,0,0,.42)'); x.fillStyle=g; x.fillRect(0,0,W,H);
  if(t<420) slideDirty=true;
}
function archiveDraw(now){
  if(!ARCHIVE||!stripSeen.archivebezel||!slideDirty) return;
  slideDirty=false; drawSlide(now);
}
$('slideFwd').addEventListener('click',()=>{ pressFlash($('slideFwd')); slideGo(slideIdx+1); });
$('slideRev').addEventListener('click',()=>{ pressFlash($('slideRev')); slideGo(slideIdx-1); });
$('discBtn').addEventListener('click',()=>{
  const b=$('discBtn'), on=!b.classList.contains('spinning'); b.classList.toggle('spinning',on);
  b.setAttribute('aria-pressed',String(on)); blip('flick');
  flash(on?'VOYAGER GOLDEN RECORD · 16⅔ RPM · '+Math.round((FMAP.VGR1||{}).au||0)+' AU FROM HERE'
          :'ITS TWIN RIDES VOYAGER 2 · '+Math.round((FMAP.VGR2||{}).au||0)+' AU OUT');
});
$('coverBtn').addEventListener('click',()=>{ pressFlash($('coverBtn'));
  flash('THE COVER SHOWS HOW TO PLAY IT, AND WHERE IT CAME FROM: THE SUN AMONG 14 PULSARS'); });
['slideFwd','slideRev','discBtn','coverBtn'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));

/* ---------- ONE SHIP ----------
   The consoles are wired to each other, the way they would be aboard: the
   main bus feeds every strip, the galley draws on the same bus, the cabin
   lights fall on all of it, and the fan blows through the whole deck. None
   of this is in the help panel; it is here to be found. */
let powerOn=true, fanOn=false, lightMode=0;
const LIGHTS=['DAY','DIMMED','NIGHT'];
function layoutLinks(){
  // armL/armR are painted at the very top edge of the comms strip, 48 units
  // tall, which lands as a ~20px target sitting on the seam between two
  // strips. Grow the hit area downward so it is reachable; the art does not
  // move, only the place your pointer has to find.
  // Wider, not taller. Growing these downwards put a transparent button on
  // top of the REMOVE BEFORE FLIGHT ring immediately below each one, which
  // stole the hover highlight from a control that is already hard to find.
  const grow=(r)=>({x:r.x-r.w*0.35, y:r.y, w:r.w*1.7, h:r.h});
  if(FOOT){ placeBox($('powerSw'),apRect('powerSw')); placeBox($('hvacSw'),apRect('hvacSw')); }
  if(GUIDE){ placeBox($('attHoldSw'),apRect('attHold')); placeBox($('attHoldSw2'),apRect('attHold2'));
    placeBox($('attLampCol'),apRect('attLamps')); }
  if(COMMS){ placeBox($('ttyKbd'),apRect('ttyKbd'));
    placeBox($('armL'),grow(apRect('armL'))); placeBox($('armR'),grow(apRect('armR'))); }
  if(FDAI) ['knobG','knobM','knobC'].forEach(k=>placeBox($('clk'+k),apRect(k)));
  if(NAV){ placeBox($('drumCvA'),apRect('drumA')); placeBox($('drumCvB'),apRect('drumB')); drawDrums(); }
  if(LIBRARY) placeBox($('retBar'),apRect('retBar'));
}
// Main bus A. Off, the deck runs on residual power: photos and readouts sag,
// the lamps die, the teleprinter stops mid-line and the pens stop writing.
function setPower(on){
  if(on===powerOn) return;
  powerOn=on; document.body.classList.toggle('brownout',!on);
  $('powerSw').setAttribute('aria-pressed',String(on));
  $('powerSw').classList.toggle('latched',!on);
  blip(on?'cr':'clunk'); pressFlash($('powerSw'));
  if(on){ powerRipple(); flash('MAIN BUS A ON'); } else flash('MAIN BUS A OFF · DECK ON RESIDUAL POWER');
}
// Power coming back runs down the deck strip by strip, as the buses pick up.
function powerRipple(){
  const art=[$('bezel'),...STRIPS.filter(s=>s.j).map(s=>$(s.img))].filter(Boolean);
  art.forEach((el,n)=>{ el.classList.remove('surge'); void el.offsetWidth;
    el.style.animationDelay=(n*90)+'ms'; el.classList.add('surge');
    setTimeout(()=>{ el.classList.remove('surge'); el.style.animationDelay=''; },900+n*90); });
}
// The galley draws hard enough to dip the whole deck while it runs.
function galleyDraw(on){ document.body.classList.toggle('sag',on&&powerOn); }
function cycleLight(){
  lightMode=(lightMode+1)%3;
  document.body.classList.toggle('dim',lightMode===1);
  document.body.classList.toggle('night',lightMode===2);
  blip('flick'); flash('CABIN LIGHTING · '+LIGHTS[lightMode]);
}
// The cabin fan: what floats, drifts with it.
function setFan(on){
  if(on===fanOn) return;
  fanOn=on; document.body.classList.toggle('fan',on);
  $('hvacSw').setAttribute('aria-pressed',String(on)); $('hvacSw').classList.toggle('latched',on);
  blip('clunk'); pressFlash($('hvacSw'));
  flash(on?'CABIN FAN ON · AIR MOVING THROUGH THE DECK':'CABIN FAN OFF');
  if(on) ['pencilItem','cardItem'].forEach(id=>{ const el=$(id); if(el&&!el.dataset.adrift){ clearTimeout(el._t); el._t=setTimeout(()=>driftStart(id),1200+Math.random()*2000); } });
}
/* ATTITUDE HOLD. The guidance strip's own toggles freeze the sky: the hand
   controller goes inert, the glass stops answering the drag, and the
   attitude ball holds where it is. */
let attHold=false;
function setAttHold(on){
  if(on&&typeof shipRatesHigh==='function'&&shipRatesHigh()){
    blip('cr'); flash('ATT HOLD REJECTED · RATES TOO HIGH');
    ttyEnqueue('','ATT HOLD REJECTED - NULL RATES BELOW 0.5 DEG/SEC'); return; }
  attHold=on; document.body.classList.toggle('atthold',on);
  ['attHoldSw','attHoldSw2'].forEach(id=>{ const b=$(id); b.classList.toggle('latched',on); b.setAttribute('aria-pressed',String(on)); });
  $('attLampCol').classList.toggle('lit',on);
  if(on&&RHC.held){ RHC.held=false; RHC.rx=RHC.ry=0; rhcPose(); }
  blip('clunk'); flash(on?'ATT HOLD · ATTITUDE FROZEN':'ATT HOLD OFF · FREE DRIFT');
}
['attHoldSw','attHoldSw2'].forEach(id=>$(id).addEventListener('click',()=>setAttHold(!attHold)));

/* WINDING THE CLOCKS. The setting knob on any station clock winds the whole
   deck through time: the Globus turns under the Sun, the tape library runs
   to the shelf that holds that hour, and letting go loads it. */
let windHours=0, windFrom=0;
function windTarget(){ return (Date.parse(F[i].t)||Date.now())+windHours*3600000; }
function windUpdate(){
  fdaiKey=''; fdaiLast=0; globeLast=0;                       // clocks and globe follow the wound time
  const hrs=(TM&&TM.hours)||[];
  if(hrs.length&&LIBRARY){
    const t=windTarget(); let best=0,bd=1e15;
    hrs.forEach((h,n)=>{ const d=Math.abs(Date.parse(h.t)-t); if(d<bd){ bd=d; best=n; } });
    const per=LIB.per, page=LIB.pages-1-Math.floor((hrs.length-1-best)/per);
    if(page!==LIB.page){ LIB.page=page; libFill(false); }
  }
}
function windRelease(){
  const hrs=(TM&&TM.hours)||[];
  if(Math.abs(windHours)<0.5||!hrs.length){ windHours=0; windUpdate(); return; }
  const t=windTarget(); let best=null,bd=1e15;
  hrs.forEach(h=>{ const d=Math.abs(Date.parse(h.t)-t); if(d<bd){ bd=d; best=h; } });
  windHours=0;
  if(best&&(!MOMENT||MOMENT.id!==best.id)){ flash('WINDING TO '+hourTitle(best.t).toUpperCase()); tapeLoadId(best.id); }
  else windUpdate();
}
['knobG','knobM','knobC'].forEach(k=>{
  const b=$('clk'+k);
  b.addEventListener('pointerdown',e=>{ e.preventDefault(); try{ b.setPointerCapture(e.pointerId); }catch(_){}
    windFrom=e.clientX; b.classList.add('winding'); blip('flick'); });
  b.addEventListener('pointermove',e=>{ if(!b.classList.contains('winding')) return;
    windHours=Math.round((e.clientX-windFrom)/9); windUpdate(); });
  const rel=()=>{ if(!b.classList.contains('winding')) return; b.classList.remove('winding'); windRelease(); };
  ['pointerup','pointercancel','lostpointercapture'].forEach(ev=>b.addEventListener(ev,rel));
  b.addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault();
    const d={ArrowLeft:-1,ArrowRight:1}[e.key]; if(!d) return; e.preventDefault(); windHours+=d; windUpdate(); });
  b.addEventListener('click',()=>{ if(windHours) windRelease(); });
});

/* The Globus drum counters: days and hours the deck has watched, counted
   from the first hour in the archive. */
function drawDrums(){
  if(!NAV||!stripSeen.navbezel) return;
  const hrs=(TM&&TM.hours)||[]; if(!hrs.length) return;
  const t0=Date.parse(hrs[0].t), t=windTarget(), el=Math.max(0,t-t0);
  const days=Math.floor(el/86400000), hours=Math.floor(el/3600000)%24;
  [['drumCvA','drumA',days],['drumCvB','drumB',hours]].forEach(([cv,ap,v])=>{
    const r=apRect(ap), x=fitCanvas($(cv),r.w,r.h), W=r.w, H=r.h;
    x.fillStyle='#15120e'; x.fillRect(0,0,W,H);
    const s=String(Math.min(999,v)).padStart(3,'0'), cw=W/3.2;
    for(let n=0;n<3;n++){
      const bx=W*0.04+n*cw;
      x.fillStyle='#e9e2d2'; x.fillRect(bx,H*0.16,cw*0.82,H*0.68);
      x.fillStyle='#241f19'; x.font=`600 ${H*0.52}px "Barlow Condensed","Arial Narrow",sans-serif`;
      x.textAlign='center'; x.textBaseline='middle'; x.fillText(s[n],bx+cw*0.41,H*0.52);
    }
    x.fillStyle='rgba(0,0,0,.35)'; x.fillRect(0,0,W,H*0.14); x.fillRect(0,H*0.86,W,H*0.14);
  });
}
/* THE TELEPRINTER KEYBOARD. Click it and type: the printer prints what you
   type and the punch cuts it. Press ENTER on a spacecraft's name and the
   deck answers -- the projector turns to its slide, the card file to its
   card, and the Globus lights whichever complex is hearing it. */
let ttyTyping=false, ttyLine='';
function kbdSet(on){
  ttyTyping=on; document.body.classList.toggle('typing',on);
  $('ttyKbd').setAttribute('aria-pressed',String(on));
  if(on){ ttyLine=''; ttyEnqueue('','>> ',''); flash('KEYBOARD LIVE · TYPE A SPACECRAFT, ENTER TO SEND'); }
  else flash('KEYBOARD RELEASED');
}
function kbdKey(e){
  if(!ttyTyping) return;
  if(e.key==='Escape'){ e.preventDefault(); kbdSet(false); return; }
  if(e.key==='Enter'){ e.preventDefault(); kbdSend(); return; }
  if(e.key==='Backspace'){ e.preventDefault(); ttyLine=ttyLine.slice(0,-1); return; }
  if(e.key.length!==1) return;
  e.preventDefault();
  if(ttyLine.length>=38) return;
  ttyLine+=e.key.toUpperCase(); blip('tick'); ttyPunch(e.key.toUpperCase());
  TTY.cur=('>> '+ttyLine); TTY.col=TTY.cur.length; TTY.dirty=true;
}
function kbdSend(){
  const q=ttyLine.trim().toUpperCase(); ttyLine='';
  TTY.cur=''; TTY.col=0; TTY.dirty=true;
  if(!q){ kbdSet(false); return; }
  const hit=FLEET.find(f=>f.n.toUpperCase()===q)||FLEET.find(f=>f.n.toUpperCase().includes(q))||FLEET.find(f=>f.id===q);
  if(!hit){ ttyEnqueue('','NO SUCH SPACECRAFT ON THE ROSTER: '+q,''); blip('cr'); return; }
  ttyEnqueue('',hit.n.toUpperCase()+' -- FILE AND SLIDE FOLLOW',''); blip('bell');
  if(ARCHIVE) slideTo(hit.id);
  if(NAV){ const k=cardList().indexOf(hit.id); if(k>=0) flipTo(k); }
  const lk=F[i].links.find(l=>l.sc===hit.id);
  if(lk&&NAV){ const lp=(NAV_ST.find(([st])=>st===lk.st)||[])[1]; if(lp){ const el=$(lp); el.classList.add('lit');
    el.animate([{filter:'brightness(2.2)'},{filter:'brightness(1)'}],{duration:900}); } }
  flash(hit.n.toUpperCase()+(lk?' · ON '+String(SITEN[lk.st]||lk.st).toUpperCase():' · NOT TRACKED JUST NOW'));
}
$('ttyKbd').addEventListener('click',()=>kbdSet(!ttyTyping));
addEventListener('keydown',kbdKey,true);

/* THE FLAGS MEAN SOMETHING. The ABORT guard stays shut until all three
   REMOVE BEFORE FLIGHT flags are pulled and both ARM switches are up. */
let armL=false, armR=false;
function setArm(which,on){
  if(which==='L') armL=on; else armR=on;
  const b=$('arm'+which); b.classList.toggle('latched',on); b.setAttribute('aria-pressed',String(on));
  blip('clunk'); flash('ARM '+which+' · '+(on?'ARMED':'SAFE')+(abortReady()?' · ABORT ENABLED':''));
  checkSequence();
}
function abortReady(){ return armL&&armR&&tagsPulled>=3; }
['L','R'].forEach(w=>$('arm'+w).addEventListener('click',()=>setArm(w,!(w==='L'?armL:armR))));

/* THE SHELF BAR. Pull it and the tapes come off the shelf, as anything
   unsecured does up here. */
let barOut=false;
function pullBar(){
  barOut=!barOut; $('retBar').classList.toggle('latched',barOut); blip(barOut?'rip':'cr');
  if(!barOut){ flash('RETAINING BAR SECURED'); return; }
  flash('RETAINING BAR RELEASED · SECURE THE TAPES');
  const sh=[...$('libShelf').children].filter(b=>b.dataset.id&&!b.classList.contains('gone'));
  sh.sort(()=>Math.random()-0.5).slice(0,2).forEach((b,n)=>setTimeout(()=>{
    const r=b.getBoundingClientRect(), s=coverRect().s, st=STRIPS.find(z=>z.img==='librarybezel');
    const cv=document.createElement('canvas'), d=devicePixelRatio||1;
    cv.width=Math.round(r.width*d); cv.height=Math.round(r.height*d);
    const x=cv.getContext('2d'), im=new Image();
    im.onload=()=>{
      const ap=apRect('spine'+[...$('libShelf').children].indexOf(b)), top=((st&&st.top)||0)*s;
      x.drawImage(im,(ap.x/s)*(2560/2560)*(im.width/2560),((ap.y-top)/s)*(im.height/400),
        (ap.w/s)*(im.width/2560),(ap.h/s)*(im.height/400),0,0,cv.width,cv.height);
      const ang=-1.2+Math.random()*0.8, sp=22+Math.random()*20;
      launchFloater({src:cv.toDataURL('image/png'),w:r.width,h:r.height,
        x:r.left+scrollX,y:r.top+scrollY,vx:Math.cos(ang)*sp,vy:Math.sin(ang)*sp,rot:0,vr:(Math.random()-.5)*40,
        label:'A tape canister, adrift',onGone:()=>b.classList.remove('gone')});
      b.classList.add('gone');
    };
    im.src='overlay/library_overlay.webp';
  },n*450));
}
$('retBar').addEventListener('click',pullBar);

/* THE SEQUENCE. Bus on, flags cleared, both switches armed, attitude free,
   and then P63 on the DSKY: the deck lamp-tests itself top to bottom. */
let sequenceDone=false;
function checkSequence(){
  if(sequenceDone||!powerOn||!abortReady()||attHold||DS.prog!=='63') return;
  sequenceDone=true;
  flash('LAUNCH SEQUENCE COMPLETE · ALL STATIONS'); blip('klaxon',0.8);
  const art=[$('bezel'),...STRIPS.filter(s=>s.j).map(s=>$(s.img))].filter(Boolean);
  art.forEach((el,n)=>setTimeout(()=>{ el.classList.remove('surge'); void el.offsetWidth; el.classList.add('surge');
    setTimeout(()=>el.classList.remove('surge'),700); },n*160));
  DS.testUntil=performance.now()+art.length*160+1200;
  setTimeout(()=>{ ttyEnqueue('','ALL STATIONS: THE DECK IS YOURS. FAR VOICES, '+new Date().getUTCFullYear(),'here'); },art.length*160+400);
}
$('powerSw').addEventListener('click',()=>setPower(!powerOn));
$('hvacSw').addEventListener('click',()=>setFan(!fanOn));
['powerSw','hvacSw'].forEach(id=>$(id).addEventListener('keydown',e=>{ if(e.key===' ') e.preventDefault(); }));

/* ---------- ZERO GRAVITY ----------
   Anything let go of floats. Floaters are objects in the cabin, so they
   live in PAGE coordinates like the console itself: they scroll with it,
   and keep drifting while scrolled out of view, so scrolling back finds
   each one wherever its course has carried it in the meantime. They tumble
   slowly, can be flicked, and are dropped once they have drifted out of
   the deck altogether. */
const floaters=[];
let floatLast=performance.now();
const STILL=matchMedia('(prefers-reduced-motion: reduce)');
function floatLayer(){
  let l=$('floaters');
  if(!l){ l=document.createElement('div'); l.id='floaters'; document.body.appendChild(l); }
  return l;
}
function launchFloater(o){
  if(STILL.matches) return null;
  const b=document.createElement('button'); b.className='floater';
  b.setAttribute('aria-label',o.label||'Something floating past'); if(o.title) b.title=o.title;
  b.innerHTML=`<img src="${o.src}" alt="">`; b.style.width=o.w+'px'; b.style.height=o.h+'px';
  const f=Object.assign({el:b,born:performance.now(),seen:false},o);
  b.addEventListener('click',()=>{
    const sgn=()=>Math.random()<.5?-1:1;
    if(o.tap==='egg'){
      // A stowaway: the first tap is a real push -- faster, and set
      // spinning. After that there is nothing more to push against, so a
      // tap only turns its course and changes its spin, never its speed.
      const sp=Math.hypot(f.vx,f.vy)||20;
      if(!f.tapped){ f.tapped=true; f.vx*=1.45; f.vy*=1.45; f.vr=sgn()*(45+Math.random()*45); }
      else { const a=Math.atan2(f.vy,f.vx)+sgn()*(0.5+Math.random()*1.1);
        f.vx=Math.cos(a)*sp; f.vy=Math.sin(a)*sp; f.vr=sgn()*Math.max(30,Math.abs(f.vr))*(0.7+Math.random()*0.6); }
    } else { f.vx+=(Math.random()-.5)*70; f.vy+=(Math.random()-.5)*70; f.vr+=(Math.random()-.5)*70; }
    blip('flick'); if(o.onClick) o.onClick(f);
  });
  floaters.push(f); floatPose(f); floatLayer().appendChild(b);
  return f;
}
function floatPose(f){ f.el.style.transform=`translate(${f.x.toFixed(1)}px,${f.y.toFixed(1)}px) rotate(${f.rot.toFixed(1)}deg)`; }
function floatTick(now){
  const dt=Math.min(0.25,(now-floatLast)/1000); floatLast=now;
  if(!floaters.length) return;
  // The layer is as tall as the deck, so it scrolls with it and clips
  // anything that has drifted past its edges.
  const lay=$('floaters'), ph=document.body.style.height||(innerHeight+'px');
  if(lay&&lay.style.height!==ph) lay.style.height=ph;
  const PW=document.documentElement.clientWidth||innerWidth, PH=parseFloat(ph)||innerHeight;
  for(let k=floaters.length-1;k>=0;k--){
    const f=floaters[k];
    if(fanOn){ f.vx+=9*dt; f.vy+=3*dt; f.vr+=2*dt; }        // the cabin fan pushes everything along
    f.x+=f.vx*dt; f.y+=f.vy*dt; f.rot+=f.vr*dt; floatPose(f);
    const inside=f.x+f.w>0&&f.y+f.h>0&&f.x<PW&&f.y<PH;
    if(inside) f.seen=true;
    // Gone once it has been in the deck and left it -- things launched from
    // outside are not dropped before they arrive -- or after five minutes
    // regardless, so a floater nudged into a slow orbit cannot stay forever.
    if((f.seen&&!inside)||now-f.born>300000){ f.el.remove(); floaters.splice(k,1); if(f.onGone) f.onGone(f); }
  }
}

/* Stowaways. Now and then, once the deck is powered up, something that
   should never have come aboard drifts in from an edge of the screen,
   tumbles across the console and out the other side. One at a time, each
   seen once before any comes round again. Click one to flick it and read
   its tag. ?eggs=fast brings them every few seconds, for testing. */
const EGGS=[
  {src:'overlay/egg_duck.webp',     size:110, sound:'squeak', cap:'RUBBER DUCK · NOT ON THE MANIFEST'},
  {src:'overlay/egg_glove.webp',    size:130, cap:'SPARE GLOVE · ED WHITE LOST ONE ON GEMINI 4, 1965'},
  {src:'overlay/egg_sandwich.webp', size:125, cap:'CORNED BEEF ON RYE · SMUGGLED ONTO GEMINI 3, 1965'},
  {src:'overlay/egg_camera.webp',   size:125, cap:'CAMERA · SPACEWALKERS HAVE LET MORE THAN ONE GO'},
  {src:'overlay/egg_dice.webp',     size:105, cap:'FUZZY DICE · REARVIEW MIRROR NOT FOUND'},
  {src:'overlay/egg_fish.webp',     size:120, sound:'blup', cap:'WATER SPHERE, ONE FISH · SKYLAB 3 CARRIED FISH IN 1973. NOT THIS ONE.'},
  {src:'overlay/egg_robot.webp',    size:115, cap:'TIN ROBOT · STILL WALKING. NOTHING TO WALK ON.'},
];
const EGG_FAST=new URLSearchParams(location.search).get('eggs')==='fast';
let eggNext=0, eggOut=false, eggBag=[];
function eggDelay(){ return EGG_FAST?6000:120000+Math.random()*240000; }         // two to six minutes
function eggTick(now){
  if(!eggNext){ eggNext=now+(EGG_FAST?3000:60000+Math.random()*120000); return; }
  if(eggOut||now<eggNext||!AC||document.hidden) return;
  if(!eggBag.length) eggBag=EGGS.slice().sort(()=>Math.random()-.5);
  spawnEgg(eggBag.pop());
}
function spawnEgg(e){
  eggOut=true;
  const retry=()=>{ eggOut=false; eggNext=performance.now()+eggDelay(); };
  const im=new Image();
  im.onerror=retry;
  im.onload=()=>{
    const s=Math.max(70,Math.min(170,e.size*innerWidth/1600)), ar=im.naturalWidth/im.naturalHeight;
    const w=ar>=1?s:s*ar, h=ar>=1?s/ar:s, side=Math.floor(Math.random()*4);
    const W=document.documentElement.clientWidth||innerWidth, H=innerHeight, sy=scrollY;
    // In from a random edge of whatever is on screen now, aimed through the
    // middle of it -- in page coordinates, so from then on it is an object
    // in the cabin like any other and scrolls with the console.
    const x=side===0?-w:side===1?W:Math.random()*(W-w), y=sy+(side===2?-h:side===3?H:Math.random()*(H-h));
    const tx=W*(0.25+Math.random()*0.5)-w/2, ty=sy+H*(0.25+Math.random()*0.5)-h/2;
    const d=Math.hypot(tx-x,ty-y)||1, sp=18+Math.random()*16;          // an unhurried 18-34 px/s
    const f=launchFloater({src:e.src,w,h,x,y,vx:(tx-x)/d*sp,vy:(ty-y)/d*sp,rot:Math.random()*360,vr:(Math.random()-.5)*30,tap:'egg',
      label:e.cap.split(' · ')[0].toLowerCase()+', floating past',
      onClick:()=>{ if(e.sound) blip(e.sound); flash(e.cap); }, onGone:retry});
    if(!f) retry();                                   // reduced motion: nothing floats
  };
  im.src=e.src;
}

let __last=performance.now();
(function tick(){
  const now=performance.now(); simDays+=ORBIT_YPS*(now-__last)/1000; __last=now;
  if(!$('boot').classList.contains('gone')){yaw+=.02;}
  drawSky(F[i]); drawScope(F[i]); drawScore();
  drawGlobe(); ttyStep(now); drawTty(); dskyDraw(); rhcTick(now); floatTick(now); eggTick(now); fdaiDraw(); readerDraw(now); archiveDraw(now);
  if(typeof shipFrame==='function') shipFrame(now);
  if(typeof portDraw==='function') portDraw(now);
  if(typeof bannerFrame==='function') bannerFrame(now);
  requestAnimationFrame(tick); })();
render();
