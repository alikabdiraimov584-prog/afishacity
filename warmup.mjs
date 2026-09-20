// Прогрев кеша провайдеров: популярные запросы прогоняются через searchLiveInventory
// последовательно с небольшой паузой — при старте (через 10 с) и затем каждые 30 минут.
// Отключается переменной окружения FREE_WARMUP=0.
import {searchLiveInventory} from "./providers.mjs";

export const WARMUP_QUERIES=["бар","ресторан","кальянная","стендап","концерт","выставка","спектакль","караоке","ночной клуб","кофейня","свидание","с детьми"];

export function startWarmup({intervalMs=30*60_000,initialDelayMs=10_000,gapMs=1500,queries=WARMUP_QUERIES,search=searchLiveInventory,env=process.env,log=(m)=>console.log(m),unref=true}={}){
  if(String(env.FREE_WARMUP??"")==="0")return {enabled:false,runs:0,stop(){},runOnce:async()=>null};
  let stopped=false,running=null,timer=null,runs=0;
  // unref: таймеры не держат процесс (в тестах выключаем, чтобы цикл событий дождался прогона).
  const sleep=ms=>new Promise(r=>{const t=setTimeout(r,ms);if(unref&&typeof t.unref==="function")t.unref()});
  async function runOnce(){
    if(running)return running; // один прогон за раз
    running=(async()=>{
      const t0=Date.now();let ok=0,fail=0;
      for(const q of queries){
        if(stopped)break;
        try{const r=await search({query:q},env);if((r?.errors||[]).length&&!(r?.items||[]).length)fail++;else ok++}catch(e){fail++}
        if(gapMs>0)await sleep(gapMs);
      }
      runs++;running=null;
      const res={ok,fail,ms:Date.now()-t0};
      log(`Warmup: ${ok} запросов прогрето, ${fail} с ошибкой, ${res.ms} мс`);
      return res;
    })();
    return running;
  }
  function schedule(ms){
    timer=setTimeout(async()=>{if(stopped)return;try{await runOnce()}catch(e){log(`Warmup: ${e.message}`)}if(!stopped)schedule(intervalMs)},ms);
    if(unref&&typeof timer.unref==="function")timer.unref();
  }
  schedule(initialDelayMs);
  return {enabled:true,runOnce,stop(){stopped=true;if(timer)clearTimeout(timer)},get runs(){return runs}};
}
