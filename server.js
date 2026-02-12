const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'runtime.log');
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const app = express();
app.use(express.json({ limit: '1mb' }));

const runtime = {
  status: 'starting',
  qr: null,
  lastError: null,
  logs: []
};

let cachedChats = [];

const scanner = {
  sourceChatIds: new Set(),
  destinationChatId: '',
  keywords: [],
  enabled: false
};
const processedMessageIds = new Set();

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function sanitizeLogText(text) {
  return String(text || '').replace(/\r?\n/g, ' ').trim();
}

function pushLog(type, text) {
  const item = {
    time: new Date().toISOString(),
    type,
    text: sanitizeLogText(text)
  };

  runtime.logs.unshift(item);
  if (runtime.logs.length > 200) {
    runtime.logs = runtime.logs.slice(0, 200);
  }

  const line = `${item.time}\t${item.type}\t${item.text}\n`;
  fs.appendFile(LOG_FILE, line, (error) => {
    if (error) {
      console.error(`Log write error: ${error.message}`);
    }
  });
}

// Load persisted settings early, before WhatsApp is initialized.
loadSettingsFromDisk();

function normalizeKeywords(rawKeywords) {
  if (!Array.isArray(rawKeywords)) {
    return [];
  }

  const unique = new Set();
  for (const item of rawKeywords) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }

  return Array.from(unique);
}

function findMatchingKeyword(text, keywords) {
  const content = text.toLowerCase();
  for (const keyword of keywords) {
    if (content.includes(keyword)) {
      return keyword;
    }
  }
  return null;
}

function serializeSettings() {
  return {
    sourceChatIds: Array.from(scanner.sourceChatIds),
    destinationChatId: scanner.destinationChatId,
    keywords: scanner.keywords,
    enabled: scanner.enabled
  };
}

function applySettings(settings) {
  const sourceChatIds = Array.isArray(settings.sourceChatIds)
    ? settings.sourceChatIds.filter((id) => typeof id === 'string' && id.trim())
    : [];

  const destinationChatId = typeof settings.destinationChatId === 'string' ? settings.destinationChatId.trim() : '';
  const keywords = normalizeKeywords(settings.keywords);

  const filteredSources = destinationChatId
    ? sourceChatIds.filter((id) => id !== destinationChatId)
    : sourceChatIds;

  scanner.sourceChatIds = new Set(filteredSources);
  scanner.destinationChatId = destinationChatId;
  scanner.keywords = keywords;
  scanner.enabled = Boolean(destinationChatId && filteredSources.length > 0 && keywords.length > 0);
}

function loadSettingsFromDisk() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    pushLog('system', 'settings.json не знайдено, стартуємо з порожніми налаштуваннями.');
    return;
  }

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    applySettings(data || {});
    pushLog(
      'system',
      `Налаштування завантажено з диска: джерела=${scanner.sourceChatIds.size}, ключові слова=${scanner.keywords.length}, destination=${scanner.destinationChatId ? 'ok' : 'missing'}.`
    );
  } catch (error) {
    pushLog('error', `Не вдалося завантажити settings.json: ${error.message}`);
  }
}

