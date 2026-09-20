import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test";
const {server}=await import("../server.mjs");

test("профиль по HTTP: анонимный клиент, обновление, событие, вечера", async ()=>{
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const H={"Content-Type":"application/json","X-Free-Client":"client-abc-123"};
  try{
    const noId=await fetch(base+"/api/me");assert.equal(noId.status,400);
    let r=await (await fetch(base+"/api/me",{headers:H})).json();
    assert.equal(r.user.telegram,false);assert.deepEqual(r.profile.saved,[]);assert.equal(r.conversation_id,null);
    r=await (await fetch(base+"/api/me",{method:"PUT",headers:H,body:JSON.stringify({taste:{quiet:2},saved:[{id:"a",name:"Бар"}]})})).json();
    assert.equal(r.profile.taste.quiet,2);assert.equal(r.profile.saved.length,1);
    r=await (await fetch(base+"/api/me/event",{method:"POST",headers:H,body:JSON.stringify({type:"book",dna:{quiet:100},place_id:"a",name:"Бар"})})).json();
    assert.ok(r.taste.quiet>2);
    r=await (await fetch(base+"/api/me/evenings",{method:"POST",headers:H,body:JSON.stringify({plan:{stops:[{query:"бар",place:{id:"a"}}],total:{start:"19:00"}},title:"Тест"})})).json();
    assert.ok(r.id);assert.equal(r.evenings.length,1);
    const d=await (await fetch(base+"/api/me/evenings/"+r.id,{method:"DELETE",headers:H})).json();
    assert.equal(d.ok,true);assert.equal(d.evenings.length,0);
    const me=await (await fetch(base+"/api/me",{headers:H})).json();
    assert.equal(me.stats.book,1);assert.equal(me.profile.saved[0].name,"Бар");
  }finally{await new Promise(r=>server.close(r))}
});

test("CORS: приложение с capacitor://localhost получает заголовки, чужой origin — нет", async ()=>{
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const pre=await fetch(base+"/api/me",{method:"OPTIONS",headers:{Origin:"capacitor://localhost","Access-Control-Request-Method":"PUT"}});
    assert.equal(pre.status,204);assert.equal(pre.headers.get("access-control-allow-origin"),"capacitor://localhost");
    assert.match(pre.headers.get("access-control-allow-headers"),/X-Free-Client/);
    const ok=await fetch(base+"/api/health",{headers:{Origin:"capacitor://localhost"}});
    assert.equal(ok.headers.get("access-control-allow-origin"),"capacitor://localhost");
    const bad=await fetch(base+"/api/health",{headers:{Origin:"https://evil.example"}});
    assert.equal(bad.headers.get("access-control-allow-origin"),null);
  }finally{await new Promise(r=>server.close(r))}
});
