// Независимость от любого отдельного источника.
//
// Требование владельца продукта: «мы не должны зависеть от них». Проверяется не
// намерением, а поведением: выключаем источник и смотрим, что карточка осталась
// осмысленной, а его имя не стало опознавательным знаком места.
import test from "node:test";
import assert from "node:assert/strict";
import {searchLiveInventory} from "../providers.mjs";
import {createCache} from "../cache.mjs";
import {rankLive,resultPayload} from "../live_ranker.mjs";
import {resolvePhoto,isAggregator,ownSiteUrl} from "../photos.mjs";
import {renderCover} from "../cover.mjs";

const osmBar=(id,name,extra={})=>({
  id:`osm:node:${id}`,provider:"OpenStreetMap",kind:"venue",name,cat:"Бар",
  tags:["bar"],cat_tags:["bar"],coords:{lat:55.76,lon:37.62},
  hours_label:"Mo-Su 18:00-02:00",price_label:"цены у заведения",price_min:null,
  source:`https://www.openstreetmap.org/node/${id}`,point_source:`https://www.openstreetmap.org/node/${id}`,
  ...extra});
const kudagoPlace=(id,name)=>({
  id:`kudago:place:${id}`,provider:"KudaGo",kind:"venue",name,cat:"Бар",
  tags:["bar"],cat_tags:["bar"],coords:{lat:55.75,lon:37.61},
  aggregator_image:"https://kudago.com/media/hall.jpg",aggregator_name:"KudaGo",
  source:"https://kudago.com/msk/place/1",point_source:"https://kudago.com/msk/place/1"});

const freshCache=()=>createCache({ttlMs:0,staleMs:0,file:null});
const providersWith=(map)=>({
  kudago:map.kudago||(async()=>({items:[],errors:[]})),
  timepad:map.timepad||(async()=>({items:[],errors:[]})),
  osm:map.osm||(async()=>({items:[],errors:[]})),
  dgis:map.dgis||(async()=>({items:[],errors:[]}))
});

test("выдача не пустеет, когда агрегатор молчит", async () => {
  for(const broken of [async()=>({items:[],errors:["KudaGo: 503"]}),async()=>{throw new Error("KudaGo down")}]){
    const live=await searchLiveInventory({query:"бар"},{},
      {cache:freshCache(),providers:providersWith({kudago:broken,osm:async()=>({items:[osmBar(1,"Ровесник"),osmBar(2,"Клава")],errors:[]})})});
    const out=rankLive(live.items,{query:"бар",taste_weights:{}},live.plan);
    assert.ok(out.length>=2,"места из открытых данных должны остаться");
  }
});

test("падение источника не роняет весь поиск", async () => {
  const live=await searchLiveInventory({query:"бар"},{},
    {cache:freshCache(),providers:providersWith({osm:async()=>{throw new Error("Overpass timeout")},
      kudago:async()=>({items:[kudagoPlace(7,"Профсоюз")],errors:[]})})});
  assert.ok(Array.isArray(live.items),"поиск завершился");
  assert.equal(live.items.length,1,"уцелевший источник отработал");
});

test("у каждого места есть фотография — своя, если чужой нет", async () => {
  const cover=(p)=>`/api/cover.svg?n=${encodeURIComponent(p.name)}`;
  for(const place of [osmBar(3,"Без картинки"),kudagoPlace(4,"С картинкой агрегатора"),
                      osmBar(5,"С Викискладом",{wikimedia_commons:"File:Bar.jpg"})]){
    const photo=await resolvePhoto(place,{coverUrl:cover,siteMeta:async()=>({})});
    assert.ok(photo&&photo.url,`нет кадра для «${place.name}»`);
    if(photo.origin!=="generated")assert.ok(photo.credit&&photo.credit.text,"кадр без указания источника");
  }
});

test("обложка рисуется всегда и не требует сети", () => {
  const svg=renderCover({name:"Заведение без данных",now:new Date("2026-09-20T19:00:00+03:00")});
  assert.ok(svg.startsWith("<svg"),"обложка не отрисована");
  assert.ok(svg.includes("Заведение без данных"));
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg),"в обложке не должно быть внешних ссылок");
});

test("фотографию и бронь с агрегатора не берём", () => {
  for(const u of ["https://kudago.com/x","https://www.kudago.com/x","https://afisha.yandex.ru/e","https://2gis.ru/f"])
    assert.equal(isAggregator(u),true,u);
  assert.equal(isAggregator("https://rovesnik.bar/"),false);
  // Сайтом заведения считается только не-агрегатор: иначе обогащение картинкой
  // ходило бы за превью на тот же агрегатор и углубляло зависимость.
  assert.equal(ownSiteUrl({official_source:"https://kudago.com/msk/place/1"}),null);
  assert.equal(ownSiteUrl({official_source:"https://rovesnik.bar/?utm_source=x"}),"https://rovesnik.bar/");
});

test("имя агрегатора не подставляется месту как категория или подпись", () => {
  const ranked=rankLive([kudagoPlace(9,"Профсоюз")],{query:"бар",taste_weights:{}},{tags:["bar"],placeIntent:true});
  const payload=resultPayload(ranked,{});
  const card=payload.results[0];
  assert.equal(card.category,"Бар","категория должна быть категорией места");
  assert.ok(!String(card.name).includes("KudaGo"));
  // provider остаётся как указание на происхождение ДАННЫХ — это сноска, не бренд карточки.
  assert.equal(card.provider,"KudaGo");
  assert.equal(card.aggregator_name,"KudaGo");
});

test("образ контейнера копирует все модули, которые импортирует код", async () => {
  const {readFileSync,readdirSync}=await import("node:fs");
  const root=new URL("../",import.meta.url);
  const modules=readdirSync(root).filter(f=>f.endsWith(".mjs"));
  const docker=readFileSync(new URL("Dockerfile",root),"utf8");
  // Перечисление файлов в COPY уже однажды разошлось с кодом, и контейнер
  // падал при старте. Либо копируем шаблоном, либо перечисляем всё.
  const copiesAll=/^COPY \*\.mjs /m.test(docker);
  if(!copiesAll){
    const missing=modules.filter(m=>!docker.includes(m));
    assert.deepEqual(missing,[],`в образ не попадут: ${missing.join(", ")}`);
  }
  assert.ok(/VOLUME .*\/app\/data/.test(docker),"каталог данных должен быть томом");
  const compose=readFileSync(new URL("docker-compose.yml",root),"utf8");
  assert.ok(/\/app\/data/.test(compose),"том с данными не подключён");
});
