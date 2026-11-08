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
  return json({verified:true, firstRecorded:!!write.meta?.changes, puzzleNumber,
    moves:steps.length, optimum:p.optimum, globalAverage:agg.average, sampleSize:agg.count});
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(!env.DB)return json({error:'D1 binding not configured'},503);
    try{
      if(url.pathname==='/api/health'&&request.method==='GET'){
        const [row,start]=await Promise.all([env.DB.prepare('SELECT COUNT(*) as total FROM puzzles').first(),getLaunchDate(env.DB)]);
        return json({ok:true,puzzleCount:row.total,dailyConfigured:validStart(start),timezone:TZ});
      }
      if(url.pathname==='/api/state'&&request.method==='GET')return json(await state(env.DB));
      if(url.pathname==='/api/attempt'&&request.method==='POST')return attempt(request,env.DB);
      return json({error:'Not found'},404);
    }catch(e){console.error('WIRLOX API error:',e?.message||String(e));return json({error:'Service temporarily unavailable'},503);}
  }
};
// For local tests only; not used as Worker exports.
export {todayInMadrid,daysAfter,validateTrace,validStart};
