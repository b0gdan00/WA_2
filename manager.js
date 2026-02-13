const express = require('express');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MANAGER_DATA_DIR = path.join(__dirname, 'manager-data');
const REGISTRY_FILE = path.join(MANAGER_DATA_DIR, 'sessions.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(MANAGER_DATA_DIR);
ensureDir(SESSIONS_DIR);

const app = express();
app.use(express.json({ limit: '1mb' }));

const registry = {
  sessions: []
};

const runtime = {
  sessions: new Map() // id -> { child, port, status, lastError }
};

function pushManagerLog(text) {
  console.log(`[manager] ${new Date().toISOString()} ${text}`);
}

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) {
    return;
  }

  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const data = JSON.parse(raw);
    registry.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (error) {
    pushManagerLog(`Failed to read registry: ${error.message}`);
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    pushManagerLog(`Failed to write registry: ${error.message}`);
    return false;
  }
}

function createId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `s_${ts}_${rnd}`;
}

function findSession(id) {
  return registry.sessions.find((s) => s.id === id);
}

function sessionDir(id) {
  return path.join(SESSIONS_DIR, id);
}

function ensureSessionOnDisk(id) {
  const dir = sessionDir(id);
  ensureDir(dir);
  ensureDir(path.join(dir, 'data'));
  ensureDir(path.join(dir, 'logs'));
  return dir;
}

function maybeMigrateLegacySingleSession() {
  // Best-effort: if no sessions exist and legacy data/settings.json exists,
  // create a default session and copy settings + auth.
  if (registry.sessions.length > 0) {
    return;
  }

  const legacySettings = path.join(__dirname, 'data', 'settings.json');
  const legacyAuth = path.join(__dirname, '.wwebjs_auth');

  if (!fs.existsSync(legacySettings) && !fs.existsSync(legacyAuth)) {
    return;
  }

  const id = 'default';
  const name = 'Default';
  registry.sessions.push({ id, name, createdAt: new Date().toISOString() });
  saveRegistry();

  const dir = ensureSessionOnDisk(id);

  try {
    if (fs.existsSync(legacySettings)) {
      const dst = path.join(dir, 'data', 'settings.json');
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(legacySettings, dst);
      }
    }
  } catch (error) {
    pushManagerLog(`Legacy settings migrate failed: ${error.message}`);
  }

  try {
    if (fs.existsSync(legacyAuth)) {
      const dst = path.join(dir, '.wwebjs_auth');
      if (!fs.existsSync(dst)) {
        // Can be large; copy only if not present.
        fs.cpSync(legacyAuth, dst, { recursive: true });
      }
    }
  } catch (error) {
    pushManagerLog(`Legacy auth migrate failed: ${error.message}`);
  }

  pushManagerLog('Legacy single-session migrated to sessions/default (best-effort).');
}

loadRegistry();
maybeMigrateLegacySingleSession();

function getRuntime(id) {
  if (!runtime.sessions.has(id)) {
    runtime.sessions.set(id, { child: null, port: null, status: 'stopped', lastError: null });
  }
  return runtime.sessions.get(id);
}

async function startWorker(id) {
  const s = findSession(id);
  if (!s) {
    throw new Error('Session not found');
  }

  const r = getRuntime(id);
  if (r.child) {
    return;
  }

  r.status = 'starting';
  r.lastError = null;
  r.port = null;

  const dir = ensureSessionOnDisk(id);

  const child = fork(path.join(__dirname, 'worker.js'), [], {
    env: {
      ...process.env,
      SESSION_ID: id,
      SESSION_DIR: dir,
      WORKER_HOST: '127.0.0.1',
      WORKER_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  r.child = child;

  child.stdout.on('data', (buf) => {
    pushManagerLog(`[${id}] ${String(buf).trim()}`);
  });

  child.stderr.on('data', (buf) => {
    pushManagerLog(`[${id}][err] ${String(buf).trim()}`);
  });

  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Worker start timeout'));
    }, 30000);

    function cleanup() {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }

    function onMessage(msg) {
      if (msg && msg.type === 'listening' && msg.port) {
        cleanup();
        resolve(msg.port);
      }
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`Worker exited early (code=${code})`));
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
  });

  r.port = ready;
  r.status = 'running';

  child.on('exit', (code, signal) => {
    const rt = getRuntime(id);
    rt.child = null;
    rt.port = null;
    rt.status = 'stopped';
    rt.lastError = code === 0 ? null : `Exited (code=${code}, signal=${signal || ''})`;
    pushManagerLog(`Session ${id} stopped: ${rt.lastError || 'ok'}`);
  });
}

