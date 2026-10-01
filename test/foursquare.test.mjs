// Foursquare и Google Places: карточка собирается из ответа в том же формате,
// что у Яндекса и 2GIS, ключ Google не утекает в адрес фото, слоты включаются
// только с ключом и только в городе, который их перечислил.
import test from "node:test";
import assert from "node:assert/strict";
import {CITY} from "../city.mjs";
import {searchFoursquare,normalizeFoursquareItem,searchGooglePlaces,normalizeGoogleItem,googlePhotoUrl,
  searchLiveInventory,buildSearchPlan,ENRICH_PROVIDERS,FOURSQUARE_VERSION} from "../providers.mjs";

const FSQ_PLACE={fsq_place_id:"4b5a1c2df964a520f7b728e3",name:"Barasti Beach",
  categories:[{fsq_category_id:"4bf58dd8d48988d116941735",name:"Bar",short_name:"Bar"},{name:"Beach Bar"}],
  location:{formatted_address:"Le Meridien Mina Seyahi, Al Sufouh Rd, Dubai"},latitude:25.0929,longitude:55.1497,
  hours:{display:"Mon-Thu 9:00 AM-2:00 AM; Fri-Sun 9:00 AM-3:00 AM",open_now:true},
  tel:"+971 4 318 1313",website:"https://www.barastibeach.com",rating:8.6,stats:{total_ratings:1240,total_photos:900},
  price:2,photos:[{id:"p1",prefix:"https://fastly.4sqi.net/img/general/","suffix":"/abc.jpg",width:1920,height:1440}]};

test("Foursquare: карточка в общем формате, рейтинг по пятибалльной, фото и ценовой уровень", async () => {
  let seen=null;
  const real=globalThis.fetch;
  globalThis.fetch=async(u,o)=>{seen={url:new URL(String(u)),opts:o};return {ok:true,status:200,json:async()=>({results:[FSQ_PLACE,FSQ_PLACE]})}};
  try{
    const out=await searchFoursquare({placeQueries:["bar"],area:null,userLocation:{lat:25.08,lon:55.14},near:true},"service-key");
    assert.equal(out.items.length,1,"дубликаты одного места отсеяны");
    const x=out.items[0];
    assert.equal(x.id,"fsq:place:4b5a1c2df964a520f7b728e3");
    assert.equal(x.provider,"Foursquare");assert.equal(x.kind,"venue");assert.equal(x.live,true);
    assert.equal(x.cat,"Bar");
    assert.ok(x.cat_tags.includes("bar"),`рубрика «Bar» даёт тег bar: ${x.cat_tags}`);
    assert.equal(x.rating,4.3,"8.6 из 10 → 4.3 из 5");
    assert.equal(x.rating_count,1240);
    assert.equal(x.price_label,"$$");assert.equal(x.price_min,null);
    assert.equal(x.hours_label,"Mon-Thu 9:00 AM-2:00 AM; Fri-Sun 9:00 AM-3:00 AM");
    assert.equal(x.open_now,true);
    assert.equal(x.phone,"+971 4 318 1313");
    assert.equal(x.official_source,"https://www.barastibeach.com/");
    assert.equal(x.aggregator_image,"https://fastly.4sqi.net/img/general/original/abc.jpg");
    assert.equal(x.aggregator_name,"Foursquare");
    assert.equal(x.source,"https://foursquare.com/v/4b5a1c2df964a520f7b728e3");
    assert.deepEqual(x.coords,{lat:25.0929,lon:55.1497});
    assert.equal(x.booking_kind,"phone");
    // Запрос: новый хост, Bearer, версия, явный список полей, точка человека.
    assert.equal(seen.url.origin+seen.url.pathname,"https://places-api.foursquare.com/places/search");
    assert.equal(seen.opts.headers.Authorization,"Bearer service-key");
    assert.equal(seen.opts.headers["X-Places-Api-Version"],FOURSQUARE_VERSION);
    assert.equal(seen.url.searchParams.get("ll"),"25.08,55.14");
    assert.equal(seen.url.searchParams.get("radius"),"4000");
    assert.equal(seen.url.searchParams.get("limit"),"20");
    assert.match(seen.url.searchParams.get("fields"),/fsq_place_id.*photos/);
  }finally{globalThis.fetch=real}
});

