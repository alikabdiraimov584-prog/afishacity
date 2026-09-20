// Соответствие структурных полей OpenStreetMap категориям справочника.
//
// Вынесено отдельно, потому что этим пользуются двое: живой поиск через Overpass
// и локальный снимок города. Дублировать разбор в обоих местах означало бы
// расхождение категорий между тем, что найдено сейчас, и тем, что лежит в индексе.
import {CATEGORIES} from "./categories.mjs";

function uniq(a){return [...new Set(a.filter(Boolean))]}

const OSM_TAG_MAP=(()=>{
  const m=new Map();
  for(const c of CATEGORIES)for(const f of c.osm||[])
    for(const [,key,op,vals] of f.matchAll(/\["([a-z:_]+)"([=~])"([^"]+)"\]/g)){
      if(!/^[a-z_|]+$/.test(vals))continue;               // regex по имени — не категория
      // Одно значение заявляют несколько категорий (hairdresser — и barber, и
      // beauty), поэтому копим все, иначе последняя затирает предыдущие.
      for(const v of (op==="~"?vals.split("|"):[vals])){
        const k=`${key}=${v}`;
        m.set(k,uniq([...(m.get(k)||[]),c.tag]));
      }
    }
  return m;
})();
// Категория места по данным источника, а не по тексту названия.
export function structuralTags(fields){
  const out=[];
  for(const [k,v] of Object.entries(fields||{}))out.push(...(OSM_TAG_MAP.get(`${k}=${v}`)||[]));
  return uniq(out);
}

// Фильтры категории, пригодные для локального отбора: только те, что задают
// пару «ключ = значение». Поиск по имени в снимке делается отдельно, через FTS.
export function categoryOsmKeys(c){
  const out=[];
  for(const f of c.osm||[])
    for(const [,key,op,vals] of f.matchAll(/\["([a-z:_]+)"([=~])"([^"]+)"\]/g)){
      if(!/^[a-z_|]+$/.test(vals))continue;
      for(const v of (op==="~"?vals.split("|"):[vals]))out.push(`${key}=${v}`);
    }
  return uniq(out);
}
// Русское название категории: первый поисковый запрос справочника как раз им и
// является. Нужно и карточке (на плашке теперь категория, а не имя агрегатора),
// и объяснению «почему вам».
const TITLE=new Map(CATEGORIES.map(c=>[c.tag,(c.queries||[])[0]||c.tag]));
for(const [k,v] of Object.entries({nightlife:"ночная жизнь",outdoors:"на воздухе",music:"музыка",
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
