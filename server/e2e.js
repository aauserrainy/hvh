/* End-to-end: real backend + two real browser clients through the real menu. */
const {chromium}=require('/opt/node-tools/node_modules/playwright-core');
const path=require('path'),fs=require('fs'),os=require('os');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-'));
process.env.DB_FILE=path.join(tmp,'e2e.db');
process.env.STATIC_DIR='/home/claude/hvh';
process.env.TRUST_PROXY='0';
const {server}=require('/home/claude/hvh/server/server.js');
let P=0,F=0;const log=[];
const ck=(n,c,x)=>{if(c){P++;log.push('  ok   '+n)}else{F++;log.push('  FAIL '+n+(x!==undefined?'  <'+String(JSON.stringify(x)).slice(0,180)+'>':''))}};
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const ARGS=['--no-sandbox','--disable-features=WebRtcHideLocalIpsWithMdns','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'];
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:ARGS});
 /* B gets its own browser: two contexts in one browser share an ICE stack and will
    not complete a peer connection to each other reliably. */
 const b2=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:ARGS});
 const mk=async(tag,br)=>{const c=await (br||b).newContext({viewport:{width:1100,height:720}});const p=await c.newPage();
   p.on('pageerror',e=>{console.log('  [pageerror '+tag+']',e.message);F++});
   p.on('console',m=>{if(m.type()==='error'&&!/favicon/.test(m.text()))console.log('  [console '+tag+']',m.text().slice(0,140))});
   await p.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,r=>r.abort());
   await p.route('**/three.min.js',r=>r.fulfill({path:'/home/claude/work/t3/three/build/three.min.js',contentType:'text/javascript'}));
   await p.goto(base+'/index.html',{waitUntil:'domcontentloaded'});
   await p.waitForTimeout(700);return p};

 const A=await mk('A'), B=await mk('B',b2);

 // ---- register through the UI ----
 await A.click('#swapBtn');
 await A.fill('#u','ownerone'); await A.fill('#p','ownerpass1'); await A.fill('#c','ownerpass1');
 await A.click('#authGo');
 await A.waitForSelector('#menu:not(.hide)',{timeout:15000});
 ck('A registers through the UI and lands on the menu', true);
 ck('A shows UID 1', (await A.textContent('#uid')).includes('UID 1'), await A.textContent('#uid'));
 ck('A is flagged as owner', !(await A.getAttribute('#ownTag','class')).includes('hide'));
 ck('owner dashboard tile appears for UID 1', await A.$('#adminBtn')!==null);

 await B.click('#swapBtn');
 await B.fill('#u','playertwo'); await B.fill('#p','playerpass1'); await B.fill('#c','playerpass1');
 await B.click('#authGo');
 await B.waitForSelector('#menu:not(.hide)',{timeout:15000});
 ck('B registers and gets UID 2', (await B.textContent('#uid')).includes('UID 2'), await B.textContent('#uid'));
 ck('B gets no owner dashboard', await B.$('#adminBtn')===null);

 // duplicate name is refused in the UI
 const C=await mk('C'); await C.click('#swapBtn');
 await C.fill('#u','OwnerOne'); await C.fill('#p','whatever12'); await C.fill('#c','whatever12');
 await C.click('#authGo'); await C.waitForTimeout(1200);
 ck('duplicate username shows an error in the UI', /taken/i.test(await C.textContent('#authMsg')), await C.textContent('#authMsg'));
 await C.close();

 // ---- host + join ----
 await A.click('#aHost');
 await A.waitForSelector('.code',{timeout:10000});
 const code=(await A.textContent('.code')).trim();
 ck('hosting shows a match code', /^[A-Z0-9]{6}$/.test(code), code);
 ck('lobby shows a waiting slot', (await A.textContent('.slots')).includes('waiting'));

 await B.fill('#joinCode',code);
 await B.click('#joinGo');
 await Promise.all([
   A.waitForFunction(()=>document.getElementById('game').style.display==='block',{timeout:40000}),
   B.waitForFunction(()=>document.getElementById('game').style.display==='block',{timeout:40000})]);
 ck('both clients launch the game when the lobby fills', true);
 /* wait for the peer link rather than guessing a sleep */
 let linked=false;
 for(let i=0;i<40 && !linked;i++){
   await A.waitForTimeout(1000);
   try{ linked = await A.frame({url:/csgo\.html/}).evaluate(()=>!!window.Net && Net.open); }catch(e){}
 }
 if(!linked){ try{ console.log('  [link status A]', await A.frame({url:/csgo\.html/}).evaluate(()=>({p:!!Net.platform,s:(document.getElementById('hvh-st')||{}).textContent}))); }catch(e){} }

 // ---- inside the match: ranked ruleset + peer link ----
 const inA=A.frameLocator('#game');
 const state=await A.frame({url:/csgo\.html/}).evaluate(()=>({
   online:ONLINE_MATCH, speed:S.speed, manip:S.manip, magic:S.magic, bots:S.bots,
   canManip:canManip(), canMagic:canMagic(), moveSpeed:moveSpeed(),
   netOpen:Net.open, route:Net.route, slot:window.CFG_SLOT,
   blockedSpeedBump:(()=>{S.speed=12;return moveSpeed()})(),
   botTabExists:Object.keys(SPEC).includes('Bots'),
   botInMisc:JSON.stringify(SPEC.Misc).includes("'bots'")
 }));
 ck('the game knows it is an online match', state.online===true, state);
 ck('manipulation is off in an online match', state.canManip===false, state);
 ck('magic bullet is off in an online match', state.canMagic===false, state);
 ck('move speed is capped at 5 even after setting it to 12', state.blockedSpeedBump===5, state.blockedSpeedBump);
 ck('bot settings live in their own BOT tab', state.botTabExists && !state.botInMisc, state);
 ck('online and offline configs use separate slots', state.slot==='hvhcfg_online', state.slot);
 ck('the two players are connected peer to peer', state.netOpen===true, {open:state.netOpen,route:state.route});

 const fB=B.frame({url:/csgo\.html/});
 const bState=await fB.evaluate(()=>({netOpen:Net.open,online:ONLINE_MATCH}));
 ck('the second client is connected too', bState.netOpen===true, bState);

 // the menu refuses a blocked setting
 const refused=await A.frame({url:/csgo\.html/}).evaluate(()=>{
   const before=S.manip; M.style.display='block'; show('Rage');
   const row=[...pg.querySelectorAll('.r')].find(r=>r.title==='Not available in an online match');
   if(row) row.querySelector('.cb')?.click();
   return {had:!!row, before, after:S.manip};
 });
 ck('a blocked setting is marked and cannot be switched on', refused.had && refused.after===false, refused);

 // peer movement validation flags a teleport without rewriting where they are.
 // Rewriting it was a bug: it dragged a respawning opponent back to the spot
 // where they died, i.e. on top of whoever killed them.
 const vr=await A.frame({url:/csgo\.html/}).evaluate(()=>{
   _vLast=null;_vStrikes=0;_vHp=100;
   validateRemote({x:0,z:0,hp:100}); const t0=performance.now();
   while(performance.now()-t0<60);
   const r=validateRemote({x:400,z:0,hp:100});
   const flagged=_vStrikes;
   // and a legitimate respawn is not flagged at all
   _vLast=null;_vStrikes=0;_vHp=100;
   validateRemote({x:0,z:0,hp:100});
   const t1=performance.now(); while(performance.now()-t1<60);
   validateRemote({x:0,z:0,hp:0});
   const t2=performance.now(); while(performance.now()-t2<60);
   const rs=validateRemote({x:400,z:0,hp:100,inv:1});
   return {x:r.x, flagged, respawnX:rs.x, respawnStrikes:_vStrikes};
 });
 ck('a teleporting opponent is flagged', vr.flagged>0, vr);
 ck('their reported position is left alone, not rewritten', vr.x===400, vr);
 ck('a legitimate respawn is not flagged', vr.respawnStrikes===0 && vr.respawnX===400, vr);

 // ---- offline mode ----
 const D=await mk('D');
 await D.click('#offBtn');
 await D.waitForFunction(()=>document.getElementById('game').style.display==='block',{timeout:30000});
 await D.waitForTimeout(5000);
 const off=await D.frame({url:/csgo\.html/}).evaluate(()=>({
   online:ONLINE_MATCH, canManip:(S.manip=true,canManip()), speed:(S.speed=11,moveSpeed()),
   slot:window.CFG_SLOT, tag:document.body.innerText.includes('OFFLINE')}));
 ck('offline mode runs without an account', off.online===false, off);
 ck('offline keeps manipulation available', off.canManip===true, off);
 ck('offline has no speed cap', off.speed===11, off.speed);
 ck('offline shows an OFFLINE indicator', off.tag===true, off);
 ck('offline uses its own config slot', off.slot==='hvhcfg_offline', off.slot);
 await D.close();

 // ---- admin dashboard in the browser ----
 await A.evaluate(()=>{const g=document.getElementById('game');g.src='about:blank';g.style.display='none'});
 await A.goto(base+'/admin.html',{waitUntil:'domcontentloaded'});
 await A.waitForTimeout(1800);
 ck('owner can open the dashboard', (await A.textContent('#main')).includes('Overview'), (await A.textContent('#main')).slice(0,80));
 ck('dashboard shows real account numbers', /Accounts/.test(await A.textContent('.cards')), await A.textContent('.cards'));
 await B.goto(base+'/admin.html',{waitUntil:'domcontentloaded'});
 await B.waitForTimeout(1500);
 ck('a non-owner is refused the dashboard', (await B.textContent('#main')).includes('owner account only'), (await B.textContent('#main')).slice(0,100));

 console.log('\n'+log.join('\n')); console.log(`\n${P} passed, ${F} failed\n`);
 await b.close(); await b2.close(); server.close();
 fs.rmSync(tmp,{recursive:true,force:true});
 process.exit(F?1:0);
})().catch(e=>{console.log('\n'+log.join('\n'));console.error('E2E CRASH',e);process.exit(2)});
