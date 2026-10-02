// Конфигурация города. Один код — много городов: всё, что раньше было зашито
// как «Москва» (рамка, часовой пояс, валюта, язык, источники, такси), берётся
// отсюда. Город выбирается переменной CITY (moscow | dubai), по умолчанию moscow,
// чтобы тесты и текущий сервер не изменили поведение.
//
// Поля:
//   id, name (как город называется в интерфейсе), lang (ru|en), locale,
//   tz (IANA), utcOffset ("+03:00"), currency, currencySymbol,
//   center {lat,lon}, bbox {south,west,north,east} — весь город,
//   centerBbox — центр города (для «в центре»),
//   yandexBbox — формат Яндекс Геопоиска «lon,lat~lon,lat» (только где он есть),
//   providers.places / providers.events — какие источники включать,
//   taxi — какие кнопки такси показывать (yandexgo | uber | careem),
//   agent — имя и характер персоны, snapshotFile — имя файла OSM-снимка.
export const CITIES={
  moscow:{
    id:"moscow",name:"Москва",nameEn:"Moscow",country:"RU",lang:"ru",locale:"ru-RU",
    tz:"Europe/Moscow",utcOffset:"+03:00",currency:"RUB",currencySymbol:"₽",
    center:{lat:55.7558,lon:37.6173},
    bbox:{south:55.49,west:37.30,north:55.96,east:37.99},
    // Те же значения, что были зашиты в providers.mjs и osm_snapshot.mjs.
    centerBbox:{south:55.71,west:37.55,north:55.80,east:37.69},
    yandexBbox:"37.32,55.55~37.97,55.95",
    providers:{places:["osm","yandex","dgis"],events:["kudago","timepad"]},
    taxi:["yandexgo"],
    agent:{name:"Варя",voice:"masha",lang:"ru-RU"},
    snapshotFile:"osm_moscow.db",
    weatherTz:"Europe/Moscow"
  },
  dubai:{
    id:"dubai",name:"Dubai",nameEn:"Dubai",country:"AE",lang:"en",locale:"en-AE",
    tz:"Asia/Dubai",utcOffset:"+04:00",currency:"AED",currencySymbol:"AED",
    center:{lat:25.2048,lon:55.2708},
    // От Джебель-Али до Дейры и Дубай-Крик; аэропорт и Марина внутри.
    bbox:{south:24.79,west:54.89,north:25.36,east:55.56},
    // Downtown, DIFC, Business Bay, Jumeirah 1 — «центр» для запросов «in the center».
    centerBbox:{south:25.17,west:55.24,north:25.24,east:55.31},
    yandexBbox:null,
    // События — локальная афиша (events_dubai.mjs): Visit Dubai, District,
    // Dubai Opera; файл собирает scripts/dubai_events/harvest.mjs по таймеру.
    providers:{places:["osm","foursquare","google"],events:["dubai_events"]},
    taxi:["uber","careem"],
    agent:{name:"Noor",voice:"john",lang:"en-US"},
    snapshotFile:"osm_dubai.db",
    weatherTz:"Asia/Dubai",
    // Районы: «hotel in Marina», «bar in JBR» — поиск переносится в район,
    // а не ведётся вокруг человека или по всему городу.
    districts:[
      {name:"Dubai Marina",re:/\b(dubai )?marina\b/,lat:25.0805,lon:55.1403},
      {name:"JBR",re:/\bjbr\b|jumeirah beach residence|the walk/,lat:25.0784,lon:55.1338},
      {name:"Downtown Dubai",re:/\bdowntown\b|burj khalifa area|dubai mall area|boulevard/,lat:25.1972,lon:55.2744},
      {name:"DIFC",re:/\bdifc\b/,lat:25.2121,lon:55.2805},
      {name:"Business Bay",re:/business bay/,lat:25.1857,lon:55.2725},
      {name:"Palm Jumeirah",re:/\b(the )?palm(?: jumeirah)?\b/,lat:25.1124,lon:55.1390},
      {name:"Jumeirah",re:/\bjumeirah\b(?! (lake|beach residence|village))/,lat:25.2093,lon:55.2462},
      {name:"JLT",re:/\bjlt\b|jumeirah lake/,lat:25.0693,lon:55.1428},
      {name:"Al Barsha",re:/\bbarsha\b|mall of the emirates/,lat:25.1124,lon:55.1960},
      {name:"Deira",re:/\bdeira\b|gold souk|spice souk/,lat:25.2711,lon:55.3075},
      {name:"Bur Dubai",re:/bur dubai|al fahidi|bastakiya|meena bazaar|old dubai|historic dubai|old town dubai|dubai old town/,lat:25.2532,lon:55.2970},
      {name:"Alserkal Avenue",re:/alserkal/,lat:25.1426,lon:55.2259},
      {name:"Al Quoz",re:/al quoz/,lat:25.1381,lon:55.2316},
      {name:"City Walk",re:/city walk/,lat:25.2063,lon:55.2617},
      {name:"La Mer",re:/la mer\b/,lat:25.2290,lon:55.2560},
      {name:"Dubai Hills",re:/dubai hills/,lat:25.1029,lon:55.2465},
      {name:"Al Seef",re:/al seef/,lat:25.2593,lon:55.3027},
      {name:"Festival City",re:/festival city/,lat:25.2228,lon:55.3527},
      {name:"Dubai Creek Harbour",re:/creek harbou?r/,lat:25.2040,lon:55.3470},
      {name:"Al Karama",re:/\bkarama\b/,lat:25.2463,lon:55.3047},
      {name:"Al Satwa",re:/\bsatwa\b/,lat:25.2229,lon:55.2719},
      {name:"Al Rigga",re:/\brigg?a\b/,lat:25.2650,lon:55.3205},
      {name:"Oud Metha",re:/oud metha/,lat:25.2365,lon:55.3130},
      {name:"Mirdif",re:/\bmirdiff?\b/,lat:25.2210,lon:55.4200},
      {name:"Dubai Silicon Oasis",re:/silicon oasis|\bdso\b/,lat:25.1210,lon:55.3800},
      {name:"Motor City",re:/motor city/,lat:25.0467,lon:55.2370},
      {name:"Dubai Sports City",re:/sports city/,lat:25.0389,lon:55.2190},
      {name:"International City",re:/international city/,lat:25.1650,lon:55.4090},
      {name:"Discovery Gardens",re:/discovery gardens?/,lat:25.0400,lon:55.1430},
      {name:"Al Nahda",re:/\bnahda\b/,lat:25.2900,lon:55.3700},
      {name:"Al Qusais",re:/\bqusais\b/,lat:25.2770,lon:55.3800},
      {name:"Jebel Ali",re:/jebel ali|jabal ali/,lat:25.0040,lon:55.0850},
      {name:"Umm Suqeim",re:/umm suqeim/,lat:25.1500,lon:55.2050},
      {name:"Al Sufouh",re:/\bsufouh\b/,lat:25.1130,lon:55.1720},
      {name:"Dubai Media City",re:/media city/,lat:25.0960,lon:55.1550},
      {name:"Dubai Internet City",re:/internet city/,lat:25.0950,lon:55.1600},
      {name:"Barsha Heights",re:/barsha heights|\btecom\b/,lat:25.0970,lon:55.1760},
      {name:"Al Wasl",re:/\bal wasl\b/,lat:25.1950,lon:55.2500},
      {name:"Umm Hurair",re:/umm hurair|\bwafi\b/,lat:25.2290,lon:55.3180},
      {name:"Al Garhoud",re:/\bgarhoud\b/,lat:25.2450,lon:55.3510},
      {name:"Al Mamzar",re:/\bmamzar\b/,lat:25.2950,lon:55.3450},
      {name:"Bluewaters",re:/blue ?waters/,lat:25.0800,lon:55.1200},
      {name:"Dubai Harbour",re:/dubai harbou?r/,lat:25.0920,lon:55.1380},
      {name:"Meydan",re:/\bmeydan\b/,lat:25.1600,lon:55.3000},
      {name:"Arabian Ranches",re:/arabian ranches/,lat:25.0550,lon:55.2700},
      {name:"JVC",re:/\bjvc\b|jumeirah village circle/,lat:25.0600,lon:55.2100},
      {name:"JVT",re:/\bjvt\b|jumeirah village triangle/,lat:25.0480,lon:55.1860},
      {name:"Damac Hills",re:/damac hills/,lat:25.0250,lon:55.2500},
      {name:"Dubai Healthcare City",re:/healthcare city/,lat:25.2320,lon:55.3220},
      {name:"Dubai Design District",re:/design district|\bd3\b/,lat:25.1870,lon:55.2970},
      {name:"Al Jaddaf",re:/\bjaddaf\b/,lat:25.2160,lon:55.3330},
      {name:"Mushrif",re:/\bmushrif\b/,lat:25.2190,lon:55.4530},
      {name:"Al Mankhool",re:/\bmankhool\b/,lat:25.2500,lon:55.2930},
      {name:"Dubai Investments Park",re:/investments? park|\bdip\b/,lat:24.9900,lon:55.1700},
      {name:"Expo City",re:/expo city|\bexpo 2020\b/,lat:24.9600,lon:55.1500},
      {name:"Dubai Airport",re:/\bdxb\b|\bairport\b/,lat:25.2532,lon:55.3657}
    ]
  }
};
const key=String(process.env.CITY||"moscow").toLowerCase();
if(!CITIES[key])throw new Error(`Неизвестный CITY=${key}; доступны: ${Object.keys(CITIES).join(", ")}`);
export const CITY=CITIES[key];
export const LANG=CITY.lang;

