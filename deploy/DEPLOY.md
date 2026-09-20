# Публикация FREE как Telegram Mini App

Telegram открывает Mini App только по HTTPS, поэтому нужны: домен, сервер с публичным IP
и TLS-сертификат. Ниже путь для Ubuntu 22.04/24.04 с nginx. Альтернатива через Docker в конце.

## 1. DNS

В панели регистратора создайте A-запись: `@` (или `app`) → IP сервера. Проверка: `dig +short YOUR_DOMAIN`.

## 2. Бот в Telegram

1. В @BotFather: `/newbot` → получите токен вида `123456:ABC...`. Он нужен серверу для проверки подписи запросов.
2. Позже, когда сайт заработает по HTTPS: `/newapp` → выберите бота → название, описание, картинка 640×360 → **Web App URL: `https://YOUR_DOMAIN`** → короткое имя. Ссылка на приложение: `https://t.me/BOT_NAME/APP_NAME`.
3. Кнопка меню в чате с ботом: `/mybots` → бот → Bot Settings → Menu Button → URL `https://YOUR_DOMAIN`.

## 3. Сервер

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
