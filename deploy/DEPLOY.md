# Развёртывание бэкенда FREE

Мобильное приложение обращается к бэкенду по HTTPS, поэтому нужны: домен, сервер с публичным IP
и TLS-сертификат. Шаги про Telegram-бота ниже нужны только если вы решите дополнительно
выпустить Mini App; для приложения их можно пропустить, `TELEGRAM_BOT_TOKEN` оставить пустым. Ниже путь для Ubuntu 22.04/24.04 с nginx. Альтернатива через Docker в конце.

## 1. DNS

В панели регистратора создайте A-запись: `@` (или `app`) → IP сервера. Проверка: `dig +short YOUR_DOMAIN`.

## 2. Бот в Telegram

1. В @BotFather: `/newbot` → получите токен вида `123456:ABC...`. Он нужен серверу для проверки подписи запросов.
2. Позже, когда сайт заработает по HTTPS: `/newapp` → выберите бота → название, описание, картинка 640×360 → **Web App URL: `https://YOUR_DOMAIN`** → короткое имя. Ссылка на приложение: `https://t.me/BOT_NAME/APP_NAME`.
3. Кнопка меню в чате с ботом: `/mybots` → бот → Bot Settings → Menu Button → URL `https://YOUR_DOMAIN`.

## 3. Быстрый путь: одна команда

На сервере от root (шаги 3 и 4 ниже выполняются автоматически):

```bash
curl -fsSL https://raw.githubusercontent.com/alikabdiraimov584-prog/afishacity/claude/blissful-lamport-3rprjv/deploy/install.sh | bash -s -- ваш.домен ТОКЕН_БОТА
```

Токен бота можно не указывать и вписать позже в `/opt/afishacity/.env`.
Повторный запуск той же команды обновляет код и перезапускает сервис.

## 3а. Сервер вручную

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx git

# Пользователь и код
sudo useradd -r -m -s /usr/sbin/nologin free
sudo git clone https://github.com/alikabdiraimov584-prog/afishacity /opt/afishacity
cd /opt/afishacity
sudo git checkout claude/blissful-lamport-3rprjv   # или main после слияния
sudo npm ci --omit=dev
sudo cp .env.example .env && sudo nano .env
sudo chown -R free:free /opt/afishacity && sudo chmod 600 /opt/afishacity/.env
```

В `.env` обязательно:

```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC...
HOST=127.0.0.1
PORT=3000
```

`TELEGRAM_BOT_TOKEN` включает проверку подписи: без неё любой, кто найдёт домен,
сможет тратить ваш ключ Claude. Проверка сервиса:

```bash
sudo cp deploy/free.service /etc/systemd/system/free.service
sudo systemctl daemon-reload && sudo systemctl enable --now free
sudo systemctl status free          # active (running)
curl -s http://127.0.0.1:3000/api/health
```

## 4. nginx и HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/free
sudo sed -i 's/YOUR_DOMAIN/ваш.домен/g' /etc/nginx/sites-available/free
sudo ln -s /etc/nginx/sites-available/free /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d ваш.домен      # выпускает сертификат и включает редирект на HTTPS
```

Проверка: `https://ваш.домен/api/health` отдаёт `"telegram_auth":true`.

## 5. Проверка в Telegram

Откройте `https://t.me/BOT_NAME/APP_NAME` или кнопку меню в чате с ботом.
В шапке приложения должно быть «Neural chat · claude-opus-5». Если написано
«AI fallback», смотрите `sudo journalctl -u free -n 50`.

Обновление: `cd /opt/afishacity && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart free`.

## Альтернатива: Docker

```bash
docker compose up -d --build
```

Контейнер слушает `127.0.0.1:3000`; nginx и certbot настраиваются как в шагах 4.

## Частые проблемы

- **Белый экран в Telegram**: URL в BotFather не HTTPS или сертификат не выпущен.
- **401 telegram_auth_required в браузере**: это норма, вне Telegram подписи нет. В браузере работает демо-сценарий.
- **429 rate_limited**: лимит 40 сообщений за 10 минут на пользователя, меняется переменной `DIALOGUE_RATE_LIMIT`.

