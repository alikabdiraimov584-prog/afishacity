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

const park=(id,name,lat,lon)=>venue({id,name,cat:"Парк",tags:["park","outdoors"],cat_tags:["park"],coords:{lat,lon},provider:"KudaGo"});
const PARKS=[
  park("sal","Саларьево парк",55.622,37.406),      // ~15 км от Кремля
  park("sad","Сад будущего",55.836,37.666),        // ~9 км
  park("gorky","Парк Горького",55.7304,37.6017),   // ~2.9 км
  park("zar","Зарядье",55.7510,37.6286)            // ~0.5 км
];
const rankArea=(query,area,items,extra={})=>{
  const args={query,area,taste_weights:{},...extra};
  return rankLive(items,args,buildSearchPlan(args));
};

test("«в центре» отсекает места за пределами центра", () => {
  assert.deepEqual(rankArea("парк",null,PARKS).map(x=>x.id).sort(),["gorky","sad","sal","zar"]);
  assert.deepEqual(rankArea("парк","центр",PARKS).map(x=>x.id),["zar","gorky"]);
});

test("совпадение считается по запросу, а не по месту в тройке", () => {
  // Раньше первый результат всегда получал 97 % независимо от того, что нашлось.
  const wide=rankArea("парк",null,PARKS);
  assert.ok(wide.every(x=>x._match===wide[0]._match),"без условий места равны");
  assert.ok(wide[0]._match<97,`не выдаём 97 % просто за первое место (получили ${wide[0]._match})`);
  const center=rankArea("парк","центр",PARKS);
  assert.ok(center[0]._match>center[1]._match,"ближе к центру — выше совпадение");
  assert.ok(center.every(x=>x._match>=50&&x._match<=99));
});

test("в причинах русские названия, без служебных тегов и слов запроса", () => {
  const [top]=rankArea("парк","центр",PARKS);
  assert.ok(top._reasons.includes("парк"),top._reasons.join(","));
  assert.ok(top._reasons.includes("в центре"));
  assert.ok(!top._reasons.includes("park"),"служебный тег не показываем");
  assert.ok(!top._reasons.includes("outdoors"));
});

test("область поиска входит в ключ кеша", async () => {
  const seen=[];
  const osm=async(plan)=>{seen.push(plan.area);return {items:[],errors:[]}};
  const providers={kudago:async()=>({items:[],errors:[]}),timepad:async()=>({items:[],errors:[]}),osm,dgis:async()=>({items:[],errors:[]})};
  const cache=new Map(),store={get:k=>cache.get(k),set:(k,v)=>cache.set(k,v)};
  await searchLiveInventory({query:"парк"},{},{providers});
  await searchLiveInventory({query:"парк",area:"центр"},{},{providers});
  assert.deepEqual(seen,[null,"центр"]);
});
