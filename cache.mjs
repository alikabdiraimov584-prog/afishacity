// Кеш результатов провайдеров (TTL + stale-while-revalidate) и предохранитель (circuit breaker)
// на каждый источник. Без внешних зависимостей; время инжектируется через now() для тестов.
import {mkdirSync,existsSync,readFileSync,writeFileSync} from "node:fs";
import {dirname} from "node:path";

// createCache({ttlMs, staleMs, max, file, now, debounceMs})
//  get(key) → {value, fresh, age_ms} | null (запись старше staleMs считается протухшей и удаляется)
//  set(key, value) — сквозная запись в файл с задержкой debounceMs
//  flush() — синхронно записать файл; load() — прочитать файл (вызывается при создании)
export function createCache({ttlMs=10*60_000,staleMs=6*60*60_000,max=500,file=null,now=Date.now,debounceMs=800}={}){
  const map=new Map();let timer=null,dirty=false;
  function prune(){while(map.size>max){const k=map.keys().next().value;map.delete(k)}}
  function load(){
    if(!file||!existsSync(file))return 0;
    try{
      const raw=JSON.parse(readFileSync(file,"utf8"));const t=now();let n=0;
      for(const [k,e] of Object.entries(raw||{})){
        if(!e||typeof e.at!=="number"||t-e.at>staleMs)continue;
        map.set(k,{at:e.at,value:e.value});n++;
      }
      prune();return n;
    }catch(e){return 0}
  }
  function flush(){
    if(timer){clearTimeout(timer);timer=null}
    if(!file||!dirty)return false;
    try{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(Object.fromEntries(map)));dirty=false;return true}
    catch(e){console.error("cache save:",e.message);return false}
  }
  function schedule(){
    dirty=true;if(!file||timer)return;
    timer=setTimeout(()=>{timer=null;flush()},debounceMs);
    if(typeof timer.unref==="function")timer.unref();
  }
  function get(key){
    const e=map.get(key);if(!e)return null;
    const age=now()-e.at;
    if(age>staleMs){map.delete(key);schedule();return null}
    // LRU: свежепрочитанная запись уходит в конец.
    map.delete(key);map.set(key,e);
    return {value:e.value,fresh:age<=ttlMs,age_ms:age};
  }
  function set(key,value){map.delete(key);map.set(key,{at:now(),value});prune();schedule()}
  function del(key){if(map.delete(key))schedule()}
  function clear(){map.clear();schedule()}
  load();
  return {get,set,delete:del,clear,flush,load,get size(){return map.size},keys:()=>[...map.keys()],ttlMs,staleMs,file};
}

// Предохранитель: после `failures` подряд неудач источник пропускается на cooldownMs,
// затем разрешается одна пробная попытка (half-open). Успех сбрасывает счётчик.
const BREAKERS=new Map();
function breaker(name){let b=BREAKERS.get(name);if(!b){b={failures:0,openedAt:null,lastError:null,probing:false};BREAKERS.set(name,b)}return b}

export function breakerStatus(name,{cooldownMs=5*60_000,now=Date.now}={}){
  const b=breaker(name);
  const open=b.openedAt!==null&&now()-b.openedAt<cooldownMs;
  return {name,open,degraded:b.openedAt!==null,failures:b.failures,lastError:b.lastError,
    retryInMs:open?Math.max(0,cooldownMs-(now()-b.openedAt)):0};
}
export function resetBreakers(name){if(name)BREAKERS.delete(name);else BREAKERS.clear()}

export class CircuitOpenError extends Error{
  constructor(name,retryInMs){super(`${name}: источник временно отключён после сбоев, повтор через ${Math.ceil(retryInMs/60_000)} мин`);this.open=true;this.name="CircuitOpenError";this.provider=name;this.retryInMs=retryInMs}
}

// withBreaker(name, fn, {failures, cooldownMs, now}) → результат fn() или CircuitOpenError без вызова fn.
export async function withBreaker(name,fn,{failures=3,cooldownMs=5*60_000,now=Date.now}={}){
  const b=breaker(name);
  if(b.openedAt!==null){
    const elapsed=now()-b.openedAt;
    if(elapsed<cooldownMs||b.probing)throw new CircuitOpenError(name,Math.max(0,cooldownMs-elapsed));
    b.probing=true; // half-open: одна пробная попытка
  }
  try{
    const r=await fn();
    b.failures=0;b.openedAt=null;b.lastError=null;b.probing=false;
    return r;
  }catch(e){
    b.failures++;b.lastError=e?.message||String(e);b.probing=false;
    if(b.failures>=failures)b.openedAt=now();
    throw e;
  }
}
