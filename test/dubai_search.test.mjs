import "./_dubai.mjs";                        // тест про Дубай: английский словарь и Asia/Dubai
import test from "node:test";
import assert from "node:assert/strict";
import {CITY} from "../city.mjs";
import {buildSearchPlan,searchOSM,priceLevelOf,priceLabelOf,translitArabic} from "../providers.mjs";
import {rankLive,resultPayload} from "../live_ranker.mjs";
import {hoursSane,hoursSummary,seasonState} from "../hours.mjs";

// Пятница 2 октября 2026, 23:00 по Дубаю.
const NOW="2026-10-02T23:00:00+04:00";
const USER={lat:25.2000,lon:55.2700};
const base=(id,name,extra={})=>({id,kind:"venue",name,organizer:name,cat:"Restaurant",tags:["food"],cat_tags:["food"],primary_tags:["food"],
  area:"Dubai",times:[],hours_label:null,price_label:null,price_min:null,provider:"OpenStreetMap",live:true,desc:"",keywords:"restaurant",
  coords:{lat:25.2010,lon:55.2710},...extra});
const run=(items,args)=>rankLive(items,{now:NOW,user_location:USER,...args},buildSearchPlan({now:NOW,user_location:USER,...args}));
// Сырые элементы OSM → карточки той же функцией, что и в проде.
const osm=async(els,q="restaurant")=>(await searchOSM(buildSearchPlan({query:q}),{snapshot:{search:()=>els}})).items;

test("город — Дубай",()=>{assert.equal(CITY.id,"dubai")});

test("«nearest», «near me», «close by» и args.near: среди подходящих первым идёт ближайшее",()=>{
  const far=base("far","Big Pharmacy",{cat:"Pharmacy",cat_tags:["pharmacy"],primary_tags:["pharmacy"],keywords:"pharmacy",
    coords:{lat:25.2300,lon:55.3000},official_source:"https://big.example.com",phone:"+9714",hours_label:"24/7",wikidata:"Q1"});
  const near=base("near","Small Pharmacy",{cat:"Pharmacy",cat_tags:["pharmacy"],primary_tags:["pharmacy"],keywords:"pharmacy",coords:{lat:25.2008,lon:55.2706}});
  // Без «рядом» полнота карточки может перевесить.
  assert.equal(run([far,near],{query:"pharmacy"})[0].id,"far");
  for(const q of ["nearest pharmacy","pharmacy near me","pharmacy close by","closest pharmacy","pharmacy within walking distance"])
    assert.equal(run([far,near],{query:q})[0].id,"near",q);
  assert.equal(run([far,near],{query:"pharmacy",near:true})[0].id,"near");
});

test("словарь намерений: общие слова не становятся поиском по названию",()=>{
  const p=(q)=>buildSearchPlan({query:q,now:NOW});
  for(const q of ["what's open after midnight","girls night out","surprise me","it's too hot, something indoors","call me a taxi","I'm bored","something fun to do now"]){
    const pl=p(q);
    assert.ok(!(pl.phrase||[]).length,`${q}: phrase=${pl.phrase}`);
    assert.ok(!(pl.focus||[]).some(w=>/after|midnight|girls|out|surprise|too|hot|call|taxi|bored|fun/.test(w)),`${q}: focus=${pl.focus}`);
  }
  const mid=p("what's open after midnight");
  assert.equal(mid.textTime,"00:00");assert.equal(mid.timeStrict,true);
  assert.ok(mid.cats.includes("bar")&&mid.cats.includes("food"),mid.cats.join(","));
  const mich=p("michelin star restaurant");
  assert.equal(mich.michelin,true);assert.deepEqual(mich.cats,["food"]);
  assert.ok(!(mich.focus||[]).includes("michelin"));
  assert.ok(p("girls night out").cats.includes("bar"));
  const hot=p("it's too hot, something indoors");
  assert.ok(hot.cats.includes("mall")&&hot.cats.includes("museum")&&!hot.cats.includes("beach"),hot.cats.join(","));
  const vague=p("surprise me");
  assert.equal(vague.vague,true);assert.ok(vague.cats.length>=4);
  const taxi=p("call me a taxi");
  assert.equal(taxi.taxi,true);assert.equal(taxi.placeIntent,false);
  assert.deepEqual(run([base("a","Call Doctor")],{query:"call me a taxi"}),[]);
});

