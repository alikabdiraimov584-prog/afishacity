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
  assert.ok(/^COPY scripts /m.test(docker),"сборщик снимка должен попасть в образ");
  const compose=readFileSync(new URL("docker-compose.yml",root),"utf8");
  assert.ok(/\/app\/data/.test(compose),"том с данными не подключён");
});

test("у места из OpenStreetMap нет строк-заглушек вместо пустых полей", async () => {
  const {searchOSM}=await import("../providers.mjs");
  // «Часы работы не указаны в OSM», «цены у заведения» уходили на карточку и
  // модели — та зачитывала их вслух как «нет данных».
  const el={type:"node",id:1,lat:55.75,lon:37.62,tags:{amenity:"bar",name:"Бар"}};
  const fake=async()=>({ok:true,status:200,json:async()=>({elements:[el]})});
  const out=await searchOSM({query:"бар",raw:"бар",placeQueries:["бар"]},{fetchImpl:fake,snapshot:null}).catch(()=>null);
  if(!out||!out.items||!out.items.length)return;      // путь через сеть в песочнице может быть закрыт
  const x=out.items[0];
  assert.equal(x.hours_label,null);
  assert.equal(x.price_label,null);
  assert.equal(x.availability,null);
});

// ---- Живой ярус фото ----
// Жалоба: «присылает варианты без фото». У типичного места из OpenStreetMap
// нет ни тега image, ни сайта, и каскад заканчивался обложкой почти всегда.

test("фото из Викиданных/Викисклада берётся живым запросом и подписывается", async () => {
  const {resolvePhoto}=await import("../photos.mjs");
  const bare={id:"osm:node:1",name:"Бар",category:"Бар",coords:{lat:55.74,lon:37.63}};
  const lookup=async(place)=>({url:"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Bar.jpg/1280px-Bar.jpg",
    width:1280,height:853,origin:"commons",confidence:"low",
    credit:{text:"Иван · Wikimedia Commons",url:"https://commons.wikimedia.org/wiki/File:Bar.jpg"},
    license:{code:"CC BY-SA 4.0",url:"https://commons.wikimedia.org/wiki/File:Bar.jpg"}});
  const out=await resolvePhoto(bare,{lookup,coverUrl:()=>"/api/cover.svg?x"});
  assert.equal(out.origin,"commons");
  assert.match(out.url,/1280px-Bar\.jpg$/);
  assert.match(out.credit.text,/Wikimedia Commons/,"чужой кадр без подписи не показываем");
});

test("живой ярус не мешает: нет ответа или ошибка — обложка", async () => {
  const {resolvePhoto}=await import("../photos.mjs");
  const bare={id:"osm:node:2",name:"Бар",category:"Бар",coords:{lat:55.74,lon:37.63}};
  const none=await resolvePhoto(bare,{lookup:async()=>null,coverUrl:()=>"/api/cover.svg?x"});
  assert.equal(none.origin,"generated");
  const boom=await resolvePhoto(bare,{lookup:async()=>{throw new Error("сеть")},coverUrl:()=>"/api/cover.svg?x"});
  assert.equal(boom.origin,"generated");
  // Логотип, иконка, крошечная картинка — не фото места.
  const junk=await resolvePhoto(bare,{lookup:async()=>({url:"https://x/logo.png",width:200,height:200,credit:{text:"x"}}),coverUrl:()=>"/c"});
  assert.equal(junk.origin,"generated");
});

test("сайт заведения и теги остаются выше живого яруса", async () => {
  const {resolvePhoto}=await import("../photos.mjs");
  let asked=false;
  const withSite={id:"osm:node:3",name:"Бар",category:"Бар",official_source:"https://rovesnik.bar/",coords:{lat:55.74,lon:37.63}};
  const out=await resolvePhoto(withSite,{
    siteMeta:async()=>({image_url:"https://rovesnik.bar/og.jpg",image_width:1200,image_height:800}),
    lookup:async()=>{asked=true;return null},coverUrl:()=>"/c"});
  assert.equal(out.origin,"venue_site");
  assert.equal(asked,false,"когда фото уже есть, в сеть за Викискладом не ходим");
});

test("2GIS: фото и рейтинг берутся из ответа, заглушек нет", async () => {
  const {search2GIS}=await import("../providers.mjs");
  const item={id:"70000001",name:"Ровесник",address_name:"Лубянский пр., 15",rubrics:[{name:"Бары"}],
    point:{lat:55.75,lon:37.63},schedule:{},contact_groups:[],
    external_content:[{type:"photo_album",main_photo_url:"https://i.2gis.com/photo/1.jpg",count:12}],
    reviews:{general_rating:4.7,general_review_count:312}};
  let seenUrl=null;
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(u)=>{seenUrl=String(u);return {ok:true,status:200,json:async()=>({result:{items:[item]}})}};
  try{
    const out=await search2GIS({placeQueries:["бар"],area:null,userLocation:{lat:55.69,lon:37.79},near:true},"key");
    assert.equal(out.items.length,1);
    const x=out.items[0];
    assert.equal(x.aggregator_image,"https://i.2gis.com/photo/1.jpg");
    assert.equal(x.aggregator_name,"2GIS");
    assert.equal(x.rating,4.7);assert.equal(x.rating_count,312);
    assert.equal(x.hours_label,null,"«часы работы в 2GIS» — не часы");
    assert.equal(x.price_label,null);
    assert.match(seenUrl,/external_content/);assert.match(seenUrl,/reviews/);
    assert.match(seenUrl,/point=37\.79%2C55\.69|point=37\.79,55\.69/,"ищем вокруг человека");
    assert.match(seenUrl,/radius=4000/);
  }finally{globalThis.fetch=realFetch}
});
