const elements = {
  refreshSessionsBtn: document.getElementById('refreshSessionsBtn'),
  sessionSelect: document.getElementById('sessionSelect'),
  newSessionName: document.getElementById('newSessionName'),
  createSessionBtn: document.getElementById('createSessionBtn'),
  startSessionBtn: document.getElementById('startSessionBtn'),
  stopSessionBtn: document.getElementById('stopSessionBtn'),
  deleteSessionBtn: document.getElementById('deleteSessionBtn'),
  sessionInfo: document.getElementById('sessionInfo'),

  statusText: document.getElementById('statusText'),
  errorText: document.getElementById('errorText'),
  qrImage: document.getElementById('qrImage'),
  qrHint: document.getElementById('qrHint'),

  chatList: document.getElementById('chatList'),
  refreshStatusBtn: document.getElementById('refreshStatusBtn'),
  refreshChatsBtn: document.getElementById('refreshChatsBtn'),

  destinationSelect: document.getElementById('destinationSelect'),
  keywordInput: document.getElementById('keywordInput'),
  addKeywordBtn: document.getElementById('addKeywordBtn'),
  keywordList: document.getElementById('keywordList'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  settingsInfo: document.getElementById('settingsInfo'),

  toggleLogsBtn: document.getElementById('toggleLogsBtn'),
  logsContainer: document.getElementById('logsContainer'),
  logList: document.getElementById('logList')
};

const state = {
  sessions: [],
  activeSessionId: '',
  sessionRuntime: null,

  status: null,
  chats: [],
  settings: {
    sourceChatIds: [],
    destinationChatId: '',
    keywords: [],
    enabled: false
  },

  ui: {
    showLogs: true
  }
};

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function loadUiPreferences() {
  const rawLogs = localStorage.getItem('wa_ui_show_logs');
  state.ui.showLogs = rawLogs !== '0';

  const rawSession = localStorage.getItem('wa_active_session');
  if (rawSession) {
    state.activeSessionId = rawSession;
  }
}

function saveActiveSession(id) {
  state.activeSessionId = id;
  localStorage.setItem('wa_active_session', id);
}

function saveLogsPref() {
  localStorage.setItem('wa_ui_show_logs', state.ui.showLogs ? '1' : '0');
}

function renderLogsVisibility() {
  if (state.ui.showLogs) {
    elements.logsContainer.classList.remove('hidden');
    elements.toggleLogsBtn.textContent = 'Сховати';
  } else {
    elements.logsContainer.classList.add('hidden');
    elements.toggleLogsBtn.textContent = 'Показати';
  }
}

function sessionLabel(runtime) {
  if (!runtime) {
    return 'Невідомо';
  }
  const map = {
    stopped: 'Зупинена',
    starting: 'Запускається',
    running: 'Працює',
    stopping: 'Зупиняється',
    error: 'Помилка'
  };
  return map[runtime.status] || runtime.status;
}

function statusLabel(code) {
  const map = {
    starting: 'Запуск',
    qr: 'Потрібна авторизація (QR)',
    authenticated: 'Авторизовано, очікується готовність',
    ready: 'Готово до роботи',
    auth_failure: 'Помилка авторизації',
    disconnected: 'Відключено',
    init_error: 'Помилка ініціалізації'
  };

  return map[code] || code || 'Невідомо';
}

function activeSession() {
  return state.sessions.find((s) => s.id === state.activeSessionId) || null;
}

function renderSessions() {
  if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
    elements.sessionSelect.innerHTML = '<option value="">Немає сесій</option>';
    elements.sessionInfo.textContent = 'Створіть сесію, щоб почати.';
    return;
  }

  const options = state.sessions.map((s) => {
    const rt = s.runtime || {};
    const selected = s.id === state.activeSessionId ? 'selected' : '';
    const suffix = rt && rt.status ? ` (${sessionLabel(rt)})` : '';
    return `<option value="${escapeHtml(s.id)}" ${selected}>${escapeHtml(s.name || s.id)}${escapeHtml(
      suffix
    )}</option>`;
  });

  elements.sessionSelect.innerHTML = options.join('');

  const s = activeSession();
  if (!s) {
    elements.sessionInfo.textContent = 'Оберіть сесію.';
    return;
  }

  const rt = s.runtime || null;
  state.sessionRuntime = rt;

  const pid = rt && rt.pid ? `pid=${rt.pid}` : 'pid=-';
  const err = rt && rt.lastError ? `, помилка: ${rt.lastError}` : '';
  elements.sessionInfo.textContent = `Сесія: ${s.id}, стан: ${sessionLabel(rt)} (${pid})${err}`;

  const running = rt && rt.status === 'running';
  elements.startSessionBtn.disabled = running;
  elements.stopSessionBtn.disabled = !running;
}

