// Каскад фотографий места.
//
// Правило, ради которого файл существует: карточка показывает САМО МЕСТО, а не
// агрегатор, через который оно нашлось. Поэтому источник картинки выбирается по
// убыванию достоверности и ОБЯЗАН закончиться кадром, который мы рисуем сами:
//
//   T1  теги OpenStreetMap (image, wikimedia_commons) — приходят в том же ответе,
//       дополнительных запросов в сеть не требуют
//   T2  сайт самого заведения — og:image / JSON-LD; сюда же его ссылка бронирования
//   T3  Викисклад по wikidata/brand:wikidata — из заранее собранного офлайн-индекса
//   T5  сгенерированная обложка — всегда доступна, сети не требует
//
// Инвариант, проверяемый тестом: если origin !== "generated", а credit.text пуст,
// кандидат отбрасывается. Лучше своя обложка, чем чужой кадр без указания автора.

// Хосты-агрегаторы. С них не берём ни фотографию, ни ссылку «забронировать»:
// именно это и есть зависимость, от которой уходим. Сравнение по суффиксу домена,
// чтобы notkudago.com не попал под правило, а www.kudago.com попал.
export const AGGREGATORS=[
  "kudago.com","afisha.ru","afisha.yandex.ru","yandex.ru","maps.yandex.ru","2gis.ru","2gis.com",
  "zoon.ru","restoclub.ru","restoran.ru","tripadvisor.com","tripadvisor.ru","timepad.ru",
  "google.com","goo.gl","foursquare.com","tomesto.ru","gettable.ru","eda.yandex.ru","delivery-club.ru"
];

export function hostOf(url){
  try{return new URL(String(url)).hostname.toLowerCase().replace(/\.$/,"").replace(/^www\./,"")}catch{return null}
}
export function isAggregator(url){
  const h=hostOf(url);
  if(!h)return false;
  return AGGREGATORS.some(a=>h===a||h.endsWith("."+a));
}

