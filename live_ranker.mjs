function norm(s=""){return String(s).toLowerCase().replace(/ё/g,"е").replace(/<[^>]*>/g," ").replace(/[^a-zа-я0-9\s]/gi," ").replace(/\s+/g," ").trim()}
function words(s){const stop=new Set(["куда","сходить","пойти","хочу","хочется","сегодня","завтра","вечером","после","москва","москве","очень","сильно","много","какой","какое","что","для","чтобы","можно","найди","место"]);return norm(s).split(" ").filter(w=>w.length>3&&!stop.has(w))}
const SYN={
  hookah:["кальян","кальянная","лаунж","hookah","shisha"],bar:["бар","паб","pub","коктейль","выпить","пиво","вино"],food:["ресторан","кафе","еда","ужин","поесть","бранч"],
  coffee:["кофе","кофейня"],work:["поработать","ноутбук","коворкинг","работы","встреча"],family:["ребенок","ребёнок","дети","семья","семейный"],
  date:["свидание","романтика","вдвоем","вдвоём"],birthday:["день рождения","праздник","компания"],
  comedy:["стендап","комедия","юмор"],jazz:["джаз","jazz"],rock:["рок","rock"],music:["концерт","музыка","группа","джаз","рок"],
  art:["выставка","искусство","галерея","арт"],science:["наука","космос","планетарий"],theatre:["театр","спектакль","опера","балет"],
  club:["клуб","вечеринка","танцы","тусовка"],karaoke:["караоке"],active:["боулинг","бильярд","квест","активно","vr"],spa:["баня","сауна","спа","массаж","йога"],
  beauty:["салон","маникюр","парикмахер","косметолог"],experience:["дегустация","мастер класс","экскурсия","яхта","необычное"]
};
function requestedTags(query,plan){const n=norm(query),out=[...(plan.tags||[])];for(const [tag,terms] of Object.entries(SYN))if(terms.some(t=>n.includes(norm(t))))out.push(tag);return [...new Set(out)]}
function itemText(x){return norm([x.name,x.organizer,x.cat,x.area,x.metro,x.desc,x.keywords,(x.tags||[]).join(" ")].filter(Boolean).join(" "))}
function toMin(t){const m=String(t||"").match(/^(\d{1,2}):(\d{2})/);return m?+m[1]*60 + +m[2]:null}
function dateOkay(x,args){if(!args.target_date)return true;if(x.kind==="venue")return true;if(!x.date_start)return false;return args.target_date>=x.date_start&&args.target_date<=(x.date_end||x.date_start)}
function timeOkay(x,args){if(!args.after_time||!x.times?.length)return true;const a=toMin(args.after_time);return x.times.some(t=>toMin(t)!==null&&toMin(t)>=a)}
function priceOkay(x,args){if(args.max_price_rub===undefined||args.max_price_rub===null)return true;if(x.price_min===null||x.price_min===undefined)return true;return x.price_min<=+args.max_price_rub}
function clamp(v,a=0,b=100){return Math.max(a,Math.min(b,v))}
function has(text,re){return re.test(text)}

export function placeDna(x){
  const text=itemText(x), tags=new Set(x.tags||[]);
  const score=(base,...conds)=>clamp(base+conds.reduce((s,c)=>s+(c?18:0),0));
  const late = has(text,/ноч|до 0[1-6]|24\/7|круглосуточ|бар|клуб|караоке|кальян/)||tags.has("nightlife");
  const quiet = has(text,/тих|спокой|камерн|уют|библиот|коворкинг/)&&!has(text,/клуб|вечерин|караоке|стендап|концерт/);
  const romantic = has(text,/панорам|вино|винн|коктейл|свидан|романт|джаз|ресторан/)&&!has(text,/детск|семейн/);
  const trendy = has(text,/дизайн|арт|модн|новый|новая|коктейл|винзавод|лофт|концепт|иммерсив/);
  const luxury = has(text,/fine|преми|lux|панорам|отель|авторск|гастроном/);
  const hidden = has(text,/переул|скрыт|секрет|камерн|необыч|иммерсив/)&&!has(text,/вднх|планетар|третьяков|пушкинск/);
  const kids = tags.has("family")||has(text,/детск|ребен|семейн|зоопарк|экспериментаниум/);
  const work = tags.has("work")||has(text,/коворкинг|ноутбук|кофейн|тих|wifi|wi fi/);
  const active = tags.has("active")||has(text,/квест|боулинг|vr|танц|актив|спорт/);
  const culture = tags.has("culture")||tags.has("art")||has(text,/музей|искусств|выстав|театр|галере/);
  const music = tags.has("music")||tags.has("jazz")||tags.has("rock")||has(text,/музык|концерт|джаз|рок/);
  const nightlife = tags.has("nightlife")||late;
  const outdoors = tags.has("outdoors")||has(text,/парк|набереж|улиц|open air|террас/);
  return {
    romantic:score(32,romantic,tags.has("date")),
    quiet:score(38,quiet,!nightlife),
    trendy:score(35,trendy),
    luxury:score(22,luxury),
    hidden:score(31,hidden),
    late:score(22,late),
    family:score(18,kids),
    work:score(20,work),
    active:score(25,active),
    culture:score(20,culture),
    music:score(20,music),
    nightlife:score(18,nightlife),
    outdoors:score(15,outdoors)
  };
}
function coordsPair(c){
  if(!c)return null;
  if(Array.isArray(c)&&c.length>=2){
    const a=+c[0],b=+c[1];if(Number.isFinite(a)&&Number.isFinite(b)){
      if(a>50&&a<60&&b>30&&b<45)return {lat:a,lon:b};
      if(b>50&&b<60&&a>30&&a<45)return {lat:b,lon:a};
    }
  }
  const lat=+(c.lat??c.latitude),lon=+(c.lon??c.lng??c.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}
function hav(a,b){const R=6371,rad=v=>v*Math.PI/180,dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);const z=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;return 2*R*Math.asin(Math.sqrt(z))}
function tasteScore(dna,taste={}){
  let s=0;
  for(const [k,w0] of Object.entries(taste||{})){
    const w=Number(w0);if(!Number.isFinite(w)||dna[k]===undefined)continue;
    s += w*(dna[k]-50)/14;
  }
  return Math.max(-45,Math.min(45,s));
}
function contextDnaReasons(dna,args){
  const n=norm(args.query||""),out=[];
  if(/тих|спокой|разговар/.test(n)&&dna.quiet>=60)out.push("спокойная атмосфера");
  if(/красив|свидан|романт/.test(n)&&dna.romantic>=60)out.push("подходит для свидания");
  if(/работ|ноутбук/.test(n)&&dna.work>=55)out.push("удобно для работы");
  if(/ребен|дет/.test(n)&&dna.family>=55)out.push("подходит с детьми");
  if(/необыч|новое|hidden/.test(n)&&dna.hidden>=55)out.push("небанальный формат");
  if(/поздно|ноч|после 22/.test(n)&&dna.late>=55)out.push("поздний формат");
  return out;
}

