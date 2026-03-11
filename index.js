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

let currentQR = null;
let botStatus = "disconnected";
let botPhoneNumber = null;
let sockRef = null;
let alwaysOnlineInterval = null;

app.use(express.json());
app.use(dashboardRouter);

app.get("/", async (req, res) => {
  let qrImageTag = "";
  if (currentQR) {
    try {
      const qrDataUrl = await QRCode.toDataURL(currentQR);
      qrImageTag = `<img src="${qrDataUrl}" alt="QR Code" style="width:280px;height:280px;" />`;
    } catch {
      qrImageTag = "<p>Check the terminal for the QR code.</p>";
    }
  }
  const statusColor = botStatus === "connected" ? "#25D366" : botStatus === "connecting" ? "#FFA500" : "#e74c3c";
  res.send(getHomePage(statusColor, qrImageTag));
});

app.get("/pair", (req, res) => {
  res.send(getPairPage());
});

app.post("/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ success: false, error: "Phone number required" });
  if (!sockRef) return res.json({ success: false, error: "Bot not connected to WhatsApp yet" });
  try {
    const cleaned = phone.replace(/[^0-9]/g, "");
    const code = await sockRef.requestPairingCode(cleaned);
    res.json({ success: true, code, message: "Enter this code in WhatsApp > Linked Devices > Link with phone number" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>IgniteBot</title>
  <meta http-equiv="refresh" content="5"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111b21;color:#e9edef;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
    .card{background:#202c33;border-radius:16px;padding:36px 44px;max-width:520px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
    .logo{font-size:2.4rem;font-weight:700;color:#25D366;margin-bottom:4px}
    .subtitle{font-size:0.9rem;color:#8696a0;margin-bottom:20px}
    .status-badge{display:inline-flex;align-items:center;gap:8px;background:#111b21;border-radius:20px;padding:6px 16px;font-size:0.85rem;font-weight:500;margin-bottom:20px}
    .dot{width:10px;height:10px;border-radius:50%;background:${statusColor}}
    .qr-box{background:#fff;border-radius:12px;padding:16px;display:inline-block;margin-bottom:16px}
    .instruction{font-size:0.85rem;color:#8696a0;line-height:1.6}
    .instruction ol{text-align:left;padding-left:18px;margin-top:8px}
    .instruction li{margin-bottom:4px}
    .connected-msg{font-size:1.05rem;color:#25D366;font-weight:600;margin-bottom:8px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:16px 0;text-align:left}
    .info-item{background:#111b21;border-radius:8px;padding:8px 12px;font-size:0.82rem}
    .info-item label{color:#8696a0;display:block;font-size:0.75rem;margin-bottom:2px}
    .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px}
    .btn{padding:10px 20px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.88rem;display:inline-block}
    .btn-green{background:#25D366;color:#111}
    .btn-blue{background:#1f6feb;color:#fff}
    .btn-dark{background:#30363d;color:#e9edef}
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
  ${botStatus === "connected"
    ? `<div class="connected-msg">✓ Bot is online!</div>
       <div style="font-size:0.85rem;color:#8696a0">+${botPhoneNumber || "Unknown"}</div>
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
       </div>`
    : currentQR
      ? `<div class="qr-box">${qrImageTag}</div>
         <div class="instruction">
           Scan with WhatsApp to connect the bot.
           <ol>
             <li>Open WhatsApp on your phone</li>
             <li>Tap Menu (⋮) → Linked Devices</li>
             <li>Tap "Link a Device"</li>
             <li>Point camera at the QR code</li>
           </ol>
         </div>
         <div class="btns" style="margin-top:14px">
           <a href="/pair" class="btn btn-blue">🔗 Link with Phone Number Instead</a>
         </div>`
      : `<div class="instruction">⏳ Starting up… QR will appear shortly.</div>`
  }
</div>
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
    .card{background:#202c33;border-radius:16px;padding:40px;max-width:420px;width:100%;text-align:center}
    h1{color:#25D366;font-size:1.6rem;margin-bottom:8px}
    p{color:#8696a0;font-size:0.9rem;margin-bottom:24px;line-height:1.5}
    input{width:100%;background:#111b21;border:1px solid #30363d;border-radius:8px;padding:12px 16px;color:#e9edef;font-size:1rem;margin-bottom:16px;outline:none}
    input:focus{border-color:#25D366}
    button{width:100%;background:#25D366;color:#111;border:none;border-radius:8px;padding:12px;font-size:1rem;font-weight:600;cursor:pointer}
    .result{margin-top:20px;background:#111b21;border-radius:10px;padding:16px;display:none}
    .code{font-size:2rem;font-weight:700;letter-spacing:6px;color:#25D366;margin:8px 0}
    .error{color:#f85149}
    .back{display:inline-block;margin-top:16px;color:#8696a0;font-size:0.85rem;text-decoration:none}
    .steps{text-align:left;font-size:0.82rem;color:#8696a0;line-height:1.8;margin-bottom:20px}
    .steps li{margin-bottom:4px}
  </style>
</head>
<body>
<div class="card">
  <h1>🔗 Pair Device</h1>
  <p>Link your WhatsApp account without scanning a QR code</p>
  <ol class="steps">
    <li>Open WhatsApp on your phone</li>
    <li>Go to Menu (⋮) → Linked Devices</li>
    <li>Tap "Link a Device"</li>
    <li>Tap "Link with phone number"</li>
    <li>Enter your number below and submit</li>
    <li>Enter the code shown in WhatsApp</li>
  </ol>
  <input type="tel" id="phone" placeholder="Phone number (e.g. 12345678901)" />
  <button onclick="getPairCode()">Get Pairing Code</button>
  <div class="result" id="result">
    <div id="resultMsg"></div>
    <div class="code" id="pairCode"></div>
  </div>
  <a href="/" class="back">← Back to Dashboard</a>
</div>
<script>
async function getPairCode() {
  const phone = document.getElementById('phone').value.trim();
  if (!phone) return alert('Please enter your phone number');
  document.getElementById('result').style.display = 'block';
  document.getElementById('resultMsg').textContent = 'Getting code...';
  document.getElementById('pairCode').textContent = '';
  try {
    const res = await fetch('/pair', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({phone})
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('resultMsg').innerHTML = '<strong style="color:#25D366">✅ Enter this code in WhatsApp:</strong>';
      document.getElementById('pairCode').textContent = data.code;
    } else {
      document.getElementById('resultMsg').innerHTML = '<span class="error">❌ ' + data.error + '</span>';
    }
  } catch(e) {
    document.getElementById('resultMsg').innerHTML = '<span class="error">❌ Network error</span>';
  }
}
</script>
</body>
</html>`;
}

const AUTH_FOLDER = "./auth_info_baileys";

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
      console.log("\n📱 Scan the QR code in the web preview:\n");
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
      console.log("✅ WhatsApp bot connected!");
      console.log(`📞 Connected as: +${botPhoneNumber}`);
      console.log("⚡ All 30+ features active. Type !menu");

      if (alwaysOnlineInterval) clearInterval(alwaysOnlineInterval);
      alwaysOnlineInterval = setInterval(async () => {
        if (settings.get("alwaysOnline") && sock) {
          await sock.sendPresenceUpdate("available").catch(() => {});
        }
      }, 30000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const senderJid = msg.key.participant || from;

      if (security.isBanned(senderJid)) continue;

      if (from === "status@broadcast") {
        if (settings.get("antiDeleteStatus")) {
          security.cacheStatus(msg.key.id, msg);
        }
        if (settings.get("autoViewStatus")) {
          await sock.readMessages([msg.key]).catch(() => {});
        }
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
      for (const participant of participants) {
        await groups.sendWelcome(sock, id, participant).catch(() => {});
      }
    } else if (action === "remove") {
      for (const participant of participants) {
        await groups.sendGoodbye(sock, id, participant).catch(() => {});
      }
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
          const statusOwner = key.participant || "Someone";
          const ownerPhone = statusOwner.split("@")[0];

          try {
            if (msgType === "conversation" || msgType === "extendedTextMessage") {
              const text = originalMsg.message?.conversation || originalMsg.message?.extendedTextMessage?.text;
              if (text) {
                await sock.sendMessage(adminJid, {
                  text: `🗑 *Deleted Status from @${ownerPhone}:*\n\n${text}`,
                });
              }
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
          } catch (err) {
            console.error("Anti-delete status forward error:", err.message);
          }
        }
        continue;
      }

      const isGroup = key.remoteJid.endsWith("@g.us");
      if (!isGroup) continue;
      const grpSettings = security.getGroupSettings(key.remoteJid);
      if (!grpSettings.antiDelete) continue;
      const cached = security.getCachedMessage(key.id);
      if (!cached) continue;

      const original = cached.msg;
      const body =
        original.message?.conversation ||
        original.message?.extendedTextMessage?.text ||
        "";
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

  sock.ev.on("presences.update", async ({ id, presences }) => {
    // Auto-detect typed messages: when someone is typing, log it
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
