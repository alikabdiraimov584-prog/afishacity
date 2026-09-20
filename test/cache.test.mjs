import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createCache,withBreaker,breakerStatus,resetBreakers,CircuitOpenError} from "../cache.mjs";

// Часы подменяем через now(): никаких реальных ожиданий.
const clock=(start=1_000_000)=>{let t=start;return {now:()=>t,tick(ms){t+=ms}}};

test("кеш: свежая запись, затем stale, затем протухшая", ()=>{
  const c=clock();const cache=createCache({ttlMs:1000,staleMs:5000,now:c.now});
  assert.equal(cache.get("k"),null);
  cache.set("k",{items:[1,2]});
  let h=cache.get("k");assert.equal(h.fresh,true);assert.deepEqual(h.value,{items:[1,2]});
  c.tick(1500);h=cache.get("k");assert.equal(h.fresh,false);assert.equal(h.age_ms,1500);
  c.tick(4000);assert.equal(cache.get("k"),null,"старше staleMs — удалено");
  assert.equal(cache.size,0);
});

test("кеш: лимит записей и LRU", ()=>{
  const cache=createCache({max:3,now:()=>1});
  cache.set("a",1);cache.set("b",2);cache.set("c",3);
  cache.get("a"); // «a» стала недавно использованной
  cache.set("d",4);
  assert.deepEqual(cache.keys().sort(),["a","c","d"]);
  assert.equal(cache.get("b"),null);
});

test("кеш: сохраняется в файл и читается при старте, протухшие записи не загружаются", ()=>{
  const dir=mkdtempSync(join(tmpdir(),"free-cache-"));const file=join(dir,"data","cache.json");
  const c=clock();
  const a=createCache({ttlMs:1000,staleMs:5000,file,now:c.now,debounceMs:60_000});
  a.set("fresh",{items:["x"]});
  assert.equal(existsSync(file),false,"запись отложена (debounce)");
  assert.equal(a.flush(),true);
  assert.ok(existsSync(file));
  c.tick(2000);a.set("later",{items:["y"]});a.flush();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file,"utf8"))).sort(),["fresh","later"]);
  c.tick(4000); // fresh: 6000 мс > staleMs, later: 4000 мс — ещё годится
  const b=createCache({ttlMs:1000,staleMs:5000,file,now:c.now});
  assert.equal(b.size,1);
  assert.equal(b.get("fresh"),null);
  assert.equal(b.get("later").fresh,false);
});

test("предохранитель: после 3 сбоев источник пропускается, после cooldown — пробная попытка, успех сбрасывает", async ()=>{
  resetBreakers();
  const c=clock();const opts={failures:3,cooldownMs:1000,now:c.now};
  let calls=0;const fail=async()=>{calls++;throw new Error("boom")};const ok=async()=>{calls++;return "ok"};
  for(let i=0;i<3;i++)await assert.rejects(withBreaker("p",fail,opts),/boom/);
  assert.equal(calls,3);
  const st=breakerStatus("p",opts);assert.equal(st.open,true);assert.equal(st.degraded,true);assert.equal(st.failures,3);
  await assert.rejects(withBreaker("p",ok,opts),e=>e instanceof CircuitOpenError&&e.open===true&&/временно отключён/.test(e.message));
  assert.equal(calls,3,"fn не вызывается, пока цепь разомкнута");
  c.tick(1001);
  assert.equal(await withBreaker("p",ok,opts),"ok");
  assert.equal(calls,4);
  const st2=breakerStatus("p",opts);assert.equal(st2.open,false);assert.equal(st2.degraded,false);assert.equal(st2.failures,0);
});

test("предохранитель: неудачная пробная попытка снова размыкает цепь; успех между сбоями обнуляет счётчик", async ()=>{
  resetBreakers();
  const c=clock();const opts={failures:3,cooldownMs:1000,now:c.now};
  const fail=async()=>{throw new Error("x")};const ok=async()=>1;
  await assert.rejects(withBreaker("q",fail,opts));await assert.rejects(withBreaker("q",fail,opts));
  await withBreaker("q",ok,opts);
  assert.equal(breakerStatus("q",opts).failures,0);
  for(let i=0;i<3;i++)await assert.rejects(withBreaker("q",fail,opts),/x/);
  assert.equal(breakerStatus("q",opts).open,true);
  c.tick(1500);
  await assert.rejects(withBreaker("q",fail,opts),/x/); // пробная попытка провалилась
  assert.equal(breakerStatus("q",opts).open,true,"снова разомкнута");
  assert.ok(breakerStatus("q",opts).retryInMs>0);
  resetBreakers();
});
