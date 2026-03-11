const cache = new Map();
let pool = null;
let ready = false;
let dbAvailable = false;

async function init() {
  if (ready) return;

  if (!process.env.DATABASE_URL) {
    console.log("🗄️  No DATABASE_URL — running with in-memory storage only");
    ready = true;
    return;
  }

  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: !process.env.DATABASE_URL.includes("localhost") && !process.env.DATABASE_URL.includes("127.0.0.1")
        ? { rejectUnauthorized: false }
        : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 4000,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_data (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bot_analytics (
        id SERIAL PRIMARY KEY,
        jid TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_created ON bot_analytics(created_at);
      CREATE INDEX IF NOT EXISTS idx_analytics_jid ON bot_analytics(jid);
      CREATE INDEX IF NOT EXISTS idx_analytics_command ON bot_analytics(command) WHERE command IS NOT NULL;
    `);

    const { rows } = await pool.query("SELECT key, value FROM bot_data");
    for (const row of rows) {
      cache.set(row.key, row.value);
    }

    dbAvailable = true;
    ready = true;
    console.log(`🗄️  PostgreSQL connected — loaded ${rows.length} data records`);
  } catch (err) {
    console.log(`🗄️  PostgreSQL unavailable (${err.message.split("\n")[0]}) — using in-memory storage`);
    pool = null;
    dbAvailable = false;
    ready = true;
  }
}

function _persist(name, data) {
  if (!dbAvailable || !pool) return;
  pool.query(
    `INSERT INTO bot_data (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [name, JSON.stringify(data)]
  ).catch(() => {});
}

function read(name, defaults = {}) {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(JSON.stringify(defaults)));
  }
  return cache.get(name);
}

function write(name, data) {
  cache.set(name, data);
  _persist(name, data);
}

function update(name, defaults, updater) {
  const data = read(name, defaults);
  updater(data);
  write(name, data);
}

async function trackEvent(jid, action, command = null) {
  if (!dbAvailable || !pool) return;
  pool.query(
    "INSERT INTO bot_analytics (jid, action, command) VALUES ($1, $2, $3)",
    [jid, action, command]
  ).catch(() => {});
}

async function getAnalyticsStats() {
  if (!dbAvailable || !pool) return null;
  try {
    const [totals, topCmds, uniqueUsers, hourly, recent] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total_messages, COUNT(command) AS total_commands FROM bot_analytics"),
      pool.query(`SELECT command, COUNT(*) AS cnt FROM bot_analytics WHERE command IS NOT NULL GROUP BY command ORDER BY cnt DESC LIMIT 10`),
      pool.query("SELECT COUNT(DISTINCT jid) AS unique_users FROM bot_analytics"),
      pool.query(`SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24') AS hour, COUNT(*) AS cnt FROM bot_analytics WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY hour ORDER BY hour`),
      pool.query(`SELECT jid, action, command, created_at FROM bot_analytics ORDER BY created_at DESC LIMIT 50`),
    ]);
    return {
      totalMessages: parseInt(totals.rows[0].total_messages),
      totalCommands: parseInt(totals.rows[0].total_commands),
      uniqueUsers: parseInt(uniqueUsers.rows[0].unique_users),
      topCommands: topCmds.rows.map((r) => [r.command, parseInt(r.cnt)]),
      hourlyStats: hourly.rows.map((r) => [r.hour, parseInt(r.cnt)]),
      recentActivity: recent.rows.map((r) => ({
        time: r.created_at,
        user: r.jid.split("@")[0],
        action: r.command || r.action,
      })),
    };
  } catch {
    return null;
  }
}

module.exports = { init, read, write, update, trackEvent, getAnalyticsStats };
