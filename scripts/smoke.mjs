#!/usr/bin/env node
// Быстрая проверка живых данных на сервере: несколько запросов на языке города,
// что нашлось и с какими полями. Запуск: node scripts/smoke.mjs (берёт .env).
import {readFileSync} from "node:fs";
try{for(const l of readFileSync(new URL("../.env",import.meta.url),"utf8").split("\n")){const m=/^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2]}}catch{}
const {CITY}=await import("../city.mjs");
const {searchLiveInventory}=await import("../providers.mjs");
const {rankLive}=await import("../live_ranker.mjs");
const Q=CITY.lang==="en"?["want a drink","shisha","dinner with a view","coffee","beach","what to see","something to do tonight"]
  :["хочу выпить","кальян","поужинать","кофейня"];
const loc=CITY.center;
console.log(`Город: ${CITY.name} (${CITY.id}), язык ${CITY.lang}`);
for(const q of Q){
  const t=Date.now();const args={query:q,user_location:loc};
  try{
    const r=await searchLiveInventory(args);const top=rankLive(r.items,args,r.plan);
    const photo=top.filter(x=>x.aggregator_image||x.image_url||x.image_raw||x.wikimedia_commons).length;
    console.log(`\n«${q}» — ${r.items.length} найдено, в выдаче ${top.length}, ${Date.now()-t} мс${r.note?` · ${r.note}`:""}`);
    for(const x of top)console.log(`  • ${x.name} | ${x.cat||""} | ${x.area||""} | часы: ${x.hours_label||"—"} | тел: ${x.phone?"есть":"—"} | сайт: ${x.official_source?"есть":"—"}`);
    if(r.errors?.length)console.log("  ошибки:",r.errors.slice(0,2).join(" | "));
  }catch(e){console.log(`\n«${q}» — ОШИБКА: ${e.message}`)}
}
process.exit(0);
