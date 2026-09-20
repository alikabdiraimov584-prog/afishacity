# FREE — AI-консьерж свободного времени в Москве

Прототип: разговорный интерфейс, который ищет реальные места и события
в live-источниках и ведёт пользователя к действию — бронь, билеты, маршрут.

## Запуск

Нужен Node.js 20+. Единственная зависимость — `@anthropic-ai/sdk`.

```bash
npm install
cp .env.example .env   # вписать ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

Без `ANTHROPIC_API_KEY` интерфейс работает в режиме резервного опросника на встроенных данных.
С ключом включается консьерж: свободный диалог через Claude (Messages API, модель
`claude-opus-5` по умолчанию) с инструментом `recommend_free`, который ищет по живым источникам.

Сервер слушает только `127.0.0.1`.

## Структура

| Файл | Назначение |
|---|---|
| `server.mjs` | HTTP-сервер, статика из `public/`, API, диалог с Claude (tool use), обогащение карточек метаданными страниц |
| `providers.mjs` | Live-источники: KudaGo, Timepad, OpenStreetMap/Overpass, 2GIS (по ключу). Построение плана поиска из запроса |
| `live_ranker.mjs` | Фильтрация и ранжирование результатов, «ДНК места», учёт Taste Graph, геолокации и погоды |
| `public/index.html` | Одностраничный UI: чат, карточки, план, сохранённое, Taste Graph, голос |

## API

| Метод и путь | Описание |
|---|---|
| `GET /api/health` | Готовность текстового AI, голоса и провайдеров |
| `POST /api/recommend` | Поиск по живым источникам. Тело: `{query, party_size, after_time, target_date, max_price_rub, area, taste_weights, user_location, weather_context}` |
| `POST /api/dialogue` | Диалог через Claude с инструментом `recommend_free`. Тело: `{message, previous_response_id, context}`; ответ содержит `response_id` — идентификатор истории, которую сервер хранит 2 часа. Требует `ANTHROPIC_API_KEY` |
| `GET /api/weather` | Прогноз Open-Meteo по `lat`/`lon` |
| `POST /api/live-session` | Возвращает 501: голос работает через распознавание речи в браузере и обычный `/api/dialogue` |

Результаты `/api/recommend` кешируются на 5 минут по аргументам запроса.

Диалог использует адаптивное размышление Claude с уровнем `CLAUDE_EFFORT` (по умолчанию `medium`),
кеширование системного промпта и серверный fallback на другую модель Anthropic при отказе
по политике (`fallbacks: "default"`). Голосовой WebRTC-режим прежнего бэкенда убран:
у Claude нет realtime-канала, поэтому речь распознаёт браузер.

## Проверка

```bash
npm run check   # синтаксис модулей + офлайн-тесты
npm test        # только тесты (node:test, без сети и зависимостей)
```

Тесты в `test/` покрывают разбор запроса (`buildSearchPlan`) и ранжирование
(`rankLive`, `placeDna`, `resultPayload`) на синтетических данных, поэтому
работают без доступа к KudaGo, Timepad и Overpass.
