# WA Monitor (Node.js + whatsapp-web.js)

Локальний інструмент для:
- авторизації WhatsApp Web через QR на веб-сторінці,
- завантаження списку чатів (у тому числі груп),
- вибору чатів для моніторингу,
- перевірки повідомлень за ключовими словами (обов''язково),
- пересилки співпадінь у вибрану кінцеву групу.

Підтримується **багатосесійний режим**:
- `manager.js` (головна панель): керує сесіями
- `worker.js` (воркер сесії): окремий процес на кожну сесію з власною авторизацією та налаштуваннями

## Вимоги
- Node.js 18+ (рекомендовано 20+)
- Інтернет для WhatsApp Web
- Chromium-залежності (Linux) для headless браузера

## Встановлення
```bash
npm install
```

## Запуск
```bash
npm start
```

Після запуску відкрийте:
- `http://localhost:3000`

## Як працювати
1. На сторінці створіть нову сесію або оберіть існуючу.
2. Натисніть `Запустити`.
3. Дочекайтесь появи QR-коду (якщо потрібен) і відскануйте його у WhatsApp на телефоні.
4. Після статусу `Готово до роботи` натисніть `Оновити чати`.
5. Позначте чати для сканування, оберіть кінцеву групу, додайте ключові слова.
6. Натисніть `Зберегти налаштування`.

## UI бібліотеки
Використано тільки ці фронтенд-підключення:
- Tailwind CDN
- FontAwesome CDN

## Дані та зберігання
Кожна сесія зберігає дані в `sessions/<sessionId>/`:
- авторизація: `sessions/<sessionId>/.wwebjs_auth/` (через `LocalAuth`)
- налаштування: `sessions/<sessionId>/data/settings.json`
- логи: `sessions/<sessionId>/logs/runtime.log`

Реєстр сесій менеджера:
- `manager-data/sessions.json`

## Linux (systemd)
Приклад розгортання в `/opt/wa_2` і запуск як сервіс.

1. Встановіть залежності (Ubuntu/Debian приклад):
```bash
sudo apt-get update
sudo apt-get install -y nodejs npm \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 xdg-utils
```

2. Створіть користувача для сервісу:
```bash
sudo useradd -r -s /usr/sbin/nologin wa || true
```

3. Скопіюйте проєкт в `/opt/wa_2`, встановіть залежності:
```bash
sudo mkdir -p /opt/wa_2
sudo chown -R wa:wa /opt/wa_2
cd /opt/wa_2
npm ci
```

4. Встановіть systemd unit:
```bash
sudo cp deploy/systemd/wa-monitor.service /etc/systemd/system/wa-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now wa-monitor
```

5. Логи:
```bash
journalctl -u wa-monitor -f
```