function saveSettingsToDisk() {
  try {
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(serializeSettings(), null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    pushLog('error', `Не вдалося зберегти settings.json: ${error.message}`);
    return false;
  }
}

function normalizeChat(chat) {
  const id = chat.id && chat.id._serialized ? chat.id._serialized : '';
  const fallbackName = id || 'Без назви';
  return {
    id,
    name: chat.name || chat.formattedTitle || fallbackName,
    isGroup: Boolean(chat.isGroup)
  };
}

async function refreshChats() {
  if (runtime.status !== 'ready') {
    return cachedChats;
  }

  const chats = await client.getChats();
  cachedChats = chats
    .map(normalizeChat)
    .filter((chat) => chat.id)
    .sort((a, b) => {
      if (a.isGroup !== b.isGroup) {
        return Number(b.isGroup) - Number(a.isGroup);
      }
      return a.name.localeCompare(b.name, 'uk');
    });

  return cachedChats;
}

function chatNameById(chatId) {
  const chat = cachedChats.find((item) => item.id === chatId);
  return chat ? chat.name : chatId;
}

function shortMessageText(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function isDuplicateMessage(message) {
  const messageId = message && message.id && message.id._serialized ? message.id._serialized : '';
  if (!messageId) {
    return false;
  }

  if (processedMessageIds.has(messageId)) {
    return true;
  }

  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 2000) {
    const oldest = processedMessageIds.values().next().value;
    if (oldest) {
      processedMessageIds.delete(oldest);
    }
  }

  return false;
}

function sourceChatIdFromMessage(message) {
  if (!message) {
    return '';
  }

  if (message.fromMe && typeof message.to === 'string') {
    return message.to;
  }

  return typeof message.from === 'string' ? message.from : '';
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'wa-monitor' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async (qr) => {
  runtime.status = 'qr';
  runtime.lastError = null;
  try {
    runtime.qr = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
    pushLog('auth', 'Отримано новий QR-код для входу.');
  } catch (error) {
    runtime.qr = null;
    runtime.lastError = `Не вдалося сформувати QR: ${error.message}`;
    pushLog('error', runtime.lastError);
  }
});

client.on('authenticated', () => {
  runtime.status = 'authenticated';
  runtime.lastError = null;
  runtime.qr = null;
  pushLog('auth', 'Авторизація пройдена, чекаємо готовність клієнта.');
});

client.on('ready', async () => {
  runtime.status = 'ready';
  runtime.lastError = null;
  runtime.qr = null;
  pushLog('system', 'WhatsApp клієнт готовий до роботи.');

  try {
    await refreshChats();
    pushLog('system', `Завантажено чатів: ${cachedChats.length}.`);

    if (scanner.destinationChatId) {
      const destinationChat = cachedChats.find((chat) => chat.id === scanner.destinationChatId);
      if (!destinationChat) {
        scanner.enabled = false;
        pushLog('error', 'Кінцеву групу з settings.json не знайдено у списку чатів. Моніторинг вимкнено.');
      } else if (!destinationChat.isGroup) {
        scanner.enabled = false;
        pushLog('error', 'Кінцевий чат з settings.json не є групою. Моніторинг вимкнено.');
      }
    }
  } catch (error) {
    runtime.lastError = `Не вдалося завантажити чати: ${error.message}`;
    pushLog('error', runtime.lastError);
  }
});

client.on('auth_failure', (message) => {
  runtime.status = 'auth_failure';
  runtime.lastError = message || 'Помилка авторизації.';
  pushLog('error', `Помилка авторизації: ${runtime.lastError}`);
});

client.on('disconnected', (reason) => {
  runtime.status = 'disconnected';
  runtime.qr = null;
  pushLog('system', `Клієнт відключено: ${reason || 'невідома причина'}.`);
});

async function processMessageForScan(message, eventName) {
  if (isDuplicateMessage(message)) {
    return;
  }

  if (!scanner.enabled || !scanner.destinationChatId) {
    return;
  }

  const sourceChatId = sourceChatIdFromMessage(message);
  if (!sourceChatId) {
    pushLog('scan', `Пропуск (${eventName}): не вдалося визначити ID джерельного чату.`);
    return;
  }

  if (!scanner.sourceChatIds.has(sourceChatId)) {
    return;
  }

  if (sourceChatId === scanner.destinationChatId) {
    pushLog('scan', 'Пропуск: джерельний чат збігається з кінцевою групою.');
    return;
  }

  const body = typeof message.body === 'string' ? message.body : '';
  if (!body) {
    pushLog('scan', `Пропуск повідомлення з "${chatNameById(sourceChatId)}": порожній текст.`);
    return;
  }

  const matchedKeyword = findMatchingKeyword(body, scanner.keywords);
  if (!matchedKeyword) {
    pushLog(
      'scan',
      `Пропуск (${eventName}) з "${chatNameById(sourceChatId)}": ключові слова не знайдено. Текст: "${shortMessageText(body)}"`
    );
    return;
  }

  try {
    const prefix = `Переслано автоматично з ${chatNameById(sourceChatId)}\n\n`;

    if (message.hasMedia) {
      const media = await message.downloadMedia();
      if (!media) {
        pushLog('error', 'Не вдалося завантажити медіа для пересилки. Пропуск.');
        return;
      }

      const caption = prefix + shortMessageText(body);
      await client.sendMessage(scanner.destinationChatId, media, { caption });
    } else {
      await client.sendMessage(scanner.destinationChatId, prefix + body);
    }

    pushLog(
      'scan',
      `Переслано (${eventName}): "${chatNameById(sourceChatId)}" -> "${chatNameById(
        scanner.destinationChatId
      )}", ключове слово: "${matchedKeyword}", текст: "${shortMessageText(body)}"`
    );
  } catch (error) {
    pushLog('error', `Помилка пересилки: ${error.message}`);
  }
}

client.on('message', async (message) => {
  await processMessageForScan(message, 'message');
});

client.on('message_create', async (message) => {
  await processMessageForScan(message, 'message_create');
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_, res) => {
  res.json({
    status: runtime.status,
    ready: runtime.status === 'ready',
    hasQr: Boolean(runtime.qr),
    qr: runtime.qr,
    lastError: runtime.lastError
  });
});

app.get('/api/chats', async (req, res) => {
  if (runtime.status !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp клієнт ще не готовий.' });
  }

  try {
    const shouldRefresh = req.query.refresh === '1';
    if (shouldRefresh || cachedChats.length === 0) {
      await refreshChats();
    }

    return res.json({ chats: cachedChats });
  } catch (error) {
    return res.status(500).json({ error: `Помилка отримання чатів: ${error.message}` });
  }
});

app.get('/api/settings', (_, res) => {
  res.json(serializeSettings());
});

app.post('/api/settings', (req, res) => {
  const body = req.body || {};

  const sourceChatIds = Array.isArray(body.sourceChatIds)
    ? body.sourceChatIds.filter((id) => typeof id === 'string' && id.trim())
    : [];
  const keywords = normalizeKeywords(body.keywords);

  const destinationChatId = typeof body.destinationChatId === 'string' ? body.destinationChatId.trim() : '';
  if (destinationChatId && runtime.status === 'ready') {
    const destinationChat = cachedChats.find((chat) => chat.id === destinationChatId);
    if (!destinationChat) {
      return res.status(400).json({ error: 'Кінцеву групу не знайдено у списку чатів.' });
    }
    if (!destinationChat.isGroup) {
      return res.status(400).json({ error: 'Кінцевий чат має бути саме групою.' });
    }
  }

  applySettings({ sourceChatIds, destinationChatId, keywords });
  const persisted = saveSettingsToDisk();

  if (scanner.enabled) {
    pushLog(
      'scan',
      `Оновлено налаштування: джерела=${sourceChatIds.length}, ключові слова=${keywords.length}, моніторинг активний.`
    );
  } else {
    pushLog(
      'scan',
      `Налаштування оновлено, але моніторинг неактивний: джерела=${sourceChatIds.length}, ключові слова=${keywords.length}, destination=${destinationChatId ? 'ok' : 'missing'}.`
    );
  }

  return res.json({ ...serializeSettings(), persisted });
});

app.get('/api/logs', (_, res) => {
  res.json({ logs: runtime.logs.slice(0, 100) });
});

app.listen(PORT, () => {
  pushLog('system', `HTTP сервер запущено на порту ${PORT}. Лог-файл: ${LOG_FILE}`);
  console.log(`Server started: http://localhost:${PORT}`);
});

client.initialize().catch((error) => {
  runtime.status = 'init_error';
  runtime.lastError = error.message;
  pushLog('error', `Помилка ініціалізації клієнта: ${error.message}`);
});
