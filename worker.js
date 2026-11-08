// WIRLOX Daily + D1. The public repo includes only this logic, never private seed SQL.
// Future puzzles are stored in D1 and are released by Europe/Madrid calendar date.
const TZ = 'Europe/Madrid';
const FIRST_DAILY = 29;
const LAST_DAILY = 35;
const MAX_TRACE = 700;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NO_CACHE = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };
function json(data, status=200) { return Response.json(data, {status, headers:NO_CACHE}); }
function todayInMadrid(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(date);
  const val = k => parts.find(x=>x.type===k).value;
  return `${val('year')}-${val('month')}-${val('day')}`;
}
function daysAfter(dateYmd, startYmd) {
  const parse = s=>Date.parse(s + 'T00:00:00Z');
  return Math.round((parse(dateYmd)-parse(startYmd))/86400000);
}
function validStart(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s+'T00:00:00Z'));
}
function toPublicPuzzle(p) {
  return {
    number:p.number, name:p.puzzle_key, day:`Puzzle ${p.number}`, mood:p.mood,
    mode:'14 letters · 3 words', start:p.starting_wheel,
    words:[p.word1,p.word2,p.word3], reference:p.optimum,
    excellent:p.excellent, good:p.good, average:p.average,
    isDaily:p.publication==='daily'
  };
}
async function getLaunchDate(db) {
  const setting=await db.prepare("SELECT value FROM settings WHERE key='daily_start_date'").first();
  return setting?.value ?? 'PAUSED';
}
function unlocked(row, currentDate, startDate) {
  if(row.publication!=='daily')return true;
  if(!validStart(startDate))return false;
  return row.number <= FIRST_DAILY+daysAfter(currentDate,startDate) && row.number <= LAST_DAILY;
}
async function state(db) {
  const date=todayInMadrid(),start=await getLaunchDate(db);
  const rows=(await db.prepare('SELECT * FROM puzzles ORDER BY number').all()).results;
  const publishedArchive=rows.filter(x=>x.publication==='archive' && x.number>=15).map(toPublicPuzzle);
  const releasedDaily=rows.filter(x=>x.publication==='daily' && unlocked(x,date,start)).map(toPublicPuzzle);
  let daily=null,status='not_launched';
  if(validStart(start)) {
    const offset=daysAfter(date,start);
    if(offset<0)status='upcoming';
    else if(offset>LAST_DAILY-FIRST_DAILY)status='finished';
    else {
      status='live';
      const num=FIRST_DAILY+offset;
      daily=toPublicPuzzle(rows.find(x=>x.number===num));
    }
  }
  return {timezone:TZ, date, status, daily, archive:publishedArchive,
    releasedDaily, dailyStart:validStart(start)?start:null};
}
const ABC='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const mod=(x,n)=>(x%n+n)%n;
function wordExists(wheel,word){
  const N=wheel.length;
  for(let i=0;i<N;i++) if([...word].every((ch,j)=>wheel[(i+j)%N]===ch))return true;
  return false;
}
// Replay the exact rules: horizontal rotates cursor, vertical alters BOTH opposite
// letters, and completion is checked after vertical moves (then cascades at
// the end of each word's fixed transition). It does NOT check after a horizontal.
function validateTrace(p, steps) {
  if(!steps || steps.length>MAX_TRACE || !/^[LRUD]+$/.test(steps))return false;
  const wheel=[...p.starting_wheel];let cursor=0,level=0;
  const words=[p.word1,p.word2,p.word3];
  for(let j=0;j<steps.length;j++){
    const step=steps[j];
    if(step==='L'||step==='R')cursor=mod(cursor+(step==='L'?-1:1),14);
    else {
      const delta=step==='U'?-1:1;
      for(const k of [cursor,(cursor+7)%14]) {
        wheel[k]=ABC[mod(ABC.indexOf(wheel[k])+delta,26)];
      }
      while(level<3 && wordExists(wheel,words[level]))level++;
    }
    if(level===3)return j===steps.length-1 && steps.length>=p.optimum;
  }
  return false;
}
async function attempt(request,db){
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);
  const size=Number(request.headers.get('content-length')||0);
  if(size>4096)return json({error:'Too large'},413);
  let data;
  try {data=JSON.parse(await request.text());}catch{return json({error:'Invalid JSON'},400);}
  const puzzleNumber=Number(data.puzzleNumber), playerId=data.playerId, steps=data.steps;
  const elapsed=Number(data.elapsedSeconds);
  if(!Number.isInteger(puzzleNumber)||puzzleNumber<1||puzzleNumber>LAST_DAILY||
    typeof playerId!=='string'||!UUID_RE.test(playerId)||typeof steps!=='string'||steps.length>MAX_TRACE||
    !Number.isInteger(elapsed)||elapsed<0||elapsed>86400*14){return json({error:'Invalid submission'},422);}
  const p=await db.prepare('SELECT * FROM puzzles WHERE number=?').bind(puzzleNumber).first();
  const date=todayInMadrid(),launch=await getLaunchDate(db);
  if(!p||!unlocked(p,date,launch))return json({error:'Puzzle not released'},404);
  if(!validateTrace(p,steps))return json({error:'Completion cannot be verified'},422);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(steps)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const write=await db.prepare('INSERT OR IGNORE INTO first_attempts (puzzle_number, anonymous_player_id, moves, elapsed_seconds, trace_sha256) VALUES (?,?,?,?,?)')
    .bind(puzzleNumber,playerId,steps.length,elapsed,hash).run();
  const agg=await db.prepare('SELECT COUNT(*) as count, ROUND(AVG(moves),1) as average FROM first_attempts WHERE puzzle_number=?').bind(puzzleNumber).first();
  // Only a verified completed play can obtain an optimal route.
  // Routes live exclusively in D1, not in this public Worker or game assets.
  const sol=await db.prepare('SELECT route FROM solution_routes WHERE puzzle_number=?').bind(puzzleNumber).first();
  const optimalRoute=sol?.route;
  if(typeof optimalRoute!=='string'||optimalRoute.length!==p.optimum||!validateTrace(p,optimalRoute))
    throw Error('Missing or invalid private route for puzzle '+puzzleNumber);
  return json({verified:true, firstRecorded:!!write.meta?.changes, puzzleNumber,
    moves:steps.length, optimum:p.optimum, globalAverage:agg.average, sampleSize:agg.count,
    optimalRoute});
}