test("Foursquare: без ключа выключен; отказ сети — ошибка, а не пустая выдача", async () => {
  const off=await searchFoursquare({placeQueries:["bar"]},"");
  assert.equal(off.disabled,true);assert.equal(off.items.length,0);
  const real=globalThis.fetch;
  globalThis.fetch=async()=>({ok:false,status:401,statusText:"Unauthorized"});
  try{await assert.rejects(()=>searchFoursquare({placeQueries:["bar"]},"bad"),/Foursquare: 401/)}
  finally{globalThis.fetch=real}
});

test("Foursquare: пустой и ядовитый ответ не роняют нормализацию", () => {
  const x=normalizeFoursquareItem({fsq_place_id:"1",name:{toString:1},categories:"nope",photos:[null,{prefix:5}],rating:"x",price:9},{});
  assert.equal(x.name,"Place");assert.equal(x.rating,null);assert.equal(x.aggregator_image,null);
  assert.equal(x.price_label,null);assert.equal(x.coords,null);assert.equal(x.hours_label,null);
});

const G_PLACE={id:"ChIJrTLr-GyuEmsRBfy61i59si0",displayName:{text:"Zuma Dubai",languageCode:"en"},
  formattedAddress:"Gate Village 06, DIFC, Dubai",location:{latitude:25.2131,longitude:55.2824},
  rating:4.6,userRatingCount:5320,currentOpeningHours:{openNow:false},
  regularOpeningHours:{weekdayDescriptions:["Monday: 12:00 – 3:00 PM, 7:00 PM – 1:00 AM","Tuesday: Closed"]},
  internationalPhoneNumber:"+971 4 425 5660",websiteUri:"https://zumarestaurant.com/dubai",priceLevel:"PRICE_LEVEL_VERY_EXPENSIVE",
  primaryTypeDisplayName:{text:"Japanese restaurant"},types:["japanese_restaurant","restaurant","bar","point_of_interest","establishment"],
  photos:[{name:"places/ChIJrTLr-GyuEmsRBfy61i59si0/photos/AUc7tXX_abc-123",widthPx:4032,heightPx:3024}]};

test("Google Places: текстовый поиск с маской полей, фото без ключа в адресе", async () => {
  let seen=null;
  const real=globalThis.fetch;
  globalThis.fetch=async(u,o)=>{seen={url:String(u),opts:o};return {ok:true,status:200,json:async()=>({places:[G_PLACE]})}};
  try{
    const out=await searchGooglePlaces({placeQueries:["japanese restaurant"],area:"center",userLocation:null,near:false},"GKEY");
    const x=out.items[0];
    assert.equal(x.id,"google:place:ChIJrTLr-GyuEmsRBfy61i59si0");
    assert.equal(x.provider,"Google");assert.equal(x.name,"Zuma Dubai");assert.equal(x.cat,"Japanese restaurant");
    assert.equal(x.rating,4.6);assert.equal(x.rating_count,5320);assert.equal(x.price_label,"$$$$");
    assert.equal(x.open_now,false);
    assert.equal(x.hours_label,"Monday: 12:00 – 3:00 PM, 7:00 PM – 1:00 AM; Tuesday: Closed");
    assert.equal(x.phone,"+971 4 425 5660");assert.equal(x.official_source,"https://zumarestaurant.com/dubai");
    assert.deepEqual(x.coords,{lat:25.2131,lon:55.2824});
    assert.ok(x.cat_tags.includes("food")||x.cat_tags.includes("bar"),`типы дают теги: ${x.cat_tags}`);
    assert.equal(x.aggregator_image,"https://places.googleapis.com/v1/places/ChIJrTLr-GyuEmsRBfy61i59si0/photos/AUc7tXX_abc-123/media?maxWidthPx=800");
    assert.ok(!/GKEY/.test(x.aggregator_image),"ключ не должен попадать в адрес, который видит клиент");
    assert.equal(seen.url,"https://places.googleapis.com/v1/places:searchText");
    assert.equal(seen.opts.method,"POST");
    assert.equal(seen.opts.headers["X-Goog-Api-Key"],"GKEY");
    assert.match(seen.opts.headers["X-Goog-FieldMask"],/places\.id,places\.displayName.*places\.photos/);
    const body=JSON.parse(seen.opts.body);
    assert.match(body.textQuery,/japanese restaurant/);
    assert.ok(body.locationBias.circle.center.latitude,"смещение к точке города");
  }finally{globalThis.fetch=real}
});

