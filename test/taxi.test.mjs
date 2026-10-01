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
  t.configure(null);t.configure({});t.configure({ref:"",tracking_id:"",providers:[],uber_client_id:""});
  assert.deepEqual(t.config,was);
  assert.deepEqual([...t.config.providers],["yandexgo"],"по умолчанию — Яндекс Go, как и раньше");
});

// ---- Дубай: Uber и Careem ----
const BURJ={lat:25.197197,lon:55.274376},DXB_ME={lat:25.21,lon:55.27};

test("links(): провайдеры в порядке города, url() — первый из них", () => {
  const t=load();
  t.configure({providers:["uber","careem"]});
  const ls=t.links(BURJ,DXB_ME,"Burj Khalifa");
  // Массивы из песочницы vm — другого realm, поэтому копируем перед сравнением.
  assert.deepEqual([...ls.map(l=>l.provider)],["uber","careem"]);
  assert.deepEqual([...ls.map(l=>l.label)],["Uber","Careem"]);
  assert.equal(t.url(BURJ,DXB_ME,"Burj Khalifa"),ls[0].url);
  assert.equal(t.links(null,DXB_ME).length,0,"без назначения ссылок нет");
});

test("Uber: универсальная ссылка с точкой назначения, подписью и client_id", () => {
  const t=load();
  t.configure({providers:["uber"],uber_client_id:"abc-123"});
  const u=new URL(t.url(BURJ,null,"Burj Khalifa"));
  assert.equal(u.origin+u.pathname,"https://m.uber.com/ul/");
  assert.equal(u.searchParams.get("action"),"setPickup");
  assert.equal(u.searchParams.get("pickup"),"my_location","без точки подачи Uber берёт положение телефона");
  assert.equal(u.searchParams.get("dropoff[latitude]"),"25.197197");
  assert.equal(u.searchParams.get("dropoff[longitude]"),"55.274376");
  assert.equal(u.searchParams.get("dropoff[nickname]"),"Burj Khalifa");
  assert.equal(u.searchParams.get("client_id"),"abc-123");
  const withStart=new URL(t.url(BURJ,DXB_ME));
  assert.equal(withStart.searchParams.get("pickup[latitude]"),"25.210000");
  assert.equal(withStart.searchParams.get("pickup"),null);
});

test("Careem: открывается приложение; неизвестный провайдер отбрасывается", () => {
  const t=load();
  t.configure({providers:["careem","gett","yandexgo"]});
  assert.deepEqual([...t.config.providers],["careem","yandexgo"]);
  const ls=t.links(BURJ,null);
  assert.equal(ls[0].url,"careem://ride");
  assert.match(ls[1].url,/^https:\/\/3\.redirect\.appmetrica\.yandex\.com\/route\?/);
});
