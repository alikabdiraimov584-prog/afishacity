#!/usr/bin/env node
// Сбор афиши Дубая из открытых структурированных источников → data/events_dubai.json.
//
//   node --no-warnings scripts/dubai_events/harvest.mjs
//   node ... harvest.mjs --out /tmp/events.json --days 90 --sources visitdubai,district,dubaiopera
//
// Источники (всё — то, что сайты сами публикуют для машин):
//   visitdubai — XML-лента календаря Visit Dubai (DET): https://www.visitdubai.com/events-en.xml,
//                указана в их robots.txt как Sitemap. Даты, площадка, координаты, ссылка на билеты.
//   district   — билетная система District (district.ae): sitemap событий из robots.txt →
//                страницы событий → schema.org Event (JSON-LD): время, цена «от», координаты.
//   dubaiopera — Dubai Opera: sitemap /sitemap/events → JSON-LD Event + расписание показов.
// Не используются: Platinumlist и Coca-Cola Arena (все страницы за очередью Queue-it,
// без браузера не открываются), Ticketmaster и Time Out (403 для ботов), Eventbrite
// (условия сайта запрещают автоматический сбор).
//
// Вежливость: свой User-Agent, robots.txt проверяется для каждого адреса,
// не больше 6 запросов одновременно и не больше 3 на один сайт, пауза между
// запросами к одному сайту, таймаут и два повтора. Длинные описания не
// сохраняются — только факты и короткий анонс (≤ 200 знаков), если он есть.
//
// Файл пишется атомарно (временный файл → rename): сервер перечитывает его по
// изменению и никогда не видит половину.
import {writeFileSync,renameSync,mkdirSync,existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {CITIES} from "../../city.mjs";
import {
  UA,text,norm,addDays,dubaiToday,daysBetween,inDubai,areaFor,OTHER_EMIRATE,NOT_EVENT_RE,
  jsonLdEvents,normalizeJsonLdEvent,parseVisitDubaiXml,normalizeVisitDubai,
  dubaiOperaSchedules,dubaiOperaCategory,districtMeta,dedupeEvents,affiliateUrl,EVENT_TAGS
} from "./normalize.mjs";

const ROOT=fileURLToPath(new URL("../..",import.meta.url));
const args=new Map();
for(let i=2;i<process.argv.length;i++){
  const a=process.argv[i];
  if(!a.startsWith("--"))continue;
  const eq=a.indexOf("=");
  if(eq>0)args.set(a.slice(2,eq),a.slice(eq+1));
  else args.set(a.slice(2),process.argv[i+1]&&!process.argv[i+1].startsWith("--")?process.argv[++i]:"1");
}
const OUT=args.get("out")||process.env.EVENTS_DUBAI_FILE||join(ROOT,"data","events_dubai.json");
const DAYS=Number(args.get("days")||90);
const SOURCES=String(args.get("sources")||"visitdubai,district,dubaiopera").split(",").map(s=>s.trim()).filter(Boolean);
const MAP_DB=args.get("map")||process.env.OSM_SNAPSHOT||join(ROOT,"data","osm_dubai.db");
const MAX_PAGES=Number(args.get("max-pages")||400);
const TIMEOUT_MS=Number(args.get("timeout")||20000);
const CONCURRENCY=Math.min(6,Number(args.get("concurrency")||6));
const PER_HOST=3;
const HOST_GAP_MS=Number(args.get("gap")||250);
const QUIET=args.get("quiet")==="1";
const log=(...a)=>{if(!QUIET)console.log(...a)};

// ---- Сеть: таймаут, повторы, ограничение параллельности --------------------
let active=0;const waiters=[];
const hostActive=new Map(),hostLast=new Map();
async function slot(host){
  for(;;){
    if(active<CONCURRENCY&&(hostActive.get(host)||0)<PER_HOST)break;
    await new Promise(r=>waiters.push(r));
  }
  active++;hostActive.set(host,(hostActive.get(host)||0)+1);
  const wait=(hostLast.get(host)||0)+HOST_GAP_MS-Date.now();
  hostLast.set(host,Math.max(Date.now(),(hostLast.get(host)||0)+HOST_GAP_MS));
  if(wait>0)await new Promise(r=>setTimeout(r,wait));
}
function release(host){
  active--;hostActive.set(host,(hostActive.get(host)||1)-1);
  const w=waiters.splice(0);w.forEach(r=>r());
}
const stats={requests:0,failed:0,blocked_by_robots:0};
async function get(url,{tries=3}={}){
  const host=new URL(url).hostname;
  if(!(await robotsAllowed(url))){stats.blocked_by_robots++;throw new Error(`robots.txt запрещает ${url}`)}
  let last=null;
  for(let i=0;i<tries;i++){
    await slot(host);
    try{
      stats.requests++;
      const r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"text/html,application/xml,application/xhtml+xml,*/*;q=0.8","Accept-Language":"en"},
        redirect:"follow",signal:AbortSignal.timeout(TIMEOUT_MS)});
      // Очередь Queue-it/капча — это не страница события.
      if(/queue-it\.net|queue\.platinumlist/.test(r.url))throw Object.assign(new Error(`очередь Queue-it на ${host}`),{fatal:true});
      if(r.status===404||r.status===410)throw Object.assign(new Error(`${r.status} ${url}`),{fatal:true});
      if(!r.ok)throw new Error(`${r.status} ${url}`);
      return await r.text();
    }catch(e){
      last=e;if(e.fatal)break;
      await new Promise(r=>setTimeout(r,800*(i+1)));
    }finally{release(host)}
  }
  stats.failed++;
  throw last||new Error(`не загрузилось: ${url}`);
}

