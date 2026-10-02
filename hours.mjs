// Разбор часов работы: OSM opening_hours ("Mo-Su 12:00-02:00", "24/7", "Mo-Fr 10:00-22:00; Sa,Su 11:00-23:00"),
// простые русские строки KudaGo/2GIS ("пн–вс 12:00–02:00", "ежедневно 10:00–22:00", "круглосуточно")
// и английские строки Foursquare/Google ("Mon-Thu 6pm–2am", "Monday: 12:00 PM – 2:00 AM", "Open 24 hours").
// parseHours(text, now) → {open_now:boolean|null, closes_at:"HH:MM"|null, opens_at:"HH:MM"|null}
// для момента `now` (Date или ISO-строка) по местному времени города (CITY.tz). Ночные интервалы (до 02:00) поддерживаются.
import {cityNow} from "./city.mjs";

const DAY_INDEX={mo:0,tu:1,we:2,th:3,fr:4,sa:5,su:6};
// Английские дни: полные и сокращённые формы → двухбуквенные коды OSM.
// «sun» и «sat» надо свернуть до «su»/«sa» раньше, чем сработает DAY_RE:
// \b(su)\b не находит «sun», и воскресенье терялось.
const EN_DAYS=[
  [/\b(?:monday|mon)\b/g,"mo"],[/\b(?:tuesday|tues|tue)\b/g,"tu"],[/\b(?:wednesday|weds|wed)\b/g,"we"],
  [/\b(?:thursday|thurs|thur|thu)\b/g,"th"],[/\b(?:friday|fri)\b/g,"fr"],[/\b(?:saturday|sat)\b/g,"sa"],
  [/\b(?:sunday|sun)\b/g,"su"]
];
// 12-часовое время → 24-часовое: «6pm» → 18:00, «6:30 pm» → 18:30, «12 am» → 00:00.
const TIME_12H=/(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\.?(?![a-z])/g;
function to24(_,h,m,ap){
  let hh=+h%12;if(ap==="p")hh+=12;
  return `${String(hh).padStart(2,"0")}:${m||"00"}`;
}
const RU_DAYS=[
  [/понедельник[а-я]*|(?<![а-я])пн(?![а-я])/g,"mo"],[/вторник[а-я]*|(?<![а-я])вт(?![а-я])/g,"tu"],
  [/сред[аыуе]|(?<![а-я])ср(?![а-я])/g,"we"],[/четверг[а-я]*|(?<![а-я])чт(?![а-я])/g,"th"],
  [/пятниц[аыуе]|(?<![а-я])пт(?![а-я])/g,"fr"],[/суббот[аыуе]|(?<![а-я])сб(?![а-я])/g,"sa"],
  [/воскресень[ея]|(?<![а-я])вс(?![а-я])/g,"su"]
];
const DAY_RE=/\b(mo|tu|we|th|fr|sa|su)\b/g;
const DAY_RANGE_RE=/\b(mo|tu|we|th|fr|sa|su)\s*-\s*(mo|tu|we|th|fr|sa|su)\b/g;
const TIME_RANGE_RE=/(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})/g;

function normalizeText(s){
  let t=String(s||"").toLowerCase().replace(/ё/g,"е")
    .replace(/[–—−]/g,"-").replace(/\s+/g," ")
    // Английские слова-времена и 12-часовой формат — до всего остального,
    // чтобы дальше работали те же регэкспы, что и для «12:00-02:00».
    .replace(/\bnoon\b/g,"12:00").replace(/\bmidnight\b/g,"00:00")
    .replace(TIME_12H,to24)
    .replace(/(\d{1,2}[:.]\d{2})\s+(?:to|till|until|-)\s+(\d{1,2}[:.]\d{2})/g,"$1-$2")
    .replace(/\bfrom\s+(?=\d{1,2}[:.]\d{2}-)/g,"")
    .replace(/(^|[\s,;])с\s+(\d{1,2}[:.]\d{2})\s+до\s+(\d{1,2}[:.]\d{2})/g,"$1$2-$3")
    .replace(/круглосуточн[а-я]*|без перерыва и выходных|24 часа|24\/7|(?:open )?24 hours|\b24h\b|around the clock/g,"24/7")
    .replace(/ежедневн[а-я]*|каждый день|daily|every ?day|без выходных/g,"mo-su")
    .replace(/будни|в будние дни|по будням|рабочие дни|weekdays/g,"mo-fr")
    .replace(/выходные|в выходные|по выходным|weekends/g,"sa-su")
    .replace(/выходной|закрыто|не работает|closed/g,"off");
  for(const [re,abbr] of EN_DAYS)t=t.replace(re,abbr);
  return t.trim();
}
function toMin(h,m){const v=+h*60+ +m;return v>1440?null:v}
function fmt(min){const v=((min%1440)+1440)%1440;return `${String(Math.floor(v/60)).padStart(2,"0")}:${String(v%60).padStart(2,"0")}`}

