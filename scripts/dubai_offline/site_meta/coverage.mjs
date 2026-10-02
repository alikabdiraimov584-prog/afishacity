// Сколько мест карты получат данные с сайтов: прогон applySiteMeta по всей базе
// (только чтение) + выборки для ручной проверки часов и ссылок брони.
//   node coverage.mjs <osm_dubai.db> <site_meta.jsonl> <site_check.json> <out.txt> <samples.json>
import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {loadSiteMeta,applySiteMeta,siteKey,matchEntity,hoursToOsm,parseTime} from "./apply_site_meta.mjs";
import {parseSchedule} from "../../../hours.mjs";

const [,,DB,META,CHECK,OUT,SAMPLES]=process.argv;
const meta=loadSiteMeta(META);
const check=fs.existsSync(CHECK)?JSON.parse(fs.readFileSync(CHECK,"utf8")):{};
const all=new Map();for(const line of fs.readFileSync(META,"utf8").split("\n")){if(!line.trim())continue;try{const r=JSON.parse(line);all.set(r.site,r)}catch{}}
const db=new DatabaseSync(DB,{readOnly:true});
const rows=db.prepare("select pid,lat,lon,tags_json from place").all();
const users=new Map();
for(const r of rows){const s=siteKey(JSON.parse(r.tags_json));if(s)users.set(s,(users.get(s)||0)+1)}
const CATS=[
  ["restaurants",t=>/^(restaurant|fast_food|food_court)$/.test(t.amenity||"")],
  ["cafes",t=>/^(cafe|ice_cream)$/.test(t.amenity||"")||t.shop==="coffee"],
  ["bars",t=>/^(bar|pub|nightclub|biergarten|hookah_lounge)$/.test(t.amenity||"")],
  ["spas",t=>/^(spa|sauna)$/.test(t.leisure||"")||/^(massage|beauty)$/.test(t.shop||"")],
  ["gyms",t=>/^(fitness_centre|sports_centre)$/.test(t.leisure||"")],
  ["attractions",t=>/^(attraction|museum|gallery|theme_park|zoo|aquarium|viewpoint)$/.test(t.tourism||"")||/^(water_park|amusement_arcade)$/.test(t.leisure||"")],
  ["hotels",t=>/^(hotel|hostel|motel|guest_house|apartment|resort)$/.test(t.tourism||"")],
];
const catOf=(t)=>{for(const [c,f] of CATS)if(f(t))return c;return "other"};
const KEYS=["opening_hours","free:price","free:booking_url","free:menu","cuisine"];
const stat={};const z=()=>({places:0,with_site:0,site_ok:0,had_oh:0,...Object.fromEntries(KEYS.map(k=>[k,0]))});
const prov={};const hoursSamples=[],bookSamples=[];let agree=0,disagree=0,splitBug=0,disList=[];
const DAYN=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const mins=(s)=>parseTime(s);
for(const r of rows){
  const t=JSON.parse(r.tags_json);const c=catOf(t);
  const st=stat[c]||(stat[c]=z());const tot=stat.ALL||(stat.ALL=z());
  st.places++;tot.places++;
  if(t.opening_hours){st.had_oh++;tot.had_oh++}
  const s=siteKey(t);if(!s)continue;
  const v=(check[s]||{}).v;if(v==="spam"||v==="parked")continue; // ingest.mjs снимает такие сайты
  st.with_site++;tot.with_site++;
  const rec=meta.get(s);if(!rec)continue;
  st.site_ok++;tot.site_ok++;
  const before={...t};
  const o={lat:r.lat,lon:r.lon,users:users.get(s)||1};
  const wrote=applySiteMeta(t,rec,o);
  for(const k of wrote){st[k]++;tot[k]++}
  if(wrote.includes("free:booking_url")){const p=t["free:booking_provider"];prov[p]=(prov[p]||0)+1;bookSamples.push({pid:r.pid,name:t.name,url:t["free:booking_url"],provider:p})}
  if(wrote.includes("opening_hours")){
    const m=matchEntity(rec,before,o);
    // сущность, из которой взяты часы (у заведения их бывает две: Restaurant + openingHoursSpecification)
    const used=(rec.entities||[]).find(e=>(e.openingHoursSpecification||e.openingHours)&&hoursToOsm(e)===t.opening_hours&&(!m||e.src===m.e.src))||m.e;
    hoursSamples.push({pid:r.pid,name:t.name,site:s,how:m&&m.how,entity:used.name,src:used.openingHoursSpecification||used.openingHours,osm:t.opening_hours});
    // Независимая сверка для openingHoursSpecification: по дням, напрямую из источника.
    const spec=hoursToOsm({openingHoursSpecification:used.openingHoursSpecification})===t.opening_hours&&used.openingHoursSpecification;
    if(spec){
      const want=Array.from({length:7},()=>[]);
      for(const x of spec){if(x.validFrom||x.validThrough)continue;const o1=mins(x.opens),c1=mins(x.closes);if(o1==null||c1==null||(o1===0&&c1===0))continue;
        let end=c1===1439||c1===0?1440:c1;if(end<o1)end+=1440;
        for(const d of x.dayOfWeek||[]){const i=DAYN.findIndex(n=>String(d).toLowerCase().endsWith(n.toLowerCase()));if(i>=0)want[i].push(`${o1}-${end}`)}}
      const got=parseSchedule(t.opening_hours)||[];
      const ok=want.every((w,i)=>JSON.stringify([...w].sort())===JSON.stringify((got[i]||[]).map(x=>`${x.start}-${x.end}`).sort()));
      if(ok)agree++;else if(/\d,\d/.test(t.opening_hours))splitBug++;else{disagree++;if(disList.length<10)disList.push({name:t.name,src:spec,osm:t.opening_hours})}
    }
  }
}
// Выборки: 20 часов и 10 ссылок брони, детерминированно.
let seed=42;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
const pick=(a,n)=>{const c=[...a];const out=[];while(c.length&&out.length<n)out.push(c.splice(Math.floor(rnd()*c.length),1)[0]);return out};
const hs=pick(hoursSamples,20),bs=pick(bookSamples,10);
fs.writeFileSync(SAMPLES,JSON.stringify({hours:hs,booking:bs},null,1));
// Сводка по выгрузке
let ok=0,err={};for(const r of all.values()){if(r.ok)ok++;else{const e=String(r.err||"?").split(":")[0];err[e]=(err[e]||0)+1}}
const recs=[...meta.values()];
const cnt=(f)=>recs.filter(f).length;
const L=[];
L.push(`FREE / Dubai — данные с сайтов заведений (site_meta.jsonl), ${new Date().toISOString()}`);
L.push(`Сайтов в выгрузке: ${all.size} из ${users.size} разных; открылись (ok): ${ok}`);
L.push(`Отказы: ${Object.entries(err).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(", ")}`);
L.push(`Среди открывшихся: с schema.org-сущностями ${cnt(r=>r.entities&&r.entities.length)}, с часами ${cnt(r=>(r.entities||[]).some(e=>e.openingHours||e.openingHoursSpecification))}, с priceRange ${cnt(r=>(r.entities||[]).some(e=>e.priceRange))}, со ссылкой брони провайдера ${cnt(r=>(r.booking||[]).some(b=>b.specific&&b.provider!=="Website"))}, с «Book/Reserve» на своём сайте ${cnt(r=>(r.booking||[]).some(b=>b.provider==="Website"))}, с меню ${cnt(r=>r.menu&&r.menu.length)}`);
L.push("");
L.push("Места, которые получат тег (applySiteMeta, guard сетей ≥3 мест на сайт, спам/парковка исключены):");
const head=["category","places","with_site","site_ok","had_OSM_oh",...KEYS];
L.push(head.map((h,i)=>i?h.padStart(14):h.padEnd(12)).join(""));
for(const c of [...CATS.map(x=>x[0]),"other","ALL"]){const s=stat[c];if(!s)continue;
  L.push([c,s.places,s.with_site,s.site_ok,s.had_oh,...KEYS.map(k=>s[k])].map((v,i)=>i?String(v).padStart(14):String(v).padEnd(12)).join(""))}
