// Афиша Дубая: события с датами, площадками, ценами и билетами.
//
// Данные — файл data/events_dubai.json (путь — EVENTS_DUBAI_FILE), который
// собирает scripts/dubai_events/harvest.mjs по таймеру (deploy/free-events.timer).
// Сервер только читает файл: поиск идёт в памяти за миллисекунды, и ни один
// запрос пользователя не ждёт чужой сайт. Файл перечитывается, когда он
// меняется на диске (сборщик подменяет его атомарно).
//
// searchDubaiEvents(plan,args) отдаёт карточки той же формы, что события
// KudaGo/Timepad (kind:"event", date_start, times, price_label, booking_url…),
// поэтому ранкер и карточка в интерфейсе работают с ними без изменений.
import {readFileSync,statSync,existsSync} from "node:fs";
import {spawn} from "node:child_process";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {CITY,cityDate,cityNow,L} from "./city.mjs";
import {affiliateUrl,addDays,weekday,daysBetween,norm,EVENT_TAGS} from "./scripts/dubai_events/normalize.mjs";

const ROOT=fileURLToPath(new URL(".",import.meta.url));
export const EVENTS_FILE_DEFAULT=join(ROOT,"data","events_dubai.json");
const HARVEST=join(ROOT,"scripts","dubai_events","harvest.mjs");
const STAT_EVERY_MS=5000;
const MAX_ITEMS=30;

// ---- Загрузка файла ----------------------------------------------------------
const state={file:null,mtimeMs:0,size:0,items:[],checkedAt:0,loadedAt:0,error:null};
export function eventsFile(env=process.env){return env.EVENTS_DUBAI_FILE||EVENTS_FILE_DEFAULT}
function valid(e){return e&&typeof e==="object"&&typeof e.name==="string"&&e.name&&/^\d{4}-\d{2}-\d{2}$/.test(e.date_start||"")}
/**
 * Текущие события из файла. Файл перечитывается, только если изменились его
 * размер или время изменения (проверка — не чаще раза в 5 секунд). Битый
 * файл не затирает прежние данные: остаётся последнее хорошее.
 */
export function loadDubaiEvents({file=eventsFile(),now=Date.now(),force=false}={}){
  if(state.file!==file){Object.assign(state,{file,mtimeMs:0,size:0,items:[],checkedAt:0,loadedAt:0,error:null})}
  if(!force&&now-state.checkedAt<STAT_EVERY_MS)return state.items;
  state.checkedAt=now;
  let st;
  try{st=statSync(file)}catch{state.error=state.items.length?null:"no events file yet";return state.items}
  if(!force&&st.mtimeMs===state.mtimeMs&&st.size===state.size)return state.items;
  try{
    const data=JSON.parse(readFileSync(file,"utf8"));
    if(!Array.isArray(data))throw new Error("expected an array of events");
    state.items=data.filter(valid);
    state.mtimeMs=st.mtimeMs;state.size=st.size;state.loadedAt=now;state.error=null;
  }catch(e){state.error=`events file unreadable: ${e.message}`}
  maybeRefresh(now);
  return state.items;
}

// ---- Фоновое обновление (необязательно) ----------------------------------------
// Основной путь обновления — таймер systemd. Здесь — запасной: при
// EVENTS_DUBAI_AUTOREFRESH=1 сервер сам запускает сборщик, если файлу больше
// 12 часов (или его нет). Один процесс за раз и не чаще раза в час.
let refreshing=null,lastRefreshAt=0;
function maybeRefresh(now=Date.now()){
  if(process.env.EVENTS_DUBAI_AUTOREFRESH!=="1"||process.env.NODE_ENV==="test")return false;
  if(refreshing||now-lastRefreshAt<60*60_000)return false;
  const age=state.mtimeMs?now-state.mtimeMs:Infinity;
  if(age<12*60*60_000)return false;
  lastRefreshAt=now;
  try{
    refreshing=spawn(process.execPath,["--no-warnings",HARVEST,"--out",state.file||eventsFile(),"--quiet"],{stdio:"ignore",detached:true,cwd:ROOT});
    refreshing.on("exit",()=>{refreshing=null;state.checkedAt=0});
    refreshing.on("error",()=>{refreshing=null});
    refreshing.unref();
    return true;
  }catch{refreshing=null;return false}
}

