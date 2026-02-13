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
Приклад розгортання в `/opt/wa_2` і запуск як сервіс (без створення окремого юзера).

### 1) Встановіть залежності
Ubuntu/Debian приклад:
```bash
sudo apt-get update
sudo apt-get install -y nodejs npm \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 xdg-utils
```

### 2) Клонувати проєкт і встановити залежності
```bash
sudo mkdir -p /opt/wa_2
sudo git clone https://github.com/b0gdan00/WA_2.git /opt/wa_2
cd /opt/wa_2
npm ci
```

### 3) Встановіть systemd unit
```bash
sudo cp deploy/systemd/wa-monitor.service /etc/systemd/system/wa-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now wa-monitor
```

### 4) Відкрити панель (сервер без GUI)
Варіант A (рекомендовано): SSH tunnel
```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
```
Після цього відкрийте на своєму ПК:
- `http://localhost:3000`

Варіант B: відкрити порт у фаєрволі та заходити напряму (краще робити через HTTPS/Reverse proxy).
У цьому випадку виставіть `HOST=0.0.0.0` у systemd unit (див. `deploy/systemd/wa-monitor.service`).

### 5) Логи
Systemd:
```bash
journalctl -u wa-monitor -f
```

Логи кожної сесії:
- `sessions/<sessionId>/logs/runtime.log`

## Примітки
- Не запускайте кілька копій сервера одночасно: це може залишати запущені headless Chromium процеси.
- Якщо сесія не стартує і в логах є `The browser is already running ...`, потрібно зупинити попередні процеси сервера/воркера.

## Корисні команди (Linux)
Нижче команди, які найчастіше потрібні для адміністрування сервера.

Оновити код з репозиторію і перезапустити сервіс:
```bash
cd /opt/wa_2
sudo git pull
npm ci
sudo systemctl restart wa-monitor
```
- `git pull`: підтягнути останню версію коду
- `npm ci`: перевстановити залежності строго по `package-lock.json`
- `systemctl restart`: застосувати зміни

Перевірити стан сервісу:
```bash
sudo systemctl status wa-monitor
```
- показує чи сервіс запущений, PID, останні повідомлення

Подивитись логи сервісу (systemd):
```bash
journalctl -u wa-monitor -f
```
- live-лог менеджера/воркерів через systemd

Подивитись шлях до unit-файла (де лежить сервіс):
```bash
systemctl show -p FragmentPath wa-monitor.service
```

Редагувати unit-файл (якщо міняєте PORT/HOST):
```bash
sudo nano /etc/systemd/system/wa-monitor.service
sudo systemctl daemon-reload
sudo systemctl restart wa-monitor
```
- `daemon-reload`: обов'язково після зміни unit-файла

Перевірити, що порт слухається:
```bash
sudo ss -ltnp | grep 3030
```
- покаже процес, який слухає порт (PORT можна змінити у unit-файлі)

SSH tunnel до панелі (рекомендовано, якщо сервіс слухає `HOST=127.0.0.1`):
```bash
ssh -L 3030:127.0.0.1:3030 user@<SERVER_IP>
```
- відкриває панель локально на ПК: `http://localhost:3030`

Відкрити порт у UFW (якщо потрібен прямий доступ):
```bash
sudo ufw allow 3030/tcp
sudo ufw status
```
- для прямого доступу виставіть в unit-файлі `HOST=0.0.0.0`

Де лежать дані сесій:
```bash
ls -la /opt/wa_2/sessions
```
- кожна сесія має свої `data/`, `logs/`, `.wwebjs_auth/`

Подивитись логи конкретної сесії:
```bash
tail -n 200 /opt/wa_2/sessions/<sessionId>/logs/runtime.log
```

Очистити дані конкретної сесії (УВАГА: зіб'ється авторизація і налаштування):
```bash
sudo systemctl stop wa-monitor
sudo rm -rf /opt/wa_2/sessions/<sessionId>
sudo systemctl start wa-monitor
```
