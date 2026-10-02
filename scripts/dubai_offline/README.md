# Карта Дубая: офлайн-сборка (OSM + Overture)

Overpass не успевает отдать весь город, а в OSM у заведений Дубая мало контактов.
Поэтому карта собирается заранее из двух открытых источников и проверяется:

1. **OSM** — выгрузка ОАЭ (`uae.osm.pbf`, download.openstreetmap.fr / Geofabrik).
2. **Overture Maps Places** — открытый каталог мест (телефоны, сайты, адреса).

Шаги (в рабочей папке `$W`, Python 3 + `osmium`, `duckdb`, желательно `shapely`; Node 22;
команды — из корня репозитория):

```sh
node --no-warnings scripts/dubai_offline/cats.mjs > $W/cats.json   # фильтры категорий + районы (city.mjs)
python3 ov.py                                 # Overture → dubai_overture.parquet (из $W)
python3 ov_names.py                           # английские имена Overture → dubai_names.parquet
python3 scripts/dubai_offline/extract.py $W   # OSM → dubai_by_cat.json, streets.json, boundaries.json, coast.json
python3 scripts/dubai_offline/merge.py $W     # склейка, чистка (curate.py), категории → dubai_merged.json, curate_log.tsv
node --no-warnings scripts/dubai_offline/ingest.mjs $W/dubai_merged.json $W/osm_dubai.db
CITY=dubai PORT=3001 OSM_SNAPSHOT=$W/osm_dubai.db node server.mjs &
python3 audit2.py $W cats      # все категории: 0 чужих, 0 пустых, только латиница
python3 audit2.py $W natural   # живые запросы
python3 audit2.py $W natural2  # запросы, которых не было при настройке
```

`ingest.mjs` берёт фото из `$W/photos/` (см. ниже) — в новой рабочей папке это
ссылка на готовую `photos/`.

## Чистка карты (`curate.py` + `curated/*.json`)

Правила — в коде, ручные списки с источниками — в `curated/`:

| что | как |
|---|---|
| закрытые места | OSM `closed=yes`, `disused=yes`, `disused:*`/`was:*` при живом теге, `opening_date` в будущем, «(closed)» в имени — выбрасывает `extract.py`; известные закрытия, ремонты и переименования — `closures.json` (ссылка на новость у каждого) |
| сезонные места | `seasons.json`: `free:season` |
| вне Дубая | точка внутри другого эмирата (границы admin_level=4 из `uae.osm.pbf`) дальше 30 м от Дубая; адрес в Шардже/Аджмане |
| неверные координаты | адрес или имя называют район/ориентир (`fixes.json` → `landmarks`, районы из `city.mjs`), а точка далеко — место из Overture выбрасывается; «стопки» Overture (5+ мест в одной точке) остаются, только если это одно здание (ТЦ рядом, общий ориентир или один адрес-здание) |
| дубли | одно имя (любое из name/name:en) в 150 м (пляжи и парки — 400 м) — одно место: геометрия OSM, контакты Overture; отели Overture — с отелем OSM в 250 м при общем «не районном» слове |
| рубрики | отель: не ресторан в отеле, не квартира посуточно, не жилой дом, у Overture — только с сайтом или телефоном; ТЦ — только настоящие (`department_store` → одежда); пляж — название пляжа у береговой линии; концерт — только музыкальные площадки (не стадионы и не арены для спорта) |
| метро | рубрика `metro`: станции Dubai Metro и Dubai Tram (английское имя + «Metro Station» / «Tram Station») |
| больницы | английское имя для арабского: name:en/int_name/official_name:en, имя Overture рядом, `hospitals_en.json` |
| MICHELIN, 50 Best | `michelin.json` (из guide.michelin.com, с координатами), `awards.json`: совпадение по имени и месту, недостающие рестораны гида добавляются |
| часы | пустые окна (`10:00-10:00`) и «ресторан открыт только 00:00–12:00» убираются |

Теги для сервера и других частей FREE (договорённость):

| тег | значение |
|---|---|
| `free:status` | `closed` (место не попадает в карту) или `temporarily_closed` (остаётся с пометкой) |
| `free:status_note` | коротко по-английски, `free:status_src` — ссылка на источник |
| `free:season` | `MM-DD/MM-DD`, может переходить через год (`10-14/05-10`) |
| `free:michelin` | `3 Stars`, `2 Stars`, `1 Star`, `Bib Gourmand`, `Selected` (+ `free:michelin_src`) |
| `free:award` | `MENA's 50 Best Restaurants 2026 #N` (+ `free:award_src`) |
| `free:price` | 1–4, `free:price_src` — откуда (`michelin` для ресторанов со звёздами) |

Что и почему выброшено или склеено — `$W/curate_log.tsv`. Гид MICHELIN Dubai 2026
объявляют 6 октября 2026: после этого обновить `curated/michelin.json`.

Новый шаг обработки каждого места при записи в снимок (часы, цены, ссылки на
бронь с сайтов) — ещё одна функция в массиве `APPLY` в `ingest.mjs`.

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
