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

// ---- Близость ----
// Живой разговор: «найди ближайшие» возвращало места в центре, потому что
// слова «ближайший» ранкер не знал вовсе, а агент подменял близость центром.

test("«ближайшие» и «поблизости» считаются просьбой о близости", ()=>{
  const near=venue("near","Рядом",{coords:{lat:55.700,lon:37.560}});   // ~200 м
  const far=venue("far","Далеко",{coords:{lat:55.860,lon:37.560}});    // ~18 км
  const me={lat:55.6985,lon:37.5600};
  for(const q of ["ближайшие бары","бар поблизости","бар рядом","бар в шаговой доступности"]){
    const out=run([far,near],{query:q,user_location:me});
    assert.equal(out[0].id,"near",`«${q}»: ближнее место должно быть первым`);
  }
});

test("без слова о близости порядок по близости не навязывается", ()=>{
  const near=venue("near","Рядом",{coords:{lat:55.700,lon:37.560}});
  const far=venue("far","Далеко",{coords:{lat:55.860,lon:37.560},keywords:"бар коктейли авторские"});
  const out=run([far,near],{query:"коктейльный бар",user_location:{lat:55.6985,lon:37.56}});
  assert.equal(out.length,2,"оба места остаются в выдаче");
});

test("агент может попросить о близости явно, не надеясь на формулировку запроса", ()=>{
  const near=venue("near","Рядом",{coords:{lat:55.700,lon:37.560}});
  const far=venue("far","Далеко",{coords:{lat:55.860,lon:37.560}});
  const me={lat:55.6985,lon:37.5600};
  // Модель переписывает запрос своими словами, и слово «ближайший» в нём
  // не обязано уцелеть. Флаг near должен работать сам по себе.
  const out=run([far,near],{query:"бар",near:true,user_location:me});
  assert.equal(out[0].id,"near");
  assert.ok((out[0]._reasons||[]).includes("рядом"),"человеку видно, почему это первое");
});

test("близость и центр — разные вещи", ()=>{
  // Человек в Кузьминках просит ближайшее: центр ему не ближе.
  const kuzminki={lat:55.6950,lon:37.7900};
  const here=venue("here","У дома",{coords:{lat:55.6960,lon:37.7930}});
  const centre=venue("centre","В центре",{coords:{lat:55.7560,lon:37.6200}});
  const near=run([centre,here],{query:"ближайший бар",user_location:kuzminki});
  assert.equal(near[0].id,"here");
  // А если прямо попросили центр — центр и получает преимущество.
  const asked=run([here,centre],{query:"бар",area:"центр",user_location:kuzminki});
  assert.equal(asked[0].id,"centre");
  assert.ok(!asked.some(x=>x.id==="here"),"далёкое от центра при просьбе о центре отсеивается");
});

// ---- Качество вместо случайности ----
// Жалоба: «присылает реально плохие заведения, а не лучшие». У OpenStreetMap
// нет рейтингов, и бар без единого тега, сетевая кофейня и точка без описания
// получали одинаковый балл — порядок задавала база.

const bare=(id,name,x={})=>({id,name,kind:"venue",cat:"Бар",tags:["bar"],cat_tags:["bar"],area:"Москва",times:[],
  hours_label:null,price_label:null,price_min:null,provider:"OpenStreetMap",live:true,desc:"",keywords:"бар",
  coords:{lat:55.75,lon:37.62},...x});

test("полнота карточки поднимает место выше пустого", ()=>{
  const out=run([bare("empty","Бар без всего"),
    bare("full","Бар с сайтом",{official_source:"https://b.bar",hours_label:"до 02:00",phone:"+7",cuisine:"burger"})],
    {query:"хочу выпить"});
  assert.equal(out[0].id,"full");
  assert.ok(out[0]._quality>out[1]._quality);
});