test("действие вырезается: «book a table at Pierchic» ищет Pierchic, а не книжный",()=>{
  const pl=buildSearchPlan({query:"book a table at Pierchic"});
  assert.deepEqual(pl.phrase,["pierchic"]);
  assert.ok(!pl.cats.includes("books"));
  const pier=base("p","Pierchic"),books=base("b","Book Corner",{cat:"Bookstore",cat_tags:["books"],primary_tags:["books"],keywords:"books"});
  assert.deepEqual(run([books,pier],{query:"book a table at Pierchic"}).map(x=>x.id),["p"]);
  assert.deepEqual(buildSearchPlan({query:"directions to Gold Souk"}).action,"directions");
});

test("время из текста: «at 2am» — ближайшая ночь, «open now» убирает закрытые, неизвестные часы — после открытых",()=>{
  const late=base("late","Night Grill",{hours_label:"Mo-Su 18:00-03:00"});
  const early=base("early","Day Bistro",{hours_label:"Mo-Su 10:00-01:00"});
  const unk=base("unk","Mystery Kitchen",{hours_label:null,official_source:"https://m.example.com",phone:"+9714",wikidata:"Q5"});
  const out=run([early,unk,late],{query:"late night food at 2am"});
  assert.deepEqual(out.map(x=>x.id),["late","unk"]);
  assert.ok(out[0]._reasons.some(r=>/open (?:at|tomorrow) 02:00/.test(r)),out[0]._reasons.join(","));
  assert.ok(out[1]._reasons.includes("hours unconfirmed"));
  const closedNow=base("cn","Lunch Place",{hours_label:"Mo-Su 08:00-16:00"});
  const openNow=base("on","Night Place",{hours_label:"Mo-Su 18:00-02:00"});
  assert.deepEqual(run([closedNow,openNow],{query:"restaurants open now"}).map(x=>x.id),["on"]);
  // Модель прислала сегодняшние 19:00, а сейчас 23:00: проверяем «сейчас».
  const till20=base("t20","Early Dinner",{hours_label:"Mo-Su 12:00-20:00"});
  assert.deepEqual(run([till20,openNow],{query:"dinner",target_date:"2026-10-02",after_time:"19:00"}).map(x=>x.id),["on"]);
  // «24 hour cafe»: круглосуточные вперёд.
  const allDay=base("247","Always Cafe",{cat_tags:["coffee"],primary_tags:["coffee"],keywords:"cafe coffee",hours_label:"24/7"});
  const cafe=base("c","Late Cafe",{cat_tags:["coffee"],primary_tags:["coffee"],keywords:"cafe coffee",hours_label:"Mo-Su 08:00-02:00",official_source:"https://x.example.com",wikidata:"Q9"});
  assert.equal(run([cafe,allDay],{query:"24 hour cafe"})[0].id,"247");
});

test("exclude_ids: «покажи ещё» не повторяет показанное и даёт до пяти новых",()=>{
  const items=Array.from({length:12},(_,i)=>base(`r${i}`,`Restaurant ${String.fromCharCode(65+i)}${i}`,{coords:{lat:25.2+i*0.003,lon:55.27}}));
  const first=run(items,{query:"restaurant"});
  assert.equal(first.length,5);
  const more=run(items,{query:"restaurant",exclude_ids:first.map(x=>x.id)});
  assert.equal(more.length,5);
  assert.ok(more.every(x=>!first.some(y=>y.id===x.id)));
});