async function loadSessions() {
  const payload = await api('/api/sessions');
  state.sessions = payload.sessions || [];

  if (!state.activeSessionId) {
    state.activeSessionId = state.sessions[0] ? state.sessions[0].id : '';
  }

  // If previously selected session no longer exists, pick first.
  if (state.activeSessionId && !state.sessions.some((s) => s.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0] ? state.sessions[0].id : '';
  }

  renderSessions();
}

async function createSession() {
  const name = elements.newSessionName.value.trim();
  const payload = await api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });

  elements.newSessionName.value = '';
  await loadSessions();

  if (payload.id) {
    saveActiveSession(payload.id);
    renderSessions();
    // Auto-start new session for QR convenience.
    await startSession();
  }
}

async function startSession() {
  if (!state.activeSessionId) {
    return;
  }
  await api(`/api/sessions/${state.activeSessionId}/start`, { method: 'POST' });
  await loadSessions();
  await loadStatus();
}

async function stopSession() {
  if (!state.activeSessionId) {
    return;
  }
  await api(`/api/sessions/${state.activeSessionId}/stop`, { method: 'POST' });
  await loadSessions();
  await clearSessionUi();
}

async function deleteSession() {
  if (!state.activeSessionId) {
    return;
  }

  const ok = window.confirm('Видалити сесію? За потреби можна видалити дані на диску вручну.');
  if (!ok) {
    return;
  }

  await api(`/api/sessions/${state.activeSessionId}?deleteData=0`, { method: 'DELETE' });
  saveActiveSession('');
  await loadSessions();
  await clearSessionUi();
}

async function apiSession(endpoint, options) {
  if (!state.activeSessionId) {
    throw new Error('Оберіть сесію.');
  }
  return await api(`/api/sessions/${state.activeSessionId}${endpoint}`, options);
}

function selectedChatIdsFromUi() {
  const checked = Array.from(document.querySelectorAll('.source-chat:checked'));
  return checked.map((item) => item.value);
}

function normalizeKeyword(input) {
  return String(input || '')
    .trim()
    .toLowerCase();
}

function addKeywordFromInput() {
  const keyword = normalizeKeyword(elements.keywordInput.value);
  if (!keyword) {
    return;
  }

  const keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];
  if (!keywords.includes(keyword)) {
    state.settings.keywords = [...keywords, keyword];
  }

  elements.keywordInput.value = '';
  renderKeywords();
}

function removeKeyword(keyword) {
  const keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];
  state.settings.keywords = keywords.filter((item) => item !== keyword);
  renderKeywords();
}

function renderStatus() {
  const current = state.status;

  if (!current) {
    elements.statusText.textContent = 'Немає даних';
    return;
  }

  elements.statusText.textContent = statusLabel(current.status);

  if (current.lastError) {
    elements.errorText.classList.remove('hidden');
    elements.errorText.textContent = `Помилка: ${current.lastError}`;
  } else {
    elements.errorText.classList.add('hidden');
    elements.errorText.textContent = '';
  }

  if (current.hasQr && current.qr) {
    elements.qrImage.classList.remove('hidden');
    elements.qrImage.src = current.qr;
    elements.qrHint.textContent = 'Скануйте цей QR-код у мобільному WhatsApp.';
  } else {
    elements.qrImage.classList.add('hidden');
    elements.qrImage.removeAttribute('src');
    elements.qrHint.textContent = current.ready
      ? 'Авторизація завершена.'
      : 'QR зʼявиться автоматично, коли він буде потрібен.';
  }
}

function renderDestinationOptions() {
  const groups = state.chats.filter((chat) => chat.isGroup);
  const options = ['<option value="">Оберіть групу</option>'];

  for (const chat of groups) {
    const selected = state.settings.destinationChatId === chat.id ? 'selected' : '';
    options.push(`<option value="${escapeHtml(chat.id)}" ${selected}>${escapeHtml(chat.name)}</option>`);
  }

  if (groups.length === 0) {
    options.push('<option value="" disabled>Групи недоступні</option>');
  }

  elements.destinationSelect.innerHTML = options.join('');
}