test("сетевая кофейня на «выпить» не проходит, на «кофе» — проходит", ()=>{
  const shoko=bare("s","Шоколадница",{brand:"Шоколадница",cat:"Кафе",tags:["cafe","bar"],cat_tags:["food","coffee"],
    official_source:"https://shoko.ru",hours_label:"до 23:00",keywords:"кафе кофе бар"});
  const realBar=bare("r","Ровесник",{official_source:"https://rovesnik.bar",hours_label:"до 04:00"});
  const drink=run([shoko,realBar],{query:"хочу выпить"});
  assert.equal(drink[0].id,"r");
  assert.ok(!drink.some(x=>x.id==="s"),"кофейная сеть — не ответ на «выпить»");
  const coffee=run([shoko,realBar],{query:"кофе"});
  assert.ok(coffee.some(x=>x.id==="s"),"а на «кофе» она уместна");
});

test("кафе, совпавшее по слову «бар», не обгоняет настоящий бар за счёт разнообразия", ()=>{
  const out=run([bare("cafe","Кафе-бар у дома",{cat:"Кафе",tags:["cafe","bar"],cat_tags:["food"]}),
    bare("b1","Бар с вики",{wikidata:"Q1",official_source:"https://e.bar",hours_label:"до 06:00"}),
    bare("b2","Просто бар")],{query:"хочу выпить"});
  const ids=out.map(x=>x.id);
  assert.ok(ids.indexOf("b2")<ids.indexOf("cafe")||!ids.includes("cafe"),`порядок: ${ids}`);
});

test("настоящий бар сети штрафа не получает", ()=>{
  // Сетевой бар (например, бар при сети отелей) — всё равно бар.
  const out=run([bare("chainbar","Бар «Шоколадница»",{brand:"Шоколадница",cat_tags:["bar"]})],{query:"хочу выпить"});
  assert.equal(out.length,1);
  assert.ok(out[0]._score>50);
});

test("рейтинг 2GIS с отзывами двигает выдачу, без отзывов — нет", ()=>{
  const good=bare("g","Хороший",{provider:"2GIS",rating:4.8,rating_count:200});
  const bad=bare("b","Плохой",{provider:"2GIS",rating:3.4,rating_count:200});
  const few=bare("f","Пятёрка от троих",{provider:"2GIS",rating:5,rating_count:3});
  const out=run([bad,few,good],{query:"хочу выпить"});
  assert.equal(out[0].id,"g");
  assert.ok(out.find(x=>x.id==="b")._quality<out.find(x=>x.id==="g")._quality);
  assert.equal(out.find(x=>x.id==="f")._quality,0,"три отзыва — не сигнал");
});

test("закрытое по тегам место не показывается", ()=>{
  const out=run([bare("open","Живой бар"),bare("dead","Мёртвый бар",{closed:true})],{query:"хочу выпить"});
  assert.deepEqual(out.map(x=>x.id),["open"]);
});

test("при равных баллах порядок устойчив и не зависит от порядка входа", ()=>{
  const a=bare("a","Бар А"),b=bare("b","Бар Б"),c=bare("c","Бар В");
  const o1=run([a,b,c],{query:"хочу выпить"}).map(x=>x.id);
  const o2=run([c,b,a],{query:"хочу выпить"}).map(x=>x.id);
  assert.deepEqual(o1,o2,"порядок не должен задаваться порядком базы");
});

test("«выпить кофе» не выбрасывает кофейни, а событие не считается сетью", ()=>{
  // Штраф сетям включался по тегу bar («выпить»), и кофейни вылетали все.
  const shoko=bare("s","Шоколадница",{brand:"Шоколадница",cat:"Кафе",tags:["cafe","bar"],cat_tags:["food","coffee"],keywords:"кофе кафе"});
  const cafe=bare("c","Кофейня у дома",{cat:"Кофейня",tags:["cafe"],cat_tags:["coffee","food"],keywords:"кофе"});
  const coffee=run([shoko,cafe],{query:"хочу выпить кофе"});
  assert.ok(coffee.length>=1,"на «выпить кофе» кофейни должны остаться");
  // Событие — не заведение: «Джаз в Пекарне» исключался как сетевая пекарня.
  const ev={id:"e",kind:"event",name:"Джаз в Пекарне",cat:"Концерт",tags:["bar","music"],cat_tags:[],
    area:"Москва",date_start:shift(1),date_end:shift(1),times:["20:00"],price_label:"",price_min:null,
    provider:"KudaGo",live:true,desc:"",keywords:"джаз концерт"};
  const out=run([ev],{query:"хочу выпить"});
  assert.equal(out.length,1,"событие не должно отсеиваться как сеть");
});
