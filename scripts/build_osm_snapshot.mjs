#!/usr/bin/env node
// Сборка локального снимка мест города из OpenStreetMap. Город — из CITY
// (рамка и имя файла берутся из city.mjs): CITY=dubai node scripts/build_osm_snapshot.mjs
//
//   node --no-warnings=ExperimentalWarning scripts/build_osm_snapshot.mjs
//   node ... scripts/build_osm_snapshot.mjs --out data/osm_moscow.db --only bar,food
//
// Запускается по расписанию (раз в сутки), а не по запросу пользователя. Пока
// сборка идёт, сервер продолжает отвечать из старого снимка: новая база пишется
// во временный файл и подменяется целиком в самом конце.
//
// Нагрузка на чужой сервис здесь наша ответственность: запросы идут по одному,
// с паузой, по зеркалам, а слишком большая категория делится на четверти, чтобы
// не просить у Overpass заведомо неподъёмный объём.
import {CATEGORIES} from "../categories.mjs";
import {categoryOsmKeys} from "../osm_tags.mjs";
import {overpassQuery} from "../providers.mjs";
import {createSnapshot,collectCategory,snapshotAcceptable,CITY_BBOX} from "../osm_snapshot.mjs";
import {SNAPSHOT_STATUS_FILE} from "../providers.mjs";
import {CITY} from "../city.mjs";
import {writeFileSync,mkdirSync,existsSync} from "node:fs";
import {dirname} from "node:path";

// Отчёт о сборке рядом со снимком. Без него /api/health показывает голое
// «ready:false», и почему снимка нет — не понять ни с сервера, ни отсюда.
function report(o){
  try{mkdirSync(dirname(SNAPSHOT_STATUS_FILE),{recursive:true});
    writeFileSync(SNAPSHOT_STATUS_FILE,JSON.stringify(o,null,1));}catch{}
}
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT=fileURLToPath(new URL("..",import.meta.url));
const args=new Map();
for(let i=2;i<process.argv.length;i++){
  const a=process.argv[i];
  if(!a.startsWith("--"))continue;
  const eq=a.indexOf("=");
  if(eq>0)args.set(a.slice(2,eq),a.slice(eq+1));
  else args.set(a.slice(2),process.argv[i+1]&&!process.argv[i+1].startsWith("--")?process.argv[++i]:"1");
}
const OUT=args.get("out")||process.env.OSM_SNAPSHOT||join(ROOT,"data",CITY.snapshotFile);
const ONLY=args.get("only")?new Set(String(args.get("only")).split(",").map(x=>x.trim())):null;
const PAUSE_MS=Number(args.get("pause")||1500);
const CAP=Number(args.get("cap")||3000);
const TIMEOUT_S=Number(args.get("timeout")||90);
// Одна категория не должна съедать весь запуск: «еда» по всей Москве делится
// на клетки, каждую Overpass считает больше минуты, и двадцать минут уходило
// на неё одну. По исчерпании бюджета категория откладывается до следующего
// раза — остальные шестьдесят четыре успеют собраться.
const CAT_BUDGET_MS=Number(args.get("cat-budget")||12)*60000;
// Столько мест в одной категории уже делает её пригодной: полного покрытия
// «еды» по Москве ждать незачем, а без этого порога снимок не соберётся.
const PARTIAL_OK=Number(args.get("partial-ok")||300);
const RESUME=args.get("no-resume")!=="1";

