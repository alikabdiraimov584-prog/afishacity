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
/* Сбор одной категории. Элементы отдаются через onBatch, наружу возвращается
   только их число.
   
   Большая категория делится на клетки, и каждую Overpass считает под минуту.
   Клетка уходит в базу сразу, как только пришла: обрыв на предпоследней
   клетке оставляет после себя работу, а не пустоту.
   
   Собранное при этом нигде не накапливается, и это не мелочь. Раньше рекурсия
   складывала элементы всех подклеток в один массив, который вызывающий код
   даже не читал: на «еде» по Москве это до сорока восьми тысяч разобранных
   объектов Overpass, десятки мегабайт, — и всё это лежало в памяти рядом с
   базой и самим сервером. На машине с гигабайтом памяти и без подкачки такой
   запас памяти отнимать не у кого: следом перестаёт хватать всем, вплоть до
   того, что sshd не может развернуть сессию. Заодно исчезает out.push(...arr):
   спред большого массива аргументами роняет стек примерно на сотне тысяч. */
export async function collectCategory(cat,box,{fetchCell,cap=3000,maxDepth=2,pause=async()=>{},depth=0,onBatch=null}={}){
  // Без приёмника элементы просто исчезли бы — молчаливая потеря данных хуже отказа.
  if(typeof onBatch!=="function")throw new TypeError("collectCategory: нужен onBatch, элементы отдаются только через него");
  let els;
  try{els=await fetchCell(cat,box)}
  catch(e){
    if(depth>=maxDepth)throw e;
    await pause();
    els=await fetchCell(cat,box);                        // одна повторная попытка
  }
  if(els.length<cap||depth>=maxDepth){
    const n=els.length;
    if(n)await onBatch(els);
    return n;
  }
  let got=0;
  for(const q of splitBox(box)){
    await pause();
    got+=await collectCategory(cat,q,{fetchCell,cap,maxDepth,pause,depth:depth+1,onBatch});
  }
  return got;
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
/* resume — продолжить недостроенную базу, а не начинать заново.
   Сборка города идёт десятки минут, и одна большая категория вроде «еды»
   может занять двадцать. Раньше каждый перезапуск стирал недострой: после
   пяти попыток подряд снимка по-прежнему не было, потому что работа каждый
   раз начиналась с нуля. Теперь готовые категории помечаются в самой базе,
   и следующий запуск берётся за оставшиеся. */
export function createSnapshot(file,{resume=false}={}){
  ensureDir(file);
  const tmp=file+".building";
  let reused=false;
  if(resume&&existsSync(tmp)){
    try{
      const probe=new DatabaseSync(tmp);
      probe.prepare("select count(*) n from place").get();   // база цела?
      probe.close();reused=true;
    }catch{reused=false}
  }
  if(!reused)for(const f of [tmp,tmp+"-wal",tmp+"-shm"])try{rmSync(f,{force:true})}catch{}
  const db=new DatabaseSync(tmp);
  db.exec(SCHEMA);
  const ins=db.prepare("insert or replace into place(pid,otype,oid,name,name_norm,lat,lon,tags_json,updated_at) values(?,?,?,?,?,?,?,?,?)");
  const insTag=db.prepare("insert or replace into ptag(tag,pid,lat,lon) values(?,?,?,?)");
  const insFts=db.prepare("insert into place_fts(name_norm,pid) values(?,?)");
  const setMeta=db.prepare("insert or replace into meta(k,v) values(?,?)");
  let stored=Number(db.prepare("select count(*) n from place").get().n)||0;
  const doneKey="done_tags";
  const readDone=()=>{
    try{const r=db.prepare("select v from meta where k=?").get(doneKey);
      return new Set(String(r&&r.v||"").split(",").filter(Boolean))}catch{return new Set()}
  };
  return {
    reused,
    /** Категории, уже собранные в этой недостроенной базе. */
    done(){return readDone()},
    markDone(tag){
      const d=readDone();d.add(String(tag));
      setMeta.run(doneKey,[...d].join(","));
    },
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
    places(){return Number(db.prepare("select count(*) n from place").get().n)||0},
    finish({source="overpass",now=Date.now()}={}){
      setMeta.run(doneKey,"");                              // собран целиком
      setMeta.run("built_at",String(now));
      setMeta.run("source",String(source));
      setMeta.run("places",String(db.prepare("select count(*) n from place").get().n));
      db.exec("pragma wal_checkpoint(truncate)");
      db.close();
      for(const f of [file,file+"-wal",file+"-shm"])try{rmSync(f,{force:true})}catch{}
      renameSync(tmp,file);
      return {file,places:stored};
    },
    abort(){try{db.close()}catch{};for(const f of [tmp,tmp+"-wal",tmp+"-shm"])try{rmSync(f,{force:true})}catch{}},
    /* Закрыть, сохранив недострой: собранные категории помечены, и следующий
       запуск продолжит с них. Отличается от abort() именно этим. */
    close(){try{db.exec("pragma wal_checkpoint(truncate)")}catch{};try{db.close()}catch{}}
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

  // Без ORDER BY «limit 80» отдавал первые строки индекса — то есть 80 самых
  // ЮЖНЫХ точек рамки, а не ближайшие и не лучшие: на «бар рядом» из центра
  // приходили Бутово и Южное Чертаново. Теперь — ближайшие к точке (человеку,
  // а без него — центру города). Долгота сжата на cos²(55.75°) ≈ 0.32, чтобы
  // километр на восток весил столько же, сколько километр на север.
  const byTag=db.prepare(`
    select p.pid,p.otype,p.oid,p.lat,p.lon,p.tags_json
    from ptag t join place p on p.pid=t.pid
    where t.tag=? and t.lat between ? and ? and t.lon between ? and ?
    order by (t.lat-?)*(t.lat-?)+(t.lon-?)*(t.lon-?)*0.32
    limit ?`);
  const byName=db.prepare(`
    select p.pid,p.otype,p.oid,p.lat,p.lon,p.tags_json
    from place_fts f join place p on p.pid=f.pid
    where place_fts match ? and p.lat between ? and ? and p.lon between ? and ?
    order by (p.lat-?)*(p.lat-?)+(p.lon-?)*(p.lon-?)*0.32
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
    // point — откуда мерить близость: положение человека, если есть.
    // Есть точка — рамка сужается до ~6 км вокруг неё: дальше «ближайшее»
    // не бывает, а ранкеру достаётся больше кандидатов из нужного района.
    // point — сузить рамку вокруг этой точки (только когда просили «рядом»).
    // order — откуда мерить близость для сортировки: положение человека, если
    // оно известно, даже когда рамка остаётся городской.
    search(plan={},{limit=80,center=false,point=null,order=null}={}){
      const ok=(c)=>c&&Number.isFinite(+c.lat)&&Number.isFinite(+c.lon)?{lat:+c.lat,lon:+c.lon}:null;
      const p=ok(point);
      const box=p?{south:p.lat-0.055,north:p.lat+0.055,west:p.lon-0.095,east:p.lon+0.095}
        :center?CENTER_BBOX:MOSCOW_BBOX;
      const at=p||ok(order)||{lat:(CENTER_BBOX.south+CENTER_BBOX.north)/2,lon:(CENTER_BBOX.west+CENTER_BBOX.east)/2};
      const seen=new Map();
      const tags=(plan.tags||[]).filter(t=>CATEGORY_KEYS.has(t));
      // Лимит делится между тегами: раньше первый тег забирал его целиком, и
      // «куда сходить вечером» (бары, еда, кальян) давало одни бары.
      const per=tags.length?Math.max(20,Math.ceil(limit/tags.length)):limit;
      for(const t of tags){
        for(const r of byTag.all(t,box.south,box.north,box.west,box.east,at.lat,at.lat,at.lon,at.lon,per))
          if(!seen.has(r.pid))seen.set(r.pid,row(r));
      }
      // Категория не опознана, но место всё равно ищут по названию — как и в
      // живом запросе, где для этого собирается фильтр по name.
      if(!seen.size){
        const q=ftsQuery(plan.coreQuery||plan.safeQuery||plan.raw||"");
        if(q){
          try{
            for(const r of byName.all(q,box.south,box.north,box.west,box.east,at.lat,at.lat,at.lon,at.lon,limit))
              if(!seen.has(r.pid))seen.set(r.pid,row(r));
          }catch{/* синтаксис FTS — не повод падать */}
        }
      }
      return [...seen.values()].slice(0,limit);
    },
    close(){try{db.close()}catch{}}
  };
}
