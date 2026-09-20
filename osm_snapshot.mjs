// Локальный снимок мест Москвы.
//
// Зачем: сейчас каждый поиск идёт в Overpass — один публичный сервис, один URL.
// Он отвечает секундами, иногда не отвечает вовсе, и пока он недоступен, мест в
// выдаче нет. Снимок переворачивает зависимость: город выгружается раз в сутки
// фоном, а запрос пользователя обслуживается из SQLite за миллисекунды. Overpass
// остаётся, но уже как способ обновить снимок, а не как путь к ответу.
//
// Отбор здесь намеренно повторяет то, что делают фильтры Overpass в providers.mjs:
// выборка по структурному тегу внутри рамки и поиск по названию. Иначе выдача из
// снимка отличалась бы от живой, и ошибку было бы невозможно воспроизвести.
import {DatabaseSync} from "node:sqlite";
import {existsSync,mkdirSync,renameSync,rmSync} from "node:fs";
import {dirname} from "node:path";
import {CATEGORIES,structuralTags,categoryOsmKeys} from "./osm_tags.mjs";

// Тот же norm, что в providers.mjs: снимок и живой поиск должны видеть одинаковый текст.
export function norm(s=""){
  return String(s).toLowerCase().replace(/ё/g,"е").replace(/<[^>]*>/g," ")
    .replace(/[^a-zа-я0-9+\-\s]/gi," ").replace(/\s+/g," ").trim();
}

const SCHEMA=`
pragma journal_mode=wal;
create table if not exists place(
  pid text primary key,
  otype text not null,
  oid integer not null,
  name text not null,
  name_norm text not null,
  lat real not null,
  lon real not null,
  tags_json text not null,
  updated_at integer not null
) without rowid;
create table if not exists ptag(
  tag text not null,
  pid text not null,
  lat real not null,
  lon real not null,
  primary key(tag,pid)
) without rowid;
create index if not exists ptag_geo on ptag(tag,lat,lon);
create virtual table if not exists place_fts using fts5(name_norm, pid unindexed);
create table if not exists meta(k text primary key, v text not null);
`;

// Рамка Москвы и рамка центра — те же значения, что у живых запросов.
export const MOSCOW_BBOX={south:55.49,west:37.30,north:55.96,east:37.99};
export const CENTER_BBOX={south:55.71,west:37.55,north:55.80,east:37.69};

// Какие структурные ключи принадлежат тегу категории: нужно билдеру, чтобы
// спросить у Overpass ровно то, что потом будет искаться локально.
export const CATEGORY_KEYS=new Map(CATEGORIES.filter(c=>c.osm&&c.osm.length).map(c=>[c.tag,categoryOsmKeys(c)]));

export function splitBox(b){
  const mlat=(b.south+b.north)/2,mlon=(b.west+b.east)/2;
  return [
    {south:b.south,west:b.west,north:mlat,east:mlon},
    {south:b.south,west:mlon,north:mlat,east:b.east},
    {south:mlat,west:b.west,north:b.north,east:mlon},
    {south:mlat,west:mlon,north:b.north,east:b.east}
  ];
}

/**
 * Забирает одну категорию из рамки, деля её при необходимости.
 * fetchCell(category,box) -> элементы; подменяется в тестах, поэтому логика
 * дробления и повторов проверяется без сети.
 * Категория, упёршаяся в потолок ответа, означает, что в рамке её больше, чем
 * нам отдали: делим рамку, иначе половина города теряется молча.
 */
export async function collectCategory(cat,box,{fetchCell,cap=3000,maxDepth=2,pause=async()=>{},depth=0}={}){
  let els;
  try{els=await fetchCell(cat,box)}
  catch(e){
    if(depth>=maxDepth)throw e;
    await pause();
    els=await fetchCell(cat,box);                        // одна повторная попытка
  }
  if(els.length<cap||depth>=maxDepth)return els;
  const out=[];
  for(const q of splitBox(box)){
    await pause();
    out.push(...await collectCategory(cat,q,{fetchCell,cap,maxDepth,pause,depth:depth+1}));
  }
  return out;
}

// Снимок из половины города — не снимок. Решение вынесено сюда, чтобы правило
// проверялось тестом, а не жило внутри скрипта.
export function snapshotAcceptable({total,failed,targets,minPlaces=500,maxFailRate=0.3}){
  if(!targets)return {ok:false,reason:"нет категорий"};
  if(total<minPlaces)return {ok:false,reason:`мест слишком мало: ${total}`};
  if(failed/targets>maxFailRate)return {ok:false,reason:`не собралось ${failed} из ${targets}`};
  return {ok:true};
}

function ensureDir(file){try{mkdirSync(dirname(file),{recursive:true})}catch{}}

/** Открывает снимок для записи. Пишем во временный файл и подменяем по готовности,
 *  чтобы работающий сервер ни секунды не видел наполовину собранную базу. */
