// Ссылка на заказ в Яндекс Go. Ошибка здесь не видна глазом: приложение
// откроется, просто пустым или не туда, — поэтому проверяется разбором URL.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

function load(){
  const sandbox={URLSearchParams,Number,Math,String};
  sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../public/taxi.js",import.meta.url),"utf8"),sandbox);
  return sandbox.FreeTaxi;
}

const ROVESNIK={lat:55.752,lon:37.634},ME={lat:55.7,lon:37.6};

test("маршрут уходит в ссылку целиком", () => {
  const u=new URL(load().url(ROVESNIK,ME));
  assert.equal(u.origin+u.pathname,"https://3.redirect.appmetrica.yandex.com/route");
  assert.equal(u.searchParams.get("start-lat"),"55.700000");
  assert.equal(u.searchParams.get("start-lon"),"37.600000");
  assert.equal(u.searchParams.get("end-lat"),"55.752000");
  assert.equal(u.searchParams.get("end-lon"),"37.634000");
  assert.ok(u.searchParams.get("appmetrica_tracking_id"),"без него ссылка не откроет приложение");
});

test("без точки подачи ссылка остаётся рабочей", () => {
  // Го возьмёт положение телефона сам, и это точнее нашей последней координаты.
  const u=new URL(load().url(ROVESNIK,null));
  assert.equal(u.searchParams.get("start-lat"),null);
  assert.equal(u.searchParams.get("end-lat"),"55.752000");
});

test("без точки назначения ссылки нет", () => {
  const t=load();
  for(const bad of [null,undefined,{},{lat:"рядом",lon:37.6},{lat:55.7},{lat:200,lon:37.6}])
    assert.equal(t.url(bad,ME),"",`${JSON.stringify(bad)} не должно давать ссылку`);
});

test("партнёрский ref приходит с сервера и остаётся латиницей", () => {
  const t=load();
  t.configure({ref:"afishacity",tracking_id:"123456"});
  const u=new URL(t.url(ROVESNIK));
  assert.equal(u.searchParams.get("ref"),"afishacity");
  assert.equal(u.searchParams.get("appmetrica_tracking_id"),"123456");
  // Кириллица в ref ломает подсчёт заказов на стороне Яндекса.
  t.configure({ref:"афиша сити!"});
  assert.equal(new URL(t.url(ROVESNIK)).searchParams.get("ref"),"afishacity","мусор не должен затирать рабочий ref");
});

test("пустые настройки не сбрасывают умолчания", () => {
  const t=load(),was=t.config;
  t.configure(null);t.configure({});t.configure({ref:"",tracking_id:""});
  assert.deepEqual(t.config,was);
});
