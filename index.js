const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const commands = require("./lib/commands");
const groups = require("./lib/groups");
const security = require("./lib/security");
const broadcast = require("./lib/broadcast");
const settings = require("./lib/settings");
const admin = require("./lib/admin");
const dashboardRouter = require("./web/dashboard");

const app = express();
const PORT = process.env.PORT || 5000;
const AUTH_FOLDER = "./auth_info_baileys";

let currentQR = null;
let botStatus = "disconnected";
let botPhoneNumber = null;
let sockRef = null;
let alwaysOnlineInterval = null;
let currentSessionId = null;

function encodeSession() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return null;
    const files = {};
    function readDir(dir, prefix) {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const key = prefix ? `${prefix}/${item}` : item;
        const stat = fs.statSync(full);
        if (stat.isFile()) {
          files[key] = fs.readFileSync(full).toString("base64");
        } else if (stat.isDirectory()) {
          readDir(full, key);
        }
      }
    }
    readDir(AUTH_FOLDER, "");
    if (!Object.keys(files).length) return null;
    return Buffer.from(JSON.stringify(files)).toString("base64");
  } catch {
    return null;
  }
}

function restoreSession(sessionId) {
  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    const files = JSON.parse(Buffer.from(sessionId, "base64").toString("utf8"));
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(AUTH_FOLDER, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(content, "base64"));
    }
    console.log("✅ Session restored from SESSION_ID");
    return true;
  } catch (err) {
    console.error("❌ Failed to restore session:", err.message);
    return false;
  }
}

if (process.env.SESSION_ID && !fs.existsSync(AUTH_FOLDER)) {
  console.log("📦 Restoring WhatsApp session from SESSION_ID...");
  restoreSession(process.env.SESSION_ID);
}

app.use(express.json());
app.use(dashboardRouter);

app.get("/", async (req, res) => {
  let qrImageTag = "";
  if (currentQR) {
    try {
      const qrDataUrl = await QRCode.toDataURL(currentQR);
      qrImageTag = `<img src="${qrDataUrl}" alt="QR Code" style="width:260px;height:260px;" />`;
    } catch {
      qrImageTag = "<p>Check the terminal for the QR code.</p>";
    }
  }
  const statusColor = botStatus === "connected" ? "#25D366" : botStatus === "connecting" ? "#FFA500" : "#e74c3c";
  res.send(getHomePage(statusColor, qrImageTag));
});

app.get("/pair", (req, res) => res.send(getPairPage()));

