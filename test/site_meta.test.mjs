// Данные с сайтов заведений → теги: часы schema.org → OSM opening_hours,
// priceRange → free:price, ссылки брони → провайдер, защита от сайтов сетей.
import test from "node:test";
import assert from "node:assert/strict";
import {hoursToOsm,validOpeningHours,priceLevel,detectProvider,websiteBookingOk,normCuisine,applySiteMeta,parseTime} from "../scripts/dubai_offline/site_meta/apply_site_meta.mjs";
import {parseSchedule} from "../hours.mjs";

const spec=(days,opens,closes,extra={})=>({dayOfWeek:[].concat(days),opens,closes,...extra});

test("openingHoursSpecification → OSM opening_hours", ()=>{
  const week=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  assert.equal(hoursToOsm({openingHoursSpecification:week.map(d=>spec(d,"10:00","01:00"))}),"Mo-Su 10:00-01:00");
  assert.equal(hoursToOsm({openingHoursSpecification:[
    spec(["https://schema.org/Sunday","https://schema.org/Monday","https://schema.org/Tuesday","https://schema.org/Wednesday","https://schema.org/Thursday"],"11:00:00","23:00:00"),
    spec(["Friday","Saturday"],"11:00","23:30")]}),"Mo-Th,Su 11:00-23:00; Fr,Sa 11:00-23:30");
  // 23:59 и 00:00 на закрытии — до полуночи; 00:00–23:59 всю неделю — круглосуточно
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"07:00","00:00")]}),"Mo-Su 07:00-24:00");
  assert.equal(hoursToOsm({openingHoursSpecification:week.map(d=>spec(d,"00:00","23:59"))}),"24/7");
  // 00:00–00:00 по schema.org — выходной; не названный день — тоже выходной
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(["Monday"],"00:00","00:00"),spec(["Tuesday","Wednesday","Thursday","Friday"],"09:00","18:00")]}),"Tu-Fr 09:00-18:00");
  // перерыв днём: два интервала в один день
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"12:00","15:00"),spec(week,"19:00","23:30")]}),"Mo-Su 12:00-15:00,19:00-23:30");
  // 12-часовое время и часовой пояс
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"9:00 AM","10:30 PM")]}),"Mo-Su 09:00-22:30");
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"08:00:00+04:00","22:00:00+04:00")]}),"Mo-Su 08:00-22:00");
  // особые даты (праздник) не ломают обычную неделю
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"10:00","22:00"),spec([],"12:00","18:00",{validFrom:"2026-12-25",validThrough:"2026-12-25"})]}),"Mo-Su 10:00-22:00");
  // мусор — ничего
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(["Funday"],"10:00","22:00")]}),null);
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"","")]}),null);
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"22:00","14:00")]}),null);
  // пересекающиеся интервалы (завтрак внутри дня) — объединяем; «Monday-Friday» в dayOfWeek
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(week,"06:00","23:00"),spec(week,"06:00","11:00")]}),"Mo-Su 06:00-23:00");
  assert.equal(hoursToOsm({openingHoursSpecification:[spec(["Monday-Friday"],"09:00","18:00")]}),"Mo-Fr 09:00-18:00");
});

