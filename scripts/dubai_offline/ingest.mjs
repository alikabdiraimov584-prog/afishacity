process.env.CITY="dubai";
const [,,IN,OUT]=process.argv;
const fs=await import("node:fs");
const {createSnapshot,snapshotAcceptable}=await import(new URL("../../osm_snapshot.mjs",import.meta.url));
const {CATEGORIES}=await import(new URL("../../categories.mjs",import.meta.url));
const {structuralTags}=await import(new URL("../../osm_tags.mjs",import.meta.url));
const data=JSON.parse(fs.readFileSync(IN,"utf8"));
for(const f of [OUT,OUT+".building",OUT+".building-wal",OUT+".building-shm"])try{fs.rmSync(f,{force:true})}catch{}
const snap=createSnapshot(OUT,{resume:false});
const targets=CATEGORIES.filter(c=>c.osm&&c.osm.length);
let total=0;const empty=[];
// В англоязычном интерфейсе место без латинского имени не прочесть: только
// арабское, китайское или кириллица («алкалааа», «Казань») — пропускаем.
const LATIN=/[A-Za-z]/;let dropped=0;
// Конторы и подрядчики под потребительской рубрикой — и в OSM тоже
// («Bollywood Film International Equipment Trading» как кинотеатр).
const B2B=/\b(contracting|contractors?|construction|maintenance|technical services|manufactur\w*|wholesale|industries|logistics|freight|cargo|engineering|consultan\w*|real estate|properties|investments?|holding|equipment trading|equipment|machinery|welding|scaffold\w*|recruitment|manpower|publishing|printing press|advertising|fit ?out)\b/i;
const readable=(e)=>{const t=e.tags||{};const n=t["name:en"]||t.name||t.brand||"";if(!n)return false;if(B2B.test(n)&&!t.tourism&&!t.amenity?.match(/^(restaurant|cafe|bar|pub|fast_food)$/)){dropped++;return false}if(LATIN.test(n))return true;dropped++;return false};
// «طيف الإمارات للعطور Taif Al Emarat Perfume» → «Taif Al Emarat Perfume»:
// в смешанном имени оставляем латинскую часть.
const ARABIC=/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]+/g;
function cleanNames(e){
  const t=e.tags||{};
  if(!t["name:en"]&&t.name&&LATIN.test(t.name)&&ARABIC.test(t.name)){
    ARABIC.lastIndex=0;
    const en=t.name.replace(ARABIC," ").replace(/[\s\-–—|,/()]+$/,"").replace(/^[\s\-–—|,/()]+/,"").replace(/\s{2,}/g," ").trim();
    if(LATIN.test(en))t["name:en"]=en;
  }
  ARABIC.lastIndex=0;
}
let labelled=0,translated=0,photos=0;
// Фото с сайтов мест, собранные заранее (photos/harvest.py): сайт → кадр.
const PHOTO_FILE=process.env.SITE_PHOTOS||IN.replace(/[^/]+$/,"photos/site_photos.jsonl");
const SITE_PHOTO=new Map();
if(fs.existsSync(PHOTO_FILE)){
  for(const line of fs.readFileSync(PHOTO_FILE,"utf8").split("\n")){
    if(!line.trim())continue;
    try{const r=JSON.parse(line);if(r.img&&r.site)SITE_PHOTO.set(r.site,r)}catch{}
  }
}
// Проверка кадров (photos/vqa2.py): логотипы, плакаты и заглушки отсеяны.
const QA_FILE=PHOTO_FILE.replace(/site_photos\.jsonl$/,"site_photos_qa2.json");
const PHOTO_OK=fs.existsSync(QA_FILE)?new Set(Object.entries(JSON.parse(fs.readFileSync(QA_FILE,"utf8"))).filter(([,v])=>v&&v.ok).map(([u])=>u)):null;
// Текст на кадре (photos/ocr.py): плакат с акцией или реклама казино — не фото места.
const OCR_FILE=PHOTO_FILE.replace(/site_photos\.jsonl$/,"site_photos_ocr.json");
const OCR=fs.existsSync(OCR_FILE)?JSON.parse(fs.readFileSync(OCR_FILE,"utf8")):{};
const textHeavy=(img)=>{const o=OCR[img];return !!(o&&(o.gamble||o.n>=3))};
// Сайт заведения захвачен (казино, «слоты») или припаркован (домен продаётся,
// photos/spam.py): ни ссылку, ни картинку оттуда человеку не даём.
const CHECK_FILE=PHOTO_FILE.replace(/site_photos\.jsonl$/,"site_check.json");
const SITE_CHECK=fs.existsSync(CHECK_FILE)?JSON.parse(fs.readFileSync(CHECK_FILE,"utf8")):{};
let deadSites=0,textDropped=0;
const siteOf=(t)=>{let s=String(t.website||t["contact:website"]||t.url||"").trim();if(s&&!s.includes("://"))s="http://"+s;return s};
function dropBadSite(t){
  const s=siteOf(t);if(!s)return;
  const c=SITE_CHECK[s];
  if(c&&(c.v==="spam"||c.v==="parked")){delete t.website;delete t["contact:website"];delete t.url;deadSites++}
}
// Один сайт на многих мест: у сети это свой сайт («Tim Hortons» —
// timhortonsgcc.com), а у портала или оператора — чужой (dubai-marina.com у
// ресторана, cravia.com у «Cinnabon»). Кадр с чужого сайта — не фото места.
// Часы, цены, онлайн-бронь и меню с собственных сайтов мест (site_meta/).
const {loadSiteMeta,applySiteMeta}=await import(new URL("./site_meta/apply_site_meta.mjs",import.meta.url));
const SITE_META=loadSiteMeta(process.env.SITE_META||IN.replace(/[^/]+$/,"photos/site_meta.jsonl"));let siteMetaTags=0;
const SITE_USERS=new Map();
for(const c of targets)for(const e of data[c.tag]||[]){
  const s=siteOf(e.tags||{});if(!s)continue;
  const id=`${e.type}/${e.id}`;let m=SITE_USERS.get(s);if(!m)SITE_USERS.set(s,m=new Set());m.add(id);
}
const STOP=new Set("dubai uae emirates emirate arabia arab middle east group the and restaurant restaurants cafe hotel hotels resort llc fze trading center centre shop store mall marina jumeirah deira karama barsha palm downtown business bay creek city tower towers plaza branch international world global services company".split(" "));
const fold=(v)=>String(v||"").normalize("NFKD").replace(/[̀-ͯ]/g,"").toLowerCase();
function nameMatchesSite(t,s){
  let host="";try{host=new URL(s).hostname.replace(/^www\d?\./,"")}catch{return true}
  const hostC=fold(host).replace(/[^a-z0-9]/g,""),core=fold(host.split(".")[0]).replace(/[^a-z0-9]/g,"");
  const names=[t["name:en"],t.name,t.brand,t.operator].filter(Boolean).map(fold);
  for(const n of names){
    const compact=n.replace(/[^a-z0-9]/g,"");
    if(core.length>=4&&compact.includes(core))return true;
    for(const w of n.split(/[^a-z0-9']+/).map(x=>x.replace(/'/g,"")))if(w.length>=4&&!STOP.has(w)&&hostC.includes(w))return true;
  }
  return false;
}
let foreignDropped=0;
function attachPhoto(t){
  if(t["free:photo"])return;
  const s=siteOf(t);
  if(!s)return;
  const r=SITE_PHOTO.get(s);if(!r)return;
  if(PHOTO_OK&&!PHOTO_OK.has(r.img))return;
  if(textHeavy(r.img)){textDropped++;return}
  if((SITE_USERS.get(s)?.size||0)>=3&&!nameMatchesSite(t,s)){foreignDropped++;return}
  t["free:photo"]=r.img;if(r.w)t["free:photo_w"]=String(r.w);if(r.h)t["free:photo_h"]=String(r.h);t["free:photo_site"]=s;photos++;
}
// Улица в адресе по-арабски → английское имя той же улицы из OSM.
const STREETS=fs.existsSync(IN.replace(/[^/]+$/,"streets.json"))?JSON.parse(fs.readFileSync(IN.replace(/[^/]+$/,"streets.json"),"utf8")):{};
function enStreet(t){
  const v=t["addr:street"];if(!v||t["addr:street:en"]||!ARABIC.test(v)){ARABIC.lastIndex=0;return}
  ARABIC.lastIndex=0;
  if(STREETS[v]){t["addr:street:en"]=STREETS[v];translated++}
}
// Только английское имя (name:en без name): в OSM Дубая так записаны Ossiano и
// CÉ LA VI — снимок требует name и молча выбрасывал такие места.
function nameFromEn(t){if(!t.name&&t["name:en"]){t.name=t["name:en"];namedFromEn++}}
let namedFromEn=0,closedDropped=0;
// free:status=closed (curate.py) — место закрыто навсегда: в карту не попадает.
// temporarily_closed остаётся с пометкой: о нём спрашивают, и ответ «закрыто
// до 2027» полезнее, чем «не нашёл».
const open=(e)=>{if(e.tags?.["free:status"]==="closed"){closedDropped++;return false}return true};
// Обработка каждого места — цепочка функций (tags, element, category) → void.
// Новый шаг (часы и цены с сайтов, ссылки на бронь) — ещё одна функция в APPLY.
const APPLY=[
  (t,e)=>cleanNames(e),
  nameFromEn,enStreet,dropBadSite,attachPhoto,
  (t,e)=>{const s=siteOf(t),r=s&&SITE_META.get(s);if(r)siteMetaTags+=applySiteMeta(t,r,{lat:e.lat??e.center?.lat,lon:e.lon??e.center?.lon,users:SITE_USERS.get(s)?.size||1}).length},
  // Контора с пометкой «достопримечательность» (муниципалитет, офис) — не
  // то, куда зовут гулять: пометку снимаем, рубрика остаётся.
  (t,e)=>{if(t.tourism==="attraction"&&t.office){delete t.tourism;e._notSight=true}},
  // Место пришло в категорию по имени («Shisha Art»), а своей рубрики в OSM
  // нет — подписывалось «Venue» и не считалось этой категорией.
  (t,e,c)=>{if(!t["free:category"]&&!structuralTags(t).length){t["free:category"]=c.tag;labelled++}}
];
for(const c of targets){
  const els=(data[c.tag]||[]).filter(readable).filter(open);
  for(const e of els)for(const f of APPLY)f(e.tags,e,c);
  if(!els.length)empty.push(c.tag);
  const keep=c.tag==="sights"?els.filter(e=>!e._notSight):els;
  for(let i=0;i<keep.length;i+=2000)total=snap.put(keep.slice(i,i+2000),c.tag);
  snap.markDone(c.tag);
}
const v=snapshotAcceptable({total,failed:0,targets:targets.length});
const res=snap.finish({source:"osm+overture"});
console.log(JSON.stringify({site_meta:SITE_META.size,site_meta_tags:siteMetaTags,site_photos:SITE_PHOTO.size,with_photo:photos,text_dropped:textDropped,dead_sites:deadSites,foreign_site:foreignDropped,dropped_nonlatin:dropped,closed_dropped:closedDropped,named_from_en:namedFromEn,labelled,translated,streets:Object.keys(STREETS).length,categories:targets.length,places:res.places,verdict:v,empty,size_mb:+(fs.statSync(OUT).size/1048576).toFixed(1)}));
