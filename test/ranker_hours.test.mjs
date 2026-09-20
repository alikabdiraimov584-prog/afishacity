import test from "node:test";
import assert from "node:assert/strict";
import {buildSearchPlan} from "../providers.mjs";
import {rankLive,resultPayload} from "../live_ranker.mjs";

// Часы работы в ранкере (hours.mjs). 20.09.2026 — воскресенье (Москва).
const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const shift=n=>{const d=new Date(today+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const ev=(id,name,date,extra={})=>({id,kind:"event",name,cat:"Стендап",tags:["comedy"],area:"Москва",date_start:date,date_end:date,times:["20:00"],price_label:"1000 ₽",price_min:1000,provider:"KudaGo",live:true,desc:"",keywords:"стендап",...extra});
const venue=(id,name,extra={})=>({id,kind:"venue",name,cat:"Бар",tags:["bar","nightlife"],area:"Москва",times:[],hours_label:"до 02:00",price_label:"",price_min:null,provider:"OpenStreetMap",live:true,desc:"",keywords:"бар коктейли",...extra});
const run=(items,args)=>rankLive(items,args,buildSearchPlan(args));

test("закрытое к after_time место выпадает, открытое получает причину, неизвестные часы не мешают", ()=>{
  const late=venue("late","Ночной бар",{hours_label:"Mo-Su 18:00-06:00"});
  const early=venue("early","Дневное кафе-бар",{hours_label:"пн–вс 10:00–22:00"});
  const unknown=venue("unk","Бар без часов",{hours_label:"часы работы на сайте"});
  const out=run([late,early,unknown],{query:"бар",target_date:"2026-09-20",after_time:"23:00"});
  assert.deepEqual(out.map(x=>x.id).sort(),["late","unk"]);
  const l=out.find(x=>x.id==="late");
  assert.ok(l._reasons.includes("открыто в 23:00"),l._reasons.join(","));
  assert.equal(l._hours.closes_at,"06:00");
  assert.equal(out.find(x=>x.id==="unk")._hours,null);
});

test("без after_time — буст «открыто сейчас», закрытое сейчас не выпадает", ()=>{
  const open=venue("open","Бар А",{hours_label:"24/7"});
  const closed=venue("closed","Бар Б",{hours_label:"Mo-Su 10:00-18:00"});
  const out=run([closed,open],{query:"бар",now:"2026-09-20T21:30:00+03:00"});
  assert.deepEqual(out.map(x=>x.id),["open","closed"]);
  assert.ok(out[0]._reasons.includes("открыто сейчас"));
  assert.equal(out[0]._hours.open_now,true);
  assert.equal(out[1]._hours.open_now,false);
  assert.ok(!out[1]._reasons.includes("открыто сейчас"));
});

test("закрытие в течение часа после after_time штрафуется", ()=>{
  const soon=venue("soon","Бар До Полуночи",{hours_label:"Mo-Su 12:00-00:00"});
  const long=venue("long","Бар До Шести",{hours_label:"Mo-Su 12:00-06:00"});
  const out=run([soon,long],{query:"бар",target_date:"2026-09-20",after_time:"23:15"});
  assert.deepEqual(out.map(x=>x.id),["long","soon"]);
  assert.ok(out[1]._reasons.includes("закрывается в 00:00"),out[1]._reasons.join(","));
  assert.ok(out[1]._score<out[0]._score-15);
});

test("на другую дату без времени часы не проверяются; события часами не фильтруются", ()=>{
  const closed=venue("c","Бар",{hours_label:"Mo-Su 10:00-12:00"});
  const out=run([closed],{query:"бар",target_date:shift(3)});
  assert.equal(out.length,1);assert.equal(out[0]._hours,null);
  const e=run([ev("e","Стендап",shift(1),{hours_label:"Mo-Su 10:00-12:00"})],{query:"стендап",target_date:shift(1),after_time:"19:00"});
  assert.equal(e.length,1);
});

test("resultPayload содержит open_now и closes_at", ()=>{
  const out=run([venue("v","Бар",{hours_label:"Mo-Su 12:00-02:00"})],{query:"бар",now:"2026-09-20T21:30:00+03:00"});
  const r=resultPayload(out,{}).results[0];
  assert.equal(r.open_now,true);assert.equal(r.closes_at,"02:00");
  assert.equal(resultPayload([venue("x","Бар")],{}).results[0].open_now,null);
  const p=resultPayload(out,{degraded:{kudago:true},from_cache:{kudago:true}});
  assert.deepEqual(p.degraded,{kudago:true});assert.deepEqual(p.from_cache,{kudago:true});
  assert.deepEqual(resultPayload([],{}).degraded,{});
});