async function stopWorker(id) {
  const r = getRuntime(id);
  if (!r.child) {
    return;
  }

  r.status = 'stopping';

  const child = r.child;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 15000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });

  r.child = null;
  r.port = null;
  r.status = 'stopped';
}

async function proxyJson(id, endpoint, req, res) {
  const r = getRuntime(id);
  if (!r.child || !r.port) {
    return res.status(409).json({ error: 'Сесія не запущена.' });
  }

  const url = `http://127.0.0.1:${r.port}${endpoint}`;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {})
    });

    const json = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(json);
  } catch (error) {
    return res.status(502).json({ error: `Не вдалося звернутися до воркера: ${error.message}` });
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sessions', (_, res) => {
  const data = registry.sessions.map((s) => {
    const r = getRuntime(s.id);
    return {
      ...s,
      runtime: {
        status: r.status,
        port: r.port,
        lastError: r.lastError,
        pid: r.child ? r.child.pid : null
      }
    };
  });

  res.json({ sessions: data });
});

app.post('/api/sessions', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const id = createId();

  registry.sessions.push({
    id,
    name: name || id,
    createdAt: new Date().toISOString()
  });

  ensureSessionOnDisk(id);
  saveRegistry();

  res.json({ id });
});

app.post('/api/sessions/:id/start', async (req, res) => {
  const id = req.params.id;
  if (!findSession(id)) {
    return res.status(404).json({ error: 'Сесію не знайдено.' });
  }

  try {
    await startWorker(id);
    return res.json({ ok: true });
  } catch (error) {
    const r = getRuntime(id);
    r.lastError = error.message;
    r.status = 'error';
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:id/stop', async (req, res) => {
  const id = req.params.id;
  if (!findSession(id)) {
    return res.status(404).json({ error: 'Сесію не знайдено.' });
  }

  await stopWorker(id);
  return res.json({ ok: true });
});

app.delete('/api/sessions/:id', async (req, res) => {
  const id = req.params.id;
  const idx = registry.sessions.findIndex((s) => s.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Сесію не знайдено.' });
  }

  await stopWorker(id);

  registry.sessions.splice(idx, 1);
  saveRegistry();

  // Optional: delete data on disk if ?deleteData=1
  if (req.query.deleteData === '1') {
    try {
      fs.rmSync(sessionDir(id), { recursive: true, force: true });
    } catch (error) {
      return res.status(500).json({ error: `Не вдалося видалити дані сесії: ${error.message}` });
    }
  }

  return res.json({ ok: true });
});

// Proxy endpoints for selected session
app.get('/api/sessions/:id/status', (req, res) => proxyJson(req.params.id, '/api/status', req, res));
app.get('/api/sessions/:id/settings', (req, res) => proxyJson(req.params.id, '/api/settings', req, res));
app.post('/api/sessions/:id/settings', (req, res) => proxyJson(req.params.id, '/api/settings', req, res));
app.get('/api/sessions/:id/logs', (req, res) => proxyJson(req.params.id, '/api/logs', req, res));
app.get('/api/sessions/:id/chats', async (req, res) => {
  const id = req.params.id;
  const r = getRuntime(id);
  if (!r.child || !r.port) {
    return res.status(409).json({ error: 'Сесія не запущена.' });
  }

  const query = req.query.refresh === '1' ? '?refresh=1' : '';
  return proxyJson(id, `/api/chats${query}`, req, res);
});

app.listen(PORT, HOST, () => {
  const bind = HOST || '0.0.0.0';
  const urlHost = bind === '0.0.0.0' ? '<SERVER_IP>' : bind;
  pushManagerLog(`Manager started: http://${urlHost}:${PORT} (bind=${bind})`);
});

process.on('SIGTERM', async () => {
  for (const s of registry.sessions) {
    await stopWorker(s.id);
  }
  process.exit(0);
});
process.on('SIGINT', async () => {
  for (const s of registry.sessions) {
    await stopWorker(s.id);
  }
  process.exit(0);
});