// Дата «сегодня» по городу (YYYY-MM-DD) — событие, начинающееся в 00:30 по
// местному, относится к местным суткам, а не к UTC.
export function cityDate(now=new Date()){
  return new Intl.DateTimeFormat("en-CA",{timeZone:CITY.tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
}
// Местное время: {weekday:"mo".."su", minute: минут с полуночи, hhmm:"HH:MM"}.
export function cityNow(now=new Date()){
  const d=typeof now==="string"?new Date(now):now;
  if(!Number.isFinite(d.valueOf()))return null;
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:CITY.tz,weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d);
  const get=(t)=>parts.find(p=>p.type===t)?.value;
  const wd=String(get("weekday")||"").slice(0,2).toLowerCase();
  const h=Number(get("hour")),m=Number(get("minute"));
  if(!/^(mo|tu|we|th|fr|sa|su)$/.test(wd)||!Number.isFinite(h)||!Number.isFinite(m))return null;
  return {weekday:wd,minute:h*60+m,hhmm:`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`};
}
export function bboxString(b=CITY.bbox){return `${b.south},${b.west},${b.north},${b.east}`}
export function inBbox(lat,lon,b=CITY.bbox){return lat>=b.south&&lat<=b.north&&lon>=b.west&&lon<=b.east}

// Строка на языке города: L("открыто сейчас","open now"). Для пользовательских
// подписей, которые формирует сервер (причины, примечания, обложки, ошибки).
export function L(ru,en){return CITY.lang==="en"?en:ru}
