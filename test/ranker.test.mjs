import test from "node:test";
import assert from "node:assert/strict";
import {buildSearchPlan} from "../providers.mjs";
import {rankLive,resultPayload,placeDna} from "../live_ranker.mjs";

const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const shift=n=>{const d=new Date(today+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const ev=(id,name,date,extra={})=>({id,kind:"event",name,cat:"Стендап",tags:["comedy"],area:"Москва",date_start:date,date_end:date,times:["20:00"],price_label:"1000 ₽",price_min:1000,provider:"KudaGo",live:true,desc:"",keywords:"стендап",...extra});
const venue=(id,name,extra={})=>({id,kind:"venue",name,cat:"Бар",tags:["bar","nightlife"],area:"Москва",times:[],hours_label:"до 02:00",price_label:"",price_min:null,provider:"OpenStreetMap",live:true,desc:"",keywords:"бар коктейли",...extra});
const run=(items,args)=>rankLive(items,args,buildSearchPlan(args));

test("прошедшие события и события без даты не попадают в выдачу без target_date", ()=>{
  const out=run([ev("past","Старый стендап",shift(-3)),ev("future","Новый стендап",shift(2)),ev("nodate","Без даты",null)],{query:"стендап"});
  assert.deepEqual(out.map(x=>x.id).sort(),["future","nodate"].sort());
});

test("фильтры по дате, времени и цене", ()=>{
  const items=[
    ev("a","Ранний",shift(1),{times:["19:00"],price_min:900}),
    ev("b","Поздний",shift(1),{times:["22:00"],price_min:900}),
    ev("c","Дорогой",shift(1),{times:["22:00"],price_min:5000}),
    ev("d","Другой день",shift(4),{times:["22:00"],price_min:900}),
  ];
  const out=run(items,{query:"стендап",target_date:shift(1),after_time:"21:00",max_price_rub:1200});
  assert.deepEqual(out.map(x=>x.id),["b"]);
  assert.ok(out[0]._reasons.includes("по дате"));
  assert.ok(out[0]._reasons.includes("в бюджете"));
});

test("нерелевантные заведения отсекаются при сильном намерении", ()=>{
  const out=run([venue("bar","Коктейльный бар"),venue("shop","Барбершоп Борода",{cat:"Барбершоп",tags:["beauty"],keywords:"стрижка борода"})],{query:"хочу выпить"});
  assert.deepEqual(out.map(x=>x.id),["bar"]);
});

test("закрытые места не показываются", ()=>{
  const out=run([venue("open","Бар А"),venue("closed","Бар Б",{availability:"закрыто"})],{query:"бар"});
  assert.deepEqual(out.map(x=>x.id),["open"]);
});

test("геолокация: «рядом» поднимает ближние места", ()=>{
  const far=venue("far","Далёкий бар",{coords:{lat:55.60,lon:37.90}});
  const near=venue("near","Ближний бар",{coords:{lat:55.762,lon:37.594}});
  const out=run([far,near],{query:"бар рядом",user_location:{lat:55.760,lon:37.590}});
  assert.equal(out[0].id,"near");
  assert.ok(out[0]._distance_km<1);
  assert.ok(out[0]._reasons.includes("рядом"));
});

test("Taste Graph смещает порядок", ()=>{
  const loud=venue("loud","Клуб-бар",{keywords:"клуб вечеринка танцы ночь",tags:["bar","club","nightlife"]});
  const calm=venue("calm","Тихий винный бар",{keywords:"тихо уютно камерно вино"});
  assert.equal(run([loud,calm],{query:"бар",taste_weights:{quiet:4}})[0].id,"calm");
  assert.equal(run([loud,calm],{query:"бар",taste_weights:{nightlife:4,active:4}})[0].id,"loud");
});

test("дождь штрафует открытые площадки", ()=>{
  const open=venue("open","Летняя терраса",{keywords:"open air терраса набережная",tags:["bar","outdoors"]});
  const inside=venue("in","Подвальный бар",{keywords:"подвал коктейли"});
  assert.equal(run([open,inside],{query:"бар",weather_context:{rain:true}})[0].id,"in");
  assert.ok(placeDna(open).outdoors>=55);
});

test("resultPayload отдаёт стабильную форму карточки", ()=>{
  const out=run([venue("v","Бар")],{query:"бар"});
  const p=resultPayload(out,{providers:{osm:true},note:null});
  assert.equal(p.status,"ok");assert.equal(p.count,1);
  const r=p.results[0];
  for(const k of ["id","name","category","date","time","price","area","source","provider","booking_url","reasons","dna","match","kind"])assert.ok(k in r,"нет поля "+k);
  assert.equal(r.date,"постоянно");
  assert.equal(resultPayload([],{}).status,"no_match");
});

test("шкала ДНК: пороги ранкера и UI достижимы", ()=>{
  const cowork=venue("w","Коворкинг Точка",{cat:"Коворкинг",tags:["work"],keywords:"коворкинг тихо wifi ноутбук"});
  const dna=placeDna(cowork);
  assert.ok(dna.work>=55,"work="+dna.work);
  assert.ok(dna.quiet>=68,"quiet="+dna.quiet);
  const plain=placeDna(venue("p","Бар",{keywords:"бар"}));
  assert.ok(plain.work<55&&plain.outdoors<40&&plain.family<55);
  const out=run([cowork],{query:"поработать с ноутбуком"});
  assert.ok(out[0]._reasons.includes("удобно для работы"),out[0]._reasons.join(","));
});
