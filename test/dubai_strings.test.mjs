// Дубайская сборка не должна показывать человеку ни одной русской строки:
// причины, примечания, подписи цены/времени, бронь, обложка.
// Город читается из env при первом импорте city.mjs, а другие тесты в том же
// процессе могли уже закрепить Москву (_moscow.mjs) — поэтому проверка идёт
// в отдельном процессе с CITY=dubai.
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";

const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const url=(f)=>JSON.stringify(new URL(`../${f}`,import.meta.url).href);

const SCRIPT=`
const {buildSearchPlan,searchOSM,searchLiveInventory,normalizeFoursquareItem,normalizeGoogleItem}=await import(${url("providers.mjs")});
const {rankLive,resultPayload}=await import(${url("live_ranker.mjs")});
const {renderCover}=await import(${url("cover.mjs")});
const {CITY}=await import(${url("city.mjs")});
const {buildPlan}=await import(${url("planner.mjs")});
const els=[
  {type:"node",id:1,lat:25.2001,lon:55.2702,tags:{amenity:"bar",name:"Sky Bar","name:ru":"Скай Бар",phone:"+971 4 000 0000",opening_hours:"Mo-Su 00:00-24:00",description:"quiet rooftop bar for a date"}},
  {type:"node",id:2,lat:25.2100,lon:55.2800,tags:{amenity:"pub",name:"Old Pub",website:"https://oldpub.example.com",opening_hours:"Mo-Su 10:00-23:59"}},
  {type:"node",id:3,lat:25.1950,lon:55.2650,tags:{amenity:"bar",name:"Karaoke Box",opening_hours:"Mo-Su 18:00-04:00"}},
  {type:"node",id:4,lat:25.1900,lon:55.2600,tags:{amenity:"bar"}}
];
const args={query:"quiet bar for a date",area:"downtown center",near:true,user_location:{lat:25.2005,lon:55.2705},max_price_rub:500};
const plan=buildSearchPlan(args);
const osm=await searchOSM(plan,{snapshot:{search:()=>els}});
const fsq=normalizeFoursquareItem({fsq_place_id:"f1",name:"Fsq Lounge",categories:[{name:"Lounge"}],tel:"+97140000001",latitude:25.201,longitude:55.271},plan);
const goo=normalizeGoogleItem({id:"g1",displayName:{text:"G Bar"},primaryTypeDisplayName:{text:"Bar"},websiteUri:"https://gbar.example.com",location:{latitude:25.202,longitude:55.272}},plan);
const ranked=rankLive([...osm.items,fsq,goo],args,plan);
const timed=rankLive(osm.items,{...args,after_time:"21:00"},plan);
const central=rankLive(osm.items,{query:"bar",area:"downtown"},buildSearchPlan({query:"bar",area:"downtown"}));
const payload=resultPayload([...ranked,...timed,...central],{note:null});
// Примечание о сбое источника: OSM падает, мест нет.
const failing=await searchLiveInventory({query:"bar"},{},{providers:{osm:async()=>{throw new Error("down")}},cache:{get:()=>null,set:()=>{}},breaker:{threshold:99}});
const drinking=await searchLiveInventory({query:"выпить очень много"},{},{providers:{osm:async()=>({items:[],errors:[]})},cache:{get:()=>null,set:()=>{}}});
const now=new Date("2026-10-02T18:00:00Z");
const covers=[
  renderCover({name:"Sky Bar",category:"Bar",tags:["bar"],area:"Downtown",hours_label:"Mo-Su 00:00-24:00",coords:{lat:25.25,lon:55.30},now}),
  renderCover({name:"Old Pub",hours_label:"Mo-Su 10:00-11:00",coords:{lat:25.2048,lon:55.2708},now}),
  renderCover({kind:"event",now})
];
const evening=await buildPlan({stops:[{query:"bar"},{query:"pub"}]},async()=>resultPayload(ranked));
process.stdout.write(JSON.stringify({city:CITY.id,osmNames:osm.items.map(x=>x.name),payload,
  notes:[failing.note,drinking.note],covers,route:evening.route_url}));
`;

test("Dubai: в пользовательских строках сервера нет кириллицы",()=>{
  const out=execFileSync(process.execPath,["--input-type=module","-e",SCRIPT],
    {cwd:ROOT,env:{...process.env,CITY:"dubai",NODE_ENV:"test"},encoding:"utf8",maxBuffer:32*1024*1024});
  const r=JSON.parse(out);
  assert.equal(r.city,"dubai");
  const CYR=/[а-яё]/i;
  // Безымянное место отброшено, английское имя предпочтено русскому.
  assert.ok(!r.osmNames.some(n=>CYR.test(n)),r.osmNames.join(", "));
  assert.ok(r.payload.results.length>=3);
  const reasons=r.payload.results.flatMap(x=>x.reasons);
  assert.ok(reasons.length>0);
  assert.ok(reasons.includes("nearby"),reasons.join(" | "));
  assert.ok(reasons.includes("in the center"),reasons.join(" | "));
  assert.ok(reasons.includes("open now")&&reasons.includes("open at 21:00"),reasons.join(" | "));
  for(const x of r.payload.results){
    for(const [k,v] of Object.entries({reasons:x.reasons.join(" | "),date:x.date,time:x.time,price:x.price,category:x.category,
      availability:x.availability,booking_provider:x.booking_provider,area:x.area,name:x.name}))
      assert.ok(!CYR.test(String(v??"")),`${x.id}.${k}: ${v}`);
  }
  assert.ok(r.payload.results.some(x=>x.booking_provider==="phone"));
  assert.ok(r.payload.results.some(x=>x.booking_provider==="official website"||x.booking_provider==="website"));
  assert.ok(r.payload.results.every(x=>x.date==="ongoing"));
  for(const n of r.notes){assert.ok(n,"note expected");assert.ok(!CYR.test(n),n)}
  for(const svg of r.covers){
    const text=[...svg.matchAll(/>([^<>]+)</g)].map(m=>m[1]).join(" | ");
    assert.ok(!CYR.test(text),text);
  }
  assert.match(r.covers[0],/PLACE/);assert.match(r.covers[2],/EVENT/);
  assert.match(r.route,/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&/);
  assert.match(r.route,/travelmode=walking/);
});
