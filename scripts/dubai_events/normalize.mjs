// Афиша Дубая: чистые функции разбора и нормализации (без сети), общие для
// сборщика (harvest.mjs), поиска (events_dubai.mjs) и тестов.
//
// Из источников берём только факты: название, даты и время, площадку,
// координаты, цену «от», ссылку на билеты и ссылку на картинку (картинку не
// копируем — её отдаёт наш прокси /api/img). Длинные описания не храним:
// не больше 200 знаков краткой подписи, и только если источник сам дал её
// как короткий анонс.

export const TZ="Asia/Dubai";
export const UA="FREE-Dubai/1.0 (+https://afishasity.ru)";
// Рамка Дубая — та же, что в city.mjs (dubai.bbox). Здесь своя копия, чтобы
// сборщик не зависел от CITY в окружении: таймер может стартовать без .env.
export const DUBAI_BBOX={south:24.79,west:54.89,north:25.36,east:55.56};
// Другие эмираты: площадка с таким адресом — не Дубай, даже если источник
// перечисляет её в «Dubai» (у District в одном списке и Абу-Даби, и Шарджа).
export const OTHER_EMIRATE=/\b(abu dhabi|yas island|saadiyat|al ain|sharjah|ajman|ras al khaimah|\brak\b|fujairah|umm al quwain|khor fakkan|hatta)\b/i;

export function text(v){
  if(typeof v==="string")return v;
  if(typeof v==="number"&&Number.isFinite(v))return String(v);
  return "";
}
const ENT={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ndash:"–",mdash:"—",rsquo:"’",lsquo:"‘",rdquo:"”",ldquo:"“",hellip:"…",eacute:"é",egrave:"è",agrave:"à",uuml:"ü",ouml:"ö",auml:"ä"};
export function decodeEntities(s){
  return text(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>{
    if(e[0]==="#"){const n=e[1]==="x"||e[1]==="X"?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return Number.isFinite(n)&&n>0&&n<0x110000?String.fromCodePoint(n):m}
    return ENT[e.toLowerCase()]??m;
  });
}
export function clean(s){return decodeEntities(decodeEntities(text(s))).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim()}
export function norm(s){return clean(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/&/g," and ").replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim()}
export function clamp(s,n=200){s=clean(s);return s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,"")+"…":s}

