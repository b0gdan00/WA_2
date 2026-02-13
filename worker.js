const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const SESSION_ID = process.env.SESSION_ID || 'default';
const SESSION_DIR =
  process.env.SESSION_DIR || path.join(__dirname, 'sessions', SESSION_ID);
const HOST = process.env.WORKER_HOST || '127.0.0.1';
const PORT = Number(process.env.WORKER_PORT || 0);

// WhatsApp has practical message/caption limits; sending bigger payloads may truncate.
// Split long forwards into smaller chunks to ensure the whole text arrives.
const MAX_TEXT_LENGTH = Number(process.env.MAX_TEXT_LENGTH || 3500);
const MAX_CAPTION_LENGTH = Number(process.env.MAX_CAPTION_LENGTH || 900);
const SEND_CHUNK_DELAY_MS = Number(process.env.SEND_CHUNK_DELAY_MS || 250);

// Best-effort: keep the session alive and automatically recover from disconnects.
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 60_000);
const RECONNECT_BASE_DELAY_MS = Number(process.env.RECONNECT_BASE_DELAY_MS || 5_000);
const RECONNECT_MAX_DELAY_MS = Number(process.env.RECONNECT_MAX_DELAY_MS || 5 * 60_000);

const LOG_DIR = path.join(SESSION_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'runtime.log');
const DATA_DIR = path.join(SESSION_DIR, 'data');
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
let httpServer = null;
let shuttingDown = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let initializeInFlight = false;
let keepAliveTimer = null;
let sendChain = Promise.resolve();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
// лалала
actionInit();

function actionInit() {
  ensureDir(SESSION_DIR);
  ensureDir(LOG_DIR);
  ensureDir(DATA_DIR);
}

function sanitizeLogText(text) {
  return String(text || '').replace(/\r?\n/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const destinationChatId =
    typeof settings.destinationChatId === 'string'
      ? settings.destinationChatId.trim()
      : '';

  const keywords = normalizeKeywords(settings.keywords);

  const filteredSources = destinationChatId
    ? sourceChatIds.filter((id) => id !== destinationChatId)
    : sourceChatIds;

  scanner.sourceChatIds = new Set(filteredSources);
  scanner.destinationChatId = destinationChatId;
  scanner.keywords = keywords;
  scanner.enabled = Boolean(
    destinationChatId && filteredSources.length > 0 && keywords.length > 0
  );
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
    fs.writeFileSync(
      SETTINGS_FILE,
      `${JSON.stringify(serializeSettings(), null, 2)}\n`,
      'utf8'
    );
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

function splitTextIntoChunks(text, maxLen) {
  const value = String(text ?? '');
  const limit = Math.max(1, Number(maxLen) || 1);

  if (!value) {
    return [];
  }

  if (value.length <= limit) {
    return [value];
  }

  const chunks = [];
  let idx = 0;
  const hardMaxChunks = 200; // Safety valve to avoid infinite spam on absurdly large inputs.

  while (idx < value.length && chunks.length < hardMaxChunks) {
    let end = Math.min(idx + limit, value.length);

    // Try to split on a whitespace/newline near the end to keep words intact.
    if (end < value.length) {
      const slice = value.slice(idx, end);
      const lastNl = slice.lastIndexOf('\n');
      const lastSpace = slice.lastIndexOf(' ');
      const breakAt = Math.max(lastNl, lastSpace);

      // Only use the break if it is close to the end; otherwise we risk tiny chunks.
      if (breakAt >= Math.max(0, slice.length - 200)) {
        end = idx + breakAt + 1;
      }
    }

    const part = value.slice(idx, end);
    chunks.push(part);
    idx = end;
  }

  if (idx < value.length) {
    // Message is extremely large; include a final marker so it's obvious it was truncated by us.
    chunks.push('[message too long: truncated]');
  }

  return chunks;
}

async function sendMessageWithRetry(chatId, content, options) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (options) {
        await client.sendMessage(chatId, content, options);
      } else {
        await client.sendMessage(chatId, content);
      }
      return;
    } catch (error) {
      lastError = error;
      const waitMs = Math.min(2000 * attempt, 5000);
      pushLog('error', `sendMessage failed (attempt ${attempt}/${maxAttempts}): ${error.message}`);
      await sleep(waitMs);
    }
  }

  throw lastError || new Error('sendMessage failed');
}

