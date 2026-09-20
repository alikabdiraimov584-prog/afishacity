import test from "node:test";
import assert from "node:assert/strict";
import {buildSearchPlan,searchLiveInventory,structuralTags} from "../providers.mjs";
import {rankLive} from "../live_ranker.mjs";
import {SERVICE_TAGS} from "../categories.mjs";

const venue=(o)=>({kind:"venue",tags:[],cat_tags:[],...o});
// Реальные ловушки из боевой выдачи: у парка в названии «аптек», а у культурного
// пространства барбершоп упомянут в описании.
const APTEKARSKY=venue({id:"park",name:"Аптекарский огород",cat:"Парк",tags:["pharmacy","park"],cat_tags:["park"],provider:"KudaGo"});
const KHLEBOZAVOD=venue({id:"loft",name:"Хлебозавод №9",cat:"Культурное пространство",desc:"кофейни, барбершоп, магазины",tags:["barber","beauty"],cat_tags:[],provider:"KudaGo"});
const PHARMACY=venue({id:"ph",name:"Аптека 36,6",cat:"Аптека",tags:["pharmacy"],cat_tags:["pharmacy"],provider:"OpenStreetMap"});
const BARBER=venue({id:"bb",name:"Chop-Chop",cat:"Парикмахерская",tags:["barber","beauty"],cat_tags:["barber","beauty"],provider:"OpenStreetMap"});

function rank(query,items){
  return rankLive(items,{query},buildSearchPlan({query})).map(x=>x.name);
}

test("парк с «аптек» в названии не выдаётся за аптеку", () => {
  assert.deepEqual(rank("аптека",[APTEKARSKY,PHARMACY]),["Аптека 36,6"]);
  assert.deepEqual(rank("аптека",[APTEKARSKY]),[]);
});

test("барбершоп в описании площадки не делает её барбершопом", () => {
  assert.deepEqual(rank("барбершоп",[KHLEBOZAVOD,BARBER]),["Chop-Chop"]);
  assert.deepEqual(rank("барбершоп",[KHLEBOZAVOD]),[]);
});

test("для досуга текстовое совпадение по-прежнему работает", () => {
  const bar=venue({id:"bar",name:"Коктейльный бар Noor",cat:"Бар",tags:["bar"],cat_tags:[]});
  assert.deepEqual(rank("бар",[bar]),["Коктейльный бар Noor"]);
});

test("теги запроса не проставляются найденным местам", async () => {
  let seen=null;
  const kudago=async(plan)=>{seen=plan;return {items:[],errors:[]}};
  const osm=async(plan)=>({items:[{...APTEKARSKY,tags:["park"],cat_tags:["park"]}],errors:[]});
  const r=await searchLiveInventory({query:"бар"},{},{providers:{kudago,timepad:async()=>({items:[],errors:[]}),osm,dgis:async()=>({items:[],errors:[]})}});
  assert.ok(seen,"события опрашиваются для досуга");
  assert.ok(!r.items.some(x=>(x.tags||[]).includes("bar")),"тег запроса не попал в карточку");
});

test("для услуги афиша событий не опрашивается", async () => {
  const called=[];
  const stub=(n)=>async()=>{called.push(n);return {items:[],errors:[]}};
  const r=await searchLiveInventory({query:"аптека"},{},
    {providers:{kudago:stub("kudago"),timepad:stub("timepad"),osm:stub("osm"),dgis:stub("dgis")}});
  assert.deepEqual(called,["osm"]);
  assert.equal(r.providers.kudago,false);
  assert.equal(r.providers.timepad,false);
});

test("структурные поля OSM дают категорию места", () => {
  assert.deepEqual(structuralTags({amenity:"pharmacy"}),["pharmacy"]);
  assert.deepEqual(structuralTags({leisure:"park"}),["park"]);
  // Одно значение делят несколько категорий — нужны обе.
  assert.deepEqual(structuralTags({shop:"hairdresser"}).sort(),["barber","beauty"]);
  assert.deepEqual(structuralTags({}),[]);
});

test("справочник делит категории на услуги и досуг", () => {
  for(const t of ["pharmacy","barber","carrepair","dentist","hotel"])assert.ok(SERVICE_TAGS.has(t),t);
  for(const t of ["bar","food","park","museum","club"])assert.ok(!SERVICE_TAGS.has(t),t);
});