function renderChatList() {
  if (!state.status || !state.status.ready) {
    elements.chatList.innerHTML = '<p class="text-gray-500">Список чатів буде доступний після готовності сесії.</p>';
    return;
  }

  if (state.chats.length === 0) {
    elements.chatList.innerHTML = '<p class="text-gray-500">Чати не знайдені.</p>';
    return;
  }

  const selected = new Set(state.settings.sourceChatIds || []);
  const destinationId = state.settings.destinationChatId || '';

  const html = state.chats
    .map((chat) => {
      const icon = chat.isGroup ? 'fa-user-group' : 'fa-user';
      const isDestination = destinationId && chat.id === destinationId;
      const disabled = isDestination ? 'disabled' : '';
      const checked = !isDestination && selected.has(chat.id) ? 'checked' : '';
      const hint = isDestination
        ? '<span class="text-xs text-gray-500 block mt-1">Кінцева група (джерело вимкнено)</span>'
        : '';

      return `
        <label class="flex items-start gap-3 p-2 rounded-lg hover:bg-gray-50 border border-transparent ${isDestination ? 'opacity-60' : ''}">
          <input class="source-chat mt-1" type="checkbox" value="${escapeHtml(chat.id)}" ${checked} ${disabled} />
          <span class="flex-1">
            <span class="font-medium"><i class="fa-solid ${icon} mr-2 text-gray-500"></i>${escapeHtml(chat.name)}</span>
            <span class="block text-xs text-gray-500 mt-1">${escapeHtml(chat.id)}</span>
            ${hint}
          </span>
        </label>
      `;
    })
    .join('');

  elements.chatList.innerHTML = html;
}

function renderKeywords() {
  const keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];

  if (keywords.length === 0) {
    elements.keywordList.innerHTML = '<p class="text-gray-500">Ключові слова ще не додані.</p>';
    return;
  }

  const html = keywords
    .map(
      (keyword) => `
        <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-gray-300 text-sm">
          ${escapeHtml(keyword)}
          <button type="button" class="remove-keyword text-gray-500 hover:text-red-600" data-keyword="${escapeHtml(keyword)}">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </span>
      `
    )
    .join('');

  elements.keywordList.innerHTML = html;
}

function renderSettings() {
  state.settings.keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];
  renderDestinationOptions();
  renderChatList();
  renderKeywords();

  if (state.settings.enabled) {
    elements.settingsInfo.textContent = 'Моніторинг увімкнений.';
  } else {
    elements.settingsInfo.textContent =
      'Моніторинг вимкнений. Оберіть джерела, додайте ключові слова та вкажіть кінцеву групу.';
  }
}

function renderLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    elements.logList.innerHTML = '<p class="text-gray-500">Події поки відсутні.</p>';
    return;
  }

  const html = logs
    .map((item) => {
      const t = new Date(item.time).toLocaleString('uk-UA');
      return `<p><span class="text-gray-500">[${escapeHtml(t)}]</span> <span class="font-medium">${escapeHtml(
        item.type
      )}</span>: ${escapeHtml(item.text)}</p>`;
    })
    .join('');

  elements.logList.innerHTML = html;
}

async function clearSessionUi() {
  state.status = null;
  state.chats = [];
  state.settings = { sourceChatIds: [], destinationChatId: '', keywords: [], enabled: false };

  elements.statusText.textContent = 'Сесію зупинено або не обрано.';
  elements.errorText.classList.add('hidden');
  elements.qrImage.classList.add('hidden');
  elements.qrImage.removeAttribute('src');
  elements.qrHint.textContent = 'Запустіть сесію. Якщо потрібна авторизація, QR зʼявиться тут.';
  elements.chatList.innerHTML = '<p class="text-gray-500">Список чатів буде доступний після готовності сесії.</p>';
  elements.destinationSelect.innerHTML = '<option value="">Оберіть групу</option>';
  elements.keywordList.innerHTML = '<p class="text-gray-500">Ключові слова ще не додані.</p>';
  elements.settingsInfo.textContent = '';
}

async function loadStatus() {
  try {
    state.status = await apiSession('/status');
    renderStatus();
  } catch (error) {
    state.status = null;
    elements.statusText.textContent = 'Сесія не запущена';
    elements.errorText.classList.remove('hidden');
    elements.errorText.textContent = error.message;
  }
}

