/* FREE planner: собирает вечер из нескольких точек с временем, переходами и маршрутом.
   Изоморфный модуль: в браузере доступен как window.FreePlanner, на сервере импортируется
   через import("./public/planner.js") и читается из globalThis.FreePlanner. */
(function(root){
"use strict";
const DEFAULT_DURATION={food:90,dinner:90,bar:90,hookah:120,coffee:45,club:150,karaoke:120,spa:120,event:120,culture:90,active:90,walk:60,other:75};
const CAT_RULES=[
  ["hookah",/кальян|hookah|lounge|лаунж/i],["bar",/бар|паб|pub|коктейл|пив|вин/i],["food",/ресторан|кафе|ужин|еда|кухн|бранч|завтрак|поесть/i],
  ["coffee",/кофе|coffee/i],["club",/клуб|танц|вечерин/i],["karaoke",/караоке/i],["spa",/спа|баня|саун|массаж/i],
  ["culture",/музей|выстав|галере|театр|спектак|лекц/i],["active",/боулинг|бильярд|квест|vr|каток/i],["walk",/прогул|парк|набереж/i]
];
function guessCategory(text){for(const [c,re] of CAT_RULES)if(re.test(String(text||"")))return c;return "other"}
function toMin(t){const m=String(t||"").match(/^(\d{1,2}):(\d{2})/);return m?+m[1]*60 + +m[2]:null}
function hhmm(min){min=((Math.round(min)%1440)+1440)%1440;return String(Math.floor(min/60)).padStart(2,"0")+":"+String(min%60).padStart(2,"0")}
function roundUp(min,step){return Math.ceil(min/step)*step}
function coordsPair(c){
  if(!c)return null;
  if(Array.isArray(c)&&c.length>=2){const a=+c[0],b=+c[1];if(Number.isFinite(a)&&Number.isFinite(b)){if(a>50&&a<60&&b>30&&b<45)return {lat:a,lon:b};if(b>50&&b<60&&a>30&&a<45)return {lat:b,lon:a}}}
  const lat=+(c.lat??c.latitude),lon=+(c.lon??c.lng??c.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}
function haversineKm(a,b){const R=6371,rad=v=>v*Math.PI/180,dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);const z=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;return 2*R*Math.asin(Math.sqrt(z))}
// Переход между точками: пешком до ~2 км, дальше такси; без координат — оценка по умолчанию.
function travel(from,to){
  const a=coordsPair(from),b=coordsPair(to);
  if(!a||!b)return {mode:"unknown",minutes:20,km:null};
  const km=haversineKm(a,b);
  const walk=Math.round(km/4.5*60);
  if(walk<=25)return {mode:"walk",minutes:Math.max(3,walk),km:+km.toFixed(1)};
  return {mode:"taxi",minutes:Math.max(8,Math.round(km/22*60)+5),km:+km.toFixed(1)};
}
function yandexRouteUrl(points,origin){
  const pts=[origin,...points].filter(Boolean).map(p=>{const c=coordsPair(p.coords||p);return c?`${c.lat},${c.lon}`:`Москва, ${p.area||p.name||""}`});
  return "https://yandex.ru/maps/?mode=routes&rtext="+pts.map(encodeURIComponent).join("~");
}
function stopDuration(stop,place){
  if(stop.duration_min)return +stop.duration_min;
  if(place?.duration_min)return +place.duration_min;
  const cat=guessCategory([stop.query,place?.category,place?.name].join(" "));
  if(place?.kind==="event")return DEFAULT_DURATION.event;
  return DEFAULT_DURATION[cat]||DEFAULT_DURATION.other;
}
// Событие с расписанием «прибивает» время: берём ближайший сеанс не раньше прихода.
function eventStart(place,arrival){
  const times=(place?.times||[]).map(toMin).filter(x=>x!==null);
  const single=toMin(place?.time);
  const all=times.length?times:(single!==null?[single]:[]);
  if(!all.length)return null;
  const ok=all.filter(t=>t>=arrival).sort((a,b)=>a-b);
  return ok.length?{start:ok[0],conflict:false}:{start:Math.max(...all),conflict:true};
}
/**
 * buildPlan(request, search)
 * request: {stops:[{query,duration_min?}], start_time?, anchor?{lat,lon}, party_size?, max_price_rub?, target_date?, taste_weights?, fixed?:[place]}
 * search: async (args) => ({results:[...]}) — любой поиск в формате resultPayload.
 */
async function buildPlan(request,search){
  const stops=(request.stops||[]).filter(s=>s&&String(s.query||"").trim()).slice(0,4);
  if(!stops.length)return {status:"no_stops",stops:[],total:null};
  let cursor=toMin(request.start_time);
  if(cursor===null)cursor=roundUp((request.now_min??19*60),30);
  let anchor=coordsPair(request.anchor)||null;
  const out=[],used=new Set();
  for(let i=0;i<stops.length;i++){
    const stop=stops[i];
    let place=stop.place||null,alternatives=[];
    if(!place){
      const args={query:stop.query,party_size:request.party_size,max_price_rub:request.max_price_rub,target_date:request.target_date,taste_weights:request.taste_weights};
      if(anchor){args.user_location=anchor;args.query=stop.query+" рядом"}
      if(cursor!==null)args.after_time=hhmm(cursor);
      let results=[];
      try{results=((await search(args))||{}).results||[]}catch(e){results=[]}
      results=results.filter(r=>r&&!used.has(r.id));
      place=results.find(r=>coordsPair(r.coords))||results[0]||null;
      alternatives=results.filter(r=>r!==place).slice(0,2);
    }
    const travelIn=out.length&&place?travel(out[out.length-1].place?.coords,place.coords):(anchor&&place?travel(anchor,place.coords):null);
    let start=cursor+(travelIn?travelIn.minutes:0);
    start=roundUp(start,5);
    let conflict=false;
    if(place&&place.kind==="event"){const ev=eventStart(place,start);if(ev){conflict=ev.conflict;start=ev.start}}
    const duration=stopDuration(stop,place);
    const end=start+duration;
    out.push({index:i+1,query:stop.query,category:guessCategory([stop.query,place?.category].join(" ")),place,alternatives,slot_start:hhmm(start),slot_end:hhmm(end),duration_min:duration,travel_in:travelIn,conflict,missing:!place});
    if(place){used.add(place.id);const c=coordsPair(place.coords);if(c)anchor=c}
    cursor=end;
  }
  for(let i=0;i<out.length-1;i++)out[i].travel_to_next=out[i+1].travel_in||null;
  const found=out.filter(s=>s.place);
  const km=out.reduce((s,x)=>s+(x.travel_in?.km||0),0);
  const priceSum=found.reduce((s,x)=>s+(Number.isFinite(+x.place.price_min)?+x.place.price_min:0),0);
  const total={start:out[0].slot_start,end:out[out.length-1].slot_end,stops:out.length,found:found.length,travel_km:+km.toFixed(1),price_from:priceSum||null,
    has_conflict:out.some(s=>s.conflict)};
  return {status:found.length?(found.length===out.length?"ok":"partial"):"no_match",stops:out,total,route_url:found.length?yandexRouteUrl(found.map(s=>s.place),request.anchor?{coords:request.anchor}:null):null};
}
function planSummary(plan){
  if(!plan||!plan.stops?.length)return "";
  return plan.stops.map(s=>`${s.slot_start}–${s.slot_end} ${s.place?s.place.name:"("+s.query+": не найдено)"}${s.travel_to_next?` → ${s.travel_to_next.mode==="walk"?"пешком":s.travel_to_next.mode==="taxi"?"такси":"переход"} ${s.travel_to_next.minutes} мин`:""}`).join("\n");
}
// Разбор фразы вида «ужин, потом бар, а после кальян» на остановки.
function parseStops(text){
  const n=String(text||"").toLowerCase().replace(/ё/g,"е");
  const parts=n.split(/\s*,?\s*(?:а\s+|и\s+)?(?:потом|затем|дальше|после)(?=\s|$)\s*/)
    .map(s=>s.replace(/^(?:этого|него|нее|этой|ужина|бара|концерта|выставки|кино|фильма)\s*/,"").replace(/^(?:в|на|к|и|а)\s+/,"").trim()).filter(Boolean);
  if(parts.length<2)return [];
  const stops=[];
  for(const p of parts){
    const cat=guessCategory(p);
    const q=cat==="food"?"ужин ресторан":cat==="bar"?"бар":cat==="hookah"?"кальянная":cat==="coffee"?"кофейня":cat==="club"?"ночной клуб":cat==="karaoke"?"караоке":cat==="spa"?"спа":cat==="culture"?"выставка":cat==="active"?"активный отдых":cat==="walk"?"прогулка парк":p.replace(/^(хочу|давай|сначала|потом|можно|нужно|надо)\s+/,"");
    stops.push({query:q});
  }
  return stops;
}
const api={buildPlan,parseStops,planSummary,travel,guessCategory,yandexRouteUrl,coordsPair,DEFAULT_DURATION};
root.FreePlanner=api;
})(typeof globalThis!=="undefined"?globalThis:this);
