/* HvH online layer v3 - 1v1 over WebRTC, no game server needed.
   Signaling (the "phone book" that lets two browsers find each other) runs over several free public
   channels at once (MQTT-over-WSS brokers + ntfy.sh) so one being down/blocked doesn't matter.
   A MANUAL copy/paste connect mode needs no signaling server at all.
   For VPNs / strict NATs add a TURN relay (RELAY SETTINGS in the lobby, or the constants below). */
(function(){
'use strict';
const VER='3.2';
let LOC=location;try{if(window.parent!==window&&window.parent.location.origin===location.origin)LOC=window.parent.location}catch(e){}
const IFR=window.parent!==window&&LOC!==location;const q=new URLSearchParams(LOC.search);
const $=id=>document.getElementById(id);

/* ---------- CONFIG: edit these to bake a relay into the site so BOTH players get it automatically ---------- */
const TURN_BUILTIN=[/* {urls:['turn:your.host:3478','turn:your.host:443?transport=tcp','turns:your.host:443?transport=tcp'],username:'u',credential:'p'} */];
const METERED={app:'comefyl',key:'pk_live_7ad1c2390f898ff5a34d4b18d6bf6252ea7a06c7'};   /* free account at metered.ca -> app name + API key (20GB/mo free) */
const STUN=['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302','stun:stun.cloudflare.com:3478','stun:global.stun.twilio.com:3478','stun:stun.nextcloud.com:443'];
const MQTT=['wss://broker.emqx.io:8084/mqtt','wss://broker.hivemq.com:8884/mqtt','wss://test.mosquitto.org:8081/mqtt','wss://mqtt.eclipseprojects.io/mqtt'];
const NTFY=['https://ntfy.sh'];

/* ---------- small helpers ---------- */
const rid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function LSget(k,d){try{const v=localStorage.getItem(k);return v==null?d:v}catch(e){return d}}
function LSset(k,v){try{localStorage.setItem(k,v)}catch(e){}}
const enc=new TextEncoder(),dec=new TextDecoder();
async function fetchT(url,ms){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{signal:c.signal})}finally{clearTimeout(t)}}
async function topicOf(code){try{const h=await crypto.subtle.digest('SHA-256',enc.encode('hvhx3|'+code));return 'hvhx3/'+[...new Uint8Array(h)].slice(0,10).map(b=>b.toString(16).padStart(2,'0')).join('')}catch(e){return 'hvhx3/'+code}}
async function hmacSha1B64(secret,msg){const k=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);const s=new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(msg)));let b='';s.forEach(x=>b+=String.fromCharCode(x));return btoa(b)}
const settings=()=>({turn:LSget('hvh_turn',''),metered:LSget('hvh_metered',''),force:LSget('hvh_force','0')=='1'});

/* ---------- ICE server list (STUN + any TURN we can find) ---------- */
async function buildIce(){
 const list=[{urls:STUN}],s=settings();let relays=0;
 const add=o=>{list.push(o);relays++};
 TURN_BUILTIN.forEach(add);
 s.turn.split('\n').forEach(l=>{l=l.trim();if(!l)return;const p=l.split(/[,|\s]+/);if(/^turns?:/i.test(p[0]))add({urls:p[0],username:p[1]||'',credential:p[2]||''})});
 let app=METERED.app,key=METERED.key;if(s.metered){const p=s.metered.split(/[,\s]+/);app=p[0];key=p[1]}
 if(app&&key){try{const r=await fetchT('https://'+encodeURIComponent(app.replace(/\.metered\.live.*$/,''))+'.metered.live/api/v1/turn/credentials?apiKey='+encodeURIComponent(key),5000);const a=await r.json();if(Array.isArray(a)&&a.length){a.forEach(add)}}catch(e){}}
 /* best-effort public Open Relay (may be rate limited or gone; harmless if so) */
 try{const u=(Math.floor(Date.now()/1000)+86400)+':hvh';list.push({urls:['turn:staticauth.openrelay.metered.ca:80','turn:staticauth.openrelay.metered.ca:443','turn:staticauth.openrelay.metered.ca:443?transport=tcp','turns:staticauth.openrelay.metered.ca:443?transport=tcp'],username:u,credential:await hmacSha1B64('openrelayprojectsecret',u)})}catch(e){}
 list.push({urls:['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp'],username:'openrelayproject',credential:'openrelayproject'});
 return {list,own:relays>0};
}

