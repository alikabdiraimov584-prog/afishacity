/* FREE: ссылки на заказ такси — Яндекс Go, Uber, Careem.
 *
 * Маршрут передаётся прямо в ссылке: если приложение на телефоне стоит, она
 * открывается как deeplink с уже заполненными точками подачи и назначения,
 * если нет — уводит на установку или на сайт сервиса. Отдельного серверного
 * вызова тут не нужно, и это к лучшему: заказ уходит в приложение, где у
 * человека уже привязана карта.
 *
 * Какие кнопки показывать, решает сервер (FREE_CITY в странице и /api/health →
 * taxi.providers, из конфигурации города): Москва — Яндекс Go, Дубай — Uber и
 * Careem. Клиент показывает КАЖДОГО провайдера отдельной кнопкой.
 *
 * window.FreeTaxi.links(to, from, {name,address}) → [{provider,label,url,copy?}]
 *   в порядке города; copy — текст, который стоит положить в буфер (адрес для
 *   Careem: точку назначения в его ссылку передать нельзя).
 * window.FreeTaxi.url(to, from, name) → ссылка первого провайдера (как раньше).
 */
(function(root){
"use strict";

const HOST="https://3.redirect.appmetrica.yandex.com/route";
const UBER_HOST="https://m.uber.com/ul/";
/* Careem. Своей схемы с точками в открытой документации нет, а голая
 * careem://ride не открывается из Telegram (openLink пускает только https) и
 * ничего не делает без установленного приложения. Зато у careem.com есть
 * универсальная ссылка: в apple-app-site-association путь «/??-??/ride»
 * («Lands on Ride Booking page»), а assetlinks.json подтверждает её для
 * Android-приложения com.careem.acma. Она открывает экран заказа поездки в
 * приложении, а без приложения — страницу Careem Ride на сайте. Пункт
 * назначения она не принимает — адрес кладём в буфер (поле copy). */
const CAREEM_URL="https://www.careem.com/en-AE/ride";
// Идентификатор редиректа Яндекс Go: по нему ссылка знает, какое приложение
// открывать и куда вести, если его нет. Партнёрский ref подставляется из
// настроек сервера — с ним заказы считаются как наши.
const cfg={tracking:"1178268795219780156",ref:"free",providers:["yandexgo"],uber_client_id:""};
const LABELS={yandexgo:"Яндекс Go",uber:"Uber",careem:"Careem"};

function point(v){
  if(!v)return null;
  const lat=Number(v.lat),lon=Number(v.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
  // За пределами вменяемых координат ссылка всё равно бесполезна, а отправлять
  // в неё мусор — значит открыть человеку пустое приложение.
  if(Math.abs(lat)>90||Math.abs(lon)>180)return null;
  return {lat,lon};
}

/** ref должен быть латиницей: кириллица в нём ломает подсчёт заказов. */
function cleanRef(v){return String(v||"").replace(/[^A-Za-z0-9_-]/g,"").slice(0,40)}

function configure(next){
  if(!next)return;
  const ref=cleanRef(next.ref);if(ref)cfg.ref=ref;
  const t=String(next.tracking_id||next.tracking||"").replace(/[^0-9]/g,"");
  if(t)cfg.tracking=t;
  if(Array.isArray(next.providers)){
    const p=next.providers.map(x=>String(x||"").toLowerCase()).filter(x=>LABELS[x]);
    if(p.length)cfg.providers=p;
  }
  const cid=String(next.uber_client_id||"").replace(/[^A-Za-z0-9_-]/g,"").slice(0,80);
  if(cid)cfg.uber_client_id=cid;
}

function yandexUrl(end,start){
  const q=new URLSearchParams();
  if(start){q.set("start-lat",start.lat.toFixed(6));q.set("start-lon",start.lon.toFixed(6))}
  q.set("end-lat",end.lat.toFixed(6));q.set("end-lon",end.lon.toFixed(6));
  q.set("ref",cfg.ref);
  q.set("appmetrica_tracking_id",cfg.tracking);
  q.set("lang","ru");
  return HOST+"?"+q.toString();
}
// Универсальная ссылка Uber (developer.uber.com → Deep links): точка подачи —
// положение телефона, назначение — координаты и подпись места.
// Подпись точки — название места, адрес — для экрана подтверждения заказа.
function uberUrl(end,start,place){
  const q=new URLSearchParams();
  q.set("action","setPickup");
  if(cfg.uber_client_id)q.set("client_id",cfg.uber_client_id);
  if(start){q.set("pickup[latitude]",start.lat.toFixed(6));q.set("pickup[longitude]",start.lon.toFixed(6))}
  else q.set("pickup","my_location");
  q.set("dropoff[latitude]",end.lat.toFixed(6));q.set("dropoff[longitude]",end.lon.toFixed(6));
  const nick=String(place.name||"").trim().slice(0,80);
  if(nick)q.set("dropoff[nickname]",nick);
  const addr=String(place.address||"").trim().slice(0,160);
  if(addr)q.set("dropoff[formatted_address]",addr);
  return UBER_HOST+"?"+q.toString();
}
function careemUrl(){return CAREEM_URL}

const BUILDERS={yandexgo:yandexUrl,uber:uberUrl,careem:careemUrl};

/**
 * to    — куда едем, {lat,lon}; без него ссылок нет.
 * from  — откуда. Необязательно: без точки подачи приложение берёт текущее
 *         положение телефона само, и это точнее, чем наша последняя координата.
 * place — {name,address} места (или просто название строкой): подпись точки
 *         назначения в Uber и текст для буфера в Careem.
 */
function links(to,from,place){
  const end=point(to);
  if(!end)return [];
  const start=point(from);
  const pl=typeof place==="string"?{name:place}:(place&&typeof place==="object"?place:{});
  const dest=[pl.name,pl.address].map(x=>String(x||"").trim()).filter(Boolean).join(", ");
  return cfg.providers.map(p=>{
    const l={provider:p,label:LABELS[p],url:BUILDERS[p](end,start,pl)};
    if(p==="careem"&&dest)l.copy=dest;
    return l;
  });
}
function url(to,from,name){
  const all=links(to,from,name);
  return all.length?all[0].url:"";
}

root.FreeTaxi={url,links,configure,get config(){return {...cfg,providers:cfg.providers.slice()}}};
})(typeof globalThis!=="undefined"?globalThis:this);
