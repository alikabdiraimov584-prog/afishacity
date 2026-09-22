// Локальный снимок мест: поиск обслуживается из SQLite, а Overpass остаётся
// способом обновить снимок, а не путём к ответу пользователя.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createSnapshot,openSnapshot,splitBox,collectCategory,snapshotAcceptable,
        MOSCOW_BBOX,CENTER_BBOX,norm} from "../osm_snapshot.mjs";
import {searchOSM,buildSearchPlan} from "../providers.mjs";

const dir=()=>mkdtempSync(join(tmpdir(),"free-snap-"));
const el=(id,tags,lat,lon,type="node")=>({type,id,lat,lon,tags});

// Небольшой кусок города: аптека, парк с «аптечным» именем, барбершоп,
// бар в центре, бар на окраине, безымянная точка и кофейня.
const SAMPLE=[
  el(1,{name:"Аптека 36,6",amenity:"pharmacy",opening_hours:"24/7"},55.760,37.620),
  el(2,{name:"Аптекарский огород",leisure:"park"},55.776,37.633),
  el(3,{name:"Chop-Chop",shop:"hairdresser"},55.755,37.632),
  el(4,{name:"Бар Ровесник",amenity:"bar",website:"https://rovesnik.bar/"},55.760,37.632),
  el(5,{name:"Бар на краю",amenity:"bar"},55.550,37.350),
  el(6,{amenity:"bar"},55.760,37.620),
  el(7,{name:"Кофейня Skuratov",amenity:"cafe"},55.770,37.600,"way")
];
function build(d,now=1758000000000){
  const file=join(d,"osm.db");
  const w=createSnapshot(file);
  w.put(SAMPLE,null,now);
  w.finish({now});
  return file;
}