// Factory 5.10.3 private gate. The access key is a Cloudflare Worker SECRET,
// never a source-code constant. A signed HttpOnly session lasts 14 days.
const FACTORY_COOKIE='wirlox_factory_session';
const FACTORY_SESSION_SECONDS=14*24*60*60;
const FACTORY_MAX_PUZZLE=1000;
const FACTORY_LOGIN_HTML="<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>WIRLOX · Private Factory</title><meta name=\"robots\" content=\"noindex,nofollow\"><style>html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,sans-serif;background:#090f1b;color:#e7f1fd}body{display:grid;min-height:100dvh;place-items:center}.card{box-sizing:border-box;width:min(420px,92vw);padding:28px;border:1px solid #334a66;border-radius:18px;background:#152138;box-shadow:0 18px 55px #0007}h1{margin:0 0 8px;font-size:26px;letter-spacing:.10em}p{color:#adbed5;line-height:1.5}label{display:block;margin:22px 0 9px;font-size:13px}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #6688a8;border-radius:8px;background:#0e182a;color:#fff;font-size:16px}button{width:100%;padding:13px;margin-top:15px;border:1px solid #83c6ee;border-radius:9px;background:#224767;color:#fff;font-size:16px;font-weight:700;cursor:pointer}#error{color:#ffb9b9;min-height:1em}</style></head><body><main class=\"card\"><h1>WIRLOX</h1><p>Private Factory · puzzle testing only.<br>The public game is unchanged.</p><form id=\"gate\"><label for=\"password\">Private access key</label><input id=\"password\" type=\"password\" autocomplete=\"current-password\" required autofocus><button type=\"submit\">Open private puzzles</button><p id=\"error\" role=\"status\"></p></form></main><script>document.getElementById('gate').addEventListener('submit',async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;document.getElementById('error').textContent='';try{const r=await fetch('/api/factory/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:document.getElementById('password').value}),cache:'no-store'});if(!r.ok){document.getElementById('error').textContent=r.status===401?'Access key not recognised.':'Private access unavailable.';return;}location.replace('/factory');}catch{document.getElementById('error').textContent='Unable to connect.';}finally{b.disabled=false;}});</script></body></html>";
const FACTORY_HEADERS={...NO_CACHE,'X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
function strongFactoryKey(env){return typeof env.FACTORY_ACCESS_KEY==='string'&&env.FACTORY_ACCESS_KEY.length>=24;}
function bytesToHex(bytes){return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
function equalHex(a,b){
 if(typeof a!=='string'||a.length!==b.length)return false;
 let mismatch=0;for(let i=0;i<b.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);
 return mismatch===0;
}
async function digest(value){return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));}
async function signature(secret, message){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('WIRLOX-FACTORY-v1:'+message));
 return bytesToHex(new Uint8Array(signed));
}
async function hasFactorySession(request,env){
 if(!strongFactoryKey(env))return false;
 const cookie=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim())
  .find(s=>s.startsWith(FACTORY_COOKIE+'='));
 if(!cookie)return false;
 const token=cookie.slice(FACTORY_COOKIE.length+1);
 const match=/^(\d{10})\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(token);
 if(!match || Number(match[1])<Math.floor(Date.now()/1000))return false;
 const message=match[1]+'.'+match[2];
 return equalHex(match[3],await signature(env.FACTORY_ACCESS_KEY,message));
}
async function loginFactory(request,env){
 if(!strongFactoryKey(env))return json({error:'Private access not configured'},503);
 if(request.headers.get('Origin')!==new URL(request.url).origin)return json({error:'Not allowed'},403);
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);
 if(Number(request.headers.get('content-length')||0)>1024)return json({error:'Too large'},413);
 let input;try{input=await request.json();}catch{return json({error:'Invalid JSON'},400);}
 if(typeof input?.key!=='string'||input.key.length>256)return json({error:'Invalid access key'},401);
 const [candidate,expected]=await Promise.all([digest(input.key),digest(env.FACTORY_ACCESS_KEY)]);
 if(!equalHex(candidate,expected))return json({error:'Invalid access key'},401);
 const expiry=String(Math.floor(Date.now()/1000)+FACTORY_SESSION_SECONDS);
 const message=expiry+'.'+crypto.randomUUID();
 const token=message+'.'+await signature(env.FACTORY_ACCESS_KEY,message);
 const headers=new Headers({...NO_CACHE,'Set-Cookie':`${FACTORY_COOKIE}=${token}; Max-Age=${FACTORY_SESSION_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`});
 return Response.json({ok:true},{headers});
}
async function serveFactory(request,env){
 if(!strongFactoryKey(env))return new Response('Factory access not yet configured.',{status:503,headers:FACTORY_HEADERS});
 if(!await hasFactorySession(request,env))return new Response(FACTORY_LOGIN_HTML,{headers:{...FACTORY_HEADERS,'Content-Type':'text/html; charset=utf-8'}});
 // Fetch the root asset, not /index.html: Cloudflare redirects /index.html
 // to /, which would otherwise navigate the browser away from /factory.
 const url=new URL(request.url);url.pathname='/';url.search='';
 const asset=await env.ASSETS.fetch(new Request(url,request));
 if(!asset.ok)return new Response('Private Factory game unavailable.',{status:503,headers:FACTORY_HEADERS});
 const headers=new Headers(asset.headers);
 Object.entries(FACTORY_HEADERS).forEach(([k,v])=>headers.set(k,v));
 return new Response(asset.body,{status:asset.status,headers});
}
async function privateFactoryPuzzles(db){
 const rows=(await db.prepare('SELECT * FROM puzzles WHERE number >= 15 ORDER BY number').all()).results;
 return json({puzzles:rows.map(toPublicPuzzle)});
}
async function privateFactoryAttempt(request,db){
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);
 if(Number(request.headers.get('content-length')||0)>4096)return json({error:'Too large'},413);
 let data;try{data=await request.json();}catch{return json({error:'Invalid JSON'},400);}
 const number=Number(data.puzzleNumber),steps=data.steps,elapsed=Number(data.elapsedSeconds);
 if(!Number.isInteger(number)||number<1||number>FACTORY_MAX_PUZZLE||
    typeof data.playerId!=='string'||!UUID_RE.test(data.playerId)||
    typeof steps!=='string'||steps.length>MAX_TRACE||
    !Number.isInteger(elapsed)||elapsed<0||elapsed>86400*14)return json({error:'Invalid submission'},422);
 const p=await db.prepare('SELECT * FROM puzzles WHERE number=?').bind(number).first();
 if(!p||!validateTrace(p,steps))return json({error:'Completion cannot be verified'},422);
 const route=await db.prepare('SELECT route FROM solution_routes WHERE puzzle_number=?').bind(number).first();
 if(typeof route?.route!=='string'||route.route.length!==p.optimum||!validateTrace(p,route.route))
  return json({error:'Private optimal route missing or invalid'},503);
 // No public attempts, global averages, or first-play statistics are written.
 return json({verified:true,firstRecorded:false,puzzleNumber:number,moves:steps.length,
   optimum:p.optimum,globalAverage:null,sampleSize:0,optimalRoute:route.route});
}

