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
    providers:{places:["osm","foursquare","google"],events:[]},
    taxi:["uber","careem"],
    agent:{name:"Noor",voice:"john",lang:"en-US"},
    snapshotFile:"osm_dubai.db",
    weatherTz:"Asia/Dubai"
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
