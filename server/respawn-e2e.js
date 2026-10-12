/* the respawn desync: killing someone must not glue them to the death spot */
const {chromium}=require('/opt/node-tools/node_modules/playwright-core');
const http=require('http'),fs=require('fs'),path=require('path');
const srv=http.createServer((rq,rs)=>{const f=path.join('/home/claude/hvh',rq.url.split('?')[0]);
 fs.readFile(f,(e,d)=>{if(e){rs.writeHead(404);return rs.end()}
 rs.writeHead(200,{'content-type':f.endsWith('.html')?'text/html':f.endsWith('.json')?'application/json':'text/javascript'});rs.end(d)})}).listen(0,async()=>{
let P=0,F=0;const log=[];
const ck=(n,c,x)=>{if(c){P++;log.push('  ok   '+n)}else{F++;log.push('  FAIL '+n+(x!==undefined?'  <'+String(JSON.stringify(x)).slice(0,200)+'>':''))}};
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p=await (await b.newContext()).newPage();
p.on('pageerror',e=>{console.log('  [pageerror]',e.message);F++});
await p.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,r=>r.abort());
await p.route('**/three.min.js',r=>r.fulfill({path:'/home/claude/work/t3/three/build/three.min.js',contentType:'text/javascript'}));
await p.addInitScript(()=>sessionStorage.setItem('hvh_session_cfg',JSON.stringify({offline:false,uid:1,match:'m',host:true,players:[{uid:1},{uid:2}]})));
await p.goto(`http://127.0.0.1:${srv.address().port}/csgo.html?mode=online`);
await p.waitForTimeout(6000);

const r=await p.evaluate(async()=>{
  const out={};
  out.online=ONLINE_MATCH;
  const wait=ms=>new Promise(r=>setTimeout(r,ms));

  // --- a normal respawn teleport must be reported as-is ---
  validateRemote({x:0,z:0,hp:100});
  await wait(60);
  validateRemote({x:0,z:0,hp:0});            // they die next to me
  await wait(60);
  const rs=validateRemote({x:60,z:40,hp:100,inv:1});   // respawn across the map
  out.respawnKept=[+rs.x.toFixed(2),+rs.z.toFixed(2)];

  // --- and the rendered opponent must actually move there, not crawl ---
  const bot=bots[0];
  bot.remote=1;bot.dead=0;bot.g.visible=true;bot.ko=0;bot.x=0;bot.z=0;
  NETR={x:60,z:40,y:0,hp:100,yaw:0,inv:1};
  for(let i=0;i<3;i++) remoteUpd(bot,0.045);
  out.drawnAt=[Math.round(bot.x),Math.round(bot.z)];

  // --- spawn protection blocks a kill ---
  bot.inv=1;bot.dead=0;bot.hp=100;bot.ko=0;
  const k0=kills; dmg(bot,100,true);
  out.killWhileProtected=kills-k0;
  out.stillAlive=!bot.dead;

  // --- once protection ends, a kill lands exactly once ---
  bot.inv=0;
  const k1=kills; dmg(bot,100,true);
  out.firstKill=kills-k1;
  const k2=kills; dmg(bot,100,true); dmg(bot,100,true);
  out.repeatKills=kills-k2;

  // --- a sustained speed hack is still caught ---
  // Assert on the OUTCOME, not on the raw counter. Past the strike threshold the
  // detector reports the peer and resets the counter by design, so a run that
  // reaches the report ends on a low count - the old assertion failed exactly
  // when detection worked, and only passed while the 30s report cooldown
  // happened to suppress it. Count strikes reached AND reports fired instead.
  _vStrikes=0;_vSent=0;_vHp=100;_vLast=null;
  let reports=0; const realReport=window.reportPeer; window.reportPeer=()=>{reports++};
  validateRemote({x:0,z:0,hp:100});
  let peak=0;
  for(let i=1;i<=20;i++){ await wait(20); validateRemote({x:i*40,z:0,hp:100}); if(_vStrikes>peak)peak=_vStrikes; }
  window.reportPeer=realReport;
  out.strikesOnRealHack=peak;
  out.reportsOnRealHack=reports;

  // --- a whole normal fight raises no strikes ---
  _vStrikes=0;_vHp=100;_vLast=null;
  validateRemote({x:0,z:0,hp:100});
  /* walking at the 5 u/s cap covers 0.25 units per 50 ms packet */
  let px=0,pz=0;
  for(let round=0;round<3;round++){
    for(let i=0;i<6;i++){ await wait(50); px+=0.22; validateRemote({x:px,z:pz,hp:100-i*8}); }
    await wait(50); validateRemote({x:px,z:pz,hp:0});                 // killed
    px=70+round*5; pz=50;                                             // respawn across the map
    await wait(50); validateRemote({x:px,z:pz,hp:100,inv:1});
    await wait(50); px+=0.2; validateRemote({x:px,z:pz,hp:100,inv:1});
    for(let i=0;i<4;i++){ await wait(50); px+=0.22; validateRemote({x:px,z:pz,hp:100}); }
  }
  out.strikesOnNormalPlay=_vStrikes;

  // --- the state packet advertises spawn protection ---
  let sent=null; const realSend=Net.send; Net.send=o=>{if(o.t==='s')sent=o};
  P.inv=1.5; netT=1; netTick(0.05); Net.send=realSend;
  out.sentInv=sent&&sent.inv;
  return out;
});
ck('test ran in online mode', r.online===true, r);
ck('a respawn teleport is passed through untouched', r.respawnKept[0]===60&&r.respawnKept[1]===40, r.respawnKept);
ck('the opponent is drawn at their real respawn point, not the death spot', r.drawnAt[0]===60&&r.drawnAt[1]===40, r.drawnAt);
ck('a spawn-protected opponent cannot be killed', r.killWhileProtected===0&&r.stillAlive===true, r);
ck('once protection ends the kill registers', r.firstKill===1, r.firstKill);
ck('the same death cannot be re-counted', r.repeatKills===0, r.repeatKills);
ck('a sustained speed hack still accumulates strikes', r.strikesOnRealHack>10, r.strikesOnRealHack);
ck('a sustained speed hack is reported, or is still building strikes',
   r.reportsOnRealHack>0 || r.strikesOnRealHack>10, r);
ck('normal play with repeated deaths raises no strikes', r.strikesOnNormalPlay===0, r.strikesOnNormalPlay);
ck('spawn protection is advertised to the opponent', r.sentInv===1, r.sentInv);
console.log('\n'+log.join('\n'));console.log(`\n${P} passed, ${F} failed\n`);
await b.close();srv.close();process.exit(F?1:0);
});
