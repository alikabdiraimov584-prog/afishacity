// Данные с собственных сайтов заведений (harvest_meta.py → site_meta.jsonl)
// → теги места. Пишем ТОЛЬКО эти теги (на них опираются остальные части):
//   opening_hours + source:opening_hours=website  — если в OSM часов нет;
//   free:price (1–4) + free:price_src=site;
//   free:booking_url + free:booking_provider ("SevenRooms"|"OpenTable"|"Eat App"|
//     "TableCheck"|"Resy"|"Quandoo"|"ResDiary"|"Chope"|"TheFork"|"Website");
//   free:menu (ссылка);
//   cuisine — только если её нет (значения OSM: строчные, «_», через «;»).
// Сайт сети (≥3 мест на одном адресе сайта): часы, бронь и меню — только
// если они про этот филиал (совпали координаты/адрес или в ссылке имя
// филиала); часы одного филиала всем остальным не раздаём.
import fs from "node:fs";

export const PROVIDERS=["SevenRooms","OpenTable","Eat App","TableCheck","Resy","Quandoo","ResDiary","Chope","TheFork","Website"];
const DAYS=["Mo","Tu","We","Th","Fr","Sa","Su"];

// Тот же ключ сайта, что siteOf() в ingest.mjs.
export const siteKey=(t)=>{let s=String(t.website||t["contact:website"]||t.url||"").trim();if(s&&!s.includes("://"))s="http://"+s;return s};

export function loadSiteMeta(path){
  const m=new Map();
  if(!path||!fs.existsSync(path))return m;
  for(const line of fs.readFileSync(path,"utf8").split("\n")){
    if(!line.trim())continue;
    let r;try{r=JSON.parse(line)}catch{continue}
    if(r&&r.site&&r.ok)m.set(r.site,r);
  }
  return m;
}

// ---------- провайдеры брони ----------
export function detectProvider(url){
  let u;try{u=new URL(url)}catch{return null}
  const h=u.hostname.toLowerCase(),path=u.pathname||"/",segs=path.split("/").filter(Boolean),q=u.searchParams;
  if(/(^|\.)sevenrooms\.com$/.test(h))return {provider:"SevenRooms",specific:/\/(?:reservations|explore\/[^/]+\/reservations)(?:\/|$)/.test(path)&&(segs.length>=2||q.has("venue"))};
  if(/(^|\.)opentable\.[a-z.]+$/.test(h)){
    const specific=!!(q.get("rid")||q.get("restref")||/^\/(?:r|restaurant\/profile)\/./.test(path)||(segs.length===1&&segs[0].includes("-")&&!["about-us","gift-cards","start-now"].includes(segs[0])));
    return {provider:"OpenTable",specific};
  }
  if(/(^|\.)eatapp\.co$/.test(h)||/(^|\.)eat-app\.[a-z.]+$/.test(h)){
    const bad=new Set("blog pricing features about en ar careers contact integrations restaurant-reservation-system login signup resources privacy terms product solutions customers partners demo pos static assets packs widget.js".split(" "));
    return {provider:"Eat App",specific:segs.length>0&&!bad.has(segs[0].toLowerCase())};
  }
  if(/(^|\.)tablecheck\.com$/.test(h))return {provider:"TableCheck",specific:segs.includes("shops")||segs.includes("reserve")};
  if(/(^|\.)resy\.com$/.test(h))return {provider:"Resy",specific:(segs.includes("cities")&&segs.length>=3)||h.startsWith("widgets.")||q.has("venueId")};
  if(/(^|\.)quandoo\.[a-z.]+$/.test(h))return {provider:"Quandoo",specific:segs.includes("place")||h.includes("widget")};
  if(/(^|\.)resdiary\.com$/.test(h))return {provider:"ResDiary",specific:segs.includes("restaurant")||/widget/i.test(path)};
  if(/(^|\.)chope\.co$/.test(h))return {provider:"Chope",specific:q.has("rid")||segs.includes("restaurant")};
  if(/(^|\.)thefork\.[a-z.]+$/.test(h))return {provider:"TheFork",specific:segs.includes("restaurant")};
  return null;
}

// ---------- часы ----------
const DAY_WORDS=[[/^(?:mo|mon|monday|mondays)$/,0],[/^(?:tu|tue|tues|tuesday|tuesdays)$/,1],[/^(?:we|wed|weds|wednesday|wednesdays)$/,2],
  [/^(?:th|thu|thur|thurs|thursday|thursdays)$/,3],[/^(?:fr|fri|friday|fridays)$/,4],[/^(?:sa|sat|saturday|saturdays)$/,5],[/^(?:su|sun|sunday|sundays)$/,6]];
