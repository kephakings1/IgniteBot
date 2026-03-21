const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let pool = null;
let localMode = false;
const LOCAL_PATH = path.join(process.cwd(), 'data', 'botsettings.json');

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
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 4000,
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
    console.log('✅ Local settings initialised');
    return;
  }

  const client = await pg.connect();
  console.log('📡 Connecting to PostgreSQL for settings...');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
      );
    `);
    for (const [key, value] of Object.entries(defaultSettings)) {
      await client.query(
        `INSERT INTO bot_settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING;`,
        [key, value]
      );
    }
    console.log('✅ PostgreSQL settings table initialised');
  } catch (err) {
    console.error('❌ Settings DB init error:', err.message);
  } finally {
    client.release();
  }
}

async function getSettings() {
  const pg = _getPool();
  if (!pg) {
    const local = _readLocal();
    return { ...defaultSettings, ...local };
  }
  const client = await pg.connect();
  try {
    const { rows } = await client.query('SELECT key, value FROM bot_settings');
    const result = { ...defaultSettings };
    for (const row of rows) result[row.key] = row.value;
    return result;
  } catch (err) {
    console.error('❌ getSettings error:', err.message);
    return { ...defaultSettings };
  } finally {
    client.release();
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
  const pg = _getPool();
  if (!pg) {
    const local = _readLocal();
    local[key] = value;
    _writeLocal(local);
    return true;
  }
  const client = await pg.connect();
  try {
    await client.query(
      `INSERT INTO bot_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, String(value)]
    );
    return true;
  } catch (err) {
    console.error('❌ updateSetting error:', err.message);
    return false;
  } finally {
    client.release();
  }
}

module.exports = {
  initializeDatabase,
  getSettings,
  getGroupSetting,
  updateSetting,
  defaultSettings,
};