test("строки openingHours → OSM opening_hours", ()=>{
  const cases=[
    [["Mo-Th 12:00-23:00","Fr-Sa 12:00-01:00","Su 12:00-23:00"],"Mo-Th,Su 12:00-23:00; Fr,Sa 12:00-01:00"],
    [["Mo,Tu,We,Th 06:30-21:30","Fr 06:30-22:00","Sa,Su 08:00-19:00"],"Mo-Th 06:30-21:30; Fr 06:30-22:00; Sa,Su 08:00-19:00"],
    ["Mo,Tu,We 09:00-17:00","Mo-We 09:00-17:00"],
    ["Sunday - Thursday: 12pm - 12am, Friday & Saturday: 12pm - 1am","Mo-Th,Su 12:00-24:00; Fr,Sa 12:00-01:00"],
    ["Daily 10 AM - 10 PM","Mo-Su 10:00-22:00"],
    ["Tu-Su 12:00-23:00, Mo closed","Tu-Su 12:00-23:00"],
    ["Mo-Fr 9:00-17:00 Sa 10:00-14:00","Mo-Fr 09:00-17:00; Sa 10:00-14:00"],
    ["Monday to Friday 8:30 am to 6 pm","Mo-Fr 08:30-18:00"],
    ["Mo-Su 12:00-15:00, 19:00-23:30","Mo-Su 12:00-15:00,19:00-23:30"],
    ["24/7","24/7"],
    ["Mo-Su 00:00-23:59","24/7"],
    ["10:00-22:00","Mo-Su 10:00-22:00"],
    ["Mon – Sat: 9:00am – 9:00pm; Sun - closed","Mo-Sa 09:00-21:00"],
    ["<li>Monday to Thursday - 10 am to 11 pm</li><li>Friday to Sunday - 10 am to 12 am</li>","Mo-Th 10:00-23:00; Fr-Su 10:00-24:00"],
    [["Mo 10:00-22:00","Tu 10:00-22:00","Mo 10:00-22:00","Tu 10:00-22:00"],"Mo,Tu 10:00-22:00"],
    [["Mo All Day","Tu All Day","We All Day","Th All Day","Fr All Day","Sa All Day","Su All Day"],"24/7"],
    ["Mo 08:00-18:00, Tu 08:00-18:00, , Sa 08:00-18:00","Mo,Tu,Sa 08:00-18:00"],
  ];
  for(const [src,want] of cases)assert.equal(hoursToOsm({openingHours:[].concat(src)}),want,JSON.stringify(src));
  for(const bad of ["Call us","Mo-Su","Mo-Su 00:00-00:00","Open for lunch and dinner","Mo-Fr 9-5","Seasonal: Mo-Su 10:00-22:00 (winter)"])
    assert.equal(hoursToOsm({openingHours:[bad]}),null,bad);
});

test("результат понимает разбор часов приложения (hours.mjs)", ()=>{
  const osm=hoursToOsm({openingHours:["Mo-Th 12:00-23:00","Fr-Sa 12:00-01:00","Su 12:00-23:00"]});
  const w=parseSchedule(osm);
  assert.deepEqual(w[0],[{start:720,end:1380}]);
  assert.deepEqual(w[4],[{start:720,end:1500}],"пятница до 01:00 — через полночь");
  assert.deepEqual(w[6],[{start:720,end:1380}]);
  assert.equal(parseSchedule(hoursToOsm({openingHoursSpecification:[spec(["Monday"],"09:00","17:00")]}))[1].length,0,"не названный день — выходной");
});

test("validOpeningHours", ()=>{
  for(const ok of ["24/7","Mo-Su 10:00-22:00","Mo-Th,Su 12:00-24:00; Fr,Sa 12:00-01:00","Mo-Su 12:00-15:00,19:00-23:30","Sa 09:00-13:00"])assert.ok(validOpeningHours(ok),ok);
  for(const bad of ["","Mo-Su","Mo-Su 25:00-26:00","Mo-Su 10:00-10:00","Monday 10:00-22:00","Mo-Su 10-22","Mo-Su 10:00-22:00;Sa off x"])assert.ok(!validOpeningHours(bad),bad);
  assert.equal(parseTime("12 noon"),720);assert.equal(parseTime("12:00 AM"),0);assert.equal(parseTime("9"),null);
});

test("priceRange → free:price 1–4", ()=>{
  const cases=[["$",1],["$$",2],["$$$",3],["$$$$",4],["$$$$$",4],["AED",1],["$$ - $$$",3],["€€",2],
    ["AED 30",1],["AED 50-70",2],["AED 100-200",2],["AED 150 - 300 per person",3],["AED 400+",4],["300-600 AED",4],["200-500 AED",3],
    ["$20-$40",2],["AED 400 for two",3],["Moderate",2],["Inexpensive",1],["Very Expensive",4]];
  for(const [pr,want] of cases)assert.equal(priceLevel(pr),want,pr);
  for(const bad of [null,"","Free","1-2","call","100-200"])assert.equal(priceLevel(bad),null,String(bad));
  assert.equal(priceLevel("AED 500-1500",{lodging:true}),null,"цена номера — не чек");
  assert.equal(priceLevel("$$$",{lodging:true}),3);
});