/* ---------- signaling transports ---------- */
function mqttTransport(url){
 const T={name:'mqtt '+url.replace(/^wss?:\/\//,'').split(/[:/]/)[0],up:false};let ws=null,closed=false,buf=new Uint8Array(0),ka=null,retry=0,rt=null,topic='',onmsg=null,onup=null,q=[];
 const cat=(...a)=>{const n=a.reduce((x,y)=>x+y.length,0),o=new Uint8Array(n);let p=0;a.forEach(y=>{o.set(y,p);p+=y.length});return o};
 const vlen=n=>{const a=[];do{let b=n%128;n=Math.floor(n/128);if(n>0)b|=128;a.push(b)}while(n>0);return Uint8Array.from(a)};
 const str=s=>{const b=enc.encode(s);return cat(Uint8Array.of(b.length>>8,b.length&255),b)};
 const pkt=(t,f,body)=>cat(Uint8Array.of(t<<4|f),vlen(body.length),body);
 function parse(){while(buf.length>=2){let n=0,m=1,i=1,b;do{if(i>=buf.length)return;b=buf[i++];n+=(b&127)*m;m*=128}while(b&128&&i<5);if(buf.length<i+n)return;const type=buf[0]>>4,fl=buf[0]&15,body=buf.slice(i,i+n);buf=buf.slice(i+n);
  if(type==2){if(body[1]===0){ws.send(pkt(8,2,cat(Uint8Array.of(0,1),str(topic),Uint8Array.of(0))))}else{try{ws.close()}catch(e){}}}
  else if(type==9){T.up=true;retry=0;onup&&onup(T);q.splice(0).forEach(x=>T.send(x))}
  else if(type==3){const tl=(body[0]<<8)|body[1];let p=2+tl;if((fl>>1&3)>0)p+=2;try{onmsg(dec.decode(body.slice(p)))}catch(e){}}}}
 function conn(){if(closed)return;try{ws=new WebSocket(url,'mqtt')}catch(e){return again()}ws.binaryType='arraybuffer';buf=new Uint8Array(0);
  ws.onopen=()=>{ws.send(pkt(1,0,cat(str('MQTT'),Uint8Array.of(4,2,0,30),str('hvh'+rid()))));clearInterval(ka);ka=setInterval(()=>{try{ws.send(Uint8Array.of(0xC0,0))}catch(e){}},20000)};
  ws.onmessage=e=>{buf=cat(buf,new Uint8Array(e.data));parse()};
  ws.onclose=()=>{T.up=false;clearInterval(ka);again()};ws.onerror=()=>{};}
 function again(){if(closed)return;clearTimeout(rt);rt=setTimeout(conn,Math.min(15000,1000*Math.pow(2,retry++)))}
 T.start=(tp,om,ou)=>{topic=tp;onmsg=om;onup=ou;conn()};
 T.send=s=>{if(T.up&&ws&&ws.readyState==1){try{ws.send(pkt(3,0,cat(str(topic),enc.encode(s))))}catch(e){}}else if(q.length<30)q.push(s)};
 T.stop=()=>{closed=true;clearTimeout(rt);clearInterval(ka);try{ws&&ws.close()}catch(e){}T.up=false};
 return T}
function ntfyTransport(base){
 const T={name:'ntfy '+base.replace(/^https?:\/\//,''),up:false};let es=null,topic='',onmsg=null,onup=null,closed=false,last=0;
 T.start=(tp,om,ou)=>{topic=tp.replace(/\//g,'-');onmsg=om;onup=ou;try{es=new EventSource(base+'/'+topic+'/sse');es.onopen=()=>{if(!T.up){T.up=true;onup&&onup(T)}};es.onerror=()=>{T.up=false};es.onmessage=e=>{try{const d=JSON.parse(e.data);if(d.event=='message'&&d.message)onmsg(d.message)}catch(x){}}}catch(e){}};
 T.send=s=>{const d=Math.max(0,last+250-Date.now());last=Math.max(Date.now(),last)+250;setTimeout(()=>{if(closed)return;try{fetch(base+'/'+topic,{method:'POST',body:s}).catch(()=>{})}catch(e){}},d)};
 T.stop=()=>{closed=true;try{es&&es.close()}catch(e){}T.up=false};
 return T}
function makeSignal(){
 const S={ts:[],seen:new Set(),me:rid(),onmsg:null,onstate:null,stopped:false};
 S.start=(topic,onmsg,onstate)=>{S.onmsg=onmsg;S.onstate=onstate;
  const mq=q.get('mqtt')?q.get('mqtt').split(','):MQTT;
  S.ts=mq.map(mqttTransport);if(q.get('nontfy')!='1')S.ts=S.ts.concat(NTFY.map(ntfyTransport));
  S.ts.forEach(t=>t.start(topic,txt=>S.recv(txt),()=>S.onstate&&S.onstate(S)))};
 S.upNames=()=>S.ts.filter(t=>t.up).map(t=>t.name);
 S.recv=txt=>{if(S.stopped)return;let m;try{m=JSON.parse(txt)}catch(e){return}if(!m||m.from===S.me||!m.id||S.seen.has(m.id))return;S.seen.add(m.id);if(m.to&&m.to!==S.me)return;S.onmsg(m)};
 S.send=o=>{o.id=rid();o.from=S.me;S.seen.add(o.id);const s=JSON.stringify(o);S.ts.forEach(t=>t.send(s))};
 S.stop=()=>{S.stopped=true;S.ts.forEach(t=>t.stop());S.ts=[]};
 return S}

/* ---------- Net ---------- */
const H={};let ui,statusEl,codeEl,btn;
const Net={ver:VER,open:false,host:false,code:'',ping:0,route:'',
 on(f){H.m=f},onOpen(f){H.o=f},onClose(f){H.c=f},
 send(o){if(!this.open)return;try{const s=JSON.stringify(o),u=this._u;if((o.t=='s')&&u&&u.readyState=='open')u.send(s);else if(this._r&&this._r.readyState=='open')this._r.send(s)}catch(e){}},
 status(t,err){if(statusEl){statusEl.textContent=t;statusEl.style.color=err?'#ff6b6b':'#9aa0a6'}},
 _link:null,_sig:null,_timers:[],
 _t(f,ms){const t=setTimeout(f,ms);this._timers.push(t);return t},
 reset(){this._timers.forEach(clearTimeout);this._timers=[];clearInterval(this._pi);try{this._sig&&this._sig.stop()}catch(e){}this._sig=null;const l=this._link;this._link=null;if(l){l.dead=true;try{l.pc.close()}catch(e){}}
  const was=this.open;this.open=false;this._r=this._u=null;this.route='';if(codeEl&&codeEl.parentNode)codeEl.parentNode.style.display='none';if(btn&&was){btn.textContent='ONLINE 1v1';btn.style.borderColor=''}},
 /* build a RTCPeerConnection + wire data channels / ICE bookkeeping */
 async _mk(onSig){
  const ice=await buildIce(),s=settings();
  const pc=new RTCPeerConnection({iceServers:ice.list,iceTransportPolicy:s.force?'relay':'all'});
  const L={pc,types:{host:0,srflx:0,relay:0,prflx:0},own:ice.own,force:s.force,pend:[],haveRemote:false,dead:false,opened:false};
  let buf=[],tm=null;const flush=()=>{if(buf.length&&onSig){onSig(buf);buf=[]}};
  pc.onicecandidate=e=>{if(e.candidate){const m=/ typ (\w+)/.exec(e.candidate.candidate);if(m)L.types[m[1]]=(L.types[m[1]]||0)+1;buf.push(e.candidate.toJSON());clearTimeout(tm);tm=setTimeout(flush,200)}else{L.gathered=true;flush()}};
  L.addIce=async c=>{for(const x of c){if(L.haveRemote){try{await pc.addIceCandidate(x)}catch(e){}}else L.pend.push(x)}};
  L.remoteSet=async()=>{L.haveRemote=true;for(const x of L.pend.splice(0)){try{await pc.addIceCandidate(x)}catch(e){}}};
  pc.oniceconnectionstatechange=()=>{if(L.dead)return;const st=pc.iceConnectionState;L.ice=st;
   if(st=='failed'&&!L.opened)Net.status(Net._why(L),1);
   if((st=='failed'||st=='closed')&&L.opened)Net._lost();
   if(st=='disconnected'&&L.opened)Net._t(()=>{if(!L.dead&&pc.iceConnectionState=='disconnected')Net._lost()},7000)};
  pc.ondatachannel=e=>Net._wire(L,e.channel);
  this._link=L;return L},
 _why(L){const t=L.types;if(L.force&&!t.relay)return 'RELAY ONLY is on but no relay server answered. Add a TURN server in RELAY SETTINGS (or untick relay only).';
  if(!t.srflx&&!t.relay)return 'No usable network path: your connection (VPN?) blocks the STUN/UDP test traffic. Fix: turn on RELAY SETTINGS with a TURN server, or switch VPN server/protocol (UDP/WireGuard), or use MANUAL CONNECT.';
  if(!t.relay)return 'Found each other but direct peer-to-peer was blocked (VPN/strict NAT) and no relay is available. Add a TURN server in RELAY SETTINGS (both players ideally) and retry.';
  return 'Found each other but could not connect even through the relay. Retry once; if it keeps failing the relay may be rate-limited - add your own TURN in RELAY SETTINGS.'},
 _wire(L,dc){dc.binaryType='arraybuffer';
  if(dc.label=='u')this._u=dc;else this._r=dc;
  dc.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch(x){return}if(!d)return;if(d.t=='ping')Net.send({t:'pong',ts:d.ts});else if(d.t=='pong')Net.ping=Date.now()-d.ts;else H.m&&H.m(d)};
  if(dc.label!='u'){dc.onopen=()=>Net._opened(L);dc.onclose=()=>{if(L.opened)Net._lost()};if(dc.readyState=='open')Net._opened(L)}},
 async _opened(L){if(L.opened||L.dead)return;L.opened=true;this.open=true;clearInterval(this._pi);this._timers.forEach(clearTimeout);this._timers=[];
  try{this._sig&&this._sig.stop()}catch(e){}this._sig=null;
  /* what path did we end up on? */
  try{const st=await L.pc.getStats();let sel=null,cands={};st.forEach(r=>{if(r.type=='candidate-pair'&&(r.selected||(r.nominated&&r.state=='succeeded')))sel=r;if(/candidate$/.test(r.type))cands[r.id]=r});
   if(sel){const a=cands[sel.localCandidateId],b=cands[sel.remoteCandidateId];const ty=(a&&a.candidateType)+'/'+(b&&b.candidateType);this.route=/relay/.test(ty)?'relay':'direct'}}catch(e){}
  this.status('Connected!'+(this.route?' ('+this.route+')':''));ui.style.display='none';btn.textContent='ONLINE: CONNECTED'+(this.route=='relay'?' (RELAY)':'');btn.style.borderColor='#8fe03a';
  H.o&&H.o();this._pi=setInterval(()=>this.send({t:'ping',ts:Date.now()}),2000)},
 _lost(){if(!this.open)return;this.open=false;clearInterval(this._pi);btn.textContent='ONLINE 1v1';btn.style.borderColor='';this.status('Disconnected',1);H.c&&H.c();const l=this._link;this._link=null;if(l){l.dead=true;try{l.pc.close()}catch(e){}}},

 /* ---- HOST (code + signaling) ---- */
 async hostGame(){this.reset();this.host=true;const al='ABCDEFGHJKMNPQRSTUVWXYZ23456789';let c='';for(let i=0;i<5;i++)c+=al[Math.floor(Math.random()*al.length)];this.code=c;
  this.status('Opening room...');const sig=this._sig=makeSignal();let shown=false,att=null;
  const show=()=>{if(shown||this._sig!==sig)return;shown=true;codeEl.textContent=c;codeEl.parentNode.style.display='block';$('hvh-link').value=LOC.origin+LOC.pathname+'?'+(IFR&&this.gameId!=null?'game='+this.gameId+'&':'')+'join='+c;this.status('Room ready (signal: '+sig.upNames().length+' channel'+(sig.upNames().length==1?'':'s')+'). Send your friend the code or link and keep this open.')};
  const startAttempt=async from=>{if(att&&att.from==from){att.resend&&att.resend();return}
   if(att&&att.L){att.L.dead=true;try{att.L.pc.close()}catch(e){}}
   const a=att={from};this.status('Friend found, connecting (this can take up to 30s on a VPN)...');
   let L;try{L=await this._mk(cs=>sig.send({k:'ice',to:from,c:cs}))}catch(e){this.status('WebRTC is not available in this browser: '+e,1);return}
   a.L=L;const pc=L.pc;const r=pc.createDataChannel('r',{ordered:true}),u=pc.createDataChannel('u',{ordered:false,maxRetransmits:0});this._wire(L,r);this._wire(L,u);
   const offer=await pc.createOffer();await pc.setLocalDescription(offer);
   a.resend=()=>sig.send({k:'offer',to:from,sdp:pc.localDescription.toJSON?pc.localDescription.toJSON():{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});a.resend();
   this._t(()=>{if(!this.open&&att===a){this.status(this._why(L),1);att=null}},35000)};
  sig.start(await topicOf(c),async m=>{
    if(this.open)return;
    if(m.k=='join')startAttempt(m.from);
    else if(m.k=='answer'&&att&&att.from==m.from&&att.L){const L=att.L;try{if(!L.haveRemote){await L.pc.setRemoteDescription(m.sdp);await L.remoteSet()}}catch(e){this.status('Handshake error: '+e,1)}}
    else if(m.k=='ice'&&att&&att.from==m.from&&att.L)att.L.addIce(m.c)},
   ()=>show());
  this._t(()=>{if(!shown)this.status('Cannot reach ANY matchmaking channel (all blocked by your network/VPN/ad-blocker). Use MANUAL CONNECT below, or press TEST MY NETWORK.',1)},12000)},

 /* ---- JOIN ---- */
 async joinGame(code){this.reset();this.host=false;code=(code||'').trim().toUpperCase();if(!code){this.status('Enter a room code',1);return}
  this.status('1/4 Contacting matchmaking channels...');const sig=this._sig=makeSignal();let got=false,L=null,up=false;const early=[];
  const tick=()=>{if(this._sig!==sig||got)return;sig.send({k:'join'})};
  sig.start(await topicOf(code),async m=>{
    if(this.open)return;
    if(m.k=='offer'&&!got){got=true;this.status('3/4 Room found, negotiating connection...');
     try{L=await this._mk(cs=>sig.send({k:'ice',to:m.from,c:cs}));L.addIce(early.splice(0));const pc=L.pc;await pc.setRemoteDescription(m.sdp);await L.remoteSet();const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
      sig.send({k:'answer',to:m.from,sdp:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});this.status('4/4 Connecting directly (up to 30s on a VPN)...');
      this._t(()=>{if(!this.open)this.status(this._why(L),1)},35000)}catch(e){this.status('Handshake error: '+e,1)}}
    else if(m.k=='ice'){if(L)L.addIce(m.c);else early.push(...m.c)}},
   ()=>{if(!up){up=true;this.status('2/4 Looking for room '+code+'...');tick();const iv=setInterval(()=>{if(got||this.open||this._sig!==sig)clearInterval(iv);else tick()},2000);this._timers.push(iv)}else if(!got)tick()});
  this._t(()=>{if(!up)this.status('Cannot reach ANY matchmaking channel (blocked by your network/VPN/ad-blocker). Use MANUAL CONNECT below, or press TEST MY NETWORK.',1)},12000);
  this._t(()=>{if(up&&!got)this.status('No room answered for code '+code+'. Check the code and that the host is still on the lobby screen with the code showing.',1)},22000)},

 /* ---- MANUAL (copy/paste) CONNECT: no servers at all ---- */
 async _gather(L,ms){if(L.pc.iceGatheringState=='complete')return;await new Promise(r=>{const t=setTimeout(r,ms);L.pc.addEventListener('icegatheringstatechange',()=>{if(L.pc.iceGatheringState=='complete'){clearTimeout(t);r()}})})},
 _pack(L){const d=L.pc.localDescription;return btoa(unescape(encodeURIComponent(JSON.stringify({type:d.type,sdp:d.sdp}))))},
 _unpack(t){try{return JSON.parse(decodeURIComponent(escape(atob(t.replace(/\s+/g,'')))))}catch(e){return null}},
 async manualOffer(){this.reset();this.host=true;this.status('Making your connection code (gathering network info, ~5s)...');const L=await this._mk(null),pc=L.pc;this._wire(L,pc.createDataChannel('r',{ordered:true}));this._wire(L,pc.createDataChannel('u',{ordered:false,maxRetransmits:0}));
  await pc.setLocalDescription(await pc.createOffer());await this._gather(L,6000);this.status('Send the code below to your friend, then paste THEIR reply back here and press step 3.');return this._pack(L)},
 async manualAnswer(txt){const o=this._unpack(txt);if(!o||o.type!='offer'){this.status('That is not a valid host code.',1);return ''}this.reset();this.host=false;this.status('Making your reply code (~5s)...');const L=await this._mk(null),pc=L.pc;await pc.setRemoteDescription(o);await L.remoteSet();await pc.setLocalDescription(await pc.createAnswer());await this._gather(L,6000);this.status('Send the reply code below to the host and wait. It connects by itself.');this._t(()=>{if(!this.open)this.status(this._why(L),1)},60000);return this._pack(L)},
 async manualFinish(txt){const a=this._unpack(txt),L=this._link;if(!a||a.type!='answer'||!L){this.status('Paste your friend\'s reply code first (and make a host code before that).',1);return}try{await L.pc.setRemoteDescription(a);await L.remoteSet();this.status('Connecting...');this._t(()=>{if(!this.open)this.status(this._why(L),1)},60000)}catch(e){this.status('Bad reply code: '+e,1)}},

 /* ---- diagnostics ---- */
 async check(){this.status('Testing your network (about 8 seconds)...');
  const sig=makeSignal(),topic=await topicOf('TEST'+rid());sig.start(topic,()=>{},()=>{});
  const ice=await buildIce();
  const ty=await new Promise(res=>{const s={host:0,srflx:0,relay:0};let pc;try{pc=new RTCPeerConnection({iceServers:ice.list})}catch(e){return res(null)}pc.createDataChannel('x');pc.onicecandidate=e=>{if(e.candidate){const m=/ typ (\w+)/.exec(e.candidate.candidate);if(m)s[m[1]]=(s[m[1]]||0)+1}else{res(s)}};pc.createOffer().then(o=>pc.setLocalDescription(o));setTimeout(()=>res(s),8000)});
  await sleep(500);const up=sig.upNames();const all=sig.ts.map(t=>t.name);sig.stop();
  let m='Matchmaking channels up: '+up.length+'/'+all.length+(up.length?'':'  (NONE reachable - blocked)')+'\nDirect (STUN): '+(ty&&ty.srflx?'OK':'FAILED')+'   Relay (TURN): '+(ty&&ty.relay?'OK':ice.own?'configured but unreachable':'none available');
  const ok=up.length&&ty&&(ty.srflx||ty.relay);
  m+='\n'+(!up.length?'-> Use MANUAL CONNECT, or disable the ad-blocker/VPN for this site.':!ok?'-> Your network blocks peer-to-peer. Add a TURN relay in RELAY SETTINGS.':ty.relay?'-> should work, even on a VPN.':'-> should work for most networks; on a VPN add a TURN relay for reliability.');
  this.status(m,!ok)},
 lobby(){if(document.pointerLockElement)document.exitPointerLock();ui.style.display='flex'}};

function build(){
 const st=document.createElement('style');st.textContent='#hvh-btn{position:fixed;left:104px;top:8px;z-index:99998;background:#16181c;color:#e8e8ea;border:1px solid #3f84e8;padding:7px 12px;font:bold 11px Tahoma,Verdana,sans-serif;letter-spacing:.1em;cursor:pointer}#hvh-btn:hover{background:#243a60}#hvh-ui{position:fixed;inset:0;z-index:99999;background:rgba(6,7,9,.86);display:none;align-items:center;justify-content:center;font:12px Tahoma,Verdana,sans-serif;color:#e8e8ea}#hvh-box{width:470px;max-width:94vw;max-height:94vh;overflow:auto;background:linear-gradient(#121316,#0d0e10);border:1px solid #000;box-shadow:0 0 0 1px #34363a;padding:20px}#hvh-box h2{margin:0 0 4px;font-size:15px;letter-spacing:.18em}#hvh-box .bar{height:2px;background:linear-gradient(90deg,#9fca2b,#34c4e5,#a057e8,#ff8a3d);margin:-20px -20px 16px}#hvh-box p{color:#8b8f98;margin:0 0 14px;line-height:1.5}#hvh-box button,#hvh-box input,#hvh-box textarea{font:bold 12px Tahoma,Verdana,sans-serif;background:#1b1c1f;color:#e8e8ea;border:1px solid #000;box-shadow:0 0 0 1px #34363a inset;padding:9px 12px}#hvh-box textarea{width:100%;height:56px;font:11px monospace;resize:vertical;margin-bottom:8px;box-sizing:border-box}#hvh-box button{cursor:pointer}#hvh-box button:hover{background:#243a60}#hvh-box .row{display:flex;gap:8px;margin-bottom:12px}#hvh-box input[type=text],#hvh-box #hvh-in,#hvh-box #hvh-link{flex:1;min-width:0}#hvh-in{text-transform:uppercase;letter-spacing:.2em;text-align:center}#hvh-code{font-size:34px;letter-spacing:.3em;text-align:center;color:#3f84e8;margin:6px 0 10px}#hvh-box details{margin:0 0 10px;border:1px solid #2a2c30;padding:8px 10px;color:#9aa0a6}#hvh-box summary{cursor:pointer;font-weight:bold;letter-spacing:.06em}#hvh-box details .row{margin:8px 0 0}#hvh-box label{display:flex;gap:6px;align-items:center;margin-top:8px}#hvh-st{white-space:pre-line}#hvh-box small{display:block;margin-top:6px;color:#8b8f98}';document.head.appendChild(st);
 btn=document.createElement('button');btn.id='hvh-btn';btn.textContent='ONLINE 1v1';btn.onclick=()=>Net.lobby();document.body.appendChild(btn);
 ui=document.createElement('div');ui.id='hvh-ui';
 ui.innerHTML='<div id="hvh-box"><div class="bar"></div><h2>ONLINE 1v1</h2><p>Play a friend directly (peer-to-peer, no game server). One of you hosts, the other joins with the code.</p>'
 +'<div class="row"><button id="hvh-host" style="flex:1">HOST A MATCH</button></div><div id="hvh-roombox" style="display:none"><div id="hvh-code"></div><div class="row"><input id="hvh-link" readonly><button id="hvh-copy">COPY LINK</button></div></div>'
 +'<div class="row"><input id="hvh-in" maxlength="5" placeholder="ROOM CODE"><button id="hvh-join">JOIN</button></div>'
 +'<div id="hvh-st" style="min-height:34px;color:#9aa0a6;line-height:1.4;margin-bottom:10px"></div>'
 +'<details id="hvh-rs"><summary>RELAY SETTINGS (for VPNs / strict networks)</summary><small style="margin:6px 0">A TURN relay lets you connect when a VPN or strict router blocks direct peer-to-peer. Free: sign up at metered.ca, copy your app name + API key, paste below as <b>appname,apikey</b>. Or paste TURN servers, one per line: <b>turn:host:443?transport=tcp,username,password</b></small><input type="text" id="hvh-met" placeholder="metered appname,apikey" style="width:100%;box-sizing:border-box;margin-bottom:8px"><textarea id="hvh-turn" placeholder="turn:host:443?transport=tcp,user,pass"></textarea><label><input type="checkbox" id="hvh-force"> Relay only (force traffic through TURN; use if direct keeps failing on VPN)</label><div class="row"><button id="hvh-save" style="flex:1">SAVE RELAY SETTINGS</button></div></details>'
 +'<details id="hvh-man"><summary>MANUAL CONNECT (no matchmaking server needed)</summary><small style="margin:6px 0">If the normal way cannot connect, trade two codes over Discord/text: host does 1, joiner does 2, host does 3.</small><textarea id="hvh-pin" placeholder="paste the other player\'s code here"></textarea><div class="row"><button id="hvh-m1" style="flex:1">1 HOST: MAKE CODE</button><button id="hvh-m2" style="flex:1">2 JOIN: PASTE HOST CODE &rarr; REPLY</button></div><button id="hvh-m3" style="width:100%;margin-bottom:8px">3 HOST: PASTE FRIEND\'S REPLY &rarr; CONNECT</button><textarea id="hvh-pout" readonly placeholder="your code appears here - copy it and send it"></textarea></details>'
 +'<div class="row" style="margin:10px 0 0"><button id="hvh-test" style="flex:1">TEST MY NETWORK</button><button id="hvh-x" style="flex:1">CLOSE</button></div><small style="text-align:center;opacity:.6">net v'+VER+'</small></div>';
 document.body.appendChild(ui);
 statusEl=$('hvh-st');codeEl=$('hvh-code');
 $('hvh-host').onclick=()=>Net.hostGame();$('hvh-join').onclick=()=>Net.joinGame($('hvh-in').value);$('hvh-test').onclick=()=>Net.check();$('hvh-x').onclick=()=>{ui.style.display='none'};
 $('hvh-copy').onclick=()=>{const l=$('hvh-link');l.select();try{navigator.clipboard.writeText(l.value)}catch(e){document.execCommand('copy')}Net.status('Link copied')};
 const s=settings();$('hvh-met').value=s.metered;$('hvh-turn').value=s.turn;$('hvh-force').checked=s.force;if(s.metered||s.turn||s.force)$('hvh-rs').open=true;
 $('hvh-save').onclick=()=>{LSset('hvh_metered',$('hvh-met').value.trim());LSset('hvh_turn',$('hvh-turn').value.trim());LSset('hvh_force',$('hvh-force').checked?'1':'0');Net.status('Relay settings saved. Now host or join again.')};
 const out=$('hvh-pout');
 $('hvh-m1').onclick=async()=>{out.value=await Net.manualOffer()};
 $('hvh-m2').onclick=async()=>{out.value=await Net.manualAnswer($('hvh-pin').value)};
 $('hvh-m3').onclick=()=>Net.manualFinish($('hvh-pin').value);
 [$('hvh-in'),$('hvh-met'),$('hvh-turn'),$('hvh-pin'),$('hvh-pout'),$('hvh-link')].forEach(el=>{el.addEventListener('keydown',e=>{e.stopPropagation();if(e.key=='Enter'&&el.id=='hvh-in')Net.joinGame(el.value)});el.addEventListener('keyup',e=>e.stopPropagation())});
 const j=q.get('join');if(j){ui.style.display='flex';$('hvh-in').value=j;setTimeout(()=>Net.joinGame(j),300)}}
window.Net=Net;if(document.body)build();else addEventListener('DOMContentLoaded',build)})();
