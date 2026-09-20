import {parseHours,moscowNow} from "./hours.mjs";

import {CATEGORIES,SERVICE_TAGS} from "./categories.mjs";
import {tagTitle as tagRu} from "./osm_tags.mjs";

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
function norm(s=""){return text(s).toLowerCase().replace(/ё/g,"е").replace(/<[^>]*>/g," ").replace(/[^a-zа-я0-9\s]/gi," ").replace(/\s+/g," ").trim()}
function words(s){const stop=new Set(["куда","сходить","пойти","хочу","хочется","сегодня","завтра","вечером","после","москва","москве","очень","сильно","много","какой","какое","что","для","чтобы","можно","найди","место"]);return norm(s).split(" ").filter(w=>w.length>3&&!stop.has(w))}
// Короткие корни (бар, рок, спа, арт, еда, семь) задаём регэкспами с границами слов:
// \b в JS не работает для кириллицы, а includes() ловит «барбершоп», «Крокус», «спать», «восемь».
const BAR_RE=/(?<![а-я])(бар(?!бер|аба|бек|он|ин|сук|рикад)|паб(?!лик)|пив[ао]|вин[оа](?![а-я])|винн|винотек)|(?<![a-z])pub(?!li)|выпить|коктейл/;
const ROCK_RE=/(?<![а-я])рок(?![а-я])|(?<![a-z])rock/;
const SYN={
  hookah:["кальян","кальянная","лаунж","hookah","shisha"],bar:[BAR_RE],food:["ресторан","кафе",/(?<![а-я])ед[аыеу](?![а-я])/,"ужин","поесть","бранч"],
  coffee:["кофе","кофейня"],work:["поработать","ноутбук","коворкинг","работы","встреча"],family:[/ребен|(?<![а-я])дет(и|ей|ям|ьми|ск|ишк)|(?<![а-я])семь[яиею]|семейн/],
  date:["свидание","романтика","вдвоем","вдвоём"],birthday:["день рождения","праздник","компания"],
  comedy:["стендап","комедия","юмор"],jazz:["джаз","jazz"],rock:[ROCK_RE],music:["концерт","музыка","группа","джаз",ROCK_RE],
  art:["выставка","искусство","галерея",/(?<![а-я])арт(?![а-я])/],science:["наука","космос","планетарий"],theatre:["театр","спектакль","опера","балет"],
  club:["клуб","вечеринка","танцы","тусовка"],karaoke:["караоке"],active:["боулинг","бильярд","квест","активно","vr"],spa:[/(?<![а-я])бан(я|и|ю|е|ей)(?![а-я])/,"сауна",/(?<![а-я])спа(?![а-я])/,"массаж","йога"],
  beauty:["салон","маникюр","парикмахер","косметолог"],experience:["дегустация","мастер класс","экскурсия","яхта","необычное"]
};
// Категории из общего справочника участвуют в подборе наравне с исходными синонимами.
for(const c of CATEGORIES){
  const cur=SYN[c.tag]||[];
  if(!cur.some(x=>x instanceof RegExp&&String(x)===String(c.re)))SYN[c.tag]=[...cur,c.re];
}
// Русские названия категорий живут в osm_tags.mjs — ими пользуется и карточка.
// Строковые синонимы сравнивались через includes(), поэтому «клубнику» относило
// к ночным клубам, а «джакузи» — к медицине. Границы слова для кириллицы задаём
// явно: \b в JS работает только для латиницы. До трёх букв окончания допускаем,
// чтобы «кофейня» по-прежнему находилась по «кофе».
const TERM_RE=new Map();
function termRe(t){
  let re=TERM_RE.get(t);
  if(!re){
    const body=norm(t).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    re=new RegExp(`(?<![а-яa-z0-9])${body}[а-я]{0,3}(?![а-я])`);
    TERM_RE.set(t,re);
  }
  return re;
}
function hasTerm(n,t){return t instanceof RegExp?t.test(n):termRe(t).test(n)}
// Кремль: точка отсчёта для запросов «в центре».
const CENTER={lat:55.7539,lon:37.6208};
function requestedTags(query,plan){const n=norm(query),out=[...(plan.tags||[])];for(const [tag,terms] of Object.entries(SYN))if(terms.some(t=>hasTerm(n,t)))out.push(tag);return [...new Set(out)]}
function moscowDate(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function itemText(x){return norm([x.name,x.organizer,x.cat,x.area,x.metro,x.desc,x.keywords,(x.tags||[]).join(" ")].filter(Boolean).join(" "))}
function toMin(t){const m=text(t).match(/^(\d{1,2}):(\d{2})/);return m?+m[1]*60 + +m[2]:null}
function dateOkay(x,args){
  if(x.kind==="venue")return true;
  if(!args.target_date){const last=x.date_end||x.date_start;return !last||last>=moscowDate()}
  if(!x.date_start)return false;return args.target_date>=x.date_start&&args.target_date<=(x.date_end||x.date_start)
}
function timeOkay(x,args){if(!args.after_time||!x.times?.length)return true;const a=toMin(args.after_time);return x.times.some(t=>toMin(t)!==null&&toMin(t)>=a)}
// Момент, для которого проверяем часы работы: after_time на целевую дату, иначе «сейчас» (args.now — для тестов).
// Если просят другой день без времени, часы не проверяем — «открыто сейчас» ничего не значит.
function hoursMoment(args){
  const m=text(args.after_time).match(/^(\d{1,2}):(\d{2})/);
  if(m)return new Date(`${args.target_date||moscowDate()}T${m[1].padStart(2,"0")}:${m[2]}:00+03:00`);
  if(args.target_date&&args.target_date!==moscowDate())return null;
  return args.now?new Date(args.now):new Date();
}
function venueHours(x,moment){
  if(x.kind!=="venue"||!moment)return null;
  const h=parseHours(x.hours_label,moment);
  if(h.open_now===null)return null;
  let closes_in=null;
  if(h.open_now&&h.closes_at){const t=moscowNow(moment);closes_in=(toMin(h.closes_at)-t.minute+1440)%1440}
  return {...h,closes_in};
}
function priceOkay(x,args){if(args.max_price_rub===undefined||args.max_price_rub===null)return true;if(x.price_min===null||x.price_min===undefined)return true;return x.price_min<=+args.max_price_rub}
function clamp(v,a=0,b=100){return Math.max(a,Math.min(b,v))}
function has(text,re){return re.test(text)}

export function placeDna(x){
  const text=itemText(x), tags=new Set(x.tags||[]);
  // Одно сработавшее условие выводит признак в зону «выражен» (~60), каждое следующее добавляет ещё.
  // Так пороги >=55/60/70 в ранкере и UI реально достижимы; без условий остаётся базовое значение.
  const score=(base,...conds)=>{const h=conds.filter(Boolean).length;return h?clamp(58+(h-1)*14+Math.round(base/8)):clamp(base)};
  const late = has(text,/ноч|до 0[1-6]|24\/7|круглосуточ|(?<![а-я])(бар(?!бер|аба|бек|он|ин|сук|рикад)|паб(?!лик))|клуб|караоке|кальян/)||tags.has("nightlife");
  const quiet = has(text,/тих|спокой|камерн|уют|библиот|коворкинг/)&&!has(text,/клуб|вечерин|караоке|стендап|концерт/);
  const romantic = has(text,/панорам|(?<![а-я])вин[оа](?![а-я])|винн|коктейл|свидан|романт|джаз|ресторан/)&&!has(text,/детск|семейн/);
  const trendy = has(text,/дизайн|(?<![а-я])арт(?![а-я])|модн|новый|новая|коктейл|винзавод|лофт|концепт|иммерсив/);
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
    outdoors:score(15,outdoors,tags.has("outdoors"))
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

// Веса вкуса приходят из тела запроса. Без проверки NaN и огромные значения
// уводили оценку в минус и выбрасывали все результаты.
function sanitizeTaste(raw){
  const out={};
  for(const [k,v] of Object.entries(raw||{})){
    const n=Number(v);
    if(Number.isFinite(n))out[k]=Math.max(-5,Math.min(5,n));
  }
  return out;
}
const NEAR_RE=/ближайш|поблизости|рядом|недалеко|неподалёку|неподалеку|от меня|пешком|близко|в шаговой/;

export function rankLive(items,args={},plan={}){
  const q=args.query||"",qwords=words(q),tags=requestedTags(q,plan),
    strong=new Set(tags.filter(t=>Object.keys(SYN).includes(t))),
    taste=sanitizeTaste(args.taste_weights), user=coordsPair(args.user_location),
    // «Ближайший» и «поблизости» сюда не попадали, и просьба «найди ближайшее»
    // молча превращалась в обычный поиск по городу. Плюс агент теперь может
    // сказать про близость прямо, не надеясь на то, что нужное слово уцелеет
    // в переписанном им запросе.
    near=args.near===true||NEAR_RE.test(norm(q)),
    rain=args.weather_context?.rain===true,moment=hoursMoment(args),
    serviceAsked=tags.some(t=>SERVICE_TAGS.has(t)),
    centerAsked=/центр/.test(norm(args.area||""));
  const scored=[];
  for(const x of items){
    if(!dateOkay(x,args)||!timeOkay(x,args)||!priceOkay(x,args))continue;
    if(x.availability&&/закрыт/.test(norm(x.availability)))continue;
    const hours=venueHours(x,moment);
    // Известно, что к нужному времени заведение закрыто — не показываем.
    if(hours&&hours.open_now===false&&args.after_time)continue;
    const text=itemText(x),xtags=new Set(x.tags||[]),ctags=new Set(x.cat_tags||[]),dna=placeDna(x);let s=0,reasons=[],strongHit=0;
    if(hours&&hours.open_now){
      s+=7;reasons.push(args.after_time?`открыто в ${args.after_time}`:"открыто сейчас");
      if(hours.closes_in!==null&&hours.closes_in<=60){s-=24;reasons.push(`закрывается в ${hours.closes_at}`)}
    }
    for(const t of tags){
      // Услугу засчитываем только по категории из источника: «Аптекарский огород»
      // — парк, а «Хлебозавод» с барбершопом в описании — не барбершоп.
      const hit=SERVICE_TAGS.has(t)?ctags.has(t):(xtags.has(t)||ctags.has(t)||SYN[t]?.some(k=>hasTerm(text,k)));
      if(hit){s+=strong.has(t)?58:22;strongHit++;reasons.push(tagRu(t))}
    }
    // Слова запроса влияют на ранг, но в причины не идут: «парк · park» — не объяснение.
    let lex=0;for(const w of qwords)if(text.includes(w))lex+=9;
    s+=Math.min(54,lex);
    if(strong.size&&strongHit===0&&lex<18)continue;
    // Спросили услугу — показываем только подтверждённые источником места.
    if(serviceAsked&&strongHit===0)continue;
    if(!strong.size&&qwords.length===0)s+=18;
    if(args.target_date&&x.kind==="event"){s+=22;reasons.push("по дате")}
    if(args.after_time&&x.times?.length){s+=9;reasons.push("по времени")}
    if(args.max_price_rub!==undefined&&args.max_price_rub!==null&&x.price_min!==null&&x.price_min<=args.max_price_rub){s+=10;reasons.push("в бюджете")}
    const ts=tasteScore(dna,taste);
    s+=ts;
    reasons.push(...contextDnaReasons(dna,args));
    let distance_km=null;
    const c=coordsPair(x.coords);
    if(user&&c){distance_km=hav(user,c);if(near)s+=Math.max(-30,32-distance_km*5);else s+=Math.max(0,8-distance_km*.6);if(distance_km<2)reasons.push("рядом")}
    // Просили центр — место за его пределами не показываем вовсе.
    let center_km=null;
    if(centerAsked&&c){
      center_km=hav(CENTER,c);
      if(center_km>6)continue;
      s+=Math.max(0,20-center_km*3);
      reasons.push(center_km<=2?"в центре":`${center_km.toFixed(1)} км от центра`);
    }
    if(rain&&dna.outdoors>=55)s-=42;
    if(rain&&dna.outdoors<40)s+=8;
    if(x.live)s+=8;if(x.provider==="2GIS")s+=5;
    // Совпадение считаем по самому запросу: сколько его условий место выполнило
    // и насколько оно совпало со вкусом. Раньше проценты нормировались внутри
    // выдачи, и первый вариант получал 97 независимо от того, что нашлось.
    // Условие может быть выполнено частично: «в центре» за 1 км и за 5 км — разное.
    const crit=[];
    if(tags.length)crit.push([3,strongHit>0?1:0]);
    if(qwords.length)crit.push([2,lex>0?1:0]);
    if(args.target_date)crit.push([2,x.kind!=="event"||x.date_start?1:0]);
    if(args.after_time)crit.push([2,!hours||hours.open_now!==false?1:0]);
    if(centerAsked)crit.push([3,center_km===null?0:clamp(1-center_km/6,0,1)]);
    if(near&&user)crit.push([2,distance_km===null?0:clamp(1-distance_km/5,0,1)]);
    if(hours)crit.push([1,hours.open_now?1:0]);
    if(args.max_price_rub!==undefined&&args.max_price_rub!==null)crit.push([1,x.price_min===null||x.price_min<=+args.max_price_rub?1:0]);
    const tot=crit.reduce((a,[w])=>a+w,0),got=crit.reduce((a,[w,v])=>a+w*v,0);
    const fit=tot?got/tot:0.6,align=clamp((ts+30)/60,0,1);
    const match=Math.round(clamp(52+36*fit+24*(align-.5),50,99));
    scored.push({...x,_score:s,_match:match,_reasons:[...new Set(reasons)].slice(0,5),_dna:dna,_distance_km:distance_km,_center_km:center_km,_hours:hours});
  }
  scored.sort((a,b)=>b._score-a._score);
  if(!scored.length)return [];
  // Абсолютный порог выбрасывал ВСЮ выдачу, когда ни одно слово запроса не нашлось
  // в текстах: на «посоветуй что-нибудь» человек получал пустой ответ при живых
  // подходящих местах. Отсекаем только слабых относительно лучшего.
  const top=scored[0]._score,close=scored.filter(x=>x._score>=top-42);
  const out=[],pool=[...close];
  while(pool.length&&out.length<5){
    let best=null,bestAdj=-Infinity;
    for(const x of pool){
      let p=0;for(const y of out){if(norm(x.cat)===norm(y.cat))p+=10;if(norm(x.organizer)===norm(y.organizer))p+=12;if(x.provider===y.provider)p+=2}
      const a=x._score-p;if(a>bestAdj){best=x;bestAdj=a}
    }
    out.push(best);pool.splice(pool.indexOf(best),1);
  }
  return out;
}
export function resultPayload(results,meta={}){
  return {status:results.length?"ok":"no_match",count:results.length,providers:meta.providers||{},degraded:meta.degraded||{},from_cache:meta.from_cache||{},note:meta.note||null,results:results.map(x=>({
    id:x.id,name:x.name,organizer:x.organizer,category:x.cat,date:x.date_start||"постоянно",time:x.times?.[0]||x.hours_label||"",
    price:x.price_label,price_min:x.price_min,availability:x.availability,area:x.area,metro:x.metro,source:x.source,
    point_source:x.point_source||x.source,official_source:x.official_source||null,coords:x.coords||null,provider:x.provider,
    image_url:x.image_url||null,image_source:x.image_source||null,booking_url:x.booking_url||null,
    booking_kind:x.booking_kind||null,booking_provider:x.booking_provider||null,phone:x.phone||null,
    reasons:x._reasons||[],dna:x._dna||placeDna(x),distance_km:x._distance_km,match:x._match||null,kind:x.kind,
    // Все сеансы, а не только первый: без этого планировщик ставил точку на
    // начало дня, даже когда человек просил «после 20:00».
    times:Array.isArray(x.times)?x.times.slice(0,8):[],
    open_now:x._hours?.open_now??null,closes_at:x._hours?.closes_at??null,
    // Поля, которые нужны для фотографии и честной подписи источника.
    tags:Array.isArray(x.tags)?x.tags.slice(0,8):[],cat_tags:Array.isArray(x.cat_tags)?x.cat_tags:[],
    hours_label:x.hours_label||null,wikidata:x.wikidata||null,brand_wikidata:x.brand_wikidata||null,
    wikimedia_commons:x.wikimedia_commons||null,image_raw:x.image_raw||null,
    aggregator_image:x.aggregator_image||null,aggregator_name:x.aggregator_name||null
  }))}
}
