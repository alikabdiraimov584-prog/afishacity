#!/usr/bin/env node
// Проверка ключа 2GIS на живых данных.
//
// Весь приём данных 2GIS написан по документации, вслепую: из среды разработки
// до их серверов не достучаться. Этот скрипт делает настоящий запрос и
// показывает, что пришло и что из этого код сумел разобрать. Демо-ключи и
// тарифы отличаются набором полей — рейтинги и фотографии есть не везде.
//
//   node scripts/check_2gis.mjs                 — ключ из .env
//   node scripts/check_2gis.mjs --key КЛЮЧ      — проверить чужой ключ
//   node scripts/check_2gis.mjs --query кальян  — другой запрос
//   node scripts/check_2gis.mjs --raw           — показать сырой ответ целиком
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {loadDotenv} from "../env.mjs";
import {search2GIS,buildSearchPlan} from "../providers.mjs";
import {rankLive,resultPayload} from "../live_ranker.mjs";

const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
loadDotenv(join(ROOT,".env"));

const arg=(n,d=null)=>{const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:d};
const key=arg("--key")||process.env.DGIS_API_KEY||process.env.TWOGIS_API_KEY||"";
const query=arg("--query","бар");
const raw=process.argv.includes("--raw");

if(!key){
  console.error("Ключ не найден. Впишите DGIS_API_KEY в .env или передайте --key.");
  process.exit(1);
}
console.log(`Ключ: ${key.slice(0,8)}…${key.slice(-4)}  |  запрос: «${query}»\n`);

// Первый запрос — сырой, чтобы увидеть форму ответа своими глазами.
const u=new URL("https://catalog.api.2gis.com/3.0/items");
for(const [k,v] of Object.entries({key,q:query,type:"branch",point:"37.6173,55.7558",radius:"4000",
  page_size:"5",locale:"ru_RU",
  fields:"items.point,items.rubrics,items.schedule,items.full_address_name,items.contact_groups,items.external_content,items.reviews,items.flags,items.org"}))
  u.searchParams.set(k,v);

let body=null,status=0,rawText="";
try{
  const r=await fetch(u,{signal:AbortSignal.timeout(15000)});
  status=r.status;
  rawText=await r.text().catch(()=>"");
  try{body=JSON.parse(rawText)}catch{body=null}
}catch(e){
  console.error(`Не удалось обратиться к 2GIS: ${e&&e.message||e}`);
  console.error("Проверьте, что сервер ходит в интернет и адрес catalog.api.2gis.com не закрыт.");
  process.exit(2);
}

const meta=body&&body.meta;
console.log(`HTTP ${status}  |  код в ответе: ${meta?.code??"—"}  ${meta?.error?`|  ошибка: ${meta.error.type}: ${meta.error.message}`:""}`);
if(status!==200||meta?.code!==200){
  // Ответ не от 2GIS выглядит иначе: у них всегда JSON с полем meta. Если его
  // нет — между нами и ними стоит что-то ещё, и дело не в ключе.
  if(!body||!meta){
    console.error("\nОтветил не 2GIS: в ответе нет их обычного поля meta.");
    console.error("Похоже, запрос не вышел наружу — корпоративный прокси, файрвол или DNS.");
    console.error("Что пришло на самом деле:\n  "+(rawText||"(пусто)").replace(/\s+/g," ").slice(0,300));
    process.exit(5);
  }
  console.error("\nКлюч не принят или запрос отклонён. Что обычно значит:");
  console.error("  403 / «Access denied» — ключ не для Catalog API (частая причина: демо-ключ");
  console.error("        выдан для карт, а справочник организаций — отдельный продукт),");
  console.error("        либо ключ ограничен по адресу или домену");
  console.error("  429 — исчерпан суточный лимит");
  console.error("\nОтвет 2GIS:\n  "+JSON.stringify(body).slice(0,600));
  process.exit(3);
}

const items=body.result?.items||[];
console.log(`Нашлось: ${items.length} (всего по запросу: ${body.result?.total??"—"})\n`);
if(!items.length){console.error("Пусто: проверьте запрос.");process.exit(4)}

// Что из нужного реально пришло. Именно здесь видно, даёт ли ключ рейтинги.
const has=(f)=>items.filter(f).length;
const fields=[
  ["координаты",   x=>x.point,                                        "обязательно: без них нет расстояния"],
  ["рубрики",      x=>(x.rubrics||[]).length,                         "обязательно: из них берётся категория"],
  ["адрес",        x=>x.address_name||x.full_address_name,            "показывается на карточке"],
  ["часы",         x=>x.schedule&&Object.keys(x.schedule).length,     "необязательно"],
  ["контакты",     x=>(x.contact_groups||[]).length,                  "телефон и сайт"],
  ["рейтинг",      x=>x.reviews&&x.reviews.general_rating,            "ГЛАВНОЕ: оценки людей"],
  ["фотографии",   x=>(x.external_content||[]).some(c=>c&&c.main_photo_url),"ГЛАВНОЕ: кадры заведений"],
];
console.log("Поля в ответе:");
for(const [name,f,why] of fields){
  const n=has(f);
  const mark=n===items.length?"есть":n?`частично (${n} из ${items.length})`:"НЕТ";
  console.log(`  ${name.padEnd(12)} ${mark.padEnd(22)} ${why}`);
}

// Теперь то же самое глазами приложения.
const plan=buildSearchPlan({query});
const out=await search2GIS(plan,key);
console.log(`\nРазобрано приложением: ${out.items.length} мест${out.errors.length?`, ошибок ${out.errors.length}`:""}`);
for(const e of out.errors)console.log(`  ошибка: ${e}`);
for(const x of out.items.slice(0,5)){
  const r=Number.isFinite(x.rating)?`${x.rating} (${x.rating_count})`:"—";
  console.log(`  ${String(x.name).slice(0,26).padEnd(28)} оценка ${r.padEnd(12)} фото ${x.aggregator_image?"есть":"нет"}  закрыт ${x.closed?"да":"нет"}  теги ${JSON.stringify(x.cat_tags)}`);
}

const ranked=rankLive(out.items,{query},plan);
const payload=resultPayload(ranked,{});
console.log(`\nПосле ранжирования: ${payload.results.length}`);
for(const r of payload.results)
  console.log(`  ${String(r.name).slice(0,26).padEnd(28)} совпадение ${r.match}%  оценка ${r.rating??"—"}  качество ${r.quality}`);

const withRating=out.items.filter(x=>Number.isFinite(x.rating)&&x.rating>0).length;
const withPhoto=out.items.filter(x=>x.aggregator_image).length;
console.log("\nИтог:");
if(!withRating)console.log("  Рейтингов нет. На этом тарифе поле reviews недоступно — порядок выдачи будет считаться без оценок людей.");
else console.log(`  Рейтинги приходят у ${withRating} из ${out.items.length} — они уже влияют на порядок и видны на карточке.`);
if(!withPhoto)console.log("  Фотографий нет. Поле external_content недоступно — карточки останутся с обложками.");
else console.log(`  Фотографии приходят у ${withPhoto} из ${out.items.length}.`);
if(raw)console.log("\nСырой ответ:\n"+JSON.stringify(body.result?.items?.[0]||body,null,1).slice(0,4000));
