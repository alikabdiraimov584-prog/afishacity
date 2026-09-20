// Разбор часов работы: OSM opening_hours ("Mo-Su 12:00-02:00", "24/7", "Mo-Fr 10:00-22:00; Sa,Su 11:00-23:00")
// и простые русские строки KudaGo/2GIS ("пн–вс 12:00–02:00", "ежедневно 10:00–22:00", "круглосуточно").
// parseHours(text, now) → {open_now:boolean|null, closes_at:"HH:MM"|null, opens_at:"HH:MM"|null}
// для момента `now` (Date или ISO-строка) по московскому времени. Ночные интервалы (до 02:00) поддерживаются.

const DAY_INDEX={mo:0,tu:1,we:2,th:3,fr:4,sa:5,su:6};
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
  return String(s||"").toLowerCase().replace(/ё/g,"е")
    .replace(/[–—−]/g,"-").replace(/\s+/g," ")
    .replace(/(^|[\s,;])с\s+(\d{1,2}[:.]\d{2})\s+до\s+(\d{1,2}[:.]\d{2})/g,"$1$2-$3")
    .replace(/круглосуточн[а-я]*|без перерыва и выходных|24 часа|24\/7/g,"24/7")
    .replace(/ежедневн[а-я]*|каждый день|daily|без выходных/g,"mo-su")
    .replace(/будни|в будние дни|по будням|рабочие дни/g,"mo-fr")
    .replace(/выходные|в выходные|по выходным/g,"sa-su")
    .replace(/выходной|закрыто|не работает|closed/g,"off")
    .trim();
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

export function moscowNow(now=new Date()){
  const d=now instanceof Date?now:new Date(now);
  if(!Number.isFinite(d.valueOf()))return null;
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Moscow",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d);
  const get=t=>parts.find(p=>p.type===t)?.value;
  const wd={Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6}[get("weekday")];
  return {day:wd,minute:(+get("hour")%24)*60+ +get("minute")};
}

const UNKNOWN={open_now:null,closes_at:null,opens_at:null};

export function parseHours(text,now=new Date()){
  const week=parseSchedule(text);if(!week)return UNKNOWN;
  const t=moscowNow(now);if(!t)return UNKNOWN;
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