test("цена: free:price, догадка с пометкой, пределы price_level_max/min и «cheaper»",async()=>{
  assert.equal(priceLevelOf("3"),3);assert.equal(priceLevelOf("$$"),2);assert.equal(priceLevelOf("very expensive"),4);assert.equal(priceLevelOf("n/a"),null);
  assert.equal(priceLabelOf(2),"$$ · moderate");assert.equal(priceLabelOf(1,true),"$ · likely budget");
  const items=await osm([
    {type:"node",id:1,lat:25.201,lon:55.271,tags:{amenity:"restaurant",name:"Luxe Room","free:price":"4"}},
    {type:"node",id:2,lat:25.202,lon:55.272,tags:{amenity:"fast_food",name:"McDonald's"}},
    {type:"node",id:3,lat:25.203,lon:55.273,tags:{amenity:"restaurant",name:"Mid Bistro","free:price":"2"}},
    {type:"node",id:4,lat:25.204,lon:55.274,tags:{amenity:"restaurant",name:"Plain Diner"}}
  ]);
  const by=Object.fromEntries(items.map(x=>[x.name,x]));
  assert.equal(by["Luxe Room"].price_level,4);assert.equal(by["Luxe Room"].price_level_estimated,false);
  assert.equal(by["McDonald's"].price_level,1);assert.equal(by["McDonald's"].price_level_estimated,true);
  assert.equal(by["Plain Diner"].price_level,null);
  const pay=resultPayload(run(items,{query:"restaurant"})).results;
  assert.equal(pay.find(x=>x.name==="Luxe Room").price,"$$$$ · luxury");
  assert.equal(pay.find(x=>x.name==="McDonald's").price,"$ · likely budget");
  // Предел из аргументов модели: известный уровень выше — прочь, неизвестный остаётся.
  const capped=run(items,{query:"restaurant",price_level_max:2}).map(x=>x.name);
  assert.ok(!capped.includes("Luxe Room")&&capped.includes("Mid Bistro")&&capped.includes("Plain Diner"),capped.join(","));
  // «Подешевле» после «Mid Bistro» ($$): модель передаёт уровень ниже.
  assert.ok(!run(items,{query:"cheaper restaurant",price_level_max:1}).some(x=>x.name==="Mid Bistro"));
  const upscale=run(items,{query:"restaurant",price_level_min:3}).map(x=>x.name);
  assert.ok(upscale.includes("Luxe Room")&&!upscale.includes("Mid Bistro")&&!upscale.includes("McDonald's"),upscale.join(","));
  assert.equal(buildSearchPlan({query:"cheap eats under 50 AED"}).priceMax,1);
  assert.equal(buildSearchPlan({query:"fine dining"}).priceMin,3);
});

test("статус: закрытые не показываются, временно закрытое — только по имени, сезон — «Opens 14 Oct»",async()=>{
  const items=await osm([
    {type:"node",id:11,lat:25.201,lon:55.271,tags:{amenity:"restaurant",name:"Gone Grill","free:status":"closed"}},
    {type:"node",id:12,lat:25.201,lon:55.272,tags:{amenity:"restaurant",name:"Old Kitchen",closed:"yes"}},
    {type:"node",id:13,lat:25.201,lon:55.273,tags:{"disused:amenity":"restaurant",amenity:"restaurant",name:"Empty Diner"}},
    {type:"node",id:14,lat:25.201,lon:55.274,tags:{amenity:"restaurant",name:"Future Bistro",opening_date:"2027-03-01"}},
    {type:"node",id:15,lat:25.201,lon:55.275,tags:{amenity:"restaurant",name:"Pause Cafe","free:status":"temporarily_closed",opening_hours:"Mo-Su 08:00-23:59"}},
    {type:"node",id:16,lat:25.201,lon:55.276,tags:{amenity:"restaurant",name:"Winter Village","free:season":"10-14/05-10",opening_hours:"Mo-Su 16:00-01:00"}},
    {type:"node",id:17,lat:25.201,lon:55.277,tags:{amenity:"restaurant",name:"Open Table",opening_hours:"Mo-Su 12:00-02:00"}}
  ]);
  const names=run(items,{query:"restaurant"}).map(x=>x.name);
  for(const n of ["Gone Grill","Old Kitchen","Empty Diner","Future Bistro","Pause Cafe"])assert.ok(!names.includes(n),`${n} в выдаче: ${names}`);
  assert.ok(names.includes("Winter Village")&&names.includes("Open Table"));
  const season=resultPayload(run(items,{query:"restaurant"})).results.find(x=>x.name==="Winter Village");
  assert.equal(season.status_note,"Opens 14 Oct");assert.equal(season.open_now,false);assert.equal(season.hours_label,"Opens 14 Oct");
  // «Сейчас» и «сегодня вечером» — вне сезона не показываем.
  assert.ok(!run(items,{query:"restaurant open now"}).some(x=>x.name==="Winter Village"));
  const pause=resultPayload(run(items,{query:"Pause Cafe"})).results;
  assert.equal(pause[0].name,"Pause Cafe");assert.equal(pause[0].status_note,"Temporarily closed");assert.equal(pause[0].open_now,false);
  assert.deepEqual(seasonState("10-14/05-10","2026-12-31"),{open:true,opens:null});
  assert.deepEqual(seasonState("10-14/05-10","2026-07-01"),{open:false,opens:"14 Oct"});
});

