# WA Monitor (Node.js + whatsapp-web.js)

Інструмент для автоматичної пересилки повідомлень між групами/чатами WhatsApp за ключовими словами.

Підтримується **багатосесійний режим**:
- `manager.js` (панель): керує сесіями
- `worker.js` (воркер): окремий процес на кожну сесію з власною авторизацією та налаштуваннями

## Для простого користувача (швидкий старт)
1. Запустіть програму:
```bash
npm install
npm start
```

2. Відкрийте панель у браузері:
- `http://localhost:3000`

3. Створіть сесію:
- Введіть назву в полі `Нова сесія`
- Натисніть `Створити`

4. Запустіть сесію:
- Оберіть її в `Активна сесія`
- Натисніть `Запустити`

5. Авторизуйтесь:
- Якщо потрібна авторизація, з''явиться QR
- Відскануйте QR у WhatsApp на телефоні (WhatsApp Web)

6. Налаштуйте пересилку:
- Натисніть `Оновити чати`
- Позначте `Чати для сканування` (джерела)
- Оберіть `Кінцева група`
- Додайте ключові слова
- Натисніть `Зберегти налаштування`

Якщо в повідомленні з джерельного чату є ключове слово, воно буде переслане в кінцеву групу з префіксом:
`Переслано автоматично з <Назва чату>`

## Вимоги
- Node.js 18+ (рекомендовано 20+)
- Інтернет
- На Linux: пакети/залежності для headless Chromium (див. нижче)

## Дані та зберігання
Кожна сесія зберігає дані в `sessions/<sessionId>/`:
- авторизація: `sessions/<sessionId>/.wwebjs_auth/` (через `LocalAuth`)
- налаштування: `sessions/<sessionId>/data/settings.json`
- логи воркера: `sessions/<sessionId>/logs/runtime.log`

Реєстр сесій менеджера:
- `manager-data/sessions.json`

## Linux (деплой на сервер) + systemd
Приклад розгортання в `/opt/wa_2` і запуск як сервіс.

### 1) Встановіть залежності
Ubuntu/Debian приклад:
```bash
sudo apt-get update
sudo apt-get install -y nodejs npm \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 xdg-utils
```

### 2) Створіть користувача
```bash
sudo useradd -r -s /usr/sbin/nologin wa || true
```

### 3) Розмістіть проєкт
```bash
sudo mkdir -p /opt/wa_2
sudo chown -R wa:wa /opt/wa_2
# скопіюйте файли проєкту в /opt/wa_2
cd /opt/wa_2
sudo -u wa npm ci
```

### 4) Встановіть systemd unit
```bash
sudo cp deploy/systemd/wa-monitor.service /etc/systemd/system/wa-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now wa-monitor
```

### 5) Відкрити панель (сервер без GUI)
Варіант A (рекомендовано): SSH tunnel
```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
```
Після цього відкрийте на своєму ПК:
- `http://localhost:3000`

Варіант B: відкрити порт у фаєрволі та заходити напряму (краще робити через HTTPS/Reverse proxy).

### 6) Логи
Systemd:
```bash
journalctl -u wa-monitor -f
```

Логи кожної сесії:
- `sessions/<sessionId>/logs/runtime.log`

## Примітки
- Не запускайте кілька копій сервера одночасно: це може залишати запущені headless Chromium процеси.
- Якщо сесія не стартує і в логах є `The browser is already running ...`, потрібно зупинити попередні процеси сервера/воркера.