## Локальный снимок мест Москвы

Поиск мест обслуживается не из сети, а из собственного индекса в SQLite
(`data/osm_moscow.db`). Overpass используется только для его пересборки.

Зачем так: Overpass — публичный сервис, который отвечает секундами и регулярно
бывает перегружен. Пока он недоступен, мест в выдаче нет. Снимок переворачивает
зависимость — город выгружается раз в сутки фоном, а запрос пользователя
обслуживается локально.

**Порядок работы**

```
systemctl status free-snapshot.timer     # расписание (ночью, со случайным разбросом)
systemctl start free-snapshot            # пересобрать прямо сейчас
journalctl -u free-snapshot -f           # следить за сборкой
curl -s https://ДОМЕН/api/health | grep -o '"osm_snapshot":{[^}]*}'
```

Первая сборка идёт десятки минут: примерно 60 запросов к Overpass с паузами,
по одному на категорию, с делением слишком крупных на четверти. Пока снимка
нет, места ищутся напрямую через Overpass — приложение работает, просто
медленнее.

**Что ожидать по объёму.** На городском масштабе (~100 тысяч мест) файл
занимает около 48 МБ, любой запрос выполняется быстрее 0.4 мс.

**Безопасность подмены.** Новая база пишется в `osm_moscow.db.building` и
подменяет старую одним переименованием в самом конце. Сервер ни секунды не
видит наполовину собранный файл и переоткрывает его сам, заметив изменение.
Если не собралось больше трети категорий или мест оказалось меньше 500,
снимок **не** заменяется — прежний остаётся на месте, а в журнал пишется
причина.

**Зеркала.** Overpass опрашивается по списку зеркал (`OVERPASS_URLS`),
рабочее запоминается и пробуется первым.

## Голосовой консьерж на Yandex Cloud

Агента зовут **Савва**. Он ведёт разговор, ищет места и собирает маршрут.
Движок — YandexGPT, речь — SpeechKit.

**Что завести в Yandex Cloud**

1. Создать сервисный аккаунт и выдать ему роли: `ai.languageModels.user`,
   `ai.speechkit-stt.user`, `ai.speechkit-tts.user`.
2. Сделать для него **API-ключ** (не IAM-токен: тот живёт 12 часов).
3. Взять идентификатор каталога — `b1g…` из адресной строки консоли.

**Что вписать в `/opt/afishacity/.env`**

```
YANDEX_API_KEY=AQVN...
YANDEX_FOLDER_ID=b1g...
AI_PROVIDER=yandex
```

Затем `systemctl restart free`. Проверка:

```
curl -s https://ДОМЕН/api/health | grep -o '"ai_provider":"[^"]*"'
curl -s https://ДОМЕН/api/health | grep -o '"yandex":{[^}]*}'
```

Если `ready:false`, поля `has_key` и `has_folder` покажут, чего не хватает.

**Как это выглядит у человека.** Кнопка микрофона открывает отдельный экран
разговора: в центре шар, который дышит под голос, под ним живая расшифровка,
ниже — карточки найденных мест с кнопками брони и маршрута. Нажатие на шар во
время реплики агента перебивает его — это нормальный способ вести разговор.

**Почему звук записывается сырым PCM.** MediaRecorder в браузере отдаёт
WebM/Opus (Chrome) или MP4/AAC (Safari); SpeechKit не принимает ни то, ни
другое. Перекодировать на сервере означало бы тащить ffmpeg ради одной
функции. Поэтому запись идёт через Web Audio, сводится к 16 кГц моно и уходит
в том виде, который SpeechKit берёт напрямую. Ответ синтезируется в MP3:
Ogg Opus в Safari играет не везде.

**Стоимость.** Каждая реплика — три обращения: распознавание, модель, синтез.
Лимит `VOICE_RATE_LIMIT` ограничивает число обращений на пользователя
за десять минут.
