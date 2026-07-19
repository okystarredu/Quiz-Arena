const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function emptyStore() {
  return {
    meta: { version: 1, createdAt: new Date().toISOString() },
    sets: [],
    sessions: [],
    chats: []
  };
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(emptyStore(), null, 2));
  }
}

function loadStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    parsed.sets ||= [];
    parsed.sessions ||= [];
    parsed.chats ||= [];
    return parsed;
  } catch {
    const backup = `${STORE_FILE}.broken-${Date.now()}`;
    try { fs.copyFileSync(STORE_FILE, backup); } catch {}
    const fresh = emptyStore();
    fs.writeFileSync(STORE_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function saveStore(store) {
  ensureStore();
  const temp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, STORE_FILE);
}

function updateStore(mutator) {
  const store = loadStore();
  const result = mutator(store);
  saveStore(store);
  return result;
}

module.exports = { loadStore, saveStore, updateStore, STORE_FILE };
