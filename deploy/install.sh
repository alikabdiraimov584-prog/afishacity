#!/usr/bin/env bash
# Полная установка FREE на чистый Ubuntu/Debian VPS одной командой (от root):
#   curl -fsSL https://raw.githubusercontent.com/alikabdiraimov584-prog/afishacity/claude/blissful-lamport-3rprjv/deploy/install.sh | bash -s -- afishamskcity.ru 123456:BOT_TOKEN
# Аргументы: домен, токен бота (необязательно, можно вписать позже в /opt/afishacity/.env).
# Скрипт идемпотентный: повторный запуск обновляет код и перезапускает сервис.
set -euo pipefail

# Ниже git reset --hard перезаписывает в том числе этот файл, а bash дочитывает
# скрипт с диска по мере выполнения — обновление ломало бы само себя на полпути.
# Поэтому сразу уходим в копию. При запуске через curl | bash копия не нужна.
if [ -z "${FREE_SELF_COPY:-}" ] && [ -f "${BASH_SOURCE[0]:-/nonexistent}" ]; then
  self="$(mktemp "${TMPDIR:-/tmp}/free-install.XXXXXX")"
  cat "${BASH_SOURCE[0]}" >"$self"
  FREE_SELF_COPY="$self" exec bash "$self" "$@"
fi
if [ -n "${FREE_SELF_COPY:-}" ]; then trap 'rm -f "$FREE_SELF_COPY"' EXIT; fi

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

# Подкачка: не для скорости, а чтобы всплеск памяти не ронял всю машину.
# На гигабайте без подкачки любой пик — это мгновенный отказ всем сразу: nginx
# перестаёт отвечать, sshd не может развернуть сессию, и до сервера не
# достучаться именно тогда, когда это нужно. С файлом подкачки тот же пик
# становится просто замедлением на несколько секунд.
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  FREE_KB=$(df --output=avail -k / | tail -1)
  if [ "${FREE_KB:-0}" -gt 3145728 ]; then      # оставляем не меньше 2 ГБ свободными
    say "Файл подкачки 1 ГБ"
    # Ни один шаг здесь не имеет права уронить установку. В контейнерной
    # виртуализации (OpenVZ, часть LXC) ядро подкачку просто не даёт, и swapon
    # возвращает отказ. При set -e это обрывало бы весь скрипт прямо тут —
    # до выкладки кода, служб и nginx, — то есть сервер оставался бы без
    # обновления из-за необязательного улучшения. Подкачка желательна, но
    # обязательной частью установки быть не может.
    if fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none 2>/dev/null; then
      chmod 600 /swapfile
      if mkswap -q /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; then
        grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
        # 10, а не умолчание: подкачка здесь — страховка на пик, а не место,
        # куда система складывает всё подряд, замедляя обычную работу.
        # Пишем в /etc/sysctl.d, а не в /etc/sysctl.conf: на свежих Ubuntu
        # последнего просто нет, и дописывание в него сначала печатало ошибку
        # от grep, а потом заводило файл, которого в системе быть не должно.
        # Отдельный файл к тому же видно как наш и легко убрать.
        printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-free.conf
        sysctl -q -w vm.swappiness=10 || true
        echo "   подкачка включена: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
      else
        # Не оставляем за собой гигабайт занятого места впустую.
        rm -f /swapfile
        echo "   подкачку это ядро не даёт (обычно контейнерная виртуализация) — продолжаю без неё"
      fi
    else
      echo "   не удалось создать файл подкачки — продолжаю без неё"
    fi
  else
    echo "   подкачки нет и места под неё тоже — всплеск памяти уронит машину целиком"
  fi
fi

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
# Папка принадлежит пользователю free, а запуск идёт от root: без этого git
# отказывается работать с "dubious ownership" и обновление тихо не происходит.
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$DIR" || git config --global --add safe.directory "$DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" || die "не удалось скачать код с GitHub"
  git -C "$DIR" checkout -q "$BRANCH" || die "не удалось переключиться на ветку $BRANCH"
  git -C "$DIR" reset -q --hard "origin/$BRANCH" || die "не удалось обновить код до origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$DIR" || die "не удалось клонировать $REPO"
fi
(cd "$DIR" && npm ci --omit=dev --silent)

say "Настройки .env"
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
fi
# .env создаётся один раз, а настройки в .env.example прибавляются с каждым
# обновлением. Без переноса обновление молча оставляет сервер без новых ключей,
# и это не видно: sed -i по несуществующей строке ничего не делает и ничего не
# говорит. Значения, которые человек уже вписал, не трогаем — только добавляем
# недостающие строки с умолчаниями.
ADDED=""
while IFS= read -r key; do
  [ -n "$key" ] || continue
  grep -q "^${key}=" "$DIR/.env" && continue
  { printf '\n'; grep -m1 "^${key}=" "$DIR/.env.example"; } >>"$DIR/.env"
  ADDED="$ADDED $key"
