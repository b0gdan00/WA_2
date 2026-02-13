const elements = {
  refreshSessionsBtn: document.getElementById('refreshSessionsBtn'),
  sessionsTableBody: document.getElementById('sessionsTableBody'),
  newSessionName: document.getElementById('newSessionName'),
  createSessionBtn: document.getElementById('createSessionBtn'),
  sessionInfo: document.getElementById('sessionInfo'),

  statusText: document.getElementById('statusText'),
  statusAlert: document.getElementById('statusAlert'),
  errorText: document.getElementById('errorText'),
  qrImage: document.getElementById('qrImage'),
  qrHint: document.getElementById('qrHint'),

  chatList: document.getElementById('chatList'),
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

let autoSaveTimer = null;
let autoSaveInFlight = false;
let autoSavePending = false;

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
    starting: 'Запуск...',
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
  const body = elements.sessionsTableBody;
  if (!body) {
    return;
  }

  const sessions = Array.isArray(state.sessions) ? state.sessions : [];

  if (sessions.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="3" class="px-3 py-4 text-center text-sm text-gray-500">
          Немає сесій. Створіть нову, щоб почати.
        </td>
      </tr>
    `;
    elements.sessionInfo.textContent = 'Створіть сесію, щоб почати.';
    return;
  }

  const rows = sessions
    .map((s) => {
      const rt = s.runtime || {};
      const selected = s.id === state.activeSessionId;
      const rowClasses = `border-b border-gray-100 ${
        selected ? 'bg-blue-50' : 'bg-white'
      } transition-colors duration-150`;
      const statusKey = (rt && rt.status) || 'stopped';
      const statusText = escapeHtml(sessionLabel(rt));
      const startDisabled = Boolean(rt && rt.status === 'running');
      const stopDisabled = !(rt && rt.status === 'running');

      const statusBadgeClasses = badgeClassForStatus(statusKey);
      const statusSpinner =
        statusKey === 'starting'
          ? '<i class="fas fa-spinner fa-spin text-indigo-500"></i>'
          : '';
      const statusCell = `
        <span class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClasses}">
          ${statusSpinner}
          <span>${statusText}</span>
        </span>
      `;

      return `
        <tr data-session-id="${escapeHtml(s.id)}" class="${rowClasses} cursor-pointer">
          <td class="px-3 py-3 text-left">
            <div class="font-medium text-gray-800">${escapeHtml(s.name || s.id)}</div>
            <div class="text-xs text-gray-500">${escapeHtml(s.id)}</div>
          </td>
          <td class="px-3 py-3 text-right text-sm text-gray-700">${statusCell}</td>
          <td class="px-3 py-3 text-right">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                data-action="start"
                data-session-id="${escapeHtml(s.id)}"
                class="bg-blue-600 hover:bg-blue-700 text-white py-2 px-3 rounded-md text-sm font-medium flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none"
                ${startDisabled ? 'disabled' : ''}
              >
                <i class="fas fa-play"></i>
                <span>Запустити</span>
              </button>
              <button
                type="button"
                data-action="stop"
                data-session-id="${escapeHtml(s.id)}"
                class="bg-gray-100 hover:bg-gray-200 text-gray-800 p-2 rounded-md text-sm font-medium flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none border border-gray-300"
                ${stopDisabled ? 'disabled' : ''}
                title="Зупинити"
              >
                <i class="fas fa-stop"></i>
                <span class="sr-only">Зупинити</span>
              </button>
              <button
                type="button"
                data-action="delete"
                data-session-id="${escapeHtml(s.id)}"
                class="bg-red-100 hover:bg-red-200 text-red-700 p-2 rounded-md text-sm font-medium flex items-center justify-center focus:outline-none border border-red-200"
                title="Видалити сесію"
              >
                <i class="fas fa-trash"></i>
                <span class="sr-only">Видалити сесію</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  body.innerHTML = rows;
  updateSessionInfoText();
}

