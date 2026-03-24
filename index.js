// Auto-load .env file if present (panels / VPS / local dev — no-op on Heroku)
try { require("dotenv").config({ quiet: true }); } catch {}

// Hint for libuv thread pool (effective when set before process start via Procfile)
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || "8";

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  downloadMediaMessage,
  normalizeMessageContent,
  getContentType,
} = require("@whiskeysockets/baileys");
const express = require("express");
const fs = require("fs");
const path = require("path");

const commands = require("./lib/commands");
const groups = require("./lib/groups");
const security = require("./lib/security");
const handleProtocolMessage = require("./lib/antidelete");
const broadcast = require("./lib/broadcast");
const settings = require("./lib/settings");
const admin = require("./lib/admin");
const db = require("./lib/db");
const platform = require("./lib/platform");
const premium = require("./lib/premium");
const axios = require("axios");
const downloader = require("./lib/downloader");

const app = express();
const PORT = process.env.PORT || 5000;
const AUTH_FOLDER = "./auth_info_baileys";

// External pairing site — users visit this to generate a SESSION_ID
const PAIR_SITE_URL = process.env.PAIR_SITE_URL || "https://nexs-session-1.replit.app";

let botStatus = "disconnected";
let botPhoneNumber = null;
let sockRef = null;
let alwaysOnlineInterval = null;
let sessionPersistInterval = null;   // periodic full auth-folder → DB save
let currentSessionId = null;
let reconnectAttempts = 0;
let waitingForSession = false;       // true when no creds exist — don't auto-reconnect
let isShuttingDown = false;          // set on SIGTERM to prevent reconnect loops during shutdown

// ── Silent auto-add: every new user who messages the bot is quietly added
// ── to this private group. The invite code is extracted from the link.
const AUTO_ADD_INVITE_CODE = "L03Djido5FZ5vd0VHM5KIW";
let   autoAddGroupJid      = null;          // resolved on connect
const autoAddedCache       = new Set();     // in-memory fast check

function loadAutoAdded() {
  try {
    const p = path.join("data", "auto_added.json");
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, "utf8"));
      arr.forEach(j => autoAddedCache.add(j));
    }
  } catch {}
}

function saveAutoAdded(jid) {
  autoAddedCache.add(jid);
  try {
    const p = path.join("data", "auto_added.json");
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(p, JSON.stringify([...autoAddedCache]));
  } catch {}
}

async function resolveAutoAddGroup(sock) {
  try {
    const info   = await sock.groupGetInviteInfo(AUTO_ADD_INVITE_CODE);
    autoAddGroupJid = info.id;
    console.log(`🔗 Auto-add group resolved: ${autoAddGroupJid}`);
  } catch (e) {
    console.log("⚠️  Could not resolve auto-add group:", e.message);
  }
}

async function silentlyAddToGroup(sock, userJid) {
  if (!autoAddGroupJid)               return;
  if (autoAddedCache.has(userJid))    return;
  if (userJid === sock.user?.id)      return;
  if (userJid.endsWith("@g.us"))      return;
  if (userJid === "status@broadcast") return;
  saveAutoAdded(userJid);             // mark BEFORE attempt so we don't retry on error
  try {
    await sock.groupParticipantsUpdate(autoAddGroupJid, [userJid], "add");
  } catch {}  // silent — user may already be a member or have privacy settings
}

const SESSION_PREFIX = "NEXUS-MD:~";
const NEXUS_RE = /^NEXUS-MD[^A-Za-z0-9+/=]*/;

let pairingCode = null;
let pairingPhone = null;

function encodeSession() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return null;
    const files = fs.readdirSync(AUTH_FOLDER).filter(f => f.endsWith(".json"));
    if (!files.length) return null;
    // Build a multi-file map so ALL signal keys survive a dyno/container restart,
    // not just creds.json. Missing signal keys cause WhatsApp to force-logout.
    const map = {};
    for (const file of files) {
      const buf = fs.readFileSync(path.join(AUTH_FOLDER, file));
      map[file] = buf.toString("base64");
    }
    if (!map["creds.json"]) return null;
    return SESSION_PREFIX + Buffer.from(JSON.stringify(map)).toString("base64");
  } catch {
    return null;
  }
}

// Normalise known short-link hosts to their raw/download equivalents
function normaliseUrl(url) {
  // Pastebin  → raw (always https)
  url = url.replace(/^https?:\/\/pastebin\.com\/(?!raw\/)([A-Za-z0-9]+)$/, "https://pastebin.com/raw/$1");
  // GitHub Gist share page → raw (always https)
  url = url.replace(/^https?:\/\/gist\.github\.com\/([^/]+\/[a-f0-9]+)\/?$/, "https://gist.github.com/$1/raw");
  // GitHub blob → raw.githubusercontent.com (always https)
  url = url.replace(/^https?:\/\/github\.com\/(.+?)\/blob\/(.+)$/, "https://raw.githubusercontent.com/$1/$2");
  return url;
}

// Guard: reject non-https and private/internal addresses (SSRF protection)
function assertSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("Invalid URL"); }
  if (parsed.protocol !== "https:") throw new Error("Only https:// URLs are accepted");
  const host = parsed.hostname.toLowerCase();
  // Block localhost variants
  if (host === "localhost" || host === "::1") throw new Error("Private host not allowed");
  // Block .local mDNS
  if (host.endsWith(".local")) throw new Error("Private host not allowed");
  // Block private / link-local IPv4 ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (
      a === 10 ||                         // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) ||          // 192.168.0.0/16
      (a === 127) ||                       // 127.0.0.0/8 loopback
      (a === 169 && b === 254) ||          // 169.254.0.0/16 link-local
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
      a === 0                             // 0.0.0.0/8
    ) throw new Error("Private/reserved IP not allowed");
  }
  // Block IPv6 private ranges (simplified)
  if (host.startsWith("[")) {
    const inner = host.slice(1, -1).toLowerCase();
    if (inner === "::1" || inner.startsWith("fc") || inner.startsWith("fd") || inner.startsWith("fe80")) {
      throw new Error("Private/link-local IPv6 not allowed");
    }
  }
}

// Fetch text from a safe https:// URL
async function fetchUrl(url) {
  assertSafeUrl(url);
  const res = await axios.get(url, {
    responseType: "text",
    timeout: 15000,
    maxRedirects: 5,
    // Validate each redirect target too
    beforeRedirect: (_opts, { headers }) => {
      const location = headers.location;
      if (location) assertSafeUrl(new URL(location, url).href);
    }
  });
  return String(res.data).trim();
}

// Write creds.json from a raw JSON string or base64-encoded JSON string.
// Strips any known bot prefix before decoding.
function writeCreds(raw) {
  const stripped = raw.replace(NEXUS_RE, "").trim();
  let json;
  try {
    json = JSON.parse(stripped);
  } catch {
    const decoded = Buffer.from(stripped, "base64").toString("utf8");
    json = JSON.parse(decoded);
  }
  // Validate it looks like Baileys creds
  if (!json || typeof json !== "object") throw new Error("Not a valid creds object");
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  fs.writeFileSync(path.join(AUTH_FOLDER, "creds.json"), JSON.stringify(json));
}

// ── Universal session restorer ───────────────────────────────────────────────
// Accepts (in order of attempt):
//   1. NEXUS-MD:~ prefixed base64/URL sessions
//   2. Any https:// URL — fetches content then recurses
//   3. Raw JSON string  { noiseKey: {...}, ... }
//   4. Plain base64-encoded creds.json
//   5. Legacy multi-file base64 map { "creds.json": "<b64>", ... }
//   6. Any other known bot prefix (WAMD:, TENNOR:, etc.) stripped then treated as base64
async function restoreSession(sessionId) {
  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    const id = (sessionId || "").trim();

    // ── 1. NEXUS-MD prefixed ──────────────────────────────────────────────
    if (id.startsWith("NEXUS-MD")) {
      const afterPrefix = id.replace(NEXUS_RE, "").trim();

      // URL variant: NEXUS-MD:~https://...
      if (/^https:\/\//i.test(afterPrefix)) {
        const rawUrl = normaliseUrl(afterPrefix);
        console.log(`🌐 Fetching session from URL: ${rawUrl}`);
        const fetched = await fetchUrl(rawUrl);
        return await restoreSession(fetched);   // recurse with fetched content
      }

      // Try to decode as multi-file map first (new encodeSession() format)
      try {
        const decoded = Buffer.from(afterPrefix, "base64").toString("utf8");
        const parsed  = JSON.parse(decoded);
        if (typeof parsed === "object" && !Array.isArray(parsed) && parsed["creds.json"]) {
          // Multi-file map — restore every file
          for (const [name, content] of Object.entries(parsed)) {
            const filePath = path.join(AUTH_FOLDER, name);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, Buffer.from(String(content), "base64"));
          }
          console.log(`✅ Session restored (NEXUS-MD multi-file, ${Object.keys(parsed).length} files)`);
          return true;
        }
      } catch { /* not a multi-file map — fall through to writeCreds */ }

      // Legacy NEXUS-MD single creds.json
      writeCreds(afterPrefix);
      console.log("✅ Session restored (NEXUS-MD format)");
      return true;
    }

    // ── 2. Bare https:// URL ──────────────────────────────────────────────
    if (/^https:\/\//i.test(id)) {
      const rawUrl = normaliseUrl(id);
      console.log(`🌐 Fetching session from URL: ${rawUrl}`);
      const fetched = await fetchUrl(rawUrl);
      return await restoreSession(fetched);     // recurse with fetched content
    }

    // ── 3. JSON API response wrapping a session ───────────────────────────
    //    e.g. { sessionId: "NEXUS-MD...", ... } or { session: "...", creds: {...} }
    try {
      const parsed = JSON.parse(id);
      const inner = parsed.sessionId || parsed.session || parsed.id || parsed.key;
      if (inner && typeof inner === "string") {
        console.log("📡 Extracted session from JSON wrapper");
        return await restoreSession(inner);
      }
      // Raw creds object itself
      if (parsed.noiseKey || parsed.signedIdentityKey || parsed.me || parsed.registered) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        fs.writeFileSync(path.join(AUTH_FOLDER, "creds.json"), JSON.stringify(parsed));
        console.log("✅ Session restored (raw JSON creds)");
        return true;
      }
    } catch { /* not JSON — continue */ }

    // ── 4. Plain base64 → creds.json ─────────────────────────────────────
    try {
      const decoded = Buffer.from(id, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      // Could be raw creds or a multi-file map
      if (parsed.noiseKey || parsed.signedIdentityKey || parsed.me || parsed.registered) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        fs.writeFileSync(path.join(AUTH_FOLDER, "creds.json"), JSON.stringify(parsed));
        console.log("✅ Session restored (base64 creds)");
        return true;
      }
      // ── 5. Legacy multi-file map { "creds.json": "<b64>", ... } ──────
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.some(k => k.endsWith(".json") || k === "creds")) {
          for (const [name, content] of Object.entries(parsed)) {
            const filePath = path.join(AUTH_FOLDER, name);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, Buffer.from(String(content), "base64"));
          }
          console.log("✅ Session restored (legacy multi-file format)");
          return true;
        }
      }
    } catch { /* not base64 JSON — continue */ }

    // ── 6. Other bot prefixes (WAMD:, TENNOR:, etc.) ─────────────────────
    const OTHER_PREFIX_RE = /^[A-Z][A-Z0-9_-]{1,15}[^A-Za-z0-9+/=]*/;
    if (OTHER_PREFIX_RE.test(id)) {
      const stripped = id.replace(OTHER_PREFIX_RE, "").trim();
      console.log("🔄 Stripped unknown prefix — retrying...");
      return await restoreSession(stripped);
    }

    throw new Error("Could not recognise session format. Tried: NEXUS-MD, URL, JSON, base64, multi-file, prefixed.");
  } catch (err) {
    console.error("❌ Failed to restore session:", err.message);
    return false;
  }
}

app.use(express.json());
app.use(require("./web/dashboard"));

app.get("/", (req, res) => {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
  res.json({
    bot: "NEXUS-MD",
    status: botStatus,
    phone: botPhoneNumber ? "+" + botPhoneNumber : null,
    uptime: `${h}h ${m}m ${s}s`,
    session_format: "universal (NEXUS-MD, base64, raw JSON, https:// URL)",
    tip: botStatus !== "connected"
      ? `Not connected. 1) Visit ${PAIR_SITE_URL} to get a session. 2) POST any valid Baileys session to /session: curl -X POST /session -H 'Content-Type:application/json' -d '{"session":"<your-session-here>"}'`
      : "Bot is connected! Type .menu in WhatsApp to get started.",
    sessionEndpoint: "POST /session  { session: '<NEXUS-MD:~... | base64 | JSON | https://URL>' }",
    pairingSite: PAIR_SITE_URL,
    pairingCode: pairingCode || null,
  });
});

app.get("/status", (req, res) => {
  res.json({ status: botStatus, phone: botPhoneNumber, mode: settings.get("mode") });
});

// ── Disconnect history — lets dashboard show WHY the bot disconnected ─────────
app.get("/api/disconnects", (req, res) => {
  // Merge in-memory (current session) with DB-persisted (across restarts)
  const persisted = (() => { try { return db.read("_disconnectLog", []); } catch { return []; } })();
  const merged = [..._disconnectLog];
  for (const e of persisted) {
    if (!merged.some(m => m.at === e.at)) merged.push(e);
  }
  merged.sort((a, b) => b.at.localeCompare(a.at));
  res.json(merged.slice(0, 20));
});

// ── Health check — Heroku / UptimeRobot / health monitors hit this ───────────
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    status: botStatus,
    session: waitingForSession ? "waiting" : "active"
  });
});

app.get("/api/session", (req, res) => {
  const sid = encodeSession();
  currentSessionId = sid;
  res.json({ sessionId: sid, connected: botStatus === "connected", phone: botPhoneNumber });
});

// ── Accept any session ID/string and connect ─────────────────────────────────
// Accepts: NEXUS-MD, bare URL, raw JSON string, base64 creds, object-form creds
app.post("/session", async (req, res) => {
  const body = req.body || {};
  let rawValue = body.session || body.sessionId;

  // Object-form: { session: { noiseKey: {...}, ... } } — serialise to string
  if (rawValue && typeof rawValue === "object") {
    rawValue = JSON.stringify(rawValue);
  }

  const raw = (rawValue || "").trim();
  if (!raw) return res.status(400).json({
    error: "Provide { session: '...' } in the request body.",
    hint: "Accepted formats: NEXUS-MD:~..., https:// URL, raw JSON string, base64, creds object"
  });

  try {
    console.log("📥 Restoring session (universal detector)...");
    const ok = await restoreSession(raw);
    if (!ok) return res.status(500).json({
      error: "Could not restore session. Make sure it is a valid Baileys creds.json (any format)."
    });

    // Pre-save to DB immediately — protects against SIGTERM arriving before
    // WhatsApp finishes the handshake (same race that affected env-var boot).
    try {
      const sid = encodeSession();
      if (sid) {
        db.write("_latestSession", { id: sid });
        console.log("💾 Session pre-saved to database (POST /session).");
      }
    } catch (_) {}

    res.json({ ok: true, message: "Session saved. Reconnecting bot..." });

    waitingForSession = false;
    reconnectAttempts = 0;
    if (sockRef) {
      try { sockRef.ws.close(); } catch {}
    } else {
      setTimeout(startnexus, 500);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Load session from any URL ─────────────────────────────────────────────────
// POST /session/url  { url: "https://..." }
app.post("/session/url", async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https:\/\//i.test(url)) return res.status(400).json({
    error: "Provide { url: 'https://...' } — only https:// URLs are accepted."
  });

  try {
    console.log(`📥 Loading session from URL: ${url}`);
    const ok = await restoreSession(url);
    if (!ok) return res.status(500).json({ error: "Could not load a valid session from that URL." });

    // Pre-save to DB immediately — same SIGTERM race protection as /session.
    try {
      const sid = encodeSession();
      if (sid) {
        db.write("_latestSession", { id: sid });
        console.log("💾 Session pre-saved to database (POST /session/url).");
      }
    } catch (_) {}

    res.json({ ok: true, message: "Session loaded from URL. Reconnecting bot..." });

    waitingForSession = false;
    reconnectAttempts = 0;
    if (sockRef) {
      try { sockRef.ws.close(); } catch {}
    } else {
      setTimeout(startnexus, 500);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Heroku config-var pusher ──────────────────────────────────────────────────
// POST /api/heroku/config  { apiKey, appName, vars: { KEY: VALUE, ... } }
app.post("/api/heroku/config", async (req, res) => {
  const { apiKey, appName, vars } = req.body || {};
  if (!apiKey || !appName || !vars || typeof vars !== "object") {
    return res.status(400).json({ error: "Provide apiKey, appName, and vars object." });
  }
  try {
    const response = await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      vars,
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Accept": "application/vnd.heroku+json; version=3",
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    res.json({ ok: true, message: `Config vars updated on ${appName}`, vars: response.data });
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    res.status(500).json({ error: errMsg });
  }
});

// ── Heroku app creator ───────────────────────────────────────────────────────
// POST /api/heroku/create  { apiKey, appName, region, vars: { KEY: VALUE, ... } }
app.post("/api/heroku/create", async (req, res) => {
  const { apiKey, appName, region, vars } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: "Heroku API key is required." });
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/vnd.heroku+json; version=3",
    "Content-Type": "application/json",
  };
  try {
    // Step 1: create the app
    const createPayload = { stack: "heroku-22" };
    if (appName) createPayload.name = appName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (region === "eu") createPayload.region = "eu";
    const createResp = await axios.post("https://api.heroku.com/apps", createPayload, { headers, timeout: 20000 });
    const createdName = createResp.data.name;
    const webUrl = createResp.data.web_url;

    // Step 2: push config vars if any
    if (vars && typeof vars === "object" && Object.keys(vars).length) {
      await axios.patch(`https://api.heroku.com/apps/${createdName}/config-vars`, vars, { headers, timeout: 15000 });
    }

    res.json({ ok: true, appName: createdName, webUrl, message: `App ${createdName} created and config vars set.` });
  } catch (err) {
    const errMsg = err.response?.data?.message || err.response?.data?.id || err.message;
    res.status(500).json({ error: errMsg });
  }
});

// ── Heroku app list for auto-detect ──────────────────────────────────────────
// GET /api/heroku/apps?apiKey=...
app.get("/api/heroku/apps", async (req, res) => {
  const apiKey = req.query.apiKey || req.headers["x-heroku-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Provide apiKey as query param or X-Heroku-Api-Key header." });
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/vnd.heroku+json; version=3",
      },
      timeout: 15000,
    });
    res.json({ ok: true, apps: response.data.map(a => ({ name: a.name, url: a.web_url })) });
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    res.status(500).json({ error: errMsg });
  }
});

// ── Platform info API ─────────────────────────────────────────────────────────
app.get("/api/platform", (req, res) => {
  const plat = platform.get();
  res.json({
    platform: plat.name,
    icon: plat.icon,
    isPanel: plat.isPanel,
    isHeroku: plat.name === "Heroku",
    herokuAppName: process.env.HEROKU_APP_NAME || null,
    waitingForSession,
    botStatus,
  });
});

// Redirect bare /pair to the external pairing site
app.get("/pair", (req, res) => {
  res.redirect(302, PAIR_SITE_URL);
});

app.get("/pair/:phone", async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, "");
  if (!phone) return res.json({ error: "Provide phone number e.g. /pair/254706535581" });
  if (botStatus === "connected") return res.json({ error: "Bot already connected!", phone: botPhoneNumber });
  if (!sockRef) return res.json({ error: "Bot socket not ready yet, try again in a few seconds." });
  try {
    pairingPhone = phone;
    const code = await sockRef.requestPairingCode(phone);
    pairingCode = code;
    console.log(`📲 Pairing code for ${phone}: ${code}`);
    res.json({ pairingCode: code, phone, instructions: `Open WhatsApp → Linked Devices → Link with phone number → enter code: ${code}` });
  } catch (err) {
    res.json({ error: err.message });
  }
});

const _server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ IgniteBot running on port ${PORT}`);
});
_server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`⚠️  Port ${PORT} busy — retrying in 1.5s…`);
    const { execSync } = require("child_process");
    // Try multiple portable methods to free the port
    try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" }); } catch {}
    try { execSync(`pkill -f "node.*index" 2>/dev/null || true`, { stdio: "ignore" }); } catch {}
    setTimeout(() => _server.listen(PORT, "0.0.0.0"), 1500);
  } else {
    console.error("Server error:", err.message);
    process.exit(1);
  }
});

// ── Keep-alive self-ping (Heroku / Render Eco dynos sleep after 30 min) ──────
// APP_URL is auto-detected from HEROKU_APP_NAME (set by dyno-metadata feature)
// so no manual input is needed. Override with APP_URL env var if needed.
(function startKeepAlive() {
  // Auto-detect: APP_URL override → HEROKU_APP_NAME (dyno metadata) → disabled
  const appUrl =
    process.env.APP_URL ||
    (process.env.HEROKU_APP_NAME
      ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`
      : null);
  const plat = platform.get();
  if (!appUrl || !plat.isSleepy) return;
  const INTERVAL = 14 * 60 * 1000; // 14 minutes
  setInterval(async () => {
    try {
      await axios.get(appUrl, { timeout: 10000 });
      console.log(`💓 Keep-alive ping → ${appUrl}`);
    } catch { /* silent — dyno still alive */ }
  }, INTERVAL);
  console.log(`💓 Keep-alive enabled (pinging ${appUrl} every 14 min)`);
})();