test("провайдер брони по ссылке", ()=>{
  const cases=[
    ["https://www.sevenrooms.com/reservations/zumadubai","SevenRooms",true],
    ["https://www.sevenrooms.com/explore/coyacafedubai/reservations/create/search","SevenRooms",true],
    ["https://sevenrooms.com/","SevenRooms",false],
    ["https://www.opentable.ae/r/the-ivy-dubai","OpenTable",true],
    ["https://www.opentable.com/restref/client/?rid=123456","OpenTable",true],
    ["https://www.opentable.com/","OpenTable",false],
    ["https://eatapp.co/reserve/kinoya-dubai","Eat App",true],
    ["https://eatapp.co/pricing","Eat App",false],
    ["https://www.tablecheck.com/en/shops/tresind-dubai/reserve","TableCheck",true],
    ["https://resy.com/cities/dxb/venue-name","Resy",true],
    ["https://www.quandoo.ae/place/some-place-12345","Quandoo",true],
    ["https://www.resdiary.com/restaurant/somewhere","ResDiary",true],
    ["https://book.chope.co/booking?rid=abc123","Chope",true],
    ["https://www.thefork.com/restaurant/le-bistro-r12345","TheFork",true],
  ];
  for(const [u,p,s] of cases)assert.deepEqual(detectProvider(u),{provider:p,specific:s},u);
  const more=[
    ["https://www.opentable.com/restref/client/","OpenTable",false],
  ];
  for(const [u,p,s] of more)assert.deepEqual(detectProvider(u),{provider:p,specific:s},u);
  assert.equal(detectProvider("https://www.example-restaurant.ae/book"),null);
  // своя страница брони на сайте заведения
  for(const u of ["https://vicolodubai.com/reservations/","https://ryzestudio.ae/book-now","https://dclinic.ae/book-an-appointment/"])assert.ok(websiteBookingOk(u),u);
  for(const u of ["https://drtosundental.com/","https://headz.com/contact-us/","https://x.ae/get-a-quote/","https://www.marriott.com/reservation/lookupReservation.mi","https://x.ae/gift-vouchers/book"])assert.ok(!websiteBookingOk(u),u);
  assert.equal(detectProvider("not a url"),null);
});

test("кухня → значения OSM", ()=>{
  assert.equal(normCuisine(["Italian","Pizza"]),"italian;pizza");
  assert.equal(normCuisine("Middle Eastern, Lebanese"),"middle_eastern;lebanese");
  assert.equal(normCuisine(["Steakhouse","Sea Food","Vegan"]),"steak_house;seafood");
  assert.equal(normCuisine(["Pan-Asian","Japanese Cuisine","Burgers"]),"asian;japanese;burger");
  assert.equal(normCuisine(["Restaurant","Fast Food"]),null);
});

test("applySiteMeta: сайт одного заведения", ()=>{
  const rec={site:"https://vicolodubai.com/",final_url:"https://vicolodubai.com/",ok:true,n_places:1,
    entities:[{type:["Restaurant"],name:"Vicolo",src:"https://vicolodubai.com/",geo:[25.20012,55.27015],priceRange:"$$$",servesCuisine:["Italian"],
      openingHoursSpecification:[spec(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],"12:00","00:00")]}],
    booking:[{url:"https://vicolodubai.com/reservations/",provider:"Website",specific:true,src:"https://vicolodubai.com/"},
      {url:"https://www.sevenrooms.com/reservations/vicolo",provider:"SevenRooms",specific:true,src:"https://vicolodubai.com/reservations/"}],
    menu:[{url:"https://vicolodubai.com/wp-content/uploads/2024/05/Vicolo-Menu-2024-1.pdf",kind:"pdf",same:true,how:"a",src:"https://vicolodubai.com/"}]};
  const t={name:"Vicolo",amenity:"restaurant",website:"https://vicolodubai.com/"};
  const wrote=applySiteMeta(t,rec,{lat:25.2001,lon:55.2701,users:1});
  assert.deepEqual(wrote.sort(),["cuisine","free:booking_url","free:menu","free:price","opening_hours"]);
  assert.equal(t.opening_hours,"Mo-Su 12:00-24:00");assert.equal(t["source:opening_hours"],"website");
  assert.equal(t["free:price"],"3");assert.equal(t["free:price_src"],"site");
  assert.equal(t["free:booking_url"],"https://www.sevenrooms.com/reservations/vicolo");assert.equal(t["free:booking_provider"],"SevenRooms");
  assert.match(t["free:menu"],/Vicolo-Menu/);assert.equal(t.cuisine,"italian");
  // часы и кухню из OSM не трогаем
  const t2={name:"Vicolo",opening_hours:"Mo-Su 09:00-17:00",cuisine:"pizza"};
  applySiteMeta(t2,rec,{lat:25.2001,lon:55.2701,users:1});
  assert.equal(t2.opening_hours,"Mo-Su 09:00-17:00");assert.equal(t2.cuisine,"pizza");assert.equal(t2["source:opening_hours"],undefined);
  // далеко (другой город) — сущность не наша
  const t3={name:"Vicolo"};applySiteMeta(t3,rec,{lat:24.45,lon:54.38,users:1});
  assert.equal(t3.opening_hours,undefined);
});