function dayIdx(w){w=String(w||"").toLowerCase().replace(/^.*[/#]/,"").replace(/[^a-z]/g,"");for(const [re,i] of DAY_WORDS)if(re.test(w))return i;return -1}
// «12:00:00+04:00», «9:00», «9.30», «9pm», «12 noon», «midnight» → минуты от полуночи.
export function parseTime(s){
  let v=String(s??"").trim().toLowerCase();
  if(!v)return null;
  if(/^(?:midnight)$/.test(v))return 0;
  if(/^(?:noon|12 ?noon|midday)$/.test(v))return 720;
  v=v.replace(/(?:[+-]\d{2}:?\d{2}|z)$/,"").replace(/\s+/g," ");
  const m=v.match(/^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?$/);
  if(!m)return null;
  let h=+m[1];const mi=+(m[2]||0);const ap=m[4]?m[4][0]:null;
  if(mi>59)return null;
  if(ap==="a"||ap==="p"){if(h<1||h>12)return null;h=h%12+(ap==="p"?12:0)}
  else if(ap==="n"){if(h!==12)return null}
  else if(!m[2]&&!m[3])return null; // голое «9» без «am/pm» — не время
  if(h>24||(h===24&&mi))return null;
  return h*60+mi;
}
const hhmm=(x)=>`${String(Math.floor(x/60)).padStart(2,"0")}:${String(x%60).padStart(2,"0")}`;
// Интервал [начало, конец] → «HH:MM-HH:MM»; конец 00:00/23:59 → 24:00; через полночь — как есть («18:00-02:00»).
function interval(o,c){
  if(o==null||c==null)return null;
  if(c===1439)c=1440;
  if(c===0)c=1440;
  if(o===c)return null;
  if(o===1440)return null;
  if(c<o&&c>720)return null; // «22:00-14:00» — ошибка, а не ночь
  return {o,c};
}
function weekToOsm(week){
  // week[d] = null (не сказано) | [] (выходной) | [{o,c}]
  if(week.every(d=>d===null))return null;
  const val=week.map(d=>{
    if(!d||!d.length)return "off";
    // Пересекающиеся интервалы (завтрак 06–11 внутри 06–23, повтор строки) — объединяем.
    const ivs=[];
    for(const x of [...d].map(x=>({o:x.o,c:x.c<=x.o?x.c+1440:x.c})).sort((a,b)=>a.o-b.o)){
      const p=ivs.at(-1);
      if(p&&x.o<=p.c){p.c=Math.max(p.c,x.c);continue}
      ivs.push({...x});
    }
    for(const x of ivs){if(x.c-x.o>=1440){if(ivs.length>1||x.o!==0)return "bad";x.c=1440}else if(x.c>1440)x.c-=1440;if(x.c===x.o)return "bad"}
    if(ivs.length>1&&ivs.at(-1).c<ivs.at(-1).o&&ivs.at(-1).c>ivs[0].o)return "bad";
    return ivs.map(x=>`${hhmm(x.o)}-${hhmm(x.c)}`).join(",");
  });
  if(val.includes("bad"))return null;
  if(val.every(v=>v==="off"))return null;
  if(val.every(v=>v==="00:00-24:00"))return "24/7";
  // Одинаковые часы — одним правилом, даже если дни не подряд: «Mo-Th,Su 12:00-24:00; Fr,Sa 12:00-01:00».
  const groups=new Map();
  for(let i=0;i<7;i++)if(val[i]!=="off"){if(!groups.has(val[i]))groups.set(val[i],[]);groups.get(val[i]).push(i)}
  const rules=[];
  for(const [v,days] of groups){
    const parts=[];
    for(let k=0;k<days.length;){
      let j=k;while(j+1<days.length&&days[j+1]===days[j]+1)j++;
      const a=days[k],b=days[j];
      parts.push(a===b?DAYS[a]:b===a+1?`${DAYS[a]},${DAYS[b]}`:`${DAYS[a]}-${DAYS[b]}`);
      k=j+1;
    }
    rules.push(`${parts.join(",")} ${v}`);
  }
  return rules.join("; ");
}
// openingHoursSpecification → OSM.
function fromSpec(specs){
  const week=Array(7).fill(null);let any=false;
  for(const s of specs||[]){
    if(!s||typeof s!=="object")continue;
    // особые даты (праздники, Рамадан) — не обычная неделя
    if(s.validFrom||s.validThrough){
      const a=Date.parse(s.validFrom||""),b=Date.parse(s.validThrough||"");
      if(!(a&&b&&b-a>=300*864e5))continue;
    }
    const days=[];
    for(const d of [].concat(s.dayOfWeek||[])){
      const w=String(d).toLowerCase().replace(/^.*[/#]/,"");
      if(w==="publicholidays")continue;
      const i=dayIdx(w);
      if(i>=0){days.push(i);continue}
      const r=parseDays(String(d).replace(/^.*[/#]/,""));if(!r)return null;days.push(...r);
    }
    if(!days.length)continue;
    const o=parseTime(s.opens),c=parseTime(s.closes);
    if(s.opens==null&&s.closes==null){for(const i of days)week[i]=week[i]||[];any=true;continue}
    if(o==null||c==null)return null;
    if(o===0&&c===0){for(const i of days)if(!week[i])week[i]=[];any=true;continue} // 00:00-00:00 — закрыто (schema.org)
    const iv=interval(o,c);if(!iv)return null;
    for(const i of days){(week[i]=week[i]||[]).push(iv)}
    any=true;
  }
  if(!any)return null;
  for(let i=0;i<7;i++)if(week[i]===null)week[i]=[];
  return weekToOsm(week);
}
// Строки openingHours: «Mo-Sa 11:00-14:30», «Mo,Tu,We 09:00-17:00», «Monday - Friday: 9am - 5pm»,
// «Daily 10 AM - 10 PM», «Tu-Su 12:00-23:00, Mo closed», «24/7». Что не разобрали целиком — не берём.
const TIME_RE=String.raw`(?:\d{1,2}(?:[:.]\d{2}){1,2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?|midnight|12\s?noon|noon)`;
const RANGE_SRC=String.raw`(${TIME_RE})\s*(?:-|–|—|\bto\b|\buntil\b|\btill\b)\s*(${TIME_RE})`;
const DAYTOK=String.raw`(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun|mo|tu|we|th|fr|sa|su)`;
const DAYWORD=String.raw`(?:${DAYTOK}|daily|everyday|every\s?day|weekdays|weekends?)`;
const DAYSPEC_RE=new RegExp(String.raw`^(?:${DAYTOK}\.?(?:\s*(?:-|–|—|to|through|thru|&|and|,|/)\s*${DAYTOK}\.?)*)$`,"i");
const ALL=[0,1,2,3,4,5,6];
function parseDays(spec){
  spec=spec.trim().toLowerCase().replace(/[.:]$/,"").trim();
  if(!spec)return null;
  if(/^(?:daily|everyday|every ?day|all ?days|all week|7 days(?: a week)?|open daily)$/.test(spec))return ALL;
  if(/^weekdays$/.test(spec))return [0,1,2,3,4];
  if(/^weekends?$/.test(spec))return [5,6];
  if(!DAYSPEC_RE.test(spec))return null;
  const out=new Set();
  for(const p of spec.split(/\s*(?:,|&|\band\b|\/)\s*/).filter(Boolean)){
    const r=p.split(/\s*(?:-|–|—|\bto\b|\bthrough\b|\bthru\b)\s*/).filter(Boolean);
    if(r.length===1){const i=dayIdx(r[0]);if(i<0)return null;out.add(i)}
    else if(r.length===2){let a=dayIdx(r[0]);const b=dayIdx(r[1]);if(a<0||b<0)return null;for(let k=0;k<7;k++){out.add(a);if(a===b)break;a=(a+1)%7}}
    else return null;
  }
  return [...out];
}
// Части: «;», «|», а также граница «…время/closed, День…» («Mo-Th 12:00-23:00, Fr 12:00-01:00»);
// запятые между днями («Mo,Tu,We 09:00-17:00») не режем.
const SPLIT_RE=new RegExp(String.raw`\s*[;|]\s*|(?<=\d|[ap]\.?m\.?|closed|off|hours)\s*,?\s+(?=${DAYWORD}\b)|(?<=\d|[ap]\.?m\.?|closed|off|hours),(?=${DAYWORD}\b)`,"i");
function fromStrings(list){
  const week=Array(7).fill(null);let any=false;
  const txt=[].concat(list||[]).map(String).join("; ").replace(/<\/?(?:li|br|p|div|tr|td|span)\b[^>]*>/gi,"; ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").replace(/(?:\s*,\s*){2,}/g,", ").replace(/(?:\s*;\s*)+/g,"; ").replace(/^[\s;,]+|[\s;,]+$/g,"").trim();
  if(!txt)return null;
  if(/^(?:24\/7|open 24\/7|open 24 hours|24 hours(?: a day)?)$/i.test(txt))return "24/7";
  for(let ch of txt.split(SPLIT_RE)){
    ch=(ch||"").trim().replace(/^(?:opening hours|hours|open)\s*:?\s*/i,"").replace(/[.,;:\s]+$/,"");
    if(!ch)continue;
    let m=ch.match(/^(.*?)[\s:\-–—]*\b(?:closed|off)$/i);
    if(m){const ds=parseDays(m[1]);if(!ds)return null;for(const d of ds)week[d]=[];any=true;continue}
    m=ch.match(/^(.*?)[\s:\-–—]*(?:open\s*)?(?:24\s?hours(?: a day)?|24\/7|00:00\s*-\s*24:00|all day)$/i);
    if(m){const ds=m[1].trim()?parseDays(m[1]):ALL;if(!ds)return null;for(const d of ds)week[d]=[{o:0,c:1440}];any=true;continue}
    const first=new RegExp(RANGE_SRC,"i").exec(ch);
    if(!first)return null;
    const dspec=ch.slice(0,first.index).replace(/[\s:,\-–—]+$/,"");
    const ds=dspec?parseDays(dspec):ALL;
    if(!ds)return null;
    // после первого интервала — только ещё интервалы через запятую/«and»
    const rest=ch.slice(first.index);
    if(rest.replace(new RegExp(RANGE_SRC,"gi"),"").replace(/[\s,&]|\band\b/gi,""))return null;
    const ivs=[];
    for(const mm of rest.matchAll(new RegExp(RANGE_SRC,"gi"))){
      const o=parseTime(mm[1]),c=parseTime(mm[2]);
      if(o===0&&c===0)return null; // «00:00-00:00» — то ли круглосуточно, то ли закрыто
      const iv=interval(o,c);if(!iv)return null;ivs.push(iv);
    }
    for(const d of ds)week[d]=[...(week[d]||[]),...ivs];
    any=true;
  }
  if(!any)return null;
  for(let i=0;i<7;i++)if(week[i]===null)week[i]=[];
  return weekToOsm(week);
}
// Сущность schema.org → строка opening_hours (или null).
export function hoursToOsm(e){
  if(!e)return null;
  let v=null;
  if(e.openingHoursSpecification&&e.openingHoursSpecification.length)v=fromSpec(e.openingHoursSpecification);
  if(!v&&e.openingHours&&[].concat(e.openingHours).length)v=fromStrings(e.openingHours);
  return v&&validOpeningHours(v)?v:null;
}
// Проверка того подмножества синтаксиса OSM, которое мы пишем.
const T=String.raw`(?:[01]\d|2[0-3]):[0-5]\d`,TE=String.raw`(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)`;
const DS=String.raw`(?:Mo|Tu|We|Th|Fr|Sa|Su)`;
const RULE_RE=new RegExp(String.raw`^(?:${DS}(?:-${DS})?(?:,${DS}(?:-${DS})?)*\s)?(?:${T}-${TE}(?:,${T}-${TE})*|off)$`);
export function validOpeningHours(s){
  if(typeof s!=="string"||!s||s.length>255)return false;
  if(s==="24/7")return true;
  const rules=s.split("; ");
  for(const r of rules){
    if(!RULE_RE.test(r))return false;
    for(const m of r.matchAll(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/g)){if(m[1]+m[2]===m[3]+m[4])return false}
  }
  return true;
}

// ---------- цена ----------
// «$$» → 2; «AED 100-200» на человека → по середине: <60 → 1, 60–150 → 2, 150–350 → 3, >350 → 4.
const RATE={aed:1,"د.إ":1,dhs:1,dh:1,"$":3.67,usd:3.67,"€":4,eur:4,"£":4.65,gbp:4.65};
export function priceLevel(pr,{lodging=false}={}){
  if(pr==null)return null;
  const s=String(pr).trim();if(!s)return null;
  const sym=s.match(/^(?:\s*(?:\$|€|£|AED|د\.إ)\s*)+(?:\s*[-–]\s*(?:\s*(?:\$|€|£|AED|د\.إ)\s*)+)?$/i);
  if(sym&&!/\d/.test(s)){
    const groups=s.split(/\s*[-–]\s*/).map(g=>(g.match(/\$|€|£|AED|د\.إ/gi)||[]).length).filter(Boolean);
    if(!groups.length)return null;
    const avg=groups.reduce((a,b)=>a+b,0)/groups.length;
    return Math.min(4,Math.max(1,Math.round(avg)));
  }
  const low=s.toLowerCase();
  if(/^(?:inexpensive|cheap|budget|low)$/.test(low))return 1;
  if(/^(?:moderate|mid-?range|medium|affordable)$/.test(low))return 2;
  if(/^(?:expensive|upscale|high)$/.test(low))return 3;
  if(/^(?:very expensive|luxury|fine dining)$/.test(low))return 4;
  if(lodging)return null; // цена номера за ночь — не «чек на человека»
  const cur=low.match(/aed|د\.إ|dhs?\b|usd|\$|€|eur|£|gbp/);
  if(!cur)return null;
  let per=1,txt=low;
  if(/\b(?:for (?:two|2)|2 (?:people|persons|pax)|two (?:people|persons))\b/.test(txt)){per=2;txt=txt.replace(/\b(?:for (?:two|2)|2 (?:people|persons|pax)|two (?:people|persons))\b/g," ")}
  const nums=[...txt.replace(/,(?=\d{3}\b)/g,"").matchAll(/\d+(?:\.\d+)?/g)].map(m=>+m[0]).filter(n=>n>0&&n<100000);
  if(!nums.length||nums.length>2)return null;
  const rate=RATE[cur[0]]||1;
  const mid=(nums.length===2?(nums[0]+nums[1])/2:nums[0])*rate/per;
  if(/under|below|less than|up to/.test(low)&&nums.length===1)return mid<=60?1:mid<=150?2:mid<=350?3:4;
  return mid<60?1:mid<=150?2:mid<=350?3:4;
}

// ---------- кухня ----------
const CUISINE_SYN={"middle eastern":"middle_eastern","middle-eastern":"middle_eastern",arabic:"arab",arabian:"arab",arab:"arab",levantine:"lebanese",
  "pan asian":"asian","pan-asian":"asian",asian:"asian","south indian":"indian","north indian":"indian",burgers:"burger",burger:"burger",
  "steak house":"steak_house",steakhouse:"steak_house",steaks:"steak_house",steak:"steak_house",bbq:"barbecue",barbeque:"barbecue",barbecue:"barbecue",grill:"grill",grills:"grill",
  "sea food":"seafood",seafood:"seafood",fish:"fish",sushi:"sushi",pizza:"pizza",pizzas:"pizza",pasta:"pasta",coffee:"coffee_shop","coffee shop":"coffee_shop",
  desserts:"dessert",dessert:"dessert","ice cream":"ice_cream",gelato:"ice_cream",sandwiches:"sandwich",sandwich:"sandwich",noodles:"noodle",noodle:"noodle",ramen:"ramen",
  "fried chicken":"chicken",chicken:"chicken",wings:"wings",shawarma:"shawarma",kebab:"kebab",kebabs:"kebab",falafel:"falafel",tapas:"tapas",dim_sum:"dim_sum","dim sum":"dim_sum",
  breakfast:"breakfast",brunch:"brunch",healthy:"healthy",salads:"salad",salad:"salad",juice:"juice",juices:"juice",tea:"tea",bubble_tea:"bubble_tea","bubble tea":"bubble_tea",
  donuts:"donut",donut:"donut",doughnuts:"donut",crepes:"crepe",crepe:"crepe",waffles:"waffle",cake:"cake",cakes:"cake",bagels:"bagel",bagel:"bagel",hot_dog:"hot_dog","hot dogs":"hot_dog",
  "tex mex":"tex-mex","tex-mex":"tex-mex",fusion:"fusion",international:"international",european:"european","modern european":"european",
  "latin american":"latin_american",peruvian:"peruvian",brazilian:"brazilian",argentinian:"argentinian",argentine:"argentinian",mexican:"mexican",american:"american",
  italian:"italian",french:"french",greek:"greek",spanish:"spanish",portuguese:"portuguese",german:"german",british:"british",english:"british",irish:"irish",russian:"russian",
  georgian:"georgian",ukrainian:"ukrainian",turkish:"turkish",persian:"persian",iranian:"persian",lebanese:"lebanese",syrian:"syrian",egyptian:"egyptian",moroccan:"moroccan",
  emirati:"emirati",yemeni:"yemeni",saudi:"saudi",iraqi:"iraqi",jordanian:"jordanian",palestinian:"palestinian",afghan:"afghan",
  indian:"indian",pakistani:"pakistani",bangladeshi:"bangladeshi","sri lankan":"sri_lankan",nepalese:"nepalese",nepali:"nepalese",kerala:"kerala",
  chinese:"chinese",cantonese:"cantonese",sichuan:"sichuan",szechuan:"sichuan",japanese:"japanese",korean:"korean",thai:"thai",vietnamese:"vietnamese",
  filipino:"filipino",indonesian:"indonesian",malaysian:"malaysian",singaporean:"singaporean",
  african:"african",ethiopian:"ethiopian",nigerian:"nigerian",mediterranean:"mediterranean",caribbean:"caribbean",hawaiian:"hawaiian",poke:"poke",
  vegetarian:null,vegan:null,halal:null,"fast food":null,"fast-food":null,cafe:null,restaurant:null,bakery:null,bar:null,food:null,"street food":null,dinner:null,lunch:null};
export function normCuisine(list){
  const out=[];
  for(const raw of [].concat(list||[])){
    for(let p of String(raw).split(/\s*(?:,|;|\/|&|\||\band\b)\s*/i)){
      p=p.toLowerCase().replace(/\s+/g," ").trim();
      if(!p)continue;
      let v=Object.prototype.hasOwnProperty.call(CUISINE_SYN,p)?CUISINE_SYN[p]:undefined;
      if(v===undefined){p=p.replace(/\b(?:cuisine|food|restaurant|style|dishes)\b/g," ").replace(/\s+/g," ").trim();if(!p)continue;v=Object.prototype.hasOwnProperty.call(CUISINE_SYN,p)?CUISINE_SYN[p]:undefined}
      if(v===undefined){
        const s=p.replace(/s$/,"");
        v=Object.prototype.hasOwnProperty.call(CUISINE_SYN,s)?CUISINE_SYN[s]:undefined;
      }
      if(v&&!out.includes(v))out.push(v);
    }
  }
  return out.length?out.slice(0,4).join(";"):null;
}

// ---------- сопоставление сущности и места ----------
const fold=(v)=>String(v||"").normalize("NFKD").replace(/[̀-ͯ]/g,"").toLowerCase();
const STOP=new Set("the and restaurant restaurants cafe coffee hotel hotels resort llc fze dubai uae branch by at of de la le el al".split(" "));
const toks=(s)=>fold(s).split(/[^a-z0-9]+/).filter(w=>w.length>=3&&!STOP.has(w));
const compact=(s)=>fold(s).replace(/[^a-z0-9]/g,"");
function placeNames(t){return [t["name:en"],t.name,t.brand,t.official_name,t["brand:en"]].filter(Boolean)}
export function nameSim(a,b){
  const ca=compact(a),cb=compact(b);
  if(!ca||!cb)return 0;
  if(ca===cb)return 1;
  // «Zuma» в «Zuma Dubai» — да; «Dubai» (город) в «Zuma Dubai» — нет.
  const short=ca.length<=cb.length?a:b;
  if(ca.length>=4&&cb.length>=4&&(ca.includes(cb)||cb.includes(ca))&&toks(short).length)return 0.9;
  const A=new Set(toks(a)),B=new Set(toks(b));
  if(!A.size||!B.size)return 0;
  let n=0;for(const w of A)if(B.has(w))n++;
  return n/Math.min(A.size,B.size)*(n?0.8:0);
}
function distM(a,b,c,d){const R=6371000,r=Math.PI/180,x=(d-b)*r*Math.cos((a+c)/2*r),y=(c-a)*r;return Math.sqrt(x*x+y*y)*R}
// Координаты-заглушки («центр Дубая» из шаблона сайта, 2 знака после точки) — как будто их нет.
const PLACEHOLDER=[[25.2048,55.2708],[25.276987,55.296249],[25.2048493,55.2707828],[25.0,55.0],[25.25,55.3]];
function realGeo(g){
  if(!g)return null;
  if(PLACEHOLDER.some(([a,b])=>Math.abs(g[0]-a)<0.0006&&Math.abs(g[1]-b)<0.0006))return null;
  if(String(g[0]).replace(/^-?\d+\.?/,"").length<=2&&String(g[1]).replace(/^-?\d+\.?/,"").length<=2)return null;
  return g;
}
const hasData=(e)=>!!(e.openingHours||e.openingHoursSpecification||e.priceRange||e.servesCuisine||e.menu);
function hostOf(u){try{return new URL(/^https?:/i.test(u)?u:"http://"+u).hostname.replace(/^www\d?\./,"").toLowerCase()}catch{return ""}}
function regDomain(h){const p=h.split(".");return p.length>=3&&p.at(-1).length===2&&["co","com","net","org","gov","ac","edu","sch"].includes(p.at(-2))?p.slice(-3).join("."):p.slice(-2).join(".")}
// Имя места видно в домене сайта (vicolodubai.com ↔ «Vicolo»).
export function nameMatchesSite(t,site){
  const host=hostOf(site);if(!host)return false;
  const hostC=compact(host),core=compact(host.split(".")[0]);
  for(const n of placeNames(t)){
    const c=compact(n);
    if(core.length>=4&&c.includes(core))return true;
    if(c.length>=4&&hostC.includes(c))return true;
    // слово имени в домене: длинное — где угодно, короткое — только с края («pita» не в «hospitals»)
    for(const w of toks(n))if((w.length>=5&&hostC.includes(w))||(w.length===4&&(core.startsWith(w)||core.endsWith(w))))return true;
  }
  return false;
}
// Отличительные слова филиала: имя места без слов бренда («Starbucks Emirates Towers» → emirates, towers).
// Слова бренда — из brand, имён сущностей сайта и самого домена.
function branchTokens(t,rec,brandName){
  const hostC=compact(hostOf((rec&&(rec.final_url||rec.site))||""));
  const brand=new Set([...toks(brandName||""),...toks(t.brand||"")]);
  for(const e of (rec&&rec.entities)||[])for(const w of toks(e.name||""))brand.add(w);
  const out=new Set();
  for(const n of placeNames(t))for(const w of toks(n))if(!brand.has(w)&&w.length>=4&&!hostC.includes(w))out.add(w);
  for(const w of toks(t["addr:street"]||""))if(w.length>=5&&!/^(street|road)$/.test(w)&&!brand.has(w))out.add(w);
  return [...out];
}
// Лучшая сущность сайта для места: {e, how:"geo"|"branch"|"name"|"single"} или null.
export function matchEntity(rec,t,{lat,lon,users}={}){
  const ents=(rec&&rec.entities||[]).filter(hasData);
  if(!ents.length)return null;
  const chain=(users??rec.n_places??1)>=3;
  const names=placeNames(t);
  const scored=[];
  const brandSite=nameMatchesSite(t,rec.final_url||rec.site)||nameMatchesSite(t,rec.site);
  const siteNames=new Set(ents.map(e=>compact(e.name||"")).filter(Boolean)).size;
  for(const e of ents){
    const sim=e.name?Math.max(0,...names.map(n=>nameSim(n,e.name))):0;
    const g=realGeo(e.geo);const d=(g&&lat!=null&&lon!=null)?distM(lat,lon,g[0],g[1]):null;
    if(d!=null&&d>3000)continue; // другое место
    if(chain){
      // Сеть: только тот же филиал — рядом по координатам или имя филиала в имени/адресе сущности.
      if(d!=null&&d<=300&&(sim>=0.5||!e.name||(d<=150&&brandSite))){scored.push({e,how:"geo",s:3-d/1000+((e.openingHours||e.openingHoursSpecification)?0.3:0)});continue}
      if(d==null&&sim>=0.5){
        const bt=branchTokens(t,rec,e.name);const hay=fold((e.name||"")+" "+(e.address||"")+" "+(e.url||""));
        if(bt.length&&bt.some(w=>hay.includes(w))){scored.push({e,how:"branch",s:2});continue}
      }
      continue;
    }
    // Рядом, но с другим именем — это может быть отель, в котором ресторан: не берём.
    const hb=(e.openingHours||e.openingHoursSpecification)?0.3:0;
    if(d!=null&&d<=500&&(sim>=0.5||(!e.name&&d<=150))){scored.push({e,how:"geo",s:3-d/1000+sim+hb});continue}
    if(sim>=0.5&&(d==null||d<=1500)){scored.push({e,how:"name",s:1+sim+hb});continue}
    // Сайт одного заведения с тем же именем, а точка на карте сдвинута (до 3 км).
    if(sim>=0.9&&siteNames<=1){scored.push({e,how:"name",s:0.8+hb});continue}
  }
  if(!scored.length&&!chain){
    // Одностраничный сайт одного заведения: одна сущность (без чужих имён) на домене сайта.
    const named=new Set(ents.map(e=>compact(e.name||"")).filter(Boolean));
    const siteDom=regDomain(hostOf(rec.final_url||rec.site));
    const e=ents[0];
    const eDom=regDomain(hostOf(e.url||e.id||e.src||""));
    const g=realGeo(e.geo);const d=(g&&lat!=null&&lon!=null)?distM(lat,lon,g[0],g[1]):null;
    if(named.size<=1&&ents.length<=2&&eDom===siteDom&&brandSite&&(d==null||d<=1000))scored.push({e,how:"single",s:0.5});
  }
  if(!scored.length)return null;
  scored.sort((a,b)=>b.s-a.s);
  // Совпало только по имени, а на сайте несколько филиалов с этим именем и разными часами — не угадываем.
  const top=scored[0];
  if(top.how==="name"){
    const rivals=scored.filter(x=>x.how==="name"&&x.e!==top.e&&(compact(x.e.name||"")!==compact(top.e.name||"")||(realGeo(x.e.geo)&&realGeo(top.e.geo)&&distM(...realGeo(x.e.geo),...realGeo(top.e.geo))>200)));
    if(rivals.some(x=>hoursToOsm(x.e)!==hoursToOsm(top.e)))return null;
  }
  return top;
}
// Все сущности того же заведения (одно и то же место бывает описано дважды: Restaurant + openingHoursSpecification).
function sameVenue(rec,best){
  const b=best.e,out=[b],bn=compact(b.name||"");
  for(const e of (rec.entities||[]).filter(hasData)){
    if(e===b||e.src!==b.src)continue;
    if(e.name&&compact(e.name)!==bn)continue;
    const eg=realGeo(e.geo),bg=realGeo(b.geo);
    if(eg&&bg&&distM(eg[0],eg[1],bg[0],bg[1])>100)continue;
    if(!eg&&!bg&&!e.name)continue;
    out.push(e);
  }
  return out;
}
// ---------- бронь и меню ----------
// Ссылка про это место: в ней имя места, а у сети — имя филиала (в пути, не в домене бренда).
function urlHasName(url,t,rec,brandName,chain){
  let path=String(url);
  try{const u=new URL(url);path=u.pathname+" "+u.search;if(!chain)path=u.hostname+" "+path}catch{}
  try{path=decodeURIComponent(path)}catch{}
  const u=compact(path);
  const bt=branchTokens(t,rec,brandName);
  if(chain)return bt.length>0&&bt.some(w=>u.includes(w));
  for(const n of placeNames(t)){const c=compact(n);if(c.length>=5&&u.includes(c))return true}
  return bt.some(w=>w.length>=5&&u.includes(w));
}
function bookingKey(url){
  try{const u=new URL(url);return (u.hostname.replace(/^www\./,"")+u.pathname.replace(/\/+$/,"")+(u.searchParams.get("rid")||u.searchParams.get("venue")||"")).toLowerCase()}catch{return url}
}
// Своя страница брони: в пути «book/reserv/appointment», и это не контакты, не «узнать цену»,
// не «найти мою бронь» и не главная.
const WEB_BOOK=/(?:reserv|book|appointment|appoint|schedule|ticket)/i;
const WEB_NOT=/(?:contact|about|location|quote|enquir|inquir|lookup|look-up|manage|cancel|modify|login|signin|account|career|blog|news|faq|terms|privacy|policy|gift|voucher|facebook|instagram)/i;
export function websiteBookingOk(url){
  let u;try{u=new URL(url)}catch{return false}
  let p=u.pathname+u.search;try{p=decodeURIComponent(p)}catch{}
  if(u.pathname==="/"||!u.pathname)return false;
  return WEB_BOOK.test(p)&&!WEB_NOT.test(p);
}
export function pickBooking(rec,t,match,{users}={}){
  const chain=(users??rec.n_places??1)>=3;
  const c=(rec.booking||[]).filter(b=>b&&b.url&&b.specific&&PROVIDERS.includes(b.provider));
  if(!c.length)return null;
  const third=[],seen=new Set();
  for(const b of c){
    if(b.provider==="Website")continue;
    const p=detectProvider(b.url);if(!p||!p.specific||p.provider!==b.provider)continue;
    const k=bookingKey(b.url);if(seen.has(k))continue;seen.add(k);third.push(b);
  }
  const brand=match&&match.e&&match.e.name;
  const branchOk=(b)=>urlHasName(b.url,t,rec,brand,chain)||(match&&(match.how==="geo"||match.how==="branch")&&b.src===match.e.src);
  if(chain){
    const ok=third.filter(branchOk);if(ok.length)return ok[0];
    const web=c.filter(b=>b.provider==="Website"&&websiteBookingOk(b.url)&&urlHasName(b.url,t,rec,brand,chain));
    return web[0]||null;
  }
  if(third.length){
    const named=third.filter(b=>urlHasName(b.url,t,rec,brand,chain));
    if(named.length)return named[0];
    if(third.length===1)return third[0];
    // Несколько разных заведений на сайте группы, имени нет ни в одной — не угадываем.
    if(match&&match.how!=="single"){const same=third.filter(b=>b.src===match.e.src);if(same.length===1)return same[0]}
    return null;
  }
  const venueSite=nameMatchesSite(t,rec.site)||nameMatchesSite(t,rec.final_url||"")||(match&&(match.how==="geo"||match.how==="name"));
  if(!venueSite)return null;
  const web=c.filter(b=>b.provider==="Website"&&websiteBookingOk(b.url));
  return web[0]||null;
}
// Меню — у еды и напитков (и «меню процедур» у спа/салонов); у магазина или клиники это не меню.
export const MENU_PLACE=(t)=>/^(?:restaurant|cafe|bar|pub|fast_food|food_court|ice_cream|nightclub|hookah_lounge|biergarten|juice_bar)$/.test(t.amenity||"")||
  /^(?:bakery|confectionery|pastry|coffee|tea|deli|chocolate|beauty|massage)$/.test(t.shop||"")||/^(?:spa|sauna)$/.test(t.leisure||"")||
  /^(?:food|coffee|bar|pastry|bakery|spa|club|hookah|nightlife|massage|beauty)$/.test(t["free:category"]||"");
export function pickMenu(rec,t,match,{users,chainMenu=false}={}){
  if(!MENU_PLACE(t))return null;
  const chain=(users??rec.n_places??1)>=3;
  const brand=match&&match.e&&match.e.name;
  const strong=match&&(match.how==="geo"||match.how==="branch");
  const list=[];
  if(match)for(const u of match.e.menu||[])list.push({url:u,kind:/\.pdf(\?|$)/i.test(u)?"pdf":"page",same:true,how:"jsonld",src:match.e.src});
  for(const m of rec.menu||[])list.push(m);
  const ok=list.filter(m=>m&&/^https?:\/\//i.test(m.url)&&!/\.(?:jpe?g|png|gif|webp|svg|json|js|css|xml|txt|zip)(\?|$)/i.test(m.url));
  if(!ok.length)return null;
  const rank=(m)=>(m.how==="jsonld"?0:m.kind==="pdf"&&m.same!==false?1:m.same!==false?2:3);
  ok.sort((a,b)=>rank(a)-rank(b));
  if(chain){
    const br=ok.find(m=>urlHasName(m.url,t,rec,brand,chain)||(strong&&m.src===match.e.src&&m.how==="jsonld"));
    if(br)return br.url;
    // Меню бренда одно на все филиалы — только по явному разрешению и если сайт — сайт этого бренда.
    if(chainMenu&&nameMatchesSite(t,rec.final_url||rec.site)){const u=new Set(ok.map(m=>m.url.replace(/[#?].*$/,"")));if(u.size===1)return ok[0].url}
    return null;
  }
  const venueSite=nameMatchesSite(t,rec.site)||nameMatchesSite(t,rec.final_url||"")||(match&&match.how!=="single");
  const named=ok.find(m=>urlHasName(m.url,t,rec,brand,chain));
  if(named)return named.url;
  if(!venueSite)return null;
  // На сайте несколько разных заведений и наше не опознано — меню может быть чужим.
  const venues=new Set((rec.entities||[]).filter(hasData).map(e=>compact(e.name||"")).filter(Boolean));
  if(venues.size>=2&&!match)return null;
  return ok[0].url;
}

const LODGING=/^(?:hotel|hostel|motel|guest_house|apartment|chalet|resort)$/;
// Главное: дописать теги места по записи сайта. opts: {lat, lon, users (сколько мест с этим сайтом), chainMenu}.
// Возвращает список записанных тегов.
export function applySiteMeta(tags,rec,opts={}){
  if(!tags||!rec||!rec.ok)return [];
  // Сначала считаем всё в сторонке: ошибка в чужих данных не должна ломать сборку карты.
  let out;
  try{out=computeSiteTags(tags,rec,opts)}catch{return []}
  for(const [k,v] of Object.entries(out.tags))tags[k]=v;
  return out.wrote;
}
function computeSiteTags(tags,rec,opts){
  const wrote=[],add={};
  const o={...opts,users:opts.users??rec.n_places??1};
  const best=matchEntity(rec,tags,o);
  const chain=o.users>=3;
  const ents=best?sameVenue(rec,best):[];
  // Часы: только у опознанного заведения; у сети — только этого филиала. Часы из OSM не трогаем.
  if(best&&!tags.opening_hours&&(!chain||best.how==="geo"||best.how==="branch")){
    // Одно и то же заведение описано на сайте дважды с разными часами — не выбираем.
    const all=new Set(ents.map(hoursToOsm).filter(Boolean));
    const oh=all.size===1?[...all][0]:null;
    if(oh){add.opening_hours=oh;add["source:opening_hours"]="website";wrote.push("opening_hours")}
  }
  if(best&&!tags["free:price"]){
    const lodging=LODGING.test(tags.tourism||"");
    let p=null;for(const e of ents){p=priceLevel(e.priceRange,{lodging});if(p)break}
    if(p){add["free:price"]=String(p);add["free:price_src"]="site";wrote.push("free:price")}
  }
  if(best&&!tags.cuisine){
    let c=null;for(const e of ents){c=normCuisine(e.servesCuisine);if(c)break}
    if(c){add.cuisine=c;wrote.push("cuisine")}
  }
  if(!tags["free:booking_url"]){
    const b=pickBooking(rec,tags,best,o);
    if(b){add["free:booking_url"]=b.url;add["free:booking_provider"]=b.provider;wrote.push("free:booking_url")}
  }
  if(!tags["free:menu"]){
    const m=pickMenu(rec,tags,best,o);
    if(m){add["free:menu"]=m;wrote.push("free:menu")}
  }
  return {tags:add,wrote};
}