export function createSnapshot(file){
  ensureDir(file);
  const tmp=file+".building";
  for(const f of [tmp,tmp+"-wal",tmp+"-shm"])try{rmSync(f,{force:true})}catch{}
  const db=new DatabaseSync(tmp);
  db.exec(SCHEMA);
  const ins=db.prepare("insert or replace into place(pid,otype,oid,name,name_norm,lat,lon,tags_json,updated_at) values(?,?,?,?,?,?,?,?,?)");
  const insTag=db.prepare("insert or replace into ptag(tag,pid,lat,lon) values(?,?,?,?)");
  const insFts=db.prepare("insert into place_fts(name_norm,pid) values(?,?)");
  const setMeta=db.prepare("insert or replace into meta(k,v) values(?,?)");
  let stored=0;
  return {
    /** elements — сырые элементы Overpass. tag — категория, под которую их запросили. */
    put(elements,tag=null,now=Date.now()){
      db.exec("begin");
      try{
        for(const el of elements||[]){
          const t=el&&el.tags;if(!t)continue;
          const lat=Number(el.lat??el.center?.lat),lon=Number(el.lon??el.center?.lon);
          if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
          const name=t.name||t["name:ru"]||t.brand||"";
          if(!name)continue;                                  // безымянная точка бесполезна в выдаче
          const pid=`${el.type}/${el.id}`;
          const nn=norm(name);
          ins.run(pid,String(el.type),Number(el.id),name,nn,lat,lon,JSON.stringify(t),now);
          insFts.run(nn,pid);
          for(const tg of new Set([...(tag?[tag]:[]),...structuralTags(t)]))insTag.run(tg,pid,lat,lon);
          stored++;
        }
        db.exec("commit");
      }catch(e){try{db.exec("rollback")}catch{};throw e}
      return stored;
    },
    finish({source="overpass",now=Date.now()}={}){
      setMeta.run("built_at",String(now));
      setMeta.run("source",String(source));
      setMeta.run("places",String(db.prepare("select count(*) n from place").get().n));
      db.exec("pragma wal_checkpoint(truncate)");
      db.close();
      for(const f of [file,file+"-wal",file+"-shm"])try{rmSync(f,{force:true})}catch{}
      renameSync(tmp,file);
      return {file,places:stored};
    },
    abort(){try{db.close()}catch{};for(const f of [tmp,tmp+"-wal",tmp+"-shm"])try{rmSync(f,{force:true})}catch{}}
  };
}

// FTS5 разбирает свой синтаксис, поэтому пользовательский текст в запрос
// не вставляем: берём слова и оформляем каждое как префикс в кавычках.
function ftsQuery(text){
  const words=norm(text).split(" ").filter(w=>w.length>=3).slice(0,4);
  if(!words.length)return null;
  return words.map(w=>`"${w.replace(/"/g,'""')}"*`).join(" OR ");
}

/** Открывает снимок для чтения. Возвращает null, если снимка нет. */
export function openSnapshot(file,{now=Date.now}={}){
  if(!file||!existsSync(file))return null;
  let db;
  try{db=new DatabaseSync(file,{readOnly:true})}catch{return null}
  let meta={};
  try{for(const r of db.prepare("select k,v from meta").all())meta[r.k]=r.v}
  catch{try{db.close()}catch{};return null}
  const builtAt=Number(meta.built_at)||0;
  const places=Number(meta.places)||0;
  if(!places){try{db.close()}catch{};return null}

  const byTag=db.prepare(`
    select p.pid,p.otype,p.oid,p.lat,p.lon,p.tags_json
    from ptag t join place p on p.pid=t.pid
    where t.tag=? and t.lat between ? and ? and t.lon between ? and ?
    limit ?`);
  const byName=db.prepare(`
    select p.pid,p.otype,p.oid,p.lat,p.lon,p.tags_json
    from place_fts f join place p on p.pid=f.pid
    where place_fts match ? and p.lat between ? and ? and p.lon between ? and ?
    limit ?`);

  const row=(r)=>{
    let tags={};try{tags=JSON.parse(r.tags_json)}catch{}
    return {type:r.otype,id:r.oid,lat:r.lat,lon:r.lon,tags};
  };

  return {
    places,builtAt,
    ageMs:()=>now()-builtAt,
    /** Свежесть: снимок старше суток лучше обновить, но пользоваться им можно. */
    stale(maxAgeMs=36*60*60*1000){return now()-builtAt>maxAgeMs},
    /**
     * Отбор по плану поиска. Возвращает сырые элементы в формате Overpass,
     * чтобы providers.mjs нормализовал их той же функцией, что и живой ответ —
     * иначе карточка из снимка отличалась бы от карточки из сети.
     */
    search(plan={},{limit=80,center=false}={}){
      const box=center?CENTER_BBOX:MOSCOW_BBOX;
      const seen=new Map();
      const tags=(plan.tags||[]).filter(t=>CATEGORY_KEYS.has(t));
      for(const t of tags){
        if(seen.size>=limit)break;
        for(const r of byTag.all(t,box.south,box.north,box.west,box.east,limit))
          if(!seen.has(r.pid))seen.set(r.pid,row(r));
      }
      // Категория не опознана, но место всё равно ищут по названию — как и в
      // живом запросе, где для этого собирается фильтр по name.
      if(!seen.size){
        const q=ftsQuery(plan.coreQuery||plan.safeQuery||plan.raw||"");
        if(q){
          try{
            for(const r of byName.all(q,box.south,box.north,box.west,box.east,limit))
              if(!seen.has(r.pid))seen.set(r.pid,row(r));
          }catch{/* синтаксис FTS — не повод падать */}
        }
      }
      return [...seen.values()].slice(0,limit);
    },
    close(){try{db.close()}catch{}}
  };
}
