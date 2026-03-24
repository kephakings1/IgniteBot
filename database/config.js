const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let pool = null;
let localMode = false;
const LOCAL_PATH = path.join(process.cwd(), 'data', 'botsettings.json');

// ── In-memory cache ───────────────────────────────────────────────────────────
// Populated once at initializeDatabase() so that transient DB connectivity
// issues on Heroku never block startnexus() on reconnect attempts.
// getSettings() returns the cache if the DB call fails instead of throwing.
let _settingsCache = null;

const defaultSettings = {
  antilink:   'on',
  antilinkall:'off',
  autobio:    'off',
  antidelete: 'on',
  antitag:    'on',
  antibot:    'off',
  anticall:   'off',
  badword:    'on',
  gptdm:      'off',
  welcome:    'off',
  autoread:   'off',
  mode:       'public',
  prefix:     '.',
  autolike:   'on',
  autoview:   'on',
  wapresence: 'online'
};

function _getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 60000,       // keep idle connections alive longer on Heroku
      connectionTimeoutMillis: 8000,  // give Heroku's shared PG more time to respond
    });
    pool.on('error', (err) => {
      // Swallow pool-level errors so the process doesn't crash on idle connection drops
      console.warn('[settings-pool] idle client error (ignored):', err.message);
    });
  }
  return pool;
}

function _readLocal() {
  try {
    if (fs.existsSync(LOCAL_PATH)) {
      return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function _writeLocal(data) {
  try {
    fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

async function initializeDatabase() {
  const pg = _getPool();
  if (!pg) {
    console.log('📁 No DATABASE_URL — using local file for settings');
    localMode = true;
    const existing = _readLocal();
    const merged = { ...defaultSettings, ...existing };
    _writeLocal(merged);
    _settingsCache = merged;
    console.log('✅ Local settings initialised');
    return;
  }

  console.log('📡 Connecting to PostgreSQL for settings...');
  try {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
      );
    `);
    for (const [key, value] of Object.entries(defaultSettings)) {
      await pg.query(
        `INSERT INTO bot_settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING;`,
        [key, value]
      );
    }
    // Warm the in-memory cache from the DB
    const { rows } = await pg.query('SELECT key, value FROM bot_settings');
    const loaded = { ...defaultSettings };
    for (const row of rows) loaded[row.key] = row.value;
    _settingsCache = loaded;
    console.log('✅ PostgreSQL settings table initialised');
  } catch (err) {
    console.error('❌ Settings DB init error:', err.message);
    // Fall back to local file so bot can still start
    const existing = _readLocal();
    _settingsCache = { ...defaultSettings, ...existing };
  }
}

async function getSettings() {
  const pg = _getPool();

  // ── Local / no-DB mode ────────────────────────────────────────────────────
  if (!pg) {
    const local = _readLocal();
    const result = { ...defaultSettings, ...local };
    _settingsCache = result;
    return result;
  }

  // ── If the cache is already populated, return it immediately ─────────────
  // This means any DB connectivity issue on reconnect retries does NOT block
  // startnexus() — it just uses the last-known good settings.
  if (_settingsCache) {
    // Refresh from DB in the background so the cache stays current
    pg.query('SELECT key, value FROM bot_settings').then(({ rows }) => {
      const refreshed = { ...defaultSettings };
      for (const row of rows) refreshed[row.key] = row.value;
      _settingsCache = refreshed;
    }).catch(() => {});  // silently ignore — stale cache is better than an error
    return _settingsCache;
  }

  // ── First call before initializeDatabase() cached data (unusual) ─────────
  try {
    const { rows } = await pg.query('SELECT key, value FROM bot_settings');
    const result = { ...defaultSettings };
    for (const row of rows) result[row.key] = row.value;
    _settingsCache = result;
    return result;
  } catch (err) {
    console.error('❌ getSettings error:', err.message);
    return _settingsCache ?? { ...defaultSettings };
  }
}

async function getGroupSetting(jid) {
  const all = await getSettings();
  return {
    antidelete: all.antidelete === 'on',
    antilink:   all.antilink === 'on',
    welcome:    all.welcome === 'on',
    antitag:    all.antitag === 'on',
  };
}

async function updateSetting(key, value) {
  // Update cache immediately so reads after this don't need to hit the DB
  if (_settingsCache) _settingsCache[key] = String(value);

  const pg = _getPool();
  if (!pg) {
    const local = _readLocal();
    local[key] = value;
    _writeLocal(local);
    return true;
  }
  try {
    await pg.query(
      `INSERT INTO bot_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, String(value)]
    );
    return true;
  } catch (err) {
    console.error('❌ updateSetting error:', err.message);
    return false;
  }
}

module.exports = {
  initializeDatabase,
  getSettings,
  getGroupSetting,
  updateSetting,
  defaultSettings,
};