export function dubaiEventsHealth({now=Date.now()}={}){
  const items=loadDubaiEvents({now});
  const today=cityDate(new Date(now));
  const upcoming=items.filter(e=>(e.date_end||e.date_start)>=today);
  const fetched=items.reduce((m,e)=>e.fetched_at&&e.fetched_at>m?e.fetched_at:m,"");
  const ageH=fetched?Math.round((now-Date.parse(fetched))/36e5*10)/10:null;
  return {ok:upcoming.length>0&&!state.error,events:upcoming.length,fetched_at:fetched||null,age_hours:ageH,
    stale:ageH!==null&&ageH>36,refreshing:Boolean(refreshing),error:state.error||null};
}

// ---- Разбор запроса: когда ------------------------------------------------------
const WD=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const MON={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
// Выходные в ОАЭ — суббота и воскресенье (с 2022 года). В субботу «эти
// выходные» — сегодня и завтра, в воскресенье — только сегодня.
export function weekendOf(today){
  const w=weekday(today);
  if(w===6)return {start:today,end:addDays(today,1)};
  if(w===0)return {start:today,end:today};
  const toSat=6-w;
  return {start:addDays(today,toSat),end:addDays(today,toSat+1)};
}
function nextWeekday(today,idx){const w=weekday(today);return addDays(today,(idx-w+7)%7)}
function endOfMonth(date){const d=new Date(date+"T12:00:00Z");d.setUTCMonth(d.getUTCMonth()+1,0);return d.toISOString().slice(0,10)}
const EVENING=/\btonight\b|\bthis evening\b|\btonite\b|\b(?:today|tomorrow|saturday|sunday|friday|monday|tuesday|wednesday|thursday) (?:night|evening)\b|\bafter work\b/;
/**
 * Окно дат из запроса и аргументов: {start,end,label,evening,explicit}.
 * target_date от агента важнее слов запроса. Без даты — ближайшие 30 дней.
 */
export function eventWindow(query="",args={},now=new Date()){
  const today=cityDate(now);
  const q=String(query||"").toLowerCase().replace(/[’']/g,"'");
  const evening=EVENING.test(q);
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(args.target_date||""))){
    const d=args.target_date<today?today:args.target_date;
    return {start:d,end:d,label:d===today?(evening?"tonight":"today"):d,evening,explicit:true};
  }
  if(/\btonight\b|\btonite\b|\bthis evening\b|\btoday\b|\bright now\b|\bnow\b/.test(q))return {start:today,end:today,label:evening?"tonight":"today",evening,explicit:true};
  if(/\btomorrow\b/.test(q)){const d=addDays(today,1);return {start:d,end:d,label:"tomorrow",evening,explicit:true}}
  if(/\bnext weekend\b/.test(q)){const w=weekendOf(addDays(weekendOf(today).end,1));return {...w,label:"next weekend",evening,explicit:true}}
  if(/\bweekend\b/.test(q)){const w=weekendOf(today);return {...w,label:"this weekend",evening,explicit:true}}
  if(/\bnext week\b/.test(q)){const mon=addDays(today,((1-weekday(today)+7)%7)||7);return {start:mon,end:addDays(mon,6),label:"next week",evening,explicit:true}}
  if(/\bthis week\b/.test(q))return {start:today,end:addDays(today,(7-weekday(today))%7),label:"this week",evening,explicit:true};
  if(/\bthis month\b/.test(q))return {start:today,end:endOfMonth(today),label:"this month",evening,explicit:true};
  for(let i=0;i<7;i++){
    if(new RegExp(`\\b(?:this |on |next )?${WD[i]}s?\\b`).test(q)){
      let d=nextWeekday(today,i);
      if(new RegExp(`\\bnext ${WD[i]}\\b`).test(q)&&d===today)d=addDays(d,7);
      return {start:d,end:d,label:WD[i][0].toUpperCase()+WD[i].slice(1),evening,explicit:true};
    }
  }
  // «October 10», «10 Oct», «on the 10th of October».
  const m=/\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(q)||/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?\b/.exec(q);
  if(m){
    const day=Number(/^\d/.test(m[1])?m[1]:m[2]),mon=MON[(/^\d/.test(m[1])?m[2]:m[1]).slice(0,3)];
    let y=Number(today.slice(0,4));
    let d=`${y}-${String(mon).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    if(d<today)d=`${y+1}${d.slice(4)}`;
    if(day>=1&&day<=31)return {start:d,end:d,label:d,evening,explicit:true};
  }
  const mm=/\bin (january|february|march|april|may|june|july|august|september|october|november|december)\b/.exec(q);
  if(mm){
    const mon=MON[mm[1].slice(0,3)];let y=Number(today.slice(0,4));
    let start=`${y}-${String(mon).padStart(2,"0")}-01`;if(endOfMonth(start)<today)start=`${y+1}${start.slice(4)}`;
    return {start:start<today?today:start,end:endOfMonth(start),label:mm[1],evening,explicit:true};
  }
  return {start:today,end:addDays(today,30),label:"upcoming",evening,explicit:false};
}

// ---- Разбор запроса: что ----------------------------------------------------------
const ASK=[
  ["comedy",/\bcomed(?:y|ies|ian|ians)\b|\bstand[ -]?up\b(?! paddle)|\bfunny\b|\blaughs?\b/],
  ["concert",/\bconcerts?\b|\bgigs?\b|\blive music\b|\bbands?\b|\bsingers?\b|\borchestra\b|\bsymphony\b|\bjazz\b|\bclassical music\b|\bmusic\b(?! venue| shop| store| school| class)/],
  ["theatre",/\btheat(?:re|er)s?\b|\bplays?\b(?! ?areas?| ?grounds?| ?zones?| ?dates?| ?rooms?)|\bmusicals?\b|\bballet\b|\bopera\b(?! gallery)|\bcircus\b|\bmagic show\b|\bacrobat\w*/],
  ["club",/\bnight ?clubs?\b|\bclub(?:bing|s)?\b(?! sandwich)|\bdjs?\b|\bpart(?:y|ies)\b|\brave\b|\btechno\b|\bhouse music\b|\bdanc(?:e|ing)\b/],
  ["nightlife",/\bnight ?life\b|\bnight out\b|\bladies night\b|\bgoing out\b/],
  ["kids",/\bkids?\b|\bchildren\b|\bchild\b|\bfamily\b|\bfamilies\b|\btoddlers?\b|\bmy (?:son|daughter)\b/],
  ["sport",/\bsports?\b|\bmatch(?:es)?\b|\bfootball\b|\bbasketball\b|\bcricket\b|\btennis\b|\bmarathon\b|\brace\b|\bmma\b|\bufc\b|\bboxing\b|\bfights?\b|\btriathlon\b|\bgrand prix\b|\bgame tonight\b/],
  ["exhibition",/\bexhibitions?\b|\bart (?:show|fair|events?)\b|\bgaller(?:y|ies)\b|\bdesign (?:week|events?)\b|\binstallations?\b/],
  ["festival",/\bfestivals?\b|\bfest\b|\bcelebrations?\b|\bdiwali\b|\bnavratri\b|\bgarba\b|\bdandiya\b|\bhalloween\b|\bchristmas\b|\bnew year'?s?\b|\bnational day\b/],
  ["food",/\bbrunch(?:es)?\b|\bfood festival\b|\btasting\b|\bculinary\b|\bafternoon tea\b|\bhigh tea\b|\bsupper club\b/],
  ["tour",/\btours?\b|\bcruise\b|\bsafari\b|\bboat (?:trip|ride|tour)\b|\byacht\b|\bhelicopter\b|\bexcursions?\b/]
];
// Слова, по которым ясно, что спрашивают афишу, а не место.
const EVENTISH=/\bevents?\b|\bwhat'?s on\b|\bwhats on\b|\bwhat is on\b|\bwhat'?s happening\b|\bhappening\b|\bgoing on\b|\btickets?\b|\bshows?\b|\bperformances?\b|\bperforming\b|\bline.?up\b|\bconcerts?\b|\bgigs?\b|\bfestivals?\b|\blive (?:music|show|performance)\b|\bplaying\b|\bwho'?s playing\b|\bscreening\b/;
const BUSINESS_ASK=/\bconferences?\b|\bsummits?\b|\bforums?\b|\bcongress\b|\bexpos?\b|\btrade (?:show|fair)s?\b|\bnetworking\b|\bbusiness events?\b|\bexhibitions? (?:and|&) conferences?\b/;
const EXPERIENCE_ASK=/\bexperiences?\b|\bactivit(?:y|ies)\b|\bthings to do\b|\bworkshops?\b|\bclass(?:es)?\b|\bmasterclass\b|\btours?\b|\bcruise\b|\bsafari\b|\bbrunch\b|\bafternoon tea\b|\bhigh tea\b|\bboat\b|\byacht\b/;
// Места, у которых своя афиша: «Dubai Opera tonight», «what's on at Coca-Cola Arena».
const VENUES=[
  [/\bdubai opera\b/,/\bdubai opera\b/],[/\bcoca[ -]?cola arena\b/,/\bcoca cola arena\b/],[/\bpepperoni\b/,/\bpepperoni\b/],
  [/\bcovent garden\b/,/\bcovent garden\b/],[/\bmeyana\b/,/\bmeyana\b/],[/\bbohemia\b/,/\bbohemia\b/],[/\bpacha\b/,/\bpacha\b/],
  [/\bushua[iï]a\b/,/\bushuaia\b/],[/\bla perle\b/,/\bla perle\b/],[/\bmadinat theatre\b/,/\bmadinat\b/],[/\bexpo city\b/,/\bexpo city\b/],
  [/\bmall of the emirates\b/,/\bmall of the emirates\b/],[/\bdubai mall\b/,/\bdubai mall\b/],[/\bzabeel park\b/,/\bzabeel\b/],
  [/\bjubilee park\b/,/\bjubilee park\b/],[/\bwarehouse 40\b|\balserkal\b/,/\balserkal\b|\bwarehouse 40\b|\bal khayat\b/],
  [/\btroy\b/,/\btroy\b/],[/\bvice club\b/,/\bvice\b/],[/\bopal room\b/,/\bopal room\b/],[/\btheatre of digital art\b/,/\btheatre of digital art\b/]
];
export function eventAsk(query="",plan={}){
  const q=String(query||"").toLowerCase().replace(/[’']/g,"'");
  const tags=ASK.filter(([,re])=>re.test(q)).map(([k])=>k);
  // «Dubai Opera» — имя площадки, а не просьба об опере.
  const venueRes=VENUES.filter(([re])=>re.test(q)).map(([,v])=>v);
  if(venueRes.some(v=>v.test("dubai opera"))){const i=tags.indexOf("theatre");if(i>=0&&!/\b(?:opera|ballet|theat\w*|musicals?|plays?)\b/.test(q.replace(/\bdubai opera\b/g," ")))tags.splice(i,1)}
  const dated=/\btonight\b|\btonite\b|\btoday\b|\btomorrow\b|\bweekend\b|\bthis week\b|\bnext week\b|\bthis month\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b|\bthis evening\b|\b\d{1,2}(?:st|nd|rd|th)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b/.test(q)||Boolean(plan&&plan.targetDate);
  const eventish=EVENTISH.test(q);
  const business=BUSINESS_ASK.test(q);
  const experience=EXPERIENCE_ASK.test(q);
  // Афишу спрашивают прямо («events», «what's on», «tickets», «concert») или
  // называют рубрику события вместе с датой («club on Saturday», «Dubai Opera
  // tonight»). «bar tonight» — это про место: рубрики события в нём нет.
  const asked=eventish||business||((tags.length>0||venueRes.length>0)&&dated);
  return {asked,tags,venues:venueRes,dated,business,experience};
}

// Метки события → рубрики справочника категорий (их понимает ранкер):
// «kids» у нас — «family» в справочнике, «comedy» — часть «theatre».
const RANK_TAGS={
  concert:{cat:["concert"],tags:["music","concert"]},theatre:{cat:["theatre"],tags:["theatre","culture"]},
  comedy:{cat:["theatre","comedy"],tags:["comedy","theatre"]},club:{cat:["club","nightlife"],tags:["nightlife","club","music"]},
  nightlife:{cat:["nightlife"],tags:["nightlife"]},kids:{cat:["family"],tags:["family"]},sport:{cat:["sport","active"],tags:["active"]},
  exhibition:{cat:["gallery","art"],tags:["art","culture"]},festival:{cat:["festival"],tags:["festival"]},
  food:{cat:["food"],tags:["food"]},tour:{cat:["tours"],tags:["experience"]}
};
const SOURCE_LABEL={visitdubai:"Visit Dubai",district:"District",dubaiopera:"Dubai Opera"};
const sourceKey=(id)=>String(id||"").split(":")[1]||"";
function sessionsOf(e){
  if(Array.isArray(e.dates)&&e.dates.length)return e.dates.filter(d=>d&&/^\d{4}-\d{2}-\d{2}$/.test(d.date));
  return null;
}
function minutes(t){const m=/^(\d{1,2}):(\d{2})/.exec(String(t||""));return m?+m[1]*60+ +m[2]:null}
/**
 * Попадает ли событие в окно. Возвращает {date_start,date_end,times} для
 * карточки (даты внутри окна) или null. Прошедшее не показываем никогда:
 * сегодняшний показ, начавшийся больше трёх часов назад, — уже прошёл.
 */
export function inWindow(e,w,{today,nowMin}){
  const sessions=sessionsOf(e);
  const evening=w.evening;
  const okSession=(d,t)=>{
    if(d<w.start||d>w.end||d<today)return false;
    const m=minutes(t);
    if(d===today&&m!==null&&nowMin!==null&&m+180<nowMin)return false;
    if(evening&&m!==null&&m<16*60)return false;
    return true;
  };
  if(sessions){
    const hit=sessions.filter(s=>okSession(s.date,s.time));
    if(!hit.length)return null;
    return {date_start:hit[0].date,date_end:hit[hit.length-1].date,times:[...new Set(hit.filter(s=>s.date===hit[0].date).map(s=>s.time).filter(Boolean))]};
  }
  const start=e.date_start,end=e.date_end&&e.date_end>=start?e.date_end:start;
  if(end<today||end<w.start||start>w.end)return null;
  const from=start>w.start?start:w.start,to=end<w.end?end:w.end;
  const day=from<today?today:from;
  if(day>to)return null;
  if(!okSession(day,start===end?e.time:null))return null;
  // Вечер: долгая выставка без времени — не «на сегодня вечером».
  if(evening&&!e.time&&daysBetween(start,end)>3)return null;
  return {date_start:day,date_end:to,times:e.time&&start===end?[e.time]:[]};
}

export function toRankerItem(e,hit,env=process.env){
  const tags=Array.isArray(e.cat_tags)?e.cat_tags.filter(t=>EVENT_TAGS.includes(t)):[];
  const catTags=[...new Set(tags.flatMap(t=>[t,...(RANK_TAGS[t]?.cat||[])]))];
  const rtags=[...new Set(tags.flatMap(t=>RANK_TAGS[t]?.tags||[]))];
  const src=sourceKey(e.id);
  const booking=affiliateUrl(e.ticket_url||e.booking_url,env)||e.booking_url||e.source||null;
  const pmin=Number.isFinite(e.price_min)?e.price_min:null;
  const free=pmin===0;
  const venue=e.venue||"";
  return {
    id:e.id,provider:SOURCE_LABEL[src]||"Dubai events",live:true,kind:"event",name:e.name,
    organizer:venue||SOURCE_LABEL[src]||"",cat:e.category||"Event",
    tags:rtags,cat_tags:catTags,area:e.area||CITY.name,metro:"",
    date_start:hit.date_start,date_end:hit.date_end,times:hit.times.slice(0,8),hours_label:"",
    price_label:free?"Free":e.price||L("цена на сайте билетов","price on the ticket site"),price_min:pmin,free,
    availability:e.booking_provider?`tickets: ${e.booking_provider}`:"tickets online",
    source:e.source||booking,point_source:e.source||booking,official_source:null,
    aggregator_image:e.image_url||null,aggregator_name:SOURCE_LABEL[src]||e.booking_provider||null,image_source:e.source||null,
    booking_url:booking,booking_kind:"tickets",booking_provider:e.booking_provider||SOURCE_LABEL[src]||null,phone:null,
    desc:e.summary||"",keywords:norm([e.name,venue,e.category,tags.join(" "),e.area].join(" ")),
    coords:e.coords&&Number.isFinite(+e.coords.lat)&&Number.isFinite(+e.coords.lon)?{lat:+e.coords.lat,lon:+e.coords.lon}:null,
    event_window:hit.label||null
  };
}

/**
 * События под запрос. plan — план поиска (buildSearchPlan), args — аргументы
 * /api/recommend (query, target_date, after_time, max_price_rub).
 * Возвращает {items, ask, window, fallback}: ask.asked — запрос про афишу
 * (ранкер ставит такие события выше мест), window — окно дат.
 * Если в окне ничего нет — ближайшие события той же рубрики в следующие 14 дней.
 */
export function searchDubaiEvents(plan={},args={},opts={}){
  const now=opts.now?new Date(opts.now):new Date();
  const env=opts.env||process.env;
  const all=opts.items||loadDubaiEvents({file:opts.file||eventsFile(env),now:now.valueOf()});
  const query=String(args.query||plan.raw||"");
  const ask=eventAsk(query,plan);
  const w=eventWindow(query,args,now);
  const empty={items:[],errors:[],ask,window:w,fallback:false};
  // Ни рубрики события, ни площадки, ни слова «афиша» — запрос не про события.
  if(!ask.asked&&!ask.tags.length&&!ask.venues.length)return empty;
  const today=cityDate(now);
  const t=cityNow(now);const nowMin=t?t.minute:null;
  const wanted=new Set(ask.tags);
  const pick=(e)=>{
    if(e.business&&!ask.business)return false;
    if(ask.business&&!e.business&&!wanted.size)return false;
    // Предложения «на любой день» — только если просят их (тур, бранч,
    // занятие) или детское: мастер-класс для детей родителю как раз и нужен.
    if(e.experience&&!ask.experience&&!wanted.has("tour")&&!wanted.has("food")&&!(wanted.has("kids")&&(e.cat_tags||[]).includes("kids")))return false;
    if(wanted.size&&!(e.cat_tags||[]).some(x=>wanted.has(x)))return false;
    if(ask.venues.length&&!ask.venues.some(re=>re.test(norm(`${e.venue||""} ${e.name||""}`))))return false;
    const max=args.max_price_rub;
    if(max!==undefined&&max!==null&&Number.isFinite(+max)&&Number.isFinite(e.price_min)&&e.price_min>+max)return false;
    return true;
  };
  const pool=all.filter(pick);
  const collect=(win)=>{
    const out=[];
    for(const e of pool){const hit=inWindow(e,win,{today,nowMin});if(hit)out.push({e,hit:{...hit,label:win.label}})}
    // Раньше — раньше: сначала ближайшие даты, внутри дня — по времени.
    out.sort((a,b)=>(a.hit.date_start+(a.hit.times[0]||"99")).localeCompare(b.hit.date_start+(b.hit.times[0]||"99"))||(a.e.experience?1:0)-(b.e.experience?1:0));
    return out;
  };
  let found=collect(w),fallback=false;
  // «theatre tickets»: стендап в справочнике — тоже «театр», но спрашивали
  // спектакль. Если спектаклей хватает, стендап не подмешиваем.
  if(wanted.has("theatre")&&!wanted.has("comedy")){
    const plays=found.filter(x=>!(x.e.cat_tags||[]).includes("comedy"));
    if(plays.length>=3)found=plays;
  }
  if(!found.length&&w.explicit){
    // В нужный день ничего — ближайшее после окна (до 14 дней), с честной
    // пометкой даты в карточке.
    const next={start:addDays(w.end,1)<today?today:addDays(w.end,1),end:addDays(w.end,14),label:"next dates",evening:false};
    found=collect(next);fallback=found.length>0;
  }
  const items=found.slice(0,opts.limit||MAX_ITEMS).map(({e,hit})=>toRankerItem(e,hit,env));
  return {items,errors:state.error&&!all.length?[`Dubai events: ${state.error}`]:[],ask,window:w,fallback};
}
