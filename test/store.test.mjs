import test from "node:test";
import assert from "node:assert/strict";
import {openStore,TASTE_DIMS} from "../store.mjs";

test("пользователь: аноним, затем склейка с Telegram", ()=>{
  const s=openStore();
  const a=s.user({anon_id:"c1"});assert.ok(a.id);assert.equal(a.tg_id,null);
  const same=s.user({anon_id:"c1"});assert.equal(same.id,a.id);
  const linked=s.user({anon_id:"c1",tg_id:42,first_name:"Дима"});
  assert.equal(linked.id,a.id);assert.equal(linked.tg_id,42);assert.equal(linked.first_name,"Дима");
  const byTg=s.user({tg_id:42});assert.equal(byTg.id,a.id);
  assert.equal(s.user({}),null);
  s.close();
});

test("профиль: вкус, сохранённое, план; вкус ограничен диапазоном", ()=>{
  const s=openStore();const u=s.user({anon_id:"c2"});
  const p0=s.getProfile(u.id);assert.deepEqual(p0.saved,[]);assert.equal(p0.taste.quiet,0);
  const p1=s.updateProfile(u.id,{taste:{quiet:9,romantic:-2.345,junk:1},saved:[{id:"a",name:"Бар"}]});
  assert.equal(p1.taste.quiet,5);assert.equal(p1.taste.romantic,-2.35);assert.equal("junk" in p1.taste,false);
  assert.equal(p1.saved[0].name,"Бар");
  const p2=s.updateProfile(u.id,{plan:[{id:"b"}]});assert.equal(p2.saved.length,1,"частичное обновление не трогает остальное");assert.equal(p2.plan.length,1);
  s.close();
});

test("обучение вкуса: бронь тихого места сдвигает quiet вверх, nightlife вниз", ()=>{
  const s=openStore();const u=s.user({anon_id:"c3"});
  const dna={quiet:90,nightlife:10,romantic:50};
  const t1=s.learn(u.id,"book",dna,{place_id:"x"});
  assert.ok(t1.quiet>0.3&&t1.quiet<0.5,"quiet="+t1.quiet);
  assert.ok(t1.nightlife<-0.3);assert.equal(t1.romantic,0);
  for(let i=0;i<30;i++)s.learn(u.id,"book",dna);
  assert.equal(s.getProfile(u.id).taste.quiet,5,"не выше 5");
  assert.equal(s.stats(u.id).book,31);
  const before=s.getProfile(u.id).taste;s.learn(u.id,"view",dna);assert.deepEqual(s.getProfile(u.id).taste,before,"неизвестный тип не учится");
  s.close();
});

test("вечера: сохранение, список, удаление; альтернативы не хранятся", ()=>{
  const s=openStore();const u=s.user({anon_id:"c4"});const other=s.user({anon_id:"c5"});
  const plan={status:"ok",stops:[{query:"бар",place:{id:"p"},alternatives:[{id:"z"}]}],total:{start:"19:00"}};
  const id=s.addEvening(u.id,plan,{title:"Пятница",date:"2026-09-25"});
  const list=s.evenings(u.id);assert.equal(list.length,1);assert.equal(list[0].title,"Пятница");assert.deepEqual(list[0].plan.stops[0].alternatives,[]);
  assert.equal(s.evenings(other.id).length,0);
  assert.equal(s.removeEvening(other.id,id),false);assert.equal(s.removeEvening(u.id,id),true);assert.equal(s.evenings(u.id).length,0);
  s.close();
});

test("диалоги: TTL и привязка к пользователю; общие планы", ()=>{
  const s=openStore();const u=s.user({anon_id:"c6"});
  s.setConversation("conv1",[{role:"user",content:"привет"}],u.id);
  assert.equal(s.getConversation("conv1",1000).messages[0].content,"привет");
  assert.equal(s.lastConversationId(u.id),"conv1");
  assert.equal(s.getConversation("conv1",-1),null,"просроченный не возвращается");
  assert.equal(s.sweepConversations(-1),1);
  s.setShared("abc",{title:"T",plan:{stops:[]}});assert.equal(s.getShared("abc").title,"T");assert.equal(s.getShared("nope"),null);
  s.close();
});

test("файл на диске переживает переоткрытие", async ()=>{
  const file="/tmp/claude-0/-home-user-afishacity/c87be004-3320-553e-82ac-10a556c96ac6/scratchpad/store-test.db";
  await import("node:fs").then(fs=>fs.rmSync(file,{force:true}));
  let s=openStore(file);const u=s.user({anon_id:"disk"});s.updateProfile(u.id,{taste:{music:2}});s.close();
  s=openStore(file);assert.equal(s.getProfile(s.user({anon_id:"disk"}).id).taste.music,2);s.close();
});