// Правило: {days:Set<0..6>, ranges:[{start,end}], off:boolean}; end>start всегда, ночь — end>1440.
const HOLIDAY_RE=/(?<![a-z])(ph|sh|easter)(?![a-z])|(?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?![a-z])|(?<![а-я])(праздничн|нерабочи)/;
function parseRule(text){
  let s=text;for(const [re,abbr] of RU_DAYS)s=s.replace(re,abbr);
  // «PH 12:00-18:00» и «Dec 25 off» — про праздники и конкретные даты, а не про
  // обычную неделю. Без дней недели такое правило раньше применялось ко всем семи
  // дням: «Dec 25 off» закрывал заведение навсегда.
  const holiday=HOLIDAY_RE.test(s);
  s=s.replace(/(?<![a-z])(ph|sh)(?![a-z])\s*(off)?/g," ");
  const days=new Set();
  s=s.replace(DAY_RANGE_RE,(_,a,b)=>{let i=DAY_INDEX[a];const j=DAY_INDEX[b];for(let k=0;k<7;k++){days.add(i);if(i===j)break;i=(i+1)%7}return " "});
  s=s.replace(DAY_RE,(_,a)=>{days.add(DAY_INDEX[a]);return " "});
  if(!days.size&&holiday)return null;                       // правило о праздниках без дней недели
  const all=days.size?days:new Set([0,1,2,3,4,5,6]);
  const explicitDays=days.size>0;
  const ranges=[];
  for(const m of s.matchAll(TIME_RANGE_RE)){
    const a=toMin(m[1],m[2]),b=toMin(m[3],m[4]);if(a===null||b===null)continue;
    ranges.push({start:a,end:b<=a?b+1440:b});
  }
  if(!ranges.length){
    // Круглосуточно — только если конкретных часов в правиле нет: иначе фраза
    // «без перерыва и выходных» рядом с интервалом затирала сам интервал.
    if(/24\/7/.test(s))return {days:all,ranges:[{start:0,end:1440}],off:false,explicitDays};
    if(/(?<![a-z])off(?![a-z])/.test(s))return {days:all,ranges:[],off:true,explicitDays};
    return null;
  }
  return {days:all,ranges,off:false,explicitDays};
}

// Запятая в расписании значит два разных вещи: «Sa,Su 11:00-23:00» — перечисление
// дней внутри одного правила, «пн-чт 12:00-00:00, пт-сб 12:00-06:00» — граница
// между правилами. Отличить их по регэкспу нельзя, поэтому идём слева направо:
// правило закончилось, только когда в нём уже есть время или «off».
const RULE_DONE=/\d{1,2}[:.]\d{2}\s*-\s*\d{1,2}[:.]\d{2}|24\/7|(?<![a-z])off(?![a-z])/;
function splitRules(text){
  const out=[];
  for(const chunk of String(text).split(";")){
    let buf="";
    for(const part of chunk.split(",")){
      if(RULE_DONE.test(buf)){out.push(buf.trim());buf=part}
      else buf=buf?buf+","+part:part;
    }
    if(buf.trim())out.push(buf.trim());
  }
  return out.filter(Boolean);
}

export function parseSchedule(text){
  const n=normalizeText(text);if(!n)return null;
  const week=Array.from({length:7},()=>null);let any=false,explicit=false;
  for(const part of splitRules(n)){
    const rule=parseRule(part);if(!rule)continue;any=true;
    if(rule.explicitDays)explicit=true;
    for(const d of rule.days)week[d]=rule.off?[]:rule.ranges;
  }
  if(!any)return null;
  // В opening_hours не упомянутый день означает «закрыто». Раньше он оставался
  // «неизвестно», и заведение, работающее только по будням, в субботу выглядело
  // как место с неизвестными часами.
  if(explicit)for(let d=0;d<7;d++)if(week[d]===null)week[d]=[];
  return week; // week[d] = массив интервалов, [] = выходной, null = неизвестно
}

// Местное время города: {day:0..6 (пн=0), minute}. Имя осталось от времён,
// когда город был один; теперь это cityNow() из city.mjs.
export function localNow(now=new Date()){
  const t=cityNow(now instanceof Date?now:new Date(now));
  return t?{day:DAY_INDEX[t.weekday],minute:t.minute}:null;
}
export const moscowNow=localNow;

const UNKNOWN={open_now:null,closes_at:null,opens_at:null};

export function parseHours(text,now=new Date()){
  const week=parseSchedule(text);if(!week)return UNKNOWN;
  const t=localNow(now);if(!t)return UNKNOWN;
  const {day,minute}=t;
  const always=week.every(r=>r&&r.length===1&&r[0].start===0&&r[0].end===1440);
  if(always)return {open_now:true,closes_at:null,opens_at:null};
  const today=week[day],yesterday=week[(day+6)%7];
  // Ночной интервал вчерашнего дня, продолжающийся после полуночи.
  if(yesterday)for(const r of yesterday)if(r.end>1440&&minute<r.end-1440)return {open_now:true,closes_at:fmt(r.end),opens_at:null};
  if(today===null)return UNKNOWN;
  for(const r of today)if(minute>=r.start&&minute<r.end)return {open_now:true,closes_at:fmt(r.end),opens_at:null};
  // Закрыто: ищем ближайшее открытие в течение недели.
  let opens=null;
  for(let i=0;i<7&&opens===null;i++){
    const rs=week[(day+i)%7];if(!rs)continue;
    const cand=rs.filter(r=>i>0||r.start>minute).sort((a,b)=>a.start-b.start)[0];
    if(cand)opens=fmt(cand.start);
  }
  return {open_now:false,closes_at:null,opens_at:opens};
}