// ---- robots.txt --------------------------------------------------------------
const robotsCache=new Map();
function parseRobots(txt){
  // Группы для «*» и для нашего агента; наш (если есть) важнее.
  const groups=[];let cur=null,lastWasAgent=false;
  for(const raw of String(txt).split(/\r?\n/)){
    const line=raw.replace(/#.*$/,"").trim();if(!line)continue;
    const m=/^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);if(!m)continue;
    const k=m[1].toLowerCase(),v=m[2].trim();
    if(k==="user-agent"){
      if(!lastWasAgent||!cur){cur={agents:[],rules:[]};groups.push(cur)}
      cur.agents.push(v.toLowerCase());lastWasAgent=true;continue;
    }
    lastWasAgent=false;
    if(!cur)continue;
    if(k==="allow"||k==="disallow")cur.rules.push({allow:k==="allow",path:v});
  }
  const mine=groups.filter(g=>g.agents.some(a=>/^free(-dubai)?(\/|$)/.test(a)));
  const pick=mine.length?mine:groups.filter(g=>g.agents.includes("*"));
  return pick.flatMap(g=>g.rules).filter(r=>r.path!==""||!r.allow);
}
function ruleMatch(rule,path){
  if(rule.path==="")return false;                   // «Disallow:» пустой — разрешено всё
  const re=new RegExp("^"+rule.path.replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*").replace(/\\\$$/,"$"));
  return re.test(path);
}
export function robotsDecision(rules,path){
  let best=null;
  for(const r of rules)if(ruleMatch(r,path)&&(!best||r.path.length>best.path.length||(r.path.length===best.path.length&&r.allow)))best=r;
  return best?best.allow:true;
}
async function robotsAllowed(url){
  const u=new URL(url);
  if(u.pathname==="/robots.txt")return true;
  const key=u.origin;
  if(!robotsCache.has(key)){
    robotsCache.set(key,(async()=>{
      try{
        const r=await fetch(`${key}/robots.txt`,{headers:{"User-Agent":UA},signal:AbortSignal.timeout(TIMEOUT_MS)});
        if(r.status>=400&&r.status<500)return [];   // нет robots.txt — ограничений нет
        if(!r.ok)return [{allow:false,path:"/"}];    // сайт болеет — не лезем
        return parseRobots(await r.text());
      }catch{return [{allow:false,path:"/"}]}
    })());
  }
  return robotsDecision(await robotsCache.get(key),u.pathname+u.search);
}

async function pool(items,fn){
  const out=new Array(items.length);let i=0;
  const workers=Array.from({length:Math.min(CONCURRENCY,items.length)},async()=>{
    while(i<items.length){const k=i++;try{out[k]=await fn(items[k],k)}catch(e){out[k]={__error:e.message}}}
  });
  await Promise.all(workers);
  return out;
}
function sitemapLocs(xml){return [...text(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m=>m[1].replace(/&amp;/g,"&"))}

// ---- Источники -----------------------------------------------------------------
async function harvestVisitDubai(){
  const xml=await get("https://www.visitdubai.com/events-en.xml");
  const rows=parseVisitDubaiXml(xml);
  const out=[];
  for(const f of rows){
    const e=normalizeVisitDubai(f);
    if(!e)continue;
    out.push({...e,id:`evt:visitdubai:${e.source_id}`,source_key:"visitdubai"});
  }
  return {items:out,seen:rows.length};
}

async function harvestDistrict(){
  const index=await get("https://cdn.district.in/sitemap/ae/sitemap-events.xml");
  const maps=sitemapLocs(index).filter(u=>/event-detail/.test(u));
  const pages=[];
  for(const m of maps)pages.push(...sitemapLocs(await get(m)));
  // Уже по адресу видно, что это не событие (билет «на любой день», сет-меню)
  // или что это не Дубай: такие страницы не открываем вовсе.
  const want=[...new Set(pages)].filter(u=>/^https:\/\/www\.district\.ae\/events\//.test(u))
    .filter(u=>{const slug=decodeURIComponent(u.split("/events/")[1]||"").replace(/-buy-tickets\/?$/,"").replace(/-/g," ");
      return !NOT_EVENT_RE.test(slug)&&!OTHER_EMIRATE.test(slug)})
    .slice(0,MAX_PAGES);
  const res=await pool(want,async(url)=>{
    const html=await get(url);
    const meta=districtMeta(html);
    if(meta.city&&!/^dubai$/i.test(meta.city))return {skip:"city"};
    const evs=jsonLdEvents(html);
    // На странице District каждый сеанс — отдельный Event (10:00, 10:30, …;
    // суббота, воскресенье). Это одно событие с расписанием, а не десять.
    // Рубрику District не передаём: она ненадёжна (см. normalize.mjs).
    const recs=evs.map(ev=>normalizeJsonLdEvent(ev,{pageUrl:url,extra:text(ev.description).slice(0,600)})).filter(Boolean);
    if(!recs.length)return {items:[]};
    const slug=(url.split("/events/")[1]||"").replace(/-buy-tickets\/?$/,"");
    const byName=new Map();
    for(const r of recs){const k=norm(r.name)+"|"+norm(r.venue);if(!byName.has(k))byName.set(k,[]);byName.get(k).push(r)}
    const out=[];let n=0;
    for(const group of byName.values()){
      const sessions=[...new Map(group.map(r=>[`${r.date_start} ${r.time||""}`,{date:r.date_start,time:r.time||null}])).values()]
        .sort((a,b)=>(a.date+(a.time||"")).localeCompare(b.date+(b.time||"")));
      const first=group[0];
      const prices=group.map(r=>r.price_min).filter(v=>v!==null&&v!==undefined);
      const pos=prices.filter(v=>v>0),pmin=pos.length?Math.min(...pos):prices.length?0:null;
      const rec={...first,date_start:sessions[0].date,date_end:group.reduce((m,r)=>r.date_end>m?r.date_end:m,sessions[sessions.length-1].date),
        time:sessions[0].time,price_min:pmin,price:pmin===null?null:pmin===0?"Free":`from ${Math.round(pmin).toLocaleString("en-US")} AED`,
        ...(sessions.length>1?{dates:sessions.slice(0,40)}:{}),
        id:`evt:district:${slug.slice(0,90)}${n?`:${n}`:""}`,source_key:"district"};
      out.push(rec);n++;
    }
    return {items:out};
  });
  const items=res.flatMap(r=>r&&r.items||[]);
  const errors=res.filter(r=>r&&r.__error).map(r=>r.__error);
  return {items,seen:want.length,errors,skipped_city:res.filter(r=>r&&r.skip==="city").length};
}

async function harvestDubaiOpera(){
  const xml=await get("https://www.dubaiopera.com/sitemap/events");
  const pages=sitemapLocs(xml).filter(u=>/\/en\/events\/[^/]+\/[^/]+\/?$/.test(u)).slice(0,MAX_PAGES);
  const res=await pool(pages,async(url)=>{
    const html=await get(url);
    const evs=jsonLdEvents(html);
    const schedules=dubaiOperaSchedules(html);
    const out=[];
    for(const ev of evs.slice(0,1)){
      const e=normalizeJsonLdEvent(ev,{pageUrl:url,sourceCategory:dubaiOperaCategory(url),schedules});
      if(!e)continue;
      const slug=url.replace(/\/$/,"").split("/").pop();
      out.push({...e,venue:e.venue||"Dubai Opera",id:`evt:dubaiopera:${slug}`,source_key:"dubaiopera"});
    }
    return {items:out};
  });
  return {items:res.flatMap(r=>r&&r.items||[]),seen:pages.length,errors:res.filter(r=>r&&r.__error).map(r=>r.__error)};
}

const HARVESTERS={visitdubai:harvestVisitDubai,district:harvestDistrict,dubaiopera:harvestDubaiOpera};

// ---- Координаты площадок по карте города --------------------------------------
async function venueMatcher(){
  if(!existsSync(MAP_DB))return null;
  try{
    const {DatabaseSync}=await import("node:sqlite");
    const db=new DatabaseSync(MAP_DB,{readOnly:true});
    const q=db.prepare("select p.name,p.lat,p.lon from place_fts f join place p on p.pid=f.pid where place_fts match ? limit 12");
    const cache=new Map();
    const look=(name)=>{
      const words=norm(name).split(" ").filter(w=>w.length>1&&!/^(the|at|of|and|dubai|uae|hotel|by)$/.test(w)).slice(0,5);
      if(!words.length)return null;
      const key=words.join(" ");
      if(cache.has(key))return cache.get(key);
      let hit=null;
      try{
        const rows=q.all(words.map(w=>`"${w}"`).join(" "));
        // Лучшее — самое короткое название, где есть все слова: «Zabeel Park»,
        // а не «Zabeel Park Jogging Track».
        const ok=rows.filter(r=>inDubai({lat:r.lat,lon:r.lon})).sort((a,b)=>a.name.length-b.name.length);
        if(ok.length)hit={lat:Math.round(ok[0].lat*1e6)/1e6,lon:Math.round(ok[0].lon*1e6)/1e6,matched:ok[0].name};
      }catch{hit=null}
      cache.set(key,hit);
      return hit;
    };
    return (venue)=>{
      // «New Covent Garden Theatre, Mall of the Emirates»: сперва площадка
      // целиком, потом каждая часть адреса.
      const parts=[venue,...String(venue||"").split(/,| at | - /i)].map(s=>s.trim()).filter(Boolean);
      for(const p of parts){const h=look(p);if(h)return h}
      return null;
    };
  }catch(e){log(`карта ${MAP_DB} недоступна: ${e.message}`);return null}
}

// ---- Сборка --------------------------------------------------------------------
async function main(){
  const t0=Date.now();
  const today=dubaiToday(),horizon=addDays(today,DAYS);
  const fetched_at=new Date().toISOString();
  const per={},all=[];
  for(const name of SOURCES){
    const fn=HARVESTERS[name];
    if(!fn){log(`неизвестный источник: ${name}`);continue}
    const t=Date.now();
    try{
      const r=await fn();
      per[name]={ok:true,raw:r.items.length,pages:r.seen,errors:(r.errors||[]).length,ms:Date.now()-t,...(r.skipped_city?{skipped_other_city:r.skipped_city}:{})};
      if((r.errors||[]).length)per[name].first_error=r.errors[0];
      all.push(...r.items);
    }catch(e){per[name]={ok:false,error:e.message,ms:Date.now()-t}}
    log(`${name}: ${JSON.stringify(per[name])}`);
  }
  const match=await venueMatcher();
  const districts=CITIES.dubai.districts||[];
  const kept=[];
  const drop={past:0,beyond:0,long_running:0,not_event:0,outside_dubai:0};
  for(const e of all){
    if(e.date_end<today){drop.past++;continue}
    if(e.date_start>horizon){drop.beyond++;continue}
    // Постоянное («каждые выходные до мая») — не событие с датой: на любой
    // запрос «в эти выходные» оно отвечало бы одним и тем же.
    if(daysBetween(e.date_start,e.date_end)>120){drop.long_running++;continue}
    if(NOT_EVENT_RE.test(norm(e.name))){drop.not_event++;continue}
    const addr=[e.venue,e.address].join(" ");
    if(OTHER_EMIRATE.test(addr)&&!/\bdubai\b/i.test(e.venue||"")){drop.outside_dubai++;continue}
    if(e.coords&&!inDubai(e.coords)){drop.outside_dubai++;continue}
    if(!e.coords&&match&&e.venue){const h=match(e.venue);if(h){e.coords={lat:h.lat,lon:h.lon};e.coords_from="map"}}
    kept.push(e);
  }
  const uniq=dedupeEvents(kept);
  const out=uniq.map(e=>{
    const area=areaFor(e.coords,districts)||(e.address?String(e.address).split(",").map(s=>s.trim()).filter(s=>s&&!/^(dubai|united arab emirates|uae)$/i.test(s)).slice(-1)[0]||null:null)||"Dubai";
    const booking=affiliateUrl(e.ticket_url||e.booking_url)||e.booking_url||e.source;
    return {
      id:e.id,kind:"event",name:e.name,category:e.category,cat_tags:(e.cat_tags||[]).filter(t=>EVENT_TAGS.includes(t)),
      ...(e.business?{business:true}:{}),...(e.experience?{experience:true}:{}),
      date_start:e.date_start,date_end:e.date_end,time:e.time||null,
      ...(e.dates&&e.dates.length?{dates:e.dates.slice(0,40)}:{}),
      venue:e.venue||null,area,coords:e.coords||null,
      price:e.price||null,price_min:e.price_min??null,
      booking_url:booking,ticket_url:e.ticket_url||null,booking_kind:"tickets",booking_provider:e.booking_provider||null,
      image_url:e.image_url||null,summary:e.summary||null,
      source:e.source,...(e.also&&e.also.length?{also:e.also.slice(0,4)}:{}),
      provider:"dubai_events",fetched_at
    };
  }).sort((a,b)=>(a.date_start+(a.time||"99")).localeCompare(b.date_start+(b.time||"99"))||a.name.localeCompare(b.name));

  // Пустой результат при живом прошлом файле — сбой источников, а не «событий
  // нет»: старый файл не затираем.
  const okSources=Object.values(per).filter(x=>x.ok).length;
  if(!out.length){
    console.error(`события не собраны (${JSON.stringify(per)}) — прежний файл ${OUT} не тронут`);
    process.exitCode=1;return;
  }
  mkdirSync(dirname(OUT),{recursive:true});
  const tmp=`${OUT}.tmp-${process.pid}`;
  writeFileSync(tmp,JSON.stringify(out,null,0).replace(/\},\{"id"/g,'},\n{"id"'));
  renameSync(tmp,OUT);

  const byTag={};for(const e of out)for(const t of e.cat_tags.length?e.cat_tags:["(none)"])byTag[t]=(byTag[t]||0)+1;
  const byCat={};for(const e of out)byCat[e.category]=(byCat[e.category]||0)+1;
  const win=(d)=>out.filter(e=>e.date_start<=addDays(today,d)).length;
  const pct=(f)=>Math.round(100*out.filter(f).length/out.length);
  const summary={file:OUT,total:out.length,raw:all.length,dropped:drop,merged_duplicates:kept.length-out.length,
    next30:win(30),next60:win(60),next90:win(90),
    with_coords:`${pct(e=>e.coords)}%`,with_price:`${pct(e=>e.price_min!==null)}%`,with_time:`${pct(e=>e.time)}%`,
    with_ticket_url:`${pct(e=>e.ticket_url)}%`,with_image:`${pct(e=>e.image_url)}%`,
    business:out.filter(e=>e.business).length,by_category:byCat,by_cat_tag:byTag,sources:per,
    sources_ok:`${okSources}/${SOURCES.length}`,http:stats,seconds:Math.round((Date.now()-t0)/1000)};
  console.log(JSON.stringify(summary,null,1));
}

if(import.meta.url===`file://${process.argv[1]}`)main().catch(e=>{console.error(e);process.exitCode=1});