test("снимок отдаёт места по структурной категории", () => {
  const d=dir();
  try{
    const s=openSnapshot(build(d));
    const names=(plan,o)=>s.search(plan,o).map(x=>x.tags.name).sort();
    assert.deepEqual(names({tags:["pharmacy"]}),["Аптека 36,6"]);
    assert.deepEqual(names({tags:["barber","beauty"]}),["Chop-Chop"]);
    assert.deepEqual(names({tags:["park"]}),["Аптекарский огород"]);
    assert.deepEqual(names({tags:["bar"]}),["Бар Ровесник","Бар на краю"]);
    s.close();
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("рамка центра отсекает окраину", () => {
  const d=dir();
  try{
    const s=openSnapshot(build(d));
    assert.deepEqual(s.search({tags:["bar"]},{center:true}).map(x=>x.tags.name),["Бар Ровесник"]);
    s.close();
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("поиск по названию работает, когда категория не опознана", () => {
  const d=dir();
  try{
    const s=openSnapshot(build(d));
    const by=(q)=>s.search({coreQuery:q}).map(x=>x.tags.name);
    assert.deepEqual(by("ровесник"),["Бар Ровесник"]);
    assert.deepEqual(by("ровес"),["Бар Ровесник"],"префикс названия");
    assert.deepEqual(by("skuratov"),["Кофейня Skuratov"],"латиница");
    assert.deepEqual(by("зюзюка"),[],"ничего не выдумываем");
    // Синтаксис FTS не должен доезжать до запроса.
    assert.doesNotThrow(()=>s.search({coreQuery:'бар" OR name_norm:*'}));
    s.close();
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("безымянные точки в снимок не попадают", () => {
  const d=dir();
  try{
    const s=openSnapshot(build(d));
    assert.equal(s.places,6,"из семи объектов один без названия");
    s.close();
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("сборка подменяет файл целиком и только в конце", () => {
  const d=dir();
  try{
    const file=join(d,"osm.db");
    const old=createSnapshot(file);
    old.put(SAMPLE,null,1);old.finish({now:1});
    const before=openSnapshot(file);
    assert.equal(before.places,6);before.close();

    // Пока идёт новая сборка, прежний снимок остаётся читаемым.
    const w=createSnapshot(file);
    w.put([el(99,{name:"Новое место",amenity:"bar"},55.76,37.62)],null,2);
    const during=openSnapshot(file);
    assert.equal(during.places,6,"во время сборки виден прежний снимок");
    during.close();

    w.finish({now:2});
    const after=openSnapshot(file);
    assert.equal(after.places,1,"после подмены виден новый");
    after.close();
    assert.equal(existsSync(file+".building"),false,"временный файл убран");
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("прерванная сборка не трогает прежний снимок", () => {
  const d=dir();
  try{
    const file=join(d,"osm.db");
    const old=createSnapshot(file);old.put(SAMPLE,null,1);old.finish({now:1});
    const w=createSnapshot(file);
    w.put([el(99,{name:"Половина города",amenity:"bar"},55.76,37.62)],null,2);
    w.abort();
    const s=openSnapshot(file);
    assert.equal(s.places,6,"прежний снимок уцелел");
    s.close();
    assert.equal(existsSync(file+".building"),false);
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("испорченный или отсутствующий файл не считается снимком", () => {
  const d=dir();
  try{
    assert.equal(openSnapshot(join(d,"нет.db")),null);
    const junk=join(d,"junk.db");writeFileSync(junk,"это не база");
    assert.equal(openSnapshot(junk),null);
    // Пустая, но валидная база — тоже не снимок.
    const empty=join(d,"empty.db");
    const w=createSnapshot(empty);w.finish({now:1});
    assert.equal(openSnapshot(empty),null,"снимок без мест бесполезен");
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("возраст снимка виден и считается", () => {
  const d=dir();
  try{
    const built=1758000000000;
    const s=openSnapshot(build(d,built),{now:()=>built+40*3600e3});
    assert.equal(Math.round(s.ageMs()/3600e3),40);
    assert.equal(s.stale(36*3600e3),true);
    assert.equal(s.stale(48*3600e3),false);
    s.close();
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("поиск мест идёт из снимка, а не в сеть", async () => {
  const d=dir();
  try{
    const s=openSnapshot(build(d));
    const plan=buildSearchPlan({query:"аптека"});
    const r=await searchOSM(plan,{snapshot:s});
    assert.equal(r.from_snapshot,true,"ответ должен прийти из снимка");
    assert.equal(r.items.length,1);
    // Формат карточки обязан совпадать с живым: иначе выдача из снимка
    // отличалась бы от сетевой и ошибку нельзя было бы воспроизвести.
    const [x]=r.items;
    assert.equal(x.provider,"OpenStreetMap");
    assert.equal(x.kind,"venue");
    assert.deepEqual(x.cat_tags,["pharmacy"]);
    assert.equal(x.coords.lat,55.760);
    assert.equal(x.hours_label,"24/7");
    assert.ok(String(x.source).includes("openstreetmap.org"));
    s.close();
  }finally{rmSync(d,{recursive:true,force:true})}
});

test("рамка делится на четверти без потери площади", () => {
  const q=splitBox(MOSCOW_BBOX);
  assert.equal(q.length,4);
  const area=(b)=>(b.north-b.south)*(b.east-b.west);
  const sum=q.reduce((a,b)=>a+area(b),0);
  assert.ok(Math.abs(sum-area(MOSCOW_BBOX))<1e-9,"четверти покрывают исходную рамку");
  for(const b of q)assert.ok(b.south>=MOSCOW_BBOX.south&&b.north<=MOSCOW_BBOX.north);
});

test("категория, упёршаяся в потолок ответа, добирается по четвертям", async () => {
  const calls=[];
  const cap=3;
  // Первый уровень всегда отдаёт ровно потолок — значит в рамке есть ещё.
  const fetchCell=async(cat,box)=>{
    calls.push(box);
    return calls.length===1?[1,2,3]:[calls.length*10];
  };
  const got=[];
  const n=await collectCategory({tag:"bar"},MOSCOW_BBOX,{fetchCell,cap,onBatch:(e)=>{got.push(...e)}});
  assert.equal(calls.length,5,"одна общая рамка плюс четыре четверти");
  assert.deepEqual(got,[20,30,40,50]);
  assert.equal(n,4,"наружу уходит только счёт, сами элементы — через onBatch");
});

test("собранное не копится в памяти", async () => {
  // На машине с гигабайтом памяти и без подкачки лишний массив на десятки
  // мегабайт отнимает её у сервера и у sshd. Элементы отдаются по клеткам и
  // нигде не накапливаются: наружу уходит число, а не выдача целиком.
  const cap=1000,cell=Array.from({length:cap},(_,i)=>i);
  let handed=0,batches=0;
  const n=await collectCategory({tag:"food"},MOSCOW_BBOX,{
    fetchCell:async()=>cell.slice(),cap,maxDepth:1,
    onBatch:(e)=>{batches++;handed+=e.length}});
  assert.equal(typeof n,"number","возвращается счёт, а не массив");
  assert.equal(batches,4,"каждая клетка отдана отдельно");
  assert.equal(n,handed);
  assert.equal(n,4*cap);
});

test("без приёмника собранное не исчезает молча", async () => {
  await assert.rejects(
    ()=>collectCategory({tag:"bar"},MOSCOW_BBOX,{fetchCell:async()=>[1],cap:10}),
    /onBatch/,"потеря данных должна быть отказом, а не тишиной");
});

test("одиночный отказ повторяется, постоянный — пробрасывается", async () => {
  let n=0;
  const flaky=async()=>{n++;if(n===1)throw new Error("504");return [1]};
  const seen=[];
  assert.equal(await collectCategory({tag:"bar"},MOSCOW_BBOX,{fetchCell:flaky,cap:10,onBatch:(e)=>{seen.push(...e)}}),1);
  assert.deepEqual(seen,[1],"повтор отдаёт клетку так же, как удачная попытка");
  const dead=async()=>{throw new Error("403")};
  await assert.rejects(()=>collectCategory({tag:"bar"},MOSCOW_BBOX,{fetchCell:dead,cap:10,onBatch:()=>{}}),/403/);
});

test("огрызок вместо снимка не публикуется", () => {
  assert.equal(snapshotAcceptable({total:50000,failed:2,targets:60}).ok,true);
  assert.equal(snapshotAcceptable({total:120,failed:0,targets:60}).ok,false,"слишком мало мест");
  assert.equal(snapshotAcceptable({total:50000,failed:30,targets:60}).ok,false,"половина категорий не собралась");
  assert.equal(snapshotAcceptable({total:0,failed:0,targets:0}).ok,false);
});

test("нормализация текста совпадает с той, что в поиске", () => {
  assert.equal(norm("Бар «Ровесник»"),"бар ровесник");
  assert.equal(norm("Кофейня  Skuratov"),"кофейня skuratov");
  assert.equal(norm("ЁЖИК"),"ежик");
});

test("рамка центра лежит внутри рамки города", () => {
  assert.ok(CENTER_BBOX.south>MOSCOW_BBOX.south&&CENTER_BBOX.north<MOSCOW_BBOX.north);
  assert.ok(CENTER_BBOX.west>MOSCOW_BBOX.west&&CENTER_BBOX.east<MOSCOW_BBOX.east);
});

test("версия формата входит в ключ кеша провайдеров", async () => {
  const {readFileSync}=await import("node:fs");
  const src=readFileSync(new URL("../providers.mjs",import.meta.url),"utf8");
  // Файловый кеш переживает перезапуск. Без версии формата сервер после
  // обновления продолжал отдавать карточки, собранные прежним кодом —
  // именно на это я и наступил при проверке.
  assert.ok(/const ITEM_SCHEMA=\d+/.test(src),"версия формата карточки не задана");
  assert.ok(/const base=\{v:ITEM_SCHEMA/.test(src),"версия не входит в ключ кеша");
});

test("категория места берётся из справочника, а не остаётся «Заведением»", async () => {
  const {placeTitle}=await import("../osm_tags.mjs");
  assert.equal(placeTitle({amenity:"pharmacy"}),"Аптека");
  assert.equal(placeTitle({shop:"hairdresser"}),"Барбершоп");
  assert.equal(placeTitle({tourism:"hotel"}),"Отель");
  assert.equal(placeTitle({shop:"car_repair"}),"Автосервис");
  assert.equal(placeTitle({amenity:"нечто-неизвестное"}),null,"не выдумываем");
});

test("состояние снимка объясняет, чего не хватает", async () => {
  const {snapshotStatus}=await import("../providers.mjs");
  const st=snapshotStatus();
  // «ready:false» без причины не отличить от «файла нет», «повреждён» и
  // «сборка упала» — по нему невозможно понять, почему поиск медленный.
  assert.equal(typeof st.ready,"boolean");
  if(!st.ready){
    assert.ok(["missing","unreadable"].includes(st.reason),`причина: ${st.reason}`);
    assert.ok(st.file,"видно, какой файл искали");
    assert.ok("last_build" in st,"виден отчёт последней сборки, если он есть");
  }
});

test("сборка продолжается с недостроенного снимка, а не начинается заново", async () => {
  const {createSnapshot}=await import("../osm_snapshot.mjs");
  const {mkdtempSync,rmSync,existsSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const dir=mkdtempSync(join(tmpdir(),"free-snap-"));
  const file=join(dir,"snap.db");
  const el=(id,name,tags)=>({type:"node",id,lat:55.75,lon:37.62,tags:{name,...tags}});
  try{
    // Первый заход: собрали две категории и упали на третьей.
    const a=createSnapshot(file,{resume:true});
    assert.equal(a.reused,false,"начинаем с чистого листа");
    a.put([el(1,"Бар",{amenity:"bar"})],"bar");a.markDone("bar");
    a.put([el(2,"Кальянная",{amenity:"hookah_lounge"})],"hookah");a.markDone("hookah");
    a.close();                                   // упали: недострой сохраняем
    assert.ok(existsSync(file+".building"),"недострой остаётся на диске");
    assert.ok(!existsSync(file),"готового снимка ещё нет");

    // Второй заход: продолжаем, а не повторяем двадцать минут работы.
    const b=createSnapshot(file,{resume:true});
    assert.equal(b.reused,true);
    assert.deepEqual([...b.done()].sort(),["bar","hookah"]);
    assert.equal(b.places(),2,"собранные места на месте");
    b.put([el(3,"Кафе",{amenity:"cafe"})],"food");b.markDone("food");
    const res=b.finish({source:"overpass"});
    assert.equal(res.places,3);
    assert.ok(existsSync(file));
    assert.ok(!existsSync(file+".building"),"после готовности недостроя не остаётся");

    // Без resume — начинаем с нуля, как и раньше.
    const c=createSnapshot(file);
    assert.equal(c.reused,false);
    assert.equal(c.places(),0);
    c.abort();
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("отменённый сбор перестаёт ходить в сеть", async () => {
  // Бюджет категории бросал ожидание, но не саму работу: рекурсия продолжала
  // качать Overpass и писать в базу — уже под именем следующей категории,
  // потому что счётчик мест общий. Отмена должна останавливать именно работу.
  const ctrl=new AbortController();
  let calls=0;
  const fetchCell=async()=>{calls++;if(calls===2)ctrl.abort();return [1,2,3]};
  const batches=[];
  await assert.rejects(
    ()=>collectCategory({tag:"food"},MOSCOW_BBOX,{fetchCell,cap:3,maxDepth:2,
      onBatch:(e)=>{batches.push(e.length)},signal:ctrl.signal}),
    (e)=>e.name==="AbortError");
  assert.equal(calls,2,"после отмены ни одного нового запроса");
  assert.equal(batches.length,0,"и ни одной новой записи в базу");
});

test("отмена не превращается в повторную попытку", async () => {
  // Отказ сети повторяется один раз — но отменённое повторять нельзя,
  // иначе отмена стоит лишнего похода в сеть вместо того, чтобы экономить.
  const ctrl=new AbortController();
  let calls=0;
  const fetchCell=async()=>{calls++;ctrl.abort();throw Object.assign(new Error("отменено"),{name:"AbortError"})};
  await assert.rejects(
    ()=>collectCategory({tag:"bar"},MOSCOW_BBOX,{fetchCell,cap:10,onBatch:()=>{},signal:ctrl.signal}),
    (e)=>e.name==="AbortError");
  assert.equal(calls,1);
});

test("сигнал отмены доходит до самого запроса", async () => {
  let seen=null;
  const fetchCell=async(_cat,_box,signal)=>{seen=signal;return [1]};
  const ctrl=new AbortController();
  await collectCategory({tag:"bar"},MOSCOW_BBOX,{fetchCell,cap:10,onBatch:()=>{},signal:ctrl.signal});
  assert.equal(seen,ctrl.signal,"иначе оборвать скачивание нечем");
});

test("дубли в индексе не съедают выдачу поиска по названию", async () => {
  // Кофейня приходит и под «едой», и под «кофе»; при возобновлении сборки —
  // ещё раз. place заменяется по ключу, а FTS5 — обычная вставка без
  // уникальности, и место получало столько строк в индексе, сколько раз его
  // записали. В выдаче они не двоятся: поиск схлопывает их по pid. Но limit
  // стоит в самом запросе, ДО схлопывания, — и десять запрошенных строк
  // превращались в три-четыре места. Выдача молча беднела втрое.
  const d=dir(),f=join(d,"dup.db");
  const snap=createSnapshot(f);
  const places=Array.from({length:12},(_,i)=>el(i+1,{name:`Скуратов ${i+1}`,amenity:"cafe"},55.75+i*0.001,37.62));
  snap.put(places,"food");
  snap.put(places,"coffee");        // те же места под второй категорией
  snap.finish({source:"test"});
  const found=openSnapshot(f).search({coreQuery:"скуратов"},{limit:10});
  const names=new Set(found.map(r=>r.tags.name));
  assert.equal(names.size,10,`из десяти запрошенных строк должно выйти десять мест, вышло ${names.size}`);
});