function updateSessionInfoText() {
  const s = activeSession();
  if (!s) {
    elements.sessionInfo.textContent = 'Оберіть сесію або створіть нову.';
    return;
  }

  const runtime = state.status || s.runtime || null;
  state.sessionRuntime = runtime;
  const pid = runtime && runtime.pid ? `pid=${runtime.pid}` : 'pid=-';
  const err = runtime && runtime.lastError ? `, помилка: ${runtime.lastError}` : '';
  const statusLabelText = runtime ? sessionLabel(runtime) : 'Невідомо';
  const name = escapeHtml(s.name || s.id);
  const sessionId = escapeHtml(s.id);
  elements.sessionInfo.innerHTML = `
    <span class="font-semibold text-gray-800 block">Назва: ${name}</span>
    <span class="text-sm text-gray-600 block">Сесія: ${sessionId}, стан: ${statusLabelText} (${pid})${err}</span>
  `;
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

async function startSession(id = state.activeSessionId) {
  if (!id) {
    return;
  }

  saveActiveSession(id);
  await api(`/api/sessions/${id}/start`, { method: 'POST' });
  await loadSessions();
  await loadStatus();
}

async function stopSession(id = state.activeSessionId) {
  if (!id) {
    return;
  }

  saveActiveSession(id);
  await api(`/api/sessions/${id}/stop`, { method: 'POST' });
  await loadSessions();
  await clearSessionUi();
}

async function deleteSession(id = state.activeSessionId) {
  if (!id) {
    return;
  }

  const ok = window.confirm('Видалити сесію? За потреби можна видалити дані на диску вручну.');
  if (!ok) {
    return;
  }

  await api(`/api/sessions/${id}?deleteData=0`, { method: 'DELETE' });
  const wasActive = id === state.activeSessionId;
  if (wasActive) {
    saveActiveSession('');
  }
  await loadSessions();

  if (wasActive) {
    await clearSessionUi();
  }
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
  const changed = !keywords.includes(keyword);
  if (changed) {
    state.settings.keywords = [...keywords, keyword];
  }

  elements.keywordInput.value = '';
  renderKeywords();
  if (changed) {
    scheduleAutoSave();
  }
}

function removeKeyword(keyword) {
  const keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];
  const changed = keywords.includes(keyword);
  state.settings.keywords = keywords.filter((item) => item !== keyword);
  renderKeywords();
  if (changed) {
    scheduleAutoSave();
  }
}

function badgeClassForStatus(status) {
  const map = {
    starting: 'bg-indigo-100 text-indigo-700',
    running: 'bg-emerald-100 text-emerald-700',
    ready: 'bg-emerald-100 text-emerald-700',
    authenticated: 'bg-amber-100 text-amber-700',
    qr: 'bg-sky-100 text-sky-700',
    auth_failure: 'bg-red-100 text-red-700',
    disconnected: 'bg-rose-100 text-rose-700',
    init_error: 'bg-red-100 text-red-700',
    stopped: 'bg-gray-100 text-gray-600',
    error: 'bg-rose-100 text-rose-700'
  };
  return map[status] || 'bg-gray-100 text-gray-600';
}

