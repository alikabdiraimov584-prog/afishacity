# FREE — мобильное приложение (iOS, Capacitor)

Приложение — нативная оболочка Capacitor вокруг интерфейса из `../public/`. Весь функционал
(диалог, поиск, план вечера, профиль) работает через бэкенд `server.mjs`, адрес которого задаётся
в `app.config.json`. Нативные возможности: геолокация, встроенный браузер для брони и маршрутов,
системный шаринг, вибрация, распознавание речи Apple (без сторонних серверов).

## Что нужно

- Mac с Xcode 15+ (App Store → Xcode), после установки один раз открыть Xcode и принять лицензию.
- Node.js 20+.
- Аккаунт Apple Developer (99 $/год) для установки на свой iPhone и публикации в TestFlight / App Store.
- Запущенный бэкенд по HTTPS (см. `../deploy/DEPLOY.md`). Его адрес — в `app.config.json` → `apiBase`.

## Сборка и запуск

```bash
cd app
npm install
npm run sync        # собирает www/ из ../public и копирует в iOS-проект
npm run ios         # открывает проект в Xcode
```

В Xcode: выберите target **App** → вкладка *Signing & Capabilities* → *Team* = ваш аккаунт.
Bundle Identifier `ru.afishacity.free` можно поменять на свой. Выберите симулятор или подключённый
iPhone и нажмите ▶. На реальном iPhone при первом запуске: Настройки → Основные → VPN и управление
устройством → доверять разработчику.

После правок в `../public/index.html` достаточно `npm run sync` и повторного запуска из Xcode.

## Отладка с локальным бэкендом

В симуляторе бэкенд на Mac доступен как `http://127.0.0.1:3000`:

```bash
FREE_API_BASE=http://127.0.0.1:3000 npm run sync
```

Для http-адреса Xcode потребует разрешить незащищённый трафик: в `ios/App/App/Info.plist`
добавьте `NSAppTransportSecurity` → `NSAllowsLocalNetworking = YES`. Для продакшена нужен HTTPS.

## Иконка и заставка

Исходники в `assets/` (`icon-only.png`, `icon-foreground.png`, `icon-background.png`, `splash*.png`).
Замените их на свои и выполните `npm run assets` — сгенерируются все размеры для iOS.

## Публикация

1. В Xcode: Product → Archive → Distribute App → App Store Connect.
2. В App Store Connect создайте приложение с тем же Bundle ID, загрузите сборку, добавьте
   тестировщиков в TestFlight.
3. Для App Store понадобятся: скриншоты, описание, политика конфиденциальности (URL), ответы на
   вопросы о сборе данных (приложение хранит анонимный идентификатор, геопозицию не сохраняет).

## Android позже

`npx cap add android` создаст Android-проект из того же кода; все плагины кроссплатформенные.