test("applySiteMeta: сайт сети — часы одного филиала не всем", ()=>{
  const ent=(name,geo,addr)=>({type:["Restaurant"],name,geo,address:addr,src:"https://brand.ae/locations",
    openingHoursSpecification:[spec(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],"08:00","23:00")]});
  const rec={site:"https://brand.ae/",final_url:"https://brand.ae/",ok:true,n_places:12,
    entities:[ent("Brand Cafe",[25.0800,55.1400],"Dubai Marina Mall"),ent("Brand Cafe",[25.2000,55.2700],"Dubai Mall")],
    booking:[{url:"https://www.sevenrooms.com/reservations/brandcafemarina",provider:"SevenRooms",specific:true,src:"https://brand.ae/"},
      {url:"https://www.sevenrooms.com/reservations/brandcafedubaimall",provider:"SevenRooms",specific:true,src:"https://brand.ae/"}],
    menu:[{url:"https://brand.ae/menu",kind:"page",same:true,how:"a",src:"https://brand.ae/"}]};
  // филиал у Marina Mall — совпали координаты
  const a={name:"Brand Cafe Marina",amenity:"cafe",website:"https://brand.ae/"};
  applySiteMeta(a,rec,{lat:25.0801,lon:55.1401,users:12});
  assert.equal(a.opening_hours,"Mo-Su 08:00-23:00");
  assert.equal(a["free:booking_url"],"https://www.sevenrooms.com/reservations/brandcafemarina");
  assert.equal(a["free:menu"],undefined,"меню бренда без названия филиала — нет");
  // филиал, которого нет на сайте: ни часов, ни чужой брони
  const b={name:"Brand Cafe",amenity:"cafe",website:"https://brand.ae/"};
  applySiteMeta(b,rec,{lat:25.30,lon:55.40,users:12});
  assert.equal(b.opening_hours,undefined);assert.equal(b["free:booking_url"],undefined);
  // меню бренда — только если явно разрешено
  const c={name:"Brand Cafe",amenity:"cafe",website:"https://brand.ae/"};
  applySiteMeta(c,rec,{lat:25.30,lon:55.40,users:12,chainMenu:true});
  assert.equal(c["free:menu"],"https://brand.ae/menu");
});

test("applySiteMeta: два филиала с одним именем и разными часами — без угадывания", ()=>{
  const e=(name,o,c)=>({type:["Restaurant"],name,src:"https://hadoota.ae/",openingHoursSpecification:[spec(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],o,c)]});
  const rec={site:"https://hadoota.ae/",final_url:"https://hadoota.ae/",ok:true,n_places:1,
    entities:[e("Hadoota - Sheikh Zayed Road","09:00","01:00"),e("Hadoota - Ibn Battuta Mall","10:00","23:00")],booking:[],menu:[]};
  const t={name:"Hadoota",amenity:"restaurant"};
  applySiteMeta(t,rec,{users:1});
  assert.equal(t.opening_hours,undefined);
  // а имя филиала в имени места — берём его
  const t2={name:"Hadoota Ibn Battuta Mall",amenity:"restaurant"};
  applySiteMeta(t2,rec,{users:1});
  assert.equal(t2.opening_hours,"Mo-Su 10:00-23:00");
});

test("applySiteMeta: ресторан на сайте отеля не получает часы и бронь отеля", ()=>{
  const rec={site:"https://grandhotel.com/",final_url:"https://grandhotel.com/",ok:true,n_places:1,
    entities:[{type:["Hotel"],name:"Grand Hotel Dubai",geo:[25.10003,55.20004],src:"https://grandhotel.com/",priceRange:"$$$$",openingHours:["Mo-Su 00:00-23:59"]}],
    booking:[{url:"https://grandhotel.com/book-now",provider:"Website",specific:true,src:"https://grandhotel.com/"}],menu:[]};
  const t={name:"Pierchic",amenity:"restaurant",website:"https://grandhotel.com/"};
  assert.deepEqual(applySiteMeta(t,rec,{lat:25.1001,lon:55.2001,users:1}),[]);
});
