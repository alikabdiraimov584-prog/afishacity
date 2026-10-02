# Карта Дубая: офлайн-сборка (OSM + Overture)

Overpass не успевает отдать весь город, а в OSM у заведений Дубая мало контактов.
Поэтому карта собирается заранее из двух открытых источников и проверяется:

1. **OSM** — выгрузка ОАЭ (`uae.osm.pbf`, download.openstreetmap.fr / Geofabrik).
2. **Overture Maps Places** — открытый каталог мест (телефоны, сайты, адреса).

Шаги (в рабочей папке `$W`, Python 3 + `osmium`, `duckdb`; Node 22):

```sh
CITY=dubai node -e '…' > $W/cats.json        # фильтры категорий из public/categories.js (см. ниже)
python3 ov.py                                 # Overture → dubai_overture.parquet (из $W)
python3 ov_names.py                           # английские имена Overture → dubai_names.parquet
python3 extract.py $W                         # OSM → dubai_by_cat.json + streets.json
python3 merge.py $W                           # склейка, чистка, категории → dubai_merged.json
node ingest.mjs $W/dubai_merged.json $W/osm_dubai.db
CITY=dubai PORT=3001 OSM_SNAPSHOT=$W/osm_dubai.db node server.mjs &
python3 audit2.py $W cats      # все категории: 0 чужих, 0 пустых, только латиница
python3 audit2.py $W natural   # живые запросы
python3 audit2.py $W natural2  # запросы, которых не было при настройке
```

`cats.json`:
```sh
CITY=dubai node --no-warnings -e 'import("./categories.mjs").then(async m=>{const {CITY}=await import("./city.mjs");
console.log(JSON.stringify({bbox:CITY.bbox,cats:m.CATEGORIES.filter(c=>c.osm&&c.osm.length).map(c=>({tag:c.tag,osm:c.osm}))}))})' > $W/cats.json
```

## Фото мест

Перед `ingest.mjs` (папка `$W/photos`):

```sh
python3 harvest.py      # og:image / hero с сайтов мест → site_photos.jsonl
python3 vqa2.py         # отсев логотипов, иконок, заглушек → site_photos_qa2.json
python3 ocr.py          # кадры с текстом (плакаты, реклама казино) → site_photos_ocr.json
python3 spam.py ../osm_dubai.db site_check.json   # захваченные/припаркованные домены
```

`ingest.mjs` кладёт кадр в тег `free:photo` (сервер показывает его подписанным
доменом сайта), а у мест с захваченным или проданным доменом убирает и сайт,
и картинку. Остальным местам сервер даёт **фото для примера** — подборку
`photos_illustrative_dubai.json` (Openverse: Flickr/StockSnap/Rawpixel, лицензии
CC, `openverse.py` + `pool.py`, отобрано вручную по листам), с подписью
«Illustrative photo · автор».

Что чистит `merge.py`: дубли OSM/Overture (имя + 120 м), места без латинского имени,
конторы и подрядчики, точки-заглушки геокодера, «двойники» известных мест,
места из других эмиратов и стран, прошедшие события. Готовая карта публикуется
в ветку `data-snapshots` (`osm_dubai.db.gz` + `osm_dubai.meta.json` с sha256),
и `deploy/install.sh` ставит её сам. Ночная сборка через Overpass такую карту
не перезаписывает (`scripts/build_osm_snapshot.mjs`, нужен `--force`).