// В OSM wikimedia_commons хранится как "File:Имя.jpg" (иногда "Category:..."),
// а в image= порой лежит ссылка на СТРАНИЦУ Commons, а не на файл. И то и другое
// приводим к прямой ссылке на файл: иначе <img> грузит HTML и картинка не появляется.
export function commonsFileUrl(value,width=1280){
  const raw=String(value||"").trim();
  if(!raw)return null;
  let file=null;
  const m=/^(?:File|Файл):(.+)$/i.exec(raw);
  if(m)file=m[1];
  else if(/^https?:\/\//i.test(raw)){
    try{
      const u=new URL(raw);
      const h=u.hostname.toLowerCase();
      if(!/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$/.test(h))return null;
      if(/\/wiki\/Special:FilePath\//i.test(u.pathname))return raw;   // уже прямая ссылка
      const w=/\/wiki\/(?:File|Файл):(.+)$/i.exec(decodeURIComponent(u.pathname));
      if(w)file=w[1];
      else if(/upload\.wikimedia\.org$/.test(h))return raw;           // тоже прямая
    }catch{return null}
  }
  if(!file)return null;
  file=file.replace(/\s/g,"_").replace(/^\/+/,"");
  if(!file||file.length>240)return null;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}

// Ссылка на сайт самого заведения — только если это действительно его сайт.
export function ownSiteUrl(place){
  const raw=place&&(place.official_source||place.website);
  if(!raw)return null;
  let u;
  try{u=new URL(String(raw))}catch{return null}
  if(!/^https?:$/.test(u.protocol))return null;
  if(isAggregator(u.href))return null;
  // Следы кампаний в ключ кеша попадать не должны.
  for(const k of [...u.searchParams.keys()])if(/^(utm_|yclid|gclid|fbclid|from$)/i.test(k))u.searchParams.delete(k);
  u.hash="";
  return u.href;
}

// Кадр с сайта заведения должен быть похож на фотографию, а не на логотип.
const BAD_NAME=/logo|sprite|placeholder|default|favicon|share|icon|banner|stub|noimage|no-image/i;
export function looksLikePhoto(url,{width=null,height=null}={}){
  if(!url)return false;
  let u;
  try{u=new URL(String(url))}catch{return false}
  if(!/^https?:$/.test(u.protocol))return false;
  if(BAD_NAME.test(u.pathname))return false;
  if(/\.svg($|\?)/i.test(u.pathname))return false;          // логотипы почти всегда svg
  if(width!==null&&Number(width)>0&&Number(width)<600)return false;
  if(width&&height){
    const r=Math.max(width/height,height/width);
    if(r>3)return false;                                     // баннер-полоска, не кадр зала
  }
  return true;
}

const CREDIT={
  osm:{text:"OpenStreetMap contributors",url:"https://www.openstreetmap.org/copyright",license:{code:"ODbL-1.0",url:"https://opendatacommons.org/licenses/odbl/"}},
  commons:{text:"Wikimedia Commons",url:"https://commons.wikimedia.org/",license:{code:"см. страницу файла",url:"https://commons.wikimedia.org/"}}
};

/**
 * Выбирает фотографию места.
 * deps.siteMeta(url) -> {image_url,image_width,image_height,booking_url,...} — обращение к сайту
 *   заведения; в тестах подменяется, поэтому функция проверяется без сети.
 * deps.commonsIndex — заранее собранный офлайн-индекс (ключи: QID и File:имя) или null.
 * deps.coverUrl(place) -> строка — терминатор каскада, обязателен.
 */
export async function resolvePhoto(place,deps={}){
  const {siteMeta=null,commonsIndex=null,coverUrl=null}=deps;
  const out=(o)=>{
    // Инвариант атрибуции: чужой кадр без указания источника не показываем.
    if(o.origin!=="generated"&&!(o.credit&&o.credit.text))return null;
    return o;
  };

  // T1 — то, что уже пришло вместе с местом.
  const fromTags=commonsFileUrl(place.wikimedia_commons)||commonsFileUrl(place.image_raw);
  if(fromTags){
    const r=out({url:fromTags,origin:"commons",confidence:"high",credit:CREDIT.commons,license:CREDIT.commons.license});
    if(r)return r;
  }
  // Сырой image= с произвольного хоста берём, только если это хост сайта заведения:
  // иначе лицензия кадра неизвестна.
  const site=ownSiteUrl(place);
  if(place.image_raw&&site&&hostOf(place.image_raw)===hostOf(site)&&looksLikePhoto(place.image_raw)){
    const r=out({url:place.image_raw,origin:"venue_site",confidence:"high",
      credit:{text:hostOf(site),url:site},license:{code:"сайт заведения",url:site}});
    if(r)return r;
  }

  // T2 — сайт самого заведения.
  if(site&&typeof siteMeta==="function"){
    let meta=null;
    try{meta=await siteMeta(site)}catch{meta=null}
    if(meta&&meta.image_url&&looksLikePhoto(meta.image_url,{width:meta.image_width,height:meta.image_height})){
      const r=out({url:meta.image_url,origin:"venue_site",confidence:"high",
        credit:{text:hostOf(site),url:site},license:{code:"сайт заведения",url:site}});
      if(r)return r;
    }
  }

  // T3 — офлайн-индекс Викисклада по wikidata/brand:wikidata.
  if(commonsIndex){
    for(const qid of [place.wikidata,place.brand_wikidata]){
      const hit=qid&&commonsIndex[qid];
      if(!hit||!hit.file)continue;
      const url=commonsFileUrl(hit.file);
      if(!url)continue;
      const r=out({url,origin:hit.kind==="logo"?"brand_logo":"commons",
        confidence:hit.kind==="logo"?"low":"medium",
        credit:{text:hit.author||CREDIT.commons.text,url:hit.page||CREDIT.commons.url},
        license:{code:hit.license||"см. страницу файла",url:hit.license_url||CREDIT.commons.url}});
      if(r)return r;
    }
  }

  // T5 — своя обложка. Этот уровень не может не сработать.
  return {url:typeof coverUrl==="function"?coverUrl(place):null,origin:"generated",confidence:"none",
    credit:null,license:CREDIT.osm.license};
}