export function rankLive(items,args={},plan={}){
  const q=args.query||"",qwords=words(q),tags=requestedTags(q,plan),
    strong=new Set(tags.filter(t=>Object.keys(SYN).includes(t))),
    taste=args.taste_weights||{}, user=coordsPair(args.user_location), near=/рядом|недалеко|от меня|пешком/.test(norm(q)),
    rain=args.weather_context?.rain===true;
  const scored=[];
  for(const x of items){
    if(!dateOkay(x,args)||!timeOkay(x,args)||!priceOkay(x,args))continue;
    if(x.availability&&/закрыт/.test(norm(x.availability)))continue;
    const text=itemText(x),xtags=new Set(x.tags||[]),dna=placeDna(x);let s=0,reasons=[],strongHit=0;
    for(const t of tags){if(xtags.has(t)||SYN[t]?.some(k=>text.includes(norm(k)))){s+=strong.has(t)?58:22;strongHit++;reasons.push(t)}}
    let lex=0;for(const w of qwords){if(text.includes(w)){lex+=9;reasons.push(w)}}s+=Math.min(54,lex);
    if(strong.size&&strongHit===0&&lex<18)continue;
    if(!strong.size&&qwords.length===0)s+=18;
    if(args.target_date&&x.kind==="event"){s+=22;reasons.push("по дате")}
    if(args.after_time&&x.times?.length){s+=9;reasons.push("по времени")}
    if(args.max_price_rub!==undefined&&args.max_price_rub!==null&&x.price_min!==null&&x.price_min<=args.max_price_rub){s+=10;reasons.push("в бюджете")}
    s+=tasteScore(dna,taste);
    reasons.push(...contextDnaReasons(dna,args));
    let distance_km=null;
    const c=coordsPair(x.coords);
    if(user&&c){distance_km=hav(user,c);if(near)s+=Math.max(-30,32-distance_km*5);else s+=Math.max(0,8-distance_km*.6);if(distance_km<2)reasons.push("рядом")}
    if(rain&&dna.outdoors>=55)s-=42;
    if(rain&&dna.outdoors<40)s+=8;
    if(x.live)s+=8;if(x.provider==="2GIS")s+=5;
    scored.push({...x,_score:s,_reasons:[...new Set(reasons)].slice(0,5),_dna:dna,_distance_km:distance_km});
  }
  scored.sort((a,b)=>b._score-a._score);
  if(!scored.length)return [];
  const top=scored[0]._score,close=scored.filter(x=>x._score>=Math.max(14,top-42));
  const out=[],pool=[...close];
  while(pool.length&&out.length<5){
    let best=null,bestAdj=-Infinity;
    for(const x of pool){
      let p=0;for(const y of out){if(norm(x.cat)===norm(y.cat))p+=10;if(norm(x.organizer)===norm(y.organizer))p+=12;if(x.provider===y.provider)p+=2}
      const a=x._score-p;if(a>bestAdj){best=x;bestAdj=a}
    }
    out.push(best);pool.splice(pool.indexOf(best),1);
  }
  const max=out[0]?._score||1,min=out[out.length-1]?._score||0;
  for(let i=0;i<out.length;i++){
    const rel=max===min?0:(out[i]._score-min)/(max-min);
    out[i]._match=Math.round(Math.max(68,Math.min(97,86+rel*11-i*2)));
  }
  return out;
}
export function resultPayload(results,meta={}){
  return {status:results.length?"ok":"no_match",count:results.length,providers:meta.providers||{},note:meta.note||null,results:results.map(x=>({
    id:x.id,name:x.name,organizer:x.organizer,category:x.cat,date:x.date_start||"постоянно",time:x.times?.[0]||x.hours_label||"",
    price:x.price_label,price_min:x.price_min,availability:x.availability,area:x.area,metro:x.metro,source:x.source,
    point_source:x.point_source||x.source,official_source:x.official_source||null,coords:x.coords||null,provider:x.provider,
    image_url:x.image_url||null,image_source:x.image_source||null,booking_url:x.booking_url||null,
    booking_kind:x.booking_kind||null,booking_provider:x.booking_provider||null,phone:x.phone||null,
    reasons:x._reasons||[],dna:x._dna||placeDna(x),distance_km:x._distance_km,match:x._match||null,kind:x.kind
  }))}
}