// ---- Даты по времени Дубая -------------------------------------------------
const fmtDate=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
const fmtTime=new Intl.DateTimeFormat("en-GB",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
export function dubaiToday(now=new Date()){return fmtDate.format(now)}
export function addDays(date,n){const d=new Date(date+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
export function daysBetween(a,b){return Math.round((Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/86400000)}
// День недели даты YYYY-MM-DD: 0 — воскресенье … 6 — суббота.
export function weekday(date){return new Date(date+"T12:00:00Z").getUTCDay()}
/**
 * Дата и время ISO-строки по Дубаю. «2026-10-08» — только дата (время
 * неизвестно), «2026-10-09T18:00:00.000Z» — момент, который переводится в
 * местное время (22:00 9 октября), «2026-10-09T20:00:00» без пояса — местное
 * время как есть. Неразборчивое — null.
 */
export function localDateTime(v){
  const s=text(v).trim();
  if(!s)return null;
  const m=/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if(!m)return null;
  if(!m[2])return {date:m[1],time:null};
  if(!m[4])return {date:m[1],time:`${m[2]}:${m[3]}`};
  const d=new Date(s.replace(" ","T"));
  if(!Number.isFinite(d.valueOf()))return null;
  // «00:00» в поясе источника без явного времени показа — это «весь день»,
  // а не полночь: Visit Dubai и часть билетных систем так пишут дату.
  return {date:fmtDate.format(d),time:fmtTime.format(d)};
}
const MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
// «10 October 2026», «Oct 10, 2026» → 2026-10-10.
export function parseHumanDate(v){
  const s=clean(v).toLowerCase().replace(/,/g," ");
  let m=/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\s+(\d{4})$/.exec(s);
  let d,mo,y;
  if(m){d=+m[1];mo=MONTHS[m[2].slice(0,4)]||MONTHS[m[2].slice(0,3)];y=+m[3]}
  else if((m=/^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/.exec(s))){mo=MONTHS[m[1].slice(0,4)]||MONTHS[m[1].slice(0,3)];d=+m[2];y=+m[3]}
  else return null;
  if(!mo||!(d>=1&&d<=31)||!(y>=2000&&y<=2100))return null;
  return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}

// ---- Цена -------------------------------------------------------------------
// «AED125», «125», «From AED 99», «Free» → число AED или 0. Возраст «18+»
// и годы ценой не считаем.
export function parsePrice(v){
  if(typeof v==="number")return Number.isFinite(v)&&v>=0&&v<100000?v:null;
  const s=clean(v).toLowerCase();
  if(!s)return null;
  if(/^(free|free entry|free admission|complimentary)\b/.test(s))return 0;
  const m=/(?:aed|dhs?|د\.إ)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:aed|dhs?)\b|^(\d[\d,]*(?:\.\d+)?)$/.exec(s);
  if(!m)return null;
  const n=Number((m[1]||m[2]||m[3]).replace(/,/g,""));
  return Number.isFinite(n)&&n>=0&&n<100000?n:null;
}
export function priceLabel(min,{free=false}={}){
  if(free||min===0)return "Free";
  if(min===null||min===undefined)return null;
  return `from ${Math.round(min).toLocaleString("en-US")} AED`;
}

// ---- Рубрики ---------------------------------------------------------------
// Метки событий (cat_tags в файле) — небольшой фиксированный набор. Метка
// ставится по рубрике источника и по словам названия; описание источника
// участвует в разборе, но не сохраняется.
export const EVENT_TAGS=["concert","theatre","comedy","club","kids","sport","exhibition","festival","food","nightlife","tour"];
const RULES=[
  ["comedy",/\bcomed(?:y|ies|ian|ians)\b|\bstand[ -]?up\b(?! paddle)|\blaugh(?:ter|s|ing)?\b|\bcomic\b|\bimprov\b|\broast\b|\bcrowd work\b/],
  ["concert",/\bconcerts?\b|\borchestra\b|\bsymphon(?:y|ic)\b|\bphilharmon\w*|\brecital\b|\bband\b|\bgigs?\b|\bin concert\b|\bsings?\b|\bsinger\b|\bpiano\b|\bviolin\w*|\bjazz\b|\bqawwali\b|\bghazal\b|\bmehfil\b|\bsufi\b|\bacoustic\b|\bunplugged\b|\bchoir\b|\bopera\b(?! gallery)|\bmusic (?:festival|night|show)\b|\b(?:pop|rock|indie|rap|hip hop|classical|world) music\b|\blive music\b|\bbaithak\b|\bstrings\b|\bserenade\b/],
  ["theatre",/\btheat(?:re|er)\b|\bmusical\b|\bballet\b|\bopera\b(?! gallery)|\bon stage\b|\bstage show\b|\bdrama\b|\bcircus\b|\bacrobat\w*|\bmagic(?:ian)?\b|\billusion\w*|\bpuppet\w*|\bdance (?:show|performance|production)\b|\bflamenco\b|\bcabaret\b|\bdastangoi\b|\bpantomime\b|\bla perle\b|\bspoken word\b|\bpoetry\b/],
  ["club",/\bdj\b|\btechno\b|\bhouse music\b|\bafro ?house\b|\bnight ?club\b|\bclubbing\b|\brave\b|\bafter ?party\b|\bbeach club\b|\bpool party\b|\bparty\b|\bbollywood night\b|\bbolly\w* night\b|\bpacha\b|\bushuaia\b|\bsoho garden\b|\bwhite dubai\b|\bcavalli club\b|\bbase dubai\b|\bopal room\b|\bkeinemusik\b|\bmusic on\b|\bfrequency 971\b|\buntold\b|\b(?:bohemia|pacha icons) presents\b/],
  ["nightlife",/\bladies night\b|\bnight ?life\b|\blounge\b|\bbar crawl\b|\bpub quiz\b|\bkaraoke\b|\bbrunch party\b|\bopen bar\b|\bafter dark\b|\bsingles night\b|\bplease leave by 10\b/],
  ["kids",/\bkids?\b|\bchildren\b|\bchild\b|\bfamily\b|\bfamilies\b|\bjunior\b|\btoddlers?\b|\bdisney\b|\bcinderella\b|\bcaterpillar\b|\bfairy ?tales?\b|\bprincess\w*\b|\bpaw patrol\b|\bpeppa\b|\bcocomelon\b|\bbluey\b|\bfrozen\b|\bsesame street\b|\ball ages\b|\bclown\b|\bstorytelling\b|\bmasha and\b/],
  ["sport",/\bvs\.?\b|\bversus\b|\bbasketball\b|\bfootball\b|\bsoccer\b|\bcricket\b|\btennis\b|\bgolf\b|\bmarathon\b|\b\d+ ?k run\b|\bcommunity run\b|\btriathlon\b|\biron ?man\b|\bduathlon\b|\bracing\b|\brace\b|\bgrand prix\b|\bmma\b|\bufc\b|\bpfl\b|\bboxing\b|\bfight night\b|\bwrestling\b|\bwwe\b|\bchampionship\b|\bcup\b|\btrophy\b|\bopen water\b|\bswim\w*\b|\bcycl\w*\b|\bpadel\b|\brugby\b|\bsevens\b|\bsail ?gp\b|\bsail grand prix\b|\bregatta\b|\bpolo\b|\bhorse rac\w*|\bfitness\b|\bhyrox\b|\bspartan\b|\bilt20\b|\bfiba\b|\b3x3\b|\bt20\b|\bmatch(?:es)?\b|\bbatting\b|\bminigolf\b|\bwater ?ski\w*\b/],
  ["exhibition",/\bexhibitions?\b|\bexhibit\b|\bgaller(?:y|ies)\b|\bart (?:fair|show|week|walk|dubai|projects?)\b|\bmuseum\b|\binstallation\b|\bimmersive\b|\bdesign (?:week|days)\b|\bdowntown design\b|\bbiennale?\b|\bsculpture\w*\b|\bphotography\b|\bdigital art\b/],
  ["festival",/\bfestivals?\b(?! city)|\bfest\b|\bfiesta\b|\bcarnival\b|\bnavratri\b|\bgarba\b|\bdandiya\b|\bdiwali\b|\bdeepavali\b|\beid\b|\bnational day\b|\bnew year'?s?\b|\bnye\b|\bchristmas\b|\bhalloween\b|\boktoberfest\b|\bholi\b|\bramadan\b|\bcelebrations?\b|\bmarkets?\b|\bfair\b|\bkorea ?360\b|\bk ?town\b|\bpataakha\b/],
  ["food",/\bbrunch\b|\bdinner\b|\bfood\b|\bfoodies?\b|\bculinary\b|\bchefs?\b|\btasting\b|\bwine\b|\blunch\b|\bbreakfast\b|\bbuffet\b|\biftar\b|\bsuhoor\b|\bafternoon tea\b|\bhigh tea\b|\bset menu\b|\bdining\b|\bbbq\b|\bbarbecue\b|\bcanteen\b|\bstreet food\b|\bcooking\b|\bgastronom\w*|\bdim ?sums?\b|\bsushi\b|\bbeverages?\b|\bbeer\b/],
  ["tour",/\btours?\b|\bguided\b|\bsafari\b|\bcruise\b|\bhelicopter\b|\bheli\b|\bdesert\b|\bdhow\b|\byachts?\b|\bboats?\b|\babra\b(?! ?kadabra)|\bfishing\b|\bkayak\w*\b|\bsightseeing\b|\bexcursion\b|\bhot air balloon\b|\bseaplane\b|\bheritage walk\b|\bhop on hop off\b|\bpedalo\b|\btowable\b/]
];
// Описание источника длинное и пёстрое («для всей семьи», «art», «party» —
// почти везде), поэтому по нему ставятся только метки из явных слов и только
// когда название рубрику не назвало.
const RULES_STRICT=[
  ["comedy",/\bstand[ -]?up comed\w*|\bcomedian\b|\bcomedy (?:show|night|special)\b/],
  ["concert",/\bin concert\b|\blive concert\b|\bconcert\b|\borchestra\b|\bsinger\b|\bsongwriter\b|\bhis band\b|\bher band\b|\bgreatest hits\b|\bchart.?topping\b|\balbum\b/],
  ["theatre",/\bmusical\b|\bballet\b|\bstage production\b|\btheatre production\b|\bacrobat\w*|\bcircus\b|\bon stage\b/],
  ["club",/\bdj set\b|\btechno\b|\bhouse music\b|\bdance floor\b|\bnightclub\b|\bafro house\b|\bmelodic house\b/],
  ["kids",/\bfor kids\b|\bfor children\b|\bfamily.?friendly\b|\blittle ones\b|\bages \d+ ?(?:to|-) ?1[0-2]\b/],
  ["sport",/\btournament\b|\bchampionship\b|\bmarathon\b|\btriathlon\b|\bgrand prix\b|\bfixture\b/],
  ["exhibition",/\bexhibition\b|\binstallation\b|\bgallery\b/],
  ["festival",/\bfestival\b(?! city)/],
  ["food",/\bbrunch\b|\btasting menu\b|\bbuffet\b|\bfine dining\b/],
  ["tour",/\bguided tour\b|\bcruise\b|\bsafari\b|\bsightseeing\b/]
];
// Предложения «на любой день» (туры, лодки, бранчи, мастер-классы): у
// билетной системы есть дата ближайшего сеанса, но это не событие с афиши.
// На «что идёт сегодня» их не показываем — только если просят именно это.
export const EXPERIENCE_RE=/\btours?\b(?! 20\d\d)|\bcruise\b|\bsafari\b|\bheli\b|\bhelicopter\b|\byachts?\b|\bboats?\b|\babra\b(?! ?kadabra)|\bfishing\b|\bkayak\w*\b|\bpedalo\b|\btowable\b|\bwater ?ski\w*\b|\bhop on hop off\b|\bsightseeing\b|\bbreakfast\b|\bbrunch\b|\bbuffet\b|\blunch\b|\bhigh tea\b|\bafternoon tea\b|\btasting (?:menu|experience)\b|\bbeer flight\b|\bbeverages\b|\bdrinks\b.*\bplay\b|\bart therapy\b|\bresin\b|\bfluid art\b|\btexture art\b|\bsnack and paint\b|\balcohol ink\b|\btufting\b|\bcrochet\b|\bpilates\b|\bbowling\b|\bminigolf\b|\bbatting\b|\bworkshop\b|\bmasterclass\b|\bclass\b|\bwednesdays\b|\bsocials\b|\bunlimited\b/;
// Деловые события (саммиты, форумы, конгрессы): в афише для отдыха они
// только мешают; показываются, только если о них спросили прямо.
export const BUSINESS_RE=/\bsummit\b|\bforum\b|\bcongress\b|\bconference\b|\bsymposium\b|\bannual meeting\b|\bawards?\b|\binvestment\b|\binvest\b|\bfintech\b|\bwealth\b|\bcapital market\w*|\bexpo\b(?! city)|\bb2b\b|\btrade show\b|\bmasterclass for professionals\b|\breal estate\b|\bblockchain\b|\bcrypto\b|\btoken2049\b|\bmedical\b|\bimaging\b|\bmenactrims\b|\bgitex\b|\bintegrate\b|\beuroshop\b|\bsuperyacht summit\b|\bweek\b(?= .*\b(?:future|finance|tech)\b)|\bfuture week\b|\bfounders forum\b|\bexpand north star\b|\bnetworking\b|\bseminar\b|\bsuperreturn\b|\bworkshop for (?:professionals|businesses)\b/;
// Не события, а постоянные аттракционы и предложения (билет «на любой день»,
// сет-меню, детская игровая): у них нет «когда», и в ответ на «что сегодня
// идёт» они только отнимают место у настоящих событий. Места есть на карте.
export const NOT_EVENT_RE=/\bgeneral admission\b|\bopen[ -]?dated?\b|\bannual pass\b|\bday pass\b|\bseason pass\b|\bgift (?:card|voucher)\b|\bvouchers?\b|\bset menu\b|\bsoft play\b|\bplay ?area\b|\bplayground\b|\bwater ?park\b|\btheme park\b|\bwaterworld\b|\bski dubai\b|\bice rink\b|\btrampo\w*\b|\bearly bird special offer\b|\bvip packs?\b|\bparking\b|\bmerchandise\b|\bjersey\b|\bhoodie\b|\btote bag\b|\bbirthday package\b|\bcombo\b|\bbutterfly garden\b|\bmiracle garden\b|\bgarden glow\b|\bdolphinarium\b|\baquarium\b|\bzoo\b|\bsafari park\b|\bglobal village\b(?! .*\b(?:concert|show|live)\b)|\blouvre\b|\bmadame tussauds\b|\bmuseum of the future\b|\bburj khalifa\b|\bat the top\b|\bdubai frame\b|\bsky ?views?\b|\bimg worlds\b|\breal madrid world\b|\blegoland\b|\bmotiongate\b|\bkidzania\b|\bhuespace\b|\bhouse of hype\b|\bterra and vision\b|\bpavilion\b/;

// Рубрика источника → метки. Только у источников, где рубрика надёжна (путь
// страницы Dubai Opera — /events/<рубрика>/…). Рубрику District не берём:
// пивная дегустация там бывает «Comedy».
const SOURCE_CATS=[
  [/comedy|stand ?up/,["comedy"]],
  [/concert|music|pop|rock|jazz|indie|folk|piano|classical|orchestra|arabic|bollywood|hip ?hop|rap/,["concert"]],
  [/theat|ballet|opera|musical|acrobat|dance|drama|circus|magic|live performance/,["theatre"]],
  [/nightlife|club|party|electronic/,["club","nightlife"]],
  [/kid|family|children/,["kids"]],
  [/sport|basketball|football|cricket|tennis|fight|mma|motor|racing/,["sport"]],
  [/exhibition|museum|gallery/,["exhibition"]],
  [/festival/,["festival"]],
  [/food|brunch|dining|culinary/,["food"]]
];
export function classify({title="",sourceCategory="",venue="",extra=""}={}){
  const t=norm(title),sc=norm(sourceCategory),v=norm(venue),x=norm(extra);
  const tags=new Set();
  // Название — главный признак. Рубрика источника и анонс помогают, только
  // если название ничего не сказало («Hanné» — кто это? анонс: «in concert»).
  const titleTags=RULES.filter(([,re])=>re.test(t)).map(([k])=>k);
  titleTags.forEach(z=>tags.add(z));
  if(sc)for(const [re,ts] of SOURCE_CATS)if(re.test(sc))ts.forEach(z=>tags.add(z));
  if(!tags.size)for(const [k,re] of RULES_STRICT)if(re.test(x))tags.add(k);
  // Комедия — это шоу, а не концерт: «Live at Dubai Comedy Festival» не
  // делает стендап концертом и фестивалем одновременно.
  if(tags.has("comedy")){tags.delete("concert");tags.delete("festival")}
  // «All of Me Tour», «World Tour 2026» — гастроли, а не экскурсия: «tour»
  // остаётся, только если в названии лодка, сафари, вертолёт и т. п.
  const tourish=/\b(?:guided|safari|cruise|heli\w*|desert|dhow|yachts?|boats?|abra(?! ?kadabra)|fishing|kayak\w*|sightseeing|hop on hop off|pedalo|towable|excursion|seaplane|balloon)\b/.test(t);
  if((tags.has("concert")||tags.has("comedy")||tags.has("theatre")||tags.has("sport"))&&!tourish)tags.delete("tour");
  // «Shaan – All of Me Tour» в Coca-Cola Arena — концерт: просто «tour» без
  // лодки и сафари на концертной площадке или с певцом в анонсе.
  if(tags.has("tour")&&!tourish&&(/\b(?:arena|opera|theat(?:re|er)|hall|amphitheat(?:re|er)|stadium|auditorium|jubilee park)\b/.test(v)||/\bconcert\b|\bsinger\b|\bsongwriter\b|\bband\b|\balbum\b/.test(x))){tags.delete("tour");tags.add("concert")}
  // Площадка подсказывает рубрику: вечер в бич-клубе — ночная жизнь,
  // спектакль в театре — театр, если ничего другого нет.
  if(/\bbeach club\b|\bpacha\b|\bushuaia\b|\bopal room\b|\bsoho garden\b|\bwhite dubai\b|\bnight ?club\b|\bvice club\b|\bavenue club\b/.test(v)&&!tags.has("food"))tags.add("club");
  if(!tags.size&&/\btheat(?:re|er)\b|\bopera\b|\bplayhouse\b/.test(v))tags.add("theatre");
  if(!tags.size&&/\barena\b|\bamphitheatre\b/.test(v))tags.add("concert");
  if(!tags.size&&/\bstadium\b/.test(v))tags.add("sport");
  if(tags.has("club"))tags.add("nightlife");
  if(tags.has("comedy"))tags.add("theatre");
  // Деловое — по названию: «Megacampus Summit» с «концертом» в описании
  // остаётся саммитом.
  const business=BUSINESS_RE.test(t)&&!titleTags.some(k=>k==="concert"||k==="comedy"||k==="theatre"||k==="club");
  const experience=!business&&EXPERIENCE_RE.test(t)&&!["concert","comedy","club","festival","theatre"].some(k=>tags.has(k));
  const list=EVENT_TAGS.filter(z=>tags.has(z));
  return {cat_tags:business?list.filter(z=>z==="exhibition"):list,business,experience};
}
const LABEL={comedy:"Comedy",concert:"Concert",theatre:"Theatre",club:"Nightlife",nightlife:"Nightlife",kids:"Kids & Family",sport:"Sport",exhibition:"Exhibition",festival:"Festival",food:"Food & Drink",tour:"Tour"};
const LABEL_ORDER=["comedy","concert","club","kids","theatre","sport","exhibition","festival","food","tour","nightlife"];
export function categoryLabel(tags=[],business=false){
  if(business)return "Conference";
  for(const k of LABEL_ORDER)if(tags.includes(k)){
    // Детский спектакль — «Kids & Family», а не «Theatre»: родителю важнее, кому он.
    if(k==="theatre"&&tags.includes("kids"))return LABEL.kids;
    return LABEL[k];
  }
  return "Event";
}

// ---- Ссылки ----------------------------------------------------------------
export function safeUrl(u,base){
  try{const x=new URL(text(u).trim(),base);return /^https?:$/.test(x.protocol)?x.href:null}catch{return null}
}
const PROVIDERS=[
  [/(^|\.)platinumlist\.net$/,"Platinumlist"],[/(^|\.)district\.(ae|in)$/,"District"],[/(^|\.)dubaiopera\.com$/,"Dubai Opera"],
  [/(^|\.)coca-cola-arena\.com$/,"Coca-Cola Arena"],[/(^|\.)ticketmaster\.ae$/,"Ticketmaster"],[/(^|\.)livenation\.me$/,"Live Nation"],
  [/(^|\.)visitdubai\.com$/,"Visit Dubai"],[/(^|\.)virginmegastore\.ae$/,"Virgin Megastore Tickets"],[/(^|\.)premieronline\.com$/,"Premier Online"],
  [/(^|\.)bohemiadubai\.com$/,"Bohemia"],[/(^|\.)pachaicons\.com$/,"Pacha ICONS"],[/(^|\.)sailgp\.com$/,"SailGP"]
];
export function providerOf(url){
  let h="";try{h=new URL(url).hostname.toLowerCase()}catch{return null}
  for(const [re,name] of PROVIDERS)if(re.test(h))return name;
  return h.replace(/^www\./,"")||null;
}
/**
 * Партнёрская ссылка на билет. Platinumlist: PLATINUMLIST_AFF — код партнёра
 * (ссылка ведёт через https://platinumlist.net/aff/?ref=<код>&link=<страница>),
 * либо PLATINUMLIST_AFF_TEMPLATE — свой шаблон с {url} (адрес страницы,
 * закодированный) и {raw}. District: DISTRICT_AFF — строка параметров
 * («ref=free»), добавляется к ссылке. Остальные билетные сайты: EVENTS_UTM —
 * строка параметров (например «utm_source=free&utm_medium=concierge»).
 * Пустые переменные — ссылка без изменений.
 */
export function affiliateUrl(url,env=process.env){
  const u=safeUrl(url);
  if(!u)return null;
  const host=new URL(u).hostname.toLowerCase();
  const addParams=(href,qs)=>{
    if(!qs)return href;
    const x=new URL(href);
    for(const [k,v] of new URLSearchParams(String(qs).replace(/^[?&]/,"")))if(!x.searchParams.has(k))x.searchParams.set(k,v);
    return x.href;
  };
  if(/(^|\.)platinumlist\.net$/.test(host)){
    if(/\/aff\/?$/.test(new URL(u).pathname))return u;          // уже партнёрская
    const tpl=text(env.PLATINUMLIST_AFF_TEMPLATE).trim();
    if(tpl&&tpl.includes("{"))return tpl.replace(/\{url\}/g,encodeURIComponent(u)).replace(/\{raw\}/g,u);
    const ref=text(env.PLATINUMLIST_AFF).trim();
    if(ref&&/^[A-Za-z0-9_-]{1,64}$/.test(ref))return `https://platinumlist.net/aff/?ref=${encodeURIComponent(ref)}&link=${encodeURIComponent(u)}`;
    return u;
  }
  if(/(^|\.)district\.(ae|in)$/.test(host))return addParams(u,text(env.DISTRICT_AFF).trim()||text(env.EVENTS_UTM).trim());
  return addParams(u,text(env.EVENTS_UTM).trim());
}

// ---- Районы ----------------------------------------------------------------
const toRad=(v)=>v*Math.PI/180;
export function haversineKm(a,b){
  const dlat=toRad(b.lat-a.lat),dlon=toRad(b.lon-a.lon);
  const z=Math.sin(dlat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dlon/2)**2;
  return 2*6371*Math.asin(Math.sqrt(z));
}
export function inDubai(c){return Boolean(c)&&c.lat>=DUBAI_BBOX.south&&c.lat<=DUBAI_BBOX.north&&c.lon>=DUBAI_BBOX.west&&c.lon<=DUBAI_BBOX.east}
// Район по ближайшему центру района из city.mjs (в пределах 3 км).
export function areaFor(coords,districts=[]){
  if(!coords)return null;
  let best=null,bd=Infinity;
  for(const d of districts){const k=haversineKm(coords,d);if(k<bd){bd=k;best=d}}
  return best&&bd<=3?best.name:null;
}
export function coordsOf(geo){
  if(!geo||typeof geo!=="object")return null;
  const lat=Number(geo.latitude??geo.lat),lon=Number(geo.longitude??geo.lon??geo.lng);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||(lat===0&&lon===0))return null;
  return {lat:Math.round(lat*1e6)/1e6,lon:Math.round(lon*1e6)/1e6};
}
// «25.2045,55.2653» (Visit Dubai) → координаты.
export function coordsFromPair(s){
  const m=/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text(s));
  return m?coordsOf({latitude:+m[1],longitude:+m[2]}):null;
}

// ---- JSON-LD ---------------------------------------------------------------
export function jsonLdBlocks(html){
  const out=[];
  const re=/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while((m=re.exec(text(html)))){
    try{out.push(JSON.parse(m[1].trim()))}catch{/* битый блок пропускаем */}
  }
  return out;
}
const isEventType=(t)=>{const a=Array.isArray(t)?t:[t];return a.some(x=>/Event$/.test(text(x))&&!/^(EventSeries|EventReservation)$/.test(text(x)))};
export function jsonLdEvents(html){
  const out=[];
  const walk=(n,depth=0)=>{
    if(!n||depth>6)return;
    if(Array.isArray(n)){n.forEach(x=>walk(x,depth+1));return}
    if(typeof n!=="object")return;
    if(isEventType(n["@type"])&&n.name&&n.startDate)out.push(n);
    if(n["@graph"])walk(n["@graph"],depth+1);
    if(n.itemListElement)walk(n.itemListElement,depth+1);
    if(n.item&&typeof n.item==="object")walk(n.item,depth+1);
    if(n.subEvent)walk(n.subEvent,depth+1);
  };
  for(const b of jsonLdBlocks(html))walk(b);
  return out;
}
function firstImage(img){
  if(!img)return null;
  if(Array.isArray(img))return firstImage(img[0]);
  if(typeof img==="object")return safeUrl(img.url||img.contentUrl);
  return safeUrl(img);
}
// Цена «от»: наименьшая ненулевая. Ноль среди тарифов — обычно «дети до 3 лет
// бесплатно» или бесплатная регистрация при платном входе; «Free» пишем,
// только когда платных тарифов нет вовсе.
export function offerMin(offers){
  const list=Array.isArray(offers)?offers:offers?[offers]:[];
  const prices=[];
  for(const o of list){
    if(!o||typeof o!=="object")continue;
    const cur=text(o.priceCurrency).toUpperCase();
    if(cur&&cur!=="AED")continue;
    for(const v of [o.lowPrice,o.price,o.highPrice,...(Array.isArray(o.offers)?o.offers.map(x=>x&&x.price):[])]){
      const n=typeof v==="number"?v:parsePrice(text(v));
      if(n!==null)prices.push(n);
    }
  }
  if(!prices.length)return null;
  const pos=prices.filter(n=>n>0);
  return pos.length?Math.min(...pos):0;
}
function offerUrl(offers){
  const list=Array.isArray(offers)?offers:offers?[offers]:[];
  for(const o of list)if(o&&o.url)return safeUrl(o.url);
  return null;
}
function placeOf(loc){
  const l=Array.isArray(loc)?loc[0]:loc;
  if(!l||typeof l!=="object")return {name:clean(text(l)),address:"",coords:null};
  const a=l.address;
  const address=typeof a==="string"?clean(a):a&&typeof a==="object"?[a.streetAddress,a.addressLocality,a.addressRegion].map(clean).filter(Boolean).join(", "):"";
  return {name:clean(l.name),address,coords:coordsOf(l.geo)};
}
/**
 * Событие schema.org → запись афиши (без id и fetched_at: их ставит сборщик).
 * opts: {source:"district", pageUrl, sourceCategory, schedules:[{date,time}]}
 */
export function normalizeJsonLdEvent(ev,opts={}){
  if(!ev||typeof ev!=="object")return null;
  const name=clean(ev.name);
  if(!name)return null;
  if(/EventCancelled|EventPostponed/i.test(text(ev.eventStatus)))return null;
  const st=localDateTime(ev.startDate),en=localDateTime(ev.endDate);
  if(!st)return null;
  const place=placeOf(ev.location);
  const schedules=(opts.schedules||[]).filter(s=>s&&/^\d{4}-\d{2}-\d{2}$/.test(s.date)).sort((a,b)=>(a.date+(a.time||"")).localeCompare(b.date+(b.time||"")));
  let date_start=st.date,date_end=en&&en.date>=st.date?en.date:st.date,time=st.time;
  // Конец «в полночь» после вечернего начала — это та же ночь, а не следующий день.
  if(en&&en.time==="00:00"&&en.date===addDays(st.date,1)&&st.time)date_end=st.date;
  if(en&&st.time&&en.time&&daysBetween(st.date,en.date)===1&&en.time<"07:00")date_end=st.date;
  if(schedules.length){date_start=schedules[0].date;date_end=schedules[schedules.length-1].date;time=schedules[0].time||time}
  const pmin=offerMin(ev.offers);
  const free=ev.isAccessibleForFree===true||pmin===0;
  const page=safeUrl(opts.pageUrl)||safeUrl(ev.url);
  const booking=offerUrl(ev.offers)||page;
  const venue=place.name||clean(opts.venue)||"";
  const cls=classify({title:name,sourceCategory:opts.sourceCategory||"",venue,extra:[text(ev.keywords),opts.extra||""].join(" ")});
  return {
    name,category:categoryLabel(cls.cat_tags,cls.business),cat_tags:cls.cat_tags,business:cls.business,experience:cls.experience,
    date_start,date_end,time:time||null,
    dates:schedules.length?schedules.map(s=>({date:s.date,time:s.time||null})):undefined,
    venue,address:place.address||null,coords:place.coords,
    price_min:free?0:pmin,price:priceLabel(free?0:pmin,{free}),
    booking_url:booking,ticket_url:booking,booking_kind:"tickets",booking_provider:providerOf(booking),
    image_url:firstImage(ev.image),source:page,summary:null
  };
}

// ---- Visit Dubai: XML-лента событий ----------------------------------------
// https://www.visitdubai.com/events-en.xml (указана в robots.txt как Sitemap).
export function parseVisitDubaiXml(xml){
  const out=[];
  const re=/<event\b[^>]*>([\s\S]*?)<\/event>/g;
  let m;
  while((m=re.exec(text(xml)))){
    const body=m[1],f={};
    const fr=/<([A-Za-z]+)>([\s\S]*?)<\/\1>|<([A-Za-z]+)\s*\/>/g;let k;
    while((k=fr.exec(body)))if(k[1])f[k[1]]=decodeEntities(k[2].replace(/^<!\[CDATA\[|\]\]>$/g,"")).trim();
    out.push(f);
  }
  return out;
}
export function normalizeVisitDubai(f){
  const name=clean(f.title);
  const date_start=parseHumanDate(f.startDate),date_end0=parseHumanDate(f.endDate);
  if(!name||!date_start)return null;
  const date_end=date_end0&&date_end0>=date_start?date_end0:date_start;
  const coords=coordsFromPair(f.location);
  const venue=clean(f.address)||"";
  const pmin=parsePrice(f.ticketPrice);
  const page=safeUrl(f.url);
  const ticket=safeUrl(f.buyTicketUrl);
  const cls=classify({title:name,venue,extra:[f.intro,f.text].join(" ")});
  return {
    name,category:categoryLabel(cls.cat_tags,cls.business),cat_tags:cls.cat_tags,business:cls.business,experience:cls.experience,
    date_start,date_end,time:null,venue,address:null,coords,
    price_min:pmin,price:priceLabel(pmin),
    booking_url:ticket||page,ticket_url:ticket||null,booking_kind:"tickets",booking_provider:ticket?providerOf(ticket):"Visit Dubai",
    image_url:safeUrl(f.image),source:page,
    // Короткий анонс Visit Dubai (одна строка) — единственный текст, который
    // храним; полное описание не копируем.
    summary:f.intro?clamp(f.intro,200):null,
    source_id:text(f.id).replace(/[{}]/g,"")||text(f.name)
  };
}

// ---- Dubai Opera: расписание из данных страницы ----------------------------
// В JSON-LD у Dubai Opera одна дата без времени; все показы с временем лежат
// в данных Next.js на той же странице: "schedules":[{"date":"2026-10-08",
// "time_slot":{"start_time":"20:00",...}}]. Кавычки там экранированы.
export function dubaiOperaSchedules(html){
  const s=text(html).replace(/\\"/g,'"');
  const out=[],seen=new Set();
  const re=/"schedule_id":\d+,"date":"(\d{4}-\d{2}-\d{2})","time_slot":\{"start_time":"(\d{2}:\d{2})/g;
  let m;
  while((m=re.exec(s))){const k=m[1]+" "+m[2];if(!seen.has(k)){seen.add(k);out.push({date:m[1],time:m[2]})}}
  return out;
}
// Рубрика Dubai Opera — второй сегмент пути: /en/events/<рубрика>/<событие>.
export function dubaiOperaCategory(url){
  const m=/\/events\/([a-z0-9-]+)\/[a-z0-9-]+\/?$/i.exec(text(url));
  return m?m[1].replace(/-/g," "):"";
}
// District: город и рубрика из данных страницы ("city":"Dubai","category_id":{..."name":"Comedy"}).
export function districtMeta(html){
  const s=text(html).replace(/\\"/g,'"');
  const city=(/"city":"([^"]{2,40})","category_id"/.exec(s)||[])[1]||null;
  const cat=(/"category_id":\{"_id":"[a-f0-9]+","name":"([^"]{1,40})"/.exec(s)||[])[1]||null;
  return {city,category:cat&&!/^all$/i.test(cat)?cat:null};
}

// ---- Склейка одинаковых событий из разных источников -----------------------
const STOP=new Set(["the","a","an","and","of","at","in","on","live","dubai","presents","present","show","tickets","ticket","by","with","feat","ft","x","vs","festival","comedy","concert","tour","2026","2027","uae","night","s"]);
export function titleTokens(s){return norm(s).split(" ").filter(w=>w.length>1&&!STOP.has(w))}
function venueKey(v){return titleTokens(String(v||"").split(",")[0]).slice(0,3).join(" ")}
export function sameEvent(a,b){
  if(!a||!b)return false;
  const da=a.date_start,db=b.date_start;
  const overlap=!(a.date_end<b.date_start||b.date_end<a.date_start);
  if(da!==db&&!overlap)return false;
  // Площадка: совпала по имени или точки рядом (до 400 м).
  const near=a.coords&&b.coords&&haversineKm(a.coords,b.coords)<=0.4;
  const va=venueKey(a.venue),vb=venueKey(b.venue);
  const sameVenue=near||(va&&vb&&(va===vb||va.includes(vb)||vb.includes(va)));
  if(!sameVenue)return false;
  const ta=new Set(titleTokens(a.name)),tb=new Set(titleTokens(b.name));
  if(!ta.size||!tb.size)return norm(a.name)===norm(b.name);
  const inter=[...ta].filter(w=>tb.has(w)).length;
  const small=Math.min(ta.size,tb.size);
  // «Dubai Comedy Festival: Mo Gilligan» и «Mo Gilligan Live at Dubai Comedy
  // Festival» — все значимые слова короткого названия есть в длинном.
  return inter>=1&&(inter/small>=0.75||inter/Math.max(ta.size,tb.size)>=0.5);
}
// Порядок доверия к полям: у билетной системы и площадки — время, цена и
// ссылка на покупку; у Visit Dubai — координаты и краткий анонс.
export const SOURCE_RANK={dubaiopera:3,district:2,visitdubai:1};
export function mergeEvents(a,b){
  const [hi,lo]=(SOURCE_RANK[b.source_key]||0)>(SOURCE_RANK[a.source_key]||0)?[b,a]:[a,b];
  const out={...lo,...Object.fromEntries(Object.entries(hi).filter(([,v])=>v!==null&&v!==undefined&&v!==""&&!(Array.isArray(v)&&!v.length)))};
  out.cat_tags=EVENT_TAGS.filter(t=>(a.cat_tags||[]).includes(t)||(b.cat_tags||[]).includes(t));
  if(hi.business!==lo.business)out.business=Boolean(hi.business&&lo.business);
  // Событие из календаря Visit Dubai или афиши Dubai Opera — событие, даже
  // если у билетной системы оно выглядит как предложение «на любой день».
  const curated=[a,b].some(x=>x.source_key!=="district"&&!x.experience);
  out.experience=!curated&&Boolean(a.experience||b.experience);
  out.category=categoryLabel(out.cat_tags,out.business);
  out.coords=hi.coords||lo.coords||null;
  out.price_min=hi.price_min??lo.price_min??null;
  out.price=priceLabel(out.price_min);
  out.time=hi.time||lo.time||null;
  // Точное расписание (показы площадки) важнее диапазона из календаря;
  // без расписания берём объединение диапазонов.
  if(hi.dates&&hi.dates.length){out.date_start=hi.date_start;out.date_end=hi.date_end;out.dates=hi.dates}
  else{
    out.date_start=hi.date_start<lo.date_start?hi.date_start:lo.date_start;
    out.date_end=hi.date_end>lo.date_end?hi.date_end:lo.date_end;
    if(lo.dates&&lo.dates.length)out.dates=lo.dates;
  }
  out.summary=hi.summary||lo.summary||null;
  out.image_url=hi.image_url||lo.image_url||null;
  out.also=[...new Set([...(a.also||[]),...(b.also||[]),a.source,b.source].filter(Boolean))].filter(u=>u!==out.source);
  return out;
}
export function dedupeEvents(list){
  const out=[];
  for(const e of list){
    const i=out.findIndex(x=>sameEvent(x,e));
    if(i<0)out.push(e);else out[i]=mergeEvents(out[i],e);
  }
  return out;
}