test("часы: ошибки ввода считаются неизвестными, подпись по-человечески",async()=>{
  assert.equal(hoursSane("Fr-Su 00:00-12:15",{eatery:true}),false);
  assert.equal(hoursSane("Mo-Su 09:00-12:00",{eatery:true}),false);
  assert.equal(hoursSane("00:00-00:00"),false);
  assert.equal(hoursSane("Mo-Su 12:00-23:00",{eatery:true}),true);
  assert.equal(hoursSane("Mo-Fr 07:00-12:00",{eatery:false}),true);
  const fri15="2026-10-02T15:00:00+04:00",fri10="2026-10-02T10:00:00+04:00",fri20="2026-10-02T20:00:00+04:00";
  assert.equal(hoursSummary("Mo-Su 12:00-23:30",fri15),"Open today 12:00–23:30");
  assert.equal(hoursSummary("Mo-Su 12:00-23:30",fri10),"Closed now · opens 12:00");
  assert.equal(hoursSummary("Mo-Fr 09:00-17:00",fri20),"Closed now · opens Mon 09:00");
  assert.equal(hoursSummary("Mo-Su 18:00-02:00","2026-10-03T01:00:00+04:00"),"Open now · until 02:00");
  assert.equal(hoursSummary("24/7",fri15),"Open 24 hours");
  assert.equal(hoursSummary("call us",fri15),null);
  const [steak]=await osm([{type:"node",id:21,lat:25.201,lon:55.271,tags:{amenity:"restaurant",name:"Meat Co",opening_hours:"Mo-Th 00:00-23:15; Fr-Su 00:00-12:15"}}]);
  assert.equal(steak.hours_label,null);assert.equal(steak.hours_raw,"Mo-Th 00:00-23:15; Fr-Su 00:00-12:15");
  const p=resultPayload([steak]).results[0];
  assert.equal(p.hours_label,null);assert.equal(p.hours_raw,"Mo-Th 00:00-23:15; Fr-Su 00:00-12:15");assert.equal(p.open_now,null);
});

test("поля карточки: бронь столика, меню, Мишлен, расстояние всегда при известном человеке",async()=>{
  const [x]=await osm([{type:"node",id:31,lat:25.2100,lon:55.2800,tags:{amenity:"restaurant",name:"Star Table",phone:"+971 4 111 1111",
    "free:booking_url":"https://book.example.com/star","free:booking_provider":"SevenRooms","website:menu":"https://star.example.com/menu",
    "free:michelin":"1 star",opening_hours:"Mo-Su 12:00-23:30"}}]);
  const r=resultPayload(run([x],{query:"michelin restaurant"})).results[0];
  assert.equal(r.booking_url,"https://book.example.com/star");assert.equal(r.booking_kind,"reserve");assert.equal(r.booking_provider,"SevenRooms");
  assert.equal(r.menu_url,"https://star.example.com/menu");assert.equal(r.michelin,"1 star");
  assert.ok(Number.isFinite(r.distance_km)&&r.distance_km>1,String(r.distance_km));
  assert.equal(r.hours_raw,"Mo-Su 12:00-23:30");assert.match(r.hours_label,/^(Open|Closed)/);
  assert.equal(r.price_level,4);
  // Район в запросе: расстояние в карточке — всё равно от человека.
  const d=resultPayload(run([x],{query:"restaurant in jbr"})).results[0];
  assert.ok(Number.isFinite(d.distance_km));
});

test("Мишлен, скорая, метро, живая музыка, вид на ориентир, большая компания",()=>{
  const star=base("star","Fancy Place",{michelin:"1 star"}),plain=base("plain","Plain Place",{official_source:"https://p.example.com",wikidata:"Q1"});
  assert.deepEqual(run([plain,star],{query:"michelin restaurant"}).map(x=>x.id),["star"]);
  const H=(id,name,extra={})=>base(id,name,{cat:"Hospital",cat_tags:["hospital"],primary_tags:["hospital"],keywords:"hospital",...extra});
  const er=H("er","Rashid Hospital",{attrs:{emergency:true,hospital:true},coords:{lat:25.23,lon:55.31}});
  const home=H("home","Nexx Home Healthcare Services",{coords:{lat:25.2005,lon:55.2705}});
  const dent=H("dent","Smile Dental Hospital Clinic",{coords:{lat:25.2006,lon:55.2706}});
  assert.deepEqual(run([home,dent,er],{query:"hospital emergency room"}).map(x=>x.id),["er"]);
  const wash=base("wash","Metro Car Wash",{cat:"Car wash",cat_tags:["carwash"],primary_tags:["carwash"]});
  const station=base("st","Burj Khalifa/Dubai Mall Metro Station",{cat:"Metro station",cat_tags:["metro"],primary_tags:["metro"]});
  assert.deepEqual(run([wash,station],{query:"nearest metro station"}).map(x=>x.id),["st"]);
  const stadium=base("stad","Cricket Stadium",{cat:"Music venue",cat_tags:["concert"],primary_tags:["concert"],ov_cat:"cricket_ground"});
  const jazz=base("jazz","Jazz Bar",{cat:"Bar",cat_tags:["bar"],primary_tags:["bar"],attrs:{live_music:true}});
  assert.ok(!run([stadium,jazz],{query:"live music tonight"}).some(x=>x.id==="stad"));
  const tower=base("bk","Burj Khalifa",{cat:"Tourist attraction",cat_tags:["sights"],primary_tags:["sights"],coords:{lat:25.1972,lon:55.2744}});
  const sky=base("sky","Sky View Restaurant",{coords:{lat:25.1980,lon:55.2750}});
  const view=run([tower,sky],{query:"restaurant with Burj Khalifa view"});
  assert.equal(view[0].id,"sky");assert.ok(!view.some(x=>x.id==="bk"));
  const kids=base("kids","Cheeky Monkeys Play Area",{cat:"Kids activities",cat_tags:["family","food"],primary_tags:["family"]});
  const rest=base("rest","Grand Brasserie");
  assert.ok(!run([kids,rest],{query:"birthday dinner for 10 people"}).some(x=>x.id==="kids"));
  const pl=buildSearchPlan({query:"golf course"});
  assert.ok(pl.cats.includes("golf")&&!pl.cats.includes("courses"),pl.cats.join(","));
});