function renderStatus() {
  const current = state.status;

  if (!current) {
    elements.statusText.textContent = 'Немає даних';
    elements.sessionInfo.textContent = 'Оберіть сесію або створіть нову.';
    elements.statusAlert?.classList.add('hidden');
    return;
  }

  const label = statusLabel(current.status);
  const badgeClasses = badgeClassForStatus(current.status);
  const spinner =
    current.status === 'starting'
      ? '<i class="fas fa-spinner fa-spin text-indigo-500"></i>'
      : '';
  elements.statusText.innerHTML = `
    <span class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${badgeClasses}">
      ${spinner}
      <span>${label}</span>
    </span>
  `;

  if (current.lastError) {
    elements.statusAlert?.classList.remove('hidden');
    elements.errorText.textContent = `Помилка: ${current.lastError}`;
  } else {
    elements.statusAlert?.classList.add('hidden');
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
  updateSessionInfoText();
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
    elements.keywordList.innerHTML = `
      <p class="mx-auto rounded-xl border border-dashed border-gray-200 bg-white p-6 text-center text-sm text-gray-500 italic">
        Ключові слова ще не додані.
      </p>
    `;
    return;
  }

  const html = keywords
    .map(
      (keyword) => `
        <span
          data-keyword="${escapeHtml(keyword)}"
          class="inline-flex items-center px-3 py-1 rounded-md bg-blue-50 text-blue-800 text-sm font-semibold cursor-pointer hover:bg-blue-100 active:bg-blue-200"
        >
          ${escapeHtml(keyword)}
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

function buildAlert(message) {
  return `<div class="bg-red-50 border border-red-200 text-red-700 rounded-md px-3 py-2 text-sm">${message}</div>`;
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
  elements.statusAlert?.classList.add('hidden');
  elements.qrImage.classList.add('hidden');
  elements.qrImage.removeAttribute('src');
  elements.qrHint.textContent = 'Запустіть сесію. Якщо потрібна авторизація, QR зʼявиться тут.';
  elements.sessionInfo.textContent = 'Оберіть сесію або створіть нову.';
  elements.chatList.innerHTML = '<p class="text-gray-500">Список чатів буде доступний після готовності сесії.</p>';
  elements.destinationSelect.innerHTML = '<option value="">Оберіть групу</option>';
  elements.keywordList.innerHTML = '<p class="text-gray-500">Ключові слова ще не додані.</p>';
  elements.settingsInfo.textContent = '';
}

async function loadStatus() {
  if (!state.activeSessionId) {
    state.status = null;
    renderStatus();
    return;
  }

  const session = state.sessions.find((s) => s.id === state.activeSessionId);
  const runtime = session ? session.runtime || {} : {};

  if (!runtime || (runtime.status && runtime.status !== 'running')) {
    state.status = {
      status: runtime.status || 'stopped',
      lastError: runtime.lastError || null,
      ready: false
    };
    renderStatus();
    return;
  }

  try {
    state.status = await apiSession('/status');
    renderStatus();
  } catch (error) {
    state.status = {
      status: runtime.status || 'running',
      lastError: error.message,
      ready: false
    };
    renderStatus();
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
    elements.chatList.innerHTML = buildAlert(`Не вдалося отримати чати: ${escapeHtml(error.message)}`);
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
    elements.logList.innerHTML = buildAlert(`Помилка журналу: ${escapeHtml(error.message)}`);
  }
}

function scheduleAutoSave() {
  if (!state.activeSessionId) {
    return;
  }

  autoSavePending = true;

  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
  }

  autoSaveTimer = setTimeout(async () => {
    if (autoSaveInFlight) {
      return;
    }

    autoSaveInFlight = true;
    try {
      // Coalesce bursts of changes into minimal number of save calls.
      while (autoSavePending) {
        autoSavePending = false;
        await saveSettings({ auto: true });
      }
    } finally {
      autoSaveInFlight = false;
    }
  }, 600);
}

async function saveSettings(options = {}) {
  const payload = {
    sourceChatIds: selectedChatIdsFromUi(),
    destinationChatId: elements.destinationSelect.value,
    keywords: state.settings.keywords || []
  };

  try {
    if (options.auto) {
      elements.settingsInfo.textContent = 'Автозбереження...';
    }

    state.settings = await apiSession('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    state.settings.keywords = Array.isArray(state.settings.keywords) ? state.settings.keywords : [];
    renderSettings();
    if (options.auto) {
      elements.settingsInfo.textContent = state.settings.enabled
        ? 'Автозбережено. Моніторинг активний.'
        : 'Автозбережено, але моніторинг ще неактивний.';
    } else {
      elements.settingsInfo.textContent = state.settings.enabled
        ? 'Налаштування збережено. Моніторинг активний.'
        : 'Налаштування збережено, але моніторинг ще неактивний.';
    }
  } catch (error) {
    elements.settingsInfo.textContent = options.auto
      ? `Помилка автозбереження: ${error.message}`
      : `Помилка збереження: ${error.message}`;
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

if (elements.sessionsTableBody) {
  elements.sessionsTableBody.addEventListener('click', async (event) => {
    const actionButton = event.target.closest('button[data-action]');
    if (actionButton) {
      const action = actionButton.getAttribute('data-action');
      const sessionId = actionButton.getAttribute('data-session-id');
      if (!sessionId) {
        return;
      }

      try {
        if (action === 'start') {
          await startSession(sessionId);
        } else if (action === 'stop') {
          await stopSession(sessionId);
        } else if (action === 'delete') {
          await deleteSession(sessionId);
        }
      } catch (error) {
        const labelMap = { start: 'запуску', stop: 'зупинки', delete: 'видалення' };
        const label = labelMap[action] || 'дії';
        elements.sessionInfo.textContent = `Помилка ${label} сесії: ${error.message}`;
      }
      return;
    }

    const row = event.target.closest('tr[data-session-id]');
    if (!row) {
      return;
    }

    const sessionId = row.getAttribute('data-session-id');
    if (!sessionId || sessionId === state.activeSessionId) {
      return;
    }

    try {
      await onSessionChanged(sessionId);
    } catch (error) {
      elements.sessionInfo.textContent = `Помилка перемикання: ${error.message}`;
    }
  });
}

elements.createSessionBtn.addEventListener('click', async () => {
  try {
    await createSession();
  } catch (error) {
    elements.sessionInfo.textContent = `Помилка створення сесії: ${error.message}`;
  }
});

// Main controls

elements.refreshChatsBtn.addEventListener('click', () => loadChats(true));
elements.saveSettingsBtn.addEventListener('click', () => saveSettings({ auto: false }));

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
  scheduleAutoSave();
});

elements.chatList.addEventListener('change', (event) => {
  const target = event.target;
  if (!target || !target.classList || !target.classList.contains('source-chat')) {
    return;
  }
  scheduleAutoSave();
});

elements.keywordList.addEventListener('click', (event) => {
  const tag = event.target.closest('[data-keyword]');
  if (!tag) {
    return;
  }

  const keyword = tag.getAttribute('data-keyword');
  if (!keyword) {
    return;
  }

  removeKeyword(keyword);
});

bootstrap();
