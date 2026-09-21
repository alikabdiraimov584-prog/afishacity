import test from "node:test";
import assert from "node:assert/strict";
import {searchLiveInventory} from "../providers.mjs";
import {createCache,resetBreakers,breakerStatus} from "../cache.mjs";
import {startWarmup,WARMUP_QUERIES} from "../warmup.mjs";

const clock=(start=10_000_000)=>{let t=start;return {now:()=>t,tick(ms){t+=ms}}};
const venue=(id,name)=>({id,kind:"venue",name,cat:"Бар",tags:["bar"],area:"Москва",times:[],hours_label:"24/7",price_label:"",price_min:null,provider:"KudaGo",live:true,desc:"",keywords:"бар"});
const okProvider=(items)=>async()=>({items,errors:[]});
const emptyProvider=async()=>({items:[],errors:[]});
const env={};

test("searchLiveInventory: свежий ответ кешируется, провайдер не дёргается повторно", async ()=>{
  resetBreakers();
  const c=clock();const cache=createCache({ttlMs:1000,staleMs:5000,now:c.now});
  let calls=0;
  const providers={kudago:async()=>{calls++;return {items:[venue("k1","Бар Один")],errors:[]}},timepad:emptyProvider,osm:emptyProvider,dgis:emptyProvider};
  const r1=await searchLiveInventory({query:"бар"},env,{providers,cache,now:c.now});
  assert.equal(calls,1);assert.equal(r1.from_cache.kudago,false);assert.equal(r1.degraded.kudago,false);
  assert.deepEqual(r1.degraded,{kudago:false,timepad:false,osm:false,dgis:false});
  assert.equal(r1.providers.dgis,false,"без ключа 2GIS отключён");
  assert.equal(r1.note,null);
  const r2=await searchLiveInventory({query:"бар"},env,{providers,cache,now:c.now});
  assert.equal(calls,1,"второй вызов из кеша");
  assert.equal(r2.from_cache.kudago,true);assert.equal(r2.items[0].id,"k1");
  // Другой запрос — другой ключ.
  await searchLiveInventory({query:"кальянная"},env,{providers,cache,now:c.now});
  assert.equal(calls,2);
});

test("searchLiveInventory: при сбое источника отдаётся сохранённый ответ, degraded и note выставлены", async ()=>{
  resetBreakers();
  const c=clock();const cache=createCache({ttlMs:1000,staleMs:5000,now:c.now});
  let fail=false;
  const providers={
    kudago:async()=>{if(fail)throw new Error("ECONNRESET");return {items:[venue("k1","Бар Один")],errors:[]}},
    timepad:okProvider([]),osm:emptyProvider,dgis:emptyProvider
  };
  await searchLiveInventory({query:"бар"},env,{providers,cache,now:c.now});
  c.tick(2000);fail=true; // TTL истёк, источник упал
  const r=await searchLiveInventory({query:"бар"},env,{providers,cache,now:c.now});
  assert.equal(r.degraded.kudago,true);assert.equal(r.from_cache.kudago,true);
  assert.equal(r.items[0].id,"k1","stale-ответ всё ещё отдаётся");
  assert.ok(r.errors.some(e=>/KudaGo: ECONNRESET/.test(e)),r.errors.join());
  // KudaGo — афиша событий; запросу «бар» она не нужна. Раньше примечание
  // вставало при любом сбое, и каждый ответ выглядел как поломка.
  assert.equal(r.note,null,"сбой нерелевантного источника не показываем");
  // А когда упал нужный источник и найдено мало — примечание есть.
  const ev=await searchLiveInventory({query:"стендап"},env,{providers,cache,now:c.now});
  assert.equal(ev.degraded.kudago,true);
  assert.match(ev.note,/не ответила|не отвечает/,"упал нужный источник, найдено мало — человек об этом знает");
  assert.equal(r.degraded.timepad,false);
});

test("searchLiveInventory: провайдер, вернувший только ошибки, считается упавшим; предохранитель размыкается после 3 сбоев", async ()=>{
  resetBreakers();
  const c=clock();const cache=createCache({ttlMs:1000,staleMs:5000,now:c.now});
  let calls=0;
  const providers={kudago:emptyProvider,timepad:async()=>{calls++;return {items:[],errors:["Timepad: 503 Service Unavailable"]}},osm:emptyProvider,dgis:emptyProvider};
  for(let i=0;i<3;i++){
    const r=await searchLiveInventory({query:"стендап"},env,{providers,cache,now:c.now,breaker:{failures:3,cooldownMs:1000}});
    assert.equal(r.degraded.timepad,true);assert.equal(r.from_cache.timepad,false);
    assert.match(r.note,/Источник мест сейчас не отвечает/,"ноль находок — нечего «показывать»");
    assert.ok(r.errors.includes("Timepad: 503 Service Unavailable"));
  }
  assert.equal(calls,3);
  const r4=await searchLiveInventory({query:"стендап"},env,{providers,cache,now:c.now,breaker:{failures:3,cooldownMs:1000}});
  assert.equal(calls,3,"цепь разомкнута — провайдер пропущен");
  assert.equal(r4.degraded.timepad,true);
  assert.ok(r4.errors.some(e=>/timepad: источник временно отключён/.test(e)),r4.errors.join());
  assert.equal(breakerStatus("timepad",{cooldownMs:1000,now:c.now}).open,true);
  c.tick(1500);
  await searchLiveInventory({query:"стендап"},env,{providers,cache,now:c.now,breaker:{failures:3,cooldownMs:1000}});
  assert.equal(calls,4,"после cooldown — пробная попытка");
  resetBreakers();
});

