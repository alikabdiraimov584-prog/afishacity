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

test("шаринг плана: карточка сохраняется, отдаётся и попадает в Open Graph", async ()=>{
  const {sharePlan,sharedPlanPage}=await import("../server.mjs");
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    // 1×1 PNG
    const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const plan={status:"ok",total:{start:"19:00",end:"23:00"},stops:[{index:1,query:"бар",slot_start:"19:00",slot_end:"20:30",place:{id:"a",name:"Бар А",category:"Бар",area:"Москва"}}]};
    const r=await (await fetch(base+"/api/plan/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan,title:"Тест",image:png})})).json();
    assert.match(r.url,/\/p\/[a-f0-9]+$/);
    assert.ok(r.card_url,"карточка сохранена");
    const img=await fetch(r.card_url);
    assert.equal(img.status,200);assert.equal(img.headers.get("content-type"),"image/png");
    const page=await (await fetch(r.url)).text();
    assert.ok(page.includes(`property="og:image" content="${r.card_url}"`),"og:image указывает на карточку");
    assert.match(page,/twitter:card" content="summary_large_image"/);
    // Без картинки превью не обещаем
    const r2=await (await fetch(base+"/api/plan/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan,title:"Без картинки"})})).json();
    assert.equal(r2.card_url,null);
    const page2=await (await fetch(r2.url)).text();
    assert.ok(!page2.includes("og:image"),"без карточки нет og:image");
    // Мусор вместо PNG не сохраняется
    const {has_card}=sharePlan(plan,{title:"Мусор",image:"data:image/png;base64,bm90YXBuZw=="});
    assert.equal(has_card,false);
    assert.ok(sharedPlanPage({id:"x",title:"<b>",plan,has_card:true},"http://x").includes("&lt;b&gt;"),"заголовок экранируется");
  }finally{await new Promise(r=>server.close(r))}
});
