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

node_major(){ command -v node >/dev/null && node -v | sed 's/^v//' | cut -d. -f1 || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  say "Node.js"
  # Сначала пробуем пакет из самой системы: на свежих Ubuntu там уже Node 22+.
  apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
  if [ "$(node_major)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || die "репозиторий Node.js недоступен для этой версии системы"
    apt-get install -y -qq nodejs >/dev/null || die "не удалось установить Node.js"
  fi
fi
command -v npm >/dev/null || apt-get install -y -qq npm >/dev/null 2>&1 || true
[ "$(node_major)" -ge 20 ] || die "нужен Node.js 20+, установлен $(node -v 2>/dev/null || echo 'нет')"
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
ips(){ getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
SELF_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
APEX_IPS="$(ips "$DOMAIN")"; WWW_IPS="$(ips "www.$DOMAIN")"
if [ -z "$APEX_IPS" ]; then
  echo "   $DOMAIN пока не резолвится — DNS не дошёл"
elif [ -n "$SELF_IP" ] && ! printf '%s\n' $APEX_IPS | grep -qx "$SELF_IP"; then
  echo "   внимание: $DOMAIN указывает на $APEX_IPS, а этот сервер — $SELF_IP"
fi
DOMAINS=(-d "$DOMAIN")
# www добавляем, только если он указывает ровно туда же. Лишняя A-запись
# (парковка хостера) не проходит проверку и заваливает весь сертификат.
if [ -n "$WWW_IPS" ] && [ "$WWW_IPS" = "$APEX_IPS" ]; then
  DOMAINS+=(-d "www.$DOMAIN")
elif [ -n "$WWW_IPS" ]; then
  echo "   www.$DOMAIN указывает на $WWW_IPS вместо $APEX_IPS — сертификат без www"
fi
issue(){ certbot --nginx "$@" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; }
if issue "${DOMAINS[@]}"; then
  echo "   сертификат выпущен, редирект на HTTPS включён"
elif [ "${#DOMAINS[@]}" -gt 2 ] && issue -d "$DOMAIN"; then
  echo "   сертификат выпущен для $DOMAIN (без www), редирект на HTTPS включён"
else
  echo "   сертификат не выпущен (DNS ещё не дошёл или порт 80 закрыт). Повторите позже:"
  echo "   certbot --nginx -d $DOMAIN --redirect"
fi

say "Готово"
echo "Проверка:   https://$DOMAIN/api/health"
echo "Логи:       journalctl -u free -f"
echo "Настройки:  nano $DIR/.env  затем  systemctl restart free"
echo "Обновление: bash $DIR/deploy/install.sh $DOMAIN"
