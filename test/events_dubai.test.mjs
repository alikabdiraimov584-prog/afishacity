// Афиша Дубая: разбор источников (JSON-LD, лента Visit Dubai, расписание
// Dubai Opera), склейка дублей, окна дат (выходные ОАЭ — суббота и
// воскресенье), прошедшее не показывается, и событие доходит до выдачи.
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {
  jsonLdEvents,normalizeJsonLdEvent,parseVisitDubaiXml,normalizeVisitDubai,dubaiOperaSchedules,dubaiOperaCategory,
  localDateTime,parseHumanDate,parsePrice,offerMin,classify,dedupeEvents,affiliateUrl,districtMeta
} from "../scripts/dubai_events/normalize.mjs";
import {robotsDecision} from "../scripts/dubai_events/harvest.mjs";

const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");

const DISTRICT_PAGE=`<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"Kikkat Live at Opal Room",
"description":"Techno all night long. A DJ set with hypnotic grooves.","url":"https://www.district.ae/events/kikkat-live-at-opal-room-buy-tickets",
"image":"https://cdn.district.in/assets/events/x.jpg","eventStatus":"EventScheduled",
"location":{"@type":"Place","name":"Opal Room","address":"Emirates Financial Towers - DIFC - Dubai - United Arab Emirates","geo":{"@type":"GeoCoordinates","latitude":25.208592,"longitude":55.276557}},
"startDate":"2026-10-09T18:00:00.000Z","endDate":"2026-10-10T00:00:00.000Z",
"offers":{"@type":"AggregateOffer","lowPrice":0,"highPrice":200,"priceCurrency":"AED","offers":[
 {"@type":"Offer","name":"Kids under 3","price":0,"priceCurrency":"AED","url":"https://www.district.ae/events/kikkat-live-at-opal-room-buy-tickets"},
 {"@type":"Offer","name":"Female","price":100,"priceCurrency":"AED"},{"@type":"Offer","name":"Male","price":150,"priceCurrency":"AED"}]}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
<script>self.__next_f.push([1,"{\\"city\\":\\"Dubai\\",\\"category_id\\":{\\"_id\\":\\"539ff9f2e8883623584e8554\\",\\"name\\":\\"All\\"}}"])</script>
</head></html>`;

