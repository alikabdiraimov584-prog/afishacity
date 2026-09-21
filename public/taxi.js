/* FREE: ссылка на заказ такси в Яндекс Go.
 *
 * Маршрут передаётся прямо в ссылке: если приложение на телефоне стоит, она
 * открывается как deeplink с уже заполненными точками подачи и назначения,
 * если нет — уводит на установку, а маршрут подхватится после. Отдельного
 * серверного вызова тут не нужно, и это к лучшему: заказ уходит в приложение,
 * где у человека уже привязана карта.
 *
 * window.FreeTaxi.url({lat,lon}, {lat,lon}|null) → строка ссылки.
 */
(function(root){
"use strict";

const HOST="https://3.redirect.appmetrica.yandex.com/route";
// Идентификатор редиректа Яндекс Go: по нему ссылка знает, какое приложение
// открывать и куда вести, если его нет. Партнёрский ref подставляется из
// настроек сервера — с ним заказы считаются как наши.
const cfg={tracking:"1178268795219780156",ref:"free"};

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
}

/**
 * to   — куда едем, {lat,lon}; без него ссылки нет.
 * from — откуда. Необязательно: без точки подачи Го берёт текущее положение
 *        телефона само, и это точнее, чем наша последняя известная координата.
 */
function url(to,from){
  const end=point(to);
  if(!end)return "";
  const q=new URLSearchParams();
  const start=point(from);
  if(start){q.set("start-lat",start.lat.toFixed(6));q.set("start-lon",start.lon.toFixed(6))}
  q.set("end-lat",end.lat.toFixed(6));q.set("end-lon",end.lon.toFixed(6));
  q.set("ref",cfg.ref);
  q.set("appmetrica_tracking_id",cfg.tracking);
  q.set("lang","ru");
  return HOST+"?"+q.toString();
}

root.FreeTaxi={url,configure,get config(){return {...cfg}}};
})(typeof globalThis!=="undefined"?globalThis:this);
