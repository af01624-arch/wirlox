// WIRLOX Factory 5.10.9 — Protected schedule page routed through /api/factory/ (public layouts unchanged).
// The public repo includes only code; private puzzle seeds and optimal routes live in D1.
// Future puzzles are stored in D1 and are released by Europe/Madrid calendar date.
const TZ = 'Europe/Madrid';
const FIRST_DAILY = 29;
// The D1 puzzles table currently permits 1–100000, by deliberate agreement.
// There is NO Daily schedule ceiling: published slots are drawn from D1.
const MAX_PUZZLE_NUMBER = 100000;
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
  return typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s+'T00:00:00Z')) &&
    new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
}
function toPublicPuzzle(p,publicNumber=p.number) {
  return {
    number:publicNumber, name:p.puzzle_key, day:`Puzzle ${publicNumber}`, mood:p.mood,
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
// Daily slots 29 onwards are public identities. The underlying source
// puzzle can be swapped BEFORE its slot is released; released slots are locked.
function unlocked(row,currentDate,startDate,publicNumber=row.number) {
  if(row.publication!=='daily')return row.publication==='archive';
  return validStart(startDate) && publicNumber>=FIRST_DAILY && publicNumber<=MAX_PUZZLE_NUMBER &&
    daysAfter(currentDate,startDate)>=publicNumber-FIRST_DAILY;
}
async function resolvePublicPuzzle(db,number){
  if(number<FIRST_DAILY)
    return db.prepare("SELECT * FROM puzzles WHERE publication='archive' AND number=?").bind(number).first();
  return db.prepare(`SELECT p.* FROM daily_schedule AS s
      JOIN puzzles AS p ON p.number=s.puzzle_number
      WHERE s.slot_number=? AND p.publication='daily'`).bind(number).first();
}
// Read in bounded D1 batches; unlike .all() alone, this does not silently
// stop after the database's per-query result limit as the archive grows.
async function getReleasedRows(db, throughSlot) {
  let after=FIRST_DAILY-1;
  const rows=[];
  while(after<throughSlot) {
    const page=(await db.prepare(`SELECT s.slot_number,p.* FROM daily_schedule AS s
      JOIN puzzles AS p ON p.number=s.puzzle_number
      WHERE s.slot_number>? AND s.slot_number<=? AND p.publication='daily'
      ORDER BY s.slot_number LIMIT 200`).bind(after,throughSlot).all()).results;
    if(!page.length)break;
    rows.push(...page);
    after=page[page.length-1].slot_number;
  }
  return rows;
}
// Find the last *consecutively* released Daily without retrieving all past
// puzzles. A missing slot, a missing source puzzle, or a non-Daily source
// prevents later scheduled entries from becoming public via any endpoint.
async function releasedBoundary(db,throughSlot) {
  if(throughSlot<FIRST_DAILY)return FIRST_DAILY-1;
  const discontinuity=await db.prepare(`SELECT previous_slot FROM (
    SELECT s.slot_number,
      LAG(s.slot_number,1,?) OVER (ORDER BY s.slot_number) AS previous_slot
    FROM daily_schedule AS s
    JOIN puzzles AS p ON p.number=s.puzzle_number AND p.publication='daily'
    WHERE s.slot_number BETWEEN ? AND ?
  ) WHERE slot_number<>previous_slot+1 ORDER BY slot_number LIMIT 1`)
    .bind(FIRST_DAILY-1,FIRST_DAILY,throughSlot).first();
  if(discontinuity)return discontinuity.previous_slot;
  const end=await db.prepare(`SELECT MAX(s.slot_number) AS last FROM daily_schedule AS s
    JOIN puzzles AS p ON p.number=s.puzzle_number AND p.publication='daily'
    WHERE s.slot_number BETWEEN ? AND ?`).bind(FIRST_DAILY,throughSlot).first();
  return end?.last??FIRST_DAILY-1;
}

// New website clients need only today's Daily, the original 14 archive
// puzzles, and a first page of released Dailies. The remaining history
// comes from /api/released as needed; it is never assembled in JS here.
async function compactState(db,at=new Date()) {
  const date=todayInMadrid(at),start=await getLaunchDate(db);
  const archived=(await db.prepare(`SELECT * FROM puzzles
    WHERE publication='archive' AND number BETWEEN 15 AND 28
    ORDER BY number`).all()).results.map(p=>toPublicPuzzle(p));
  let status='not_launched',daily=null,releasedDaily=[];
  let lastReleasedNumber=FIRST_DAILY-1,nextDailyScheduled=false;
  if(validStart(start)) {
    const offset=daysAfter(date,start);
    if(offset<0)status='upcoming';
    else {
      const target=FIRST_DAILY+offset;
      lastReleasedNumber=await releasedBoundary(db,target);
      if(lastReleasedNumber>=FIRST_DAILY) {
        const page=(await db.prepare(`SELECT s.slot_number,p.* FROM daily_schedule AS s
          JOIN puzzles AS p ON p.number=s.puzzle_number AND p.publication='daily'
          WHERE s.slot_number BETWEEN ? AND ?
          ORDER BY s.slot_number LIMIT 100`)
          .bind(FIRST_DAILY,lastReleasedNumber).all()).results;
        releasedDaily=page.map(p=>toPublicPuzzle(p,p.slot_number));
      }
      if(lastReleasedNumber===target) {
        const row=await resolvePublicPuzzle(db,target);
        if(row){
          status='live';daily=toPublicPuzzle(row,target);
          const tomorrow=await db.prepare(`SELECT 1 AS present FROM daily_schedule AS s
            JOIN puzzles AS p ON p.number=s.puzzle_number AND p.publication='daily'
            WHERE s.slot_number=?`).bind(target+1).first();
          nextDailyScheduled=!!tomorrow;
        }else status='awaiting_puzzle';
      }else status='awaiting_puzzle';
    }
  }
  return {timezone:TZ,date,status,daily,archive:archived,releasedDaily,
    lastReleasedNumber,nextDailyScheduled,
    dailyStart:validStart(start)?start:null};
}

// Paginated released archive for future website/app versions. A page-size
// limit is not a lifetime puzzle limit; callers can request the next page.
async function releasedPage(db,request,at=new Date()) {
  const u=new URL(request.url),raw=u.searchParams.get('after');
  const after=raw===null?FIRST_DAILY-1:Number(raw);
  if(!Number.isSafeInteger(after)||after<FIRST_DAILY-1||after>MAX_PUZZLE_NUMBER)
    return json({error:'Invalid archive cursor'},422);
  const start=await getLaunchDate(db);
  const offset=validStart(start)?daysAfter(todayInMadrid(at),start):-1;
  if(offset<0)return json({items:[],nextAfter:after,hasMore:false});
  const through=await releasedBoundary(db,FIRST_DAILY+offset);
  const rows=(await db.prepare(`SELECT s.slot_number,p.* FROM daily_schedule s
    JOIN puzzles p ON p.number=s.puzzle_number AND p.publication='daily'
    WHERE s.slot_number>? AND s.slot_number<=?
    ORDER BY s.slot_number LIMIT 101`).bind(after,through).all()).results;
  const items=rows.slice(0,100);
  return json({items:items.map(p=>toPublicPuzzle(p,p.slot_number)),
    nextAfter:items.length?items[items.length-1].slot_number:after,
    hasMore:rows.length>100});
}
async function state(db,at=new Date()) {
  const date=todayInMadrid(at),start=await getLaunchDate(db);
  const archived=(await db.prepare("SELECT * FROM puzzles WHERE publication='archive' AND number>=15 ORDER BY number").all()).results;
  const archive=archived.map(p=>toPublicPuzzle(p));
  let daily=null,status='not_launched',releasedDaily=[];
  if(validStart(start)) {
    const offset=daysAfter(date,start);
    if(offset<0) status='upcoming';
    else {
      const targetSlot=FIRST_DAILY+offset;
      const released=await getReleasedRows(db,targetSlot);
      // Never expose a puzzle after an unscheduled gap; released slots
      // must stay consecutive, even if an editor has made a mistake.
      for(const row of released) {
        if(row.slot_number!==FIRST_DAILY+releasedDaily.length)break;
        releasedDaily.push(toPublicPuzzle(row,row.slot_number));
      }
      const latest=releasedDaily[releasedDaily.length-1];
      if(latest?.number===targetSlot) {
        status='live';daily=latest;
      } else {
        // No repeat, no fabricated puzzle, and no HTTP 503 just because
        // future slots haven't been curated yet.
        status='awaiting_puzzle';
      }
    }
  }
  return {timezone:TZ,date,status,daily,archive,releasedDaily,
    dailyStart:validStart(start)?start:null};
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
  if(!Number.isInteger(puzzleNumber)||puzzleNumber<1||puzzleNumber>MAX_PUZZLE_NUMBER||
    typeof playerId!=='string'||!UUID_RE.test(playerId)||typeof steps!=='string'||steps.length>MAX_TRACE||
    !Number.isInteger(elapsed)||elapsed<0||elapsed>86400*14){return json({error:'Invalid submission'},422);}
  const p=await resolvePublicPuzzle(db,puzzleNumber);
  const date=todayInMadrid(),launch=await getLaunchDate(db);
  if(!p||!unlocked(p,date,launch,puzzleNumber))return json({error:'Puzzle not released'},404);
  if(!validateTrace(p,steps))return json({error:'Completion cannot be verified'},422);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(steps)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  // Any prior verified offline practice result means this is not a fair
  // competitive first attempt. Existing online first attempts are untouched.
  const hadOffline=await db.prepare('SELECT 1 AS found FROM offline_personal_bests WHERE puzzle_number=? AND anonymous_player_id=?')
    .bind(puzzleNumber,playerId).first();
  const write=hadOffline?{meta:{changes:0}}:
    await db.prepare('INSERT OR IGNORE INTO first_attempts (puzzle_number, anonymous_player_id, moves, elapsed_seconds, trace_sha256) VALUES (?,?,?,?,?)')
    .bind(puzzleNumber,playerId,steps.length,elapsed,hash).run();
  const agg=await db.prepare('SELECT COUNT(*) as count, ROUND(AVG(moves),1) as average FROM first_attempts WHERE puzzle_number=?').bind(puzzleNumber).first();
  // Only a verified completed play can obtain an optimal route.
  // Routes live exclusively in D1, not in this public Worker or game assets.
  const sol=await db.prepare('SELECT route FROM solution_routes WHERE puzzle_number=?').bind(p.number).first();
  const optimalRoute=sol?.route;
  if(typeof optimalRoute!=='string'||optimalRoute.length!==p.optimum||!validateTrace(p,optimalRoute))
    throw Error('Missing or invalid private route for puzzle '+puzzleNumber);
  return json({verified:true, firstRecorded:!!write.meta?.changes, firstAttemptExcluded:!!hadOffline, puzzleNumber,
    moves:steps.length, optimum:p.optimum, globalAverage:agg.average, sampleSize:agg.count,
    optimalRoute});
}

// Factory 5.10.19: verify downloaded-Archive/offline results without changing
// first_attempts or its global average. Requires offline_personal_bests D1 table.
async function offlineAttempt(request,db){
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);
 if(Number(request.headers.get('content-length')||0)>4096)return json({error:'Too large'},413);
 let data;try{const raw=await request.text();if(raw.length>4096)return json({error:'Too large'},413);data=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
 const number=data.puzzleNumber,playerId=data.playerId,steps=data.steps,elapsed=data.elapsedSeconds;
 if(!Number.isInteger(number)||number<1||number>MAX_PUZZLE_NUMBER||
    typeof playerId!=='string'||!UUID_RE.test(playerId)||typeof steps!=='string'||
    !steps.length||steps.length>MAX_TRACE||
    !Number.isInteger(elapsed)||elapsed<0||elapsed>86400*14)return json({error:'Invalid submission'},422);
 const p=await resolvePublicPuzzle(db,number);
 if(!p||!unlocked(p,todayInMadrid(),await getLaunchDate(db),number))return json({error:'Puzzle not released'},404);
 if(!validateTrace(p,steps))return json({error:'Completion cannot be verified'},422);
 const hash=await digest(steps);
 await db.prepare(`INSERT INTO offline_personal_bests
    (puzzle_number,anonymous_player_id,moves,elapsed_seconds,trace_sha256,updated_at)
    VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(puzzle_number,anonymous_player_id) DO UPDATE SET
    moves=excluded.moves, elapsed_seconds=excluded.elapsed_seconds,
    trace_sha256=excluded.trace_sha256, updated_at=excluded.updated_at
    WHERE excluded.moves<offline_personal_bests.moves OR
    (excluded.moves=offline_personal_bests.moves AND excluded.elapsed_seconds<offline_personal_bests.elapsed_seconds)`)
  .bind(number,playerId,steps.length,elapsed,hash).run();
 return json({verified:true,offlineRecorded:true,firstRecorded:false,
   puzzleNumber:number,moves:steps.length,optimum:p.optimum});
}

// Factory 5.10.3 private gate. The access key is a Cloudflare Worker SECRET,
// never a source-code constant. A signed HttpOnly session lasts 14 days.
const FACTORY_COOKIE='wirlox_factory_session';
const FACTORY_SESSION_SECONDS=14*24*60*60;
const FACTORY_MAX_PUZZLE=MAX_PUZZLE_NUMBER;
const FACTORY_LOGIN_HTML="<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>WIRLOX · Private Factory</title><meta name=\"robots\" content=\"noindex,nofollow\"><style>html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,sans-serif;background:#090f1b;color:#e7f1fd}body{display:grid;min-height:100dvh;place-items:center}.card{box-sizing:border-box;width:min(420px,92vw);padding:28px;border:1px solid #334a66;border-radius:18px;background:#152138;box-shadow:0 18px 55px #0007}h1{margin:0 0 8px;font-size:26px;letter-spacing:.10em}p{color:#adbed5;line-height:1.5}label{display:block;margin:22px 0 9px;font-size:13px}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #6688a8;border-radius:8px;background:#0e182a;color:#fff;font-size:16px}button{width:100%;padding:13px;margin-top:15px;border:1px solid #83c6ee;border-radius:9px;background:#224767;color:#fff;font-size:16px;font-weight:700;cursor:pointer}#error{color:#ffb9b9;min-height:1em}</style></head><body><main class=\"card\"><h1>WIRLOX</h1><p>Private Factory · puzzle testing only.<br>The public game is unchanged.</p><form id=\"gate\"><label for=\"password\">Private access key</label><input id=\"password\" type=\"password\" autocomplete=\"current-password\" required autofocus><button type=\"submit\">Open private puzzles</button><p id=\"error\" role=\"status\"></p></form></main><script>document.getElementById('gate').addEventListener('submit',async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;document.getElementById('error').textContent='';try{const r=await fetch('/api/factory/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:document.getElementById('password').value}),cache:'no-store'});if(!r.ok){document.getElementById('error').textContent=r.status===401?'Access key not recognised.':'Private access unavailable.';return;}location.replace('/factory');}catch{document.getElementById('error').textContent='Unable to connect.';}finally{b.disabled=false;}});</script></body></html>";
const FACTORY_HEADERS={...NO_CACHE,'X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
function strongFactoryKey(env){return typeof env.FACTORY_ACCESS_KEY==='string'&&env.FACTORY_ACCESS_KEY.length>=18;}
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
 // D1 .all() is a single page; read every page as the private library grows.
 const rows=[];let after=14;
 while(true){
  const page=(await db.prepare('SELECT * FROM puzzles WHERE number>? ORDER BY number LIMIT 200').bind(after).all()).results;
  if(!page.length)break;
  rows.push(...page);after=page[page.length-1].number;
 }
 return json({puzzles:rows.map(p=>toPublicPuzzle(p))});
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
  if(!Number.isInteger(number)||number<1||number>MAX_PUZZLE_NUMBER||
     typeof playerId!=='string'||!UUID_RE.test(playerId)||
     typeof feel!=='string'||!['','Clever','Straightforward','Grindy'].includes(feel)||
     typeof note!=='string'||note.length>240||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(note))
    return json({error:'Invalid feedback'},422);
  const puzzle=isPrivate
    ?await db.prepare('SELECT number, publication FROM puzzles WHERE number=?').bind(number).first()
    :await resolvePublicPuzzle(db,number);
  if(!puzzle)return json({error:'Puzzle not found'},404);
  if(!isPrivate){
    const launch=await getLaunchDate(db);
    if(!unlocked(puzzle,todayInMadrid(),launch,number))return json({error:'Puzzle not released'},404);
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


// Private-only daily schedule administration. This page is separate from the
// game and does not alter any established WIRLOX layout or CSS.
const SCHEDULE_HEADERS={...FACTORY_HEADERS,'Content-Type':'text/html; charset=utf-8'};
const SCHEDULE_PAGE=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>WIRLOX · Daily Schedule · 5.10.9</title>
<style>html{color-scheme:dark}body{font:15px system-ui,-apple-system,sans-serif;background:#0a1120;color:#e2edff;max-width:790px;margin:25px auto;padding:0 18px}h1{font-size:24px;letter-spacing:.09em}p,small{color:#b1c5dc;line-height:1.55}section{border:1px solid #38516f;border-radius:13px;background:#15233c;padding:18px;margin:16px 0}label{display:block;margin:15px 0 5px}select,input,button{font:inherit;color:#e6f3ff;border:1px solid #6686a7;border-radius:7px;background:#101d33;padding:10px;max-width:100%}select,input{width:100%;box-sizing:border-box}button{background:#224867;cursor:pointer;margin:12px 7px 0 0}button:disabled{opacity:.5;cursor:default}ul{padding-left:23px;line-height:1.7}li{margin:3px 0}#message{min-height:1.5em}a{color:#a9dfff}</style></head><body><h1>WIRLOX · PRIVATE DAILY SCHEDULE</h1><p>Factory 5.10.9 · Protected planning only. The public game is unchanged. <a href="/factory">Back to private puzzles</a></p><p id="message" role="status">Loading schedule…</p><section><h2>Launch</h2><p id="launchStatus"></p><label for="startDate">First daily release (Madrid calendar date)</label><input id="startDate" type="date"><button id="startButton">Schedule launch</button><button id="pauseButton" hidden>Cancel future launch</button><small>Activation requires confirmation. No puzzle goes live while PAUSED. Once the first day has begun, the launch date is locked.</small></section><section><h2>Replace a future puzzle</h2><label for="slot">Daily slot</label><select id="slot"></select><label for="replacement">Replace with</label><select id="replacement"></select><button id="replaceButton">Apply replacement / swap</button><small>An unused reserve replaces the slot and leaves the original in reserve. Choosing a different future slot swaps those two puzzles. Already released slots cannot be changed.</small></section><section><h2>Scheduled puzzles</h2><ul id="schedule"></ul><small>This list is private. It never exposes unreleased puzzles to the public archive.</small></section>
<script>(()=>{'use strict';const $=id=>document.getElementById(id);let data=null;const endpoint='/api/factory/schedule';const msg=t=>{$('message').textContent=t};
async function call(path,method='GET',body){const r=await fetch(endpoint+path,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(r.status===401){location.replace('/factory');throw Error('Session expired');}const j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j;}
const opt=(sel,value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;sel.append(o)};
function replacements(){if(!data)return;const slot=Number($('slot').value);$('replacement').replaceChildren();for(const p of data.reserves)opt($('replacement'),p.number,\`Reserve #\${p.number} · \${p.words.join(' / ')}\`);for(const s of data.slots){if(s.slot!==slot && !s.locked)opt($('replacement'),s.puzzleNumber,\`Swap with slot \${s.slot} · \${s.words.join(' / ')}\`);}$('replaceButton').disabled=!$('replacement').options.length;}
async function refresh(){data=await call('');$('launchStatus').textContent=data.dailyStart?\`Scheduled for \${data.dailyStart} · \${data.status}\`:'PAUSED — no public Daily releases';$('startButton').disabled=data.status!=='not_launched';$('startDate').disabled=data.status!=='not_launched';$('pauseButton').hidden=data.status!=='upcoming';$('slot').replaceChildren();$('schedule').replaceChildren();for(const s of data.slots){if(!s.locked)opt($('slot'),s.slot,\`Puzzle \${s.slot} · \${s.words.join(' / ')}\`);const li=document.createElement('li');li.textContent=\`\${s.slot}: \${s.words.join(' / ')} · source #\${s.puzzleNumber}\${s.locked?' · RELEASED':''}\`;$('schedule').append(li);}replacements();msg('Schedule loaded · '+data.slots.length+' slots');}
$('slot').addEventListener('change',replacements);
$('replaceButton').addEventListener('click',async()=>{const slot=Number($('slot').value),puzzleNumber=Number($('replacement').value);if(!slot||!puzzleNumber||!confirm(\`Change future Daily puzzle \${slot} to source #\${puzzleNumber}?\`))return;try{await call('/replace','POST',{slot,puzzleNumber});await refresh();msg('Future puzzle updated. No released puzzles were changed.');}catch(e){msg(e.message);}});
$('startButton').addEventListener('click',async()=>{const startDate=$('startDate').value;if(!startDate)return msg('Choose a launch date.');if(!confirm(\`Start publishing WIRLOX Daily at Madrid midnight on \${startDate}?\`))return;try{await call('/launch','POST',{startDate,confirmation:'START DAILY'});await refresh();msg('Daily launch scheduled.');}catch(e){msg(e.message);}});
$('pauseButton').addEventListener('click',async()=>{if(!confirm('Cancel the UPCOMING launch and return to PAUSED?'))return;try{await call('/pause','POST',{confirmation:'PAUSE DAILY'});await refresh();msg('Future launch cancelled. Daily is PAUSED.');}catch(e){msg(e.message);}});
refresh().catch(e=>msg(e.message));})();</script></body></html>`;
async function scheduleAdmin(db,at=new Date()){
  const today=todayInMadrid(at),start=await getLaunchDate(db);
  const offset=validStart(start)?daysAfter(today,start):-1;
  const status=!validStart(start)?'not_launched':offset<0?'upcoming':'live';
  // The schedule is extendable; do not demand exactly 28 entries.
  const scheduled=[];let after=FIRST_DAILY-1;
  while(true) {
    const page=(await db.prepare(`SELECT s.slot_number,s.puzzle_number,p.word1,p.word2,p.word3,p.mood
      FROM daily_schedule s JOIN puzzles p ON p.number=s.puzzle_number
      WHERE s.slot_number>? ORDER BY s.slot_number LIMIT 200`).bind(after).all()).results;
    if(!page.length)break;
    scheduled.push(...page);
    after=page[page.length-1].slot_number;
  }
  if(scheduled.some((s,i)=>s.slot_number!==FIRST_DAILY+i))throw Error('Daily schedule has a gap');
  const rows=[];let reserveAfter=0;
  while(true){
    const page=(await db.prepare(`SELECT number,word1,word2,word3,mood FROM puzzles
      WHERE publication='daily' AND number>? AND number NOT IN
      (SELECT puzzle_number FROM daily_schedule) ORDER BY number LIMIT 200`).bind(reserveAfter).all()).results;
    if(!page.length)break;
    rows.push(...page);reserveAfter=page[page.length-1].number;
  }
  return {today,status,dailyStart:validStart(start)?start:null,
    slots:scheduled.map(s=>({slot:s.slot_number,puzzleNumber:s.puzzle_number,mood:s.mood,
      words:[s.word1,s.word2,s.word3],locked:offset>=0 && s.slot_number<=FIRST_DAILY+offset})),
    reserves:rows.map(p=>({number:p.number,mood:p.mood,words:[p.word1,p.word2,p.word3]}))};
}
async function scheduleMutation(request,db,kind){
  if(request.headers.get('Origin')!==new URL(request.url).origin)return json({error:'Not allowed'},403);
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);
  if(Number(request.headers.get('content-length')||0)>1024)return json({error:'Too large'},413);
  let v;try{const raw=await request.text();if(raw.length>1024)return json({error:'Too large'},413);v=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
  const today=todayInMadrid(),start=await getLaunchDate(db);
  if(kind==='launch'){
    if(start!=='PAUSED')return json({error:'Launch is already scheduled or active'},409);
    if(v?.confirmation!=='START DAILY'||!validStart(v?.startDate)||v.startDate<=today)
      return json({error:'Choose a future Madrid date and confirm launch'},422);
    const check=await scheduleAdmin(db);
    if(check.slots.length<1)return json({error:'Schedule has no first puzzle'},503);
    await db.prepare("UPDATE settings SET value=? WHERE key='daily_start_date' AND value='PAUSED'").bind(v.startDate).run();
    return json({ok:true,status:'upcoming',dailyStart:v.startDate});
  }
  if(kind==='pause'){
    if(v?.confirmation!=='PAUSE DAILY'||!validStart(start)||start<=today)
      return json({error:'Only an upcoming launch may be cancelled'},409);
    await db.prepare("UPDATE settings SET value='PAUSED' WHERE key='daily_start_date' AND value=?").bind(start).run();
    return json({ok:true,status:'not_launched'});
  }
  if(kind!=='replace')return json({error:'Not found'},404);
  const slot=v?.slot,number=v?.puzzleNumber;
  if(!Number.isInteger(slot)||slot<FIRST_DAILY||slot>MAX_PUZZLE_NUMBER||
     !Number.isInteger(number)||number<FIRST_DAILY)
    return json({error:'Invalid slot or candidate'},422);
  const schedule=await scheduleAdmin(db);
  const target=schedule.slots.find(s=>s.slot===slot);
  if(!target||target.locked)return json({error:'That puzzle is already released'},409);
  if(target.puzzleNumber===number)return json({error:'Already in that slot'},409);
  const candidate=await db.prepare("SELECT number FROM puzzles WHERE number=? AND publication='daily'").bind(number).first();
  if(!candidate)return json({error:'Candidate is not an unreleased daily puzzle'},422);
  const other=schedule.slots.find(s=>s.puzzleNumber===number);
  if(other?.locked)return json({error:'Cannot move an already released puzzle'},409);
  if(other){
    // 3 updates in a single D1 transaction avoid an intermediate UNIQUE clash.
    await db.batch([
      db.prepare('UPDATE daily_schedule SET puzzle_number=NULL WHERE slot_number=? AND puzzle_number=?').bind(slot,target.puzzleNumber),
      db.prepare('UPDATE daily_schedule SET puzzle_number=? WHERE slot_number=? AND puzzle_number=?').bind(target.puzzleNumber,other.slot,number),
      db.prepare('UPDATE daily_schedule SET puzzle_number=? WHERE slot_number=? AND puzzle_number IS NULL').bind(number,slot)
    ]);
  }else{
    await db.prepare('UPDATE daily_schedule SET puzzle_number=? WHERE slot_number=? AND puzzle_number=?')
      .bind(number,slot,target.puzzleNumber).run();
  }
  const done=await db.prepare('SELECT puzzle_number FROM daily_schedule WHERE slot_number=?').bind(slot).first();
  if(done?.puzzle_number!==number)return json({error:'Schedule changed concurrently; refresh and retry'},409);
  return json({ok:true,slot,puzzleNumber:number,swappedWith:other?.slot??null});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    // Keep the private scheduler on the known-working /factory Worker route.
    // Some deployed asset routing configurations intercept nested /factory/* paths.
    if((url.pathname==='/factory'||url.pathname==='/factory/')&&request.method==='GET'){
      if(url.searchParams.get('view')==='schedule'){
        if(!await hasFactorySession(request,env))return Response.redirect(new URL('/factory',url),302);
        return new Response(SCHEDULE_PAGE,{headers:SCHEDULE_HEADERS});
      }
      return serveFactory(request,env);
    }
    if((url.pathname==='/factory/schedule'||url.pathname==='/factory/schedule/')&&request.method==='GET'){
      if(!await hasFactorySession(request,env))return Response.redirect(new URL('/factory',url),302);
      return new Response(SCHEDULE_PAGE,{headers:SCHEDULE_HEADERS});
    }
    if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
    try{
      if(url.pathname==='/api/factory/login'&&request.method==='POST')return loginFactory(request,env);
      if(url.pathname.startsWith('/api/factory/')){
        if(!await hasFactorySession(request,env))return json({error:'Private access required'},401);
        if(!env.DB)return json({error:'D1 binding not configured'},503);
        if(url.pathname==='/api/factory/puzzles'&&request.method==='GET')return privateFactoryPuzzles(env.DB);
        if(url.pathname==='/api/factory/attempt'&&request.method==='POST')return privateFactoryAttempt(request,env.DB);
        if(url.pathname==='/api/factory/feedback'&&request.method==='POST')return savePuzzleFeedback(request,env.DB,true);
        // Browser-facing schedule uses /api/*, which Cloudflare routes to the Worker reliably.
        if(url.pathname==='/api/factory/schedule/page'&&request.method==='GET')return new Response(SCHEDULE_PAGE,{headers:SCHEDULE_HEADERS});
        if(url.pathname==='/api/factory/schedule'&&request.method==='GET')return json(await scheduleAdmin(env.DB));
        if(url.pathname==='/api/factory/schedule/replace'&&request.method==='POST')return scheduleMutation(request,env.DB,'replace');
        if(url.pathname==='/api/factory/schedule/launch'&&request.method==='POST')return scheduleMutation(request,env.DB,'launch');
        if(url.pathname==='/api/factory/schedule/pause'&&request.method==='POST')return scheduleMutation(request,env.DB,'pause');
        return json({error:'Not found'},404);
      }
      if(!env.DB)return json({error:'D1 binding not configured'},503);
      if(url.pathname==='/api/health'&&request.method==='GET'){
        const [row,start]=await Promise.all([env.DB.prepare('SELECT COUNT(*) as total FROM puzzles').first(),getLaunchDate(env.DB)]);
        return json({ok:true,puzzleCount:row.total,dailyConfigured:validStart(start),timezone:TZ});
      }
      if(url.pathname==='/api/state'&&request.method==='GET')return json(await (url.searchParams.get('compact')==='1'?compactState(env.DB):state(env.DB)));
      if(url.pathname==='/api/released'&&request.method==='GET')return releasedPage(env.DB,request);
      if(url.pathname==='/api/attempt'&&request.method==='POST')return attempt(request,env.DB);
      if(url.pathname==='/api/offline-attempt'&&request.method==='POST')return offlineAttempt(request,env.DB);
      if(url.pathname==='/api/feedback'&&request.method==='POST')return savePuzzleFeedback(request,env.DB,false);
      return json({error:'Not found'},404);
    }catch(e){console.error('WIRLOX API error:',e?.message||String(e));return json({error:'Service temporarily unavailable'},503);}
  }
};
// For local tests only; not used as Worker exports.
export {todayInMadrid,daysAfter,validateTrace,validStart,state,compactState,releasedBoundary,releasedPage,resolvePublicPuzzle,unlocked,scheduleAdmin,scheduleMutation,getReleasedRows};
