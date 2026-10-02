import {parseHours,localNow} from "./hours.mjs";
import {CITY,cityDate,L} from "./city.mjs";

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
// Слова названия: по границам слов, без дефисов и знаков («Atlantis-Aquaventure»).
const toks=(v)=>norm(v||"").split(/[^a-z0-9а-я]+/).filter(Boolean);
// Слова, которые добавляют к названию известного места, не меняя его.
const CORE_EXTRA=new Set(["jumeirah","hotel","resort","spa","island","dubai","uae","official","main","entrance"]);
const NAME_FILLER=new Set(["the","of","and","at","in","by","dubai","uae","llc","l","c","co","fz","fze","branch","s"]);
// Слово запроса в тексте — целиком или основой («skydiv» → skydive, skydiving).
function hasWord(text,w){
  if(w.includes(" "))return text.includes(w);
  return new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}${w.length>=5?"":"(?![a-z0-9])"}`).test(text);
}
// Кухня и её признаки: завтрак — это и кафе, и пекарня; чай — и кондитерская.
const CUISINE_SYN={arabic:/\barab(?:ic|ian)?\b|lebanese|emirati|levant|middle eastern|syrian|khaleeji/,arab:/\barab(?:ic|ian)?\b|lebanese|emirati|levant|middle eastern|syrian|khaleeji/,breakfast:/breakfast|brunch|cafe|coffee|bakery|pancake|crepe|bagel|eggs/,brunch:/brunch|breakfast|cafe/,tea:/\btea\b|tea room|patisserie|high tea|afternoon/,
  seafood:/seafood|fish|lobster|oyster|crab|shrimp/,
  steak:/steak|grill|bbq|meat/,burger:/burger/,vegan:/vegan|plant/,vegetarian:/vegetarian|vegan|veg\b|plant/,
  dosa:/dosa|south indian|udupi|kerala|chettinad|tamil|andhra|saravana|kamat/,southindian:/dosa|south indian|udupi|kerala|chettinad|tamil|andhra|saravana|kamat/,
  dimsum:/dim ?sum|dumpling|cantonese|yum cha|chinese/,falafel:/falafel|shawarma|lebanese|arab|middle eastern|syrian|levant/,
  turkish:/turk|ottoman|istanbul|anatolia|kebab|pide/,thali:/thali|indian|gujarati|rajasthani/,tacos:/taco|mexican/,taco:/taco|mexican/};
const cuisineHit=(text,w)=>CUISINE_SYN[w]?CUISINE_SYN[w].test(text):hasWord(text,w);
const LATE_RE=/24\/7|00:00-24:00|-2[4]:00|-0[0-6]:\d\d|-(?:01|02|03|04|05)\b/;
const SEA_RE=/beach|\bsea\b|seaside|marina|ocean|water ?front|corniche|harbou?r|\bjbr\b|la mer|palm jumeirah|the palm|bluewaters|\bpier\b|kite beach|the walk|umm suqeim|creek/;
// Одно место под разными подписями: «Maha Balloon» и «MAHA Balloon Adventures»,
// «Noodle House» и «The Noodle House JBR», «Atlantis-Aquaventure» и
// «Atlantis Aquaventure Waterpark»: одно название — начало другого.
function sameVenue(x,y){
  if(x.brand&&y.brand&&norm(x.brand)===norm(y.brand))return true;
  const a=toks(x.name).filter(w=>!NAME_FILLER.has(w)),b=toks(y.name).filter(w=>!NAME_FILLER.has(w));
  if(!a.length||!b.length)return norm(x.name)===norm(y.name);
  const [s1,s2]=a.length<=b.length?[a,b]:[b,a];
  if(s1.every((w,i)=>s2[i]===w))return true;
  // Одна точка (до 150 м) и два общих слова: «JA Shooting Club & Centre» и
  // «Jebel Ali Shooting Club» — один и тот же клуб.
  const cx0=x.coords,cy0=y.coords;
  if(cx0&&cy0&&Number.isFinite(+cx0.lat)&&Number.isFinite(+cy0.lat)&&Math.abs(cx0.lat-cy0.lat)<0.0014&&Math.abs(cx0.lon-cy0.lon)<0.0015){
    const sb=new Set(b);if(a.filter(w=>sb.has(w)).length>=2)return true;
  }
  // «…Historical Neighbourhood» и «…Historical Neighborhood»: общее начало
  // из 2+ слов на 75% короткого названия и рядом — одно и то же место.
  let k=0;while(k<s1.length&&s1[k]===s2[k])k++;
  if(k>=2&&k/s1.length>=0.75){
    const cx=x.coords,cy=y.coords;
    if(cx&&cy&&Number.isFinite(+cx.lat)&&Number.isFinite(+cy.lat))return Math.abs(cx.lat-cy.lat)<0.015&&Math.abs(cx.lon-cy.lon)<0.015;
    return true;
  }
  return false;
}
// Основа слова — только если от слова остаётся 5+ букв: «cooking» не
// превращается в «cook», который находил «Ben's Cookies».
const stemW=(w)=>{if(w.includes(" ")||w.length<6)return w;const st=w.replace(/(ing|ers|er|es|s)$/,"");return st.length>=5?st:w};
// Занятия, которые узнаются по названию даже вне своей рубрики (батутный
// центр подписан «спортзалом»). Слова, что встречаются в чужих названиях
// («thread» — ателье, «camel» — печенье, «horse» — паб), сюда не входят.
const SPECIFIC_WORDS=new Set(["jetski","zipline","paddleboarding","lasertag","surfing","kitesurfing","trampoline","trampolin","kayaking","snorkeling","skydiving","paragliding","zipline","bungee","balloon","helicopter","hammam","padel","paintball","archery","pilates","crossfit","squash"].map(stemW));
const MAIN_CATEGORY_TAGS=new Set(CATEGORIES.map(c=>c.tag));
const FAST_ASK=/fast ?food|burger|quick|cheap|budget|takeaway|take away|drive.?thru|kids|chicken|fries|mcdonald|kfc|subway|pizza hut|domino|hardee|shake shack|five guys|nando|popeyes|wendy|starbucks|tim hortons|costa/;
const CHAIN_EN=/\b(mcdonald s?|kfc|burger king|subway|pizza hut|domino s?|hardee s?|popeyes|wendy s?|papa john s?|little caesars|texas chicken|krispy kreme|dunkin|baskin robbins|starbucks|tim hortons|costa coffee|caribou coffee|shake shack|five guys|nando s?|johnny rockets|fuddruckers|tgi fridays|t g i friday s?|fridays|applebee s?|chili s?|cheesecake factory|p f chang s?|operation falafel|al baik|jollibee|max s|charleys|herfy|taco bell|carl s jr|fatburger|smashburger|wingstop|chuck e cheese)\b/;
const SIGHT_SERVICES=new Set(["mall","mosque","hotel","market","jewelry","perfume"]);
const STOP_EN=["what","where","when","which","with","want","wanna","need","looking","find","show","tell","some","something","anything","good","best","nice","great","place","places","spot","spots","tonight","today","tomorrow","evening","night","near","nearby","around","there","here","have","that","this","from","into","your","please","could","would","should","dubai","city","open","now"];
function words(s){const stop=new Set(["куда","сходить","пойти","хочу","хочется","сегодня","завтра","вечером","после","москва","москве","очень","сильно","много","какой","какое","что","для","чтобы","можно","найди","место",...STOP_EN,String(CITY.name||"").toLowerCase()]);return norm(s).split(" ").filter(w=>w.length>3&&!stop.has(w))}
// Короткие корни (бар, рок, спа, арт, еда, семь) задаём регэкспами с границами слов:
// \b в JS не работает для кириллицы, а includes() ловит «барбершоп», «Крокус», «спать», «восемь».
const BAR_RE=/(?<![а-я])(гастробар|гастропаб|рюмочн|наливочн|бар(?!бер|аба|бек|он|ин|сук|рикад)|паб(?!лик)|пив[ао]|пивн(?:ой|ая|ые|ым)|вин[оа](?![а-я])|винн|винотек)|(?<![a-z])pub(?!li)|выпить|коктейл/;
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
// Точка отсчёта для запросов «в центре»: в Москве — Кремль (как и было),
// в остальных городах — центр из конфигурации.
const CENTER=CITY.id==="moscow"?{lat:55.7539,lon:37.6208}:CITY.center;
function requestedTags(query,plan){const n=norm(query),out=[...(plan.tags||[])];for(const [tag,terms] of Object.entries(SYN))if(terms.some(t=>hasTerm(n,t)))out.push(tag);return [...new Set(out)]}
const moscowDate=()=>cityDate();
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
  if(m)return new Date(`${args.target_date||moscowDate()}T${m[1].padStart(2,"0")}:${m[2]}:00${CITY.utcOffset}`);
  if(args.target_date&&args.target_date!==moscowDate())return null;
  return args.now?new Date(args.now):new Date();
}
function venueHours(x,moment){
  if(x.kind!=="venue"||!moment)return null;
  const h=parseHours(x.hours_label,moment);
  if(h.open_now===null)return null;
  let closes_in=null;
  if(h.open_now&&h.closes_at){const t=localNow(moment);closes_in=(toMin(h.closes_at)-t.minute+1440)%1440}
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
    // Порядок в массиве неизвестен ([lat,lon] у KudaGo, [lon,lat] у GeoJSON):
    // угадываем по рамке города с запасом в несколько градусов.
    const a=+c[0],b=+c[1];if(Number.isFinite(a)&&Number.isFinite(b)){
      const B=CITY.bbox,isLat=v=>v>B.south-5&&v<B.north+5,isLon=v=>v>B.west-5&&v<B.east+5;
      if(isLat(a)&&isLon(b))return {lat:a,lon:b};
      if(isLat(b)&&isLon(a))return {lat:b,lon:a};
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
  // В Дубае запрос по-английски: те же признаки, английские слова. Для Москвы
  // регэкспы прежние, чтобы выдача не сдвинулась.
  const EN=CITY.lang==="en";
  if((EN?/тих|спокой|разговар|quiet|calm|chill|talk/:/тих|спокой|разговар/).test(n)&&dna.quiet>=60)out.push(L("спокойная атмосфера","calm atmosphere"));
  if((EN?/красив|свидан|романт|date|romantic|beautiful/:/красив|свидан|романт/).test(n)&&dna.romantic>=60)out.push(L("подходит для свидания","good for a date"));
  if((EN?/работ|ноутбук|work|laptop/:/работ|ноутбук/).test(n)&&dna.work>=55)out.push(L("удобно для работы","good for working"));
  if((EN?/ребен|дет|kid|child|family/:/ребен|дет/).test(n)&&dna.family>=55)out.push(L("подходит с детьми","good with kids"));
  if((EN?/необыч|новое|hidden|unusual|new/:/необыч|новое|hidden/).test(n)&&dna.hidden>=55)out.push(L("небанальный формат","something different"));
  if((EN?/поздно|ноч|после 22|late|night/:/поздно|ноч|после 22/).test(n)&&dna.late>=55)out.push(L("поздний формат","late-night spot"));
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

/* Качество места из того, что есть.
   У OpenStreetMap нет ни рейтингов, ни посещаемости, и без этого блока бар без
   единого тега, сетевая кофейня и точка без описания получали одинаковый балл:
   порядок выдачи задавала база, а не пригодность. Полнота карточки — честный
   заменитель репутации: у живого, известного заведения есть свой сайт, часы,
   телефон и кухня; у заброшенной точки на карте — одно имя. */
export function qualityScore(x){
  let q=0;
  if(x.official_source)q+=9;                         // свой сайт — самое сильное: за ним стоит бизнес
  if(x.hours_label)q+=7;                             // часы указаны
  if(x.phone)q+=4;
  if(x.wikidata||x.brand_wikidata)q+=5;              // известно за пределами карты
  if(x.cuisine)q+=3;
  if(x.has_description||(x.desc&&x.desc.length>40))q+=3;
  if(x.image_raw||x.wikimedia_commons)q+=3;          // есть настоящее фото
  if(x.booking_kind==="telegram"||x.booking_kind==="whatsapp"||x.booking_kind==="site")q+=3;
  // Рейтинг с отзывами — единственный настоящий голос людей среди всех
  // сигналов. Считается только при заметном числе отзывов: пятёрка от трёх
  // человек ничего не значит. Низкий рейтинг — минус, а не ноль.
  if(Number.isFinite(x.rating)&&x.rating>0&&(x.rating_count||0)>=20){
    const weight=Math.min(1,(x.rating_count||0)/150);
    q+=Math.round((x.rating-4)*14*weight);            // 4.7 при 150+ отзывах ≈ +10, 3.5 ≈ −7
  }
  return q;
}

// Сетевой общепит на просьбу «выпить»/«вечером» — не ответ. Эти места честно
// попадают в бары по синонимам («кафе-бар» в тексте), а по сути — кофейня
// или фастфуд с очередью. На «кофе» и «перекусить» штраф не действует.
const DRINK_TAGS=new Set(["bar","hookah","wine","cocktail","nightlife","karaoke","club"]);
const CHAIN_RE=/шоколадниц|кофемани|cofix|кофикс|surf coffee|stars coffee|one price|правда кофе|coffee like|даблби|kfc|кфс|макдон|вкусно\s*[—–-]?\s*и\s*точка|burger king|бургер кинг|теремок|додо|dodo|subway|сабвей|cinnabon|синнабон|крошка[\s-]*картошка|му[\s-]*му|братья караваевы|хлеб насущный|prime|прайм|шаурм|столов|пекарн|булочн|coffee|кофейн/i;
// null — исключить из выдачи вовсе; число — штраф.
const EAT_TAGS=new Set(["coffee","food","bakery","pastry"]);
function chainPenalty(x,tags,ctags){
  // Событие — не заведение: «Джаз в Пекарне» исключался как сетевая пекарня.
  if(x.kind==="event")return 0;
  // Просят и выпить, и поесть («хочу выпить кофе», «куда сходить вечером») —
  // кофейни и рестораны тут уместны, штрафовать их не за что.
  if(tags.some(t=>EAT_TAGS.has(t)))return 0;
  if(!tags.some(t=>DRINK_TAGS.has(t)))return 0;
  const drinkPlace=[...DRINK_TAGS].some(t=>ctags.has(t));
  if(drinkPlace)return 0;                            // настоящий бар — без штрафа, даже сетевой
  const name=norm([x.name,x.organizer,x.brand].filter(Boolean).join(" "));
  // Сеть, которая по структуре не бар, на «выпить» не показывается вообще.
  // Штрафом это не решалось: порог отбора относительный, и стоило настоящим
  // барам потерять баллы (скажем, все закрываются через час), как сеть
  // проскакивала второй.
  if(CHAIN_RE.test(name))return null;
  // Не сеть, но и не бар по структуре — кафе, совпавшее по слову. Штраф
  // должен перевешивать бонус за разнообразие категорий в отборе (+10),
  // иначе кафе выходит выше настоящего бара только за то, что оно «другое».
  return -24;
}

export function rankLive(items,args={},plan={}){
  const q=args.query||"",qwords=words(q),tags=requestedTags(q,plan),
    strong=new Set(tags.filter(t=>Object.keys(SYN).includes(t))),
    taste=sanitizeTaste(args.taste_weights),
    // Назван район («bar in JBR») — расстояние меряем от района, а не от человека.
    districtPt=plan.district?coordsPair(plan.userLocation):null,
    user=districtPt||coordsPair(args.user_location),
    focus=Array.isArray(plan.focus)?plan.focus.map(w=>norm(w)).filter(Boolean).map(stemW):[],
    cuisine=new Set(Array.isArray(plan.cuisine)?plan.cuisine.map(w=>norm(w)):[]),
    // Название места («ain dubai», «global village»): совпавшее по всем словам
    // место — ответ, даже если у него нет «вечерней» рубрики.
    phrase=Array.isArray(plan.phrase)?plan.phrase.map(w=>norm(w)).filter(Boolean):[],
    aliasRaw=plan.focusAlias&&typeof plan.focusAlias==="object"?plan.focusAlias:{},
    // Ключи синонимов — исходные слова, а уточнения тут уже в основе слова.
    alias=Object.fromEntries(Object.entries(aliasRaw).flatMap(([k,v])=>[[k,v],[stemW(norm(k)),v]])),
    qTokens=new Set(toks(q)),
    // Основные рубрики запроса — без общих «active», «outdoors», «family»-ярлыков.
    mainTags=Array.isArray(plan.cats)&&plan.cats.length?plan.cats:tags.filter(t=>MAIN_CATEGORY_TAGS.has(t)),
    // «Ближайший» и «поблизости» сюда не попадали, и просьба «найди ближайшее»
    // молча превращалась в обычный поиск по городу. Плюс агент теперь может
    // сказать про близость прямо, не надеясь на то, что нужное слово уцелеет
    // в переписанном им запросе.
    // Район внутри названия («Madinat Jumeirah») — не «рядом с районом».
    near=(Boolean(districtPt)&&!plan.phraseWithDistrict)||args.near===true||NEAR_RE.test(norm(q)),
    // Расстояние в карточке — от человека, если он известен, а не от района.
    realUser=coordsPair(args.user_location),
    rain=args.weather_context?.rain===true,moment=hoursMoment(args),
    serviceAsked=tags.some(t=>SERVICE_TAGS.has(t)),
    // «Рядом» с известной точкой важнее «центра»: иначе просьба «ближайшее»
    // из Кузьминок отсекала всё дальше 6 км от Кремля — то есть всё рядом.
    centerAsked=(CITY.lang==="en"?/центр|\bcent(?:er|re)\b|downtown/:/центр/).test(norm(args.area||""))&&!(near&&user);
  // Место за пределами карты (Хатта, Абу-Даби): ничего похожего по имени
  // не подсовываем — агент честно скажет, что это вне Дубая.
  if(plan.outOfArea)return [];
  const qual=new Set(Array.isArray(plan.qualCats)?plan.qualCats:[]);
  const scored=[];
  const multiCat=(plan.placeQueries||[]).length>1;
  for(const x of items){
    if(!dateOkay(x,args)||!timeOkay(x,args)||!priceOkay(x,args))continue;
    if(x.closed||(x.availability&&/закрыт/.test(norm(x.availability))))continue;
    const hours=venueHours(x,moment);
    // Известно, что к нужному времени заведение закрыто — не показываем.
    if(hours&&hours.open_now===false&&args.after_time)continue;
    const text=itemText(x),xtags=new Set(x.tags||[]),ctags=new Set(x.cat_tags||[]),dna=placeDna(x);let s=0,reasons=[],strongHit=0;
    const nameT=new Set(toks(x.name));
    const named=phrase.length>0&&phrase.every(w=>nameT.has(w));
    // «Ядро»: в названии нет ничего сверх слов запроса — «Ski Dubai», а не
    // «Ski Dubai Snow Park Parking»; это и есть место, о котором спросили.
    const core=named&&[...nameT].every(w=>qTokens.has(w)||NAME_FILLER.has(w)||CORE_EXTRA.has(w));
    // Совпало название целиком — это ответ; частично при названной рубрике
    // («camel ride», «hot air balloon») — просто сильный плюс, без вытеснения.
    if(named)s+=core?130:((plan.cats||[]).length?35:90);
    // Среди одноимённых — известное (есть в Википедии) вперёд: настоящий
    // «Burj Al Arab Jumeirah», а не одноимённая точка без адреса.
    if(named&&x.wikidata)s+=25;
    // Одноимённые: точка из OpenStreetMap надёжнее по координатам, чем запись
    // каталога (у тех нередко адрес «Dubai» и точка в другом районе).
    if(named&&!/^osm:node:9\d{12}$/.test(String(x.id||"")))s+=25;
    // Обходить проверку рубрики может только точное название или запрос без
    // рубрики: «work» в «Automaint Work Shop» не делает автосервис кафе.
    const bypass=core||(named&&!(plan.cats||[]).length);
    if(hours&&hours.open_now){
      s+=7;reasons.push(args.after_time?L(`открыто в ${args.after_time}`,`open at ${args.after_time}`):L("открыто сейчас","open now"));
      if(hours.closes_in!==null&&hours.closes_in<=60){s-=24;reasons.push(L(`закрывается в ${hours.closes_at}`,`closes at ${hours.closes_at}`))}
    }
    for(const t of tags){
      // Услугу засчитываем только по категории из источника: «Аптекарский огород»
      // — парк, а «Хлебозавод» с барбершопом в описании — не барбершоп.
      const hit=SERVICE_TAGS.has(t)?ctags.has(t):(xtags.has(t)||ctags.has(t)||SYN[t]?.some(k=>hasTerm(text,k)));
      // Для общего запроса («куда сходить вечером» = бар + ресторан + кальянная)
      // каждая следующая совпавшая рубрика даёт меньше: иначе кальян-бар,
      // у которого в рубриках и бар, и кальян, и ночная жизнь, набирал в полтора
      // раза больше любого бара или ресторана и занимал всю пятёрку.
      if(hit){s+=strong.has(t)?(multiCat&&strongHit>0?14:58):22;strongHit++;reasons.push(tagRu(t))}
    }
    // Уточнение без категории не спасает: «vr games» не должен приводить в
    // спортзал «Pursuit Games», а «pizza» — в KidZania.
    // Исключение — конкретное занятие прямо в названии: «Bounce Trampoline Park»
    // подписан спортзалом, но на «trampoline park» это и есть ответ.
    const specificInName=focus.some(w=>SPECIFIC_WORDS.has(w)&&(alias[w]||[w]).some(a=>hasWord(norm(x.name||""),stemW(norm(a)))));
    if(specificInName)s+=40;
    if(!bypass&&!specificInName&&focus.length&&mainTags.length&&!mainTags.some(t=>ctags.size?ctags.has(t):xtags.has(t)))continue;
    // Кухню спрашивают у заведения общепита: KidZania с «pizza» в теге кухни — не пиццерия.
    if(!bypass&&cuisine.size&&!/\b(restaurant|fast food|cafe|coffee|food court|bar|pub|ice cream|bakery|deli|delicatessen|eatery|diner|bistro|confectionery|pastry|patisserie|tea)\b/.test(norm(x.keywords||x.cat||"")))continue;
    // «coworking»: настоящий коворкинг выше кафе, где тоже можно поработать.
    if(mainTags.includes("work")&&ctags.has("work")&&!ctags.has("coffee")&&!ctags.has("food"))s+=/co.?work|shared office|hot ?desk|meeting room|office space/.test(norm(q))?60:25;
    // Фастфуд и сети на ужин, свидание, вид — не ответ, если о них не просили.
    if(CITY.lang==="en"&&tags.includes("food")&&!FAST_ASK.test(norm(q))&&(/\bfast food\b/.test(x.keywords||"")||CHAIN_EN.test(norm(x.name||""))))s-=28;
    // Слова запроса влияют на ранг, но в причины не идут: «парк · park» — не объяснение.
    let lex=0;for(const w of qwords)if(text.includes(w))lex+=9;
    s+=Math.min(54,lex);
    if(!bypass&&strong.size&&strongHit===0&&lex<18)continue;
    // Спросили услугу — показываем только подтверждённые источником места.
    if(!bypass&&serviceAsked&&strongHit===0)continue;
    // Спросили не услугу («what to see», «museum»), а основная рубрика места —
    // услуга: юрфирма или магазин одежды с пометкой «достопримечательность»
    // в каталоге не то, куда зовут гулять. Торговый центр, мечеть, рынок и
    // отель — исключения: в Дубае это и есть то, что смотрят.
    if(!bypass&&tags.length&&!serviceAsked&&Array.isArray(x.primary_tags)&&x.primary_tags.length){
      const p0=x.primary_tags[0];
      if(SERVICE_TAGS.has(p0)&&!tags.includes(p0)&&!SIGHT_SERVICES.has(p0))continue;
    }
    // Уточнение запроса: кухня («sushi») или имя («atlantis»). Совпало —
    // место наверх; не та кухня — вниз, но не прочь: лучше итальянец рядом,
    // чем пустая выдача.
    if(focus.length){
      const fh=focus.filter(w=>cuisine.has(w)?cuisineHit(text,w):(alias[w]||[w]).some(a=>hasWord(text,stemW(norm(a)))));
      if(fh.length){
        s+=30+12*(fh.length-1);if(fh.some(w=>cuisine.has(w)))reasons.push(L("нужная кухня","cuisine match"));
        // Совпало по имени — из одноимённых надёжнее известное и точка OSM.
        if(x.wikidata)s+=15;
        if(!/^osm:node:9\d{12}$/.test(String(x.id||"")))s+=10;
      }
      else if(cuisine.size)s-=30;
    }
    // Виды: смотровые площадки, колесо, башни — вперёд.
    if(plan.viewAsk&&(/viewpoint|observation/.test(x.keywords||"")||/\b(view|views|sky|observ\w*|deck|top|frame|ain dubai|wheel|burj|tower)\b/.test(norm(x.name||"")))){s+=35;reasons.push(L("виды","views"))}
    // С детьми: детские центры, парки развлечений, зоопарки, аквапарки.
    if(plan.kidsAsk&&["family","themepark","zoo","aquapark"].some(t=>ctags.has(t)))s+=25;
    // «fine dining»: фастфуд, фудкорт, кафетерий и сети — не ответ.
    if(plan.upscale&&tags.includes("food")){
      if(/\bfast food\b|food court|cafeteria|canteen|takeaway|delivery/.test(text)||CHAIN_EN.test(norm(x.name||"")))s-=40;
      else if(/fine dining|steakhouse|restaurant|bistro|brasserie|grill/.test(text)&&(x.official_source||x.phone))s+=12;
    }
    // «cheap»: кафетерии, шаурма, фудкорт — вперёд; стейкхаусы и лаунжи — назад.
    if(plan.cheap&&tags.includes("food")){
      if(/cafeteria|fast food|shawarma|food court|bakery|karak|canteen|falafel|biryani|street food|takeaway/.test(text))s+=20;
      else if(/steak|fine dining|lounge|brasserie|meat co|caviar|wagyu/.test(text))s-=20;
    }
    // Пожелание к месту («family restaurant», «gym with a pool»): совпало — плюс.
    if(qual.size&&[...qual].some(t=>ctags.has(t)||xtags.has(t)))s+=20;
    // «rooftop»: крыша, терраса, высокий этаж.
    if(plan.rooftop&&/roof ?top|\broof\b|terrace|sky ?(?:bar|lounge|view)|\blevel \d{2}|\bfloor \d{2}|\d{2}(?:st|nd|rd|th) floor/.test(text)){s+=25;reasons.push(L("на крыше","rooftop"))}
    // «late night»: место, открытое за полночь, — вперёд; закрывается рано — назад.
    if(plan.lateNight&&x.kind==="venue"){
      if(LATE_RE.test(x.hours_label||"")){s+=25;reasons.push(L("открыто допоздна","open late"))}
      else if(hours&&hours.closes_at&&/^(1\d|2[0-2]):/.test(hours.closes_at))s-=15;
    }
    // «by the sea»: у воды — пляж, марина, набережная, JBR, Palm.
    if(plan.seaside){
      if(ctags.has("beach")||SEA_RE.test(text)){s+=28;reasons.push(L("у воды","by the water"))}
      else s-=10;
    }
    if(!strong.size&&qwords.length===0)s+=18;
    if(args.target_date&&x.kind==="event"){s+=22;reasons.push(L("по дате","matches the date"))}
    if(args.after_time&&x.times?.length){s+=9;reasons.push(L("по времени","matches the time"))}
    if(args.max_price_rub!==undefined&&args.max_price_rub!==null&&x.price_min!==null&&x.price_min<=args.max_price_rub){s+=10;reasons.push(L("в бюджете","within budget"))}
    const ts=tasteScore(dna,taste);
    s+=ts;
    reasons.push(...contextDnaReasons(dna,args));
    let distance_km=null;
    const c=coordsPair(x.coords);
    if(user&&c){distance_km=hav(user,c);if(near)s+=Math.max(-30,32-distance_km*5);else s+=Math.max(0,8-distance_km*.6);if(distance_km<2)reasons.push(districtPt?L(`в районе ${plan.district}`,`in ${plan.district}`):L("рядом","nearby"))}
    const shownKm=districtPt&&realUser&&c?hav(realUser,c):distance_km;
    // Просили центр — место за его пределами не показываем вовсе.
    let center_km=null;
    if(centerAsked&&c){
      center_km=hav(CENTER,c);
      if(center_km>6)continue;
      s+=Math.max(0,20-center_km*3);
      reasons.push(center_km<=2?L("в центре","in the center"):L(`${center_km.toFixed(1)} км от центра`,`${center_km.toFixed(1)} km from the center`));
    }
    if(rain&&dna.outdoors>=55)s-=42;
    if(rain&&dna.outdoors<40)s+=8;
    if(x.live)s+=8;if(/2GIS|Яндекс Карты|Foursquare|Google/.test(x.provider||""))s+=5;
    const quality=qualityScore(x);
    s+=quality;
    // Место подходит по сопутствующей рубрике, а не по основной: ресторан,
    // где есть бар, — это ресторан. Ранг ниже настоящего бара, но в выдаче
    // остаётся: если баров рядом нет, ресторан с баром лучше пустоты.
    if(strong.size&&Array.isArray(x.primary_tags)&&x.primary_tags.length){
      const primary=new Set(x.primary_tags);
      const asMain=[...strong].some(t=>primary.has(t));
      if(!asMain&&strongHit>0){s-=26;reasons.push(L("по сопутствующей рубрике","secondary category match"))}
    }
    const chain=chainPenalty(x,tags,ctags);
    if(chain===null)continue;
    s+=chain;
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
    const catHit=mainTags.some(t=>ctags.size?ctags.has(t):xtags.has(t));
    const cuisineOk=cuisine.size>0&&[...cuisine].some(w=>cuisineHit(text,w));
    scored.push({...x,_cuisine:cuisineOk,_named:named,_core:core,_cat:catHit||bypass||specificInName,_score:s,_match:match,_quality:quality,_reasons:[...new Set(reasons)].slice(0,5),_dna:dna,_distance_km:shownKm,_rank_km:distance_km,_center_km:center_km,_hours:hours});
  }
  // При равных баллах порядок раньше задавала база (2GIS → OSM → KudaGo):
  // одинаково заполненные места шли в порядке конкатенации. Вторые ключи —
  // качество, близость, и в самом конце устойчивый хеш, а не случайность.
  const h=(id)=>{let x=0;for(const ch of String(id||""))x=(x*31+ch.charCodeAt(0))>>>0;return x};
  scored.sort((a,b)=>b._score-a._score||(b._quality||0)-(a._quality||0)
    ||((a._rank_km??99)-(b._rank_km??99))||((a._center_km??99)-(b._center_km??99))||h(a.id)-h(b.id));
  if(!scored.length)return [];
  // Спросили конкретную рубрику («zoo», «library», «tattoo studio») и места
  // этой рубрики есть — остальное не показываем: KidZania по ярлыку
  // «для семьи» или «Library cafe» по слову в названии — не ответ.
  if(mainTags.length&&CITY.lang==="en"){
    const hits=scored.filter(x=>x._cat);
    if(hits.length)scored.splice(0,scored.length,...hits);
  }
  // Спросили кухню и мест этой кухни хватает — остальные не показываем:
  // на «seafood in jumeirah» кафе с завтраками — не ответ.
  if(cuisine.size&&CITY.lang==="en"){
    const ok=scored.filter(x=>x._cuisine);
    if(ok.length>=3)scored.splice(0,scored.length,...ok);
  }
  // Спросили место по названию и оно нашлось — показываем его, а не соседей
  // по рубрике: на «Global Village» — сам Global Village, а не парковку при нём.
  if(phrase.length){
    const nm=scored.filter(x=>x._named),cores=nm.filter(x=>x._core);
    // Известное место (Википедия) нашлось — одноимённые точки в других
    // районах считаем двойниками и не показываем.
    const wk=cores.find(x=>x.wikidata)||(cores.length?nm.find(x=>x.wikidata&&!x._core):null);
    const near=(x)=>{const a=coordsPair(x.coords),b=coordsPair(wk.coords);return a&&b&&hav(a,b)<=1.5};
    const coresOk=wk?[wk,...cores.filter(x=>x!==wk&&near(x))]:cores;
    if(coresOk.length)scored.splice(0,scored.length,...coresOk);
    else if(nm.length&&!(plan.cats||[]).length&&(!plan.district||plan.phraseWithDistrict))scored.splice(0,scored.length,...nm);
  }
  // Абсолютный порог выбрасывал ВСЮ выдачу, когда ни одно слово запроса не нашлось
  // в текстах: на «посоветуй что-нибудь» человек получал пустой ответ при живых
  // подходящих местах. Отсекаем только слабых относительно лучшего.
  const top=scored[0]._score,close=scored.filter(x=>x._score>=top-42);
  // Первое место далеко впереди («Kurtuba … Key Cutting» на «key cutting»),
  // но остальные мастерские той же рубрики — тоже ответ: добираем их, а не
  // оставляем одну карточку.
  if(CITY.lang==="en"&&close.length<5)for(const x of scored)if(close.length<8&&x._cat&&!close.includes(x))close.push(x);
  const out=[],pool=[...close];
  // Общий запрос («куда сходить вечером») раскладывается на несколько категорий
  // сразу — бар, ресторан, кальянная. Раньше каждая из них считалась «запрошенной»,
  // штраф за повтор не работал, и пять карточек подряд были кальянными: они
  // просто закрываются позже всех. Для таких запросов повтор ведущей рубрики
  // штрафуется мягко, чтобы в пятёрке был выбор, а не одна категория.
  const multi=multiCat;
  const lead=(x)=>(x.primary_tags&&x.primary_tags[0])||(x.cat_tags&&x.cat_tags[0])||norm(x.cat);
  while(pool.length&&out.length<5){
    let best=null,bestAdj=-Infinity;
    for(const x of pool){
      // Одно и то же место дважды («Zuma Dubai» ресторан и парковка с тем же
      // именем) и три филиала одной сети подряд — не выбор.
      if(CITY.lang==="en"&&out.some(y=>sameVenue(x,y)))continue;
      // Одинаковая категория штрафуется только если её не просили: на «выпить»
      // второй бар — это то, что нужно, а не повод подсунуть кафе.
      const asked=tags.some(t=>(x.cat_tags||[]).includes(t));
      let p=0;for(const y of out){if(!asked&&norm(x.cat)===norm(y.cat))p+=10;if(asked&&multi&&lead(x)===lead(y))p+=7;if(norm(x.organizer)===norm(y.organizer))p+=12;if(x.provider===y.provider)p+=2}
      const a=x._score-p;if(a>bestAdj){best=x;bestAdj=a}
    }
    if(!best)break;
    out.push(best);pool.splice(pool.indexOf(best),1);
  }
  return out;
}
export function resultPayload(results,meta={}){
  return {status:results.length?"ok":"no_match",count:results.length,providers:meta.providers||{},degraded:meta.degraded||{},from_cache:meta.from_cache||{},note:meta.note||null,results:results.map(x=>({
    id:x.id,name:x.name,organizer:x.organizer,category:x.cat,date:x.date_start||L("постоянно","ongoing"),time:x.times?.[0]||x.hours_label||"",
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
    quality:x._quality??null,
    // Оценка людей — единственный такой сигнал, что у нас есть. Без этих
    // полей рейтинг влиял на порядок, но не доходил ни до карточки, ни до
    // модели: человек не понимал, почему место первое.
    rating:Number.isFinite(x.rating)?x.rating:null,rating_count:x.rating_count||0,
    wikimedia_commons:x.wikimedia_commons||null,image_raw:x.image_raw||null,
    aggregator_image:x.aggregator_image||null,aggregator_name:x.aggregator_name||null
  }))}
}
