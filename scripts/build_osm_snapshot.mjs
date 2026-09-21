#!/usr/bin/env node
// Сборка локального снимка мест Москвы из OpenStreetMap.
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
import {createSnapshot,collectCategory,snapshotAcceptable,MOSCOW_BBOX} from "../osm_snapshot.mjs";
import {SNAPSHOT_STATUS_FILE} from "../providers.mjs";
import {writeFileSync,mkdirSync} from "node:fs";
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
const OUT=args.get("out")||join(ROOT,"data","osm_moscow.db");
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

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const bboxStr=(b)=>`${b.south},${b.west},${b.north},${b.east}`;

// Запрос по одной категории в одной рамке. Возвращает элементы либо бросает.
async function fetchCell(cat,box){
  const filters=(cat.osm||[]).map(f=>f.replaceAll("{{bbox}}",bboxStr(box))).join("");
  if(!filters)return [];
  const q=`[out:json][timeout:${TIMEOUT_S}];(${filters});out center tags ${CAP};`;
  const d=await overpassQuery(q,{timeoutMs:(TIMEOUT_S+10)*1000});
  // Перегрузка приходит как обычный ответ с полем remark — без проверки это
  // выглядело бы как «в этой клетке пусто».
  if(d&&d.remark&&/timed out|error|too busy|load/i.test(String(d.remark)))
    throw new Error(`Overpass: ${String(d.remark).slice(0,100)}`);
  return d.elements||[];
}
// Часы на бюджет категории: обрываем ожидание, а не саму сборку.
function withBudget(promise,ms,tag){
  return Promise.race([promise,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error(ms>=60000?`превышен бюджет ${Math.round(ms/60000)} мин`:`превышен бюджет ${Math.round(ms/1000)} с`)),ms))]);
}

const targets=CATEGORIES.filter(c=>c.osm&&c.osm.length&&(!ONLY||ONLY.has(c.tag)));
if(!targets.length){console.error("нет категорий для сборки");process.exit(1)}

console.log(`Сборка снимка: ${targets.length} категорий → ${OUT}`);
console.log(`Рамка ${bboxStr(MOSCOW_BBOX)}, потолок ${CAP} на запрос, пауза ${PAUSE_MS} мс\n`);

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
      collectCategory(cat,MOSCOW_BBOX,{fetchCell,cap:CAP,pause:()=>sleep(PAUSE_MS),onBatch}),
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
