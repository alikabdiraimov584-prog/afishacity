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
let labelled=0,translated=0;
// Улица в адресе по-арабски → английское имя той же улицы из OSM.
const STREETS=fs.existsSync(IN.replace(/[^/]+$/,"streets.json"))?JSON.parse(fs.readFileSync(IN.replace(/[^/]+$/,"streets.json"),"utf8")):{};
function enStreet(t){
  const v=t["addr:street"];if(!v||t["addr:street:en"]||!ARABIC.test(v)){ARABIC.lastIndex=0;return}
  ARABIC.lastIndex=0;
  if(STREETS[v]){t["addr:street:en"]=STREETS[v];translated++}
}
for(const c of targets){
  const els=(data[c.tag]||[]).filter(readable);
  for(const e of els){
    cleanNames(e);enStreet(e.tags);
    // Контора с пометкой «достопримечательность» (муниципалитет, офис) — не
    // то, куда зовут гулять: пометку снимаем, рубрика остаётся.
    if(e.tags.tourism==="attraction"&&e.tags.office){delete e.tags.tourism;e._notSight=true}
    // Место пришло в категорию по имени («Shisha Art»), а своей рубрики в OSM
    // нет — подписывалось «Venue» и не считалось этой категорией.
    if(!e.tags["free:category"]&&!structuralTags(e.tags).length){e.tags["free:category"]=c.tag;labelled++}
  }
  if(!els.length)empty.push(c.tag);
  const keep=c.tag==="sights"?els.filter(e=>!e._notSight):els;
  for(let i=0;i<keep.length;i+=2000)total=snap.put(keep.slice(i,i+2000),c.tag);
  snap.markDone(c.tag);
}
const v=snapshotAcceptable({total,failed:0,targets:targets.length});
const res=snap.finish({source:"osm+overture"});
console.log(JSON.stringify({dropped_nonlatin:dropped,labelled,translated,streets:Object.keys(STREETS).length,categories:targets.length,places:res.places,verdict:v,empty,size_mb:+(fs.statSync(OUT).size/1048576).toFixed(1)}));
