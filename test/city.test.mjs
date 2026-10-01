// Конфигурация города: health отдаёт город, фото Google идёт через сервер,
// снимок и рамки берутся из CITY.
import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test";
const {CITY,CITIES,cityDate,cityNow,bboxString}=await import("../city.mjs");
const {server}=await import("../server.mjs");
const {snapshotStatus}=await import("../providers.mjs");
const {CITY_BBOX,CENTER_BBOX}=await import("../osm_snapshot.mjs");

test("city.mjs: обе конфигурации полные, по умолчанию Москва", () => {
  for(const c of Object.values(CITIES)){
    for(const k of ["id","name","lang","tz","utcOffset","currency","center","bbox","centerBbox","providers","taxi","snapshotFile","weatherTz"])
      assert.ok(c[k]!==undefined,`${c.id}: нет поля ${k}`);
    assert.ok(c.bbox.south<c.centerBbox.south&&c.bbox.north>c.centerBbox.north,`${c.id}: центр внутри рамки`);
  }
  assert.equal(CITIES.moscow.yandexBbox,"37.32,55.55~37.97,55.95");
  assert.equal(CITIES.dubai.yandexBbox,null,"Яндекс Дубай не покрывает");
  assert.deepEqual(CITIES.dubai.taxi,["uber","careem"]);
  if(!process.env.CITY)assert.equal(CITY.id,"moscow");
  assert.match(cityDate(new Date("2026-09-20T22:30:00Z")),/^2026-09-2[01]$/);
  const t=cityNow(new Date("2026-09-20T22:30:00Z"));
  assert.ok(t&&/^(su|mo)$/.test(t.weekday));
  assert.equal(bboxString({south:1,west:2,north:3,east:4}),"1,2,3,4");
});

test("рамки снимка и имя файла — из города", () => {
  assert.deepEqual(CITY_BBOX,CITY.bbox);assert.deepEqual(CENTER_BBOX,CITY.centerBbox);
  const st=snapshotStatus();
  assert.ok(String(st.file).endsWith(CITY.snapshotFile)||process.env.OSM_SNAPSHOT,`файл снимка ${st.file}`);
});

test("/api/health: блок city, провайдеры и такси по городу; /api/gphoto без ключа закрыт", async () => {
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const h=await (await fetch(base+"/api/health")).json();
    assert.deepEqual(h.city,{id:CITY.id,name:CITY.name,lang:CITY.lang,tz:CITY.tz,currency:CITY.currency,taxi:CITY.taxi,providers:CITY.providers});
    assert.deepEqual(h.taxi.providers,CITY.taxi);
    assert.equal(typeof h.taxi.uber_client_id,"string");
    assert.equal(h.providers.foursquare,false,"без FOURSQUARE_API_KEY выключен");
    assert.equal(h.providers.google_places,false);
    assert.equal(h.providers.kudago,CITY.providers.events.includes("kudago"));
    assert.ok(h.provider_health.osm,"здоровье источников на месте");
    // Без ключа маршрут фото Google ничего не проксирует — и ничего не раскрывает.
    const g=await fetch(base+"/api/gphoto?name=places/abc/photos/def");
    assert.equal(g.status,404);
    const viaImg=await fetch(base+"/api/img?u="+encodeURIComponent("https://places.googleapis.com/v1/places/abc/photos/def/media?maxWidthPx=800"));
    assert.equal(viaImg.status,404,"тот же адрес через /api/img уходит в тот же обработчик");
  }finally{await new Promise(r=>server.close(r))}
});

test("/api/gphoto: с ключом плохое имя отбрасывается до похода в сеть", async () => {
  process.env.GOOGLE_PLACES_API_KEY="test-key";
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const real=globalThis.fetch;
  let calls=0;
  try{
    const bad=await real(base+"/api/gphoto?name="+encodeURIComponent("places/abc/photos/../../etc"));
    assert.equal(bad.status,400);
    const bad2=await real(base+"/api/gphoto?name=");
    assert.equal(bad2.status,400);
    assert.equal(calls,0);
  }finally{delete process.env.GOOGLE_PLACES_API_KEY;globalThis.fetch=real;await new Promise(r=>server.close(r))}
});
