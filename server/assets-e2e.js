/* Model pipeline tests.
   The important case is the FIRST one: the public build ships no manifest and
   must behave exactly as before. The rest prove a manifest actually swaps the
   models in, auto-scales them to the player height, and that a broken entry
   degrades to the built-in model instead of breaking the game. */
const {chromium}=require('playwright-core');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const THREE_BUILD=process.env.THREE_BUILD||'/home/claude/work/t3/three/build/three.min.js';
let pass=0,fail=0;
const ok=(n,c,d)=>{if(c){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(d?'  ['+d+']':''))}};

function serve(manifest){
  return http.createServer((rq,rs)=>{
    const u=rq.url.split('?')[0];
    if(u==='/assets/manifest.json'){
      if(manifest===null){rs.writeHead(404);return rs.end()}
      rs.writeHead(200,{'content-type':'application/json'});return rs.end(JSON.stringify(manifest));
    }
    const f=path.join(ROOT,u);
    fs.readFile(f,(e,d)=>{if(e){rs.writeHead(404);return rs.end()}
      rs.writeHead(200,{'content-type':u.endsWith('.html')?'text/html':u.endsWith('.glb')?'model/gltf-binary':u.endsWith('.json')?'application/json':'text/javascript'});
      rs.end(d)});
  });
}

async function run(label,manifest,check){
  const srv=serve(manifest); await new Promise(r=>srv.listen(0,r));
  const b=await chromium.launch({executablePath:process.env.CHROMIUM||'/opt/pw-browsers/chromium',
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const p=await (await b.newContext({viewport:{width:640,height:400}})).newPage();
  p.setDefaultTimeout(120000);
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/,r=>r.abort());
  await p.route('**/three.min.js',r=>r.fulfill({path:THREE_BUILD,contentType:'text/javascript'}));
  await p.goto('http://127.0.0.1:'+srv.address().port+'/csgo.html?mode=offline',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(14000);
  console.log('\n'+label);
  const st=await p.evaluate(()=>{
    const bot=bots[0];
    let modelMeshes=0; if(bot&&bot.g.userData.model)bot.g.userData.model.traverse(o=>{if(o.isMesh||o.isSkinnedMesh)modelMeshes++});
    const bb=bot?new THREE.Box3().setFromObject(bot.g):null;
    return {ready:ASSET.ready,chars:Object.keys(ASSET.chars),wpn:Object.keys(ASSET.wpn),
      bots:bots.length,usedModel:!!(bot&&bot.g.userData.model),modelMeshes,
      height:bb?+(bb.max.y-bb.min.y).toFixed(2):null,
      proceduralKids:bot?bot.g.children.length:0,
      alive:typeof P!=='undefined'&&P.hp>0};
  });
  check(st,errs);
  await b.close();srv.close();
}

(async()=>{
  await run('no manifest (what GitHub Pages serves)',null,(st,errs)=>{
    ok('the game still boots',st.alive,JSON.stringify(st));
    ok('bots are still created',st.bots>0);
    ok('the built-in procedural model is used',!st.usedModel);
    ok('a missing manifest is not a page error',errs.length===0,errs[0]);
    ok('the asset layer still settles',st.ready===true);
  });

  await run('manifest pointing at real glTF models',{
    characters:{t:{url:'server/fixtures/probe-char.glb',scale:'auto'},ct:{url:'server/fixtures/probe-char.glb',scale:'auto'}},
    weapons:{'AK-47':{url:'server/fixtures/probe-wpn.glb',scale:'auto'}}
  },(st,errs)=>{
    ok('both team models load',st.chars.includes('t')&&st.chars.includes('ct'),JSON.stringify(st.chars));
    ok('the weapon model loads',st.wpn.includes('AK-47'),JSON.stringify(st.wpn));
    ok('bots are rebuilt using the loaded model',st.usedModel,JSON.stringify(st));
    ok('the loaded model actually has geometry',st.modelMeshes>0,'meshes='+st.modelMeshes);
    ok('auto-scale fits it to the 1.8-unit player',st.height>1.4&&st.height<2.2,'height='+st.height);
    ok('no page errors',errs.length===0,errs[0]);
  });

  await run('manifest with a broken url',{
    characters:{t:{url:'server/fixtures/does-not-exist.glb'}}
  },(st,errs)=>{
    ok('a dead url falls back to the built-in model',!st.usedModel);
    ok('the game still boots',st.alive);
    ok('bots still exist',st.bots>0);
    ok('a dead url is not a page error',errs.length===0,errs[0]);
  });

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