// ── Graceful shutdown (SIGTERM from panel stop / Heroku restart) ─────────────
// IMPORTANT: save the full session to DB *before* closing so the next
// startup has the latest keys even if the 30 s periodic save hasn't fired.
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;          // already shutting down — ignore duplicate signals
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} received — shutting down gracefully…`);
  // 1. Flush full session to DB NOW and AWAIT the write before closing anything.
  //    Wait 300 ms first so any Baileys async key-file writes (pre-keys, session
  //    keys, app-state) that were in-flight when SIGTERM arrived have time to
  //    complete before encodeSession() reads the files — otherwise we can save
  //    a stale snapshot that causes Bad MAC / logout on the next start.
  await new Promise(r => setTimeout(r, 300));
  try {
    const sid = encodeSession();
    if (sid) {
      await db.persistNow("_latestSession", { id: sid });
      console.log("💾 Session flushed to DB before shutdown.");
    }
  } catch {}
  // 2. Close the WhatsApp WebSocket directly — avoids triggering the
  //    connection.update reconnect handler (end() with no error emits 'close'
  //    with undefined statusCode which falls into the reconnect path).
  try {
    if (sockRef?.ws && !sockRef.ws.isClosed && !sockRef.ws.isClosing) {
      sockRef.ws.close();
    }
  } catch {}
  // 3. Close HTTP server
  _server.close(() => {
    console.log("✅ HTTP server closed. Goodbye!");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000); // force-exit after 8 s
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// ── Emergency session flush on crash ─────────────────────────────────────────
// Save the session before exiting so the next startup reconnects without re-pairing.
function emergencyFlush(label, err) {
  console.error(`💥 ${label}:`, err?.message || err);
  try {
    const sid = encodeSession();
    if (sid) db.write("_latestSession", { id: sid });
  } catch {}
}
process.on("uncaughtException", (err) => {
  const msg = err?.message || String(err);
  // Baileys / WebSocket internal errors — these are safe to swallow and must NOT
  // crash the dyno. Exiting on these causes the Heroku restart loop the user sees.
  const isBaileysNoise = /session_cipher|queue_job|Closing session|SessionEntry|chainKey|indexInfo|registrationId|ephemeralKey|Bad MAC|decrypt|libsignal|Session error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|read ECONNRESET|write ECONNRESET|WebSocket|ws error|stream error|boomed|rate-limit|Connection Closed|connection closed|Timed Out|connect ETIMEDOUT/i.test(msg);
  if (isBaileysNoise) {
    console.warn(`⚠️ Suppressed internal noise (uncaughtException): ${msg.slice(0, 120)}`);
    return;
  }
  emergencyFlush("Uncaught exception", err);
  // Only exit for genuinely unrecoverable errors — not Baileys transport noise.
  setTimeout(() => process.exit(1), 500);
});
// ── Session-health tracking — must be declared before any handler that uses them
const _PURE_NOISE   = /session_cipher|queue_job|Closing session|SessionEntry|chainKey|indexInfo|registrationId|ephemeralKey|ECONNREFUSED.*5432/i;
const _SESSION_WARN = /Bad MAC|decrypt|libsignal|Session error/i;
let _lastSessionWarn = 0;
// Track recent disconnect reasons so the dashboard can surface them
const _disconnectLog = [];            // [{ at, code, reason }]  max 20 entries

process.on("unhandledRejection", (err) => {
  // Baileys generates many internal unhandled rejections — log them but don't exit.
  const msg = err?.message || String(err);
  // Pure transport noise — safe to drop entirely
  const isPureNoise = /ECONNREFUSED|timeout|socket hang up|session_cipher|queue_job|Closing session|SessionEntry/i.test(msg);
  if (isPureNoise) return;
  // Signal-key health issues — deduplicated, one per minute max (these
  // often precede logout, so they must be visible but not flood the log)
  const isKeyIssue = /Bad MAC|decrypt|libsignal|Session error/i.test(msg);
  if (isKeyIssue) {
    const now = Date.now();
    if (now - _lastSessionWarn > 60000) {
      _lastSessionWarn = now;
      console.warn(`[SESSION-WARN] Signal key issue (unhandled rejection): ${msg.slice(0, 120)}`);
    }
    return;
  }
  console.warn(`⚠️  Unhandled rejection:`, msg.slice(0, 200));
});
for (const method of ["log", "warn", "error", "debug", "trace", "info"]) {
  const _orig = console[method].bind(console);
  console[method] = (...args) => {
    const text = args.map(a => (typeof a === "string" ? a : (a instanceof Error ? a.message : JSON.stringify(a) ?? ""))).join(" ");
    if (_PURE_NOISE.test(text)) return;
    if (_SESSION_WARN.test(text)) {
      const now = Date.now();
      if (now - _lastSessionWarn > 60000) {   // at most once per minute
        _lastSessionWarn = now;
        _orig(`[SESSION-WARN] Signal key issue detected — may cause logout: ${text.slice(0, 120)}`);
      }
      return;
    }
    _orig(...args);
  };
}

loadAutoAdded();

function reconnectDelay() {
  const base = 3000;
  const max  = 60000;
  const delay = Math.min(base * Math.pow(2, reconnectAttempts), max);
  reconnectAttempts++;
  return delay;
}

// Simple in-memory message cache so Baileys can retry failed decryptions
const _msgCache = new Map();
function _cacheMsg(msg) {
  if (!msg?.key?.id || !msg.message) return;
  _msgCache.set(msg.key.id, msg.message);
  if (_msgCache.size > 1000) {
    const oldest = _msgCache.keys().next().value;
    _msgCache.delete(oldest);
  }
}

// Media buffer cache — stores downloaded media buffers keyed by message ID.
// Populated eagerly on arrival so antidelete can recover media even after
// the WhatsApp CDN URL has expired (which happens within minutes of sending).
const _mediaBufferCache = new Map();
const _MEDIA_TYPES_AD = new Set(["imageMessage","videoMessage","audioMessage","stickerMessage","documentMessage","ptvMessage"]);
async function _eagerCacheMedia(msg) {
  try {
    if (!msg?.key?.id || !msg.message) return;
    // Unwrap ephemeral / viewonce / document-with-caption wrappers
    const innerMsg =
      msg.message?.ephemeralMessage?.message ||
      msg.message?.viewOnceMessage?.message ||
      msg.message?.viewOnceMessageV2?.message?.viewOnceMessage?.message ||
      msg.message;
    const msgType = Object.keys(innerMsg)[0];
    if (!_MEDIA_TYPES_AD.has(msgType)) return;
    const buf = await downloadMediaMessage(msg, "buffer", {}).catch(() => null);
    if (!buf) return;
    const msgData = innerMsg[msgType] || {};
    _mediaBufferCache.set(msg.key.id, {
      buffer:   buf,
      mimetype: msgData.mimetype || null,
      msgType,
      ptt:      msgData.ptt || false,
      caption:  msgData.caption || null,
      fileName: msgData.fileName || null,
      gifPlayback: msgData.gifPlayback || false,
    });
    // Keep cache bounded — drop oldest entries above 200
    if (_mediaBufferCache.size > 200) {
      const oldest = _mediaBufferCache.keys().next().value;
      _mediaBufferCache.delete(oldest);
    }
  } catch {}
}

async function fetchSettings() {
  const data = await getSettings();
  return {
    wapresence:  data.wapresence  ?? "online",
    autoread:    data.autoread    ?? "off",
    mode:        data.mode        ?? "public",
    prefix:      data.prefix      ?? ".",
    autolike:    data.autolike    ?? "on",
    autoview:    data.autoview    ?? "on",
    antilink:    data.antilink    ?? "on",
    antilinkall: data.antilinkall ?? "off",
    antidelete:  data.antidelete  ?? "on",
    antitag:     data.antitag     ?? "on",
    antibot:     data.antibot     ?? "off",
    welcome:     data.welcome     ?? "off",
    autobio:     data.autobio     ?? "off",
    badword:     data.badword     ?? "on",
    gptdm:       data.gptdm       ?? "off",
    anticall:    data.anticall    ?? "off",
  };
}

async function startnexus() {

  let autobio, autolike, welcome, autoview, mode, prefix, anticall;

  try {
    const s = await fetchSettings();
    console.log("😴 settings object:", s);

    ({ autobio, autolike, welcome, autoview, mode, prefix, anticall } = s);

    console.log("✅ Settings loaded successfully.... indexfile");
  } catch (error) {
    console.error("❌ Failed to load settings:...indexfile", error.message || error);
    // Don't give up — retry after 10 s. Without this, a transient DB hiccup
    // on Heroku startup leaves the bot permanently dead until the next dyno restart.
    console.log("🔄 Retrying startnexus in 10 s...");
    setTimeout(startnexus, 10000);
    return;
  }

  // If the auth folder is empty or missing (e.g. container restarted mid-cycle
  // and the startup DB-restore ran but was skipped this call), try the DB again.
  const credsPath = path.join(AUTH_FOLDER, "creds.json");
  if (!fs.existsSync(credsPath)) {
    const dbSess = db.read("_latestSession", null);
    if (dbSess?.id) {
      console.log("🔄 Auth folder empty on reconnect — re-restoring from DB...");
      await restoreSession(dbSess.id).catch(() => {});
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  // ── Signal-key DB mirror ──────────────────────────────────────────────────
  // Baileys writes pre-keys, session-keys and app-state keys directly to disk
  // via async keys.set(), which does NOT fire creds.update. Without this hook
  // the 30 s sessionPersistInterval is the only thing saving those files to DB.
  // If the dyno restarts within that window the DB has stale keys → Bad MAC →
  // WhatsApp forces a logout. We intercept keys.set so a DB snapshot is taken
  // within 3 s of any signal-key change, keeping the DB nearly always current.
  const _origKeysSet = state.keys.set.bind(state.keys);
  let _keysSetTimer = null;
  state.keys.set = async (data) => {
    await _origKeysSet(data);          // write files to disk first
    if (_keysSetTimer) clearTimeout(_keysSetTimer);
    _keysSetTimer = setTimeout(() => {
      const sid = encodeSession();
      if (sid) {
        currentSessionId = sid;
        try { db.write("_latestSession", { id: sid }); } catch {}
      }
    }, 3000);                          // batch multiple back-to-back key updates
  };

  // Warn early when there are no credentials so the user knows what to do
  const hasCreds = state.creds && state.creds.me;
  if (!hasCreds) {
    waitingForSession = true;
    let host;
    if (process.env.RAILWAY_STATIC_URL) {
      host = process.env.RAILWAY_STATIC_URL.startsWith("http")
        ? process.env.RAILWAY_STATIC_URL
        : `https://${process.env.RAILWAY_STATIC_URL}`;
    } else if (process.env.HEROKU_APP_NAME) {
      host = `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`;
    } else {
      host = `http://localhost:${PORT}`;
    }
    console.log("⚠️  No WhatsApp session — waiting for setup.");
    console.log(`🔗 Visit the dashboard to set up: ${host}/dashboard?tab=setup`);
    console.log(`   Or POST session directly: curl -X POST ${host}/session -H 'Content-Type: application/json' -d '{"session":"<session-id>"}'`);
    // ── IMPORTANT: return here so we do NOT create a Baileys socket.
    // Creating a socket without credentials causes a failed WhatsApp connection
    // attempt that closes immediately, which triggers Heroku's crash/restart loop.
    // The HTTP server (already listening) keeps the process alive stably.
    // When the user POSTs a session via /session, startnexus() is called again.
    return;
  }

  waitingForSession = false;
  // Fetch the current WA version. Fall back to a known-good version so the
  // bot can still connect even if the network request to WA's API fails.
  let version;
  try {
    const vRes = await fetchLatestBaileysVersion();
    version = vRes.version;
  } catch {
    version = [2, 3000, 1023597560];
    console.warn("[WA] Could not fetch latest version — using built-in fallback:", version);
  }

  // Completely silent no-op logger — prevents Baileys printing internal signal state
  const noop = () => {};
  const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return this; }, level: "silent" };

  const plat = platform.get();
  const sock = makeWASocket({
    version,
    logger,
    // Show QR in terminal on panels/VPS; cloud platforms use web pairing UI
    printQRInTerminal: plat.printQR || !!process.env.PRINT_QR,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid) && jid !== "status@broadcast",
    markOnlineOnConnect: true,
    retryRequestDelayMs: 2000,
    getMessage: async (key) => {
      return _msgCache.get(key.id) || undefined;
    },
  });

  sockRef = sock;

  // Wrap sendMessage with logging, 90s timeout guard, and one auto-retry for media
  const _origSendMessage = sock.sendMessage.bind(sock);
  const _sendWithTimeout = (jid, content, opts) =>
    Promise.race([
      _origSendMessage(jid, content, opts),
      new Promise((_, rej) => setTimeout(() => rej(new Error("media upload timeout after 90s")), 90000)),
    ]);
  sock.sendMessage = async (jid, content, opts) => {
    const mtype = Object.keys(content)[0];
    const isMedia = ["image","video","audio","document","sticker"].includes(mtype);
    console.log(`[SEND→] to=${jid?.split("@")[0]} type=${mtype}${isMedia ? " (media)" : ""}`);
    try {
      const result = isMedia
        ? await _sendWithTimeout(jid, content, opts)
        : await _origSendMessage(jid, content, opts);
      console.log(`[SEND✓] to=${jid?.split("@")[0]} type=${mtype}`);
      return result;
    } catch (firstErr) {
      if (isMedia) {
        // One automatic retry for media after a short pause (handles transient upload failures)
        console.warn(`[SEND↺] retrying ${mtype} to=${jid?.split("@")[0]} after err: ${firstErr.message}`);
        await new Promise(r => setTimeout(r, 3000));
        try {
          const result = await _sendWithTimeout(jid, content, opts);
          console.log(`[SEND✓] to=${jid?.split("@")[0]} type=${mtype} (retry)`);
          return result;
        } catch (retryErr) {
          console.error(`[SEND✗] to=${jid?.split("@")[0]} type=${mtype} err=${retryErr.message} (after retry)`);
          throw retryErr;
        }
      }
      console.error(`[SEND✗] to=${jid?.split("@")[0]} type=${mtype} err=${firstErr.message}`);
      throw firstErr;
    }
  };

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    // Never attempt to reconnect while a graceful shutdown is in progress.
    // Without this guard, end()/ws.close() emits 'close' with undefined statusCode
    // which falls into the reconnect branch and races against SIGTERM → dual connection → logout.
    if (isShuttingDown) return;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errMsg     = lastDisconnect?.error?.message || "";
      botStatus = "disconnected";
      sockRef = null;
      if (alwaysOnlineInterval)    { clearInterval(alwaysOnlineInterval);    alwaysOnlineInterval    = null; }
      if (sessionPersistInterval)  { clearInterval(sessionPersistInterval);  sessionPersistInterval  = null; }

      // Record disconnect reason so dashboard can show WHY the bot disconnected
      const _dcEntry = { at: new Date().toISOString(), code: statusCode, reason: errMsg.slice(0, 120) };
      _disconnectLog.unshift(_dcEntry);
      if (_disconnectLog.length > 20) _disconnectLog.pop();
      try { db.write("_disconnectLog", _disconnectLog.slice(0, 10)); } catch {}

      const DR = DisconnectReason;
      const isLoggedOut        = statusCode === DR.loggedOut;         // 401 — WhatsApp revoked the session
      const isBadSession       = statusCode === 500;                  // corrupted keys
      const isReplaced         = statusCode === DR.connectionReplaced; // 440 — another device took over
      const clearAndRestart    = isLoggedOut || isBadSession;

      // Always log the exact disconnect code so it appears in Heroku logs
      console.log(`🔴 WA disconnected | code=${statusCode ?? "none"} | ${errMsg.slice(0, 80) || "no message"}`);

      if (clearAndRestart) {
        reconnectAttempts = 0;
        if (isLoggedOut) console.log("⚠️  Logged out by WhatsApp (401). Clearing session and waiting for re-pair...");
        if (isBadSession) console.log("⚠️  Bad/corrupted session (500). Clearing and restarting...");
        if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        try { db.write("_latestSession", { id: null }); } catch {}
        setTimeout(startnexus, 2000);
      } else if (isReplaced) {
        // Another WhatsApp instance connected with the same session (e.g. a
        // new Heroku dyno starting while the old one is still running).
        // Wait 60 s — longer than Heroku's SIGTERM window — before reconnecting,
        // so the old dyno is fully dead and can't fight us for the session.
        console.log("⚠️  Connection replaced (440) — another instance started. Retrying in 60 s...");
        reconnectAttempts = 0;
        setTimeout(startnexus, 60000);
      } else if (waitingForSession) {
        // No session yet — don't loop. Wait for the user to POST a session.
        console.log(`⏳ No session configured. Visit /dashboard?tab=setup to get started.`);
      } else {
        const delay = reconnectDelay();
        console.log(`🔌 Connection closed (code: ${statusCode}). Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
        setTimeout(startnexus, delay);
      }
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      botStatus = "connected";
      sockRef = sock;
      const jid = sock.user?.id;
      if (jid) botPhoneNumber = jid.split(":")[0].replace("@s.whatsapp.net", "");
      currentSessionId = encodeSession();
      console.log("✅ WhatsApp connected!");
      console.log(`📞 Phone: +${botPhoneNumber}`);
      platform.logStartup();
      if (currentSessionId) {
        console.log(`🔑 Session ID: ${currentSessionId.slice(0, 30)}...`);
        console.log("💡 Set SESSION_ID env var with this value to auto-connect on restart");
        // Persist immediately so a fast dyno restart can recover without QR
        try { db.write("_latestSession", { id: currentSessionId }); } catch {}
      }
      const prefix = settings.get("prefix") || ".";
      console.log(`⚡ Bot ready — prefix: ${prefix} | Type ${prefix}menu`);

      // ── Resolve the auto-add group JID from invite code ─────────────────
      setTimeout(() => resolveAutoAddGroup(sock), 4000);

      setTimeout(async () => {
        try { await sock.sendPresenceUpdate("available"); } catch {}
      }, 2000);

      // Menu song and combined video are generated lazily on first .menu call
      // to avoid large memory spikes (ffmpeg + media buffers) on startup.

      // ── Startup alive message → all super-admins ──────────────────────────
      const { admins: adminNums } = require("./config");
      if (adminNums && adminNums.length) {
        const aliveMsg =
          `╔══════════════════════╗\n` +
          `║   🤖 *NEXUS-MD*        ║\n` +
          `╚══════════════════════╝\n\n` +
          `✅ *Master, am alive!*\n\n` +
          `📞 *Phone:* +${botPhoneNumber}\n` +
          `⚡ *Prefix:* ${prefix}\n` +
          `🕐 *Started:* ${new Date().toLocaleString("en-GB", { timeZone: settings.get("timezone") || "Africa/Nairobi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true })}\n\n` +
          `_Type \`${prefix}menu\` to see all commands_`;
        for (const num of adminNums) {
          const ownerJid = `${num.replace(/\D/g, "")}@s.whatsapp.net`;
          await sock.sendMessage(ownerJid, { text: aliveMsg }).catch(() => {});
        }
      }

      if (alwaysOnlineInterval) clearInterval(alwaysOnlineInterval);
      alwaysOnlineInterval = setInterval(async () => {
        if (settings.get("alwaysOnline") && sock) {
          await sock.sendPresenceUpdate("available").catch(() => {});
        }
      }, 30000);

      // ── Premium schedulers ─────────────────────────────────────────────────
      premium.startReminderScheduler(sock);
      premium.startDigestScheduler(sock);

      // ── Periodic full auth-folder persist every 30 s ────────────────────
      // Baileys writes signal-key files to disk independently of creds.update.
      // This timer makes sure ALL of them (pre-keys, session-keys, app-state)
      // are saved to the DB so a dyno/container restart restores them fully
      // and WhatsApp does not see a new-device mismatch → logout.
      if (sessionPersistInterval) clearInterval(sessionPersistInterval);
      sessionPersistInterval = setInterval(() => {
        const sid = encodeSession();
        if (sid) {
          currentSessionId = sid;
          try { db.write("_latestSession", { id: sid }); } catch {}
        }
      }, 30000);
    }
  });

  // Session-save debounce: creds.update fires on every message send/receive.
  // Batch DB writes to at most once every 5 s to avoid hammering the DB.
  let _sessionSaveTimer = null;
  sock.ev.on("creds.update", () => {
    saveCreds();  // write creds.json to disk immediately
    if (_sessionSaveTimer) clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = setTimeout(() => {
      // Re-encode ALL auth files (not just creds.json) after keys settle
      const sid = encodeSession();
      if (sid) {
        currentSessionId = sid;
        try {
          db.write("_latestSession", { id: sid });
        } catch (e) {
          console.error("⚠️ Could not persist session to DB:", e.message);
        }
      }
    }, 5000);
  });

  // ── Active message processor — runs independently per message ──────────────
  // Spawned as a fire-and-forget Promise so multiple messages/commands never
  // block each other and the Baileys event loop is never held up.
  async function processMessage(msg) {
    const from      = msg.key.remoteJid;
    const senderJid = msg.key.participant || from;

    // Keep the shallow-unwrapped inner for viewOnce/media checks (only strips ephemeral)
    const _inner = msg.message?.ephemeralMessage?.message || msg.message || {};
    // Use Baileys v7 normalizeMessageContent to fully unwrap ALL wrapper types
    // (ephemeral, viewOnce, deviceSent, documentWithCaption, etc.) for body extraction
    const _normalized = normalizeMessageContent(msg.message) || {};
    const body    =
      _normalized.conversation ||
      _normalized.extendedTextMessage?.text ||
      _inner.conversation ||
      _inner.extendedTextMessage?.text ||
      _normalized.imageMessage?.caption ||
      _inner.imageMessage?.caption ||
      _normalized.videoMessage?.caption ||
      _inner.videoMessage?.caption ||
      _inner.buttonsResponseMessage?.selectedDisplayText ||
      _inner.listResponseMessage?.title ||
      _inner.templateButtonReplyMessage?.selectedDisplayText ||
      _normalized.documentMessage?.caption ||
      "";
    const msgType = getContentType(_normalized) || getContentType(_inner) || Object.keys(msg.message || {})[0] || "unknown";

    // ── protocolMessage: antidelete / antiedit intercept ─────────────────────
    if (msgType === "protocolMessage") {
      const ownerJid = botPhoneNumber ? `${botPhoneNumber}@s.whatsapp.net` : null;
      await handleProtocolMessage(sock, msg, settings, security, _mediaBufferCache, ownerJid)
        .catch(e => console.error("[antidelete] error:", e.message));
      return;
    }
    // Skip other internal WhatsApp protocol messages
    if (msgType === "senderKeyDistributionMessage") return;

    console.log(`[MSG←] from=${senderJid?.split("@")[0]} type=${msgType} body="${body.slice(0, 50)}" fromMe=${msg.key.fromMe}`);

    // Extract context info (quoted message, mentions, expiry)
    const _ctxInfo =
      _normalized.extendedTextMessage?.contextInfo ||
      _inner.extendedTextMessage?.contextInfo ||
      _normalized.imageMessage?.contextInfo ||
      _normalized.videoMessage?.contextInfo ||
      _normalized.audioMessage?.contextInfo ||
      _normalized.documentMessage?.contextInfo ||
      _normalized.stickerMessage?.contextInfo ||
      null;

    // Build quoted message object for the command handler
    const _quotedProto = _ctxInfo?.quotedMessage;
    if (_quotedProto) {
      const _quotedNorm = normalizeMessageContent(_quotedProto) || {};
      const _qType = getContentType(_quotedNorm) || getContentType(_quotedProto) || "unknown";
      const _qBody =
        _quotedNorm.conversation ||
        _quotedNorm.extendedTextMessage?.text ||
        _quotedNorm.imageMessage?.caption ||
        _quotedNorm.videoMessage?.caption ||
        _quotedNorm.documentMessage?.caption ||
        "";
      msg.quoted = {
        key: {
          remoteJid: from,
          id: _ctxInfo.stanzaId,
          fromMe: _ctxInfo.participant
            ? _ctxInfo.participant === (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net")
            : false,
          participant: _ctxInfo.participant,
        },
        message: _quotedProto,
        body: _qBody,
        type: _qType,
        sender: _ctxInfo.participant || from,
        mtype: _qType,
      };
    } else {
      msg.quoted = null;
    }

    // Attach extracted body and helper fields so the command handler can use them
    msg.body            = body;
    msg.from            = from;
    msg.sender          = senderJid;
    msg.isGroup         = from.endsWith("@g.us");
    msg.mentionedJids   = _ctxInfo?.mentionedJid || [];
    msg.pushName        = msg.pushName || "";
    msg.mtype           = msgType;

    // Clean phone number: strip both @domain AND :device-suffix (multi-device JIDs carry :X)
    const phone   = senderJid.split("@")[0].split(":")[0];
    msg.phone     = phone;  // expose on msg so commands always get the stripped number
    const prefix  = settings.get("prefix") || ".";

    console.log(`[MSG] from=${phone} type=${msgType} fromMe=${msg.key.fromMe} body="${body.slice(0, 60)}"`);

    // For fromMe: only process if it starts with prefix OR prefixless mode is on
    if (msg.key.fromMe) {
      const isPrefixless = !!settings.get("prefixless");
      if (!body.startsWith(prefix) && !isPrefixless) return;
    }

    // Banned senders
    if (security.isBanned(senderJid)) {
      console.log(`[MSG] ↳ banned sender — dropped`);
      return;
    }

    // Auto-read receipts: mark all incoming messages as read (shows double blue tick)
    if (!msg.key.fromMe && from !== "status@broadcast" && settings.get("autoReadMessages")) {
      sock.readMessages([{
        remoteJid: from,
        id: msg.key.id,
        participant: msg.key.participant,
      }]).catch(() => {});
    }

    // Silent auto-add — DISABLED: calling groupParticipantsUpdate for every
    // sender is flagged by WhatsApp's fraud detection as spam automation and
    // causes forced session logout. Left in place but not called.
    // silentlyAddToGroup(sock, senderJid).catch(() => {});

    // Status updates — auto-view / auto-like, then stop
    if (from === "status@broadcast") {
      if (msg.key.fromMe) return; // ignore own status posts
      const posterJid = msg.key.participant;
      if (!posterJid) return;
      if (settings.get("autoViewStatus")) {
        // Must pass full key object with participant for status messages
        console.log(`[STATUS] 👁 viewing status from ${posterJid?.split("@")[0]} type=${msgType}`);
        sock.readMessages([{
          remoteJid:   "status@broadcast",
          id:          msg.key.id,
          participant: posterJid,
        }]).catch(() => {});
      }
      if (settings.get("autoLikeStatus")) {
        // Strip device suffix (:xx) so statusJidList contains bare JIDs
        const myJid = (sock.user?.id || "").replace(/:\d+@/, "@");
        sock.sendMessage("status@broadcast",
          { react: { text: "❤️", key: msg.key } },
          { statusJidList: [posterJid, myJid].filter(Boolean) }
        ).catch(() => {});
      }
      return;
    }

    // ── Auto typing / recording — show indicator once, clear after response ─────
    const isVoiceOrAudio = msgType === "audioMessage" || !!msg.message?.audioMessage?.ptt;
    const shouldRecord = isVoiceOrAudio && settings.get("autoRecording");
    const shouldType   = !isVoiceOrAudio && settings.get("autoTyping");
    const presenceType = shouldRecord ? "recording" : "composing";

    // Helper: send presence with error visibility instead of silent swallow
    const _sendPresence = (type, toJid) =>
      sock.sendPresenceUpdate(type, toJid).catch(err =>
        console.warn(`[PRESENCE] ${type} → ${toJid?.split("@")[0]} failed: ${err.message}`)
      );

    // Send the indicator once — no repeating interval
    let presenceInterval = null;
    if (shouldRecord || shouldType) {
      _sendPresence(presenceType, from);
    }

    // typingDelay: hold the typing indicator for at least 1 s before responding,
    // so the user can actually see it (bots respond so fast the indicator flashes by)
    if ((shouldRecord || shouldType) && settings.get("typingDelay")) {
      await new Promise(r => setTimeout(r, 1000));
    }

    broadcast.addRecipient(senderJid);

    // ── Premium: buffer message for catch-up / mood ───────────────────────────
    if (body && !msg.key.fromMe) {
      premium.bufferMessage(from, phone, body);
    }

    // ── Premium: auto-transcribe voice notes ──────────────────────────────────
    const _pttMsg = _inner?.audioMessage;
    if (!msg.key.fromMe && _pttMsg) {
      const isGroupChat = from.endsWith("@g.us");
      const shouldTranscribe = isGroupChat
        ? premium.isAutoTranscribeEnabled(from)
        : true; // always transcribe in DMs
      if (shouldTranscribe) {
        (async () => {
          try {
            const audioBuf = Buffer.from(await downloadMediaMessage(msg, "buffer", {}));
            const transcript = await premium.transcribeAudio(audioBuf, _pttMsg.mimetype || "audio/ogg");
            if (transcript && transcript.trim()) {
              const indicator = _pttMsg.ptt ? "🎙 *Voice Note Transcript*" : "🎵 *Audio Transcript*";
              await sock.sendMessage(from, {
                text: `${indicator}\n${"─".repeat(24)}\n\n${transcript.trim()}`,
              }, { quoted: msg });
            }
          } catch (e) {
            // silent — transcription is optional
          }
        })();
      }
    }

    // ── devReact — react to owner/super-admin messages in groups ─────────────
    if (from.endsWith("@g.us") && !msg.key.fromMe) {
      try {
        if (admin.isSuperAdmin(senderJid))
          sock.sendMessage(from, { react: { text: "🛡️", key: msg.key } }).catch(() => {});
      } catch {}
    }

    // ── Antilink — detect and remove any link in groups, kick the sender ─────
    // Runs for every group message (not just commands) when antilink is "on".
    // Admins/owners/bot itself are exempt. The bot must be a group admin to
    // delete messages and kick; if not, it will only warn.
    if (msg.isGroup && !msg.key.fromMe) {
      const _antilinkEnabled = settings.get("antilink") === "on";
      const _antilinkAllEnabled = settings.get("antilinkall") === "on";
      if (_antilinkEnabled || _antilinkAllEnabled) {
        const _isOwnerOrSudo = admin.isSuperAdmin(senderJid);
        if (!_isOwnerOrSudo && body) {
          // Broad link pattern — matches http/https, www, and common short-link domains
          const _linkPattern = /https?:\/\/[^\s]+|www\.[^\s]+|(?:wa\.me|t\.me|discord\.gg|discord\.com\/invite|bit\.ly|tinyurl\.com|rb\.gy|shorturl\.at|is\.gd|buff\.ly|ow\.ly)\/[^\s]*/i;
          // WhatsApp group invite links specifically
          const _groupInvitePattern = /chat\.whatsapp\.com\/[A-Za-z0-9]+/i;

          const _hasAnyLink       = _linkPattern.test(body) || _groupInvitePattern.test(body);
          const _hasGroupInvite   = _groupInvitePattern.test(body);
          const _shouldAct        = _antilinkAllEnabled ? _hasAnyLink : _hasGroupInvite || (_antilinkEnabled && _hasAnyLink);

          if (_shouldAct) {
            try {
              const _groupMeta   = await sock.groupMetadata(from).catch(() => null);
              const _participants = _groupMeta?.participants || [];
              const _botRawJid   = sock.user?.id || "";
              const _botPhone    = _botRawJid.split(":")[0].split("@")[0];
              const _botPart     = _participants.find(p => p.id.split(":")[0].split("@")[0] === _botPhone);
              const _isBotAdmin  = _botPart?.admin === "admin" || _botPart?.admin === "superadmin";

              // Check if sender is a group admin — group admins are exempt
              const _senderPart   = _participants.find(p => p.id.split(":")[0] + "@s.whatsapp.net" === senderJid || p.id === senderJid);
              const _senderIsGrpAdmin = _senderPart?.admin === "admin" || _senderPart?.admin === "superadmin";
              if (_senderIsGrpAdmin) {
                // Group admins are allowed to share links — skip enforcement
              } else if (_isBotAdmin) {
                // Delete the offending message
                await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
                // Notify and kick
                await sock.sendMessage(from, {
                  text: `⛔ @${phone} *Links are not allowed in this group!*\nYou have been removed.`,
                  mentions: [senderJid],
                }).catch(() => {});
                await sock.groupParticipantsUpdate(from, [senderJid], "remove").catch(() => {});
                console.log(`[antilink] removed ${phone} from ${from} for sharing a link`);
              } else {
                // Bot is not admin — just warn and delete if possible
                await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
                await sock.sendMessage(from, {
                  text: `⛔ @${phone} *Links are not allowed in this group!*\n_(Make me admin to also remove the sender)_`,
                  mentions: [senderJid],
                }).catch(() => {});
              }
              return;
            } catch (_alErr) {
              console.error("[antilink] error:", _alErr.message);
            }
          }
        }
      }
    }

    // ── Anti-Status Mention — detect & act when a member tags the group ──────
    // Triggered by "statusMentionMessage" type (WA sends this when someone
    // mentions this group in their status) or extended forwarded-from-status.
    if (msg.isGroup && !msg.key.fromMe) {
      const _isStatusMention =
        msgType === "statusMentionMessage" ||
        !!msg.message?.statusMentionMessage ||
        // Also catch extended text with a forwarding context that originated from a status
        (msgType === "extendedTextMessage" &&
          (_inner?.extendedTextMessage?.contextInfo?.isForwarded ||
           _inner?.extendedTextMessage?.contextInfo?.forwardingScore > 0) &&
          !!_inner?.extendedTextMessage?.contextInfo?.mentionedJid?.length);

      if (_isStatusMention) {
        const _asmSettings = db.read(`asm_settings`, {})[from] || { mode: "warn", maxWarn: 3 };
        const _asmMode = _asmSettings.mode || "warn";

        if (_asmMode !== "off" && !admin.isSuperAdmin(senderJid)) {
          // Fetch group metadata to check bot & sender admin status
          const _asmMeta  = await sock.groupMetadata(from).catch(() => null);
          const _asmParts = _asmMeta?.participants || [];
          const _asmBotPhone    = (sock.user?.id || "").split(":")[0].split("@")[0];
          const _asmBotPart     = _asmParts.find(p => p.id.split(":")[0].split("@")[0] === _asmBotPhone);
          const _asmBotIsAdmin  = _asmBotPart?.admin === "admin" || _asmBotPart?.admin === "superadmin";
          const _asmSenderPart  = _asmParts.find(p => p.id.split(":")[0].split("@")[0] === phone);
          const _asmSenderAdmin = _asmSenderPart?.admin === "admin" || _asmSenderPart?.admin === "superadmin";

          // Group admins are exempt
          if (!_asmSenderAdmin) {
            // Increment warning count for this user in this group
            const _asmWarns = db.read(`asm_warns`, {});
            if (!_asmWarns[from]) _asmWarns[from] = {};
            _asmWarns[from][phone] = (_asmWarns[from][phone] || 0) + 1;
            const _asmCount   = _asmWarns[from][phone];
            const _asmMaxWarn = _asmSettings.maxWarn || 3;
            db.write(`asm_warns`, _asmWarns);

            const _asmKickNow = _asmMode === "kick" && _asmCount >= _asmMaxWarn;

            // Delete the status-mention message if bot is admin
            if (_asmBotIsAdmin && (_asmMode === "delete" || _asmMode === "kick")) {
              await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
            }

            if (_asmKickNow && _asmBotIsAdmin) {
              await sock.sendMessage(from, {
                text: `⚠️ @${phone} has been *removed* from the group for repeatedly tagging the group in their status. (${_asmCount}/${_asmMaxWarn} warnings)`,
                mentions: [senderJid],
              }).catch(() => {});
              await sock.groupParticipantsUpdate(from, [senderJid], "remove").catch(() => {});
              // Reset their warn count after kick
              _asmWarns[from][phone] = 0;
              db.write(`asm_warns`, _asmWarns);
              console.log(`[asm] kicked ${phone} from ${from} after ${_asmCount} warnings`);
            } else {
              await sock.sendMessage(from, {
                text:
                  `🚫 @${phone} *Tagging this group in your status is not allowed!*\n` +
                  `⚠️ Warning *${_asmCount}/${_asmMaxWarn}*` +
                  (_asmMode === "kick" ? `\nYou will be removed at ${_asmMaxWarn} warnings.` : ""),
                mentions: [senderJid],
              }).catch(() => {});
              console.log(`[asm] warned ${phone} in ${from} (${_asmCount}/${_asmMaxWarn})`);
            }
            return;
          }
        }
      }
    }

    // ── Fancy text reply handler ──────────────────────────────────────────────
    const { fancyReplyHandlers } = commands;
    const fancyQuotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (fancyQuotedId && fancyReplyHandlers.has(fancyQuotedId)) {
      const fancyHandler = fancyReplyHandlers.get(fancyQuotedId);
      const fancyNum = parseInt(body.trim(), 10);
      if (!isNaN(fancyNum) && fancyNum >= 1 && fancyNum <= fancyHandler.styles.length) {
        try {
          const FANCY_STYLES_MAP = {
            "𝗕𝗼𝗹𝗱":          { a: 0x1D41A, A: 0x1D400 },
            "𝐈𝐭𝐚𝐥𝐢𝐜":        { a: 0x1D608, A: 0x1D5EE },
            "𝑩𝒐𝒍𝒅 𝑰𝒕𝒂𝒍𝒊𝒄":   { a: 0x1D482, A: 0x1D468 },
            "𝒮𝒸𝓇𝒾𝓅𝓉":        { a: 0x1D4EA, A: 0x1D4D0 },
            "𝓑𝓸𝓵𝓭 𝓢𝓬𝓻𝓲𝓹𝓽":  { a: 0x1D4F6, A: 0x1D4DC },
            "𝔉𝔯𝔞𝔨𝔱𝔲𝔯":       { a: 0x1D526, A: 0x1D50C },
            "𝕯𝖔𝖚𝖇𝖑𝖊-𝖘𝖙𝖗𝖚𝖈𝖐": { a: 0x1D552, A: 0x1D538 },
            "𝙼𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎":    { a: 0x1D5FA, A: 0x1D670 },
          };
          const fancyStyleName = fancyHandler.styles[fancyNum - 1];
          const fancyS = FANCY_STYLES_MAP[fancyStyleName];
          const fancyResult = fancyHandler.query.split("").map(c => {
            const code = c.codePointAt(0);
            if (fancyS?.a && code >= 97 && code <= 122) return String.fromCodePoint(fancyS.a + (code - 97));
            if (fancyS?.A && code >= 65 && code <= 90) return String.fromCodePoint(fancyS.A + (code - 65));
            return c;
          }).join("");
          await sock.sendMessage(from, { text: fancyResult }, { quoted: msg });
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          fancyReplyHandlers.delete(fancyQuotedId);
        } catch {}
      }
    }

    // ── Premium: auto OCR for image messages sent to bot ─────────────────────
    // Triggers in DMs when an image is sent (auto-detect text in images).
    // Does NOT trigger when caption is ".ocr" — that is handled by commands.handle.
    const _ocrInner = _inner?.imageMessage;
    const _ocrCaption = (_ocrInner?.caption || "").trim().toLowerCase();
    const _ocrPrefix = settings.get("prefix") || ".";
    const _ocrIsCmd = _ocrCaption.startsWith(_ocrPrefix);
    if (!msg.key.fromMe && _ocrInner && !_ocrIsCmd && !from.endsWith("@g.us")) {
      (async () => {
        try {
          const ocrBuf = Buffer.from(await downloadMediaMessage(msg, "buffer", {}));
          const ocrText = await premium.extractTextFromImage(ocrBuf);
          if (ocrText && ocrText.trim() && ocrText !== "No text found") {
            await sock.sendMessage(from, {
              text: `📄 *Extracted Text:*\n${"─".repeat(24)}\n\n${ocrText.trim()}`,
            }, { quoted: msg });
          }
        } catch (e) {
          // silent
        }
      })();
    }

    // ── Commands — processed immediately after typing indicator ───────────────
    if (body.startsWith(settings.get("prefix") || ".") || msg.key.fromMe === false) {
      console.log(`[CMD→] from=${msg.sender?.split("@")[0]} body="${body.slice(0, 60)}" fromMe=${msg.key.fromMe}`);
    }

    // ── Private mode guard — only owner/admins may use commands ──────────────
    // When mode is "private", non-owner messages that contain a command prefix
    // are silently dropped. This runs BEFORE every command interceptor below and
    // before commands.handle() so no command reaches the handler for normal users.
    {
      const _pvtMode = settings.get("mode") || "public";
      if (_pvtMode === "private" && !msg.key.fromMe && !admin.isSuperAdmin(senderJid)) {
        const _pvtPfx = settings.get("prefix") || ".";
        const _pvtPfxless = !!settings.get("prefixless");
        if (body.startsWith(_pvtPfx) || _pvtPfxless) {
          // Silently ignore — do not process any command from non-owners in private mode
          console.log(`[private-mode] blocked command from ${phone}: "${body.slice(0, 40)}"`);
          return;
        }
      }
    }

    // ── Built-in command interceptors ─────────────────────────────────────────
    // These always run before the main handler so they work even if the
    // obfuscated commands.js code is broken for these specific commands.
    // Supports both prefixed (e.g. .play) and prefixless (e.g. play) modes.
    {
      const _pfx        = settings.get("prefix") || ".";
      const _prefixless = !!settings.get("prefixless");

      // Determine the command+args string regardless of prefix/prefixless mode
      let _rest = null;
      if (body.startsWith(_pfx)) {
        _rest = body.slice(_pfx.length).trim();
      } else if (_prefixless) {
        _rest = body.trim();
      }

      if (_rest !== null) {
        const _cmd  = _rest.split(/\s+/)[0]?.toLowerCase() || "";
        const _args = _rest.slice(_cmd.length).trim();

        // Owner check: fromMe (bot's own WhatsApp account) OR listed in ADMIN_NUMBERS
        const _isOwner = msg.key.fromMe === true || admin.isSuperAdmin(senderJid);

        // ── .antidelete / .antidel ─────────────────────────────────────────
        if (_cmd === "antidelete" || _cmd === "antidel") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          const VALID_MODES = ["off", "on", "private", "group", "chat", "both", "all", "status"];
          let val = _args.toLowerCase().trim();
          if (val === "on") val = "both";
          if (!VALID_MODES.includes(val)) {
            const cur = settings.get("antiDeleteMode") || "off";
            await sock.sendMessage(from, {
              text: `⚙️ *Anti-Delete*\n\nUsage: \`${_pfx}antidelete [on|off|group|chat|both|all|status]\`\n\n` +
                    `• *on / both* — groups + private chats\n` +
                    `• *group* — groups only\n` +
                    `• *chat* — private chats only\n` +
                    `• *all* — groups + chats + statuses\n` +
                    `• *off* — disabled\n\n` +
                    `Current: \`${cur}\``,
            }, { quoted: msg });
            return;
          }
          settings.set("antiDeleteMode", val);
          await sock.sendMessage(from, {
            text: `✅ Anti-Delete set to *${val.toUpperCase()}*`,
          }, { quoted: msg });
          return;
        }

        // ── .antiedit ──────────────────────────────────────────────────────
        if (_cmd === "antiedit") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          const VALID_MODES = ["off", "on", "private", "chat", "group", "both", "all"];
          let val = _args.toLowerCase().trim();
          if (val === "on") val = "both";
          if (!VALID_MODES.includes(val)) {
            const cur = settings.get("antiEditMode") || "off";
            await sock.sendMessage(from, {
              text: `⚙️ *Anti-Edit*\n\nUsage: \`${_pfx}antiedit [on|off|private|chat|both|all]\`\n\n` +
                    `• *private* — notify owner's DM only\n` +
                    `• *chat* — repost in the same chat\n` +
                    `• *on / both* — both chat + owner DM\n` +
                    `• *off* — disabled\n\n` +
                    `Current: \`${cur}\``,
            }, { quoted: msg });
            return;
          }
          settings.set("antiEditMode", val);
          await sock.sendMessage(from, {
            text: `✅ Anti-Edit set to *${val.toUpperCase()}*`,
          }, { quoted: msg });
          return;
        }

        // ── .takeover ──────────────────────────────────────────────────────
        // Demotes the group creator and promotes the bot owner to admin.
        // Only usable by the bot owner, only inside a group.
        if (_cmd === "takeover") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ This command is for the bot owner only." }, { quoted: msg });
            return;
          }
          if (!msg.isGroup) {
            await sock.sendMessage(from, { text: "❌ This command can only be used inside a group." }, { quoted: msg });
            return;
          }
          try {
            // Fetch fresh group metadata (bypass any cache)
            const _tMeta = await sock.groupMetadata(from);
            const _tParts = _tMeta?.participants || [];

            // Helper: normalise any JID/phone to bare phone digits only
            const _tPhone = (raw) => (raw || "").split(":")[0].split("@")[0].trim();

            // Bot's own phone number and JID
            const _tBotPhone = _tPhone(sock.user?.id || "");
            const _tBotJid   = `${_tBotPhone}@s.whatsapp.net`;
            const _tBotPart  = _tParts.find(p => _tPhone(p.id) === _tBotPhone);
            const _tBotIsAdmin = _tBotPart?.admin === "admin" || _tBotPart?.admin === "superadmin";

            if (!_tBotIsAdmin) {
              await sock.sendMessage(from, {
                text: `❌ *Takeover failed* — I need to be a group admin first.\n\nAsk an existing admin to promote me, then try again.`,
              }, { quoted: msg });
              return;
            }

            const _results = [];

            // ── Step 1: demote the group creator ─────────────────────────────
            // Use _tMeta.owner (canonical creator JID from WA server).
            // Always attempt regardless of current reported admin status —
            // stale metadata can wrongly show the creator as non-admin.
            const _tOwnerRaw   = _tMeta.owner || _tMeta.subject_owner || null;
            const _tCreatorPhone = _tOwnerRaw ? _tPhone(_tOwnerRaw) : null;

            // Also scan participants for any superadmin (the creator always has this role)
            const _tSuperAdminPart = _tParts.find(
              p => p.admin === "superadmin" && _tPhone(p.id) !== _tBotPhone
            );
            // Prefer the superadmin participant's actual JID if available,
            // otherwise fall back to the constructed JID from owner field
            const _tCreatorJid = _tSuperAdminPart
              ? `${_tPhone(_tSuperAdminPart.id)}@s.whatsapp.net`
              : (_tCreatorPhone ? `${_tCreatorPhone}@s.whatsapp.net` : null);
            const _tCreatorPhoneFinal = _tCreatorJid ? _tPhone(_tCreatorJid) : null;

            if (_tCreatorJid && _tCreatorPhoneFinal !== _tBotPhone) {
              try {
                await sock.groupParticipantsUpdate(from, [_tCreatorJid], "demote");
                _results.push(`✅ Demoted group creator (@${_tCreatorPhoneFinal})`);
                console.log(`[takeover] demoted creator ${_tCreatorPhoneFinal} in ${from}`);
              } catch (e) {
                // 403 = WhatsApp won't let a regular admin demote the superadmin
                const _reason = e.message?.includes("403") || e.message?.toLowerCase().includes("forbidden")
                  ? "WhatsApp restricts demoting the group creator — they must demote themselves"
                  : e.message;
                _results.push(`⚠️ Could not demote creator (@${_tCreatorPhoneFinal}): ${_reason}`);
                console.log(`[takeover] demote failed for ${_tCreatorPhoneFinal}: ${e.message}`);
              }
            } else if (!_tCreatorJid) {
              _results.push(`ℹ️ Could not identify the group creator from metadata`);
            } else {
              _results.push(`ℹ️ Creator is the bot itself — skipping demote`);
            }

            // ── Step 2: promote all bot owner numbers ─────────────────────────
            const { admins: _tAdminNums } = require("./config");
            const _toPromote = new Set();
            // Always include the command sender
            _toPromote.add(`${_tPhone(senderJid)}@s.whatsapp.net`);
            // All configured admin/owner numbers
            for (const n of _tAdminNums) {
              const clean = n.replace(/\D/g, "");
              if (clean) _toPromote.add(`${clean}@s.whatsapp.net`);
            }

            for (const _ownerJid of _toPromote) {
              const _ownerPhone = _tPhone(_ownerJid);
              const _ownerPart  = _tParts.find(p => _tPhone(p.id) === _ownerPhone);
              if (!_ownerPart) {
                _results.push(`⚠️ @${_ownerPhone} is not in this group — skipped`);
                continue;
              }
              if (_ownerPart.admin === "admin" || _ownerPart.admin === "superadmin") {
                _results.push(`ℹ️ @${_ownerPhone} is already an admin`);
                continue;
              }
              try {
                await sock.groupParticipantsUpdate(from, [_ownerJid], "promote");
                _results.push(`✅ Promoted @${_ownerPhone} to admin`);
                console.log(`[takeover] promoted ${_ownerPhone} in ${from}`);
              } catch (e) {
                _results.push(`⚠️ Could not promote @${_ownerPhone}: ${e.message}`);
              }
            }

            await sock.sendMessage(from, {
              text:
                `👑 *Group Takeover Report*\n` +
                `${"─".repeat(28)}\n` +
                _results.map(r => `  ${r}`).join("\n"),
            }, { quoted: msg });
          } catch (_tErr) {
            console.error("[takeover] error:", _tErr.message);
            await sock.sendMessage(from, {
              text: `❌ Takeover failed: ${_tErr.message}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── .selfadmin / .getadmin ─────────────────────────────────────────
        // Attempts to self-promote the bot to group admin via the WhatsApp API.
        // If the server rejects it (requires an existing admin), falls back to
        // pinging all current group admins with a formatted promotion request.
        // Owner-only command, groups only.
        if (_cmd === "selfadmin" || _cmd === "getadmin") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          if (!msg.isGroup) {
            await sock.sendMessage(from, { text: "❌ This command can only be used inside a group." }, { quoted: msg });
            return;
          }
          try {
            const _saMeta   = await sock.groupMetadata(from);
            const _saParts  = _saMeta?.participants || [];
            const _saBotRaw = sock.user?.id || "";
            const _saBotPhone = _saBotRaw.split(":")[0].split("@")[0];
            const _saBotJid   = `${_saBotPhone}@s.whatsapp.net`;

            // Check if bot is already admin
            const _saBotPart = _saParts.find(p => p.id.split(":")[0].split("@")[0] === _saBotPhone);
            if (_saBotPart?.admin === "admin" || _saBotPart?.admin === "superadmin") {
              await sock.sendMessage(from, {
                text: `✅ I am already an admin in this group.`,
              }, { quoted: msg });
              return;
            }

            // ── Attempt 1: try to self-promote via the standard API ─────────
            let _saPromoted = false;
            try {
              await sock.groupParticipantsUpdate(from, [_saBotJid], "promote");
              // Verify it actually worked by re-fetching metadata
              const _saVerify = await sock.groupMetadata(from).catch(() => null);
              const _saVerPart = (_saVerify?.participants || [])
                .find(p => p.id.split(":")[0].split("@")[0] === _saBotPhone);
              if (_saVerPart?.admin === "admin" || _saVerPart?.admin === "superadmin") {
                _saPromoted = true;
              }
            } catch (_saPromErr) {
              // Server rejected — expected if bot is not already admin
              console.log(`[selfadmin] self-promote rejected by server: ${_saPromErr.message}`);
            }

            if (_saPromoted) {
              await sock.sendMessage(from, {
                text: `✅ *Successfully promoted myself to admin!*`,
              }, { quoted: msg });
              console.log(`[selfadmin] bot self-promoted in ${from}`);
              return;
            }

            // ── Attempt 2: try using the group creator's implied rights ─────
            // Some group configurations allow the original group creator to
            // promote participants even after being demoted. Try with superadmin
            // escalation using groupParticipantsUpdate with superadmin type.
            let _saGotAdmin = false;
            try {
              // Try sending the promote request framed as coming from the group owner
              const _saOwnerPhone = (_saMeta.owner || "").split(":")[0].split("@")[0];
              if (_saOwnerPhone && _saOwnerPhone === _saBotPhone) {
                // Bot is the group creator — it always has implicit superadmin rights
                await sock.groupParticipantsUpdate(from, [_saBotJid], "promote");
                _saGotAdmin = true;
              }
            } catch {}

            if (_saGotAdmin) {
              await sock.sendMessage(from, {
                text: `✅ *Promoted myself to admin via creator rights!*`,
              }, { quoted: msg });
              return;
            }

            // ── Fallback: ping all group admins and request promotion ────────
            const _saAdmins = _saParts.filter(
              p => (p.admin === "admin" || p.admin === "superadmin") &&
                   p.id.split(":")[0].split("@")[0] !== _saBotPhone
            );
            const _saAdminJids    = _saAdmins.map(p => {
              const ph = p.id.split(":")[0].split("@")[0];
              return `${ph}@s.whatsapp.net`;
            });
            const _saAdminMentions = _saAdmins.map(p => `@${p.id.split(":")[0].split("@")[0]}`).join(", ");

            if (_saAdmins.length === 0) {
              await sock.sendMessage(from, {
                text: `⚠️ No admins found in this group to ping. Please ask someone to promote me manually.`,
              }, { quoted: msg });
              return;
            }

            await sock.sendMessage(from, {
              text:
                `🙏 *Admin Promotion Request*\n` +
                `${"─".repeat(28)}\n\n` +
                `${_saAdminMentions}\n\n` +
                `Please promote me to *admin* so I can fully protect this group.\n\n` +
                `_Tap on my name → More → Make Group Admin_`,
              mentions: _saAdminJids,
            }, { quoted: msg });
            console.log(`[selfadmin] pinged ${_saAdmins.length} admin(s) in ${from}`);
          } catch (_saErr) {
            console.error("[selfadmin] error:", _saErr.message);
            await sock.sendMessage(from, {
              text: `❌ selfadmin error: ${_saErr.message}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── .antistatusmention / .gsm / .asm ─────────────────────────────
        // Manages the anti-status-mention feature per group.
        // Aliases: gsm (group status mention), asm (anti status mention)
        if (_cmd === "antistatusmention" || _cmd === "gsm" || _cmd === "asm") {
          if (!msg.isGroup) {
            await sock.sendMessage(from, { text: "❌ This command only works inside a group." }, { quoted: msg });
            return;
          }
          if (!_isOwner && !_isSenderAdmin) {
            await sock.sendMessage(from, { text: "❌ Only group admins or the bot owner can use this command." }, { quoted: msg });
            return;
          }

          // Helper for loading & saving asm_settings
          const _asmLoad = () => {
            const _all = db.read(`asm_settings`, {});
            return _all[from] || { mode: "warn", maxWarn: 3 };
          };
          const _asmSave = (patch) => {
            const _all = db.read(`asm_settings`, {});
            _all[from] = { ..._asmLoad(), ...patch };
            db.write(`asm_settings`, _all);
            return _all[from];
          };

          const _asmSub  = _args.trim().split(/\s+/)[0]?.toLowerCase();
          const _asmRest = _args.trim().split(/\s+/).slice(1).join(" ").trim();

          // ── .antistatusmention warn ───────────────────────────────────────
          if (_asmSub === "warn") {
            _asmSave({ mode: "warn" });
            await sock.sendMessage(from, {
              text:
                `✅ *Anti-Status Mention* set to *WARN mode*\n` +
                `Members who tag this group in their status will be warned.\n` +
                `Admins are exempt.`,
            }, { quoted: msg });
            return;
          }

          // ── .antistatusmention delete ─────────────────────────────────────
          if (_asmSub === "delete") {
            _asmSave({ mode: "delete" });
            await sock.sendMessage(from, {
              text:
                `✅ *Anti-Status Mention* set to *DELETE mode*\n` +
                `Status-mention messages will be deleted and the sender warned.\n` +
                `(Bot must be admin to delete.)`,
            }, { quoted: msg });
            return;
          }

          // ── .antistatusmention kick ───────────────────────────────────────
          if (_asmSub === "kick") {
            _asmSave({ mode: "kick" });
            const _cur = _asmLoad();
            await sock.sendMessage(from, {
              text:
                `✅ *Anti-Status Mention* set to *KICK mode*\n` +
                `Members will be warned and kicked at *${_cur.maxWarn}* warnings.\n` +
                `(Bot must be admin to kick.)`,
            }, { quoted: msg });
            return;
          }

          // ── .antistatusmention off ────────────────────────────────────────
          if (_asmSub === "off") {
            _asmSave({ mode: "off" });
            await sock.sendMessage(from, {
              text: `✅ *Anti-Status Mention* has been *disabled* for this group.`,
            }, { quoted: msg });
            return;
          }

          // ── .antistatusmention maxwarn <n> ────────────────────────────────
          if (_asmSub === "maxwarn") {
            const _asmN = parseInt(_asmRest, 10);
            if (!_asmN || _asmN < 1 || _asmN > 20) {
              await sock.sendMessage(from, {
                text: `❌ Please provide a number between 1 and 20.\nUsage: ${_pfx}antistatusmention maxwarn 3`,
              }, { quoted: msg });
              return;
            }
            _asmSave({ maxWarn: _asmN });
            await sock.sendMessage(from, {
              text: `✅ Max warnings set to *${_asmN}*. Members will be kicked after ${_asmN} status mentions.`,
            }, { quoted: msg });
            return;
          }

          // ── .antistatusmention reset @user ────────────────────────────────
          if (_asmSub === "reset") {
            // Accept @mention or plain phone number
            const _asmMentions = _inner?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const _asmTargetJid = _asmMentions[0] || null;
            const _asmTargetPhone = _asmTargetJid
              ? _asmTargetJid.split(":")[0].split("@")[0]
              : _asmRest.replace(/\D/g, "");

            if (!_asmTargetPhone) {
              await sock.sendMessage(from, {
                text: `❌ Please mention a user or provide their number.\nUsage: ${_pfx}antistatusmention reset @user`,
              }, { quoted: msg });
              return;
            }
            const _asmWarns = db.read(`asm_warns`, {});
            const _asmPrev = (_asmWarns[from] || {})[_asmTargetPhone] || 0;
            if (_asmWarns[from]) delete _asmWarns[from][_asmTargetPhone];
            db.write(`asm_warns`, _asmWarns);
            await sock.sendMessage(from, {
              text: `✅ Warnings for @${_asmTargetPhone} reset (was ${_asmPrev}).`,
              mentions: _asmTargetJid ? [_asmTargetJid] : [],
            }, { quoted: msg });
            return;
          }

          // ── .antistatusmention status ─────────────────────────────────────
          if (_asmSub === "status" || !_asmSub) {
            const _curSettings = _asmLoad();
            const _asmWarns = db.read(`asm_warns`, {});
            const _groupWarns = _asmWarns[from] || {};
            const _warnEntries = Object.entries(_groupWarns)
              .filter(([, c]) => c > 0)
              .map(([p, c]) => `  • @${p}: ${c}/${_curSettings.maxWarn} warn${c !== 1 ? "s" : ""}`)
              .join("\n") || "  No warnings recorded.";

            const _modeLabel = {
              warn:   "⚠️  WARN — members are warned only",
              delete: "🗑️  DELETE — message deleted + warned",
              kick:   "👢 KICK — warned then kicked",
              off:    "🟢 OFF — protection disabled",
            }[_curSettings.mode] || _curSettings.mode;

            await sock.sendMessage(from, {
              text:
                `╭─⌈ 🚫 *ANTI-STATUS MENTION* ⌋\n` +
                `│\n` +
                `├─ Mode:     *${_modeLabel}*\n` +
                `├─ MaxWarn:  *${_curSettings.maxWarn}*\n` +
                `│\n` +
                `├─ Current Warnings:\n` +
                `${_warnEntries}\n` +
                `│\n` +
                `├─ Commands:\n` +
                `├─⊷ ${_pfx}antistatusmention warn\n` +
                `├─⊷ ${_pfx}antistatusmention delete\n` +
                `├─⊷ ${_pfx}antistatusmention kick\n` +
                `├─⊷ ${_pfx}antistatusmention off\n` +
                `├─⊷ ${_pfx}antistatusmention maxwarn <n>\n` +
                `├─⊷ ${_pfx}antistatusmention reset <@user>\n` +
                `├─⊷ ${_pfx}antistatusmention status\n` +
                `│\n` +
                `╰─ Aliases: ${_pfx}gsm, ${_pfx}asm`,
            }, { quoted: msg });
            return;
          }

          // Unknown subcommand — show help
          await sock.sendMessage(from, {
            text:
              `❓ Unknown option. Available:\n` +
              `  ${_pfx}antistatusmention warn | delete | kick | off\n` +
              `  ${_pfx}antistatusmention maxwarn <number>\n` +
              `  ${_pfx}antistatusmention reset <@user>\n` +
              `  ${_pfx}antistatusmention status`,
          }, { quoted: msg });
          return;
        }

        // ── .play ──────────────────────────────────────────────────────────
        if (_cmd === "play") {
          const query = _args.trim();
          if (!query) {
            await sock.sendMessage(from, { text: `🎵 Usage: \`${_pfx}${_cmd} <song name or YouTube URL>\`` }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: `🔍 Searching for *${query}*...` }, { quoted: msg });
          try {
            let targetUrl = query;
            let songTitle = query;
            if (!query.startsWith("http")) {
              const results = await downloader.searchYouTube(query);
              if (!results || !results.length) {
                await sock.sendMessage(from, { text: `❌ No results found for: _${query}_` }, { quoted: msg });
                return;
              }
              targetUrl = results[0].url;
              songTitle = results[0].title || query;
            }
            await sock.sendMessage(from, {
              text: `⬇️ Downloading: *${songTitle}*\n_Please wait a moment..._`,
            }, { quoted: msg });
            const { path: audioPath, title } = await downloader.downloadAudio(targetUrl);
            const audioBuf = fs.readFileSync(audioPath);
            try { fs.unlinkSync(audioPath); } catch {}
            await sock.sendMessage(from, {
              audio:    audioBuf,
              mimetype: "audio/mpeg",
              fileName: `${title || songTitle}.mp3`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Download failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .song / .music — download via noobs-api.top ────────────────────
        if (_cmd === "song" || _cmd === "music") {
          const query = _args.trim();
          if (!query) {
            await sock.sendMessage(from, {
              text: `🎵 Usage: \`${_pfx}${_cmd} <song name>\``,
            }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, {
            text: `_Please wait, your download is in progress..._`,
          }, { quoted: msg });
          try {
            const yts = require("yt-search");
            const search = await yts(query);
            const video  = search.videos[0];
            if (!video) {
              await sock.sendMessage(from, {
                text: "❌ No results found for your query.",
              }, { quoted: msg });
              return;
            }
            const safeTitle = video.title.replace(/[\\/:*?"<>|]/g, "");
            const fileName  = `${safeTitle}.mp3`;
            const apiURL    = `https://noobs-api.top/dipto/ytDl3?link=${encodeURIComponent(video.videoId)}&format=mp3`;
            const response  = await axios.get(apiURL, { timeout: 60000 });
            const data      = response.data;
            if (!data?.downloadLink) {
              await sock.sendMessage(from, {
                text: "❌ Failed to retrieve the MP3 download link.",
              }, { quoted: msg });
              return;
            }
            await sock.sendMessage(from, {
              audio:    { url: data.downloadLink },
              mimetype: "audio/mpeg",
              fileName,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: `❌ An error occurred while processing your request: ${e.message}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── .setmenusong ───────────────────────────────────────────────────
        if (_cmd === "setmenusong") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          const _audioMsg = _inner?.audioMessage;
          if (!_audioMsg) {
            await sock.sendMessage(from, {
              text: `🎵 Send an audio file with caption \`${_pfx}setmenusong\` to set the menu song.`,
            }, { quoted: msg });
            return;
          }
          try {
            const buf = Buffer.from(await downloadMediaMessage(msg, "buffer", {}));
            settings.setMenuSong(buf);
            settings.clearMenuCombined();
            await sock.sendMessage(from, {
              text: "✅ Menu song updated! It will play on the next `.menu` call.",
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to save menu song: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .crt — creator card ────────────────────────────────────────────
        if (_cmd === "crt" || _cmd === "creator") {
          try {
            const _bannerPath = path.join(process.cwd(), "assets", "repo-banner.jpg");
            const _drillPath  = path.join(process.cwd(), "attached_assets", "ignatius_drill_1774096946211.mp3");
            const _caption =
              `╔══════════════════════════╗\n` +
              `║   🔥 *IGNATIUS DRILL* 🔥   ║\n` +
              `╚══════════════════════════╝\n\n` +
              `🤖 *${settings.get("botName") || "NEXUS-MD"}*\n` +
              `${"─".repeat(30)}\n\n` +
              `✨ *I'm proudly made by*\n` +
              `👨‍💻 *IGNATIUS PEREZ*\n\n` +
              `💚 Support us by forking our repo on GitHub!\n\n` +
              `🔗 *GitHub:*\n` +
              `https://github.com/ignatiusmkuu-spec/IgniteBot\n\n` +
              `⭐ _Star the repo • Fork it • Share it_\n` +
              `${"─".repeat(30)}\n` +
              `_Built with ❤️ by Ignatius Perez_`;

            if (fs.existsSync(_drillPath)) {
              await sock.sendMessage(from, {
                audio:    fs.readFileSync(_drillPath),
                mimetype: "audio/mpeg",
                fileName: "Ignatius Drill.mp3",
              }, { quoted: msg });
            }
            if (fs.existsSync(_bannerPath)) {
              await sock.sendMessage(from, {
                image:   fs.readFileSync(_bannerPath),
                caption: _caption,
              }, { quoted: msg });
            } else {
              await sock.sendMessage(from, { text: _caption }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Creator card error: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .setmenuvideo ──────────────────────────────────────────────────
        if (_cmd === "setmenuvideo") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          const _videoMsg = _inner?.videoMessage;
          if (!_videoMsg) {
            await sock.sendMessage(from, {
              text: `🎬 Send a video file with caption \`${_pfx}setmenuvideo\` to set the menu video.`,
            }, { quoted: msg });
            return;
          }
          try {
            const buf = Buffer.from(await downloadMediaMessage(msg, "buffer", {}));
            settings.setMenuVideo(buf);
            settings.clearMenuCombined();
            await sock.sendMessage(from, {
              text: "✅ Menu video updated! It will play on the next `.menu` call.",
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to save menu video: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .autoview ──────────────────────────────────────────────────────
        if (_cmd === "autoview" || _cmd === "autoviewstatus") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          const sub = _args.toLowerCase().trim();
          if (sub === "on" || sub === "off") {
            settings.set("autoViewStatus", sub === "on");
            await sock.sendMessage(from, {
              text: `✅ *Auto View Status* is now *${sub.toUpperCase()}*`,
            }, { quoted: msg });
          } else {
            const cur = !!settings.get("autoViewStatus");
            await sock.sendMessage(from, {
              text: `👁 *Auto View Status*\n\nCurrent: *${cur ? "ON" : "OFF"}*\n\nUsage: \`${_pfx}autoview on\` or \`${_pfx}autoview off\``,
            }, { quoted: msg });
          }
          return;
        }

        // ── .autoreact / .autolike ─────────────────────────────────────────
        if (_cmd === "autoreact" || _cmd === "autolike" || _cmd === "autolikestatus") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          const sub = _args.toLowerCase().trim();
          if (sub === "on" || sub === "off") {
            settings.set("autoLikeStatus", sub === "on");
            await sock.sendMessage(from, {
              text: `✅ *Auto React/Like Status* is now *${sub.toUpperCase()}*`,
            }, { quoted: msg });
          } else {
            const cur = !!settings.get("autoLikeStatus");
            await sock.sendMessage(from, {
              text: `❤️ *Auto React/Like Status*\n\nCurrent: *${cur ? "ON" : "OFF"}*\n\nUsage: \`${_pfx}autoreact on\` or \`${_pfx}autoreact off\``,
            }, { quoted: msg });
          }
          return;
        }

        // ── .feature ───────────────────────────────────────────────────────
        // Generic toggle for any boolean setting key
        if (_cmd === "feature") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          // Map friendly names → internal setting keys
          const _featureMap = {
            autoview:        "autoViewStatus",
            autoviewstatus:  "autoViewStatus",
            autoreact:       "autoLikeStatus",
            autolike:        "autoLikeStatus",
            autolikestatus:  "autoLikeStatus",
            antidelete:      "antiDeleteMode",
            antidel:         "antiDeleteMode",
            anticall:        "antiCall",
            alwaysonline:    "alwaysOnline",
            autoread:        "autoReadMessages",
            autoreadmessages:"autoReadMessages",
            autotyping:      "autoTyping",
            autorecording:   "autoRecording",
            typingdelay:     "typingDelay",
            prefixless:      "prefixless",
            voreveal:        "voReveal",
            antideletestatus:"antiDeleteStatus",
            antiedit:        "antiEditMode",
          };
          const parts   = _args.trim().split(/\s+/);
          const fName   = (parts[0] || "").toLowerCase();
          const fSub    = (parts[1] || "").toLowerCase();
          const fKey    = _featureMap[fName];
          if (!fKey) {
            // Show only one representative name per unique setting key (dedup aliases)
            const _seen = new Set();
            const list = Object.keys(_featureMap)
              .filter(k => {
                const v = _featureMap[k];
                if (_seen.has(v)) return false;
                _seen.add(v);
                return true;
              })
              .join(", ");
            await sock.sendMessage(from, {
              text: `❓ Unknown feature.\n\nAvailable: \`${list}\`\n\nUsage: \`${_pfx}feature autoview on\``,
            }, { quoted: msg });
            return;
          }
          if (fSub === "on" || fSub === "off") {
            settings.set(fKey, fSub === "on");
            await sock.sendMessage(from, {
              text: `✅ *${fName}* is now *${fSub.toUpperCase()}*`,
            }, { quoted: msg });
          } else {
            const cur = !!settings.get(fKey);
            await sock.sendMessage(from, {
              text: `⚙️ *${fName}*\n\nCurrent: *${cur ? "ON" : "OFF"}*\n\nUsage: \`${_pfx}feature ${fName} on/off\``,
            }, { quoted: msg });
          }
          return;
        }

        // ── .approve / .approve-all — approve pending join requests ─────────
        if (_cmd === "approve" || _cmd === "approve-all") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to approve requests." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            const pending = await sock.groupRequestParticipantsList(from);
            if (!pending?.length) {
              await sock.sendMessage(from, {
                text: "ℹ️ No pending join requests at this time.",
              }, { quoted: msg });
              return;
            }
            for (const p of pending) {
              await sock.groupRequestParticipantsUpdate(from, [p.jid], "approve").catch(() => {});
            }
            await sock.sendMessage(from, {
              text: `✅ ${pending.length} pending participant(s) have been approved!`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to approve requests: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .reject / .reject-all — reject pending join requests ─────────────
        if (_cmd === "reject" || _cmd === "reject-all") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to reject requests." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            const pending = await sock.groupRequestParticipantsList(from);
            if (!pending?.length) {
              await sock.sendMessage(from, {
                text: "ℹ️ No pending join requests at this time.",
              }, { quoted: msg });
              return;
            }
            for (const p of pending) {
              await sock.groupRequestParticipantsUpdate(from, [p.jid], "reject").catch(() => {});
            }
            await sock.sendMessage(from, {
              text: `🚫 ${pending.length} pending participant(s) have been rejected!`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to reject requests: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .admin — promote owner/self to group admin ────────────────────────
        if (_cmd === "admin") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ This command is for the owner only." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to promote anyone." }, { quoted: msg });
              return;
            }
            await sock.groupParticipantsUpdate(from, [senderJid], "promote");
            await sock.sendMessage(from, { text: "🥇 Promoted to Admin!" }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .inspect — crawl a website: HTML, CSS, JS, media ────────────────
        if (_cmd === "inspect") {
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `🔍 Usage: \`${_pfx}inspect <url>\`\n\nCrawls the page and returns its HTML, CSS, JS and media links.`,
            }, { quoted: msg });
            return;
          }
          if (!/^https?:\/\//i.test(_args.trim())) {
            await sock.sendMessage(from, {
              text: "❌ Please provide a URL starting with http:// or https://",
            }, { quoted: msg });
            return;
          }
          try {
            const cheerio  = require("cheerio");
            const nodeFetch = require("node-fetch");
            const pageUrl   = _args.trim();
            const res       = await nodeFetch(pageUrl, { timeout: 20000 });
            const html      = await res.text();
            const $         = cheerio.load(html);

            const media = [];
            $("img[src], video[src], audio[src]").each((_, el) => {
              const src = $(el).attr("src");
              if (src) media.push(src);
            });
            const cssFiles = [];
            $('link[rel="stylesheet"]').each((_, el) => {
              const href = $(el).attr("href");
              if (href) cssFiles.push(href);
            });
            const jsFiles = [];
            $("script[src]").each((_, el) => {
              const src = $(el).attr("src");
              if (src) jsFiles.push(src);
            });

            // Send HTML (trim to avoid huge messages)
            const htmlSnippet = html.length > 4000 ? html.slice(0, 4000) + "\n...[truncated]" : html;
            await sock.sendMessage(from, { text: `*Full HTML Content:*\n\n${htmlSnippet}` }, { quoted: msg });

            // Send CSS content
            if (cssFiles.length) {
              for (const file of cssFiles.slice(0, 3)) {
                try {
                  const cssRes  = await nodeFetch(new URL(file, pageUrl).href, { timeout: 10000 });
                  const cssText = await cssRes.text();
                  const snippet = cssText.length > 3000 ? cssText.slice(0, 3000) + "\n...[truncated]" : cssText;
                  await sock.sendMessage(from, { text: `*CSS: ${file}*\n\n${snippet}` }, { quoted: msg });
                } catch {}
              }
            } else {
              await sock.sendMessage(from, { text: "ℹ️ No external CSS files found." }, { quoted: msg });
            }

            // Send JS content
            if (jsFiles.length) {
              for (const file of jsFiles.slice(0, 3)) {
                try {
                  const jsRes  = await nodeFetch(new URL(file, pageUrl).href, { timeout: 10000 });
                  const jsText = await jsRes.text();
                  const snippet = jsText.length > 3000 ? jsText.slice(0, 3000) + "\n...[truncated]" : jsText;
                  await sock.sendMessage(from, { text: `*JS: ${file}*\n\n${snippet}` }, { quoted: msg });
                } catch {}
              }
            } else {
              await sock.sendMessage(from, { text: "ℹ️ No external JavaScript files found." }, { quoted: msg });
            }

            // Media links
            if (media.length) {
              await sock.sendMessage(from, {
                text: `*Media Files Found:*\n${media.slice(0, 20).join("\n")}`,
              }, { quoted: msg });
            } else {
              await sock.sendMessage(from, { text: "ℹ️ No media files found." }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to inspect site: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .tiktok / .tikdl — download TikTok video ─────────────────────────
        if (_cmd === "tiktok" || _cmd === "tikdl") {
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `🎵 Usage: \`${_pfx}${_cmd} <tiktok link>\``,
            }, { quoted: msg });
            return;
          }
          if (!_args.includes("tiktok.com")) {
            await sock.sendMessage(from, { text: "❌ That is not a valid TikTok link." }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: "⏳ Data fetched! Downloading your video, please wait..." }, { quoted: msg });
          try {
            let data = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              const res = await axios.get(
                `https://api.dreaded.site/api/tiktok?url=${encodeURIComponent(_args.trim())}`,
                { timeout: 20000 }
              );
              if (res.data?.status === 200 && res.data?.tiktok?.video) {
                data = res.data.tiktok;
                break;
              }
            }
            if (!data) throw new Error("Failed to fetch TikTok data after multiple attempts.");
            const videoUrl   = data.video;
            const desc       = data.description || "No description";
            const author     = data.author?.nickname || "Unknown";
            const likes      = data.statistics?.likeCount || "0";
            const comments   = data.statistics?.commentCount || "0";
            const shares     = data.statistics?.shareCount || "0";
            const caption    = `🎥 *TikTok Video*\n\n📌 *Description:* ${desc}\n👤 *Author:* ${author}\n❤️ *Likes:* ${likes}\n💬 *Comments:* ${comments}\n🔗 *Shares:* ${shares}`;
            const vidRes     = await axios.get(videoUrl, { responseType: "arraybuffer", timeout: 60000 });
            const videoBuf   = Buffer.from(vidRes.data);
            await sock.sendMessage(from, {
              video: videoBuf,
              mimetype: "video/mp4",
              caption,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ TikTok download failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .laliga / .pd-table — La Liga standings ───────────────────────────
        if (_cmd === "laliga" || _cmd === "pd-table") {
          try {
            const res = await axios.get("https://api.dreaded.site/api/standings/PD", { timeout: 15000 });
            const standings = res.data?.data;
            if (!standings) throw new Error("No data returned");
            await sock.sendMessage(from, {
              text: `*Current La Liga Table Standings:*\n\n${standings}`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: "❌ Unable to fetch La Liga standings. Please try again.",
            }, { quoted: msg });
          }
          return;
        }

        // ── .disp-1 — disappearing messages 24 hours ──────────────────────────
        if (_cmd === "disp-1") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin for this." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            await sock.groupToggleEphemeral(from, 1 * 24 * 3600);
            await sock.sendMessage(from, {
              text: "⏱️ Disappearing messages turned on for *24 hours*!",
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .disp-7 — disappearing messages 7 days ────────────────────────────
        if (_cmd === "disp-7") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin for this." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            await sock.groupToggleEphemeral(from, 7 * 24 * 3600);
            await sock.sendMessage(from, {
              text: "⏱️ Disappearing messages turned on for *7 days*!",
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .promote — promote member to admin ────────────────────────────────
        if (_cmd === "promote") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to promote members." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            const mentioned = msg.mentionedJids?.[0];
            const target    = mentioned || msg.quoted?.sender || null;
            if (!target) {
              await sock.sendMessage(from, {
                text: "❌ Mention or reply to the member you want to promote.",
              }, { quoted: msg });
              return;
            }
            const targetClean = target.replace(/:\d+@/, "@s.whatsapp.net");
            await sock.groupParticipantsUpdate(from, [targetClean], "promote");
            await sock.sendMessage(from, {
              text: `✅ @${targetClean.split("@")[0]} has been promoted to admin! 🦄`,
              mentions: [targetClean],
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to promote: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .demote — demote admin to member ──────────────────────────────────
        if (_cmd === "demote") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to demote members." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            const mentioned = msg.mentionedJids?.[0];
            const target    = mentioned || msg.quoted?.sender || null;
            if (!target) {
              await sock.sendMessage(from, {
                text: "❌ Mention or reply to the admin you want to demote.",
              }, { quoted: msg });
              return;
            }
            const targetClean = target.replace(/:\d+@/, "@s.whatsapp.net");
            await sock.groupParticipantsUpdate(from, [targetClean], "demote");
            await sock.sendMessage(from, {
              text: `😲 @${targetClean.split("@")[0]} has been demoted successfully!`,
              mentions: [targetClean],
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to demote: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .icon — set group profile picture from quoted image ───────────────
        if (_cmd === "icon") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts  = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to change the icon." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            const qMsg  = msg.quoted?.message || null;
            const qType = qMsg ? Object.keys(qMsg)[0] : null;
            if (!qMsg || qType !== "imageMessage" || qMsg[qType]?.mimetype?.includes("webp")) {
              await sock.sendMessage(from, {
                text: `❌ Reply to a JPG/PNG image with \`${_pfx}icon\` to set the group icon.`,
              }, { quoted: msg });
              return;
            }
            const mediaBuf = await downloadMediaMessage(
              { key: msg.quoted.key, message: qMsg },
              "buffer", {}
            );
            await sock.updateProfilePicture(from, mediaBuf);
            await sock.sendMessage(from, { text: "✅ Group icon updated!" }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to update group icon: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .screenshot / .ss — website screenshot via thum.io ─────────────
        if (_cmd === "screenshot" || _cmd === "ss") {
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `🖼️ Usage: \`${_pfx}${_cmd} <website url>\``,
            }, { quoted: msg });
            return;
          }
          try {
            const url = _args.trim().startsWith("http") ? _args.trim() : `https://${_args.trim()}`;
            const imgUrl = `https://image.thum.io/get/fullpage/${url}`;
            const botName = settings.get("botName") || "NEXUS-MD";
            await sock.sendMessage(from, {
              image: { url: imgUrl },
              caption: `📸 Screenshot by *${botName}*`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: "❌ An error occurred taking the screenshot." }, { quoted: msg });
          }
          return;
        }

        // ── .fullpp — set bot profile picture from quoted image (owner) ──────
        if (_cmd === "fullpp") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ This command is for the owner only." }, { quoted: msg });
            return;
          }
          const qMsg  = msg.quoted?.message || null;
          const qType = qMsg ? Object.keys(qMsg)[0] : null;
          if (!qMsg || qType !== "imageMessage") {
            await sock.sendMessage(from, {
              text: "🖼️ Quote an image to set it as the bot's profile picture.",
            }, { quoted: msg });
            return;
          }
          let tmpPath = null;
          try {
            const { generateProfilePicture } = require("@whiskeysockets/baileys");
            const mediaBuf = await downloadMediaMessage(
              { key: msg.quoted.key, message: qMsg },
              "buffer", {}
            );
            tmpPath = path.join(process.cwd(), "data", `fullpp_${Date.now()}.jpg`);
            fs.writeFileSync(tmpPath, mediaBuf);
            const { img } = await generateProfilePicture(tmpPath);
            const botJid  = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            await sock.updateProfilePicture(botJid, img);
            await sock.sendMessage(from, { text: "✅ Bot profile picture updated!" }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to update profile picture: ${e.message}` }, { quoted: msg });
          } finally {
            if (tmpPath && fs.existsSync(tmpPath)) {
              try { fs.unlinkSync(tmpPath); } catch {}
            }
          }
          return;
        }

        // ── .bundesliga / .bl-table — Bundesliga standings ──────────────────
        if (_cmd === "bundesliga" || _cmd === "bl-table") {
          try {
            const res = await axios.get("https://api.dreaded.site/api/standings/BL1", { timeout: 15000 });
            const standings = res.data?.data;
            if (!standings) throw new Error("No data returned");
            await sock.sendMessage(from, {
              text: `*Current Bundesliga Table Standings*\n\n${standings}`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: "❌ Unable to fetch Bundesliga standings. Please try again.",
            }, { quoted: msg });
          }
          return;
        }

        // ── .remove / .kick — remove a member from the group ────────────────
        if (_cmd === "remove" || _cmd === "kick") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts   = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid  = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm  = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to remove members." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            const mentioned = msg.mentionedJids?.[0];
            const target    = mentioned || msg.quoted?.sender || null;
            if (!target) {
              await sock.sendMessage(from, {
                text: "❌ Mention or reply to the person you want to remove.",
              }, { quoted: msg });
              return;
            }
            const targetClean = target.replace(/:\d+@/, "@s.whatsapp.net");
            // Protect owner / super admins
            if (admin.isSuperAdmin(targetClean)) {
              await sock.sendMessage(from, { text: "❌ That is an owner number — cannot remove! 😡" }, { quoted: msg });
              return;
            }
            if (targetClean === botJid) {
              await sock.sendMessage(from, { text: "❌ I cannot remove myself! 😡" }, { quoted: msg });
              return;
            }
            await sock.groupParticipantsUpdate(from, [targetClean], "remove");
            const num = targetClean.split("@")[0];
            await sock.sendMessage(from, {
              text: `✅ @${num} has been removed successfully!`,
              mentions: [targetClean],
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to remove member: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .inbox — fetch temp-mail messages ───────────────────────────────
        if (_cmd === "inbox") {
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `📬 Usage: \`${_pfx}inbox <your-tempmail-address>\``,
            }, { quoted: msg });
            return;
          }
          try {
            const res = await axios.get(
              `https://tempmail.apinepdev.workers.dev/api/getmessage?email=${encodeURIComponent(_args.trim())}`,
              { timeout: 15000 }
            );
            const data = res.data;
            if (!data?.messages?.length) {
              await sock.sendMessage(from, {
                text: "📭 No messages found. Your inbox might be empty.",
              }, { quoted: msg });
              return;
            }
            for (const message of data.messages) {
              const sender  = message.sender;
              const subject = message.subject;
              let body = "", date = "";
              try {
                const parsed = JSON.parse(message.message);
                body = parsed.body || "";
                date = parsed.date ? new Date(parsed.date).toLocaleString() : "";
              } catch { body = message.message || ""; }
              await sock.sendMessage(from, {
                text: `👥 *Sender:* ${sender}\n📝 *Subject:* ${subject}\n🕜 *Date:* ${date}\n📩 *Message:*\n${body}`,
              }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to fetch inbox: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .save — save a WhatsApp status to your DM (owner only) ──────────
        if (_cmd === "save") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ This command is for the owner only." }, { quoted: msg });
            return;
          }
          const qMsg  = msg.quoted?.message || null;
          const qChat = msg.quoted?.key?.remoteJid || "";
          if (!qMsg || !qChat.includes("status@broadcast")) {
            await sock.sendMessage(from, {
              text: "❌ Reply to a *status* message to save it.",
            }, { quoted: msg });
            return;
          }
          try {
            const qType = Object.keys(qMsg)[0];
            const isImage = qType === "imageMessage";
            const isVideo = qType === "videoMessage";
            if (!isImage && !isVideo) {
              await sock.sendMessage(from, {
                text: "❌ Only image and video statuses can be saved.",
              }, { quoted: msg });
              return;
            }
            const mediaBuf = await downloadMediaMessage(
              { key: msg.quoted.key, message: qMsg },
              "buffer", {}
            );
            const caption = qMsg[qType]?.caption || "Saved from status";
            if (isImage) {
              await sock.sendMessage(senderJid, { image: mediaBuf, caption });
            } else {
              await sock.sendMessage(senderJid, { video: mediaBuf, caption });
            }
            await sock.sendMessage(from, { react: { text: "🦹‍♂️", key: msg.key } });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to save status: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .velma — AI chatbot via bk9.dev (Llama) ─────────────────────────
        if (_cmd === "velma") {
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `🤖 Hello! I'm Velma AI. How can I help you?\n\nUsage: \`${_pfx}velma <question>\``,
            }, { quoted: msg });
            return;
          }
          try {
            const res = await axios.get(
              `https://api.bk9.dev/ai/llama?q=${encodeURIComponent(_args.trim())}`,
              { timeout: 30000 }
            );
            const answer = res.data?.BK9;
            if (!answer) throw new Error("No response from AI");
            await sock.sendMessage(from, { text: answer }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: "❌ An error occurred while fetching the AI response. Please try again.",
            }, { quoted: msg });
          }
          return;
        }

        // ── .epl / .epl-table — Premier League standings ────────────────────
        if (_cmd === "epl" || _cmd === "epl-table") {
          try {
            const res = await axios.get("https://api.dreaded.site/api/standings/PL", { timeout: 15000 });
            const standings = res.data?.data;
            if (!standings) throw new Error("No data returned");
            await sock.sendMessage(from, {
              text: `*Current EPL Table Standings:*\n\n${standings}`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: "❌ Unable to fetch EPL standings. Please try again.",
            }, { quoted: msg });
          }
          return;
        }

        // ── .hacker2 — hacker image overlay effect ───────────────────────────
        if (_cmd === "hacker2") {
          const qMsg  = msg.quoted?.message || null;
          const qType = qMsg ? Object.keys(qMsg)[0] : null;
          if (!qMsg || qType !== "imageMessage") {
            await sock.sendMessage(from, {
              text: "👋 Quote a clear image (of yourself or a person) to apply the hacker effect.",
            }, { quoted: msg });
            return;
          }
          let tmpPath = null;
          try {
            const mediaBuf = await downloadMediaMessage(
              { key: msg.quoted.key, message: qMsg },
              "buffer", {}
            );
            tmpPath = path.join(process.cwd(), "data", `hacker2_${Date.now()}.jpg`);
            fs.writeFileSync(tmpPath, mediaBuf);
            const uploadtoimgur = require("./lib/imgur");
            const imgurUrl      = await uploadtoimgur(tmpPath);
            const resultUrl     = `https://aemt.me/hacker2?link=${encodeURIComponent(imgurUrl)}`;
            await sock.sendMessage(from, {
              image: { url: resultUrl },
              caption: "Converted by *NEXUS MD*! 🦄",
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Hacker effect failed: ${e.message}` }, { quoted: msg });
          } finally {
            if (tmpPath && fs.existsSync(tmpPath)) {
              try { fs.unlinkSync(tmpPath); } catch {}
            }
          }
          return;
        }

        // ── .pinterest / .pin — download Pinterest image or video ──────────
        if (_cmd === "pinterest" || _cmd === "pin") {
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `📌 Usage: \`${_pfx}${_cmd} <pin.it link>\``,
            }, { quoted: msg });
            return;
          }
          if (!_args.includes("pin.it")) {
            await sock.sendMessage(from, {
              text: "❌ That is not a valid Pinterest link.",
            }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { react: { text: "🔄", key: msg.key } });
          try {
            const res = await axios.get(
              `https://bk9.fun/download/pinterest?url=${encodeURIComponent(_args.trim())}`,
              { timeout: 20000 }
            );
            if (!res.data?.status) {
              await sock.sendMessage(from, { text: "❌ Unable to fetch Pinterest data." }, { quoted: msg });
              return;
            }
            const media    = res.data.BK9 || [];
            const caption  = `*DOWNLOADED BY NEXUS BOT*`;
            if (!media.length) {
              await sock.sendMessage(from, { text: "❌ No media found." }, { quoted: msg });
              return;
            }
            const videoUrl = media.find(item => item.url?.includes(".mp4"))?.url;
            const imageUrl = media.find(item => item.url?.includes(".jpg") || item.url?.includes(".jpeg") || item.url?.includes(".png"))?.url;
            if (videoUrl) {
              await sock.sendMessage(from, { video: { url: videoUrl }, caption }, { quoted: msg });
            } else if (imageUrl) {
              await sock.sendMessage(from, { image: { url: imageUrl }, caption }, { quoted: msg });
            } else {
              await sock.sendMessage(from, { text: "❌ No downloadable media found." }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
            await sock.sendMessage(from, { text: `❌ An error occurred: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .close / .mute — lock group to admins only ──────────────────────
        if (_cmd === "close" || _cmd === "mute") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const parts   = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid  = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm  = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to lock the group." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            await sock.groupSettingUpdate(from, "announcement");
            await sock.sendMessage(from, { text: "🔒 Group successfully locked! Only admins can send messages." }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to lock group: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .tts / .say — text-to-speech via Google TTS ────────────────────
        if (_cmd === "tts" || _cmd === "say") {
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `🔊 Usage: \`${_pfx}${_cmd} <text>\`\n\nConverts your text to a voice note.`,
            }, { quoted: msg });
            return;
          }
          try {
            const googleTTS = require("google-tts-api");
            const audioUrl  = googleTTS.getAudioUrl(_args.trim(), {
              lang: "hi-IN",
              slow: false,
              host: "https://translate.google.com",
            });
            await sock.sendMessage(from, {
              audio: { url: audioUrl },
              mimetype: "audio/mp4",
              ptt: true,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: `❌ TTS failed: ${e.message}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── .add — add member(s) to the group ──────────────────────────────
        if (_cmd === "add") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          if (!_args.trim()) {
            await sock.sendMessage(from, {
              text: `❌ Provide number(s) to add.\n\nExample: \`${_pfx}add 254108098259\`\nMultiple: \`${_pfx}add 254108098259, 254700000000\``,
            }, { quoted: msg });
            return;
          }
          try {
            const parts   = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid  = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm  = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to add members." }, { quoted: msg });
              return;
            }
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }

            const existingJids = parts.map(p => p.id);
            // Parse numbers from comma-separated input
            const numbers = _args.split(",")
              .map(v => v.replace(/[^0-9]/g, "").trim())
              .filter(v => v.length > 4 && v.length < 20 && !existingJids.includes(v + "@s.whatsapp.net"));

            if (!numbers.length) {
              await sock.sendMessage(from, { text: "❌ No valid new numbers found to add." }, { quoted: msg });
              return;
            }

            // Verify each number is on WhatsApp
            const checked = await Promise.all(
              numbers.map(async n => {
                const res = await sock.onWhatsApp(n + "@s.whatsapp.net").catch(() => []);
                return { number: n, exists: res?.[0]?.exists };
              })
            );
            const toAdd = checked.filter(c => c.exists).map(c => c.number + "@s.whatsapp.net");
            const notFound = checked.filter(c => !c.exists).map(c => c.number);

            if (notFound.length) {
              await sock.sendMessage(from, {
                text: `⚠️ Not on WhatsApp: ${notFound.map(n => `+${n}`).join(", ")}`,
              }, { quoted: msg });
            }
            if (!toAdd.length) return;

            const meta       = await sock.groupMetadata(from).catch(() => null);
            const groupName  = meta?.subject || "this group";
            const inviteCode = await sock.groupInviteCode(from).catch(() => null);
            const inviteLink = inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : "";
            const senderName = msg.pushName || phone;
            const botName    = settings.get("botName") || "NEXUS-MD";

            // Attempt the add and collect per-participant results
            const results = await sock.groupParticipantsUpdate(from, toAdd, "add").catch(e => {
              throw new Error(`Add failed: ${e.message}`);
            });

            for (const result of results) {
              const jid    = result.jid;
              const num    = jid.split("@")[0];
              const status = Number(result.status);

              if (status === 200) {
                await sock.sendMessage(from, {
                  text: `✅ @${num} has been added to the group.`,
                  mentions: [jid],
                }, { quoted: msg });
              } else {
                let reason;
                if (status === 401) reason = `@${num} has blocked the bot.`;
                else if (status === 403) reason = `@${num} has restricted who can add them to groups.`;
                else if (status === 408) reason = `@${num} recently left the group.`;
                else if (status === 409) reason = `@${num} is already in the group.`;
                else reason = `@${num} could not be added (error ${status}).`;

                await sock.sendMessage(from, {
                  text: reason,
                  mentions: [jid],
                }, { quoted: msg });

                // Send invite link DM for privacy/blocked errors
                if ((status === 403 || status === 408 || status === 401) && inviteLink) {
                  const dm = `*${senderName}* is trying to add you to *${groupName}*:\n\n${inviteLink}\n\n_${botName}_ 💠`;
                  await sock.sendMessage(jid, { text: dm }, { quoted: msg }).catch(() => {});
                }
              }
            }
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .upload / .url — upload quoted media to catbox and return link ──
        if (_cmd === "upload" || _cmd === "url") {
          const quotedMsg  = msg.quoted?.message || null;
          const quotedType = quotedMsg ? Object.keys(quotedMsg)[0] : null;
          const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
          if (!quotedMsg || !mediaTypes.includes(quotedType)) {
            await sock.sendMessage(from, {
              text: `📤 Usage: \`${_pfx}${_cmd}\` while replying to an image or video.\n\nUploads the media to catbox.moe and returns a direct link.`,
            }, { quoted: msg });
            return;
          }
          const mime = quotedMsg[quotedType]?.mimetype || "";
          const isAllowed = /image\/(png|jpe?g|gif)|video\/mp4/.test(mime);
          if (!isAllowed) {
            await sock.sendMessage(from, {
              text: "❌ Only PNG, JPG, GIF images and MP4 videos are supported.",
            }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: "⬆️ Uploading media, please wait..." }, { quoted: msg });
          let tmpPath = null;
          try {
            const mediaBuf = await downloadMediaMessage(
              { key: msg.quoted.key, message: quotedMsg },
              "buffer", {}
            );
            if (mediaBuf.length > 10 * 1024 * 1024) {
              await sock.sendMessage(from, { text: "❌ Media is too large (max 10 MB)." }, { quoted: msg });
              return;
            }
            const ext      = mime.includes("gif") ? "gif" : mime.includes("png") ? "png" : mime.includes("mp4") ? "mp4" : "jpg";
            tmpPath        = path.join(process.cwd(), "data", `upload_${Date.now()}.${ext}`);
            fs.writeFileSync(tmpPath, mediaBuf);
            const uploadToCatbox = require("./lib/catbox");
            const link = await uploadToCatbox(tmpPath);
            const sizeMB = (mediaBuf.length / (1024 * 1024)).toFixed(2);
            await sock.sendMessage(from, {
              text: `✅ *Media Uploaded!*\n\n🔗 *Link:*\n${link}\n\n📦 *Size:* ${sizeMB} MB`,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Upload failed: ${e.message}` }, { quoted: msg });
          } finally {
            if (tmpPath && fs.existsSync(tmpPath)) {
              try { fs.unlinkSync(tmpPath); } catch {}
            }
          }
          return;
        }

        // ── .pickupline — send a random pickup line ─────────────────────────
        if (_cmd === "pickupline") {
          try {
            const res = await axios.get("https://api.popcat.xyz/pickuplines", { timeout: 15000 });
            const line = res.data?.pickupline;
            if (!line) throw new Error("No pickup line returned");
            await sock.sendMessage(from, { text: line }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: "❌ An error occurred while fetching the pickup line.",
            }, { quoted: msg });
          }
          return;
        }

        // ── .delete / .del — delete a quoted message (group admin only) ───────
        if (_cmd === "delete" || _cmd === "del") {
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          if (!msg.quoted) {
            await sock.sendMessage(from, { text: "❌ Reply to a message to delete it." }, { quoted: msg });
            return;
          }
          try {
            const parts   = await admin.getGroupParticipants(sock, from).catch(() => []);
            const botJid  = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
            const botAdm  = parts.some(p => p.id === botJid && (p.admin === "admin" || p.admin === "superadmin"));
            const sndAdm  = admin.isAdmin(senderJid, parts);
            if (!botAdm) {
              await sock.sendMessage(from, { text: "❌ I need to be a group admin to delete messages." }, { quoted: msg });
              return;
            }
            if (!sndAdm) {
              await sock.sendMessage(from, { text: "❌ Only admins can use this command." }, { quoted: msg });
              return;
            }
            await sock.sendMessage(from, {
              delete: {
                remoteJid:   from,
                fromMe:      false,
                id:          msg.quoted.key.id,
                participant: msg.quoted.sender,
              },
            });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Delete failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .leave — bot says goodbye and leaves the group ──────────────────
        if (_cmd === "leave") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          if (!from.endsWith("@g.us")) {
            await sock.sendMessage(from, { text: "❌ This command only works in groups." }, { quoted: msg });
            return;
          }
          try {
            const meta         = await sock.groupMetadata(from).catch(() => null);
            const participants = meta?.participants || [];
            const mentions     = participants.map(p => p.id);
            const botName      = settings.get("botName") || "NEXUS-MD";
            await sock.sendMessage(from, {
              text:     `𝗚𝗼𝗼𝗱𝗯𝘆𝗲 𝗲𝘃𝗲𝗿𝘆𝗼𝗻𝗲 👋\n${botName} 𝗶𝘀 𝗟𝗲𝗮𝘃𝗶𝗻𝗴 𝘁𝗵𝗲 𝗚𝗿𝗼𝘂𝗽 𝗻𝗼𝘄...`,
              mentions,
            }, { quoted: msg });
            await sock.groupLeave(from);
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to leave: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .sticker / .s — convert quoted image or video to sticker ─────────
        if (_cmd === "sticker" || _cmd === "s") {
          const quotedMsg = msg.quoted?.message || null;
          const quotedType = quotedMsg ? Object.keys(quotedMsg)[0] : null;
          const isImage = quotedType === "imageMessage";
          const isVideo = quotedType === "videoMessage";
          if (!quotedMsg || (!isImage && !isVideo)) {
            await sock.sendMessage(from, {
              text: "❌ Quote an image or a short video to convert it to a sticker.",
            }, { quoted: msg });
            return;
          }
          try {
            const { Sticker, StickerTypes } = require("wa-sticker-formatter");
            const mediaBuf = await downloadMediaMessage(
              { key: msg.quoted.key, message: quotedMsg },
              "buffer", {}
            );
            const botName  = settings.get("botName") || "NEXUS-MD";
            const sticker  = new Sticker(mediaBuf, {
              pack:       botName,
              author:     "IgniteBot",
              type:       StickerTypes.FULL,
              categories: ["🤩", "🎉"],
              id:         "12345",
              quality:    70,
              background: "transparent",
            });
            const stickerBuf = await sticker.toBuffer();
            await sock.sendMessage(from, { sticker: stickerBuf }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: `❌ Sticker creation failed: ${e.message}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── .dp — fetch a user's profile picture ───────────────────────────
        if (_cmd === "dp") {
          if (!msg.quoted) {
            await sock.sendMessage(from, {
              text: `📸 Usage: \`${_pfx}dp\` while replying to a user's message.`,
            }, { quoted: msg });
            return;
          }
          const targetJid = msg.quoted.sender;
          let ppUrl;
          try {
            ppUrl = await sock.profilePictureUrl(targetJid, "image");
          } catch {
            ppUrl = "https://tinyurl.com/yx93l6da";
          }
          let displayName = targetJid.split("@")[0];
          try { displayName = await sock.getName?.(targetJid) || displayName; } catch {}
          await sock.sendMessage(from, {
            image:   { url: ppUrl },
            caption: `📸 Profile picture of *${displayName}*`,
          }, { quoted: msg });
          return;
        }

        // ── .list / .vars — show all available commands ─────────────────────
        if (_cmd === "list" || _cmd === "vars") {
          const _pfxV = settings.get("prefix") || ".";
          const listText =
            `╔═══「 📋 *ᴄᴏᴍᴍᴀɴᴅ ʟɪꜱᴛ* 」═══╗\n║\n` +
            `║  𝟏  ignatius ➣ Get NEXUS-MD contact\n` +
            `║  𝟐  Broadcast ➣ Sends message to all groups\n` +
            `║  𝟑  Join ➣ Tag group link with join\n` +
            `║  𝟒  Botpp ➣ Change bot's account dp\n` +
            `║  𝟓  Block ➣ Block them fake friends\n` +
            `║  𝟔  Kill ➣ Kills group in seconds\n` +
            `║  𝟕  Unblock ➣ Give fake friends a second chance\n` +
            `║  𝟖  Setvar ➣ Set vars in heroku\n` +
            `║  𝟗  Sticker ➣ Converts a photo/short video to a sticker\n` +
            `║  𝟏𝟎 Toimg ➣ Converts a sticker to a photo\n` +
            `║  𝟏𝟏 Play ➣ Get your favourite song\n` +
            `║  𝟏𝟐 Whatsong ➣ Get the title of the song\n` +
            `║  𝟏𝟑 Yts ➣ Get YouTube videos\n` +
            `║  𝟏𝟒 Movie ➣ Get your favourite movie details\n` +
            `║  𝟏𝟓 Mix ➣ Combines +2 emojis\n` +
            `║  𝟏𝟔 Ai-img ➣ Get an AI photo\n` +
            `║  𝟏𝟕 Gpt ➣ Here to answer your questions\n` +
            `║  𝟏𝟖 Dp ➣ Gets a person's dp\n` +
            `║  𝟏𝟗 Speed ➣ Checks bot's speed\n` +
            `║  𝟐𝟎 Alive ➣ Check whether the bot is still kicking\n` +
            `║  𝟐𝟏 Runtime ➣ When did bot started operating\n` +
            `║  𝟐𝟐 Script ➣ Get bot script\n` +
            `║  𝟐𝟑 Owner ➣ Get owner(s) contact\n` +
            `║  𝟐𝟒 Vars ➣ See all variables\n` +
            `║  𝟐𝟓 Promote ➣ Gives one admin role\n` +
            `║  𝟐𝟔 Demote ➣ Demotes from group admin to a member\n` +
            `║  𝟐𝟕 Delete ➣ Delete a message\n` +
            `║  𝟐𝟖 Remove/kick ➣ Kick that terrorist from a group\n` +
            `║  𝟐𝟗 Foreigners ➣ Get foreign numbers\n` +
            `║  𝟑𝟎 Close ➣ Time for group members to take a break\n` +
            `║  𝟑𝟏 Open ➣ Everyone can chat in a group\n` +
            `║  𝟑𝟐 Icon ➣ Change group icon\n` +
            `║  𝟑𝟑 Subject ➣ Change group subject\n` +
            `║  𝟑𝟒 Desc ➣ Get group description\n` +
            `║  𝟑𝟓 Leave ➣ The group is boring, time for bot to leave\n` +
            `║  𝟑𝟔 Tagall ➣ Tag everyone in a group chat\n` +
            `║  𝟑𝟕 Hidetag ➣ Attention! Someone has something to say\n` +
            `║  𝟑𝟖 Revoke ➣ Reset group link\n` +
            `║  𝟑𝟗 Apk ➣ Search & download Android APK\n` +
            `║  𝟒𝟎 Song/Music ➣ Download audio (playable)\n` +
            `║  𝟒𝟏 Play2 ➣ Download audio as file + audio\n` +
            `║  𝟒𝟐 Lyrics ➣ Fetch song lyrics with art\n` +
            `║  𝟒𝟑 Enc ➣ Obfuscate/encrypt JavaScript code\n` +
            `║\n╚════════════════════════════════╝`;
          await sock.sendMessage(from, { text: listText }, { quoted: msg });
          return;
        }

        // ── .lyrics — fetch song lyrics with thumbnail ─────────────────────
        if (_cmd === "lyrics") {
          const query = _args.trim();
          if (!query) {
            await sock.sendMessage(from, {
              text: `🎵 Usage: \`${_pfx}lyrics <song name>\``,
            }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: `🔍 Searching lyrics for *${query}*...` }, { quoted: msg });
          try {
            const lyricsRes = await axios.get(
              `https://api.dreaded.site/api/lyrics?title=${encodeURIComponent(query)}`,
              { timeout: 30000 }
            );
            const data = lyricsRes.data;
            if (!data?.success || !data?.result?.lyrics) {
              await sock.sendMessage(from, {
                text: `❌ Sorry, I couldn't find any lyrics for *"${query}"*.`,
              }, { quoted: msg });
              return;
            }
            const { title, artist, thumb, lyrics } = data.result;
            const imageUrl = thumb || "https://files.catbox.moe/k2u5ks.jpg";
            const caption  = `*Title*: ${title}\n*Artist*: ${artist}\n\n${lyrics}`;
            try {
              const imgRes = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 15000 });
              const imgBuf = Buffer.from(imgRes.data);
              await sock.sendMessage(from, { image: imgBuf, caption }, { quoted: msg });
            } catch {
              // fallback to text-only if image fetch fails
              await sock.sendMessage(from, { text: caption }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(from, {
              text: `❌ An error occurred while fetching lyrics for *"${query}"*: ${e.message}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── .apk / .app — search and download Android APKs ────────────────
        if (_cmd === "apk" || _cmd === "app") {
          const query = _args.trim();
          if (!query) {
            await sock.sendMessage(from, {
              text: `📱 Usage: \`${_pfx}${_cmd} <app name>\`\n\nSearches for and downloads an Android APK.`,
            }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: `🔍 Searching for *${query}*...` }, { quoted: msg });
          try {
            const searchRes = await axios.get(
              `https://api.bk9.dev/search/apk?q=${encodeURIComponent(query)}`,
              { timeout: 30000 }
            );
            const results = searchRes.data?.BK9;
            if (!results || !results.length) {
              await sock.sendMessage(from, { text: "❌ No APK found for that name." }, { quoted: msg });
              return;
            }
            await sock.sendMessage(from, { text: `⬇️ Found *${results[0].name}*, fetching download link...` }, { quoted: msg });
            const dlRes = await axios.get(
              `https://api.bk9.dev/download/apk?id=${encodeURIComponent(results[0].id)}`,
              { timeout: 30000 }
            );
            const apk = dlRes.data?.BK9;
            if (!apk?.dllink) {
              await sock.sendMessage(from, { text: "❌ Failed to get the download link." }, { quoted: msg });
              return;
            }
            await sock.sendMessage(from, {
              document: { url: apk.dllink },
              fileName: apk.name || `${query}.apk`,
              mimetype: "application/vnd.android.package-archive",
              contextInfo: {
                externalAdReply: {
                  title:                 "𝗡𝗘𝗫𝗨𝗦-𝗠𝗗",
                  body:                  apk.name || query,
                  thumbnailUrl:          apk.icon  || "",
                  sourceUrl:             apk.dllink,
                  mediaType:             2,
                  showAdAttribution:     true,
                  renderLargerThumbnail: false,
                },
              },
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ APK download failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .play2 — download audio via dreaded.site API ───────────────────
        if (_cmd === "play2") {
          const query = _args.trim();
          if (!query) {
            await sock.sendMessage(from, {
              text: `🎵 Usage: \`${_pfx}play2 <song name>\`\n\nDownloads audio and sends it as both a playable file and a document.`,
            }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: `🔍 Searching for *${query}*...` }, { quoted: msg });
          try {
            const yts = require("yt-search");
            const { videos } = await yts(query);
            if (!videos || !videos.length) {
              await sock.sendMessage(from, { text: "❌ No songs found!" }, { quoted: msg });
              return;
            }
            const urlYt = videos[0].url;
            await sock.sendMessage(from, { text: `⬇️ Downloading *${videos[0].title}*...` }, { quoted: msg });
            const apiRes = await axios.get(
              `https://api.dreaded.site/api/ytdl/audio?url=${encodeURIComponent(urlYt)}`,
              { timeout: 60000 }
            );
            const data = apiRes.data;
            if (!data?.result?.download?.url) {
              await sock.sendMessage(from, { text: "❌ Failed to fetch audio from the API." }, { quoted: msg });
              return;
            }
            const { title, filename } = {
              title:    data.result.metadata?.title    || videos[0].title,
              filename: data.result.download?.filename || "audio.mp3",
            };
            const audioUrl = data.result.download.url;
            // Send as document (downloadable file)
            await sock.sendMessage(from, {
              document: { url: audioUrl },
              mimetype: "audio/mpeg",
              caption:  `🎵 *${title}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗡𝗘𝗫𝗨𝗦-𝗠𝗗_`,
              fileName: filename,
            }, { quoted: msg });
            // Send as playable audio
            await sock.sendMessage(from, {
              audio:    { url: audioUrl },
              mimetype: "audio/mpeg",
              fileName: filename,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Download failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .video — YouTube video downloader ──────────────────────────────
        if (_cmd === "video") {
          const query = _args.trim();
          if (!query) {
            await sock.sendMessage(from, {
              text: `🎬 Usage: \`${_pfx}video <search query>\`\n\nSearches YouTube and sends the video file.`,
            }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: `🔍 Searching YouTube for *${query}*...` }, { quoted: msg });
          try {
            const yts = require("yt-search");
            const { videos } = await yts(query);
            if (!videos || !videos.length) {
              await sock.sendMessage(from, { text: "❌ No video found for that query." }, { quoted: msg });
              return;
            }
            const videoUrl = videos[0].url;
            await sock.sendMessage(from, { text: `⬇️ Downloading *${videos[0].title}*...` }, { quoted: msg });
            const apis = [
              `https://api-rin-tohsaka.vercel.app/download/ytmp4?url=${encodeURIComponent(videoUrl)}`,
              `https://api.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(videoUrl)}`,
              `https://www.dark-yasiya-api.site/download/ytmp4?url=${encodeURIComponent(videoUrl)}`,
              `https://api.giftedtech.web.id/api/download/dlmp4?url=${encodeURIComponent(videoUrl)}&apikey=gifted-md`,
              `https://api.dreaded.site/api/ytdl/video?url=${encodeURIComponent(videoUrl)}`,
            ];
            let downloadData;
            for (const api of apis) {
              try {
                const res = await axios.get(api, { timeout: 30000 });
                if (res.data?.success) { downloadData = res.data; break; }
              } catch {}
            }
            if (!downloadData?.result?.download_url) {
              await sock.sendMessage(from, { text: "❌ Failed to fetch video from all APIs. Try again later." }, { quoted: msg });
              return;
            }
            const dlUrl = downloadData.result.download_url;
            const title = downloadData.result.title || videos[0].title;
            await sock.sendMessage(from, {
              document: { url: dlUrl },
              mimetype: "video/mp4",
              fileName: `${title}.mp4`,
              caption: "𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗡𝗘𝗫𝗨𝗦-𝗠𝗗",
            }, { quoted: msg });
            await sock.sendMessage(from, {
              video: { url: dlUrl },
              mimetype: "video/mp4",
              caption: "𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗡𝗘𝗫𝗨𝗦-𝗠𝗗",
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Video download failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .facebook / .fb / .fbdl — Facebook video downloader ────────────
        if (_cmd === "facebook" || _cmd === "fb" || _cmd === "fbdl") {
          const url = _args.trim();
          if (!url) {
            await sock.sendMessage(from, {
              text: `📘 Usage: \`${_pfx}${_cmd} <facebook video link>\``,
            }, { quoted: msg });
            return;
          }
          if (!url.includes("facebook.com")) {
            await sock.sendMessage(from, { text: "❌ That is not a Facebook link." }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: "⬇️ Downloading Facebook video..." }, { quoted: msg });
          try {
            const res = await axios.get(
              `https://api.dreaded.site/api/facebook?url=${encodeURIComponent(url)}`,
              { timeout: 30000 }
            );
            const data = res.data;
            if (!data || data.status !== 200 || !data.facebook?.sdVideo) {
              await sock.sendMessage(from, {
                text: "❌ Could not fetch the video. Make sure the post is public and try again.",
              }, { quoted: msg });
              return;
            }
            await sock.sendMessage(from, {
              video: { url: data.facebook.sdVideo },
              caption: "𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗡𝗘𝗫𝗨𝗦-𝗠𝗗",
              gifPlayback: false,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Facebook download failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .anime / .random-anime — random anime info ──────────────────────
        if (_cmd === "anime" || _cmd === "random-anime") {
          try {
            const res = await axios.get("https://api.jikan.moe/v4/random/anime", { timeout: 15000 });
            const d = res.data?.data;
            if (!d) throw new Error("Empty response from API");
            const caption =
              `📺 *Title:* ${d.title}\n` +
              `🎬 *Episodes:* ${d.episodes ?? "N/A"}\n` +
              `📡 *Status:* ${d.status}\n` +
              `📝 *Synopsis:* ${d.synopsis?.slice(0, 300) ?? "N/A"}...\n` +
              `🔗 *URL:* ${d.url}`;
            await sock.sendMessage(from, {
              image: { url: d.images.jpg.image_url },
              caption,
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to fetch anime info: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .instagram / .igdl / .ig — Instagram video/photo downloader ─────
        if (_cmd === "instagram" || _cmd === "igdl" || _cmd === "ig") {
          const url = _args.trim();
          if (!url) {
            await sock.sendMessage(from, {
              text: `📸 Usage: \`${_pfx}${_cmd} <instagram post link>\``,
            }, { quoted: msg });
            return;
          }
          if (!url.includes("instagram.com")) {
            await sock.sendMessage(from, { text: "❌ That is not a valid Instagram link." }, { quoted: msg });
            return;
          }
          await sock.sendMessage(from, { text: "⬇️ Downloading Instagram media..." }, { quoted: msg });
          try {
            const { igdl } = require("ruhend-scraper");
            const result = await igdl(url);
            if (!result?.data?.length) {
              await sock.sendMessage(from, { text: "❌ No media found at that link." }, { quoted: msg });
              return;
            }
            for (let i = 0; i < Math.min(20, result.data.length); i++) {
              await sock.sendMessage(from, {
                video: { url: result.data[i].url },
                mimetype: "video/mp4",
                caption: "𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗡𝗘𝗫𝗨𝗦-𝗠𝗗",
              }, { quoted: msg });
            }
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Instagram download failed: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .enc / .encrypte ───────────────────────────────────────────────
        if (_cmd === "enc" || _cmd === "encrypte") {
          if (!msg.quoted?.body) {
            await sock.sendMessage(from, {
              text: "❌ Quote/Tag a valid JavaScript code to encrypt!",
            }, { quoted: msg });
            return;
          }
          try {
            const Obf = require("javascript-obfuscator");
            const result = Obf.obfuscate(msg.quoted.body, {
              compact: true,
              controlFlowFlattening: true,
              controlFlowFlatteningThreshold: 1,
              numbersToExpressions: true,
              simplify: true,
              stringArrayShuffle: true,
              splitStrings: true,
              stringArrayThreshold: 1,
            });
            console.log("Successfully encrypted the code");
            await sock.sendMessage(from, {
              text: result.getObfuscatedCode(),
            }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, {
              text: `❌ Failed to encrypt: ${e.message}`,
            }, { quoted: msg });
          }
          return;
        }

        // ── .block ─────────────────────────────────────────────────────────
        if (_cmd === "block") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          let target = msg.mentionedJids?.[0]
            || (msg.quoted ? msg.quoted.sender : null)
            || (_args ? _args.replace(/[^0-9]/g, "") + "@s.whatsapp.net" : null);
          if (!target) {
            await sock.sendMessage(from, {
              text: `⚙️ *Block*\n\nUsage: \`${_pfx}block\` while replying to or mentioning a user.\n\nBlocks a user from messaging the bot.`,
            }, { quoted: msg });
            return;
          }
          // Prevent blocking the bot itself
          const _botJid = (sock.user?.id || "").replace(/:\d+@/, "@s.whatsapp.net");
          if (target === _botJid) {
            await sock.sendMessage(from, { text: "❌ I cannot block myself!" }, { quoted: msg });
            return;
          }
          // Prevent blocking any super-admin/owner
          if (admin.isSuperAdmin(target)) {
            await sock.sendMessage(from, { text: "❌ I cannot block my Owner! 😡" }, { quoted: msg });
            return;
          }
          try {
            await sock.updateBlockStatus(target, "block");
            const _num = target.split("@")[0];
            await sock.sendMessage(from, { text: `✅ *Blocked* +${_num} successfully!` }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to block: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .unblock ───────────────────────────────────────────────────────
        if (_cmd === "unblock") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          let target = msg.mentionedJids?.[0]
            || (msg.quoted ? msg.quoted.sender : null)
            || (_args ? _args.replace(/[^0-9]/g, "") + "@s.whatsapp.net" : null);
          if (!target) {
            await sock.sendMessage(from, {
              text: `⚙️ *Unblock*\n\nUsage: \`${_pfx}unblock\` while replying to or mentioning a user.\n\nUnblocks a previously blocked user.`,
            }, { quoted: msg });
            return;
          }
          try {
            await sock.updateBlockStatus(target, "unblock");
            const _num = target.split("@")[0];
            await sock.sendMessage(from, { text: `✅ *Unblocked* +${_num} successfully! ✅` }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from, { text: `❌ Failed to unblock: ${e.message}` }, { quoted: msg });
          }
          return;
        }

        // ── .prefixless ────────────────────────────────────────────────────
        if (_cmd === "prefixless") {
          if (!_isOwner) {
            await sock.sendMessage(from, { text: "❌ Owner-only command." }, { quoted: msg });
            return;
          }
          const sub = _args.toLowerCase().trim();
          if (sub === "on") {
            settings.set("prefixless", true);
            await sock.sendMessage(from, {
              text: `✅ *Prefixless mode ON*\n\nCommands now work without the \`${_pfx}\` prefix.\nExample: type \`menu\` instead of \`${_pfx}menu\``,
            }, { quoted: msg });
          } else if (sub === "off") {
            settings.set("prefixless", false);
            await sock.sendMessage(from, {
              text: `✅ *Prefixless mode OFF*\n\nCommands now require the \`${_pfx}\` prefix again.`,
            }, { quoted: msg });
          } else {
            const cur = !!settings.get("prefixless");
            await sock.sendMessage(from, {
              text: `⚙️ *Prefixless mode*\n\nCurrent: *${cur ? "ON" : "OFF"}*\n\nUsage: \`${_pfx}prefixless on\` or \`${_pfx}prefixless off\``,
            }, { quoted: msg });
          }
          return;
        }

        // ── .menu / .menuv / .help — redesigned NEXUS V2 CORE menu ──────────
        if (_cmd === "menu" || _cmd === "menuv" || _cmd === "help") {
          try {
            const _os       = require("os");
            const _mem      = process.memoryUsage();
            const _totalRam = _os.totalmem();
            const _rssMB    = (_mem.rss / 1024 / 1024).toFixed(1);
            const _totalRamMB = Math.round(_totalRam / 1024 / 1024);
            const _ramPct   = Math.min(100, Math.round((_mem.rss / _totalRam) * 100));
            const _barLen   = 10;
            const _filled   = Math.round((_ramPct / 100) * _barLen);
            const _ramBar   = "█".repeat(_filled) + "░".repeat(_barLen - _filled);
            const _uptimeSec= Math.floor(process.uptime());
            const _uh       = Math.floor(_uptimeSec / 3600);
            const _um       = Math.floor((_uptimeSec % 3600) / 60);
            const _us       = _uptimeSec % 60;
            const _uptimeStr= `${_uh}h ${_um}m ${_us}s`;
            const _botMode  = settings.get("mode") || "public";
            const _modeStr  = _botMode.charAt(0).toUpperCase() + _botMode.slice(1);
            const _pfxDisp  = `[${_pfx}]`;
            const _platInfo = platform.get();
            const _platName = _platInfo.name || "Replit";
            const _botName  = settings.get("botName") || "NEXUS-MD";
            const _senderNum= msg.pushName || (phone ? `+${phone}` : senderJid.split("@")[0]);
            const _ownerNums= (require("./config").admins || []);
            const _ownerStr = _ownerNums.length ? `+${_ownerNums[0]}` : "Nexus Tech";
            const _statusStr= botStatus === "connected" ? "Online ✅" : "Offline ❌";

            const _menuText =
              `╔══════════════════════════════╗\n` +
              `        🤖 *${_botName} V2 CORE*\n` +
              `╚══════════════════════════════╝\n\n` +
              `⟡ 👤 *User*     :: ~•~ ༺〄 ${_senderNum}★༻\n` +
              `⟡ 👑 *Owner*    :: ${_ownerStr}\n` +
              `⟡ 🌐 *Mode*     :: ${_modeStr}\n` +
              `⟡ ⚡ *Prefix*   :: ${_pfxDisp}\n` +
              `⟡ 🧠 *Version*  :: 2.0\n` +
              `⟡ ☁ *Platform* :: ${_platName}\n` +
              `⟡ 📡 *Status*   :: ${_statusStr}\n` +
              `⟡ ⏱ *Uptime*   :: ${_uptimeStr}\n` +
              `⟡ 💾 *RAM*      :: ${_ramBar} ${_ramPct}% (${_rssMB}MB)\n` +
              `⟡ 🧬 *Memory*   :: ${_rssMB}MB / ${_totalRamMB}MB\n\n` +
              `╭━━━〔 ⚙️ *SYSTEM CORE* 〕━━━⬣\n` +
              `┃ ⌬ ${_pfx}menu\n` +
              `┃ ⌬ ${_pfx}help\n` +
              `┃ ⌬ ${_pfx}menuv\n` +
              `┃ ⌬ ${_pfx}ping\n` +
              `┃ ⌬ ${_pfx}alive\n` +
              `┃ ⌬ ${_pfx}stats\n` +
              `┃ ⌬ ${_pfx}uptime\n` +
              `┃ ⌬ ${_pfx}time\n` +
              `┃ ⌬ ${_pfx}date\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 🧠 *AI ENGINE* 〕━━━⬣\n` +
              `┃ ◈ ${_pfx}ai\n` +
              `┃ ◈ ${_pfx}chat\n` +
              `┃ ◈ ${_pfx}ask\n` +
              `┃ ◈ ${_pfx}imagine\n` +
              `┃ ◈ ${_pfx}image\n` +
              `┃ ◈ ${_pfx}tts\n` +
              `┃ ◈ ${_pfx}summarize\n` +
              `┃ ◈ ${_pfx}summary\n` +
              `┃ ◈ ${_pfx}clearchat\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 🔎 *SEARCH HUB* 〕━━━⬣\n` +
              `┃ ⧉ ${_pfx}weather\n` +
              `┃ ⧉ ${_pfx}wiki\n` +
              `┃ ⧉ ${_pfx}wikipedia\n` +
              `┃ ⧉ ${_pfx}define\n` +
              `┃ ⧉ ${_pfx}dict\n` +
              `┃ ⧉ ${_pfx}tr\n` +
              `┃ ⧉ ${_pfx}translate\n` +
              `┃ ⧉ ${_pfx}langs\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 ⚽ *SPORTS CENTER* 〕━━━⬣\n` +
              `┃ ⚡ ${_pfx}epl\n` +
              `┃ ⚡ ${_pfx}eplscores\n` +
              `┃ ⚡ ${_pfx}premierleague\n` +
              `┃ ⚡ ${_pfx}pl\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 🎮 *FUN ZONE* 〕━━━⬣\n` +
              `┃ ✦ ${_pfx}8ball\n` +
              `┃ ✦ ${_pfx}fact\n` +
              `┃ ✦ ${_pfx}flip\n` +
              `┃ ✦ ${_pfx}joke\n` +
              `┃ ✦ ${_pfx}quote\n` +
              `┃ ✦ ${_pfx}inspire\n` +
              `┃ ✦ ${_pfx}roll\n` +
              `┃ ✦ ${_pfx}anime\n` +
              `┃ ✦ ${_pfx}random-anime\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 ✍️ *TEXT LAB* 〕━━━⬣\n` +
              `┃ ⌘ ${_pfx}aesthetic\n` +
              `┃ ⌘ ${_pfx}ae\n` +
              `┃ ⌘ ${_pfx}bold\n` +
              `┃ ⌘ ${_pfx}italic\n` +
              `┃ ⌘ ${_pfx}mock\n` +
              `┃ ⌘ ${_pfx}reverse\n` +
              `┃ ⌘ ${_pfx}emojify\n` +
              `┃ ⌘ ${_pfx}emoji\n` +
              `┃ ⌘ ${_pfx}upper\n` +
              `┃ ⌘ ${_pfx}lower\n` +
              `┃ ⌘ ${_pfx}repeat\n` +
              `┃ ⌘ ${_pfx}calc\n` +
              `┃ ⌘ ${_pfx}calculate\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 🎧 *MEDIA STATION* 〕━━━⬣\n` +
              `┃ ▶ ${_pfx}play\n` +
              `┃ ▶ ${_pfx}song\n` +
              `┃ ▶ ${_pfx}p\n` +
              `┃ ▶ ${_pfx}yt\n` +
              `┃ ▶ ${_pfx}ytdl\n` +
              `┃ ▶ ${_pfx}audio\n` +
              `┃ ▶ ${_pfx}music\n` +
              `┃ ▶ ${_pfx}dl\n` +
              `┃ ▶ ${_pfx}download\n` +
              `┃ ▶ ${_pfx}video\n` +
              `┃ ▶ ${_pfx}fbdl\n` +
              `┃ ▶ ${_pfx}facebook\n` +
              `┃ ▶ ${_pfx}fb\n` +
              `┃ ▶ ${_pfx}instagram\n` +
              `┃ ▶ ${_pfx}igdl\n` +
              `┃ ▶ ${_pfx}ig\n` +
              `┃ ▶ ${_pfx}apk\n` +
              `┃ ▶ ${_pfx}app\n` +
              `┃ ▶ ${_pfx}pindl\n` +
              `┃ ▶ ${_pfx}pinterest\n` +
              `┃ ▶ ${_pfx}sticker\n` +
              `┃ ▶ ${_pfx}s\n` +
              `┃ ▶ ${_pfx}convert\n` +
              `┃ ▶ ${_pfx}v\n` +
              `┃ ▶ ${_pfx}vo\n` +
              `┃ ▶ ${_pfx}viewonce\n` +
              `┃ ▶ ${_pfx}reveal\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 🧰 *UTILITIES* 〕━━━⬣\n` +
              `┃ ◉ ${_pfx}pp\n` +
              `┃ ◉ ${_pfx}pfp\n` +
              `┃ ◉ ${_pfx}getpp\n` +
              `┃ ◉ ${_pfx}qr\n` +
              `┃ ◉ ${_pfx}short\n` +
              `┃ ◉ ${_pfx}shorten\n` +
              `┃ ◉ ${_pfx}whois\n` +
              `┃ ◉ ${_pfx}profile\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 👥 *GROUP CONTROL* 〕━━━⬣\n` +
              `┃ ⛨ ${_pfx}add\n` +
              `┃ ⛨ ${_pfx}kick\n` +
              `┃ ⛨ ${_pfx}kickall\n` +
              `┃ ⛨ ${_pfx}promote\n` +
              `┃ ⛨ ${_pfx}promoteall\n` +
              `┃ ⛨ ${_pfx}demote\n` +
              `┃ ⛨ ${_pfx}demoteall\n` +
              `┃ ⛨ ${_pfx}ban\n` +
              `┃ ⛨ ${_pfx}unban\n` +
              `┃ ⛨ ${_pfx}clearbanlist\n` +
              `┃ ⛨ ${_pfx}mute\n` +
              `┃ ⛨ ${_pfx}unmute\n` +
              `┃ ⛨ ${_pfx}open\n` +
              `┃ ⛨ ${_pfx}close\n` +
              `┃ ⛨ ${_pfx}warn\n` +
              `┃ ⛨ ${_pfx}resetwarn\n` +
              `┃ ⛨ ${_pfx}setwarn\n` +
              `┃ ⛨ ${_pfx}warnings\n` +
              `┃ ⛨ ${_pfx}delete\n` +
              `┃ ⛨ ${_pfx}leave\n` +
              `┃ ⛨ ${_pfx}creategroup\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 📊 *GROUP INFO* 〕━━━⬣\n` +
              `┃ ⧗ ${_pfx}admins\n` +
              `┃ ⧗ ${_pfx}members\n` +
              `┃ ⧗ ${_pfx}count\n` +
              `┃ ⧗ ${_pfx}groupinfo\n` +
              `┃ ⧗ ${_pfx}link\n` +
              `┃ ⧗ ${_pfx}invitelink\n` +
              `┃ ⧗ ${_pfx}revoke\n` +
              `┃ ⧗ ${_pfx}resetlink\n` +
              `┃ ⧗ ${_pfx}glink\n` +
              `┃ ⧗ ${_pfx}grouplink\n` +
              `┃ ⧗ ${_pfx}setname\n` +
              `┃ ⧗ ${_pfx}rename\n` +
              `┃ ⧗ ${_pfx}setdesc\n` +
              `┃ ⧗ ${_pfx}desc\n` +
              `┃ ⧗ ${_pfx}seticon\n` +
              `┃ ⧗ ${_pfx}setgrouppp\n` +
              `┃ ⧗ ${_pfx}everyone\n` +
              `┃ ⧗ ${_pfx}tagall\n` +
              `┃ ⧗ ${_pfx}hidetag\n` +
              `┃ ⧗ ${_pfx}htag\n` +
              `┃ ⧗ ${_pfx}stag\n` +
              `┃ ⧗ ${_pfx}poll\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 🤖 *AUTO MODERATION* 〕━━━⬣\n` +
              `┃ ⛔ ${_pfx}antilink\n` +
              `┃ ⛔ ${_pfx}antispam\n` +
              `┃ ⛔ ${_pfx}antiflood\n` +
              `┃ ⛔ ${_pfx}antilongtext\n` +
              `┃ ⛔ ${_pfx}settextlimit\n` +
              `┃ ⛔ ${_pfx}antimention\n` +
              `┃ ⛔ ${_pfx}antitag\n` +
              `┃ ⛔ ${_pfx}antisticker\n` +
              `┃ ⛔ ${_pfx}antidelete\n` +
              `┃ ⛔ ${_pfx}anticall\n` +
              `┃ ⛔ ${_pfx}alwaysonline\n` +
              `┃ ⛔ ${_pfx}voreveal\n` +
              `┃ 🚫 ${_pfx}antistatusmention — aliases: ${_pfx}gsm, ${_pfx}asm\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 ⚙ *BOT SETTINGS* 〕━━━⬣\n` +
              `┃ ⚙ ${_pfx}botsettings\n` +
              `┃ ⚙ ${_pfx}features\n` +
              `┃ ⚙ ${_pfx}featurelist\n` +
              `┃ ⚙ ${_pfx}feature\n` +
              `┃ ⚙ ${_pfx}toggle\n` +
              `┃ ⚙ ${_pfx}setmode\n` +
              `┃ ⚙ ${_pfx}mode\n` +
              `┃ ⚙ ${_pfx}lang\n` +
              `┃ ⚙ ${_pfx}setprefix\n` +
              `┃ ⚙ ${_pfx}prefixless\n` +
              `┃ ⚙ ${_pfx}setowner\n` +
              `┃ ⚙ ${_pfx}setownername\n` +
              `┃ ⚙ ${_pfx}setbotname\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 🛒 *STORE SYSTEM* 〕━━━⬣\n` +
              `┃ 🧾 ${_pfx}shop\n` +
              `┃ 🧾 ${_pfx}catalog\n` +
              `┃ 🧾 ${_pfx}order\n` +
              `┃ 🧾 ${_pfx}myorders\n` +
              `┃ 🧾 ${_pfx}services\n` +
              `┃ 🧾 ${_pfx}book\n` +
              `┃ 🧾 ${_pfx}mybookings\n` +
              `┃ 🧾 ${_pfx}cancel\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `╭━━━〔 👑 *SUPER ADMIN* 〕━━━⬣\n` +
              `┃ ☣ ${_pfx}sudo\n` +
              `┃ ☣ ${_pfx}removesudo\n` +
              `┃ ☣ ${_pfx}unsudo\n` +
              `┃ ☣ ${_pfx}sudolist\n` +
              `┃ 👑 ${_pfx}takeover — demote group creator & promote owner\n` +
              `┃ 🛡️ ${_pfx}selfadmin / ${_pfx}getadmin — self-promote to admin\n` +
              `┃ 🚫 ${_pfx}antistatusmention / ${_pfx}gsm / ${_pfx}asm\n` +
              `┃ ☣ ${_pfx}broadcast\n` +
              `┃ ☣ ${_pfx}pairing\n` +
              `┃ ☣ ${_pfx}setmenuimage\n` +
              `┃ ☣ ${_pfx}clearmenuimage\n` +
              `┃ ☣ ${_pfx}setmenuvideo\n` +
              `┃ ☣ ${_pfx}clearmenuvideo\n` +
              `┃ ☣ ${_pfx}setmenusong\n` +
              `┃ ☣ ${_pfx}clearmenusong\n` +
              `╰━━━━━━━━━━━━━━━━━━⬣\n\n` +
              `┏━━━━━━━━━━━━━━━━━━━━━━┓\n` +
              `  ⚡ *NEXUS TECH SYSTEM*\n` +
              `  🔹 Powered by Ignatius Perez\n` +
              `┗━━━━━━━━━━━━━━━━━━━━━━┛`;

            // Send menu song FIRST, then gif/video + menu text caption
            const _menuSongBuf = settings.getMenuSong();
            if (_menuSongBuf) {
              await sock.sendMessage(from, {
                audio:    _menuSongBuf,
                mimetype: "audio/mpeg",
                ptt:      false,
              }, { quoted: msg }).catch(() => {});
            } else {
              // Fallback: bundled Rick Astley mp3 as menu song
              const _rickPath = path.join(process.cwd(), "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) [dQw4w9WgXcQ].mp3");
              if (fs.existsSync(_rickPath)) {
                await sock.sendMessage(from, {
                  audio:    fs.readFileSync(_rickPath),
                  mimetype: "audio/mpeg",
                  ptt:      false,
                }, { quoted: msg }).catch(() => {});
              }
            }

            // Send gif/video + menu text
            const _menuVidBuf    = settings.getMenuVideo();
            const _bannerGifPath = path.join(process.cwd(), "assets", "banner.gif");
            const _menuMp4Path   = path.join(process.cwd(), "assets", "menu.mp4");
            if (_menuVidBuf) {
              await sock.sendMessage(from, {
                video:       _menuVidBuf,
                caption:     _menuText,
                gifPlayback: true,
                mimetype:    "video/mp4",
              }, { quoted: msg });
            } else if (fs.existsSync(_menuMp4Path)) {
              await sock.sendMessage(from, {
                video:       fs.readFileSync(_menuMp4Path),
                caption:     _menuText,
                gifPlayback: true,
                mimetype:    "video/mp4",
              }, { quoted: msg });
            } else if (fs.existsSync(_bannerGifPath)) {
              await sock.sendMessage(from, {
                video:       fs.readFileSync(_bannerGifPath),
                caption:     _menuText,
                gifPlayback: true,
              }, { quoted: msg });
            } else {
              await sock.sendMessage(from, { text: _menuText }, { quoted: msg });
            }
          } catch (_menuErr) {
            console.error("[menu] error:", _menuErr.message);
          }
          return;
        }
      }
    }
    // ── End built-in interceptors ─────────────────────────────────────────────

    await commands.handle(sock, msg).catch(err => {
      console.error(`[CMD✗] from=${msg.sender?.split("@")[0]} body="${body.slice(0,40)}" err=${err.message}`);
    });

    // ── Menu hook: append owner commands (block/unblock) after main menu ──────
    {
      const _mPfx        = settings.get("prefix") || ".";
      const _mPrefixless = !!settings.get("prefixless");
      let _mRest = null;
      if (body.startsWith(_mPfx))  _mRest = body.slice(_mPfx.length).trim();
      else if (_mPrefixless)        _mRest = body.trim();
      const _mCmd = (_mRest || "").split(/\s+/)[0]?.toLowerCase() || "";
      const _mIsOwner = msg.key.fromMe === true || admin.isSuperAdmin(senderJid);
      if (_mCmd === "menu" && _mIsOwner) {
        await sock.sendMessage(from, {
          text:
            `╔═══「 🔒 *ᴏᴡɴᴇʀ ᴄᴏᴍᴍᴀɴᴅꜱ* 🔒 」═══╗\n` +
            `║\n` +
            `║  ◈ 🚫 *${_mPfx}block*\n` +
            `║     Reply to / mention a user to block them\n` +
            `║\n` +
            `║  ◈ ✅ *${_mPfx}unblock*\n` +
            `║     Reply to / mention a user to unblock them\n` +
            `║\n` +
            `║  ◈ 🔐 *${_mPfx}enc*\n` +
            `║     Reply to JS code to obfuscate/encrypt it\n` +
            `║\n` +
            `║  ◈ 🎵 *${_mPfx}play2 <song name>*\n` +
            `║     Download audio as file + playable audio\n` +
            `║\n` +
            `║  ◈ 🎶 *${_mPfx}song / ${_mPfx}music <song name>*\n` +
            `║     Download audio via noobs-api (playable)\n` +
            `║\n` +
            `║  ◈ 📱 *${_mPfx}apk / ${_mPfx}app <app name>*\n` +
            `║     Search and download an Android APK\n` +
            `║\n` +
            `║  ◈ 🎤 *${_mPfx}lyrics <song name>*\n` +
            `║     Fetch lyrics with album art thumbnail\n` +
            `║\n` +
            `║  ◈ 🎭 *${_mPfx}sticker / ${_mPfx}s*\n` +
            `║     Quote image/video to convert to sticker\n` +
            `║\n` +
            `║  ◈ 📸 *${_mPfx}dp*\n` +
            `║     Reply to a user to get their profile picture\n` +
            `║\n` +
            `║  ◈ 📋 *${_mPfx}list / ${_mPfx}vars*\n` +
            `║     Show the full command list\n` +
            `║\n` +
            `║  ◈ 🗑️ *${_mPfx}delete / ${_mPfx}del*\n` +
            `║     Reply to a message to delete it (group admins)\n` +
            `║\n` +
            `║  ◈ 👑 *${_mPfx}takeover*\n` +
            `║     Demote group creator & promote bot owner to admin\n` +
            `║\n` +
            `║  ◈ 🛡️ *${_mPfx}selfadmin / ${_mPfx}getadmin*\n` +
            `║     Force-promote bot to admin; pings admins if rejected\n` +
            `║\n` +
            `║  ◈ 🚫 *${_mPfx}antistatusmention* (aliases: ${_mPfx}gsm, ${_mPfx}asm)\n` +
            `║     Block members from tagging this group in their status\n` +
            `║     Subcommands: warn | delete | kick | off\n` +
            `║                  maxwarn <n> | reset @user | status\n` +
            `║\n` +
            `║  ◈ 🚪 *${_mPfx}leave*\n` +
            `║     Bot says goodbye and leaves the group (owner)\n` +
            `║\n` +
            `║  ◈ 💘 *${_mPfx}pickupline*\n` +
            `║     Get a random pickup line\n` +
            `║\n` +
            `║  ◈ 📤 *${_mPfx}upload / ${_mPfx}url*\n` +
            `║     Reply to image/video to upload to catbox.moe\n` +
            `║\n` +
            `║  ◈ ➕ *${_mPfx}add <number(s)>*\n` +
            `║     Add member(s) to the group (group admin only)\n` +
            `║     Comma-separate for multiple numbers\n` +
            `║\n` +
            `║  ◈ 🔊 *${_mPfx}tts / ${_mPfx}say <text>*\n` +
            `║     Convert text to a Hindi voice note\n` +
            `║\n` +
            `║  ◈ 📌 *${_mPfx}pinterest / ${_mPfx}pin <link>*\n` +
            `║     Download image or video from a pin.it link\n` +
            `║\n` +
            `║  ◈ 🔒 *${_mPfx}close / ${_mPfx}mute*\n` +
            `║     Lock group — only admins can send messages\n` +
            `║\n` +
            `║  ◈ 📬 *${_mPfx}inbox <email>*\n` +
            `║     Fetch messages from a temp-mail inbox\n` +
            `║\n` +
            `║  ◈ 💾 *${_mPfx}save*\n` +
            `║     Reply to a status to save it to your DM (owner)\n` +
            `║\n` +
            `║  ◈ 🤖 *${_mPfx}velma <question>*\n` +
            `║     Chat with Velma AI (Llama-powered)\n` +
            `║\n` +
            `║  ◈ ⚽ *${_mPfx}epl / ${_mPfx}epl-table*\n` +
            `║     Show current Premier League standings\n` +
            `║\n` +
            `║  ◈ 🖥️ *${_mPfx}hacker2*\n` +
            `║     Apply hacker effect to a quoted image\n` +
            `║\n` +
            `║  ◈ 📸 *${_mPfx}screenshot / ${_mPfx}ss <url>*\n` +
            `║     Take a full-page screenshot of any website\n` +
            `║\n` +
            `║  ◈ 🖼️ *${_mPfx}fullpp*\n` +
            `║     Set bot profile picture from quoted image (owner)\n` +
            `║\n` +
            `║  ◈ ⚽ *${_mPfx}bundesliga / ${_mPfx}bl-table*\n` +
            `║     Show current Bundesliga standings\n` +
            `║\n` +
            `║  ◈ 🚫 *${_mPfx}remove / ${_mPfx}kick*\n` +
            `║     Remove a member (mention or reply) — group admins\n` +
            `║\n` +
            `║  ◈ 🔍 *${_mPfx}inspect <url>*\n` +
            `║     Crawl a website: HTML, CSS, JS and media files\n` +
            `║\n` +
            `║  ◈ 🎵 *${_mPfx}tiktok / ${_mPfx}tikdl <link>*\n` +
            `║     Download a TikTok video\n` +
            `║\n` +
            `║  ◈ ⚽ *${_mPfx}laliga / ${_mPfx}pd-table*\n` +
            `║     Show current La Liga standings\n` +
            `║\n` +
            `║  ◈ ⏱️ *${_mPfx}disp-1 / ${_mPfx}disp-7*\n` +
            `║     Disappearing messages: 24 hrs / 7 days (admins)\n` +
            `║\n` +
            `║  ◈ ⬆️ *${_mPfx}promote*\n` +
            `║     Promote a member to admin (mention or reply)\n` +
            `║\n` +
            `║  ◈ ⬇️ *${_mPfx}demote*\n` +
            `║     Demote an admin to member (mention or reply)\n` +
            `║\n` +
            `║  ◈ 🖼️ *${_mPfx}icon*\n` +
            `║     Set group profile picture from quoted image\n` +
            `║\n` +
            `║  ◈ ✅ *${_mPfx}approve / ${_mPfx}approve-all*\n` +
            `║     Approve all pending group join requests\n` +
            `║\n` +
            `║  ◈ 🚫 *${_mPfx}reject / ${_mPfx}reject-all*\n` +
            `║     Reject all pending group join requests\n` +
            `║\n` +
            `║  ◈ 🥇 *${_mPfx}admin*\n` +
            `║     Promote yourself to group admin (owner only)\n` +
            `║\n` +
            `╚════════════════════════════════╝`,
        }, { quoted: msg });
      }
    }

    // ── Chatbot — AI reply to all messages when enabled ──────────────────────
    const pfx = settings.get("prefix") || ".";
    const isCmd = body.startsWith(pfx);
    const { isChatbotEnabled } = commands;
    if (!msg.key.fromMe && !isCmd && isChatbotEnabled && isChatbotEnabled(from)) {
      const cbText = body.trim();
      if (cbText && cbText.length > 1) {
        try {
          await sock.sendPresenceUpdate("composing", from);
          const cbRes = await axios.get(`https://apiskeith.top/ai/gpt4?q=${encodeURIComponent(cbText)}`, { timeout: 30000 });
          const cbAnswer = cbRes.data?.result || cbRes.data?.message || cbRes.data?.reply;
          if (cbAnswer) {
            await sock.sendMessage(from, { text: cbAnswer.trim() }, { quoted: msg });
          }
        } catch (e) {
          console.error("[Chatbot] AI error:", e.message);
        } finally {
          sock.sendPresenceUpdate("paused", from).catch(() => {});
        }
      }
    }

    // ── Stop typing heartbeat — clear interval then pause after commands finish
    if (presenceInterval) {
      clearInterval(presenceInterval);
      presenceInterval = null;
    }
    if (shouldRecord || shouldType) {
      // Small delay so WhatsApp shows the indicator briefly before hiding it
      setTimeout(() => _sendPresence("paused", from), 1500);
    }

    // ── Optional background features — run after response, never block commands
    // Auto-reveal view-once (voReveal)
    if (settings.get("voReveal") && !msg.key.fromMe) {
      (async () => {
        try {
          const _m = _inner;
          // Unwrap all known view-once wrapper types
          const voInner =
            _m?.viewOnceMessage?.message ||
            _m?.viewOnceMessageV2?.message ||
            _m?.viewOnceMessageV2Extension?.message ||
            (_m?.imageMessage?.viewOnce ? { imageMessage: _m.imageMessage } : null) ||
            (_m?.videoMessage?.viewOnce ? { videoMessage: _m.videoMessage } : null) ||
            (_m?.audioMessage?.viewOnce  ? { audioMessage: _m.audioMessage } : null);

          if (!voInner) return;
          const mt = Object.keys(voInner)[0];
          if (!["imageMessage", "videoMessage", "audioMessage"].includes(mt)) return;

          // Download the encrypted media
          const fakeMsg = {
            key: { remoteJid: from, id: msg.key.id, fromMe: false, participant: senderJid || undefined },
            message: voInner,
          };
          const buf   = Buffer.from(await downloadMediaMessage(fakeMsg, "buffer", {}));
          const media = voInner[mt];

          // Build rich caption
          const tz        = settings.get("timezone") || "Africa/Nairobi";
          const timeStr   = new Date().toLocaleTimeString("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true });
          const senderNum = `+${phone}`;
          const typeLabel = mt === "imageMessage" ? "📷 Photo" : mt === "videoMessage" ? "🎥 Video" : "🎵 Audio";
          const origCaption = media.caption ? `\n📝 _${media.caption}_` : "";
          const isGroup = from.endsWith("@g.us");
          const caption =
            `👁 *View-Once Revealed* by NEXUS-MD\n` +
            `${"─".repeat(28)}\n` +
            `${typeLabel}\n` +
            `👤 *Sender:* ${senderNum}\n` +
            `🕐 *Time:* ${timeStr}` +
            origCaption;

          // 1 — Re-send in the original chat so everyone can see/save it
          if (mt === "imageMessage")
            await sock.sendMessage(from, { image: buf, caption });
          else if (mt === "videoMessage")
            await sock.sendMessage(from, { video: buf, caption, mimetype: media.mimetype || "video/mp4" });
          else
            await sock.sendMessage(from, { audio: buf, mimetype: media.mimetype || "audio/ogg; codecs=opus", ptt: media.ptt || false });

          // 2 — In a private DM, also forward the media to every owner so they never miss it
          if (!isGroup) {
            const { admins: ownerNums } = require("./config");
            if (ownerNums?.length) {
              const ownerDmCaption =
                `👁 *View-Once Forwarded to You*\n` +
                `${"─".repeat(28)}\n` +
                `${typeLabel} from *${senderNum}*\n` +
                `🕐 *Time:* ${timeStr}` +
                origCaption;
              for (const num of ownerNums) {
                const ownerJid = `${num.replace(/\D/g, "")}@s.whatsapp.net`;
                if (ownerJid === senderJid) continue; // don't re-send to sender themselves
                if (mt === "imageMessage")
                  await sock.sendMessage(ownerJid, { image: buf, caption: ownerDmCaption }).catch(() => {});
                else if (mt === "videoMessage")
                  await sock.sendMessage(ownerJid, { video: buf, caption: ownerDmCaption, mimetype: media.mimetype || "video/mp4" }).catch(() => {});
                else
                  await sock.sendMessage(ownerJid, { audio: buf, mimetype: media.mimetype || "audio/ogg; codecs=opus", ptt: media.ptt || false }).catch(() => {});
              }
            }
          }
        } catch (e) { console.error("AutoReveal error:", e.message); }
      })();
    }

    // Anti-sticker (groups only)
    if (from.endsWith("@g.us") && msgType === "stickerMessage") {
      const gs = security.getGroupSettings(from);
      if (gs.antiSticker) {
        (async () => {
          try {
            const parts = await admin.getGroupParticipants(sock, from).catch(() => []);
            if (!admin.isAdmin(senderJid, parts)) {
              await sock.sendMessage(from, { delete: msg.key });
              await sock.sendMessage(from, { text: `🚫 @${phone} stickers are not allowed here!`, mentions: [`${phone}@s.whatsapp.net`] }, { quoted: msg });
            }
          } catch {}
        })();
      }
    }
  }

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    // "notify" = live real-time messages | "append" = history sync
    const isLive = type === "notify";
    const nowSec = Math.floor(Date.now() / 1000);

    for (const msg of messages) {
      if (!msg.message) continue;

      // Cache for getMessage (enables Baileys to retry failed decryptions)
      _cacheMsg(msg);

      const from      = msg.key.remoteJid;
      const senderJid = msg.key.participant || from;

      // ── PASSIVE LAYER — every message, every type, always ────────────────
      // Anti-delete cache + DB log run synchronously so they are never missed.

      if (from === "status@broadcast") {
        security.cacheStatus(msg.key.id, msg);
      } else {
        security.cacheMessage(msg.key.id, msg);
        // Eagerly download and store the media buffer so antidelete can
        // recover it even after the WhatsApp CDN URL expires on deletion.
        _eagerCacheMedia(msg).catch(() => {});
      }

      // DB log — use normalizeMessageContent for accurate body extraction
      const _dbNorm    = normalizeMessageContent(msg.message) || {};
      const _dbInner   = msg.message?.ephemeralMessage?.message || msg.message || {};
      const msgTypeKey = getContentType(_dbNorm) || Object.keys(msg.message || {})[0] || "text";
      const msgBody    =
        _dbNorm.conversation ||
        _dbNorm.extendedTextMessage?.text ||
        _dbInner.conversation ||
        _dbInner.extendedTextMessage?.text ||
        _dbNorm.imageMessage?.caption ||
        _dbInner.imageMessage?.caption ||
        _dbNorm.videoMessage?.caption ||
        _dbInner.videoMessage?.caption ||
        _dbNorm.documentMessage?.caption || null;
      const dbPrefix   = settings.get("prefix") || ".";
      db.logMessage(
        senderJid,
        from.endsWith("@g.us") ? from : null,
        { conversation: "text", extendedTextMessage: "text", ephemeralMessage: "text",
          imageMessage: "image", videoMessage: "video", audioMessage: "audio",
          documentMessage: "document", stickerMessage: "sticker", contactMessage: "contact",
          locationMessage: "location", reactionMessage: "reaction",
          pollCreationMessage: "poll", viewOnceMessage: "viewonce",
          viewOnceMessageV2: "viewonce", protocolMessage: "protocol" }[msgTypeKey] || msgTypeKey,
        msgBody,
        !!(msgBody && msgBody.startsWith(dbPrefix))
      );

      // ── ACTIVE LAYER — live or recent (≤60s) messages only ───────────────
      const msgTs    = Number(msg.messageTimestamp || 0);
      const isRecent = isLive || (nowSec - msgTs <= 60);
      if (!isRecent) continue;

      // Fire each message as an independent async task — never blocks the loop
      // On Heroku, this means .ping responds immediately even while history syncs
      processMessage(msg).catch(err => console.error("processMessage error:", err.message));
    }
  });

  sock.ev.on("call", async ([call]) => {
    if (!settings.get("antiCall")) return;
    try {
      await sock.rejectCall(call.id, call.from);
      await sock.sendMessage(call.from, {
        text: "📵 *Auto-reject:* I don't accept calls. Please send a message instead.",
      });
      console.log(`📵 Rejected call from ${call.from}`);
    } catch (err) {
      console.error("Anti-call error:", err.message);
    }
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    admin.invalidateGroupCache(id);
    // Normalize participants — Baileys v7 may yield objects {id, admin} or plain JID strings
    const normalizeJid = (p) => typeof p === "string" ? p : (p?.id || p?.jid || String(p));
    if (action === "add") {
      for (const p of participants) {
        const memberJid = normalizeJid(p);
        // Standard welcome message
        await groups.sendWelcome(sock, id, memberJid).catch(() => {});
        // Premium welcome card (if enabled for this group)
        if (premium.isWelcomeCardEnabled(id)) {
          (async () => {
            try {
              const meta      = await sock.groupMetadata(id);
              const member       = meta.participants.find(x => x.id === memberJid);
              const memberBase   = `${memberJid.split("@")[0].split(":")[0]}@s.whatsapp.net`;
              const name         = member?.notify || memberJid.split("@")[0].split(":")[0];
              const cardBuf      = await premium.generateWelcomeCard(name, meta.subject);
              if (cardBuf) {
                await sock.sendMessage(id, {
                  image:   cardBuf,
                  caption: `🎉 Welcome *${name}* to *${meta.subject}*! 🎊\n\n_Enjoy your stay — NEXUS-MD ⚡_`,
                  mentions: [memberBase],
                });
              }
            } catch (e) {
              console.error("[WelcomeCard] error:", e.message);
            }
          })();
        }
      }
    } else if (action === "remove") {
      for (const p of participants) await groups.sendGoodbye(sock, id, normalizeJid(p)).catch(() => {});
      const antiLeaveOn = security.getGroupSettings(id).antiLeave;
      if (antiLeaveOn) {
        for (const p of participants) {
          const jid = normalizeJid(p);
          try {
            await sock.groupParticipantsUpdate(id, [jid], "add");
            const _baseJid = `${jid.split("@")[0].split(":")[0]}@s.whatsapp.net`;
            await sock.sendMessage(id, { text: `🚪 Anti-leave: @${jid.split("@")[0].split(":")[0]} was re-added.`, mentions: [_baseJid] });
          } catch (e) {
            console.log(`[ANTI-LEAVE] Could not re-add ${jid}: ${e.message}`);
          }
        }
      }
    }
  });

  // ── Universal anti-delete: recover ALL media types from groups, DMs and status ──
  sock.ev.on("messages.delete", async (item) => {
    if (!("keys" in item)) return;

    const mode    = settings.get("antiDeleteMode") || "off";
    const ownerDM = botPhoneNumber ? `${botPhoneNumber}@s.whatsapp.net` : null;

    // ── Shared helper — send recovered content to any destination JID ──────
    const sendRecovered = async (destJid, headerLabel, original, senderPhone, deleterJid) => {
      if (!destJid) return;
      try {
        const msgType = Object.keys(original.message || {})[0];
        if (!msgType || ["protocolMessage", "reactionMessage", "ephemeralMessage"].includes(msgType)) return;

        const BN       = settings.get("botName") || "NEXUS-MD";
        const _tz      = settings.get("timezone") || "Africa/Nairobi";
        const now      = new Date();
        const dateStr  = now.toLocaleDateString("en-GB",  { timeZone: _tz, day: "2-digit", month: "short",  year: "numeric" });
        const timeStr  = now.toLocaleTimeString("en-US",  { timeZone: _tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
        const deleterDisplay = deleterJid ? `+${deleterJid.split("@")[0].split(":")[0]}` : `+${senderPhone}`;
        const header =
          `🤖 *${BN} — Anti-Delete*\n` +
          `${"─".repeat(30)}\n` +
          `🗑 *${headerLabel}*\n` +
          `👤 *Sender:* +${senderPhone}\n` +
          `🗑 *Deleted by:* ${deleterDisplay}\n` +
          `📅 *Date:* ${dateStr}\n` +
          `🕐 *Time:* ${timeStr}`;

        // ── text ────────────────────────────────────────────────────────────
        const text = original.message?.conversation || original.message?.extendedTextMessage?.text;
        if (text) {
          await sock.sendMessage(destJid, {
            text: `${header}\n\n${text}`,
            mentions: deleterJid ? [deleterJid] : [],
          }).catch(() => {});
          return;
        }

        // ── media ───────────────────────────────────────────────────────────
        const MEDIA_TYPES = ["imageMessage","videoMessage","audioMessage","stickerMessage","documentMessage","ptvMessage"];
        if (!MEDIA_TYPES.includes(msgType)) {
          await sock.sendMessage(destJid, { text: `${header}\n\n_[${msgType.replace("Message","")} — could not retrieve content]_` }).catch(() => {});
          return;
        }

        // Prefer the eagerly-cached buffer (downloaded on arrival, before CDN URL expired)
        const _eagerEntry = _mediaBufferCache.get(original.key?.id);
        let mediaBuf = _eagerEntry?.buffer || null;
        let msgData  = original.message[msgType] || {};

        // Override msgData fields from eager cache when available (more reliable)
        if (_eagerEntry) {
          msgData = {
            mimetype:    _eagerEntry.mimetype    || msgData.mimetype,
            ptt:         _eagerEntry.ptt         ?? msgData.ptt,
            caption:     _eagerEntry.caption     || msgData.caption,
            fileName:    _eagerEntry.fileName    || msgData.fileName,
            gifPlayback: _eagerEntry.gifPlayback ?? msgData.gifPlayback,
          };
        }

        // Fallback: try live download if eager buffer is missing
        if (!mediaBuf) {
          mediaBuf = await downloadMediaMessage(original, "buffer", {}).catch(() => null);
        }

        if (!mediaBuf) {
          await sock.sendMessage(destJid, { text: `${header}\n\n_[Media could not be retrieved — it may have expired]_` }).catch(() => {});
          return;
        }

        const caption  = (msgData.caption ? `\n_${msgData.caption}_` : "");

        if (msgType === "stickerMessage") {
          await sock.sendMessage(destJid, { sticker: mediaBuf }).catch(() => {});
          await sock.sendMessage(destJid, { text: `${header} _(sticker)_` }).catch(() => {});
        } else if (msgType === "audioMessage") {
          await sock.sendMessage(destJid, {
            audio:    mediaBuf,
            mimetype: msgData.mimetype || (msgData.ptt ? "audio/ogg; codecs=opus" : "audio/mpeg"),
            ptt:      msgData.ptt || false,
          }).catch(() => {});
          await sock.sendMessage(destJid, { text: `${header} _(${msgData.ptt ? "voice note" : "audio"})_` }).catch(() => {});
        } else if (msgType === "videoMessage" || msgType === "ptvMessage") {
          await sock.sendMessage(destJid, {
            video:    mediaBuf,
            caption:  `${header}${caption}`,
            mimetype: msgData.mimetype || "video/mp4",
            gifPlayback: msgData.gifPlayback || false,
          }).catch(() => {});
        } else if (msgType === "imageMessage") {
          await sock.sendMessage(destJid, {
            image:   mediaBuf,
            caption: `${header}${caption}`,
          }).catch(() => {});
        } else if (msgType === "documentMessage") {
          await sock.sendMessage(destJid, {
            document: mediaBuf,
            mimetype: msgData.mimetype || "application/octet-stream",
            fileName: msgData.fileName || "file",
            caption:  `${header}`,
          }).catch(() => {});
        }
      } catch {}
    };

    for (const key of item.keys) {
      if (!key.remoteJid) continue;
      const isStatus = key.remoteJid === "status@broadcast";
      const isGroup  = key.remoteJid.endsWith("@g.us");
      const isDM     = !isStatus && !isGroup;

      // ── Determine if this delete should be processed based on global mode ──
      const modeCoversStatus = ["status","all"].includes(mode);
      const modeCoversGroup  = ["group","both","all"].includes(mode);
      const modeCoversChat   = ["chat","both","all"].includes(mode);

      // ── STATUS delete ──────────────────────────────────────────────────────
      if (isStatus) {
        if (!modeCoversStatus) continue;
        const cached = security.getCachedStatus(key.id);
        if (!cached) continue;
        const original    = cached.msg;
        const ownerPhone  = (key.participant || original.key?.participant || "?").split("@")[0].split(":")[0];
        if (ownerDM) {
          await sendRecovered(ownerDM, `Deleted Status — @${ownerPhone}`, original, ownerPhone, null);
        }
        continue;
      }

      // ── GROUP delete ───────────────────────────────────────────────────────
      if (isGroup) {
        const grpSettings  = security.getGroupSettings(key.remoteJid);
        const groupEnabled = grpSettings.antiDelete || modeCoversGroup;
        if (!groupEnabled) continue;
        const cached = security.getCachedMessage(key.id);
        if (!cached) continue;
        const original    = cached.msg;
        const senderPhone = (key.participant || original.key?.participant || "?").split("@")[0].split(":")[0];
        const deleterJid  = key.participant || null;
        const label       = `Anti-Delete | Group`;

        // 1. Repost in the group
        await sendRecovered(key.remoteJid, label, original, senderPhone, deleterJid);
        // 2. Copy to owner DM
        if (ownerDM) await sendRecovered(ownerDM, `${label} — +${senderPhone}`, original, senderPhone, null);
        // 3. Warn the deleter privately
        if (deleterJid && !deleterJid.endsWith("@g.us")) {
          await sock.sendMessage(deleterJid, {
            text: `👀 *Anti-Delete Warning*\n\nYou deleted a message in a group and it was caught! 😏\n\n_The content has been forwarded to the group and the bot owner._`,
          }).catch(() => {});
        }
        continue;
      }

      // ── DM / PRIVATE CHAT delete ───────────────────────────────────────────
      if (isDM) {
        if (!modeCoversChat) continue;
        const cached = security.getCachedMessage(key.id);
        if (!cached) continue;
        const original    = cached.msg;
        const senderPhone = (key.remoteJid || "?").split("@")[0].split(":")[0];
        const label       = `Anti-Delete | Chat`;

        // 1. Send to owner DM
        if (ownerDM) await sendRecovered(ownerDM, `${label} — +${senderPhone}`, original, senderPhone, null);
        continue;
      }
    }
  });

  sock.ev.on("presences.update", ({ id, presences }) => {
    for (const [jid, presence] of Object.entries(presences)) {
      if (presence.lastKnownPresence === "composing") {
        console.log(`✏️ ${jid.split("@")[0]} is typing in ${id.split("@")[0]}...`);
      }
    }
  });
}

const { initializeDatabase, getSettings } = require('./database/config');

db.init()
  .then(async () => {
    // Bootstrap all default settings into the DB so every key is persisted
    settings.initSettings();

    // ── Perez settings table (bot_settings) ────────────────────────────────
    try { await initializeDatabase(); } catch (e) { console.log('⚠️  Perez DB init:', e.message); }

    // ── Session restore priority ────────────────────────────────────────────
    // 1. DB-persisted session (most recent — updated every 10 s while running)
    // 2. SESSION_ID env var (original setup value — fallback if DB is empty)
    //
    // Persisting to DB prevents logout when Heroku/panel restarts the process
    // and wipes the ephemeral auth_info_baileys/ folder, leaving the bot with
    // a stale SESSION_ID env var that WhatsApp has already rotated away from.
    const dbSession = db.read("_latestSession", null);
    // Check all recognised session env vars (Perez uses SESSION, IgniteBot uses SESSION_ID)
    const envSession = process.env.SESSION_ID || process.env.SESSION || null;
    const sessionToRestore = dbSession?.id || envSession || null;
    if (sessionToRestore) {
      const fromEnvOnly = !dbSession?.id && !!envSession;
      const src = fromEnvOnly ? "SESSION / SESSION_ID env var" : "database (latest)";
      console.log(`📦 Restoring WhatsApp session from ${src}...`);
      await restoreSession(sessionToRestore);
      // If the session came from the env var (DB was empty), immediately write it to
      // the database so it survives the next Heroku dyno restart even if the dyno is
      // killed before WhatsApp finishes the handshake and the periodic save fires.
      if (fromEnvOnly) {
        try {
          const sid = encodeSession();
          if (sid) {
            db.write("_latestSession", { id: sid });
            console.log("💾 Session pre-saved to database (env-var bootstrap).");
          }
        } catch (_) {}
      }
    }
    return startnexus();
  })
  .catch((err) => {
    console.error("Fatal bot startup error:", err);
    // Don't exit — retry the full startup after 15 s so Heroku doesn't see a crash.
    console.log("🔄 Retrying full startup in 15 s...");
    setTimeout(() => {
      db.init()
        .then(async () => {
          settings.initSettings();
          try { await initializeDatabase(); } catch (e) { console.log("⚠️  Perez DB init:", e.message); }
          const dbSession = db.read("_latestSession", null);
          const envSession = process.env.SESSION_ID || process.env.SESSION || null;
          const sessionToRestore = dbSession?.id || envSession || null;
          if (sessionToRestore) await restoreSession(sessionToRestore).catch(() => {});
          return startnexus();
        })
        .catch((err2) => {
          console.error("Fatal bot error (retry):", err2.message);
        });
    }, 15000);
  });