done <<EOF_KEYS
$(sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$DIR/.env.example")
EOF_KEYS
[ -z "$ADDED" ] || echo "   добавлены новые настройки со значениями по умолчанию:$ADDED"
# Правка .env с телефона легко оставляет строки без "=": вставленную команду,
# голый токен. systemd выбрасывает их молча, поэтому чистим сами и сообщаем.
STRAY=$(grep -cvE '^[[:space:]]*($|#)|^[A-Za-z_][A-Za-z0-9_]*=' "$DIR/.env" || true)
if [ "${STRAY:-0}" -gt 0 ]; then
  sed -i -E '/^[[:space:]]*($|#)/!{/^[A-Za-z_][A-Za-z0-9_]*=/!d}' "$DIR/.env"
  echo "   убрано строк не в формате КЛЮЧ=значение: $STRAY"
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

say "Снимок мест: таймер обновления"
cp "$DIR/deploy/free-snapshot.service" /etc/systemd/system/free-snapshot.service
cp "$DIR/deploy/free-snapshot.timer" /etc/systemd/system/free-snapshot.timer
systemctl daemon-reload
systemctl enable -q free-snapshot.timer
systemctl start free-snapshot.timer
if [ -s "$DIR/data/osm_moscow.db" ]; then
  echo "   снимок на месте: $(du -h "$DIR/data/osm_moscow.db" | cut -f1)"
elif systemctl is-active --quiet free-snapshot.service; then
  # Повторная установка во время сборки начинала её заново, и снимок не
  # успевал собраться никогда: десятки минут работы отбрасывались каждым
  # запуском обновления. Идёт — пусть идёт.
  echo "   сборка уже идёт — не трогаю (запущена $(systemctl show -p ActiveEnterTimestamp --value free-snapshot.service))"
  echo "   следить: journalctl -u free-snapshot -f"
else
  # Первая сборка идёт десятки минут, поэтому запускаем её фоном: сервер уже
  # отвечает, просто места пока ищутся через Overpass.
  if [ -s "$DIR/data/osm_moscow.status.json" ]; then
    echo "   прошлая сборка не удалась:"
    sed -n 's/.*"reason": *"\([^"]*\)".*/     \1/p' "$DIR/data/osm_moscow.status.json" | head -1
  fi
  echo "   снимка ещё нет — собираю в фоне, места пока ищутся напрямую"
  echo "   следить: journalctl -u free-snapshot -f"
  echo "   ВАЖНО: не запускайте обновление снова, пока сборка не закончится"
  systemctl start --no-block free-snapshot.service || true
fi

say "nginx для $DOMAIN"
if ss -ltnp | grep -q ':80 .*apache2'; then systemctl disable -q --now apache2; fi
# Шаблон ниже перезапишет конфиг вместе с блоком SSL, который дописал certbot.
# Держим копию, чтобы вернуть рабочий HTTPS, если сертификат не встанет обратно.
NGINX_PREV=""
if grep -qs ssl_certificate /etc/nginx/sites-available/free; then
  NGINX_PREV="$(mktemp)"; cp /etc/nginx/sites-available/free "$NGINX_PREV"
fi
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
restore_nginx(){
  [ -n "${NGINX_PREV:-}" ] || return 1
  cp "$NGINX_PREV" /etc/nginx/sites-available/free
  nginx -t -q && systemctl reload nginx
}
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] && certbot install --nginx --cert-name "$DOMAIN" --redirect --non-interactive >/dev/null 2>&1; then
  echo "   сертификат уже выпущен — вернули его в конфиг nginx"
elif issue "${DOMAINS[@]}"; then
  echo "   сертификат выпущен, редирект на HTTPS включён"
elif [ "${#DOMAINS[@]}" -gt 2 ] && issue -d "$DOMAIN"; then
  echo "   сертификат выпущен для $DOMAIN (без www), редирект на HTTPS включён"
elif restore_nginx; then
  echo "   сертификат не обновлён, вернули прежний конфиг с HTTPS"
else
  echo "   сертификат не выпущен (DNS ещё не дошёл или порт 80 закрыт). Повторите позже:"
  echo "   certbot --nginx -d $DOMAIN --redirect"
fi
if [ -n "${NGINX_PREV:-}" ]; then rm -f "$NGINX_PREV"; fi

say "Готово"
echo "Проверка:   https://$DOMAIN/api/health"
echo "Логи:       journalctl -u free -f"
echo "Настройки:  nano $DIR/.env  затем  systemctl restart free"
echo "Обновление: bash $DIR/deploy/install.sh $DOMAIN"