test("JSON-LD: событие District → запись афиши по времени Дубая", () => {
  const evs=jsonLdEvents(DISTRICT_PAGE);
  assert.equal(evs.length,1,"FAQPage не событие");
  const e=normalizeJsonLdEvent(evs[0],{pageUrl:"https://www.district.ae/events/kikkat-live-at-opal-room-buy-tickets"});
  // 18:00Z = 22:00 в Дубае (UTC+4), тот же день; конец «в полночь» — та же ночь.
  assert.equal(e.date_start,"2026-10-09");assert.equal(e.date_end,"2026-10-09");assert.equal(e.time,"22:00");
  assert.equal(e.venue,"Opal Room");
  assert.deepEqual(e.coords,{lat:25.208592,lon:55.276557});
  // Бесплатный детский тариф — не «Free»: цена «от» — наименьшая платная.
  assert.equal(e.price_min,100);assert.equal(e.price,"from 100 AED");
  assert.equal(e.booking_provider,"District");assert.equal(e.booking_kind,"tickets");
  assert.match(e.booking_url,/^https:\/\/www\.district\.ae\/events\//);
  assert.equal(e.image_url,"https://cdn.district.in/assets/events/x.jpg");
  assert.ok(e.cat_tags.includes("club")&&e.cat_tags.includes("nightlife"),e.cat_tags.join(","));
  assert.equal(e.summary,null,"описание источника не копируется");
  assert.deepEqual(districtMeta(DISTRICT_PAGE),{city:"Dubai",category:null},"рубрика «All» — не рубрика");
  // Отменённое и без даты — не событие.
  assert.equal(normalizeJsonLdEvent({...evs[0],eventStatus:"https://schema.org/EventCancelled"}),null);
  assert.equal(normalizeJsonLdEvent({...evs[0],startDate:"soon"}),null);
});

test("даты, цены и рубрики разбираются без ловушек", () => {
  assert.deepEqual(localDateTime("2026-10-08"),{date:"2026-10-08",time:null});
  assert.deepEqual(localDateTime("2026-10-09T21:30:00+04:00"),{date:"2026-10-09",time:"21:30"});
  assert.deepEqual(localDateTime("2026-10-09T20:30:00.000Z"),{date:"2026-10-10",time:"00:30"},"после полуночи по Дубаю — следующий день");
  assert.equal(parseHumanDate("10 October 2026"),"2026-10-10");
  assert.equal(parseHumanDate("Oct 3, 2026"),"2026-10-03");
  assert.equal(parseHumanDate("TBC"),null);
  assert.equal(parsePrice("AED125"),125);assert.equal(parsePrice("From AED 1,250"),1250);assert.equal(parsePrice("125"),125);
  assert.equal(parsePrice("Free entry"),0);assert.equal(parsePrice("18+"),null);
  assert.equal(offerMin([{price:0,priceCurrency:"AED"}]),0,"только бесплатные тарифы — бесплатно");
  assert.equal(offerMin([{price:50,priceCurrency:"USD"}]),null,"чужая валюта не цена в AED");
  assert.ok(classify({title:"Dubai Comedy Festival: Mo Gilligan"}).cat_tags.includes("comedy"));
  assert.ok(!classify({title:"Dubai Comedy Festival: Mo Gilligan"}).cat_tags.includes("concert"));
  assert.ok(classify({title:"Shaan - All Of Me Tour",venue:"Coca-Cola Arena"}).cat_tags.includes("concert"),"гастроли на арене — концерт");
  assert.ok(classify({title:"Heli Dubai - Iconic Tour - 12 Mins"}).cat_tags.includes("tour"));
  assert.equal(classify({title:"Heli Dubai - Iconic Tour - 12 Mins"}).experience,true);
  assert.ok(classify({title:"Cinderella Show"}).cat_tags.includes("kids"));
  assert.equal(classify({title:"Dubai FinTech Summit"}).business,true);
  assert.ok(!classify({title:"Tufting Time | Dubai Festival City Mall",extra:"at Dubai Festival City Mall"}).cat_tags.includes("festival"),"Festival City — район, а не фестиваль");
});

test("Visit Dubai: XML-лента и Dubai Opera: расписание показов", () => {
  const xml=`<?xml version="1.0"?><events><event xmlns=""><id>{A881465A-15D2}</id><name>frequency-971</name>
<url>https://www.visitdubai.com/en/festivals-and-events/dubai-events-calendar/frequency-971</url><title>Frequency 971: Benny Benassi &amp; DJ Slim</title>
<image>https://www.visitdubai.com/-/media/x.jpg</image><intro>Groove to unmissable electronic beats</intro><text>Long copyrighted description that must not be stored.</text>
<ticketPrice>AED250</ticketPrice><buyTicketUrl>https://dubai.platinumlist.net/event-tickets/1/frequency</buyTicketUrl><location>25.2045,55.2654</location>
<address>Coca-Cola Arena</address><startDate>10 October 2026</startDate><endDate>10 October 2026</endDate></event></events>`;
  const rows=parseVisitDubaiXml(xml);
  assert.equal(rows.length,1);
  const e=normalizeVisitDubai(rows[0]);
  assert.equal(e.name,"Frequency 971: Benny Benassi & DJ Slim");
  assert.equal(e.date_start,"2026-10-10");assert.equal(e.time,null);
  assert.deepEqual(e.coords,{lat:25.2045,lon:55.2654});
  assert.equal(e.price_min,250);assert.equal(e.booking_provider,"Platinumlist");
  assert.equal(e.summary,"Groove to unmissable electronic beats");
  assert.ok(!JSON.stringify(e).includes("copyrighted"),"полное описание не хранится");
  assert.ok(e.cat_tags.includes("club"));
  const html=`x \\"schedules\\":[{\\"schedule_id\\":4218,\\"date\\":\\"2026-11-25\\",\\"time_slot\\":{\\"start_time\\":\\"20:00\\",\\"end_time\\":\\"22:00\\"}},
{\\"schedule_id\\":4219,\\"date\\":\\"2026-11-26\\",\\"time_slot\\":{\\"start_time\\":\\"20:00\\"}},{\\"schedule_id\\":4218,\\"date\\":\\"2026-11-25\\",\\"time_slot\\":{\\"start_time\\":\\"20:00\\"}}]`;
  assert.deepEqual(dubaiOperaSchedules(html),[{date:"2026-11-25",time:"20:00"},{date:"2026-11-26",time:"20:00"}]);
  assert.equal(dubaiOperaCategory("https://www.dubaiopera.com/en/events/comedy/trevor-noah"),"comedy");
  const op=normalizeJsonLdEvent({"@type":"Event",name:"Trevor Noah",startDate:"2026-11-25",location:{name:"Dubai Opera",geo:{latitude:25.1947,longitude:55.2784}},offers:{price:295,priceCurrency:"AED"}},
    {pageUrl:"https://www.dubaiopera.com/en/events/comedy/trevor-noah",sourceCategory:"comedy",schedules:dubaiOperaSchedules(html)});
  assert.equal(op.date_start,"2026-11-25");assert.equal(op.date_end,"2026-11-26");assert.equal(op.time,"20:00");
  assert.equal(op.dates.length,2);assert.ok(op.cat_tags.includes("comedy"));
});

test("одно событие из двух источников склеивается, разные — нет", () => {
  const a={source_key:"visitdubai",name:"Dubai Comedy Festival: Mo Gilligan",date_start:"2026-10-12",date_end:"2026-10-12",time:null,venue:"Dubai Opera",
    coords:{lat:25.1947,lon:55.2784},cat_tags:["comedy","theatre"],price_min:null,source:"https://www.visitdubai.com/x",summary:"Big laughs"};
  const b={source_key:"dubaiopera",name:"Mo Gilligan Live at Dubai Comedy Festival",date_start:"2026-10-12",date_end:"2026-10-12",time:"18:30",venue:"Dubai Opera",
    coords:{lat:25.1948,lon:55.2785},cat_tags:["comedy","theatre"],price_min:250,source:"https://www.dubaiopera.com/y",booking_url:"https://www.dubaiopera.com/y"};
  const c={...b,name:"Katherine Ryan Live at Dubai Comedy Festival",time:"21:30",source:"https://www.dubaiopera.com/z"};
  const out=dedupeEvents([a,b,c]);
  assert.equal(out.length,2);
  const mo=out.find(x=>/Gilligan/.test(x.name));
  assert.equal(mo.time,"18:30","время — у площадки");assert.equal(mo.price_min,250);
  assert.equal(mo.summary,"Big laughs","анонс — из календаря");
  assert.deepEqual(mo.also,["https://www.visitdubai.com/x"]);
  // Тот же день, другая площадка — разные события.
  assert.equal(dedupeEvents([b,{...b,venue:"Coca-Cola Arena",coords:{lat:25.2043,lon:55.2654}}]).length,2);
});

test("партнёрские ссылки: только когда задано, только своему сайту", () => {
  const pl="https://dubai.platinumlist.net/event-tickets/107317/trevor-noah";
  assert.equal(affiliateUrl(pl,{}),pl);
  assert.equal(affiliateUrl(pl,{PLATINUMLIST_AFF:"abc123"}),`https://platinumlist.net/aff/?ref=abc123&link=${encodeURIComponent(pl)}`);
  assert.equal(affiliateUrl(pl,{PLATINUMLIST_AFF_TEMPLATE:"https://go.example/?u={url}"}),`https://go.example/?u=${encodeURIComponent(pl)}`);
  assert.equal(affiliateUrl(pl,{PLATINUMLIST_AFF:"bad ref!"}),pl,"мусор в коде партнёра не попадает в ссылку");
  assert.equal(affiliateUrl("https://www.district.ae/events/x-buy-tickets",{DISTRICT_AFF:"ref=free"}),"https://www.district.ae/events/x-buy-tickets?ref=free");
  assert.equal(affiliateUrl("https://www.dubaiopera.com/en/events/a/b",{EVENTS_UTM:"utm_source=free"}),"https://www.dubaiopera.com/en/events/a/b?utm_source=free");
  assert.equal(affiliateUrl("javascript:alert(1)",{}),null);
});

test("robots.txt: самое длинное правило решает, * и $ работают", () => {
  const rules=[{allow:false,path:"*/ticket/buy"},{allow:false,path:"/*?"},{allow:true,path:"/events/ok$"},{allow:false,path:"/events/"}];
  assert.equal(robotsDecision(rules,"/events/kikkat-buy-tickets"),false);
  assert.equal(robotsDecision(rules,"/events/ok"),true);
  assert.equal(robotsDecision(rules,"/a/ticket/buy"),false);
  assert.equal(robotsDecision(rules,"/search?q=1"),false);
  assert.equal(robotsDecision(rules,"/sitemap.xml"),true);
  assert.equal(robotsDecision([],"/anything"),true);
});

// Окна дат, «прошедшее не показываем» и путь до выдачи — в отдельном процессе
// с CITY=dubai: город читается при первом импорте city.mjs.
const url=(f)=>JSON.stringify(new URL(`../${f}`,import.meta.url).href);
const SCRIPT=`
const {eventWindow,weekendOf,searchDubaiEvents,eventAsk}=await import(${url("events_dubai.mjs")});
const {searchLiveInventory}=await import(${url("providers.mjs")});
const {rankLive,resultPayload}=await import(${url("live_ranker.mjs")});
// Четверг 1 октября 2026, 21:00 по Дубаю.
const THU=new Date("2026-10-01T17:00:00Z");
const win=(q,now=THU,args={})=>eventWindow(q,args,now);
const ev=(o)=>({kind:"event",cat_tags:[],venue:"Dubai Opera",area:"Downtown Dubai",coords:{lat:25.1947,lon:55.2784},
  price:"from 100 AED",price_min:100,booking_url:"https://www.dubaiopera.com/x",ticket_url:"https://www.dubaiopera.com/x",booking_provider:"Dubai Opera",
  image_url:"https://img.example/x.jpg",source:"https://www.dubaiopera.com/x",provider:"dubai_events",fetched_at:"2026-10-01T00:00:00Z",...o});
const items=[
  ev({id:"evt:dubaiopera:past",name:"Old Concert",category:"Concert",cat_tags:["concert"],date_start:"2026-09-28",date_end:"2026-09-28",time:"20:00"}),
  ev({id:"evt:dubaiopera:early",name:"Matinee Concert Today",category:"Concert",cat_tags:["concert"],date_start:"2026-10-01",date_end:"2026-10-01",time:"15:00"}),
  ev({id:"evt:dubaiopera:tonight",name:"Late Jazz Tonight",category:"Concert",cat_tags:["concert"],date_start:"2026-10-01",date_end:"2026-10-01",time:"22:00"}),
  ev({id:"evt:dubaiopera:fri",name:"Friday Gala",category:"Concert",cat_tags:["concert"],date_start:"2026-10-02",date_end:"2026-10-02",time:"20:00"}),
  ev({id:"evt:dubaiopera:sat",name:"Saturday Symphony",category:"Concert",cat_tags:["concert"],date_start:"2026-10-03",date_end:"2026-10-03",time:"20:00"}),
  ev({id:"evt:district:kids",name:"Puppet Show",category:"Kids & Family",cat_tags:["kids","theatre"],date_start:"2026-10-04",date_end:"2026-10-04",time:"11:00",venue:"Meyana Theatre"}),
  ev({id:"evt:district:club",name:"Techno Night with DJ X",category:"Nightlife",cat_tags:["club","nightlife"],date_start:"2026-10-03",date_end:"2026-10-03",time:"23:00",venue:"Opal Room"}),
  ev({id:"evt:district:heli",name:"Heli Tour 12 mins",category:"Tour",cat_tags:["tour"],experience:true,date_start:"2026-10-03",date_end:"2026-10-03",time:"10:00",venue:"HeliDubai"}),
  ev({id:"evt:visitdubai:summit",name:"Dubai FinTech Summit",category:"Conference",cat_tags:[],business:true,date_start:"2026-10-03",date_end:"2026-10-04",time:null,venue:"Madinat Jumeirah"}),
  ev({id:"evt:dubaiopera:next",name:"Comedy Next Week",category:"Comedy",cat_tags:["comedy","theatre"],date_start:"2026-10-09",date_end:"2026-10-09",time:"20:30"}),
  ev({id:"evt:dubaiopera:multi",name:"Trevor Noah",category:"Comedy",cat_tags:["comedy","theatre"],date_start:"2026-10-03",date_end:"2026-10-10",time:"20:00",
    dates:[{date:"2026-10-03",time:"20:00"},{date:"2026-10-10",time:"20:00"}]})
];
const S=(q,now=THU,args={})=>searchDubaiEvents({},{query:q,...args},{items,now:now.valueOf(),env:{}});
const names=(r)=>r.items.map(x=>x.name);
const out={
  weekends:{thu:weekendOf("2026-10-01"),fri:weekendOf("2026-10-02"),sat:weekendOf("2026-10-03"),sun:weekendOf("2026-10-04"),mon:weekendOf("2026-10-05")},
  windows:{weekend:win("concert this weekend"),tonight:win("what's on tonight"),tomorrow:win("tomorrow"),saturday:win("club on saturday"),
    nextWeekend:win("next weekend"),date:win("anything on 10 october"),target:win("concert this weekend",THU,{target_date:"2026-10-04"}),none:win("comedy show")},
  weekend:names(S("concert this weekend")),
  tonight:names(S("what's on tonight")),
  tonightLate:names(S("what's on tonight",new Date("2026-10-01T21:30:00Z"))),
  kids:names(S("events for kids this weekend")),
  club:names(S("nightclub with DJ Saturday")),
  tours:names(S("boat or helicopter tour this weekend")),
  conf:names(S("business conference this weekend")),
  allWeekend:names(S("events this weekend")),
  fallback:(()=>{const r=S("comedy tomorrow");return {names:names(r),fallback:r.fallback,date:r.items[0]?.date_start}})(),
  multi:S("comedy this weekend").items.map(x=>[x.name,x.date_start,x.times]),
  budget:names(S("concert this weekend",THU,{max_price_rub:50})),
  barTonight:S("bar tonight").items.length,
  ask:{opera:eventAsk("Dubai Opera tonight"),bar:eventAsk("bar tonight"),theatre:eventAsk("theatre tickets")},
  shape:S("concert this weekend").items[0]
};
// Путь до выдачи: источник подменён (без файла и сети), карта даёт два бара.
const bars=[1,2].map(i=>({id:"osm:node:"+i,provider:"OpenStreetMap",kind:"venue",name:"Bar "+i,organizer:"Bar "+i,cat:"Bar",tags:["bar","nightlife"],cat_tags:["bar","nightlife"],
  area:"Downtown",metro:"",date_start:null,date_end:null,times:[],hours_label:"Mo-Su 18:00-03:00",price_label:null,price_min:null,free:false,
  availability:"",source:"https://www.openstreetmap.org/node/"+i,official_source:"https://bar"+i+".example.com",phone:"+9714000000"+i,coords:{lat:25.2+i/1000,lon:55.27},keywords:"bar pub cocktails"}));
// Ранкер сверяет даты с настоящим «сегодня», поэтому здесь событие — на
// сегодня в 23:59 (вечер и ещё не прошло в любое время суток).
const {cityDate}=await import(${url("city.mjs")});
const today=cityDate();
const pipeItems=[ev({id:"evt:dubaiopera:live",name:"Late Jazz Tonight",category:"Concert",cat_tags:["concert"],date_start:today,date_end:today,time:"23:59"})];
const stub=(plan,args)=>searchDubaiEvents(plan,args,{items:pipeItems,env:{}});
const live=await searchLiveInventory({query:"what's on tonight"},{},{providers:{osm:async()=>({items:bars,errors:[]}),dubai_events:stub},cache:{get:()=>null,set:()=>{}}});
const ranked=rankLive(live.items,{query:"what's on tonight"},live.plan);
out.today=today;
out.pipeline={eventAsk:live.plan.eventAsk,providers:live.providers,payload:resultPayload(ranked,live).results.map(x=>({kind:x.kind,name:x.name,date:x.date,time:x.time,price:x.price,booking_kind:x.booking_kind,booking_url:x.booking_url,reasons:x.reasons}))};
const plain=await searchLiveInventory({query:"bar"},{},{providers:{osm:async()=>({items:bars,errors:[]}),dubai_events:stub},cache:{get:()=>null,set:()=>{}}});
out.plainBar={eventAsk:plain.plan.eventAsk||null,events:plain.items.filter(x=>x.kind==="event").length};
process.stdout.write(JSON.stringify(out));
`;
let R=null;
const run=()=>R||(R=JSON.parse(execFileSync(process.execPath,["--no-warnings","--input-type=module","-e",SCRIPT],
  {cwd:ROOT,env:{...process.env,CITY:"dubai",NODE_ENV:"test",EVENTS_DUBAI_FILE:join(ROOT,"test","__no_events__.json")},encoding:"utf8",maxBuffer:16*1024*1024})));

test("окна дат: выходные ОАЭ — суббота и воскресенье", () => {
  const r=run();
  assert.deepEqual(r.weekends.thu,{start:"2026-10-03",end:"2026-10-04"});
  assert.deepEqual(r.weekends.fri,{start:"2026-10-03",end:"2026-10-04"},"пятница — ещё не выходной");
  assert.deepEqual(r.weekends.sat,{start:"2026-10-03",end:"2026-10-04"});
  assert.deepEqual(r.weekends.sun,{start:"2026-10-04",end:"2026-10-04"},"в воскресенье суббота уже прошла");
  assert.deepEqual(r.weekends.mon,{start:"2026-10-10",end:"2026-10-11"});
  const w=r.windows;
  assert.equal(w.weekend.start,"2026-10-03");assert.equal(w.weekend.end,"2026-10-04");assert.equal(w.weekend.label,"this weekend");
  assert.equal(w.tonight.start,"2026-10-01");assert.equal(w.tonight.end,"2026-10-01");assert.equal(w.tonight.evening,true);
  assert.equal(w.tomorrow.start,"2026-10-02");
  assert.equal(w.saturday.start,"2026-10-03");assert.equal(w.saturday.end,"2026-10-03");
  assert.deepEqual([w.nextWeekend.start,w.nextWeekend.end],["2026-10-10","2026-10-11"]);
  assert.equal(w.date.start,"2026-10-10");
  assert.deepEqual([w.target.start,w.target.end],["2026-10-04","2026-10-04"],"дата от агента важнее слов");
  assert.equal(w.none.explicit,false);assert.equal(w.none.end,"2026-10-31");
});

test("поиск: окно, рубрика, прошедшее исключено, ближайшее при пустом окне", () => {
  const r=run();
  assert.deepEqual(r.weekend,["Saturday Symphony"],"пятница и прошлое — не выходные");
  // Сегодня вечером: дневной концерт (15:00) уже не «вечер», прошедший — никогда.
  assert.deepEqual(r.tonight,["Late Jazz Tonight"]);
  // В 01:30 ночи следующих суток «сегодня» — уже пятница.
  assert.ok(!r.tonightLate.includes("Late Jazz Tonight"));
  assert.ok(!r.allWeekend.includes("Old Concert"));
  assert.deepEqual(r.kids,["Puppet Show"]);
  assert.deepEqual(r.club,["Techno Night with DJ X"]);
  assert.ok(r.tours.includes("Heli Tour 12 mins"),"тур — когда просят тур");
  assert.ok(!r.allWeekend.includes("Heli Tour 12 mins"),"«на любой день» не выдаётся за событие");
  assert.ok(!r.allWeekend.includes("Dubai FinTech Summit"),"саммиты — только по прямому запросу");
  assert.deepEqual(r.conf,["Dubai FinTech Summit"]);
  assert.deepEqual(r.fallback,{names:["Trevor Noah","Comedy Next Week"],fallback:true,date:"2026-10-03"});
  assert.deepEqual(r.multi,[["Trevor Noah","2026-10-03",["20:00"]]],"многодневное — дата показа внутри окна");
  assert.deepEqual(r.budget,[],"дороже бюджета — нет");
  assert.equal(r.barTonight,0,"«bar tonight» — про место, не про афишу");
  assert.equal(r.ask.opera.asked,true);assert.deepEqual(r.ask.opera.tags,[],"Dubai Opera — площадка, а не жанр");
  assert.equal(r.ask.bar.asked,false);
  assert.equal(r.ask.theatre.asked,true);
});

test("карточка события той же формы, что KudaGo/Timepad", () => {
  const x=run().shape;
  for(const k of ["id","provider","kind","name","organizer","cat","tags","cat_tags","area","date_start","date_end","times","price_label","price_min",
    "free","availability","source","point_source","aggregator_image","booking_url","booking_kind","booking_provider","desc","keywords","coords"])
    assert.ok(k in x,`нет поля ${k}`);
  assert.equal(x.kind,"event");assert.equal(x.live,true);
  assert.equal(x.date_start,"2026-10-03");assert.deepEqual(x.times,["20:00"]);
  assert.equal(x.price_label,"from 100 AED");assert.equal(x.booking_kind,"tickets");
  assert.ok(x.cat_tags.includes("concert"));
  assert.equal(x.organizer,"Dubai Opera");assert.equal(x.provider,"Dubai Opera");
});

test("«what's on tonight»: событие выше баров, «bar» — без афиши", () => {
  const r=run();
  assert.deepEqual(r.pipeline.eventAsk,{label:"tonight",fallback:false});
  assert.equal(r.pipeline.providers.dubai_events,true);
  const top=r.pipeline.payload[0];
  assert.equal(top.kind,"event");assert.equal(top.name,"Late Jazz Tonight");
  assert.equal(top.date,r.today);assert.equal(top.time,"23:59");assert.equal(top.price,"from 100 AED");
  assert.equal(top.booking_kind,"tickets");assert.match(top.booking_url,/dubaiopera\.com/);
  assert.ok(top.reasons.includes("tonight"),top.reasons.join(", "));
  assert.ok(r.pipeline.payload.some(x=>x.kind==="venue"),"бары остаются ниже");
  assert.deepEqual(r.plainBar,{eventAsk:null,events:0});
});

test("free-events.service: предел кучи под MemoryMax, таймер — каждые 6 часов", async () => {
  const {readFileSync}=await import("node:fs");
  const svc=readFileSync(join(ROOT,"deploy","free-events.service"),"utf8");
  const tim=readFileSync(join(ROOT,"deploy","free-events.timer"),"utf8");
  const heap=Number((/--max-old-space-size=(\d+)/.exec(svc)||[])[1]);
  const max=Number((/^MemoryMax=(\d+)M$/m.exec(svc)||[])[1]),high=Number((/^MemoryHigh=(\d+)M$/m.exec(svc)||[])[1]);
  assert.ok(heap>0&&max>Math.round(heap*1.1875)+16+64,`куча ${heap} МБ не помещается под MemoryMax ${max} МБ`);
  assert.ok(high&&high<max);
  assert.match(svc,/^User=free$/m);assert.match(svc,/^WorkingDirectory=\/opt\/afishacity$/m);
  assert.match(svc,/scripts\/dubai_events\/harvest\.mjs/);
  assert.match(svc,/^ReadWritePaths=\/opt\/afishacity\/data$/m);
  // StartLimit* — только в [Unit], иначе systemd их молча игнорирует.
  const unitPart=svc.split(/^\[Service\]$/m)[0];
  assert.match(unitPart,/^StartLimitBurst=/m);
  assert.match(tim,/^OnCalendar=\*-\*-\* 00\/6:/m);assert.match(tim,/^Unit=free-events\.service$/m);
  const inst=readFileSync(join(ROOT,"deploy","install.sh"),"utf8");
  assert.match(inst,/free-events\.timer/);assert.match(inst,/\$PREBUILT\/events_dubai\.json/);
});
