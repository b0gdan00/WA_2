# WA Monitor (Node.js + whatsapp-web.js)

Локальний інструмент для:
- авторизації WhatsApp Web через QR на веб-сторінці,
- завантаження списку чатів (у тому числі груп),
- вибору чатів для моніторингу,
- перевірки повідомлень за ключовими словами (обов'язково),
- форварду співпадінь у вибрану кінцеву групу.

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
1. Дочекайтесь появи QR-коду на сторінці.
2. Відскануйте QR у WhatsApp на телефоні.
3. Після статусу `Готово до роботи` натисніть `Оновити чати`.
4. Позначте чати для сканування.
5. Оберіть кінцеву групу.
6. Додайте одне або кілька ключових слів.
7. Натисніть `Зберегти налаштування`.

## UI бібліотеки
Використано тільки ці фронтенд-підключення:
- Tailwind CDN
- FontAwesome CDN

## Примітка
Сесія WhatsApp зберігається локально в `.wwebjs_auth/` (через `LocalAuth`).
Налаштування (джерела/ключові слова/кінцева група) зберігаються в `data/settings.json`.

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