// Готовый снимок, собранный офлайн из выгрузки OSM и каталога Overture
// (source = «osm+overture»), полнее того, что успевает отдать Overpass:
// в нём контакты и адреса десятков тысяч мест. Ночная сборка не должна его
// затирать — только по явной просьбе (--force или FORCE_OVERPASS=1).
{
  const force=args.get("force")==="1"||process.env.FORCE_OVERPASS==="1";
  if(!force&&existsSync(OUT)){
    try{
      const {DatabaseSync}=await import("node:sqlite");
      const db=new DatabaseSync(OUT,{readOnly:true});
      const src=db.prepare("select v from meta where k='source'").get();
      db.close();
      if(src&&String(src.v).includes("overture")){
        console.log(`снимок ${OUT} собран офлайн (${src.v}) — Overpass его не перезаписывает; --force, чтобы пересобрать`);
        process.exit(0);
      }
    }catch{/* не читается — значит, собираем заново */}
  }
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const bboxStr=(b)=>`${b.south},${b.west},${b.north},${b.east}`;

// Запрос по одной категории в одной рамке. Возвращает элементы либо бросает.
async function fetchCell(cat,box,signal){
  const filters=(cat.osm||[]).map(f=>f.replaceAll("{{bbox}}",bboxStr(box))).join("");
  if(!filters)return [];
  const q=`[out:json][timeout:${TIMEOUT_S}];(${filters});out center tags ${CAP};`;
  const d=await overpassQuery(q,{timeoutMs:(TIMEOUT_S+10)*1000,signal});
  // Перегрузка приходит как обычный ответ с полем remark — без проверки это
  // выглядело бы как «в этой клетке пусто».
  if(d&&d.remark&&/timed out|error|too busy|load/i.test(String(d.remark)))
    throw new Error(`Overpass: ${String(d.remark).slice(0,100)}`);
  return d.elements||[];
}
/* Часы на бюджет категории.
 *
 * Бюджет обязан обрывать саму работу, а не только ожидание её. Раньше здесь
 * была гонка двух промисов: главный цикл переставал ждать и шёл дальше, а
 * брошенная рекурсия продолжала качать Overpass и писать в базу. Счётчик мест
 * общий на всю сборку, поэтому сироты приписывали найденное следующей
 * категории — и та считалась собранной, даже если сама не нашла ничего, и
 * навсегда выпадала из возобновления. Плюс несколько одновременных скачиваний
 * вместо одного на сервисе, которым пользуемся бесплатно.
 *
 * Таймер тоже надо снимать. Каждый setTimeout держит цикл событий, и после
 * «Готово» процесс жил ещё столько, сколько оставалось от последнего бюджета, —
 * до двенадцати минут, занимая всё это время пиковую память на машине, где её
 * гигабайт и нет подкачки. Systemd всё это время считает сборку идущей.
 */
function withBudget(run,ms,tag){
  const ctrl=new AbortController();
  let timer=null;
  const alarm=new Promise((_,rej)=>{
    timer=setTimeout(()=>{
      ctrl.abort();
      rej(new Error(ms>=60000?`превышен бюджет ${Math.round(ms/60000)} мин`:`превышен бюджет ${Math.round(ms/1000)} с`));
    },ms);
  });
  return Promise.race([run(ctrl.signal),alarm]).finally(()=>clearTimeout(timer));
}

const targets=CATEGORIES.filter(c=>c.osm&&c.osm.length&&(!ONLY||ONLY.has(c.tag)));
if(!targets.length){console.error("нет категорий для сборки");process.exit(1)}

console.log(`Сборка снимка (${CITY.name}): ${targets.length} категорий → ${OUT}`);
console.log(`Рамка ${bboxStr(CITY_BBOX)}, потолок ${CAP} на запрос, пауза ${PAUSE_MS} мс\n`);
// Сухая проверка: NODE_ENV=test — показать план и выйти, в сеть не ходить.
if(process.env.NODE_ENV==="test"){console.log("NODE_ENV=test: сухой запуск, сборка не выполняется");process.exit(0)}

const snap=createSnapshot(OUT,{resume:RESUME});
const already=snap.done();
if(snap.reused)console.log(`Продолжаю недостроенный снимок: готово ${already.size} категорий, ${snap.places()} мест`);
const failed=[],partial=[];
let total=snap.places(),done=0;
const started=Date.now();

for(const cat of targets){
  done++;
  const keys=categoryOsmKeys(cat);
  const label=`[${String(done).padStart(2)}/${targets.length}] ${cat.tag}`;
  if(already.has(cat.tag)){
    console.log(`${label.padEnd(26)} уже собрана, пропускаю`);
    continue;
  }
  const before=total;
  let got=0;
  // Клетки уходят в базу по мере готовности: обрыв на середине большой
  // категории больше не уничтожает то, что уже собрано.
  const onBatch=(els)=>{got+=els.length;total=snap.put(els,cat.tag)};
  try{
    await withBudget(
      (signal)=>collectCategory(cat,CITY_BBOX,{fetchCell,cap:CAP,pause:()=>sleep(PAUSE_MS),onBatch,signal}),
      CAT_BUDGET_MS,cat.tag);
    snap.markDone(cat.tag);                    // в следующий раз не переделываем
    console.log(`${label.padEnd(26)} ${String(got).padStart(5)} объектов, всего ${total} (+${total-before})  ${keys.slice(0,2).join(", ")||"по названию"}`);
  }catch(e){
    const why=String(e&&e.message||e);
    // Собрали достаточно, просто не успели дочистить хвост: считаем категорию
    // готовой, иначе огромная «еда» не даст снимку собраться никогда.
    if(total-before>=PARTIAL_OK){
      snap.markDone(cat.tag);
      partial.push({tag:cat.tag,places:total-before,error:why});
      console.log(`${label.padEnd(26)} ${String(got).padStart(5)} объектов, всего ${total} (+${total-before})  частично: ${why.slice(0,40)}`);
    }else{
      failed.push({tag:cat.tag,error:why});
      console.log(`${label.padEnd(26)} ОШИБКА: ${why.slice(0,60)}`);
    }
  }
  await sleep(PAUSE_MS);
}

// Второй и третий заходы по тому, что не собралось. Раньше такие категории
// просто выпадали до завтрашнего таймера: город считался собранным, а на
// «театр» или «гольф» поиск молчал. Overpass часто отказывает из-за загрузки,
// а не навсегда — через пару минут та же категория проходит. Бюджет на заход
// больше, пауза перед ним длиннее, чтобы зеркала успели остыть.
for(let pass=2;pass<=3&&failed.length;pass++){
  const retry=failed.splice(0,failed.length);
  console.log(`\nЗаход ${pass}: повторяю ${retry.length} категорий — ${retry.map(f=>f.tag).join(", ")}`);
  await sleep(PAUSE_MS*20);
  for(const f of retry){
    const cat=targets.find(c=>c.tag===f.tag);if(!cat)continue;
    const before=total;let got=0;
    const onBatch=(els)=>{got+=els.length;total=snap.put(els,cat.tag)};
    try{
      await withBudget((signal)=>collectCategory(cat,CITY_BBOX,{fetchCell,cap:CAP,pause:()=>sleep(PAUSE_MS*2),onBatch,signal}),
        CAT_BUDGET_MS*2,cat.tag);
      snap.markDone(cat.tag);
      console.log(`  ${cat.tag.padEnd(16)} ${String(got).padStart(5)} объектов, всего ${total} (+${total-before})`);
    }catch(e){
      const why=String(e&&e.message||e);
      if(total-before>=PARTIAL_OK){snap.markDone(cat.tag);partial.push({tag:cat.tag,places:total-before,error:why});
        console.log(`  ${cat.tag.padEnd(16)} частично: +${total-before}`)}
      else{failed.push({tag:cat.tag,error:why});console.log(`  ${cat.tag.padEnd(16)} снова ошибка: ${why.slice(0,60)}`)}
    }
    await sleep(PAUSE_MS*2);
  }
}

// Лучше оставить прежний снимок, чем подменить его огрызком.
const verdict=snapshotAcceptable({total,failed:failed.length,targets:targets.length});
if(!verdict.ok){
  // Недострой НЕ выбрасываем: собранные категории помечены, и следующий
  // запуск возьмётся за оставшиеся вместо того, чтобы начать с нуля.
  snap.close?.();
  report({ok:false,reason:verdict.reason,places:total,resumable:true,done:[...snap.done()].length,
    duration_s:Math.round((Date.now()-started)/1000),
    failed:failed.slice(0,20),partial:partial.slice(0,20),targets:targets.length});
  console.error(`\nСнимок НЕ заменён: ${verdict.reason}.`);
  console.error("Прежний снимок остался на месте. Причины:");
  for(const f of failed.slice(0,10))console.error(`  ${f.tag}: ${f.error}`);
  process.exit(2);
}

const res=snap.finish({source:"overpass"});
const mins=((Date.now()-started)/60000).toFixed(1);
report({ok:true,places:res.places,duration_s:Math.round((Date.now()-started)/1000),
  failed:failed.slice(0,20),partial:partial.slice(0,20),targets:targets.length});
console.log(`\nГотово за ${mins} мин: ${res.places} мест → ${res.file}`);
if(partial.length)console.log(`Собраны частично: ${partial.map(f=>`${f.tag} (${f.places})`).join(", ")}`);
if(failed.length)console.log(`Не собрались: ${failed.map(f=>f.tag).join(", ")}`);
// Работа сделана — выходим сразу, не дожидаясь, пока цикл событий опустеет сам.
// Держать процесс с пиковой памятью на машине с гигабайтом ради висящего
// таймера или сокета незачем, а systemd считает oneshot идущим до самого конца.
process.exit(0);