// Factory 5.10.4 feedback: one editable record per puzzle and anonymous browser.
// No IP addresses, account details, or unpublished puzzle content are stored.
// Public feedback is accepted only after that browser's verified first completion.
async function savePuzzleFeedback(request,db,isPrivate){
  if(request.headers.get('Origin')!==new URL(request.url).origin)return json({error:'Not allowed'},403);
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);
  if(Number(request.headers.get('content-length')||0)>2048)return json({error:'Too large'},413);
  let data;
  try{const text=await request.text();if(text.length>2048)return json({error:'Too large'},413);data=JSON.parse(text);}
  catch{return json({error:'Invalid JSON'},400);}
  const number=data?.puzzleNumber,playerId=data?.playerId,feel=data?.feel,note=data?.note;
  if(!Number.isInteger(number)||number<1||number>(isPrivate?FACTORY_MAX_PUZZLE:LAST_DAILY)||
     typeof playerId!=='string'||!UUID_RE.test(playerId)||
     typeof feel!=='string'||!['','Clever','Straightforward','Grindy'].includes(feel)||
     typeof note!=='string'||note.length>240||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(note))
    return json({error:'Invalid feedback'},422);
  const puzzle=await db.prepare('SELECT number, publication FROM puzzles WHERE number=?').bind(number).first();
  if(!puzzle)return json({error:'Puzzle not found'},404);
  if(!isPrivate){
    const launch=await getLaunchDate(db);
    if(!unlocked(puzzle,todayInMadrid(),launch))return json({error:'Puzzle not released'},404);
    const completed=await db.prepare('SELECT 1 AS found FROM first_attempts WHERE puzzle_number=? AND anonymous_player_id=?')
       .bind(number,playerId).first();
    if(!completed)return json({error:'Verified completion required'},409);
  }
  await db.prepare(`INSERT INTO puzzle_feedback
    (source,puzzle_number,anonymous_player_id,feel,note,updated_at)
    VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(source,puzzle_number,anonymous_player_id)
    DO UPDATE SET feel=excluded.feel,note=excluded.note,updated_at=excluded.updated_at`)
    .bind(isPrivate?'factory':'public',number,playerId,feel,note.trim()).run();
  return json({saved:true,puzzleNumber:number});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if((url.pathname==='/factory'||url.pathname==='/factory/')&&request.method==='GET')return serveFactory(request,env);
    if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
    try{
      if(url.pathname==='/api/factory/login'&&request.method==='POST')return loginFactory(request,env);
      if(url.pathname.startsWith('/api/factory/')){
        if(!await hasFactorySession(request,env))return json({error:'Private access required'},401);
        if(!env.DB)return json({error:'D1 binding not configured'},503);
        if(url.pathname==='/api/factory/puzzles'&&request.method==='GET')return privateFactoryPuzzles(env.DB);
        if(url.pathname==='/api/factory/attempt'&&request.method==='POST')return privateFactoryAttempt(request,env.DB);
        if(url.pathname==='/api/factory/feedback'&&request.method==='POST')return savePuzzleFeedback(request,env.DB,true);
        return json({error:'Not found'},404);
      }
      if(!env.DB)return json({error:'D1 binding not configured'},503);
      if(url.pathname==='/api/health'&&request.method==='GET'){
        const [row,start]=await Promise.all([env.DB.prepare('SELECT COUNT(*) as total FROM puzzles').first(),getLaunchDate(env.DB)]);
        return json({ok:true,puzzleCount:row.total,dailyConfigured:validStart(start),timezone:TZ});
      }
      if(url.pathname==='/api/state'&&request.method==='GET')return json(await state(env.DB));
      if(url.pathname==='/api/attempt'&&request.method==='POST')return attempt(request,env.DB);
      if(url.pathname==='/api/feedback'&&request.method==='POST')return savePuzzleFeedback(request,env.DB,false);
      return json({error:'Not found'},404);
    }catch(e){console.error('WIRLOX API error:',e?.message||String(e));return json({error:'Service temporarily unavailable'},503);}
  }
};
// For local tests only; not used as Worker exports.
export {todayInMadrid,daysAfter,validateTrace,validStart};
