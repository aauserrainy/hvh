/* HvH audio manager v1 - shared by the CS:GO and Rust modes.
   Every sound is synthesised with WebAudio (no sound files, nothing to license).
   Each game passes its own settings per call, so CS:GO and Rust never share configuration.
   Hit sounds are played only from confirmed-hit events (the games call HvhAudio.hit once per confirmed hit);
   a 35 ms guard also drops accidental double triggers, and the number of live voices is capped. */
(function(){
'use strict';
const A={ctx:null,bus:null,voices:0,last:{},MAXV:10};
function ctx(){
 try{
  if(!A.ctx){const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;A.ctx=new C();
   const comp=A.ctx.createDynamicsCompressor();comp.threshold.value=-14;comp.knee.value=12;comp.ratio.value=6;comp.attack.value=.002;comp.release.value=.12;comp.connect(A.ctx.destination);A.bus=comp}
  if(A.ctx.state=='suspended')A.ctx.resume();return A.ctx}catch(e){return null}}
const unlock=()=>{ctx()};['pointerdown','keydown','touchstart'].forEach(e=>addEventListener(e,unlock,{once:true,passive:true}));

/* ---- primitives: all take times relative to "now" and clean themselves up ---- */
function osc(a,t0,type,f0,f1,dur,vol){
 const o=a.createOscillator(),g=a.createGain();o.type=type;o.frequency.setValueAtTime(f0,t0);if(f1&&f1!=f0)o.frequency.exponentialRampToValueAtTime(Math.max(20,f1),t0+dur);
 g.gain.setValueAtTime(0,t0);g.gain.linearRampToValueAtTime(vol,t0+.002);g.gain.exponentialRampToValueAtTime(.0001,t0+dur);
 o.connect(g);g.connect(A.bus);o.start(t0);o.stop(t0+dur+.02)}
function noise(a,t0,dur,vol,ftype,freq,q){
 const n=Math.max(1,Math.floor(a.sampleRate*dur)),b=a.createBuffer(1,n,a.sampleRate),d=b.getChannelData(0);for(let i=0;i<n;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/n,2);
 const s=a.createBufferSource();s.buffer=b;const f=a.createBiquadFilter();f.type=ftype;f.frequency.value=freq;if(q)f.Q.value=q;const g=a.createGain();g.gain.value=vol;
 s.connect(f);f.connect(g);g.connect(A.bus);s.start(t0)}

/* ---- packs. Each is (audioctx, now, volume 0..1) ---- */
const P={
 head:{
  'Skeet':(a,t,v)=>{noise(a,t,.012,.9*v,'highpass',4500);osc(a,t,'sine',2350,2300,.13,.5*v);osc(a,t,'sine',3520,3500,.1,.28*v);osc(a,t,'sine',1175,1170,.16,.2*v);osc(a,t,'triangle',4700,4600,.05,.12*v)},
  'Bell':(a,t,v)=>{noise(a,t,.008,.4*v,'highpass',5000);[[1568,.45,.55],[4327,.28,.3],[7180,.16,.18]].forEach(p=>osc(a,t,'sine',p[0],p[0],p[1]+.3,p[2]*v))},
  'Metallic':(a,t,v)=>{noise(a,t,.02,.5*v,'bandpass',3200,4);[1210,1870,2760,3920].forEach((f,i)=>osc(a,t,'square',f,f*.99,.12+.02*i,.1*v));osc(a,t,'sine',620,600,.18,.25*v)},
  'Pop':(a,t,v)=>{osc(a,t,'sine',900,180,.09,.7*v);noise(a,t,.01,.5*v,'highpass',3000)},
  'Double tick':(a,t,v)=>{[0,.055].forEach((d,i)=>{noise(a,t+d,.01,.7*v,'highpass',3800);osc(a,t+d,'sine',i?2600:2000,i?2550:1950,.045,.4*v)})},
  'Rust headshot':(a,t,v)=>{noise(a,t,.035,.85*v,'bandpass',2800,1.2);osc(a,t,'sine',2100,2060,.26,.38*v);osc(a,t,'sine',3150,3100,.2,.2*v);osc(a,t,'sine',150,48,.14,.55*v)},
  'Helmet clank':(a,t,v)=>{noise(a,t,.04,.6*v,'bandpass',1800,3);[780,1330,2140,3300].forEach((f,i)=>osc(a,t,'triangle',f,f*.97,.22-.03*i,.18*v));osc(a,t,'sine',210,90,.1,.4*v)}
 },
 body:{
  'Tick':(a,t,v)=>{noise(a,t,.01,.6*v,'highpass',3000);osc(a,t,'sine',950,700,.05,.4*v)},
  'Thud':(a,t,v)=>{noise(a,t,.05,.5*v,'lowpass',700);osc(a,t,'sine',120,55,.1,.6*v)},
  'Soft pop':(a,t,v)=>{osc(a,t,'sine',520,220,.07,.5*v)},
  'Hitmarker':(a,t,v)=>{osc(a,t,'square',1500,1500,.035,.18*v);noise(a,t,.008,.4*v,'highpass',5000)},
  'Tink':(a,t,v)=>{osc(a,t,'sine',2600,2500,.08,.35*v);noise(a,t,.006,.3*v,'highpass',6000)},
  'Flesh':(a,t,v)=>{noise(a,t,.07,.7*v,'lowpass',900);osc(a,t,'sine',95,45,.11,.7*v);noise(a,t,.015,.3*v,'bandpass',2200,2)}
 }
};
A.names={head:Object.keys(P.head),body:Object.keys(P.body)};
/* recommended lists per mode (shown in each game's menu) */
A.lists={csgo:{head:['Skeet','Bell','Metallic','Pop','Double tick'],body:['Tick','Thud','Soft pop','Hitmarker']},
         rust:{head:['Rust headshot','Helmet clank','Skeet','Bell'],body:['Flesh','Thud','Tink','Hitmarker']}};

/* o = {on:bool, pack:string, vol:0..1 (already master*category)} */
function play(kind,o){
 if(!o||o.on===false||!(o.vol>0))return false;const fn=P[kind]&&P[kind][o.pack];if(!fn)return false;
 const a=ctx();if(!a)return false;if(A.voices>=A.MAXV&&kind!='head')return false;
 A.voices++;setTimeout(()=>{A.voices=Math.max(0,A.voices-1)},450);
 try{fn(a,a.currentTime+.001,Math.min(1,o.vol))}catch(e){A.voices=Math.max(0,A.voices-1);return false}return true}
/* confirmed hit. ns = 'csgo' | 'rust'. Guard against duplicate triggers for the same hit. */
A.hit=function(ns,head,o){const k=ns+(head?'h':'b'),n=performance.now();if(n-(A.last[k]||0)<35)return false;A.last[k]=n;return play(head?'head':'body',o)};
/* settings-menu preview: never deduplicated */
A.preview=function(head,o){return play(head?'head':'body',o)};
window.HvhAudio=A;
})();
