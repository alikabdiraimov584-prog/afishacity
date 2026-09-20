import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createCache,withBreaker,breakerStatus} from "./cache.mjs";

import {CATEGORIES,SERVICE_TAGS,categoryTags} from "./categories.mjs";
import {structuralTags,placeTitle} from "./osm_tags.mjs";
import {openSnapshot} from "./osm_snapshot.mjs";
import {statSync} from "node:fs";
export {structuralTags};

const MOSCOW_POINT = "37.6173,55.7558";
const TIMEOUT_MS = 6500;

// String() на значении из сети может бросить исключение: объект вида
// {"toString":1} — валидный JSON, и приведение его к строке падает с
// «Cannot convert object to primitive value». Одного такого поля хватало,
// чтобы запрос завершился пятисоткой с внутренним текстом ошибки наружу.
function text(v){
  if(typeof v==="string")return v;
  if(v===null||v===undefined)return "";
  if(typeof v==="number"||typeof v==="boolean")return Number.isFinite(v)||typeof v==="boolean"?String(v):"";
  return "";                                   // массивы и объекты текстом не являются
}
function norm(s=""){return text(s).toLowerCase().replace(/ё/g,"е").replace(/<[^>]*>/g," ").replace(/[^a-zа-я0-9+\-\s]/gi," ").replace(/\s+/g," ").trim()}
function stripHtml(s=""){return String(s).replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," ").trim()}
function uniq(a){return [...new Set(a.filter(Boolean))]}
function clampText(s,n=440){s=stripHtml(s);return s.length>n?s.slice(0,n-1)+"…":s}
// Цену засчитываем только рядом с денежным признаком. Раньше бралась первая
// группа цифр, и «18+» становилось ценой 18 ₽, «с 12:00 до 23:00» — 12 ₽,
// а «2026 год» — 2026 ₽; эти числа потом проходили фильтр бюджета.
const MONEY_UNIT="(?:₽|руб[а-я]*(?![а-я])|р(?![а-я])|rub)";
const MONEY_RANGE=new RegExp(`(\\d[\\d\\s]{0,7}\\d|\\d)\\s*[-–—]\\s*(?:\\d[\\d\\s]{0,7}\\d|\\d)\\s*${MONEY_UNIT}`);
const MONEY_PLAIN=new RegExp(`(\\d[\\d\\s]{0,7}\\d|\\d)\\s*${MONEY_UNIT}`);
const MONEY_CTX=/(?:от|до|цена|стоимость|билет[а-я]*)\s*(\d[\d\s]{0,7}\d|\d)(?![\d:+])/;
export function parseMoney(s=""){
  const t=text(s).toLowerCase().replace(/\u00a0/g," ");
  // Возраст, время и год — не цена.
  const cleaned=t.replace(/\d+\s*\+/g," ").replace(/\d{1,2}[:.]\d{2}/g," ").replace(/(?<!\d)(19|20)\d{2}(?![\d])/g," ");
  const m=MONEY_RANGE.exec(cleaned)||MONEY_PLAIN.exec(cleaned)||MONEY_CTX.exec(cleaned);
  if(!m)return null;
  const n=Number(text(m[1]).replace(/\s/g,""));
  return Number.isFinite(n)&&n>=0&&n<=1000000?n:null;
}
// Дата берётся по Москве, а не по UTC: событие, начинающееся в 00:30 МСК,
// иначе получало вчерашнюю дату и не находилось по фильтру «сегодня».
const MSK_DATE=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"});
// new Date(x) на объекте тоже приводит его к примитиву и падает на ядовитом
// toString, поэтому датой считаем только строку или число.
function dateish(x){return typeof x==="string"||typeof x==="number"?new Date(x):new Date(NaN)}
export function isoDate(x){if(!x)return null;const d=dateish(x);return Number.isFinite(d.valueOf())?MSK_DATE.format(d):null}
function hhmm(x){if(!x)return null;const d=dateish(x);if(!Number.isFinite(d.valueOf()))return null;return new Intl.DateTimeFormat("ru-RU",{timeZone:"Europe/Moscow",hour:"2-digit",minute:"2-digit",hour12:false}).format(d)}
function moscowDate(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function addDays(dateStr,n){const d=new Date(dateStr+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function dateBounds(targetDate){const start=targetDate||moscowDate();const end=targetDate||addDays(start,30);return {start,end}}
function toEpoch(date,time="00:00:00"){return Math.floor(Date.parse(`${date}T${time}+03:00`)/1000)}

// В JS \b работает только для латиницы, поэтому границы кириллических слов
// задаём через lookbehind/lookahead. Все регэкспы применяются к norm()-тексту:
// нижний регистр, ё→е, пунктуация заменена пробелами.
const BAR_RE=/(?<![а-я])(бар(?!бер|аба|бек|он|ин|сук|рикад)|паб(?!лик)|пив[ао]|вин[оа](?![а-я])|винн|винотек)|(?<![a-z])pub(?!li)|выпить|коктейл|алкогол|дринк/;
const FOOD_RE=/ресторан|поесть|ужин|(?<![а-я])ед[аыеу](?![а-я])|кухн|кафе|завтрак|бранч/;
const FAMILY_RE=/ребен|(?<![а-я])дет(и|ей|ям|ьми|ск|ишк)|(?<![а-я])семь[яиею]|семейн/;
const SPA_RE=/(?<![а-я])бан(я|и|ю|е|ей)(?![а-я])|саун|(?<![а-я])спа(?![а-я])/;
const ROCK_RE=/(?<![а-я])рок(?![а-я])|(?<![a-z])rock/;
const ART_RE=/выстав|искусств|галере|(?<![а-я])арт(?![а-я])/;
const STOP=new Set(["куда","сходить","пойти","хочу","хочется","сегодня","завтра","вечером","после","москва","москве","москву","очень","сильно","много","какой","какое","какие","что","чтобы","можно","найди","найти","место","места","нибудь","что-нибудь","есть","нужно","надо","давай","давайте","посоветуй","подскажи","рядом","около","недалеко","меня","нас","мне","мы","нам","компанией","человек"]);

// Пустая выдача при наличии ошибок — это отказ источника, а не «ничего не нашлось».
// Предохранитель считает только брошенные исключения, поэтому такой случай надо
// бросать: иначе провайдер молча отдаёт ноль карточек и никогда не отключается.
function providerResult(items,errors,extra={}){
  if(!items.length&&errors.length)throw new Error(errors[0]);
  return {items,errors,...extra};
}

async function fetchJson(url,opts={}){
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),opts.timeoutMs||TIMEOUT_MS);
  try{
    const r=await fetch(url,{...opts,signal:ctrl.signal,headers:{"User-Agent":"FREE-Moscow/0.9 (+local prototype)",...(opts.headers||{})}});
    if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  }finally{clearTimeout(t)}
}

// Правила подбора запросов к провайдерам собираются из общего справочника категорий.
const PLACE_RULES = CATEGORIES.map(c=>({re:c.re,queries:c.queries,tags:[c.tag,...(c.extraTags||[])]}));
const EVENT_RULES = [
  {re:/стендап|stand\s?up|комед|юмор/, queries:["стендап"], tags:["comedy"]},
  {re:/джаз|jazz/, queries:["джаз"], tags:["jazz","music"]},
  {re:ROCK_RE, queries:["рок"], tags:["rock","music"]},
  {re:/концерт|музык|группа|исполнител|песн/, queries:["концерт"], tags:["music"]},
  {re:/театр|спектак|опера|балет/, queries:["спектакль"], tags:["theatre"]},
  {re:ART_RE, queries:["выставка"], tags:["art","culture"]},
  {re:/лекц|паблик|форум|конференц/, queries:["лекция"], tags:["lecture"]},
  {re:/мастер.?класс|воркшоп/, queries:["мастер-класс"], tags:["workshop"]},
  {re:/фестивал|маркет|ярмарк/, queries:["фестиваль"], tags:["festival"]},
  {re:/космос|планетар|астроном/, queries:["космос"], tags:["space","science"]}
];

export function buildSearchPlan(args={}){
  const q=norm(args.query||"");const placeQueries=[],eventQueries=[],tags=[];
  for(const r of PLACE_RULES)if(r.re.test(q)){placeQueries.push(...r.queries);tags.push(...r.tags)}
  for(const r of EVENT_RULES)if(r.re.test(q)){eventQueries.push(...r.queries);tags.push(...r.tags)}
  const safeQuery=q.replace(/(^|\s)(сильно|очень|много|побольше|до упаду|в хлам)(?=\s|$)/g," ").replace(/\s+/g," ").trim();
  // Ядро запроса без стоп-слов: то, что реально стоит искать в провайдерах.
  const coreQuery=safeQuery.split(" ").filter(w=>w.length>3&&!/[0-9]/.test(w)&&!STOP.has(w)&&!/^бесплат/.test(w)).slice(0,5).join(" ");
  if(!placeQueries.length&&!eventQueries.length&&coreQuery){eventQueries.push(coreQuery);placeQueries.push(coreQuery)}
  const placeIntent=placeQueries.length>0;
  const eventIntent=eventQueries.length>0;
  // Аптеку или автосервис в афише событий искать бессмысленно: такие источники
  // возвращают парки и площадки, которые только засоряют выдачу.
  const serviceOnly=!eventIntent&&tags.some(t=>SERVICE_TAGS.has(t));
  return {
    raw:args.query||"",safeQuery,coreQuery,
    placeQueries:uniq(placeQueries).slice(0,4),eventQueries:uniq(eventQueries).slice(0,4),tags:uniq(tags),
    placeIntent,eventIntent,serviceOnly,
    targetDate:args.target_date||null,maxPrice:args.max_price_rub??null,freeOnly:args.max_price_rub===0||/бесплат/.test(q),
    afterTime:args.after_time||null,area:args.area||null,
    heavyDrinkingPhrase:/выпить.*(много|сильно)|напиться|в хлам/.test(q)
  };
}

// Структурные теги OSM живут в osm_tags.mjs: ими пользуется и снимок города.
// Рубрики источника (KudaGo, Timepad, 2GIS) — тоже структурные данные.
function rubricTags(names){return uniq(categoryTags(norm((names||[]).filter(Boolean).join(" "))))}

function inferTags(text){
  const n=norm(text);
  const t=categoryTags(n);
  // Признаки, специфичные для событий, а не для заведений.
  const events=[
    ["comedy",/стендап|standup|комед|юмор/],["jazz",/джаз|jazz/],["rock",/(?<![а-я])рок(?![а-я])|(?<![a-z])rock/],
    ["music",/музык|концерт|джаз|группа|(?<![а-я])рок(?![а-я])/],["art",/выстав|искусств|галере|(?<![а-я])арт(?![а-я])/],
    ["culture",/музей|искусств|театр|выстав/],["theatre",/театр|спектак|балет|опера/],["science",/наук|планетар|космос|лекц/],
    ["space",/космос|планетар|астроном/],["lecture",/лекц|форум|паблик/],["workshop",/мастер.?класс|воркшоп/],
    ["festival",/фестивал|маркет|ярмарк/],["nightlife",/(?<![а-я])(бар(?!бер|аба|бек|он|ин|сук|рикад)|паб(?!лик))|клуб|караоке|ночн/]
  ];
  for(const [tag,re] of events)if(re.test(n))t.push(tag);
  return uniq(t);
}


function priceInfo(label,isFree=false){
  if(isFree)return {price_label:"Бесплатно",price_min:0,free:true};
  const p=parseMoney(label);
  return {price_label:label&&text(label).trim()?stripHtml(label):"цена на сайте",price_min:p,free:false};
}

async function kudagoEventDetail(id){
  const fields="id,title,short_title,dates,place,price,is_free,site_url,description,categories,tags,images";
  return fetchJson(`https://kudago.com/public-api/v1.4/events/${id}/?lang=ru&fields=${encodeURIComponent(fields)}&expand=place,dates,images`);
}
async function kudagoPlaceDetail(id){
  const fields="id,title,address,timetable,phone,description,site_url,foreign_url,coords,subway,is_closed,categories,tags,images";
  return fetchJson(`https://kudago.com/public-api/v1.4/places/${id}/?lang=ru&fields=${encodeURIComponent(fields)}&expand=images`);
}

function normalizeKudagoEvent(e,plan){
  const dates=Array.isArray(e.dates)?e.dates:[];
  const b=dateBounds(plan.targetDate);const minEpoch=toEpoch(b.start);const maxEpoch=toEpoch(b.end,"23:59:59");
  const relevant=dates.filter(d=>!d.start||(+d.start>=minEpoch-86400&&+d.start<=maxEpoch+86400));
  // Если в окне поиска дат нет — берём ближайшую будущую, а не первую (возможно, давно прошедшую).
  const d=relevant[0]||dates.find(x=>+x.start>=minEpoch-86400)||dates[dates.length-1]||{};
  const epochDate=v=>v?isoDate(+v*1000):null;
  const place=e.place||{};
  const pi=priceInfo(e.price,e.is_free===true);
  const text=[e.title,e.description,(e.categories||[]).map(x=>x.name).join(" "),(e.tags||[]).join(" ")].join(" ");
  return {
    id:`kudago:event:${e.id}`,provider:"KudaGo",live:true,kind:"event",name:e.title||e.short_title||"Событие",
    organizer:place.title||"KudaGo",cat:(e.categories||[])[0]?.name||"Событие",
    tags:inferTags(text),cat_tags:rubricTags((e.categories||[]).map(x=>x.name)),
    area:place.address||"Москва",metro:place.subway||"",date_start:d.start_date||epochDate(d.start),date_end:d.end_date||d.start_date||epochDate(d.end||d.start),
    times:uniq(relevant.map(x=>x.start_time?x.start_time.slice(0,5):null).filter(Boolean)).slice(0,8),hours_label:"",
    ...pi,availability:"актуальность из KudaGo",source:e.site_url||place.site_url||"https://kudago.com/msk/",
    point_source:e.site_url||place.site_url||"https://kudago.com/msk/",official_source:null,
    // Кадр агрегатора — нижняя ступень каскада, а не опознавательный знак карточки.
    aggregator_image:e.images?.[0]?.image||null,aggregator_name:"KudaGo",image_source:e.images?.[0]?.source?.link||null,
    booking_url:e.site_url||null,booking_kind:"tickets",booking_provider:"KudaGo",phone:null,
    desc:clampText(e.description||""),keywords:norm(text),coords:place.coords||null
  };
}
function normalizeKudagoPlace(p,plan){
  const text=[p.title,p.description,(p.categories||[]).map(x=>x.name).join(" "),(p.tags||[]).join(" ")].join(" ");
  return {
    id:`kudago:place:${p.id}`,provider:"KudaGo",live:true,kind:"venue",name:p.title||"Место",organizer:p.title||"",
    cat:(p.categories||[])[0]?.name||"Место",
    tags:inferTags(text),cat_tags:rubricTags((p.categories||[]).map(x=>x.name)),area:p.address||"Москва",metro:p.subway||"",
    date_start:null,date_end:null,times:[],hours_label:p.timetable||"часы работы на сайте",price_label:"цены на сайте",price_min:null,free:false,
    availability:p.is_closed?"закрыто":"действующее место",source:p.site_url||p.foreign_url||"https://kudago.com/msk/",
    point_source:p.site_url||p.foreign_url||"https://kudago.com/msk/",official_source:p.foreign_url||null,
    aggregator_image:p.images?.[0]?.image||null,aggregator_name:"KudaGo",image_source:p.images?.[0]?.source?.link||null,
    booking_url:p.foreign_url||p.site_url||null,booking_kind:"site",booking_provider:p.title||"официальный сайт",phone:p.phone||null,desc:clampText(p.description||""),keywords:norm(text),coords:p.coords||null
  };
}

export async function searchKudago(plan){
  const out=[],errors=[];
  try{
    const ids=[];
    for(const q of plan.eventQueries.slice(0,3)){
      const u=new URL("https://kudago.com/public-api/v1.4/search/");u.searchParams.set("q",q);u.searchParams.set("location","msk");u.searchParams.set("ctype","event");u.searchParams.set("page_size","20");u.searchParams.set("expand","place,dates");if(plan.freeOnly)u.searchParams.set("is_free","true");
      try{const d=await fetchJson(u);for(const x of (d.results||[]))ids.push(x.id)}catch(e){errors.push(`KudaGo events: ${e.message}`)}
    }
    const unique=uniq(ids).slice(0,18);
    const details=await Promise.all(unique.map(id=>kudagoEventDetail(id).catch(e=>({__error:e.message}))));
    // Отказ каждой детали раньше проглатывался: провайдер отдавал ноль карточек
    // без единой ошибки, поэтому предохранитель не срабатывал и деградация
    // источника выглядела как «ничего не нашлось».
    const failed=details.filter(x=>x&&x.__error);
    if(unique.length&&failed.length===unique.length)throw new Error(`детали недоступны (${failed[0].__error})`);
    if(failed.length)errors.push(`KudaGo events: ${failed.length} из ${unique.length} не загрузились`);
    for(const e of details)if(e&&!e.__error){const x=normalizeKudagoEvent(e,plan);if(x.date_start||x.times.length)out.push(x)}
  }catch(e){errors.push(`KudaGo events: ${e.message}`)}
  try{
    const ids=[];
    for(const q of plan.placeQueries.slice(0,3)){
      const u=new URL("https://kudago.com/public-api/v1.4/search/");u.searchParams.set("q",q);u.searchParams.set("location","msk");u.searchParams.set("ctype","place");u.searchParams.set("page_size","25");
      try{const d=await fetchJson(u);for(const x of (d.results||[]))if(!x.is_closed)ids.push(x.id)}catch(e){errors.push(`KudaGo places: ${e.message}`)}
    }
    const wanted=uniq(ids).slice(0,22);
    const details=await Promise.all(wanted.map(id=>kudagoPlaceDetail(id).catch(e=>({__error:e.message}))));
    const failed=details.filter(x=>x&&x.__error);
    if(wanted.length&&failed.length===wanted.length)throw new Error(`детали недоступны (${failed[0].__error})`);
    if(failed.length)errors.push(`KudaGo places: ${failed.length} из ${wanted.length} не загрузились`);
    for(const p of details)if(p&&!p.__error&&!p.is_closed)out.push(normalizeKudagoPlace(p,plan));
  }catch(e){errors.push(`KudaGo places: ${e.message}`)}
  return providerResult(out,errors);
}

function timepadBounds(plan){
  const b=dateBounds(plan.targetDate);return {start:`${b.start}T00:00:00+03:00`,end:`${b.end}T23:59:59+03:00`};
}
function normalizeTimepadEvent(e,plan){
  const reg=e.registration_data||{};
  const pmin=Number.isFinite(reg.price_min)?reg.price_min:null;
  const free=pmin===0 || (Array.isArray(e.ticket_types)&&e.ticket_types.some(t=>+t.price===0));
  const priceLabel=free?"Бесплатно":pmin!==null?`от ${Math.round(pmin).toLocaleString("ru-RU")} ₽`:"цена / регистрация на Timepad";
  const cats=(e.categories||[]).map(x=>x.name||"");const text=[e.name,e.description_short,cats.join(" "),e.organization?.name].join(" ");
  return {
    id:`timepad:event:${e.id}`,provider:"Timepad",live:true,kind:"event",name:e.name||"Событие",organizer:e.organization?.name||"Timepad",
    cat:cats[0]||"Событие",tags:inferTags(text),cat_tags:rubricTags(cats),area:e.location?.address||e.location?.city||"Москва",metro:"",
    date_start:isoDate(e.starts_at),date_end:isoDate(e.ends_at)||isoDate(e.starts_at),times:uniq([hhmm(e.starts_at)]),hours_label:"",
    price_label:priceLabel,price_min:pmin,free,availability:reg.is_registration_open===false?"регистрация закрыта":"регистрация на Timepad",
    source:e.url||e.organization?.url||"https://timepad.ru/",point_source:e.url||e.organization?.url||"https://timepad.ru/",
    official_source:e.organization?.url||null,
    aggregator_name:"Timepad",aggregator_image:e.poster_image?.uploadcare_url?`${text(e.poster_image.uploadcare_url).startsWith("//")?"https:":""}${e.poster_image.uploadcare_url}-/preview/900x600/`:e.poster_image?.default_url||null,
    booking_url:e.url||null,booking_kind:"tickets",booking_provider:"Timepad",phone:null,desc:clampText(e.description_short||e.description_html||""),keywords:norm(text),coords:e.location?.coordinates||null
  };
}

export async function searchTimepad(plan){
  const out=[],errors=[];const b=timepadBounds(plan);
  // Без распознанного намерения ищем по ядру запроса; пустое ядро = все ближайшие события Москвы.
  const qs=plan.eventQueries.length?plan.eventQueries.slice(0,3):[plan.coreQuery||""];
  for(const q of qs){
    try{
      const u=new URL("https://api.timepad.ru/v1/events.json");u.searchParams.set("limit","50");u.searchParams.set("skip","0");u.searchParams.set("cities","Москва");u.searchParams.set("sort","+starts_at");u.searchParams.set("starts_at_min",b.start);u.searchParams.set("starts_at_max",b.end);u.searchParams.set("fields","location,organization,categories,registration_data,description_short,ticket_types,poster_image");
      const kw=norm(q).split(" ").filter(w=>w.length>3).slice(0,2);if(kw.length)u.searchParams.set("keywords",kw.join(","));
      if(plan.freeOnly)u.searchParams.set("price_max","0");
      else if(plan.maxPrice!==null&&plan.maxPrice!==undefined)u.searchParams.set("price_max",String(plan.maxPrice));
      const d=await fetchJson(u);
      for(const e of (d.values||[]))out.push(normalizeTimepadEvent(e,plan));
    }catch(e){errors.push(`Timepad: ${e.message}`)}
  }
  return providerResult(out,errors);
}


function contactList2gis(x){
  const out=[];
  for(const g of (x.contact_groups||[]))for(const c of (g.contacts||[]))out.push(c);
  return out;
}
function bookingFromContacts(contacts=[]){
  const normUrl=v=>{if(!v)return null;v=text(v).trim();if(/^https?:\/\//i.test(v)||/^tel:/i.test(v))return v;return null};
  for(const c of contacts){
    const t=text(c.type).toLowerCase(),u=normUrl(c.url);
    if((/telegram|whatsapp|messenger/.test(t)||/t\.me|wa\.me|whatsapp/i.test(u||""))&&u)
      return {url:u,kind:/whatsapp|wa\.me/i.test(u)?"whatsapp":"telegram",provider:c.print_text||c.text||"мессенджер"};
  }
  for(const c of contacts){
    const t=text(c.type).toLowerCase(),u=normUrl(c.url),v=text(c.value);
    if(t==="phone"||/phone/.test(t)){const ph=v.replace(/[^\d+]/g,"");if(ph)return {url:`tel:${ph}`,kind:"phone",provider:"телефон"}}
    if((t==="website"||t==="url")&&u)return {url:u,kind:"site",provider:"сайт"};
  }
  return {url:null,kind:null,provider:null};
}

function normalize2gisItem(x,plan){
  const contacts=contactList2gis(x),book=bookingFromContacts(contacts);
  const rubrics=(x.rubrics||[]).map(r=>r.name||"");const text=[x.name,x.address_name,rubrics.join(" ")].join(" ");
  let schedule="часы работы в 2GIS";
  if(x.schedule?.comment)schedule=x.schedule.comment;
  return {
    id:`2gis:place:${x.id}`,provider:"2GIS",live:true,kind:"venue",name:x.name||"Заведение",organizer:x.name||"",
    cat:rubrics[0]||"Заведение",tags:inferTags(text),cat_tags:rubricTags(rubrics),area:x.address_name||x.full_address_name||"Москва",metro:"",
    date_start:null,date_end:null,times:[],hours_label:schedule,price_label:"цены в карточке заведения",price_min:null,free:false,
    availability:"действующая организация по данным 2GIS",source:`https://2gis.ru/moscow/firm/${encodeURIComponent(x.id)}`,
    point_source:`https://2gis.ru/moscow/firm/${encodeURIComponent(x.id)}`,official_source:null,
    image_url:null,booking_url:book.url,booking_kind:book.kind,booking_provider:book.provider,
    phone:contacts.find(c=>text(c.type).toLowerCase()==="phone")?.value||null,
    desc:rubrics.length?rubrics.join(" · "):"Карточка действующей организации из 2GIS",keywords:norm(text),coords:x.point||null
  };
}
export async function search2GIS(plan,key){
  if(!key)return {items:[],errors:[],disabled:true};
  const out=[],errors=[];
  for(const q of plan.placeQueries.slice(0,4)){
    try{
      const u=new URL("https://catalog.api.2gis.com/3.0/items");u.searchParams.set("key",key);u.searchParams.set("q",q);u.searchParams.set("type","branch");u.searchParams.set("point",MOSCOW_POINT);u.searchParams.set("radius",wantsCenter(plan.area)?"6000":"50000");u.searchParams.set("page_size","50");u.searchParams.set("locale","ru_RU");u.searchParams.set("fields","items.point,items.rubrics,items.schedule,items.full_address_name,items.contact_groups");
      const d=await fetchJson(u);for(const x of (d.result?.items||[]))out.push(normalize2gisItem(x,plan));
    }catch(e){errors.push(`2GIS: ${e.message}`)}
  }
  return {items:out,errors,disabled:false};
}


const MOSCOW_BBOX = "55.49,37.30,55.96,37.99";
const OVERPASS_TIMEOUT_S=12;
// Версия формата карточки. Поднимайте её, когда меняется то, что кладут
// normalize*-функции: это разом обесценивает файловый кеш.
const ITEM_SCHEMA=2;
// Центр — примерно кольцо радиусом 5 км вокруг Кремля: Садовое и ближние районы.
const CENTER_BBOX = "55.71,37.55,55.80,37.69";
export function wantsCenter(area){return /центр/.test(text(area).toLowerCase())}
// Overpass — не один сервис, а несколько независимых зеркал одного API.
// С единственным URL мы просто меняли зависимость от агрегатора на зависимость
// от overpass-api.de: он регулярно перегружен и отвечает 429/504.
export const OVERPASS_MIRRORS=String(process.env.OVERPASS_URLS||
  "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter")
  .split(",").map(x=>x.trim()).filter(Boolean);
// Зеркало, ответившее последним успешно, пробуем первым: не гоняем по кругу зря.
let overpassPreferred=0;
export async function overpassQuery(query,{timeoutMs,fetchJsonImpl=fetchJson}={}){
  const order=OVERPASS_MIRRORS.map((_,i)=>OVERPASS_MIRRORS[(overpassPreferred+i)%OVERPASS_MIRRORS.length]);
  const body=new URLSearchParams({data:query}).toString();
  let last=null;
  for(const url of order){
    try{
      const d=await fetchJsonImpl(url,{method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body,timeoutMs});
      overpassPreferred=OVERPASS_MIRRORS.indexOf(url);
      return d;
    }catch(e){last=e}
  }
  throw last||new Error("нет доступных зеркал Overpass");
}

// Фильтры OpenStreetMap — из того же справочника.
const OSM_RULES = CATEGORIES.filter(c=>c.osm&&c.osm.length).map(c=>({re:c.re,filters:c.osm,tag:c.tag}));

function osmAddress(t={}){
  const parts=[
    t["addr:street"] && [t["addr:street"],t["addr:housenumber"]].filter(Boolean).join(", "),
    t["addr:place"], t["addr:suburb"]
  ].filter(Boolean);
  return parts.join(" · ") || "Москва";
}
function osmSource(x){return `https://www.openstreetmap.org/${x.type}/${x.id}`}
function messagingUrl(v,type){
  if(!v)return null;v=text(v).trim();
  if(/^https?:\/\//i.test(v))return v;
  if(type==="telegram")return `https://t.me/${v.replace(/^@/,"")}`;
  if(type==="whatsapp"){const ph=v.replace(/[^\d]/g,"");return ph?`https://wa.me/${ph}`:null}
  return null;
}
// Теги OSM правит кто угодно. Ссылка оттуда доезжает до href в интерфейсе,
// поэтому схему проверяем на входе, а не на выходе.
export function safeLink(raw){
  const v=text(raw).trim();
  if(!/^https?:\/\//i.test(v))return null;
  try{const u=new URL(v);return /^https?:$/.test(u.protocol)?u.href:null}catch{return null}
}
function normalizeOsmItem(x,plan){
  const t=x.tags||{};
  const phone=t["contact:phone"]||t.phone||null;
  const reservation=safeLink(t.reservation);
  const telegram=messagingUrl(t["contact:telegram"]||t.telegram,"telegram");
  const whatsapp=messagingUrl(t["contact:whatsapp"]||t.whatsapp,"whatsapp");
  const directBook=telegram||whatsapp||reservation||(phone?`tel:${text(phone).replace(/[^\d+]/g,"")}`:null);
  const name=t.name||t["name:ru"]||t.brand||"Заведение";
  const amenity=t.amenity||t.leisure||t.sport||"place";
  const text=[name,t.brand,t.cuisine,amenity,t.description,t["description:ru"],t["smoking"],t["opening_hours"]].filter(Boolean).join(" ");
  const site=safeLink(t.website)||safeLink(t["contact:website"])||osmSource(x);
  const cats={
    hookah_lounge:"Кальянная",bar:"Бар",pub:"Паб",biergarten:"Бар",nightclub:"Ночной клуб",
    restaurant:"Ресторан",cafe:"Кафе",sauna:"Сауна",spa:"Спа"
  };
  return {
    id:`osm:${x.type}:${x.id}`,provider:"OpenStreetMap",live:true,kind:"venue",name,organizer:t.brand||name,
    // Раньше всё, кроме десятка знакомых значений, называлось «Заведение».
    // Теперь название берётся из справочника по структурному тегу места.
    cat:cats[amenity]||(/караоке|karaoke/i.test(text)?"Караоке":placeTitle(t))||"Заведение",
    tags:inferTags(text),cat_tags:structuralTags(t),area:osmAddress(t),metro:"",
    // Эти теги приходят в том же ответе и раньше терялись: из них берётся
    // фотография места без обращения к агрегатору.
    wikidata:t.wikidata||null,brand_wikidata:t["brand:wikidata"]||null,
    wikimedia_commons:t.wikimedia_commons||null,image_raw:t.image||null,
    date_start:null,date_end:null,times:[],hours_label:t.opening_hours||"часы работы не указаны в OSM",
    price_label:"цены у заведения",price_min:null,free:false,
    availability:"объект из актуальной базы OpenStreetMap; часы лучше перепроверить",
    source:osmSource(x),point_source:osmSource(x),official_source:site!==osmSource(x)?site:null,
    image_url:null,
    booking_url:directBook||((site!==osmSource(x))?site:null),booking_kind:telegram?"telegram":whatsapp?"whatsapp":reservation?"site":phone?"phone":(site!==osmSource(x)?"site":null),
    booking_provider:telegram?"Telegram":whatsapp?"WhatsApp":phone?"телефон":(site!==osmSource(x)?"официальный сайт":null),phone,
    desc:clampText(t.description||t["description:ru"]||[t.cuisine,t["opening_hours"]].filter(Boolean).join(" · ")),
    keywords:norm(text),coords:{lat:x.lat||x.center?.lat||null,lon:x.lon||x.center?.lon||null}
  };
}
export function osmFilters(plan){
  const q=norm(plan.raw||plan.safeQuery||"");
  const filters=[];
  for(const r of OSM_RULES) if(r.re.test(q)) filters.push(...r.filters);
  // Категория не распознана, но место всё равно ищут: пробуем найти по названию (бренд, конкретное заведение).
  if(!filters.length&&plan.coreQuery&&plan.coreQuery.length>=4){
    const safe=plan.coreQuery.replace(/[^а-яa-z0-9 ]/gi,"").trim().split(" ").filter(w=>w.length>=4).slice(0,2).join("|");
    if(safe.length>=4)filters.push(`nwr["name"~"${safe}",i]["amenity"]({{bbox}});`,`nwr["name"~"${safe}",i]["shop"]({{bbox}});`);
  }
  return plan.placeIntent?uniq(filters):[];
}
// Локальный снимок города: если он есть, поиск мест идёт из него, а Overpass
// остаётся запасным путём. Файл подменяется целиком при пересборке, поэтому
// следим за временем изменения и переоткрываем — иначе сервер продолжал бы
// читать удалённый файл по старому дескриптору до перезапуска.
const SNAPSHOT_FILE=process.env.OSM_SNAPSHOT||join(fileURLToPath(new URL(".",import.meta.url)),"data","osm_moscow.db");
let snapCache={handle:null,mtime:0,checked:0};
export function getSnapshot({now=Date.now,file=SNAPSHOT_FILE}={}){
  const t=now();
  if(t-snapCache.checked<60_000)return snapCache.handle;
  snapCache.checked=t;
  let mtime=0;
  try{mtime=statSync(file).mtimeMs}catch{mtime=0}
  if(mtime===snapCache.mtime)return snapCache.handle;
  if(snapCache.handle)try{snapCache.handle.close()}catch{}
  snapCache={handle:mtime?openSnapshot(file):null,mtime,checked:t};
  return snapCache.handle;
}
export function snapshotStatus(){
  const h=getSnapshot();
  if(!h)return {ready:false};
  return {ready:true,places:h.places,built_at:new Date(h.builtAt).toISOString(),
    age_hours:Math.round(h.ageMs()/36e5),stale:h.stale()};
}

export async function searchOSM(plan,opts={}){
  // opts.snapshot === null отключает снимок (тесты живого пути).
  const snap=opts.snapshot!==undefined?opts.snapshot:getSnapshot();
  if(snap){
    try{
      const els=snap.search(plan,{center:wantsCenter(plan.area),limit:80});
      const items=els.map(x=>normalizeOsmItem(x,plan)).filter(x=>x.name!=="Заведение");
      // Снимок ответил — в сеть не идём вовсе. Пусто в снимке ещё не значит
      // «пусто в городе», поэтому на этот случай ниже остаётся Overpass.
      if(items.length)return {items,errors:[],disabled:false,from_snapshot:true};
    }catch(e){/* повреждённый снимок не должен мешать живому поиску */}
  }
  const filters=osmFilters(plan);
  if(!filters.length) return {items:[],errors:[],disabled:false};
  // Просят центр — сужаем область поиска, иначе Overpass отдаёт всю Москву.
  const bbox=wantsCenter(plan.area)?CENTER_BBOX:MOSCOW_BBOX;
  // Overpass просили считать до 18 с, а клиент обрывал на 6.5 с: тяжёлые запросы
  // всегда падали по таймауту и накручивали предохранителю отказы. Сводим вместе.
  const query=`[out:json][timeout:${OVERPASS_TIMEOUT_S}];(${filters.map(s=>s.replaceAll("{{bbox}}",bbox)).join("")});out center tags 80;`;
  try{
    const d=await overpassQuery(query,{timeoutMs:(OVERPASS_TIMEOUT_S+2)*1000});
    const items=(d.elements||[]).map(x=>normalizeOsmItem(x,plan)).filter(x=>x.name!=="Заведение");
    return {items,errors:[],disabled:false};
  }catch(e){
    return providerResult([],[`OpenStreetMap/Overpass: ${e.message}`],{disabled:false});
  }
}

function dedupe(items){
  const seen=new Map();
  for(const x of items){
    const key=norm(`${x.name}|${x.date_start||"venue"}|${x.area||""}`).replace(/\s/g,"");
    if(!seen.has(key))seen.set(key,x);
    else{
      const a=seen.get(key);if(a.provider!=="2GIS"&&x.provider==="2GIS")seen.set(key,{...a,provider:`${a.provider}+2GIS`});
    }
  }
  return [...seen.values()];
}

// --- Надёжность поиска: кеш ответов провайдеров + предохранитель на каждый источник ---
const LIVE_TTL_MS=10*60_000;          // свежий ответ переиспользуется 10 минут
const LIVE_STALE_MS=6*60*60_000;      // при сбое источника отдаём сохранённый ответ до 6 часов
const BREAKER={failures:3,cooldownMs:5*60_000};
const CACHE_FILE=process.env.NODE_ENV==="test"?null:join(fileURLToPath(new URL(".",import.meta.url)),"data","live_cache.json");
const PROVIDER_LABEL={kudago:"KudaGo",timepad:"Timepad",osm:"OpenStreetMap/Overpass",dgis:"2GIS"};
let liveCache=null;
// Состояние источников: какой из них сейчас отключён предохранителем и почему.
// Иначе «часть источников временно недоступна» в интерфейсе ничем не объяснить.
export function providerHealth(){
  const out={};
  for(const n of ["kudago","timepad","osm","dgis"]){
    const b=breakerStatus(n,{cooldownMs:BREAKER.cooldownMs});
    out[n]={ok:!b.open,failures:b.failures,last_error:b.lastError||null,retry_in_sec:Math.round(b.retryInMs/1000)};
  }
  return out;
}
export function getLiveCache(){return liveCache||(liveCache=createCache({ttlMs:LIVE_TTL_MS,staleMs:LIVE_STALE_MS,file:CACHE_FILE}))}

// Ключ кеша — только то, что реально влияет на запрос к провайдеру (и plan.tags, которые попадают в карточки).
function cacheKeyFor(name,plan,hasKey){
  // Область входит в ключ: у центра и всей Москвы результаты разные.
  // Версия формата — тоже: файловый кеш переживает перезапуск, и после обновления
  // сервер иначе продолжал бы отдавать карточки, собранные прежним кодом.
  const base={v:ITEM_SCHEMA,t:plan.tags,c:wantsCenter(plan.area)};
  const part={
    kudago:{e:plan.eventQueries.slice(0,3),p:plan.placeQueries.slice(0,3),f:plan.freeOnly,d:plan.targetDate},
    timepad:{e:plan.eventQueries.length?plan.eventQueries.slice(0,3):[plan.coreQuery||""],d:plan.targetDate,f:plan.freeOnly,m:plan.maxPrice},
    osm:{f:osmFilters(plan)},
    dgis:{p:plan.placeQueries.slice(0,4),k:!!hasKey}
  }[name];
  return `${name}:${JSON.stringify({...base,...part})}`;
}

// Провайдер считается упавшим, если бросил исключение или вернул одни ошибки без единого результата.
async function cachedProvider(name,key,fn,{cache,now,breaker}){
  const hit=cache.get(key);
  if(hit&&hit.fresh)return {items:hit.value.items,errors:[],from_cache:true,degraded:breakerStatus(name,{cooldownMs:breaker.cooldownMs,now}).open};
  try{
    const r=await withBreaker(name,async()=>{
      const r=await fn();
      if((r.errors||[]).length&&!(r.items||[]).length){const e=new Error(r.errors.join("; "));e.labeled=true;throw e}
      return r;
    },{...breaker,now});
    cache.set(key,{items:r.items||[]});
    return {items:r.items||[],errors:r.errors||[],from_cache:false,degraded:false};
  }catch(e){
    const msg=e.open||e.labeled?e.message:`${PROVIDER_LABEL[name]}: ${e.message}`;
    if(hit)return {items:hit.value.items,errors:[msg],from_cache:true,degraded:true};
    return {items:[],errors:[msg],from_cache:false,degraded:true};
  }
}

// opts: {providers:{kudago,timepad,osm,dgis}, cache, now, breaker} — для тестов и прогрева.
export async function searchLiveInventory(args={},env=process.env,opts={}){
  const plan=buildSearchPlan(args);
  const P={kudago:searchKudago,timepad:searchTimepad,osm:searchOSM,dgis:search2GIS,...(opts.providers||{})};
  const ctx={cache:opts.cache||getLiveCache(),now:opts.now||Date.now,breaker:{...BREAKER,...(opts.breaker||{})}};
  const dgisKey=env.DGIS_API_KEY||env.TWOGIS_API_KEY||"";
  const skipEvents=plan.serviceOnly;
  const none={items:[],errors:[],from_cache:false,degraded:false,disabled:true};
  const [k,t,o,d]=await Promise.all([
    skipEvents?none:cachedProvider("kudago",cacheKeyFor("kudago",plan),()=>P.kudago(plan),ctx),
    skipEvents?none:cachedProvider("timepad",cacheKeyFor("timepad",plan),()=>P.timepad(plan),ctx),
    cachedProvider("osm",cacheKeyFor("osm",plan),()=>P.osm(plan),ctx),
    dgisKey?cachedProvider("dgis",cacheKeyFor("dgis",plan,true),()=>P.dgis(plan,dgisKey),ctx):{items:[],errors:[],from_cache:false,degraded:false,disabled:true}
  ]);
  const items=dedupe([...(d.items||[]),...(o.items||[]),...(k.items||[]),...(t.items||[])]);
  const degraded={kudago:k.degraded,timepad:t.degraded,osm:o.degraded,dgis:d.degraded};
  const from_cache={kudago:k.from_cache,timepad:t.from_cache,osm:o.from_cache,dgis:d.from_cache};
  const anyDegraded=Object.values(degraded).some(Boolean);
  const anyStale=[k,t,o,d].some(x=>x.degraded&&x.from_cache);
  const notes=[];
  if(plan.heavyDrinkingPhrase)notes.push("Запрос интерпретирован как поиск баров/пабов/ночных заведений; FREE не ранжирует места по количеству алкоголя.");
  if(anyDegraded)notes.push(anyStale?"Часть источников временно недоступна, показываю сохранённые результаты.":"Часть источников временно недоступна.");
  return {
    plan,items,
    errors:[...(k.errors||[]),...(t.errors||[]),...(o.errors||[]),...(d.errors||[])],
    providers:{kudago:!skipEvents,timepad:!skipEvents,osm:true,dgis:!d.disabled},
    degraded,from_cache,
    note:notes.length?notes.join(" "):null
  };
}