test("одно место дважды рядом (до 150 м) — один раз",()=>{
  const a=base("a","Cafe Nero Marina",{coords:{lat:25.20100,lon:55.27100}});
  const b=base("b","Marina Cafe Nero",{coords:{lat:25.20130,lon:55.27120}});
  const c=base("c","Other Diner",{coords:{lat:25.2050,lon:55.2750}});
  const out=run([a,b,c],{query:"restaurant"}).map(x=>x.id);
  assert.equal(out.filter(id=>id==="a"||id==="b").length,1,out.join(","));
});

test("события Дубая: «this weekend» — суббота и воскресенье, прошедшие — никогда, события выше площадок",()=>{
  const was=CITY.providers.events;
  CITY.providers.events=["dubai_events"];
  try{
    const E=(id,date,extra={})=>({id,kind:"event",name:`Show ${id}`,cat:"Comedy",tags:["comedy"],cat_tags:["comedy"],area:"Dubai",venue:"Dubai Opera",
      date_start:date,date_end:date,time:"20:00",price:"AED 150",price_min:150,booking_url:"https://t.example.com",booking_kind:"tickets",
      provider:"Dubai events",live:true,desc:"",keywords:"comedy show",coords:{lat:25.1960,lon:55.2720},...extra});
    const items=[E("sat","2026-10-03"),E("sun","2026-10-04"),E("past","2026-10-01"),E("next","2026-10-10"),
      E("tonightDone","2026-10-02",{time:"18:00"}),base("venue","Comedy Club Venue",{cat:"Theatre",cat_tags:["theatre"],primary_tags:["theatre"],keywords:"comedy club theatre"})];
    const plan=buildSearchPlan({query:"comedy show this weekend",now:NOW});
    assert.equal(plan.eventIntent,true);assert.ok(plan.eventTags.includes("comedy"));
    assert.deepEqual([plan.dateFrom,plan.dateTo],["2026-10-03","2026-10-04"]);
    const out=rankLive(items,{query:"comedy show this weekend",now:NOW,user_location:USER},plan).map(x=>x.id);
    assert.deepEqual(out.slice(0,2).sort(),["sat","sun"]);
    assert.ok(!out.includes("past")&&!out.includes("next")&&!out.includes("tonightDone"),out.join(","));
    const tonight=rankLive(items,{query:"comedy tonight",now:"2026-10-02T17:00:00+04:00"},buildSearchPlan({query:"comedy tonight",now:"2026-10-02T17:00:00+04:00"})).map(x=>x.id);
    assert.ok(tonight.includes("tonightDone")&&!tonight.includes("sat"),tonight.join(","));
    const pay=resultPayload(rankLive(items,{query:"comedy show this weekend",now:NOW},plan)).results.find(x=>x.id==="sat");
    assert.equal(pay.price,"AED 150");assert.equal(pay.time,"20:00");assert.equal(pay.booking_kind,"tickets");
  }finally{CITY.providers.events=was}
});

test("арабское имя без английского — транслитерация, тип места в конце",()=>{
  const t=translitArabic("مستشفى راشد");
  assert.match(t,/^[A-Za-z ]+$/);assert.match(t,/Hospital$/);
});