test("Google Places: имя фото проверяется, без ключа слот выключен", async () => {
  assert.equal(googlePhotoUrl("places/abc/photos/def"),"https://places.googleapis.com/v1/places/abc/photos/def/media?maxWidthPx=800");
  assert.equal(googlePhotoUrl("places/abc/photos/../x"),null);
  assert.equal(googlePhotoUrl("https://evil.example/"),null);
  assert.equal(normalizeGoogleItem({id:"1",photos:[{name:"nope"}]},{}).aggregator_image,null);
  assert.equal((await searchGooglePlaces({placeQueries:["bar"]},"")).disabled,true);
});

test("Foursquare и Google дополняют карточку с карты рейтингом, фото и часами", async () => {
  assert.ok(ENRICH_PROVIDERS.has("Foursquare")&&ENRICH_PROVIDERS.has("Google"));
  const osmBar={id:"osm:node:1",provider:"OpenStreetMap",live:true,kind:"venue",name:"Barasti Beach",cat:"Бар",tags:["bar"],cat_tags:["bar"],primary_tags:["bar"],
    area:"Al Sufouh Rd",metro:"",date_start:null,date_end:null,times:[],hours_label:null,price_label:null,price_min:null,free:false,
    availability:null,rating:null,rating_count:0,closed:false,aggregator_image:null,aggregator_name:null,source:"https://osm.org/node/1",point_source:"https://osm.org/node/1",
    official_source:null,image_url:null,booking_url:null,booking_kind:null,booking_provider:null,phone:null,desc:"",keywords:"barasti beach bar",coords:{lat:25.0929,lon:55.1497}};
  const fsq={...normalizeFoursquareItem(FSQ_PLACE,{}),area:"Al Sufouh Rd"};
  const providers={kudago:async()=>({items:[],errors:[]}),timepad:async()=>({items:[],errors:[]}),
    osm:async()=>({items:[osmBar],errors:[]}),dgis:async()=>({items:[],errors:[]}),yandex:async()=>({items:[],errors:[]}),
    foursquare:async()=>({items:[fsq],errors:[]})};
  const out=await searchLiveInventory({query:"бар"},{NODE_ENV:"test",FOURSQUARE_API_KEY:"k"},{providers,cache:{get:()=>null,set(){}},now:()=>1});
  const hits=out.items.filter(i=>/Barasti/.test(i.name));
  assert.equal(hits.length,1,"одно место, а не два");
  const x=hits[0];
  assert.equal(x.rating,4.3);assert.equal(x.rating_count,1240);
  assert.equal(x.aggregator_image,"https://fastly.4sqi.net/img/general/original/abc.jpg");
  assert.match(x.hours_label,/Mon-Thu/);assert.equal(x.phone,"+971 4 318 1313");assert.equal(x.price_label,"$$");
  assert.match(x.provider,/OpenStreetMap\+Foursquare/);
  assert.equal(out.providers.foursquare,true);
  assert.equal(out.degraded.foursquare,false);
});

test("слот Foursquare появляется в сводках только там, где он включён", async () => {
  const providers={kudago:async()=>({items:[],errors:[]}),timepad:async()=>({items:[],errors:[]}),osm:async()=>({items:[],errors:[]})};
  const out=await searchLiveInventory({query:"бар"},{NODE_ENV:"test",FOURSQUARE_API_KEY:"k",GOOGLE_PLACES_API_KEY:"g"},{providers,cache:{get:()=>null,set(){}},now:()=>1});
  const on=CITY.providers.places.includes("foursquare");
  assert.equal("foursquare" in out.degraded,on,"в Москве слота нет, в Дубае — есть");
  assert.equal("google" in out.providers,CITY.providers.places.includes("google"));
  if(!on)assert.deepEqual(Object.keys(out.degraded),["kudago","timepad","osm","dgis","yandex"],"московский ответ не меняется");
});

test("план поиска по-английски не ломает запросы к источникам", () => {
  const plan=buildSearchPlan({query:"rooftop bar near me"});
  assert.ok(Array.isArray(plan.placeQueries));
  assert.equal(typeof plan.near,"boolean");
});