app.post("/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ success: false, error: "Phone number required" });
  if (!sockRef) return res.json({ success: false, error: "Bot is not ready yet. Wait a moment and try again." });
  try {
    const cleaned = phone.replace(/[^0-9]/g, "");
    const code = await sockRef.requestPairingCode(cleaned);
    res.json({ success: true, code });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get("/api/session", (req, res) => {
  const sid = encodeSession();
  currentSessionId = sid;
  res.json({ sessionId: sid, connected: botStatus === "connected", phone: botPhoneNumber });
});

app.get("/status", (req, res) => {
  res.json({ status: botStatus, phone: botPhoneNumber, mode: settings.get("mode") });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ IgniteBot web server running on port ${PORT}`);
});

function getHomePage(statusColor, qrImageTag) {
  const s = settings.getAll();
  const on = (v) => v ? `<span style="color:#25D366">ON</span>` : `<span style="color:#e74c3c">OFF</span>`;

  const connectedHTML = `
    <div class="connected-msg">✅ Bot is Online</div>
    <div class="phone-tag">+${botPhoneNumber || "Unknown"}</div>

    <div class="session-card">
      <div class="session-header">
        <span>📋 Your Session ID</span>
        <span class="session-note">Save this to keep the bot running on Heroku</span>
      </div>
      <textarea id="sid" class="session-area" readonly placeholder="Loading session ID..."></textarea>
      <div class="session-actions">
        <button class="btn-copy" onclick="copySid()">📋 Copy Session ID</button>
        <button class="btn-refresh" onclick="loadSid()">🔄 Refresh</button>
      </div>
      <div class="session-instructions">
        <strong>To keep the bot running after Heroku restarts:</strong>
        <ol>
          <li>Copy the Session ID above</li>
          <li>Go to Heroku → Your App → Settings → Config Vars</li>
          <li>Add variable: <code>SESSION_ID</code> = (paste here)</li>
          <li>Bot will auto-connect on next restart</li>
        </ol>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-item"><label>Mode</label>${s.mode?.toUpperCase()}</div>
      <div class="info-item"><label>Always Online</label>${on(s.alwaysOnline)}</div>
      <div class="info-item"><label>Auto View Status</label>${on(s.autoViewStatus)}</div>
      <div class="info-item"><label>Auto Like Status</label>${on(s.autoLikeStatus)}</div>
      <div class="info-item"><label>Anti Call</label>${on(s.antiCall)}</div>
      <div class="info-item"><label>Anti Delete Status</label>${on(s.antiDeleteStatus)}</div>
    </div>
    <div class="btns">
      <a href="/dashboard" class="btn btn-green">📊 Dashboard</a>
      <a href="/pair" class="btn btn-blue">🔗 Pair Device</a>
    </div>`;

  const connectingHTML = `
    <div class="qr-box">${qrImageTag}</div>
    <div class="instruction">
      Scan with WhatsApp to connect the bot.
      <ol>
        <li>Open WhatsApp on your phone</li>
        <li>Tap Menu (⋮) → Linked Devices</li>
        <li>Tap "Link a Device"</li>
        <li>Point your camera at the QR code</li>
      </ol>
    </div>
    <div class="btns" style="margin-top:14px">
      <a href="/pair" class="btn btn-blue">🔗 Link with Phone Number Instead</a>
    </div>`;

  const waitingHTML = `<div class="instruction">⏳ Starting up… QR will appear shortly.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>IgniteBot</title>
  ${botStatus !== "connected" ? '<meta http-equiv="refresh" content="5"/>' : ""}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111b21;color:#e9edef;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
    .card{background:#202c33;border-radius:16px;padding:32px 36px;max-width:540px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
    .logo{font-size:2.2rem;font-weight:700;color:#25D366;margin-bottom:4px}
    .subtitle{font-size:0.88rem;color:#8696a0;margin-bottom:18px}
    .status-badge{display:inline-flex;align-items:center;gap:8px;background:#111b21;border-radius:20px;padding:6px 16px;font-size:0.85rem;font-weight:500;margin-bottom:18px}
    .dot{width:10px;height:10px;border-radius:50%;background:${statusColor}}
    .qr-box{background:#fff;border-radius:12px;padding:14px;display:inline-block;margin-bottom:14px}
    .instruction{font-size:0.83rem;color:#8696a0;line-height:1.6}
    .instruction ol{text-align:left;padding-left:18px;margin-top:8px}
    .instruction li{margin-bottom:4px}
    .connected-msg{font-size:1.1rem;color:#25D366;font-weight:700;margin-bottom:4px}
    .phone-tag{font-size:0.88rem;color:#8696a0;margin-bottom:18px}
    .session-card{background:#111b21;border-radius:12px;padding:18px;margin-bottom:16px;text-align:left}
    .session-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
    .session-header span:first-child{font-weight:600;font-size:0.9rem}
    .session-note{font-size:0.72rem;color:#8696a0}
    .session-area{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px;color:#58a6ff;font-family:monospace;font-size:0.72rem;height:80px;resize:none;outline:none;word-break:break-all;margin-bottom:10px}
    .session-actions{display:flex;gap:8px;margin-bottom:14px}
    .btn-copy{flex:1;background:#25D366;color:#111;border:none;border-radius:8px;padding:9px;font-weight:600;cursor:pointer;font-size:0.85rem}
    .btn-refresh{background:#30363d;color:#e9edef;border:none;border-radius:8px;padding:9px 14px;cursor:pointer;font-size:0.85rem}
    .session-instructions{font-size:0.78rem;color:#8696a0;line-height:1.7}
    .session-instructions ol{padding-left:16px;margin-top:6px}
    .session-instructions li{margin-bottom:3px}
    .session-instructions code{background:#1f2937;padding:1px 5px;border-radius:4px;color:#58a6ff;font-size:0.75rem}
    .session-instructions strong{color:#e9edef}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:14px 0;text-align:left}
    .info-item{background:#111b21;border-radius:8px;padding:8px 12px;font-size:0.82rem}
    .info-item label{color:#8696a0;display:block;font-size:0.72rem;margin-bottom:2px}
    .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px}
    .btn{padding:10px 20px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.88rem;display:inline-block}
    .btn-green{background:#25D366;color:#111}
    .btn-blue{background:#1f6feb;color:#fff}
    .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#25D366;color:#111;padding:10px 24px;border-radius:20px;font-weight:600;font-size:0.9rem;opacity:0;transition:opacity 0.3s;pointer-events:none}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">⚡ IgniteBot</div>
  <div class="subtitle">Full-Featured WhatsApp Bot · 30+ Features</div>
  <div class="status-badge">
    <div class="dot"></div>
    ${botStatus === "connected" ? "Connected & Running" : botStatus === "connecting" ? "Connecting…" : "Waiting for QR Scan"}
  </div>
  ${botStatus === "connected" ? connectedHTML : currentQR ? connectingHTML : waitingHTML}
</div>
<div class="toast" id="toast">✅ Copied!</div>
<script>
async function loadSid() {
  try {
    const r = await fetch('/api/session');
    const d = await r.json();
    document.getElementById('sid').value = d.sessionId || 'Session not ready yet. Try again in a moment.';
  } catch { document.getElementById('sid').value = 'Error loading session. Try refreshing.'; }
}
function copySid() {
  const el = document.getElementById('sid');
  if (!el.value || el.value.includes('not ready')) return;
  navigator.clipboard.writeText(el.value).then(() => showToast()).catch(() => {
    el.select(); document.execCommand('copy'); showToast();
  });
}
function showToast() {
  const t = document.getElementById('toast');
  t.style.opacity = '1';
  setTimeout(() => t.style.opacity = '0', 2500);
}
${botStatus === "connected" ? "window.onload = loadSid;" : ""}
</script>
</body>
</html>`;
}

function getPairPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>IgniteBot — Pair Device</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111b21;color:#e9edef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#202c33;border-radius:16px;padding:36px;max-width:460px;width:100%;text-align:center}
    h1{color:#25D366;font-size:1.5rem;margin-bottom:6px}
    .sub{color:#8696a0;font-size:0.88rem;margin-bottom:22px;line-height:1.5}
    input{width:100%;background:#111b21;border:1px solid #30363d;border-radius:8px;padding:12px 16px;color:#e9edef;font-size:1rem;margin-bottom:14px;outline:none}
    input:focus{border-color:#25D366}
    .btn-main{width:100%;background:#25D366;color:#111;border:none;border-radius:8px;padding:12px;font-size:1rem;font-weight:700;cursor:pointer}
    .result{margin-top:18px;background:#111b21;border-radius:10px;padding:18px;display:none;text-align:left}
    .code-box{text-align:center;font-size:2.2rem;font-weight:700;letter-spacing:8px;color:#25D366;margin:10px 0 14px;background:#0d1117;border-radius:8px;padding:12px}
    .error{color:#f85149}
    .after-pair{display:none;margin-top:18px;background:#1a2f1a;border:1px solid #25D366;border-radius:10px;padding:16px;text-align:left}
    .after-pair h3{color:#25D366;margin-bottom:8px;font-size:0.9rem}
    .session-area{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px;color:#58a6ff;font-family:monospace;font-size:0.7rem;height:72px;resize:none;outline:none;word-break:break-all;margin:8px 0}
    .btn-copy{width:100%;background:#25D366;color:#111;border:none;border-radius:8px;padding:9px;font-weight:600;cursor:pointer;margin-bottom:10px}
    .steps{text-align:left;font-size:0.8rem;color:#8696a0;line-height:1.8;margin-bottom:18px;padding-left:16px}
    .steps li{margin-bottom:3px}
    .back{display:inline-block;margin-top:16px;color:#8696a0;font-size:0.83rem;text-decoration:none}
    code{background:#1f2937;padding:1px 5px;border-radius:4px;color:#58a6ff;font-size:0.75rem}
    .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#25D366;color:#111;padding:10px 24px;border-radius:20px;font-weight:600;font-size:0.9rem;opacity:0;transition:opacity 0.3s;pointer-events:none}
  </style>
</head>
<body>
<div class="card">
  <h1>🔗 Pair Device</h1>
  <p class="sub">Connect your WhatsApp without scanning a QR code. Enter your phone number to get a pairing code.</p>
  <ol class="steps">
    <li>Enter your number in international format (no + or spaces)</li>
    <li>Open WhatsApp → Menu → Linked Devices → Link a Device</li>
    <li>Tap <strong>"Link with phone number"</strong></li>
    <li>Enter the 8-character code shown below</li>
    <li>After connecting, copy your <strong>Session ID</strong></li>
    <li>Paste it as <code>SESSION_ID</code> on Heroku Config Vars</li>
  </ol>
  <input type="tel" id="phone" placeholder="Phone number e.g. 12345678901" />
  <button class="btn-main" onclick="getPairCode()">Get Pairing Code</button>
  <div class="result" id="result">
    <div id="resultMsg" style="margin-bottom:8px;font-size:0.88rem"></div>
    <div class="code-box" id="pairCode"></div>
    <div id="sessionSection" style="display:none">
      <div style="font-size:0.82rem;color:#8696a0;margin-bottom:6px">
        ⏳ Waiting for WhatsApp connection… Session ID will appear here after you enter the code above.
      </div>
    </div>
  </div>

  <div class="after-pair" id="afterPair">
    <h3>📋 Your Session ID — Copy &amp; Save This!</h3>
    <div style="font-size:0.78rem;color:#8696a0;margin-bottom:6px">Paste this as <code>SESSION_ID</code> in Heroku Config Vars to keep the bot running after restarts</div>
    <textarea class="session-area" id="sessionId" readonly placeholder="Fetching session ID..."></textarea>
    <button class="btn-copy" onclick="copySession()">📋 Copy Session ID</button>
    <div style="font-size:0.78rem;color:#8696a0;line-height:1.6">
      <strong style="color:#e9edef">How to save on Heroku:</strong>
      <ol style="padding-left:16px;margin-top:4px">
        <li>Go to Heroku Dashboard → Your App</li>
        <li>Settings → Config Vars → Reveal Config Vars</li>
        <li>Add: Key = <code>SESSION_ID</code>, Value = (paste copied ID)</li>
        <li>Click Add. Bot will auto-connect after restart! ✅</li>
      </ol>
    </div>
  </div>

  <a href="/" class="back">← Back to Home</a>
</div>
<div class="toast" id="toast">✅ Copied!</div>
<script>
let polling = null;

async function getPairCode() {
  const phone = document.getElementById('phone').value.trim();
  if (!phone) return alert('Please enter your phone number');
  const result = document.getElementById('result');
  result.style.display = 'block';
  document.getElementById('resultMsg').textContent = 'Getting pairing code...';
  document.getElementById('pairCode').textContent = '';
  try {
    const res = await fetch('/pair', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('resultMsg').innerHTML = '<strong style="color:#25D366">✅ Enter this code in WhatsApp:</strong>';
      document.getElementById('pairCode').textContent = data.code;
      document.getElementById('sessionSection').style.display = 'block';
      startPollingSession();
    } else {
      document.getElementById('resultMsg').innerHTML = '<span class="error">❌ ' + data.error + '</span>';
    }
  } catch(e) {
    document.getElementById('resultMsg').innerHTML = '<span class="error">❌ Network error. Try again.</span>';
  }
}

function startPollingSession() {
  if (polling) clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const r = await fetch('/api/session');
      const d = await r.json();
      if (d.connected && d.sessionId) {
        clearInterval(polling);
        document.getElementById('afterPair').style.display = 'block';
        document.getElementById('sessionId').value = d.sessionId;
      }
    } catch {}
  }, 3000);
}

function copySession() {
  const el = document.getElementById('sessionId');
  if (!el.value || el.value.includes('Fetching')) return;
  navigator.clipboard.writeText(el.value).then(() => showToast()).catch(() => {
    el.select(); document.execCommand('copy'); showToast();
  });
}

function showToast() {
  const t = document.getElementById('toast');
  t.style.opacity = '1';
  setTimeout(() => t.style.opacity = '0', 2500);
}
</script>
</body>
</html>`;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    markOnlineOnConnect: true,
  });

  sockRef = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      botStatus = "connecting";
      console.log("\n📱 Scan QR code in the web preview:\n");
      qrcodeTerminal.generate(qr, { small: true });
      console.log("\n→ Or visit /pair to link via phone number\n");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      botStatus = "disconnected";
      currentQR = null;
      sockRef = null;
      if (alwaysOnlineInterval) { clearInterval(alwaysOnlineInterval); alwaysOnlineInterval = null; }
      console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log("Logged out. Clearing session...");
        if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        setTimeout(startBot, 1000);
      }
    }

    if (connection === "open") {
      botStatus = "connected";
      currentQR = null;
      sockRef = sock;
      const jid = sock.user?.id;
      if (jid) botPhoneNumber = jid.split(":")[0].replace("@s.whatsapp.net", "");
      currentSessionId = encodeSession();
      console.log("✅ WhatsApp bot connected!");
      console.log(`📞 Connected as: +${botPhoneNumber}`);
      console.log("📋 Session ID generated — copy it from the web panel");
      console.log("⚡ All 30+ features active. Type !menu");

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

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const senderJid = msg.key.participant || from;

      if (security.isBanned(senderJid)) continue;

      if (from === "status@broadcast") {
        if (settings.get("antiDeleteStatus")) security.cacheStatus(msg.key.id, msg);
        if (settings.get("autoViewStatus")) await sock.readMessages([msg.key]).catch(() => {});
        if (settings.get("autoLikeStatus")) {
          const statusOwner = msg.key.participant || senderJid;
          await sock.sendMessage(
            statusOwner,
            { react: { text: "❤️", key: msg.key } },
            { statusJidList: [statusOwner, sock.user?.id].filter(Boolean) }
          ).catch(() => {});
        }
        continue;
      }

      broadcast.addRecipient(senderJid);
      await commands.handle(sock, msg).catch((err) => {
        console.error("Message handler error:", err.message);
      });
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
    if (action === "add") {
      for (const p of participants) await groups.sendWelcome(sock, id, p).catch(() => {});
    } else if (action === "remove") {
      for (const p of participants) await groups.sendGoodbye(sock, id, p).catch(() => {});
    }
  });

  sock.ev.on("messages.delete", async (item) => {
    if (!("keys" in item)) return;
    for (const key of item.keys) {
      if (!key.remoteJid) continue;

      if (key.remoteJid === "status@broadcast" && settings.get("antiDeleteStatus")) {
        const cached = security.getCachedStatus(key.id);
        if (cached && botPhoneNumber) {
          const adminJid = `${botPhoneNumber}@s.whatsapp.net`;
          const originalMsg = cached.msg;
          const msgType = Object.keys(originalMsg.message || {})[0];
          const ownerPhone = (key.participant || "").split("@")[0];
          try {
            if (msgType === "conversation" || msgType === "extendedTextMessage") {
              const text = originalMsg.message?.conversation || originalMsg.message?.extendedTextMessage?.text;
              if (text) await sock.sendMessage(adminJid, { text: `🗑 *Deleted Status from @${ownerPhone}:*\n\n${text}` });
            } else if (msgType === "imageMessage" || msgType === "videoMessage") {
              const mediaBuf = await downloadMediaMessage(originalMsg, "buffer", {}).catch(() => null);
              if (mediaBuf) {
                const isVideo = msgType === "videoMessage";
                await sock.sendMessage(adminJid, {
                  [isVideo ? "video" : "image"]: mediaBuf,
                  caption: `🗑 *Deleted ${isVideo ? "video" : "image"} status from @${ownerPhone}*`,
                });
              }
            }
          } catch (err) { console.error("Anti-delete status error:", err.message); }
        }
        continue;
      }

      if (!key.remoteJid.endsWith("@g.us")) continue;
      const grpSettings = security.getGroupSettings(key.remoteJid);
      if (!grpSettings.antiDelete) continue;
      const cached = security.getCachedMessage(key.id);
      if (!cached) continue;
      const original = cached.msg;
      const body = original.message?.conversation || original.message?.extendedTextMessage?.text || "";
      const senderPhone = (key.participant || "").split("@")[0];
      if (body) {
        await sock.sendMessage(key.remoteJid, {
          text: `🗑 *Deleted message from @${senderPhone}:*\n\n${body}`,
          mentions: [key.participant],
        }).catch(() => {});
      } else {
        const msgType = Object.keys(original.message || {})[0];
        if (msgType === "imageMessage" || msgType === "videoMessage") {
          try {
            const mediaBuf = await downloadMediaMessage(original, "buffer", {});
            const isVideo = msgType === "videoMessage";
            await sock.sendMessage(key.remoteJid, {
              [isVideo ? "video" : "image"]: Buffer.from(mediaBuf),
              caption: `🗑 *Deleted ${isVideo ? "video" : "image"} from @${senderPhone}*`,
              mentions: [key.participant],
            }).catch(() => {});
          } catch {}
        }
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

startBot().catch((err) => {
  console.error("Fatal bot error:", err);
  process.exit(1);
});