async function loadSettings() {
  try {
    state.settings = await apiSession('/settings');
    state.settings.keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];
    renderSettings();
  } catch (error) {
    elements.settingsInfo.textContent = `Не вдалося завантажити налаштування: ${error.message}`;
  }
}

async function loadChats(forceRefresh = false) {
  if (!state.status || !state.status.ready) {
    renderChatList();
    return;
  }

  try {
    const query = forceRefresh ? '?refresh=1' : '';
    const payload = await apiSession(`/chats${query}`);
    state.chats = payload.chats || [];
    renderSettings();
  } catch (error) {
    elements.chatList.innerHTML = `<p class="text-red-600">Не вдалося отримати чати: ${escapeHtml(error.message)}</p>`;
  }
}

async function loadLogs() {
  if (!state.ui.showLogs) {
    return;
  }

  try {
    const payload = await apiSession('/logs');
    renderLogs(payload.logs);
  } catch (error) {
    elements.logList.innerHTML = `<p class="text-red-600">Помилка журналу: ${escapeHtml(error.message)}</p>`;
  }
}

async function saveSettings() {
  const payload = {
    sourceChatIds: selectedChatIdsFromUi(),
    destinationChatId: elements.destinationSelect.value,
    keywords: state.settings.keywords || []
  };

  try {
    state.settings = await apiSession('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    state.settings.keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];
    renderSettings();
    elements.settingsInfo.textContent = state.settings.enabled
      ? 'Налаштування збережено. Моніторинг активний.'
      : 'Налаштування збережено, але моніторинг ще неактивний.';
  } catch (error) {
    elements.settingsInfo.textContent = `Помилка збереження: ${error.message}`;
  }
}

async function onSessionChanged(id) {
  saveActiveSession(id);
  await loadSessions();

  // Try to load status/settings/chats/logs if running.
  await loadStatus();
  await loadSettings();
  await loadChats(true);
  await loadLogs();
}

async function bootstrap() {
  loadUiPreferences();
  renderLogsVisibility();

  await loadSessions();
  renderSessions();

  if (state.activeSessionId) {
    await loadStatus();
    await loadSettings();
    await loadChats(true);
    await loadLogs();
  } else {
    await clearSessionUi();
  }

  setInterval(async () => {
    await loadSessions();
    if (state.activeSessionId) {
      await loadStatus();
      await loadChats(false);
    }
  }, 5000);

  setInterval(loadLogs, 5000);
}

// Session controls

elements.refreshSessionsBtn.addEventListener('click', loadSessions);

elements.sessionSelect.addEventListener('change', async () => {
  const id = elements.sessionSelect.value;
  await onSessionChanged(id);
});

elements.createSessionBtn.addEventListener('click', async () => {
  try {
    await createSession();
  } catch (error) {
    elements.sessionInfo.textContent = `Помилка створення сесії: ${error.message}`;
  }
});

elements.startSessionBtn.addEventListener('click', async () => {
  try {
    await startSession();
  } catch (error) {
    elements.sessionInfo.textContent = `Помилка запуску: ${error.message}`;
  }
});

elements.stopSessionBtn.addEventListener('click', async () => {
  try {
    await stopSession();
  } catch (error) {
    elements.sessionInfo.textContent = `Помилка зупинки: ${error.message}`;
  }
});

elements.deleteSessionBtn.addEventListener('click', async () => {
  try {
    await deleteSession();
  } catch (error) {
    elements.sessionInfo.textContent = `Помилка видалення: ${error.message}`;
  }
});

// Main controls

elements.refreshStatusBtn.addEventListener('click', loadStatus);
elements.refreshChatsBtn.addEventListener('click', () => loadChats(true));
elements.saveSettingsBtn.addEventListener('click', saveSettings);

elements.toggleLogsBtn.addEventListener('click', () => {
  state.ui.showLogs = !state.ui.showLogs;
  saveLogsPref();
  renderLogsVisibility();
});

elements.addKeywordBtn.addEventListener('click', addKeywordFromInput);
elements.keywordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addKeywordFromInput();
  }
});

elements.destinationSelect.addEventListener('change', () => {
  state.settings.destinationChatId = elements.destinationSelect.value;
  renderChatList();
});

elements.keywordList.addEventListener('click', (event) => {
  const button = event.target.closest('.remove-keyword');
  if (!button) {
    return;
  }

  const keyword = button.getAttribute('data-keyword');
  if (!keyword) {
    return;
  }

  removeKeyword(keyword);
});

bootstrap();
