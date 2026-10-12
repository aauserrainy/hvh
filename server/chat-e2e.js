/* chat, presence, the offline-button fix, and the rename */
const {chromium}=require('/opt/node-tools/node_modules/playwright-core');
const path=require('path'),fs=require('fs'),os=require('os');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-'));
process.env.DB_FILE=path.join(tmp,'c.db');process.env.STATIC_DIR='/home/claude/hvh';process.env.TRUST_PROXY='0';
const {server}=require('/home/claude/hvh/server/server.js');
let P=0,F=0;const log=[];
const ck=(n,c,x)=>{if(c){P++;log.push('  ok   '+n)}else{F++;log.push('  FAIL '+n+(x!==undefined?'  <'+String(JSON.stringify(x)).slice(0,200)+'>':''))}};
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const mk=async(t)=>{const p=await (await b.newContext({viewport:{width:1280,height:860}})).newPage();
  p.on('pageerror',e=>{console.log('  [pageerror '+t+']',e.message);F++});
  await p.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,r=>r.abort());
  await p.route('**/three.min.js',r=>r.fulfill({path:'/home/claude/work/t3/three/build/three.min.js',contentType:'text/javascript'}));
  await p.goto(base+'/index.html',{waitUntil:'domcontentloaded'});await p.waitForTimeout(700);return p};
 const A=await mk('A'),B=await mk('B');
 ck('page title is rainy.hvh', (await A.title())==='rainy.hvh', await A.title());
 ck('sign-in card is branded rainy.hvh', (await A.textContent('h1')).replace(/\s/g,'')==='rainy.hvh', await A.textContent('h1'));

 for(const [p,n] of [[A,'rainyowner'],[B,'secondguy']]){
  await p.click('#swapBtn');await p.fill('#u',n);await p.fill('#p','passpass11');await p.fill('#c','passpass11');
  await p.click('#authGo');await p.waitForSelector('#menu:not(.hide)',{timeout:15000});}
 ck('menu header is branded rainy.hvh', (await A.textContent('.logo')).replace(/\s/g,'')==='rainy.hvh', await A.textContent('.logo'));

 // ---- the bug: JOIN OFFLINE on the menu ----
 await A.click('#aOffline');
 await A.waitForFunction(()=>document.getElementById('game').style.display==='block',{timeout:25000});
 ck('JOIN OFFLINE on the menu actually launches the game', true);
 await A.waitForTimeout(4500);
 const off=await A.frame({url:/csgo/}).evaluate(()=>({online:ONLINE_MATCH,bots:bots.length}));
 ck('it launches an offline bot match', off.online===false && off.bots>0, off);
 await A.click('#leave'); await A.waitForTimeout(1500);

 // ---- chat ----
 await A.waitForTimeout(3200);
 ck('chat panel is present', await A.$('#chatlog')!==null);
 await B.fill('#chatIn','hello from player two'); await B.click('#chatGo');
 await A.waitForTimeout(4000);
 const seen=await A.textContent('#chatlog');
 ck('a message from one player reaches the other', seen.includes('hello from player two'), seen.slice(0,160));
 await A.fill('#chatIn','owner here'); await A.click('#chatGo');
 await B.waitForTimeout(4000);
 const bSeen=await B.textContent('#chatlog');
ck('messages flow both ways', bSeen.includes('owner here'), bSeen.slice(0,160));
 const dupes=await B.evaluate(()=>{const t=[...document.querySelectorAll('#chatlog .cm')].map(l=>l.textContent);
   return {total:t.length, unique:new Set(t).size, lines:t}});
 ck('no message is rendered twice', dupes.total===dupes.unique, dupes);

 const styled=await B.evaluate(()=>{
   const lines=[...document.querySelectorAll('#chatlog .cm')];
   const own=lines.find(l=>l.textContent.includes('owner here'));
   const other=lines.find(l=>l.textContent.includes('hello from player two'));
   const cs=own?getComputedStyle(own.querySelector('.nm')):null;
   return {ownHasClass:!!own&&own.classList.contains('own'),
           otherHasClass:!!other&&other.classList.contains('own'),
           glow:cs?cs.textShadow:'', color:cs?cs.color:'',
           uidBadges:lines.map(l=>l.querySelector('.uidb')?.textContent)};
 });
 ck('the owner line is marked as the owner', styled.ownHasClass===true, styled);
 ck('a normal player line is not', styled.otherHasClass===false, styled);
 ck("the owner's name has a white aura", /rgba?\(255,\s*255,\s*255/.test(styled.glow)&&(styled.glow.match(/px/g)||[]).length>=3, styled.glow);
 ck("the owner's name is white", styled.color==='rgb(255, 255, 255)', styled.color);
 ck('every message shows the speaker UID', styled.uidBadges.length>=2 && styled.uidBadges.every(u=>/^\d+$/.test(u)), styled.uidBadges);

 const online=await A.evaluate(()=>({count:document.getElementById('onCount').textContent,
   names:[...document.querySelectorAll('#onlineList .ou')].map(o=>o.textContent),
   ownerMarked:[...document.querySelectorAll('#onlineList .ou')].some(o=>o.classList.contains('own'))}));
 ck('the active user list shows both players', online.names.length>=2, online);
 ck('the online count is shown', /\d+ online/.test(online.count), online.count);
 ck('the owner is highlighted in the user list', online.ownerMarked===true, online);

 const anim=await A.evaluate(()=>{
   const t=document.querySelector('.act'), m=document.querySelector('#chatlog .cm');
   return {tile:getComputedStyle(t).animationName, line:m?getComputedStyle(m).animationName:'',
           reduced:!!document.styleSheets.length};
 });
 ck('menu tiles animate in', anim.tile==='riseIn', anim);
 ck('chat lines animate in', anim.line==='slideIn', anim);

 await A.screenshot({path:'/tmp/menu.png'});
 console.log('\n'+log.join('\n'));console.log(`\n${P} passed, ${F} failed\n`);
 await b.close();server.close();fs.rmSync(tmp,{recursive:true,force:true});process.exit(F?1:0);
})().catch(e=>{console.log('\n'+log.join('\n'));console.error('CRASH',e);process.exit(2)});
