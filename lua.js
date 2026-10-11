/* HvH Lua scripting v1 - sandboxed Lua 5.3 (Fengari, MIT) with a documented API.
   Each script gets its own Lua state with only safe libraries (base minus load/dofile, string, table, math, utf8, coroutine).
   No io/os/package/debug, no network, no DOM. Every callback runs under an instruction-count hook that aborts it after a time limit.
   A script that errors 5 times in a row is switched off; one script failing never affects the game or other scripts. */
(function(){
'use strict';
const H={scripts:[],host:null,X:null,ready:false,VER:3.4,LIMIT:{load:150,cb:12}};
let F,lua,lauxlib,lualib,tl,tj;
const LS={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};
const EVENTS=['round_start','round_end','spawn','death','hit','weapon','tick','draw','key'];

/* ---- marshalling ---- */
function push(L,v,d){d=d||0;if(d>4){lua.lua_pushnil(L);return}
 if(v===null||v===undefined)lua.lua_pushnil(L);else if(typeof v=='number')lua.lua_pushnumber(L,isFinite(v)?v:0);else if(typeof v=='boolean')lua.lua_pushboolean(L,v);else if(typeof v=='string')lua.lua_pushstring(L,tl(v));
 else if(Array.isArray(v)){lua.lua_createtable(L,v.length,0);v.forEach((x,i)=>{push(L,x,d+1);lua.lua_rawseti(L,-2,i+1)})}
 else if(typeof v=='object'){lua.lua_createtable(L,0,8);for(const k in v){push(L,v[k],d+1);lua.lua_setfield(L,-2,tl(k))}}else lua.lua_pushnil(L)}
function arg(L,i){const t=lua.lua_type(L,i);if(t==lua.LUA_TNUMBER)return lua.lua_tonumber(L,i);if(t==lua.LUA_TBOOLEAN)return !!lua.lua_toboolean(L,i);if(t==lua.LUA_TSTRING)return lua.lua_tojsstring(L,i);
 if(t==lua.LUA_TTABLE){const o=[];let n=0;lua.lua_pushnil(L);const ab=lua.lua_absindex(L,i);while(lua.lua_next(L,ab)!==0&&n++<64){o.push(arg(L,-1));lua.lua_pop(L,1)}return o}return undefined}
const str=(L,i,d)=>{const v=arg(L,i);return v===undefined?d:String(v).slice(0,400)};
const num=(L,i,d)=>{const v=arg(L,i);return typeof v=='number'?v:d};

/* ---- one Lua state per script ---- */
function mkState(sc){const L=lauxlib.luaL_newstate();
 [['_G',lualib.luaopen_base],['string',lualib.luaopen_string],['table',lualib.luaopen_table],['math',lualib.luaopen_math],['utf8',lualib.luaopen_utf8],['coroutine',lualib.luaopen_coroutine]].forEach(([n,f])=>{lauxlib.luaL_requiref(L,tl(n),f,1);lua.lua_pop(L,1)});
 ['dofile','loadfile','load','loadstring','require','collectgarbage','print'].forEach(n=>{lua.lua_pushnil(L);lua.lua_setglobal(L,tl(n))});
 lua.lua_getglobal(L,tl('math'));['randomseed'].forEach(n=>{});lua.lua_pop(L,1);
 const fn=(tbl,name,f)=>{lua.lua_pushcfunction(L,L_=>{try{return f(L_)||0}catch(e){lauxlib.luaL_error(L_,tl(String(e&&e.message||e)));return 0}});lua.lua_setfield(L,-2,tl(name))};
 const reg=(name,build)=>{lua.lua_createtable(L,0,16);build((n,f)=>fn(null,n,f));lua.lua_setglobal(L,tl(name))};
 const host=()=>H.host;
 reg('hvh',def=>{
  def('on',L_=>{const ev=str(L_,1,'');if(!EVENTS.includes(ev))throw new Error('unknown event '+ev+' (valid: '+EVENTS.join(', ')+')');if(lua.lua_type(L_,2)!=lua.LUA_TFUNCTION)throw new Error('hvh.on needs a function');lua.lua_pushvalue(L_,2);const r=lauxlib.luaL_ref(L_,lua.LUA_REGISTRYINDEX);(sc.h[ev]=sc.h[ev]||[]).push(r);if((sc.h[ev]||[]).length>16)throw new Error('too many handlers')});
  def('log',L_=>{const n=lua.lua_gettop(L_),a=[];for(let i=1;i<=n;i++)a.push(String(arg(L_,i)));H.log(sc,a.join(' '))});
  def('notify',L_=>{host().notify(str(L_,1,''),str(L_,2,''),str(L_,3,'#9fca2b'))});
  def('sound',L_=>{host().sound(str(L_,1,'Skeet'),num(L_,2,.6))});
  def('get',L_=>{push(L_,host().get(str(L_,1,'')));return 1});
  def('set',L_=>{const ok=host().set(str(L_,1,''),arg(L_,2));if(!ok)throw new Error('setting not allowed or invalid: '+str(L_,1,''));});
  def('bots',L_=>{push(L_,host().bots());return 1});
  def('player',L_=>{push(L_,host().player());return 1});
  def('score',L_=>{push(L_,host().score());return 1});
  def('set_bot',L_=>{host().setBot(num(L_,1,0),str(L_,2,''),arg(L_,3))});
  def('time',L_=>{lua.lua_pushnumber(L_,performance.now()/1000);return 1});
  def('version',L_=>{lua.lua_pushnumber(L_,H.VER);return 1});
  def('key',L_=>{const code=str(L_,1,'');if(lua.lua_type(L_,2)!=lua.LUA_TFUNCTION)throw new Error('hvh.key needs a function');lua.lua_pushvalue(L_,2);const r=lauxlib.luaL_ref(L_,lua.LUA_REGISTRYINDEX);(sc.keys[code]=sc.keys[code]||[]).push(r);if(sc.kn++>16)throw new Error('too many keybinds')})});
 reg('ui',def=>{
  const add=(t,L_)=>{const id=str(L_,1,''),label=str(L_,2,id);if(!id)throw new Error('ui control needs an id');const o={t,id,label};if(t=='slider'){o.min=num(L_,3,0);o.max=num(L_,4,100);o.val=num(L_,5,o.min)}else if(t=='combo'){o.opts=(arg(L_,3)||[]).map(String).slice(0,16);o.val=str(L_,4,o.opts[0])}else o.val=!!arg(L_,3);
   if(sc.ui.length>=24&&!sc.ui.find(u=>u.id==id))throw new Error('too many controls');const old=sc.ui.find(u=>u.id==id);if(old){o.val=old.val}else{const sv=sc.saved[id];if(sv!==undefined)o.val=sv;sc.ui.push(o)}const cur=sc.ui.find(u=>u.id==id);if(old)Object.assign(cur,{label,min:o.min,max:o.max,opts:o.opts});push(L_,cur.val);return 1};
  def('checkbox',L_=>add('check',L_));def('slider',L_=>add('slider',L_));def('combo',L_=>add('combo',L_));
  def('get',L_=>{const u=sc.ui.find(x=>x.id==str(L_,1,''));push(L_,u?u.val:null);return 1})});
 reg('draw',def=>{const X=()=>H.X;
  const col=(L_,i)=>str(L_,i,'#ffffff');
  def('text',L_=>{const x=X();if(!x||!sc.drawing)return;x.fillStyle=col(L_,4);x.font=(num(L_,5,12)|0)+'px Verdana';x.textAlign=str(L_,6,'left');x.fillText(str(L_,3,''),num(L_,1,0),num(L_,2,0))});
  def('rect',L_=>{const x=X();if(!x||!sc.drawing)return;const f=arg(L_,6);x.save();if(f===false){x.strokeStyle=col(L_,5);x.strokeRect(num(L_,1,0),num(L_,2,0),num(L_,3,0),num(L_,4,0))}else{x.fillStyle=col(L_,5);x.fillRect(num(L_,1,0),num(L_,2,0),num(L_,3,0),num(L_,4,0))}x.restore()});
  def('line',L_=>{const x=X();if(!x||!sc.drawing)return;x.strokeStyle=col(L_,5);x.lineWidth=Math.min(8,num(L_,6,1));x.beginPath();x.moveTo(num(L_,1,0),num(L_,2,0));x.lineTo(num(L_,3,0),num(L_,4,0));x.stroke()});
  def('circle',L_=>{const x=X();if(!x||!sc.drawing)return;x.strokeStyle=col(L_,4);x.lineWidth=Math.min(8,num(L_,5,1));x.beginPath();x.arc(num(L_,1,0),num(L_,2,0),Math.min(2000,num(L_,3,5)),0,6.2832);x.stroke()});
  def('size',L_=>{push(L_,{w:H.size[0],h:H.size[1]});return 1})});
 return L}

/* run something in the sandbox under a time limit; returns {ok,err} */
function guarded(sc,ms,body){const L=sc.L;if(!L)return{ok:false,err:'not running'};const dl=performance.now()+ms;
 lua.lua_sethook(L,L_=>{if(performance.now()>dl)lauxlib.luaL_error(L_,tl('script exceeded its time limit ('+ms+' ms)'))},lua.LUA_MASKCOUNT,1500);
 let r;try{r=body(L)}catch(e){r={ok:false,err:String(e&&e.message||e)}}lua.lua_sethook(L,null,0,0);return r}
function pcallTop(L,nargs){const st=lua.lua_pcall(L,nargs,0,0);if(st!==lua.LUA_OK){const m=lua.lua_tojsstring(L,-1);lua.lua_pop(L,1);return{ok:false,err:m}}return{ok:true}}

function fail(sc,err){sc.err=err;sc.fails++;H.log(sc,'ERROR: '+err);if(sc.fails>=5){H.stop(sc,'disabled after 5 consecutive errors');sc.on=false;H.saveEnabled()}H.refresh()}
function call(sc,ms,ref,args){const res=guarded(sc,ms,L=>{lua.lua_rawgeti(L,lua.LUA_REGISTRYINDEX,ref);args.forEach(a=>push(L,a));return pcallTop(L,args.length)});if(res.ok)sc.fails=0;else fail(sc,res.err)}
H.emit=function(ev,data){if(!H.ready)return;for(const sc of H.scripts){if(!sc.on||!sc.L)continue;const hs=sc.h[ev];if(!hs)continue;if(ev=='draw')sc.drawing=true;const a=ev=='tick'?[data]:ev=='draw'?[H.size[0],H.size[1]]:[data];for(const r of hs.slice())call(sc,H.LIMIT.cb,r,a);sc.drawing=false}};
H.key=function(code){if(!H.ready)return;for(const sc of H.scripts){if(!sc.on||!sc.L)continue;const hs=sc.keys[code];if(hs)hs.forEach(r=>call(sc,H.LIMIT.cb,r,[]));}H.emit('key',code)};
H.log=function(sc,m){sc.con.push(new Date().toLocaleTimeString()+'  '+m);if(sc.con.length>80)sc.con.shift();if(H.panel&&H.sel===sc)H.drawConsole()};

H.start=function(sc){if(sc.L)return;sc.err='';sc.h={};sc.keys={};sc.kn=0;sc.fails=0;sc.saved={};try{sc.saved=JSON.parse(LS.get('hvhlua:cfg:'+sc.id)||'{}')}catch(e){}
 const bad=H.compat(sc);if(bad){sc.err=bad;sc.on=false;H.log(sc,'cannot start: '+bad);return}
 sc.L=mkState(sc);const res=guarded(sc,H.LIMIT.load,L=>{if(lauxlib.luaL_loadstring(L,tl(sc.src))!==lua.LUA_OK){const m=lua.lua_tojsstring(L,-1);lua.lua_pop(L,1);return{ok:false,err:m}}return pcallTop(L,0)});
 if(!res.ok){sc.err=res.err;H.log(sc,'LOAD ERROR: '+res.err);H.stop(sc,null);sc.on=false}else H.log(sc,'loaded')};
H.stop=function(sc,why){if(sc.L){try{lua.lua_close(sc.L)}catch(e){}sc.L=null}sc.h={};sc.keys={};if(why)H.log(sc,why)};
H.compat=function(sc){const m=sc.meta;if(m.requires&&parseFloat(m.requires)>H.VER)return'needs HvH '+m.requires+' or newer (this is '+H.VER+')';
 for(const d of (m.depends||[])){const o=H.scripts.find(x=>x.meta.name==d);if(!o)return'missing dependency: '+d;if(!o.on)return'dependency "'+d+'" is not enabled'}return''};
H.meta=function(src){const m={};const g=k=>{const r=new RegExp('^--@'+k+'\\s+(.+)$','m').exec(src);return r?r[1].trim():''};m.name=g('name');m.version=g('version')||'0';m.author=g('author');m.description=g('desc');m.requires=g('requires');m.depends=g('depends')?g('depends').split(',').map(s=>s.trim()).filter(Boolean):[];return m};
H.saveEnabled=function(){LS.set('hvhlua:enabled',JSON.stringify(H.scripts.filter(s=>s.on).map(s=>s.id)))};
H.saveCfg=function(sc){const o={};sc.ui.forEach(u=>o[u.id]=u.val);LS.set('hvhlua:cfg:'+sc.id,JSON.stringify(o))};
H.add=function(id,src,custom){const old=H.scripts.find(s=>s.id==id);if(old){H.stop(old);H.scripts.splice(H.scripts.indexOf(old),1)}const m=H.meta(src);const sc={id,src,meta:m,custom:!!custom,on:false,L:null,h:{},keys:{},kn:0,ui:[],saved:{},con:[],err:'',fails:0,drawing:false};if(!m.name)m.name=id;H.scripts.push(sc);return sc};
H.reload=function(sc){const on=sc.on;H.stop(sc,'reloading');sc.ui=[];if(on){sc.on=true;H.start(sc)}H.refresh()};
H.toggle=function(sc,on){if(on){sc.on=true;H.start(sc);if(!sc.L)sc.on=false}else{H.stop(sc,'disabled');sc.on=false}H.saveEnabled();H.refresh()};

H.init=async function(host){H.host=host;H.size=[1280,720];
 if(!window.fengari){H.err='Lua engine (lib/fengari-web.js) failed to load';return false}
 F=window.fengari;lua=F.lua;lauxlib=F.lauxlib;lualib=F.lualib;tl=F.to_luastring;tj=F.to_jsstring;
 let list=[];try{list=await (await fetch('scripts/index.json?v=34')).json()}catch(e){list=[]}
 for(const f of list){try{const src=await (await fetch('scripts/'+f+'?v=34')).text();H.add(f.replace(/\.lua$/,''),src,false)}catch(e){}}
 const cs=LS.get('hvhlua:custom');if(cs)H.add('custom',cs,true);
 let en=[];try{en=JSON.parse(LS.get('hvhlua:enabled')||'[]')}catch(e){}
 H.ready=true;H.scripts.forEach(s=>{if(en.includes(s.id)){s.on=true;H.start(s);if(!s.L)s.on=false}});return true};

/* ---- script manager UI ---- */
const CSS='#luam{position:fixed;inset:0;z-index:9999;background:rgba(6,7,9,.72);display:none;align-items:center;justify-content:center;font:12px Verdana,sans-serif;color:#d6d9de}#luam .m_w{width:min(980px,96vw);height:min(640px,92vh);background:#14161a;border:1px solid #2a2e36;border-radius:8px;display:flex;flex-direction:column;box-shadow:0 20px 60px #000a}#luam .m_t{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #23272e;font-size:13px}#luam .m_t b{flex:1;letter-spacing:.5px}#luam button{background:#23272e;color:#d6d9de;border:1px solid #333944;border-radius:4px;padding:5px 10px;cursor:pointer;font:inherit}#luam button:hover{background:#2c313a}#luam .m_b{flex:1;display:flex;min-height:0}#luam .m_l{width:260px;border-right:1px solid #23272e;overflow:auto}#luam .m_it{padding:9px 12px;border-bottom:1px solid #1d2026;cursor:pointer;display:flex;gap:8px;align-items:center}#luam .m_it.sel{background:#1d2229}#luam .m_it small{color:#7d8591;display:block}#luam .m_r{flex:1;padding:12px 14px;overflow:auto}#luam .m_st{display:inline-block;width:8px;height:8px;border-radius:50%;background:#555}#luam .m_st.on{background:#9fca2b}#luam .m_st.er{background:#e5534b}#luam pre{background:#0d0f12;border:1px solid #23272e;padding:8px;height:130px;overflow:auto;margin:6px 0;white-space:pre-wrap;font:11px Consolas,monospace;color:#9fb0bf}#luam textarea{width:100%;height:120px;background:#0d0f12;color:#cfd6df;border:1px solid #23272e;font:11px Consolas,monospace;box-sizing:border-box}#luam .m_row{display:flex;align-items:center;gap:10px;margin:7px 0}#luam .m_row label{width:200px}#luam .m_er{color:#ff8a80}#luam h4{margin:12px 0 4px;font-size:11px;color:#8d96a3;text-transform:uppercase;letter-spacing:1px}';
H.openManager=function(){if(!H.panel)build();try{document.exitPointerLock()}catch(e){}H.panel.style.display='flex';H.refresh()};
H.closeManager=function(){if(H.panel)H.panel.style.display='none'};
function build(){const st=document.createElement('style');st.textContent=CSS;document.head.appendChild(st);const p=document.createElement('div');p.id='luam';p.innerHTML='<div class="m_w"><div class="m_t"><b>LUA SCRIPT MANAGER</b><span id="lm_info" style="color:#7d8591;margin-right:12px"></span><button id="lm_x">Close</button></div><div class="m_b"><div class="m_l" id="lm_list"></div><div class="m_r" id="lm_det"></div></div></div>';document.body.appendChild(p);H.panel=p;p.querySelector('#lm_x').onclick=H.closeManager;p.addEventListener('mousedown',e=>{if(e.target===p)H.closeManager()});p.addEventListener('keydown',e=>e.stopPropagation())}
H.refresh=function(){if(!H.panel||H.panel.style.display=='none')return;const L=H.panel.querySelector('#lm_list'),D=H.panel.querySelector('#lm_det');H.panel.querySelector('#lm_info').textContent=(H.ready?'Lua 5.3 (Fengari) · sandboxed · '+H.scripts.length+' scripts':(H.err||'engine not loaded'));
 L.innerHTML='';if(!H.sel||!H.scripts.includes(H.sel))H.sel=H.scripts[0]||null;
 H.scripts.forEach(sc=>{const d=document.createElement('div');d.className='m_it'+(sc===H.sel?' sel':'');d.innerHTML='<span class="m_st '+(sc.err?'er':sc.on?'on':'')+'"></span><div><b>'+esc(sc.meta.name)+'</b><small>v'+esc(sc.meta.version)+(sc.meta.author?' · '+esc(sc.meta.author):'')+'</small></div>';d.onclick=()=>{H.sel=sc;H.refresh()};L.appendChild(d)});
 const nw=document.createElement('div');nw.className='m_it';nw.innerHTML='<b>+ Custom script…</b>';nw.onclick=()=>{H.sel=H.scripts.find(s=>s.custom)||H.add('custom',LS.get('hvhlua:custom')||'--@name My script\n--@version 1.0\n--@desc Edit me\nhvh.on("hit",function(e)\n  hvh.notify("Hit",e.head and "headshot" or "body","#9fca2b")\nend)\n',true);H.refresh()};L.appendChild(nw);
 const sc=H.sel;if(!sc){D.innerHTML='<p>No scripts found.</p>';return}
 let h='<div class="m_row"><b style="font-size:14px;flex:1">'+esc(sc.meta.name)+' <small style="color:#7d8591">v'+esc(sc.meta.version)+'</small></b><label style="width:auto"><input type="checkbox" id="lm_on" '+(sc.on?'checked':'')+'> Enabled</label><button id="lm_rl">Reload</button></div><div style="color:#9aa3af">'+esc(sc.meta.description||'')+'</div>'+(sc.meta.requires?'<div style="color:#7d8591">Requires HvH '+esc(sc.meta.requires)+'+</div>':'')+(sc.meta.depends.length?'<div style="color:#7d8591">Depends on: '+sc.meta.depends.map(esc).join(', ')+'</div>':'')+(sc.err?'<div class="m_er">⚠ '+esc(sc.err)+'</div>':'');
 if(sc.ui.length){h+='<h4>Script settings</h4><div id="lm_ui"></div>'}
 h+='<h4>Console</h4><pre id="lm_con"></pre>';if(sc.custom)h+='<h4>Source</h4><textarea id="lm_src" spellcheck="false"></textarea><div class="m_row"><button id="lm_run">Save &amp; run</button><button id="lm_del">Delete</button></div>';
 D.innerHTML=h;D.querySelector('#lm_on').onchange=e=>{H.toggle(sc,e.target.checked)};D.querySelector('#lm_rl').onclick=()=>{sc.err='';H.reload(sc)};
 const ui=D.querySelector('#lm_ui');if(ui)sc.ui.forEach(u=>{const r=document.createElement('div');r.className='m_row';const lb=document.createElement('label');lb.textContent=u.label;r.appendChild(lb);let c;if(u.t=='check'){c=document.createElement('input');c.type='checkbox';c.checked=!!u.val;c.onchange=()=>{u.val=c.checked;H.saveCfg(sc)}}else if(u.t=='slider'){c=document.createElement('input');c.type='range';c.min=u.min;c.max=u.max;c.value=u.val;const v=document.createElement('span');v.textContent=u.val;c.oninput=()=>{u.val=+c.value;v.textContent=c.value;H.saveCfg(sc)};r.appendChild(c);c=v}else{c=document.createElement('select');u.opts.forEach(o=>c.add(new Option(o)));c.value=u.val;c.onchange=()=>{u.val=c.value;H.saveCfg(sc)}}r.appendChild(c);ui.appendChild(r)});
 const ta=D.querySelector('#lm_src');if(ta){ta.value=sc.src;D.querySelector('#lm_run').onclick=()=>{LS.set('hvhlua:custom',ta.value);const en=sc.on;const n=H.add('custom',ta.value,true);H.sel=n;if(en||true){n.on=true;H.start(n);if(!n.L)n.on=false}H.saveEnabled();H.refresh()};D.querySelector('#lm_del').onclick=()=>{H.stop(sc);H.scripts.splice(H.scripts.indexOf(sc),1);LS.set('hvhlua:custom','');H.sel=null;H.saveEnabled();H.refresh()}}
 H.drawConsole()};
H.drawConsole=function(){const c=H.panel&&H.panel.querySelector('#lm_con');if(c&&H.sel){c.textContent=H.sel.con.join('\n');c.scrollTop=1e6}};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
window.HvhLua=H})();