L.push("");
L.push(`opening_hours до: ${stat.ALL.had_oh} мест (${(100*stat.ALL.had_oh/stat.ALL.places).toFixed(1)}%), после: ${stat.ALL.had_oh+stat.ALL.opening_hours} (${(100*(stat.ALL.had_oh+stat.ALL.opening_hours)/stat.ALL.places).toFixed(1)}%)`);
L.push(`free:booking_provider: ${Object.entries(prov).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(", ")}`);
L.push(`Сверка часов из openingHoursSpecification с разбором приложения (hours.mjs) по дням: совпало ${agree}, не совпало ${disagree}; ещё ${splitBug} — перерыв днём («12:00-15:00,19:00-23:00»): синтаксис OSM верный, но parseSchedule в hours.mjs оставляет только последний интервал (ошибка hours.mjs)`);
for(const d of disList)L.push(`  ✗ ${d.name}: ${JSON.stringify(d.src).slice(0,300)} → ${d.osm}`);
L.push("");
L.push("20 случайных конвертаций часов (источник → opening_hours):");
for(const h of hs)L.push(`- ${h.name} [${h.how}; ${h.entity||""}]\n    src: ${JSON.stringify(h.src).slice(0,400)}\n    osm: ${h.osm}`);
fs.writeFileSync(OUT,L.join("\n")+"\n");
console.log(L.slice(0,22).join("\n"));
