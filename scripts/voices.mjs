#!/usr/bin/env node
// Послушать голоса SpeechKit и выбрать Савве свой.
//
// Голос агента — не техническая настройка, а его лицо: выбирать его по
// названию в документации бессмысленно, надо слышать. Скрипт синтезирует
// одну и ту же фразу разными голосами и кладёт файлы в public/voices/,
// откуда их открывает браузер телефона.
//
//   node scripts/voices.mjs                          — молодые голоса с амплуа
//   node scripts/voices.mjs --all                    — вообще все
//   node scripts/voices.mjs --voices anton:good,lera — выбранные
//   node scripts/voices.mjs --text "своя фраза"
//
// Удалить после выбора: rm -rf public/voices
import {mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {loadDotenv} from "../env.mjs";
import {yandexTts,yandexConfig,YandexError} from "../yandex.mjs";

const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
loadDotenv(join(ROOT,".env"));

// Голоса третьей версии звучат моложе и естественнее; старые голоса первой
// слышно как «робот читает». Амплуа меняет возраст звучания сильнее тембра,
// поэтому каждый молодой голос пробуем в двух амплуа.
const YOUNG=[["anton","good"],["anton","neutral"],["alexander","good"],["alexander","neutral"],
             ["kirill","good"],["kirill","neutral"],["masha","good"],["masha","neutral"],
             ["dasha","good"],["julia","good"],["lera","good"]];
const OLD=[["filipp",""],["ermil",""],["zahar",""],["madirus",""],["marina",""],["alena",""]];

function arg(name,fallback=null){
  const i=process.argv.indexOf(name);
  return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback;
}
const text=arg("--text","Ближе всего «Ровесник» — три минуты пешком. Показать ещё?");
// --voices принимает «голос» или «голос:амплуа».
const list=arg("--voices")
  ?arg("--voices").split(",").map(x=>x.trim()).filter(Boolean).map(x=>x.split(":"))
  :process.argv.includes("--all")?[...YOUNG,...OLD]:YOUNG;

const cfg=yandexConfig();
if(!cfg.ready){
  console.error("Нужны YANDEX_API_KEY и YANDEX_FOLDER_ID в .env");
  process.exit(1);
}

const out=join(ROOT,"public","voices");
rmSync(out,{recursive:true,force:true});
mkdirSync(out,{recursive:true});

const ok=[];
for(const [voice,role=""] of list){
  const name=role?`${voice}-${role}`:voice;
  try{
    const mp3=await yandexTts(text,{cfg,voice,role});
    writeFileSync(join(out,`${name}.mp3`),mp3);
    ok.push(name);
    console.log(`  ${name.padEnd(20)} готов (${(mp3.length/1024).toFixed(0)} КБ)`);
  }catch(e){
    // Голос или амплуа могут быть недоступны — это не повод бросать остальные.
    const why=e instanceof YandexError?e.message:String(e&&e.message||e);
    console.log(`  ${name.padEnd(20)} не вышло: ${why}`);
  }
}

if(!ok.length){console.error("\nНи один голос не синтезировался.");process.exit(1)}
const host=process.env.PUBLIC_HOST||"afishasity.ru";
console.log(`\nПослушайте с телефона:`);
for(const v of ok)console.log(`  https://${host}/voices/${v}.mp3   ${v}`);
console.log(`\nПонравившийся впишите в .env: YANDEX_VOICE=<голос> и YANDEX_ROLE=<амплуа>`);
console.log(`(в имени файла они через дефис: anton-good → YANDEX_VOICE=anton, YANDEX_ROLE=good)`);
console.log(`Затем: systemctl restart free`);
console.log(`Потом удалите образцы:         rm -rf ${out}`);