test("searchLiveInventory: заметка о сбое не затирает заметку о «выпить много»", async ()=>{
  resetBreakers();
  const cache=createCache({now:()=>1});
  const providers={kudago:async()=>{throw new Error("down")},timepad:emptyProvider,osm:emptyProvider,dgis:emptyProvider};
  const r=await searchLiveInventory({query:"хочу выпить очень много"},env,{providers,cache,now:()=>1});
  // KudaGo к «выпить» не относится: остаётся только заметка про алкоголь.
  assert.match(r.note,/не ранжирует места по количеству алкоголя\./);
  assert.ok(!/не ответила/.test(r.note),"сбой афиши событий тут ни при чём");
  resetBreakers();
});

test("прогрев: отключается FREE_WARMUP=0, иначе прогоняет все запросы последовательно", async ()=>{
  const off=startWarmup({env:{FREE_WARMUP:"0"},search:async()=>{throw new Error("не должен вызываться")}});
  assert.equal(off.enabled,false);
  const calls=[];let concurrent=0,maxConcurrent=0;
  const search=async(args)=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);await new Promise(r=>setTimeout(r,2));calls.push(args.query);concurrent--;return {items:[1],errors:[]}};
  const logs=[];
  const w=startWarmup({env:{},search,initialDelayMs:60_000,intervalMs:60_000,gapMs:1,log:m=>logs.push(m),unref:false});
  assert.equal(w.enabled,true);
  const res=await w.runOnce();
  assert.deepEqual(calls,WARMUP_QUERIES);
  assert.equal(maxConcurrent,1,"строго последовательно");
  assert.equal(res.ok,12);assert.equal(res.fail,0);assert.equal(w.runs,1);
  assert.match(logs[0],/12 запросов прогрето/);
  w.stop();
});

test("прогрев: стартует по таймеру и повторяется по интервалу, ошибки поиска не роняют цикл", async ()=>{
  let n=0;
  const search=async()=>{n++;if(n%2)throw new Error("сеть");return {items:[],errors:["x"]}};
  const w=startWarmup({env:{},search,queries:["бар","кафе"],initialDelayMs:1,intervalMs:5,gapMs:0,unref:false});
  const deadline=Date.now()+2000;
  while(w.runs<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  w.stop();
  assert.ok(w.runs>=2,"runs="+w.runs);
  assert.ok(n>=4);
});

test("Overpass: таймаут в поле remark — это сбой, а не «мест нет»", async ()=>{
  const {searchOSM}=await import("../providers.mjs");
  const {buildSearchPlan}=await import("../providers.mjs");
  const plan=buildSearchPlan({query:"бар"});
  // Overpass отвечает HTTP 200 с пустым elements и remark: раньше это
  // считалось честной пустотой и кешировалось на часы.
  const out=await searchOSM(plan,{snapshot:null,
    fetchJsonImpl:async()=>({elements:[],remark:"runtime error: Query timed out in \"query\" at line 1 after 12 seconds."})}).catch(e=>({thrown:e.message}));
  const failed=out.thrown||(out.errors||[]).some(e=>/timed out/.test(e));
  assert.ok(failed,`ожидали ошибку, получили ${JSON.stringify(out).slice(0,120)}`);
});

test("ключ кеша различает район и «рядом»", async ()=>{
  const {searchLiveInventory}=await import("../providers.mjs");
  const seen=[];
  const providers={kudago:emptyProvider,timepad:emptyProvider,osm:emptyProvider,
    dgis:async(plan)=>{seen.push(plan);return {items:[venue("d1","Бар")],errors:[]}}};
  const cache=createCache({now:()=>1});
  const run=(args)=>searchLiveInventory(args,{...env,DGIS_API_KEY:"k"},{providers,cache,now:()=>1});
  // Поле точки в ключе перетиралось списком запросов, а «рядом» в ключ не
  // входило вовсе: 2GIS ищет в радиусе 4 км и 50 км — записи делились.
  await run({query:"бар рядом",user_location:{lat:55.55,lon:37.55}});
  await run({query:"бар рядом",user_location:{lat:55.90,lon:37.45}});
  assert.equal(seen.length,2,"разные районы не должны делить кеш");
  await run({query:"посоветуй бар",user_location:{lat:55.55,lon:37.55}});
  assert.equal(seen.length,3,"«рядом» и обычный поиск — разные запросы");
});