function enqueueSend(fn) {
  sendChain = sendChain
    .then(() => fn())
    .catch((error) => {
      // Keep the chain alive even if one send fails.
      pushLog('error', `Send queue error: ${error.message}`);
    });
  return sendChain;
}

async function sendTextInChunks(chatId, text, maxLen) {
  const chunks = splitTextIntoChunks(text, maxLen);
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    await sendMessageWithRetry(chatId, chunk);
    if (SEND_CHUNK_DELAY_MS > 0) {
      await sleep(SEND_CHUNK_DELAY_MS);
    }
  }
}

async function sendMediaWithCaptionAndText(chatId, media, fullText) {
  const chunks = splitTextIntoChunks(fullText, MAX_CAPTION_LENGTH);
  if (chunks.length === 0) {
    await sendMessageWithRetry(chatId, media);
    return;
  }

  const [caption, ...rest] = chunks;
  await sendMessageWithRetry(chatId, media, { caption });

  for (const chunk of rest) {
    if (!chunk) {
      continue;
    }
    await sendMessageWithRetry(chatId, chunk);
    if (SEND_CHUNK_DELAY_MS > 0) {
      await sleep(SEND_CHUNK_DELAY_MS);
    }
  }
}

function isDuplicateMessage(message) {
  const messageId =
    message && message.id && message.id._serialized ? message.id._serialized : '';
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

loadSettingsFromDisk();

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: SESSION_ID,
    dataPath: path.join(SESSION_DIR, '.wwebjs_auth')
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

function reconnectDelayMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  const base = RECONNECT_BASE_DELAY_MS;
  const max = RECONNECT_MAX_DELAY_MS;
  const exp = Math.min(max, base * Math.pow(2, n - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(max, exp + jitter);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(trigger, details) {
  if (shuttingDown) {
    return;
  }

  if (reconnectTimer || initializeInFlight) {
    return;
  }

  reconnectAttempt += 1;
  if (reconnectAttempt >= 12 && process.send) {
    pushLog('error', 'Забагато невдалих перепідключень. Перезапуск воркера для чистого відновлення.');
    // Let the manager process restart the worker with a clean Chromium instance.
    process.exit(2);
  }
  const delay = reconnectDelayMs(reconnectAttempt);
  runtime.status = 'reconnecting';
  runtime.lastError = null;
  runtime.qr = null;

  const reason = details ? ` (${details})` : '';
  pushLog(
    'system',
    `Перепідключення заплановано через ${Math.round(delay / 1000)}с: ${trigger}${reason}.`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reinitializeClient(trigger);
  }, delay);
}

async function reinitializeClient(trigger) {
  if (shuttingDown) {
    return;
  }

  if (initializeInFlight) {
    return;
  }
  initializeInFlight = true;

  runtime.status = 'reconnecting';
  runtime.lastError = null;
  runtime.qr = null;

  pushLog('system', `Спроба перепідключення (${trigger}), спроба #${reconnectAttempt || 1}...`);

  try {
    try {
      await client.destroy();
    } catch (error) {
      pushLog('error', `destroy() перед перепідключенням: ${error.message}`);
    }

    await client.initialize();
    // If initialize() did not throw, the client will emit qr/auth/ready events.
    reconnectAttempt = 0;
  } catch (error) {
    pushLog('error', `Перепідключення не вдалося: ${error.message}`);
    scheduleReconnect('reconnect_failed', error.message);
  } finally {
    initializeInFlight = false;
  }
}

function startKeepAlive() {
  if (keepAliveTimer) {
    return;
  }

  keepAliveTimer = setInterval(async () => {
    if (shuttingDown) {
      return;
    }
    if (runtime.status !== 'ready') {
      return;
    }

    try {
      // Lightweight ping. If it throws, schedule reconnect.
      if (typeof client.getState !== 'function') {
        return;
      }
      await client.getState();
    } catch (error) {
      pushLog('error', `Keepalive error: ${error.message}`);
      scheduleReconnect('keepalive', error.message);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

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
  clearReconnectTimer();
  pushLog('auth', 'Авторизація пройдена, чекаємо готовність клієнта.');
});

client.on('ready', async () => {
  runtime.status = 'ready';
  runtime.lastError = null;
  runtime.qr = null;
  clearReconnectTimer();
  reconnectAttempt = 0;
  startKeepAlive();
  pushLog('system', 'WhatsApp клієнт готовий до роботи.');

  try {
    await refreshChats();
    pushLog('system', `Завантажено чатів: ${cachedChats.length}.`);

    if (scanner.destinationChatId) {
      const destinationChat = cachedChats.find(
        (chat) => chat.id === scanner.destinationChatId
      );
      if (!destinationChat) {
        scanner.enabled = false;
        pushLog(
          'error',
          'Кінцеву групу з settings.json не знайдено у списку чатів. Моніторинг вимкнено.'
        );
      } else if (!destinationChat.isGroup) {
        scanner.enabled = false;
        pushLog(
          'error',
          'Кінцевий чат з settings.json не є групою. Моніторинг вимкнено.'
        );
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
  scheduleReconnect('auth_failure', runtime.lastError);
});

client.on('disconnected', (reason) => {
  runtime.status = 'disconnected';
  runtime.qr = null;
  pushLog('system', `Клієнт відключено: ${reason || 'невідома причина'}.`);
  scheduleReconnect('disconnected', reason || '');
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
    const fullText = prefix + body;

    if (message.hasMedia) {
      const media = await message.downloadMedia();
      if (!media) {
        pushLog('error', 'Не вдалося завантажити медіа для пересилки. Пропуск.');
        return;
      }

      await enqueueSend(async () => {
        await sendMediaWithCaptionAndText(scanner.destinationChatId, media, fullText);
      });
    } else {
      await enqueueSend(async () => {
        await sendTextInChunks(scanner.destinationChatId, fullText, MAX_TEXT_LENGTH);
      });
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

app.get('/api/meta', (_, res) => {
  res.json({ sessionId: SESSION_ID, sessionDir: SESSION_DIR });
});

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

  const destinationChatId =
    typeof body.destinationChatId === 'string' ? body.destinationChatId.trim() : '';

  const keywords = normalizeKeywords(body.keywords);

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
      `Оновлено налаштування: джерела=${scanner.sourceChatIds.size}, ключові слова=${scanner.keywords.length}, моніторинг активний.`
    );
  } else {
    pushLog(
      'scan',
      `Налаштування оновлено, але моніторинг неактивний: джерела=${scanner.sourceChatIds.size}, ключові слова=${scanner.keywords.length}, destination=${scanner.destinationChatId ? 'ok' : 'missing'}.`
    );
  }

  return res.json({ ...serializeSettings(), persisted });
});

app.get('/api/logs', (_, res) => {
  res.json({ logs: runtime.logs.slice(0, 100) });
});

async function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  pushLog('system', 'Зупинка воркера...');
  clearReconnectTimer();
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  try {
    await client.destroy();
  } catch (error) {
    pushLog('error', `Помилка destroy(): ${error.message}`);
  }

  if (httpServer) {
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  pushLog('system', 'Воркер зупинено.');
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason || 'unknown');
  pushLog('error', `unhandledRejection: ${msg}`);
  scheduleReconnect('unhandledRejection', msg);
});

process.on('uncaughtException', (error) => {
  pushLog('error', `uncaughtException: ${error?.message || String(error)}`);
  scheduleReconnect('uncaughtException', error?.message || '');
});

httpServer = app.listen(PORT, HOST, () => {
  const address = httpServer.address();
  const realPort = address && typeof address === 'object' ? address.port : PORT;

  pushLog('system', `Worker HTTP запущено: http://${HOST}:${realPort} (session=${SESSION_ID})`);

  if (process.send) {
    process.send({ type: 'listening', port: realPort });
  }
});

client.initialize().catch((error) => {
  runtime.status = 'init_error';
  runtime.lastError = error.message;
  pushLog('error', `Помилка ініціалізації клієнта: ${error.message}`);
  scheduleReconnect('init_error', error.message);
});
