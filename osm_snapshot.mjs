// Локальный снимок мест города (рамка и файл — из city.mjs).
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
import {CITY} from "./city.mjs";

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

// Рамка города и рамка центра — из конфигурации города, те же значения, что у
// живых запросов. MOSCOW_BBOX осталось как прежнее имя: это рамка текущего CITY.
export const CITY_BBOX=CITY.bbox;
export const MOSCOW_BBOX=CITY_BBOX;
export const CENTER_BBOX=CITY.centerBbox;
// Сжатие долготы при сортировке по близости: cos²(широты центра), чтобы
// километр на восток весил столько же, сколько километр на север
// (Москва ≈ 0.32, Дубай ≈ 0.82).
const LON_WEIGHT=Math.round(Math.cos(CITY.center.lat*Math.PI/180)**2*100)/100;

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
export async function collectCategory(cat,box,{fetchCell,cap=3000,maxDepth=2,pause=async()=>{},depth=0,onBatch=null,signal=null}={}){
  // Без приёмника элементы просто исчезли бы — молчаливая потеря данных хуже отказа.
  if(typeof onBatch!=="function")throw new TypeError("collectCategory: нужен onBatch, элементы отдаются только через него");
  // Отмену проверяем перед каждым шагом. Сверху категорию бросают по бюджету, и
  // если рекурсия об этом не знает, она продолжает качать Overpass и писать
  // в базу — уже под именем следующей категории, потому что счётчик мест общий.
  const stop=()=>{if(signal&&signal.aborted)throw Object.assign(new Error("сбор отменён"),{name:"AbortError"})};
  const aborted=(e)=>Boolean(e&&e.name==="AbortError");
  stop();
  let els;
  try{els=await fetchCell(cat,box,signal)}
  catch(e){
    if(aborted(e)||depth>=maxDepth)throw e;               // отменённое не повторяем
    await pause();
    stop();
    els=await fetchCell(cat,box,signal);                  // одна повторная попытка
  }
  stop();
  if(els.length<cap||depth>=maxDepth){
    const n=els.length;
    if(n)await onBatch(els);
    return n;
  }
  let got=0;
  for(const q of splitBox(box)){
    await pause();
    stop();
    got+=await collectCategory(cat,q,{fetchCell,cap,maxDepth,pause,depth:depth+1,onBatch,signal});
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
  const delFts=db.prepare("delete from place_fts where pid=?");
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
          // place заменяется по ключу, а FTS5 — обычная вставка без уникальности.
          // Одно и то же место приходит под несколькими категориями (кофейня —
          // и «еда», и «кофе») и при возобновлении сборки, и каждый раз получало
          // ещё одну строку в индексе. Поиск join'ит place_fts с place, поэтому
          // место показывалось в выдаче столько раз, сколько его записали.
          delFts.run(pid);
          // В индекс поиска — и английское имя (в Дубае name часто по-арабски),
          // и кухня: «sushi» находит суши-бар, даже если суши нет в названии.
          const extra=[t["name:en"],t["name:ru"]!==name?t["name:ru"]:"",t.cuisine&&String(t.cuisine).replace(/[;_,]/g," ")].filter(Boolean).join(" ");
          insFts.run(extra?`${nn} ${norm(extra)}`:nn,pid);
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
// Имя для точного сравнения: без акцентов, регистра и знаков («CÉ LA VI» → «ce la vi»).
export function foldName(s=""){
  return String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/&/g," and ")
    .replace(/[^a-z0-9а-яё]+/g," ").replace(/\s+/g," ").trim();
}
export function openSnapshot(file,{now=Date.now}={}){
  let exactIdx=null;
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
    order by (t.lat-?)*(t.lat-?)+(t.lon-?)*(t.lon-?)*${LON_WEIGHT}
    limit ?`);
  const byName=db.prepare(`
    select p.pid,p.otype,p.oid,p.lat,p.lon,p.tags_json
    from place_fts f join place p on p.pid=f.pid
    where place_fts match ? and p.lat between ? and ? and p.lon between ? and ?
    order by (p.lat-?)*(p.lat-?)+(p.lon-?)*(p.lon-?)*${LON_WEIGHT}
    limit ?`);

  // Отбор по тегу из tags_json («"outdoor_seating":"yes"», «"free:michelin":»):
  // таких признаков нет в индексе рубрик, а уточнение запроса («с террасой»,
  // «Мишлен», «приёмный покой») без них не найти среди 120 ближайших.
  // Полный проход по 50 тысячам строк — десятки миллисекунд, и делается только
  // для запросов с таким уточнением.
  const byJson=db.prepare(`
    select p.pid,p.otype,p.oid,p.lat,p.lon,p.tags_json
    from place p
    where instr(p.tags_json,?)>0 and p.lat between ? and ? and p.lon between ? and ?
    order by (p.lat-?)*(p.lat-?)+(p.lon-?)*(p.lon-?)*${LON_WEIGHT}
    limit ?`);
  // Рубрики, которые есть в самой базе (их добавляет сборка карты, например
  // «metro»), ищутся, даже если справочник категорий о них ещё не знает.
  let ptagSet=new Set();
  try{ptagSet=new Set(db.prepare("select distinct tag from ptag").all().map(r=>r.tag))}catch{}

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
        :center?CENTER_BBOX:CITY_BBOX;
      const at=p||ok(order)||{lat:(CENTER_BBOX.south+CENTER_BBOX.north)/2,lon:(CENTER_BBOX.west+CENTER_BBOX.east)/2};
      const seen=new Map();
      // Уточнение («sushi», «atlantis», «burj khalifa») ищется по названию и
      // кухне ПОВЕРХ категории: иначе в 120 ближайших отелей Atlantis не попадал
      // вовсе, а суши-бары тонули среди всех ресторанов.
      // Основа слова: «skydiving» ищет и «Skydive Dubai», «tours» — и «tour».
      // Короткое слово — только целиком: «read»* находил «Readymade Garments»,
      // «take»* — «Take Home», «thread»* — ателье «Thread Up».
      const ALIAS_PREFIX=false;
      const stem=(w)=>{if(w.includes(" ")||w.length<6)return w;const st=w.replace(/(ing|ers|er|es|s)$/,"");return st.length>=5?st:w};
      const one=(w)=>{const st=stem(w);const q=`"${st.replace(/"/g,'""')}"`;return st!==w||(!w.includes(" ")&&w.length>=5&&ALIAS_PREFIX)?q+"*":q};
      // Синонимы из плана: «zipline» ищет и «XLine», «surfing» — «Surf School».
      const aliases=plan.focusAlias&&typeof plan.focusAlias==="object"?plan.focusAlias:{};
      const term=(w)=>aliases[w]?`(${aliases[w].map(a=>{const n=norm(a);return n.includes(" ")?`"${n.replace(/"/g,'""')}"`:`"${n.replace(/"/g,'""')}"*`}).join(" OR ")})`:one(w);
      const fq=(ws,op)=>ws.map(term).join(` ${op} `);
      // Название целиком («ain dubai», «global village»): все слова, точные, по
      // всему городу — место может быть далеко от района человека.
      const phrase=(Array.isArray(plan.phrase)?plan.phrase:[]).map(w=>norm(w)).filter(Boolean).slice(0,4);
      if(phrase.length){
        try{
          const q=phrase.map(w=>`"${w.replace(/"/g,'""')}"`).join(" AND ");
          for(const r of byName.all(q,CITY_BBOX.south,CITY_BBOX.north,CITY_BBOX.west,CITY_BBOX.east,at.lat,at.lat,at.lon,at.lon,40))
            if(!seen.has(r.pid))seen.set(r.pid,row(r));
        }catch{/* синтаксис FTS — не повод падать */}
      }
      const focus=(Array.isArray(plan.focus)?plan.focus:[]).map(w=>norm(w)).filter(w=>w.length>=3).slice(0,3);
      // Слово с синонимами сначала ищется само по себе: «Maui Kayak Shop» не
      // должен тонуть среди сорока ближайших «Watersports» по синониму.
      for(const w of focus)if(aliases[w]){
        try{for(const r of byName.all(one(w),box.south,box.north,box.west,box.east,at.lat,at.lat,at.lon,at.lon,40))if(!seen.has(r.pid))seen.set(r.pid,row(r))}catch{}
      }
      if(focus.length){
        const qAnd=fq(focus,"AND");
        const qOr=fq(focus,"OR");
        for(const q of focus.length>1?[qAnd,qOr]:[qAnd]){
          try{
            for(const r of byName.all(q,box.south,box.north,box.west,box.east,at.lat,at.lat,at.lon,at.lon,40))
              if(!seen.has(r.pid))seen.set(r.pid,row(r));
          }catch{/* синтаксис FTS — не повод падать */}
          if(seen.size)break;
        }
      }
      const cats=new Set(Array.isArray(plan.cats)?plan.cats:[]);
      // Соседние занятия («kayaking» → «watersports») — по названию, после основного.
      for(const w of (Array.isArray(plan.relatedFocus)?plan.relatedFocus:[]).map(x=>norm(x)).filter(x=>x.length>=3).slice(0,4)){
        const q=w.includes(" ")?`"${w.replace(/"/g,'""')}"`:`"${w.replace(/"/g,'""')}"*`;
        try{for(const r of byName.all(q,box.south,box.north,box.west,box.east,at.lat,at.lat,at.lon,at.lon,30))if(!seen.has(r.pid))seen.set(r.pid,row(r))}catch{}
      }
      const tags=(plan.tags||[]).filter(t=>CATEGORY_KEYS.has(t)||(cats.has(t)&&ptagSet.has(t)));
      // Лимит делится между тегами: раньше первый тег забирал его целиком, и
      // «куда сходить вечером» (бары, еда, кальян) давало одни бары.
      const per=tags.length?Math.max(20,Math.ceil(limit/tags.length)):limit;
      for(const t of tags){
        for(const r of byTag.all(t,box.south,box.north,box.west,box.east,at.lat,at.lat,at.lon,at.lon,per))
          if(!seen.has(r.pid))seen.set(r.pid,row(r));
      }
      // Уточнения из тегов (терраса, Мишлен, приёмный покой, станция метро) —
      // поверх рубрик: по городу, ближайшие к точке. Идут отдельным списком
      // после основного, чтобы общий предел их не срезал.
      const head=new Map([...seen.entries()].slice(0,limit));
      const extra=new Map();
      const add=(r)=>{if(!head.has(r.pid)&&!extra.has(r.pid))extra.set(r.pid,row(r))};
      const jsonTags=(Array.isArray(plan.jsonTags)?plan.jsonTags:[]).filter(s=>typeof s==="string"&&s.length>=4).slice(0,6);
      const jbox=p?box:CITY_BBOX;
      for(const jt of jsonTags){
        try{
          for(const r of byJson.all(jt,jbox.south,jbox.north,jbox.west,jbox.east,at.lat,at.lat,at.lon,at.lon,60))add(r);
        }catch{/* повреждённая строка не повод падать */}
      }
      // «Ресторан с видом на Бурдж-Халифу»: те же рубрики вокруг ориентира.
      const anchor=ok(plan.landmark);
      if(anchor){
        const ab={south:anchor.lat-0.02,north:anchor.lat+0.02,west:anchor.lon-0.022,east:anchor.lon+0.022};
        for(const t of tags)
          for(const r of byTag.all(t,ab.south,ab.north,ab.west,ab.east,anchor.lat,anchor.lat,anchor.lon,anchor.lon,Math.max(30,per)))add(r);
      }
      // Категория не опознана, но место всё равно ищут по названию — как и в
      // живом запросе, где для этого собирается фильтр по name.
      if(!seen.size&&!extra.size){
        const q=ftsQuery(plan.coreQuery||plan.safeQuery||plan.raw||"");
        if(q){
          try{
            for(const r of byName.all(q,box.south,box.north,box.west,box.east,at.lat,at.lat,at.lon,at.lon,limit))
              if(!seen.has(r.pid))seen.set(r.pid,row(r));
          }catch{/* синтаксис FTS — не повод падать */}
        }
      }
      return [...[...seen.values()].slice(0,limit),...extra.values()];
    },
    /** Точное название места («CÉ LA VI», «Zuma», «Il Borro») → имя из базы или null.
     *  Короткие слова и буквы с акцентами поиск по словам не находит; таблица
     *  «свёрнутое имя → имя» строится один раз (≈40 тыс. строк, десятки мс). */
    exactName(text){
      const key=foldName(text);if(!key||key.length<2)return null;
      if(!exactIdx){
        exactIdx=new Map();
        try{
          for(const r of db.prepare("select name,tags_json from place").all()){
            let t={};try{t=JSON.parse(r.tags_json)}catch{}
            for(const n of new Set([r.name,t["name:en"],t.name].filter(Boolean))){
              const k=foldName(n);if(!k)continue;
              for(const v of [k,k.replace(/^the /,""),k.replace(/ dubai$/,"")])if(v&&!exactIdx.has(v))exactIdx.set(v,r.name);
            }
          }
        }catch{}
      }
      for(const v of [key,key.replace(/^the /,""),key.replace(/ dubai$/,"")])if(exactIdx.has(v))return exactIdx.get(v);
      return null;
    },
    close(){try{db.close()}catch{}}
  };
}
