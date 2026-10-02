// Фильтры категорий и районы города → cats.json для extract.py и merge.py:
//   node --no-warnings scripts/dubai_offline/cats.mjs > $W/cats.json
// Районы (city.mjs) нужны merge.py, чтобы сверять адрес места с его точкой:
// «Dubai Marina» в адресе и точка в Бур-Дубае — координаты неверные.
process.env.CITY=process.env.CITY||"dubai";
const {CATEGORIES}=await import(new URL("../../categories.mjs",import.meta.url));
const {CITY}=await import(new URL("../../city.mjs",import.meta.url));
console.log(JSON.stringify({
  bbox:CITY.bbox,
  cats:CATEGORIES.filter(c=>c.osm&&c.osm.length).map(c=>({tag:c.tag,osm:c.osm})),
  districts:(CITY.districts||[]).map(d=>({name:d.name,re:d.re.source,lat:d.lat,lon:d.lon}))
}));
