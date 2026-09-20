#!/usr/bin/env bash
# Полная установка FREE на чистый Ubuntu/Debian VPS одной командой (от root):
#   curl -fsSL https://raw.githubusercontent.com/alikabdiraimov584-prog/afishacity/claude/blissful-lamport-3rprjv/deploy/install.sh | bash -s -- afishamskcity.ru 123456:BOT_TOKEN
# Аргументы: домен, токен бота (необязательно, можно вписать позже в /opt/afishacity/.env).
# Скрипт идемпотентный: повторный запуск обновляет код и перезапускает сервис.
set -euo pipefail

DOMAIN="${1:-}"; BOT_TOKEN="${2:-}"
REPO="https://github.com/alikabdiraimov584-prog/afishacity"
BRANCH="${FREE_BRANCH:-claude/blissful-lamport-3rprjv}"
DIR=/opt/afishacity

say(){ printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31mОШИБКА: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "запустите от root"
[ -n "$DOMAIN" ] || die "укажите домен: bash install.sh afishamskcity.ru [токен_бота]"
command -v apt-get >/dev/null || die "поддерживаются только Ubuntu/Debian"
export DEBIAN_FRONTEND=noninteractive

say "Пакеты: git, nginx, certbot"
apt-get update -qq
apt-get install -y -qq curl git nginx certbot python3-certbot-nginx >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  say "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
say "Node $(node -v)"

say "Код проекта → $DIR"
id -u free >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin free
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
(cd "$DIR" && npm ci --omit=dev --silent)

say "Настройки .env"
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
fi
if [ -n "$BOT_TOKEN" ]; then
  sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$BOT_TOKEN|" "$DIR/.env"
fi
grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$DIR/.env" || echo "   (токен бота не задан — проверка подписи Telegram выключена; впишите его позже в $DIR/.env)"
grep -q '^ANTHROPIC_API_KEY=.\+' "$DIR/.env" || echo "   (ключ Claude не задан — работает демо-режим; впишите ANTHROPIC_API_KEY в $DIR/.env)"
chown -R free:free "$DIR"; chmod 600 "$DIR/.env"

say "Сервис systemd"
cp "$DIR/deploy/free.service" /etc/systemd/system/free.service
systemctl daemon-reload
systemctl enable -q free
systemctl restart free
sleep 2
curl -fsS http://127.0.0.1:3000/api/health >/dev/null || { journalctl -u free -n 30 --no-pager; die "сервис не поднялся, лог выше"; }
echo "   сервис отвечает на 127.0.0.1:3000"

say "nginx для $DOMAIN"
if ss -ltnp | grep -q ':80 .*apache2'; then systemctl disable -q --now apache2; fi
sed "s/YOUR_DOMAIN/$DOMAIN www.$DOMAIN/" "$DIR/deploy/nginx.conf" > /etc/nginx/sites-available/free
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/free /etc/nginx/sites-enabled/free
nginx -t -q
systemctl enable -q nginx; systemctl reload nginx || systemctl restart nginx
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow -q 'Nginx Full' >/dev/null || true; fi

say "HTTPS через Let's Encrypt"
DOMAINS=(-d "$DOMAIN")
if getent hosts "www.$DOMAIN" >/dev/null; then DOMAINS+=(-d "www.$DOMAIN"); fi
if certbot --nginx "${DOMAINS[@]}" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
  echo "   сертификат выпущен, редирект на HTTPS включён"
else
  echo "   сертификат не выпущен (DNS ещё не дошёл или порт 80 закрыт). Повторите позже:"
  echo "   certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
fi

say "Готово"
echo "Проверка:   https://$DOMAIN/api/health"
echo "Логи:       journalctl -u free -f"
echo "Настройки:  nano $DIR/.env  затем  systemctl restart free"
echo "Обновление: bash $DIR/deploy/install.sh $DOMAIN"
