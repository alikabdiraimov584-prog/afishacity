# FREE — AI-консьерж свободного времени в Москве

Прототип: разговорный интерфейс, который ищет реальные места и события
в live-источниках и ведёт пользователя к действию — бронь, билеты, маршрут.

## Запуск

Нужен Node.js 20+. Внешних зависимостей нет.

```bash
cp .env.example .env   # заполнить ключи при необходимости
npm start              # http://localhost:3000
```

Сервер слушает только `127.0.0.1`.

## Структура

| Файл | Назначение |
|---|---|
| `server.mjs` | HTTP-сервер, статика из `public/`, API, диалог с OpenAI, обогащение карточек метаданными страниц |
| `providers.mjs` | Live-источники: KudaGo, Timepad, OpenStreetMap/Overpass, 2GIS (по ключу). Построение плана поиска из запроса |
| `live_ranker.mjs` | Фильтрация и ранжирование результатов, «ДНК места», учёт Taste Graph, геолокации и погоды |
| `public/index.html` | Одностраничный UI: чат, карточки, план, сохранённое, Taste Graph, голос |

## API

| Метод и путь | Описание |
|---|---|
| `GET /api/health` | Готовность текстового AI, голоса и провайдеров |
| `POST /api/recommend` | Поиск по живым источникам. Тело: `{query, party_size, after_time, target_date, max_price_rub, area, taste_weights, user_location, weather_context}` |
| `POST /api/dialogue` | Диалог через OpenAI Responses API с инструментом `recommend_free`. Требует `OPENAI_API_KEY` |
| `GET /api/weather` | Прогноз Open-Meteo по `lat`/`lon` |
| `POST /api/live-session` | WebRTC-сессия голосового режима. Требует `OPENAI_API_KEY` |

Результаты `/api/recommend` кешируются на 5 минут по аргументам запроса.

## Проверка

```bash
npm run check   # синтаксис модулей + офлайн-тесты
npm test        # только тесты (node:test, без сети и зависимостей)
```

Тесты в `test/` покрывают разбор запроса (`buildSearchPlan`) и ранжирование
(`rankLive`, `placeDna`, `resultPayload`) на синтетических данных, поэтому
работают без доступа к KudaGo, Timepad и Overpass.
