#!/usr/bin/env node
// Послушать голоса SpeechKit и выбрать Савве свой.
//
// Голос агента — не техническая настройка, а его лицо: выбирать его по
// названию в документации бессмысленно, надо слышать. Скрипт синтезирует
// одну и ту же фразу разными голосами и кладёт файлы в public/voices/,
// откуда их открывает браузер телефона.
//
//   node scripts/voices.mjs                      — мужские голоса
//   node scripts/voices.mjs --all                — все
//   node scripts/voices.mjs --voices zahar,ermil — выбранные
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

const MALE=["filipp","ermil","zahar","madirus"];
const FEMALE=["alena","jane","omazh","dasha","julia","lera","marina"];

function arg(name,fallback=null){
  const i=process.argv.indexOf(name);
  return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback;
}
const text=arg("--text","Ближе всего «Ровесник» — три минуты пешком. Показать ещё?");
const list=arg("--voices")?arg("--voices").split(",").map(s=>s.trim()).filter(Boolean)
  :process.argv.includes("--all")?[...MALE,...FEMALE]:MALE;

const cfg=yandexConfig();
if(!cfg.ready){
  console.error("Нужны YANDEX_API_KEY и YANDEX_FOLDER_ID в .env");
  process.exit(1);
}

const out=join(ROOT,"public","voices");
rmSync(out,{recursive:true,force:true});
mkdirSync(out,{recursive:true});

const ok=[];
for(const voice of list){
  try{
    const mp3=await yandexTts(text,{cfg,voice});
    writeFileSync(join(out,`${voice}.mp3`),mp3);
    ok.push(voice);
    console.log(`  ${voice.padEnd(10)} готов (${(mp3.length/1024).toFixed(0)} КБ)`);
  }catch(e){
    // Голос может быть недоступен в каталоге — это не повод бросать остальные.
    const why=e instanceof YandexError?e.message:String(e&&e.message||e);
    console.log(`  ${voice.padEnd(10)} не вышло: ${why}`);
  }
}

if(!ok.length){console.error("\nНи один голос не синтезировался.");process.exit(1)}
const host=process.env.PUBLIC_HOST||"afishasity.ru";
console.log(`\nПослушайте с телефона:`);
for(const v of ok)console.log(`  https://${host}/voices/${v}.mp3   ${v}`);
console.log(`\nПонравившийся впишите в .env:  YANDEX_VOICE=<имя>   затем  systemctl restart free`);
console.log(`Потом удалите образцы:         rm -rf ${out}`);