/* Правдоподобие часов. Часы на карте вносят руками, и в Дубае встречается
   откровенная ошибка ввода: стейкхаус «Fr-Su 00:00-12:15» (хотели 12:00-00:15),
   ресторан в молле «09:00-12:00», «00:00-00:00». Такие часы честнее считать
   неизвестными, чем звать человека в закрытое место или прятать открытое.
   Правила намеренно узкие:
   — окно нулевой длины («12:00-12:00», «00:00-00:00») — всегда ошибка;
   — у ресторана, бара, паба, клуба, кальянной (eatery=true) единственное окно
     дня начинается в полночь и кончается раньше 15:00;
   — у них же всё расписание кончается к 12:30 — так рестораны не работают.
   Кафе сюда не входят: завтраки до полудня бывают на самом деле. */
export function hoursSane(text,{eatery=false}={}){
  const n=normalizeText(text);if(!n)return true;
  for(const m of n.matchAll(TIME_RANGE_RE)){
    const a=toMin(m[1],m[2]),b=toMin(m[3],m[4]);
    if(a!==null&&b!==null&&a===b)return false;
  }
  if(!eatery)return true;
  const week=parseSchedule(text);if(!week)return true;
  let maxEnd=0,any=false;
  for(const day of week){
    if(!day||!day.length)continue;any=true;
    if(day.length===1&&day[0].start===0&&day[0].end<15*60)return false;
    for(const r of day)maxEnd=Math.max(maxEnd,r.end);
  }
  if(any&&maxEnd<=12*60+30)return false;
  return true;
}

const EN_DAY_NAMES=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
/* Часы по-человечески, для карточки: «Open today 12:00–23:30»,
   «Open now · until 02:00», «Closed now · opens 12:00»,
   «Closed now · opens tomorrow 09:00», «Open 24 hours». null — неизвестно.
   Строка OSM вроде «Su-We 08:00-24:00; Th-Sa 08:00-01:00» человеку ничего не
   говорит: её отдаём отдельным полем для подробной карточки. */
export function hoursSummary(text,now=new Date()){
  const week=parseSchedule(text);if(!week)return null;
  const t=localNow(now);if(!t)return null;
  if(week.every(r=>r&&r.length===1&&r[0].start===0&&r[0].end===1440))return "Open 24 hours";
  const h=parseHours(text,now);
  if(h.open_now===null)return null;
  const today=week[t.day]||[];
  if(h.open_now){
    const win=today.find(r=>t.minute>=r.start&&t.minute<r.end);
    if(win&&win.start===0&&win.end>=1440)return "Open 24 hours today";
    if(win)return `Open today ${fmt(win.start)}–${fmt(win.end)}`;
    return h.closes_at?`Open now · until ${h.closes_at}`:"Open now";
  }
  if(!h.opens_at)return "Closed now";
  if(today.some(r=>r.start>t.minute))return `Closed now · opens ${h.opens_at}`;
  for(let i=1;i<7;i++){
    const rs=week[(t.day+i)%7];
    if(rs&&rs.length)return `Closed now · opens ${i===1?"tomorrow":EN_DAY_NAMES[(t.day+i)%7]} ${h.opens_at}`;
  }
  return "Closed now";
}

const MONTHS_EN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/* Сезон «MM-DD/MM-DD» (free:season): Global Village работает с октября по май,
   и в остальное время карта честно показывает его часы — но ворота закрыты.
   Сезон может переходить через Новый год («10-14/05-10»).
   date — «YYYY-MM-DD» по местному времени. Ответ: {open:boolean, opens:"14 Oct"|null}
   или null, если строка сезона не разобрана. */
export function seasonState(season,date){
  const m=String(season||"").trim().match(/^(\d{2})-(\d{2})\s*\/\s*(\d{2})-(\d{2})$/);
  const d=String(date||"").match(/^\d{4}-(\d{2})-(\d{2})$/);
  if(!m||!d)return null;
  const from=+m[1]*100+ +m[2],to=+m[3]*100+ +m[4],cur=+d[1]*100+ +d[2];
  if(!(+m[1]>=1&&+m[1]<=12&&+m[3]>=1&&+m[3]<=12))return null;
  const open=from<=to?cur>=from&&cur<=to:cur>=from||cur<=to;
  return {open,opens:open?null:`${+m[2]} ${MONTHS_EN[+m[1]-1]}`};
}
