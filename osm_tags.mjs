// Соответствие структурных полей OpenStreetMap категориям справочника.
//
// Вынесено отдельно, потому что этим пользуются двое: живой поиск через Overpass
// и локальный снимок города. Дублировать разбор в обоих местах означало бы
// расхождение категорий между тем, что найдено сейчас, и тем, что лежит в индексе.
import {CATEGORIES,queriesFor} from "./categories.mjs";
import {CITY} from "./city.mjs";

function uniq(a){return [...new Set(a.filter(Boolean))]}

// Каждый фильтр категории — набор условий, которые должны выполняться ВСЕ:
// «leisure=sports_centre И sport=swimming» — бассейн, а не любой спорткомплекс.
// Раньше условия разбирались по одному, и любой спорткомплекс становился
// бассейном, любой фитнес — йогой и спа, любое кафе — местом для работы.
const OSM_FILTERS=(()=>{
  const out=[];
  for(const c of CATEGORIES)for(const f of c.osm||[]){
    const conds=[];let structural=true;
    for(const [,key,op,raw] of f.matchAll(/\["([a-z:_]+)"([=~])"([^"]+)"\]/g)){
      if(op==="~"&&raw==="."){conds.push([key,null]);continue}   // ключ есть, значение любое
      // Регэкспы фильтров закреплены «^(…)$» (иначе shop~"pet" ловил «carpet»):
      // для словаря снимаем якоря и берём сами значения.
      const vals=op==="~"?raw.replace(/^\^\((.*)\)\$$/,"$1"):raw;
      if(!/^[a-z_|]+$/.test(vals)){structural=false;break}        // regex по имени — не категория
      conds.push([key,new Set(op==="~"?vals.split("|"):[vals])]);
    }
    if(!structural||!conds.length)continue;
    // Вместе с extraTags категории («nightlife» у бара): иначе бар с латинским
    // названием, чьё имя не ловится регэкспом, терял баллы за эти теги.
    out.push({conds,tags:[c.tag,...(c.extraTags||[])]});
  }
  return out;
})();
// Категория места по данным источника, а не по тексту названия.
// Значения через «;» («climbing;swimming») считаются каждое отдельно.
export function structuralTags(fields){
  const f=fields||{};const out=[];
  const has=(k,set)=>{
    const v=f[k];if(v===undefined||v===null||v==="")return false;
    if(!set)return true;
    return String(v).split(";").some(x=>set.has(x.trim()));
  };
  for(const r of OSM_FILTERS)if(r.conds.every(([k,set])=>has(k,set)))out.push(...r.tags);
  return uniq(out);
}

// Фильтры категории, пригодные для локального отбора: только те, что задают
// пару «ключ = значение». Поиск по имени в снимке делается отдельно, через FTS.
export function categoryOsmKeys(c){
  const out=[];
  for(const f of c.osm||[])
    for(const [,key,op,raw] of f.matchAll(/\["([a-z:_]+)"([=~])"([^"]+)"\]/g)){
      // Регэкспы фильтров закреплены «^(…)$» (иначе shop~"pet" ловил «carpet»):
      // для словаря снимаем якоря и берём сами значения.
      const vals=op==="~"?raw.replace(/^\^\((.*)\)\$$/,"$1"):raw;
      if(!/^[a-z_|]+$/.test(vals))continue;
      for(const v of (op==="~"?vals.split("|"):[vals]))out.push(`${key}=${v}`);
    }
  return uniq(out);
}
// Русское название категории: первый поисковый запрос справочника как раз им и
// является. Нужно и карточке (на плашке теперь категория, а не имя агрегатора),
// и объяснению «почему вам».
// На языке города: в Дубае карточка с карты подписана «Bar», а не «Бар»,
// и «почему вам» — «bar · nightlife», а не «бар · ночная жизнь».
const EN=CITY.lang==="en";
const TITLE=new Map(CATEGORIES.map(c=>[c.tag,(EN?queriesFor(c,"en"):c.queries||[])[0]||c.tag]));
for(const [k,v] of Object.entries(EN?{nightlife:"nightlife",outdoors:"outdoors",music:"music",
  culture:"culture",art:"exhibitions",theatre:"theatre",comedy:"stand-up",jazz:"jazz",rock:"rock",
  science:"science",festival:"festival",lecture:"talk",workshop:"workshop",
  experience:"experience",friends:"for groups",beauty:"beauty"}:{nightlife:"ночная жизнь",outdoors:"на воздухе",music:"музыка",
  culture:"культура",art:"выставки",theatre:"театр",comedy:"стендап",jazz:"джаз",rock:"рок",
  science:"наука",festival:"фестиваль",lecture:"лекция",workshop:"мастер-класс",
  experience:"впечатления",friends:"для компании",beauty:"красота"}))TITLE.set(k,v);
export function tagTitle(tag){return TITLE.get(tag)||tag}
// Заголовок карточки по структурным тегам места: первый распознанный выигрывает.
export function placeTitle(osmTags){
  for(const t of structuralTags(osmTags)){
    const title=TITLE.get(t);
    if(title)return title[0].toUpperCase()+title.slice(1);
  }
  return null;
}

export {CATEGORIES};
