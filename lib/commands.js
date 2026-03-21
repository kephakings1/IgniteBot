const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile, execFileSync } = require("child_process");

// Detect ffmpeg once at startup — avoids crashing when not installed (e.g. bare Heroku)
const FFMPEG_PATH = (() => {
  try {
    const p = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    return p || "ffmpeg";
  } catch {
    return null;
  }
})();
if (!FFMPEG_PATH) console.log("⚠️  ffmpeg not found — menu video generation disabled (image+audio will be sent separately)");
const axios = require("axios");

const ai = require("./ai");
const sticker = require("./sticker");
const downloader = require("./downloader");
const translator = require("./translator");
const analytics = require("./analytics");
const store = require("./store");
const booking = require("./booking");
const broadcast = require("./broadcast");
const security = require("./security");
const groups = require("./groups");
const converter = require("./converter");
const lang = require("./language");
const platform = require("./platform");
const keywords = require("./keywords");
const admin = require("./admin");
const settings = require("./settings");
const db = require("./db");
const textart = require("./textart");
const sports = require("./sports");
const perez = require("./perez");
const { prefix: defaultPrefix, botName } = require("../config");

// ── Robust body extractor — handles ALL Baileys v7 message wrappings ────────
// Disappearing-message chats wrap the real message inside ephemeralMessage.
// Template / button / list replies must also be unwrapped.
function extractBody(msg) {
  const m = msg?.message;
  if (!m) return "";
  // Unwrap ephemeral (disappearing messages) — this is the #1 silent drop cause
  const inner = m.ephemeralMessage?.message || m;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    inner.buttonsResponseMessage?.selectedDisplayText ||
    inner.listResponseMessage?.title ||
    inner.templateButtonReplyMessage?.selectedDisplayText ||
    // Nested view-once text (rare but possible)
    inner.viewOnceMessage?.message?.conversation ||
    inner.viewOnceMessage?.message?.extendedTextMessage?.text ||
    ""
  );
}

function getPrefix() {
  return settings.get("prefix") || defaultPrefix;
}

function isPrefixless() {
  return !!settings.get("prefixless");
}

// ── Phone number normalisation ───────────────────────────────────────────────
// Accepts any user input (international, local with 0, with +, with spaces).
// Returns a clean digit string ready to append @s.whatsapp.net.
// Examples (countryCode="254"):
//   "+254706535581"  →  "254706535581"
//   "0706535581"     →  "254706535581"   (leading 0 → prepend CC)
//   "00254706535581" →  "254706535581"   (00-prefix → strip 00)
//   "254706535581"   →  "254706535581"   (already international)
function normalizePhone(raw) {
  const cc = (settings.get("countryCode") || "254").replace(/\D/g, "");
  let digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";
  // Strip international dialling prefix "00"
  if (digits.startsWith("00") && digits.length > cc.length + 4) {
    digits = digits.slice(2);
  }
  // Strip leading "0" and prepend country code (local format)
  if (digits.startsWith("0") && digits.length <= 11) {
    digits = cc + digits.slice(1);
  }
  return digits;
}

// ── Date / time helpers that respect the configured timezone ─────────────────
function getFormattedDate() {
  const tz = settings.get("timezone") || "Africa/Nairobi";
  try {
    return new Date().toLocaleDateString("en-GB", {
      timeZone: tz, day: "2-digit", month: "long", year: "numeric",
    });
  } catch {
    return new Date().toLocaleDateString("en-GB", {
      day: "2-digit", month: "long", year: "numeric",
    });
  }
}

function getFormattedTime() {
  const tz = settings.get("timezone") || "Africa/Nairobi";
  try {
    return new Date().toLocaleTimeString("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
    });
  } catch {
    return new Date().toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
    });
  }
}

function getFormattedDateTime() {
  return `${getFormattedDate()} • ${getFormattedTime()}`;
}

// ── Connect Four game engine ─────────────────────────────────────────────────
class ConnectFour {
  constructor(playerRed, playerYellow) {
    this.playerRed = playerRed;
    this.playerYellow = playerYellow;
    this.board = Array.from({ length: 6 }, () => Array(7).fill(0));
    this.currentTurn = playerRed;
    this.moveCount = 0;
  }
  drop(col) {
    col = parseInt(col, 10) - 1;
    if (isNaN(col) || col < 0 || col > 6) return { error: "Invalid column (1-7)" };
    for (let r = 5; r >= 0; r--) {
      if (this.board[r][col] === 0) {
        this.board[r][col] = this.currentTurn === this.playerRed ? 1 : 2;
        this.moveCount++;
        const winner = this.checkWin(r, col);
        if (winner) return { winner: this.currentTurn };
        if (this.moveCount >= 42) return { draw: true };
        this.currentTurn = this.currentTurn === this.playerRed ? this.playerYellow : this.playerRed;
        return { ok: true };
      }
    }
    return { error: "Column is full! Choose another column." };
  }
  checkWin(row, col) {
    const piece = this.board[row][col];
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (let d = 1; d <= 3; d++) {
        const r = row + dr*d, c = col + dc*d;
        if (r<0||r>5||c<0||c>6||this.board[r][c]!==piece) break; count++;
      }
      for (let d = 1; d <= 3; d++) {
        const r = row - dr*d, c = col - dc*d;
        if (r<0||r>5||c<0||c>6||this.board[r][c]!==piece) break; count++;
      }
      if (count >= 4) return true;
    }
    return false;
  }
  render() {
    const symbols = { 0: "⬛", 1: "🔴", 2: "🟡" };
    const colNums = "1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣";
    return this.board.map(row => row.map(c => symbols[c]).join("")).join("\n") + "\n" + colNums;
  }
}
const c4Games = {};

// ── Chatbot per-chat state ────────────────────────────────────────────────────
const CHATBOT_FILE = path.join(process.cwd(), "data", "chatbot_chats.json");
function loadChatbotChats() {
  try {
    fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
    if (fs.existsSync(CHATBOT_FILE)) return JSON.parse(fs.readFileSync(CHATBOT_FILE, "utf8"));
  } catch {}
  return {};
}
function saveChatbotChats(obj) {
  try {
    fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
    fs.writeFileSync(CHATBOT_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}
function isChatbotEnabled(chatId) {
  return !!loadChatbotChats()[chatId];
}
function setChatbotEnabled(chatId, val) {
  const obj = loadChatbotChats();
  if (val) obj[chatId] = true; else delete obj[chatId];
  saveChatbotChats(obj);
}

// ── Fancy text Unicode maps ───────────────────────────────────────────────────
const FANCY_STYLES = {
  "𝗕𝗼𝗹𝗱":         { a: 0x1D400, A: 0x1D41A, digits: 0x1D7CE },
  "𝐈𝐭𝐚𝐥𝐢𝐜":       { a: 0x1D608, A: 0x1D5EE },
  "𝑩𝒐𝒍𝒅 𝑰𝒕𝒂𝒍𝒊𝒄":  { a: 0x1D468, A: 0x1D482 },
  "𝒮𝒸𝓇𝒾𝓅𝓉":       { a: 0x1D4EA, A: 0x1D4D0 },
  "𝓑𝓸𝓵𝓭 𝓢𝓬𝓻𝓲𝓹𝓽": { a: 0x1D4F6, A: 0x1D4DC },
  "𝔉𝔯𝔞𝔨𝔱𝔲𝔯":      { a: 0x1D526, A: 0x1D50C },
  "𝕯𝖔𝖚𝖇𝖑𝖊-𝖘𝖙𝖗𝖚𝖈𝖐": { a: 0x1D552, A: 0x1D538 },
  "𝙼𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎":   { a: 0x1D5FA, A: 0x1D670 },
};
function applyFancyStyle(text, style) {
  const s = FANCY_STYLES[style];
  if (!s) return text;
  return text.split("").map(c => {
    const code = c.codePointAt(0);
    if (code >= 97 && code <= 122 && s.a) return String.fromCodePoint(s.a + (code - 97));
    if (code >= 65 && code <= 90 && s.A) return String.fromCodePoint(s.A + (code - 65));
    if (code >= 48 && code <= 57 && s.digits) return String.fromCodePoint(s.digits + (code - 48));
    return c;
  }).join("");
}
const fancyReplyHandlers = new Map();

// ── Unified feature map ──────────────────────────────────────────────────────
// cat: "global" = super-admin only, applies bot-wide
// cat: "group"  = group-admin only, applies to the current group
const FEATURE_MAP = {
  autoview:         { label: "Auto View Status",     emoji: "👁",  cat: "global", get: ()    => settings.get("autoViewStatus"),                           set: (v)    => settings.set("autoViewStatus", v) },
  autolike:         { label: "Auto Like Status",     emoji: "❤️",  cat: "global", get: ()    => settings.get("autoLikeStatus"),                           set: (v)    => settings.set("autoLikeStatus", v) },
  alwaysonline:     { label: "Always Online",        emoji: "🟢",  cat: "global", get: ()    => settings.get("alwaysOnline"),                             set: (v)    => settings.set("alwaysOnline", v) },
  anticall:         { label: "Anti Call",            emoji: "📵",  cat: "global", get: ()    => settings.get("antiCall"),                                 set: (v)    => settings.set("antiCall", v) },
  antideletestatus: { label: "Anti Delete Status",   emoji: "🗑️",  cat: "global", get: ()    => settings.get("antiDeleteStatus"),                         set: (v)    => settings.set("antiDeleteStatus", v) },
  autoread:         { label: "Auto Read Messages",   emoji: "📖",  cat: "global", get: ()    => settings.get("autoReadMessages"),                         set: (v)    => settings.set("autoReadMessages", v) },
  prefixless:       { label: "Prefixless Commands",  emoji: "📌",  cat: "global", get: ()    => settings.get("prefixless"),                               set: (v)    => settings.set("prefixless", v) },
  antilink:         { label: "Anti Link",            emoji: "🔗",  cat: "group",  get: (grp) => security.getGroupSettings(grp).antiLink,                  set: (v, grp) => security.setGroupSetting(grp, "antiLink", v) },
  antispam:         { label: "Anti Spam",            emoji: "🛡️",  cat: "group",  get: (grp) => security.getGroupSettings(grp).antiSpam,                  set: (v, grp) => security.setGroupSetting(grp, "antiSpam", v) },
  antidelete:       { label: "Anti Delete Messages", emoji: "🚫",  cat: "group",  get: (grp) => security.getGroupSettings(grp).antiDelete,                set: (v, grp) => security.setGroupSetting(grp, "antiDelete", v) },
  antimentiongroup: { label: "Anti Mass Mention",    emoji: "🔕",  cat: "group",  get: (grp) => security.getGroupSettings(grp).antiMentionGroup,           set: (v, grp) => security.setGroupSetting(grp, "antiMentionGroup", v) },
  antitag:          { label: "Anti Tag All",         emoji: "🏷️",  cat: "group",  get: (grp) => security.getGroupSettings(grp).antiTag,                   set: (v, grp) => security.setGroupSetting(grp, "antiTag", v) },
  voreveal:         { label: "Auto Reveal View-Once", emoji: "👁",  cat: "global", get: ()    => settings.get("voReveal"),                                   set: (v)    => settings.set("voReveal", v) },
  autotyping:       { label: "Auto Typing Indicator", emoji: "⌨️", cat: "global", get: ()    => settings.get("autoTyping"),                                  set: (v)    => settings.set("autoTyping", v) },
  autorecording:    { label: "Auto Recording Status", emoji: "🎤", cat: "global", get: ()    => settings.get("autoRecording"),                               set: (v)    => settings.set("autoRecording", v) },
  typingdelay:      { label: "Typing Delay (Human)",  emoji: "⏱", cat: "global", get: ()    => settings.get("typingDelay"),                                  set: (v)    => settings.set("typingDelay", v) },
  antisticker:      { label: "Anti Sticker",          emoji: "🚫", cat: "group",  get: (grp) => security.getGroupSettings(grp).antiSticker,                  set: (v, grp) => security.setGroupSetting(grp, "antiSticker", v) },
  antimention:      { label: "Anti Mention",          emoji: "🔕", cat: "group",  get: (grp) => security.getGroupSettings(grp).antiMentionGroup,             set: (v, grp) => security.setGroupSetting(grp, "antiMentionGroup", v) },
};

function buildFeatureList(groupJid) {
  const on  = (v) => v ? "✅ ON " : "❌ OFF";
  const p   = getPrefix();
  let out = `╔═══════════════════════╗\n║   ⚙️  *Feature Toggles*  ║\n╚═══════════════════════╝\n\n`;
  out += `_Type \`${p}feature [name] on/off\` to toggle_\n\n`;

  out += `🌐 *Global Features* _(super-admin)_\n`;
  for (const [name, f] of Object.entries(FEATURE_MAP).filter(([,f]) => f.cat === "global")) {
    out += `${f.emoji} \`${name.padEnd(18)}\` ${on(f.get())}  — ${f.label}\n`;
  }

  if (groupJid) {
    out += `\n👥 *Group Features* _(group-admin)_\n`;
    for (const [name, f] of Object.entries(FEATURE_MAP).filter(([,f]) => f.cat === "group")) {
      out += `${f.emoji} \`${name.padEnd(18)}\` ${on(f.get(groupJid))}  — ${f.label}\n`;
    }
  } else {
    out += `\n👥 *Group Features* — run in a group to see & toggle\n`;
  }

  return out;
}

async function reply(sock, msg, text) {
  return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function getMediaBuffer(sock, msg) {
  try {
    const { downloadMediaMessage } = require("@whiskeysockets/baileys");
    return Buffer.from(await downloadMediaMessage(msg, "buffer", {}));
  } catch {
    return null;
  }
}

// ── View-once helpers ────────────────────────────────────────────────────────
// Extracts the inner view-once media object from any WhatsApp message variant.
// Handles: viewOnceMessage, viewOnceMessageV2, viewOnceMessageV2Extension,
// ephemeral wrappers, and flat imageMessage/videoMessage with viewOnce:true flag.
function extractViewOnce(msgObj) {
  if (!msgObj) return null;
  // Unwrap ephemeral layer first
  const m = msgObj.ephemeralMessage?.message || msgObj;
  // Container-style view-once
  if (m.viewOnceMessage?.message)          return m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message)        return m.viewOnceMessageV2.message;
  if (m.viewOnceMessageV2Extension?.message) return m.viewOnceMessageV2Extension.message;
  // Flat style: regular message type with viewOnce:true flag
  if (m.imageMessage?.viewOnce)  return { imageMessage: m.imageMessage };
  if (m.videoMessage?.viewOnce)  return { videoMessage: m.videoMessage };
  if (m.audioMessage?.viewOnce)  return { audioMessage: m.audioMessage };
  return null;
}

async function decryptViewOnce(sock, voInner, quotedCtx, fallbackJid) {
  const { downloadMediaMessage } = require("@whiskeysockets/baileys");
  const mediaType = Object.keys(voInner)[0]; // imageMessage | videoMessage | audioMessage
  if (!["imageMessage", "videoMessage", "audioMessage"].includes(mediaType)) return null;

  const fakeMsg = {
    key: {
      remoteJid:   quotedCtx?.remoteJid || fallbackJid,
      id:          quotedCtx?.stanzaId  || ("vo-" + Date.now()),
      fromMe:      false,
      participant: quotedCtx?.participant || undefined,
    },
    message: voInner,
  };

  try {
    const buf = Buffer.from(await downloadMediaMessage(fakeMsg, "buffer", {}));
    return { buf, mediaType, media: voInner[mediaType] };
  } catch {
    return null;
  }
}

async function sendRevealedMedia(sock, jid, { buf, mediaType, media }, quotedMsg) {
  const caption = `🔓 *View Once Revealed* by NEXUS-MD\n${media.caption ? `_${media.caption}_` : ""}`.trim();
  const opts = { quoted: quotedMsg };
  if (mediaType === "imageMessage") {
    await sock.sendMessage(jid, { image: buf, caption }, opts);
  } else if (mediaType === "videoMessage") {
    await sock.sendMessage(jid, { video: buf, caption, mimetype: media.mimetype || "video/mp4" }, opts);
  } else if (mediaType === "audioMessage") {
    await sock.sendMessage(jid, { audio: buf, mimetype: media.mimetype || "audio/ogg; codecs=opus", ptt: media.ptt || false }, opts);
  }
}

function getMentioned(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

// ── Text transformer helpers ─────────────────────────────────────────────────
function mockText(s) {
  return s.split("").map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join("");
}
function reverseText(s) { return s.split("").reverse().join(""); }
function aestheticText(s) {
  const map = "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ";
  return s.toLowerCase().split("").map(c => {
    const i = c.charCodeAt(0) - 97;
    return i >= 0 && i < 26 ? map[i] : c === " " ? "　" : c;
  }).join("");
}
function boldText(s) {
  return s.split("").map(c => {
    const l = c.charCodeAt(0);
    if (l >= 65 && l <= 90)  return String.fromCodePoint(0x1D400 + l - 65);
    if (l >= 97 && l <= 122) return String.fromCodePoint(0x1D41A + l - 97);
    if (l >= 48 && l <= 57)  return String.fromCodePoint(0x1D7CE + l - 48);
    return c;
  }).join("");
}
function italicText(s) {
  return s.split("").map(c => {
    const l = c.charCodeAt(0);
    if (l >= 65 && l <= 90)  return String.fromCodePoint(0x1D608 + l - 65);
    if (l >= 97 && l <= 122) return String.fromCodePoint(0x1D622 + l - 97);
    return c;
  }).join("");
}
function emojifyText(s) {
  const em = ["🇦","🇧","🇨","🇩","🇪","🇫","🇬","🇭","🇮","🇯","🇰","🇱","🇲","🇳","🇴","🇵","🇶","🇷","🇸","🇹","🇺","🇻","🇼","🇽","🇾","🇿"];
  return s.toLowerCase().split("").map(c => {
    const i = c.charCodeAt(0) - 97;
    return i >= 0 && i < 26 ? em[i] + " " : c === " " ? "   " : c + " ";
  }).join("").trim();
}
function safeCalc(expr) {
  if (!/^[\d\s+\-*/%.()^,]+$/.test(expr.replace(/\s/g, ""))) throw new Error("Invalid characters in expression");
  const safe = expr.replace(/\^/g, "**");
  // eslint-disable-next-line no-new-func
  const result = Function('"use strict"; return (' + safe + ')')();
  if (!isFinite(result)) throw new Error("Result is not finite");
  return result;
}

// Fetch group participants safely
async function getParticipants(sock, jid) {
  try { return (await sock.groupMetadata(jid)).participants; } catch { return []; }
}

// Get profile picture URL safely
async function getPpUrl(sock, jid) {
  try { return await sock.profilePictureUrl(jid, "image"); } catch { return null; }
}

function getQuotedMsg(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
}

function getQuotedJid(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.participant;
}

// Build a single menu section — returns a formatted string block
function menuSection(icon, title, items) {
  return `${icon} *${title}*\n${items.map(([cmd, desc]) => `› \`${cmd}\` — ${desc}`).join("\n")}`;
}

const LINE = "━━━━━━━━━━━━━━━━━━━━━━";

function ramBar(pct, len = 10) {
  const filled = Math.round((pct / 100) * len);
  return "█".repeat(filled) + "░".repeat(len - filled);
}

function detectPlatform() {
  const e = process.env;
  if (e.DYNO)                                          return "Heroku";
  if (e.REPL_ID || e.REPL_SLUG || e.REPLIT_DB_URL)    return "Replit";
  if (e.RAILWAY_ENVIRONMENT || e.RAILWAY_PROJECT_ID)   return "Railway";
  if (e.RENDER || e.RENDER_SERVICE_ID)                 return "Render";
  if (e.KOYEB_SERVICE_NAME)                            return "Koyeb";
  if (e.CYCLIC_URL)                                    return "Cyclic";
  if (e.FLY_APP_NAME)                                  return "Fly.io";
  if (e.VERCEL)                                        return "Vercel";
  if (e.PROJECT_DOMAIN)                                return "Glitch";
  if (e.GITPOD_WORKSPACE_ID)                           return "Gitpod";
  return "VPS / Local";
}

// Combined menu video stored in PostgreSQL via settings — survives Heroku dyno restarts
function getCombinedMenuVideo() {
  return settings.getMenuCombined();
}

function clearCombinedMenuVideo() {
  settings.clearMenuCombined();
}

async function buildCombinedMenuVideo(imageBuf, audioBuf) {
  if (!FFMPEG_PATH) throw new Error("ffmpeg not available on this host");
  const uid = Date.now();
  const tmpDir = os.tmpdir();
  const imgTmp = path.join(tmpDir, `mi_${uid}.jpg`);
  const audTmp = path.join(tmpDir, `ma_${uid}.mp3`);
  const vidTmp = path.join(tmpDir, `mv_${uid}.mp4`);
  try {
    fs.writeFileSync(imgTmp, imageBuf);
    fs.writeFileSync(audTmp, audioBuf);
    await new Promise((resolve, reject) => {
      execFile(FFMPEG_PATH, [
        "-loop", "1", "-i", imgTmp,
        "-i", audTmp,
        "-c:v", "libx264", "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-y", vidTmp,
      ], { timeout: 120000 }, (err) => err ? reject(err) : resolve());
    });
    const buf = fs.readFileSync(vidTmp);
    // Persist in PostgreSQL so Heroku dyno restarts don't need to rebuild
    settings.setMenuCombined(buf);
    return buf;
  } finally {
    for (const f of [imgTmp, audTmp, vidTmp]) try { fs.unlinkSync(f); } catch {}
  }
}

function section(title, cmds) {
  const p = getPrefix();
  return (
    `╭─〔 ${title} 〕\n` +
    cmds.map((c) => `│ ${p}${c}`).join("\n") +
    `\n╰───────────────`
  );
}

function buildMenu(p, senderName) {
  if (!p) p = getPrefix();
  const uptime    = process.uptime();
  const hrs       = Math.floor(uptime / 3600);
  const mins      = Math.floor((uptime % 3600) / 60);
  const secs      = Math.floor(uptime % 60);
  const mem       = process.memoryUsage();
  const usedMB    = (mem.heapUsed  / 1024 / 1024).toFixed(1);
  const totalMB   = (mem.heapTotal / 1024 / 1024).toFixed(1);
  const ramPct    = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const bar       = ramBar(ramPct);
  const mode      = settings.get("mode") || "public";
  const modeMap   = { public: "Public", private: "Private", group: "Group" };
  const name      = senderName || "User";
  const ownerName = settings.get("ownerName") || "Nexus Tech";

  return (
    `╭━━━〔 🤖 𝑵𝑬𝑿𝑼𝑺-𝑴𝑫 𝑪𝑶𝑹𝑬 〕━━━╮\n` +
    `┃ 👤 User:  ~•~ ༺〄 ${name}★༻\n` +
    `┃ 👑 Owner: ${ownerName}\n` +
    `┃ 🌍 Mode: ${modeMap[mode] || "Public"}\n` +
    `┃ ⚡ Prefix: [${p}]\n` +
    `┃ 🧠 Version: 2.0\n` +
    `┃ ☁ Platform: ${detectPlatform()}\n` +
    `┃ 📡 Status: Online\n` +
    `┃ ⏱ Uptime: ${hrs}h ${mins}m ${secs}s\n` +
    `┃ 💾 RAM: ${bar} ${ramPct}%\n` +
    `┃ 🧬 Memory: ${usedMB}MB / ${totalMB}MB\n` +
    `╰━━━━━━━━━━━━━━━━━━━━╯`
  );
}

function buildMenuSections(_p) {
  return [
    section("🧭 SYSTEM CORE", [
      "menu", "help", "menuv",
      "ping", "alive", "stats", "uptime", "time", "date",
    ]),
    section("🧠 AI ENGINE", [
      "ai", "ai2", "ai3", "chat", "ask",
      "imagine", "image", "dalle", "createimage",
      "tts", "say", "summarize", "summary", "clearchat",
      "gpt", "gpt2", "gpt3", "darkgpt",
      "bard", "googleai", "blackbox", "bb",
      "copilot", "msai", "ilama", "llama",
      "metai", "metalai", "mistral",
      "perplexity", "pplx",
      "speechwriter", "speech",
      "gpt4", "aigpt4", "deepseek", "ds",
      "chatbot",
    ]),
    section("🔎 SEARCH HUB", [
      "weather",
      "wiki", "wikipedia",
      "define", "dict",
      "tr", "translate", "langs",
    ]),
    section("⚽ SPORTS CENTER", [
      "epl", "eplscores", "premierleague", "pl",
      "laliga", "bundesliga", "seriea", "ligue1",
      "fixtures", "matches",
    ]),
    section("🎮 FUN ZONE", [
      "8ball", "fact", "flip",
      "joke", "quote", "inspire", "roll",
      "pickupline", "catfact", "advise", "hack",
      "flirt", "dare", "compliment", "character",
      "gif", "emojimix", "encrypt", "decrypt",
      "animu", "fancy", "connect4", "c4", "drop", "forfeit",
    ]),
    section("✍️ TEXT LAB", [
      "aesthetic", "ae", "bold", "italic",
      "mock", "reverse", "emojify", "emoji",
      "upper", "lower", "repeat",
      "calc", "calculate",
    ]),
    section("🎵 MEDIA STATION", [
      "play", "song", "p",
      "yt", "ytdl", "audio",
      "music", "dl", "download",
      "fbdl", "facebook",
      "pindl", "pinterest",
      "sticker", "s", "convert",
      "v", "vo", "viewonce", "reveal",
      "tiktok", "tikdl", "twitter", "twtdl",
      "instagram", "igdl",
      "ytmp3", "yta", "ytmp4", "ytv",
      "song2", "play2", "video",
      "lyrics", "yts",
    ]),
    section("🧰 UTILITIES", [
      "pp", "pfp", "getpp", "dp",
      "qr", "short", "shorten",
      "whois", "profile",
      "carbon", "screenshot", "ss",
      "anime", "animu", "movie", "github", "gitclone",
      "apk", "app", "news", "inspect",
      "tweet", "pin", "quotely",
      "remini", "removebg", "attp", "smeme", "take",
      "request", "reportbug", "runtime",
      "upload", "hacker2", "trt", "translate",
      "mail", "whatsong", "shazam",
      "fetch", "fetchurl",
      "chaneljid", "channeljid", "chjid",
      "clearmessages",
    ]),
    section("🎨 TEXT ART", [
      "textart", "metallic", "ice", "snow",
      "neon", "gold", "naruto", "dragonball",
      "graffiti", "silver", "devil", "matrix",
      "hacker", "sand", "water", "thunder",
    ]),
    section("👥 GROUP CONTROL", [
      "add", "kick", "kickall", "kill", "kill2",
      "promote", "promoteall",
      "demote", "demoteall",
      "ban", "unban",
      "mute", "unmute", "open", "close",
      "warn", "resetwarn", "warnings",
      "delete", "leave", "creategroup",
      "approve", "approve-all", "reject", "reject-all",
      "gcprofile", "icon", "subject", "desc",
      "hidetag", "tag", "foreigners",
      "antileave", "vcf", "group-vcf",
      "disp-1", "disp-7", "disp-90", "disp-off",
    ]),
    section("📊 GROUP INFO", [
      "admins", "members", "count", "groupinfo",
      "link", "invitelink", "revoke", "resetlink",
      "glink", "grouplink",
      "setname", "rename",
      "setdesc", "desc",
      "seticon", "setgrouppp",
      "everyone", "tagall",
      "hidetag", "htag", "stag", "poll",
    ]),
    section("👋 WELCOME SYSTEM", [
      "setwelcome", "setgoodbye",
      "welcome", "goodbye",
      "gctime", "antileave",
    ]),
    section("🚫 AUTO MODERATION", [
      "antilink", "antispam", "antiflood",
      "antilongtext", "settextlimit",
      "antimention", "antimentiongroup",
      "antitag", "antisticker",
      "antidelete", "anticall",
      "alwaysonline", "voreveal",
      "antibadword", "antibot", "antiimage",
      "antidemote", "antipromote", "antiedit",
    ]),
    section("⚙️ BOT SETTINGS", [
      "botsettings", "features", "featurelist",
      "feature", "toggle",
      "setmode", "mode", "lang",
      "setprefix", "prefixless",
      "setowner", "setownername", "setbotname",
      "autotyping", "autorecord", "autoboth", "autofont",
      "autostatus", "autoreadreceipts", "readreceipts",
      "disp", "deepseek", "ds",
      "cleartmp", "clearsession",
      "chatbot",
    ]),
    section("🛒 STORE SYSTEM", [
      "shop", "catalog", "order", "myorders",
      "services", "book", "mybookings", "cancel",
    ]),
    section("👑 SUPER ADMIN", [
      "sudo", "removesudo", "unsudo", "sudolist",
      "broadcast", "broadcastgroups", "cast", "pairing",
      "block", "unblock", "join", "restart",
      "save", "botpp", "fullpp", "eval",
      "setmenuimage", "clearmenuimage",
      "setmenuvideo", "clearmenuvideo",
      "setmenusong", "clearmenusong",
      "menutype",
    ]),
    section("💻 CODE COMPILER", [
      "compile-js", "compile-py",
      "compile-c", "compile-c++",
      "sc", "repo",
    ]),
    section("🎭 STICKER TOOLS", [
      "sticker", "s", "take",
      "attp", "smeme", "quotely",
      "tovideo", "mp4", "toimage",
      "vv", "retrieve",
    ]),
  ];
}

async function handle(sock, msg) {
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  // For fromMe DMs, the sender is the bot itself (sock.user?.id), not the remoteJid (which is the recipient)
  const senderJid = isGroup
    ? (msg.key.participant || msg.key.remoteJid)
    : (msg.key.fromMe ? (sock.user?.id || msg.key.remoteJid) : msg.key.remoteJid);
  const senderPhone = senderJid.split("@")[0].split(":")[0];

  // If the message came from the bot's own phone it is always the owner — full permissions
  const isOwner = !!msg.key.fromMe;
  const isSuperAdminUser = () => isOwner || admin.isSuperAdmin(senderJid);

  const body = extractBody(msg);

  analytics.trackMessage(senderJid).catch(() => {});

  if (settings.get("autoReadMessages")) {
    sock.readMessages([msg.key]).catch(() => {});
  }

  const groupParticipants = isGroup
    ? await admin.getGroupParticipants(sock, from).catch(() => [])
    : [];
  // Owner always counts as admin (group or DM)
  const isAdminUser = isOwner || admin.isAdmin(senderJid, groupParticipants);

  const botMode = settings.get("mode");
  if (botMode === "private" && !isSuperAdminUser()) return;
  if (botMode === "group" && !isGroup) return;

  if (isGroup) {
    const grpSettings = security.getGroupSettings(from);

    if (grpSettings.antiLink && !isAdminUser && body && security.hasLink(body)) {
      try {
        await sock.sendMessage(from, { delete: msg.key });
        await sock.sendMessage(from,
          { text: `⚠️ @${senderPhone} links are not allowed here!`, mentions: [senderJid] },
          { quoted: msg }
        );
      } catch {}
      return;
    }

    if (grpSettings.antiSpam && !isAdminUser && security.isSpam(senderJid)) {
      try {
        await sock.sendMessage(from, {
          text: `🛡 @${senderPhone} slow down! Too many messages.`, mentions: [senderJid],
        });
      } catch {}
      return;
    }

    if (grpSettings.antiLongText && !isAdminUser && body && body.length > (grpSettings.maxTextLen || 500)) {
      try {
        await sock.sendMessage(from, { delete: msg.key });
        const warnCount = security.trackLongText(from, senderJid);
        const maxWarns  = 3;
        if (warnCount >= maxWarns) {
          security.clearLongTextWarn(from, senderJid);
          await admin.kickMember(sock, from, senderJid);
          await sock.sendMessage(from, {
            text: `🚫 @${senderPhone} has been *kicked* for repeatedly sending long text messages! (${warnCount}/${maxWarns} warnings)`,
            mentions: [senderJid],
          });
        } else {
          await sock.sendMessage(from, {
            text: `⚠️ @${senderPhone} — *Warning ${warnCount}/${maxWarns}:* Message too long! Max allowed is *${grpSettings.maxTextLen || 500} characters*.\n\n_${maxWarns - warnCount} more violation(s) will result in a kick._`,
            mentions: [senderJid],
          });
          await sock.sendMessage(senderJid + (senderJid.includes("@") ? "" : "@s.whatsapp.net"), {
            text: `⚠️ *Anti Long-Text Warning ${warnCount}/${maxWarns}*\n\nYou sent a message that was too long in a group. You have *${maxWarns - warnCount}* warning(s) left before you are kicked.\n\nPlease keep messages under *${grpSettings.maxTextLen || 500} characters*.`,
          }).catch(() => {});
        }
      } catch {}
      return;
    }

    if ((grpSettings.antiMentionGroup || grpSettings.antiTag) && !isAdminUser) {
      if (security.hasMassMention(msg, 5)) {
        try {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.sendMessage(from,
            { text: `🚫 @${senderPhone} mass tagging is not allowed!`, mentions: [senderJid] },
            { quoted: msg }
          );
        } catch {}
        return;
      }
    }

    // Anti Bad Word enforcement
    if (grpSettings.badWordsEnabled && !isAdminUser && body) {
      const badWords = grpSettings.badWords || [];
      const lowerBody = body.toLowerCase();
      const foundBad = badWords.find(w => lowerBody.includes(w));
      if (foundBad) {
        try {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.sendMessage(from,
            { text: `🚫 @${senderPhone} please watch your language! Banned word detected.`, mentions: [senderJid] },
            { quoted: msg }
          );
        } catch {}
        return;
      }
    }

    // Anti Image enforcement
    if (grpSettings.antiImage && !isAdminUser) {
      const msgContent = msg.message || {};
      const hasImage = !!(msgContent.imageMessage || msgContent.ephemeralMessage?.message?.imageMessage || msgContent.viewOnceMessage?.message?.imageMessage);
      if (hasImage) {
        try {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.sendMessage(from,
            { text: `📸 @${senderPhone} only admins can send images in this group!`, mentions: [senderJid] },
            { quoted: msg }
          );
        } catch {}
        return;
      }
    }

    if (grpSettings.antiDelete) {
      security.cacheMessage(msg.key.id, msg);
    }
  }

  const prefix = getPrefix();
  const prefixless = isPrefixless();

  const hasPrefix = body.startsWith(prefix);
  if (!hasPrefix && !prefixless) {
    if (body) {
      const kwResponse = keywords.match(body);
      if (kwResponse) {
        await sock.sendMessage(from, { text: kwResponse }, { quoted: msg });
      }
    }
    return;
  }

  const stripped = hasPrefix ? body.slice(prefix.length) : body;
  if (!stripped.trim()) return;

  const [rawCmd, ...args] = stripped.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const text = args.join(" ");

  analytics.trackMessage(senderJid, cmd).catch(() => {});
  console.log(`[CMD] ${senderPhone} → ${cmd}${text ? " " + text.slice(0, 40) : ""}`);

  try {
    switch (cmd) {

      case "menu":
      case "help":
      case "menuv": {
        const menuVideo    = settings.getMenuVideo();
        const menuImage    = settings.getMenuImage();
        const menuSong     = settings.getMenuSong();
        const menuType     = settings.getMenuType();   // "video" | "image"
        const menuPrefix   = getPrefix();
        const senderName   = msg.pushName || senderPhone;
        const header       = buildMenu(menuPrefix, senderName);
        const sections     = buildMenuSections(menuPrefix);
        const sectionsText = sections.join("\n\n");
        const footer       =
          `\n╭━━━〔 🚀 𝑵𝑬𝑿𝑼𝑺-𝑴𝑫 〕━━━╮\n` +
          `┃ Power • Speed • Intelligence\n` +
          `┃ made. by Ignatius\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯`;
        const fullCaption  = header + "\n\n" + sectionsText + "\n" + footer;

        // ── Step 1: Always send audio first so it starts playing before visual ──
        // No quoted/reply on the song — appears as a clean standalone audio bubble.
        if (menuSong) {
          try {
            await sock.sendMessage(from, {
              audio:    menuSong,
              mimetype: "audio/mpeg",
              ptt:      false,
            });
          } catch (songErr) {
            console.error("[MENU] Song send failed:", songErr.message);
          }
        }

        // ── Step 2: Send the visual (video or image) with the full menu caption ─
        if (menuType === "image") {
          if (menuImage) {
            await sock.sendMessage(from, { image: menuImage, caption: fullCaption }, { quoted: msg });
          } else {
            await reply(sock, msg, fullCaption);
          }
        } else {
          // Video mode (default)
          if (menuVideo) {
            await sock.sendMessage(from, {
              video:       menuVideo,
              caption:     fullCaption,
              mimetype:    "video/mp4",
              gifPlayback: true,   // auto-play loop like a GIF
            }, { quoted: msg });
          } else if (menuImage) {
            await sock.sendMessage(from, { image: menuImage, caption: fullCaption }, { quoted: msg });
          } else {
            await reply(sock, msg, fullCaption);
          }
        }
        break;
      }

      case "ping": {
        const start = Date.now();
        sock.sendPresenceUpdate("recording", from).catch(() => {});
        const latency = Date.now() - start;
        const uptime = process.uptime();
        const hrs = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        const secs = Math.floor(uptime % 60);
        const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        const dateStr = getFormattedDate();
        const timeStr = getFormattedTime();
        const plat = platform.get();
        await reply(sock, msg,
          `🏓 *Pong!*\n\n` +
          `⚡ *${botName}* is online\n` +
          `${plat.icon} Platform: *${plat.name}*\n` +
          `📶 Latency: *${latency}ms*\n` +
          `⏱ Uptime: *${hrs}h ${mins}m ${secs}s*\n` +
          `🧠 Memory: *${memMB} MB*\n` +
          `📌 Prefix: *${prefix}*  |  Prefixless: *${prefixless ? "ON" : "OFF"}*\n` +
          `📅 Date: *${dateStr}*\n` +
          `🕐 Time: *${timeStr}*\n\n` +
          `_Made by NEXUS-MD_ ⚡`
        );
        break;
      }

      case "ai":
      case "chat": {
        if (!text) { await reply(sock, msg, `💬 Usage: *${prefix}ai [message]*`); break; }
        const aiReply = await ai.chat(senderJid, text);
        await reply(sock, msg, aiReply);
        break;
      }

      case "ask": {
        if (!text) { await reply(sock, msg, `❓ Usage: *${prefix}ask [question]*`); break; }
        const answer = await ai.ask(text);
        await reply(sock, msg, answer);
        break;
      }

      case "summarize":
      case "summary": {
        const toSummarize = text || getQuotedMsg(msg)?.conversation || getQuotedMsg(msg)?.extendedTextMessage?.text;
        if (!toSummarize) { await reply(sock, msg, `📝 Reply to a message or provide text.`); break; }
        const summary = await ai.summarize(toSummarize);
        await reply(sock, msg, `📝 *Summary:*\n\n${summary}`);
        break;
      }

      case "clearchat": {
        ai.clearHistory(senderJid);
        await reply(sock, msg, "🗑️ AI chat history cleared.");
        break;
      }

      case "imagine":
      case "image": {
        if (!text) { await reply(sock, msg, `🎨 Usage: *${prefix}imagine [prompt]*`); break; }
        await reply(sock, msg, "🎨 Generating image...");
        const imgResult = await ai.generateImage(text);
        if (imgResult.error) { await reply(sock, msg, imgResult.error); break; }
        try {
          const res = await axios.get(imgResult.url, { responseType: "arraybuffer", timeout: 30000 });
          await sock.sendMessage(from, {
            image: Buffer.from(res.data),
            caption: `🎨 *Generated Image*\n_${text.slice(0, 100)}_`,
          }, { quoted: msg });
        } catch {
          await reply(sock, msg, `🎨 Image ready: ${imgResult.url}`);
        }
        break;
      }

      case "tts": {
        if (!text) { await reply(sock, msg, `🔊 Usage: *${prefix}tts [text]*`); break; }
        await reply(sock, msg, "🔊 Converting to speech...");
        const outPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
        const ttsResult = await ai.textToSpeech(text, outPath);
        if (ttsResult.error) { await reply(sock, msg, ttsResult.error); break; }
        await sock.sendMessage(from, {
          audio: fs.readFileSync(ttsResult.path), mimetype: "audio/mpeg", ptt: true,
        }, { quoted: msg });
        try { fs.unlinkSync(ttsResult.path); } catch {}
        break;
      }

      case "sticker":
      case "s": {
        const imgMsg = msg.message?.imageMessage;
        const vidMsg = msg.message?.videoMessage;
        const quotedImg = getQuotedMsg(msg)?.imageMessage;
        const quotedVid = getQuotedMsg(msg)?.videoMessage;
        if (!imgMsg && !vidMsg && !quotedImg && !quotedVid) {
          await reply(sock, msg, `🎨 Reply to an image/video with *${prefix}sticker*`);
          break;
        }
        await reply(sock, msg, "⏳ Creating sticker...");
        const targetMsg = (imgMsg || vidMsg) ? msg : { key: msg.key, message: getQuotedMsg(msg) };
        const buf = await getMediaBuffer(sock, targetMsg);
        if (!buf) { await reply(sock, msg, "❌ Could not download media."); break; }
        let stickerBuf;
        if (imgMsg || quotedImg) {
          stickerBuf = await sticker.imageToSticker(buf);
        } else {
          stickerBuf = await sticker.videoToSticker(buf);
        }
        await sock.sendMessage(from, { sticker: stickerBuf }, { quoted: msg });
        break;
      }

      case "v":
      case "vo":
      case "viewonce":
      case "reveal": {
        const quotedCtx = msg.message?.extendedTextMessage?.contextInfo;
        const quotedRaw = quotedCtx?.quotedMessage;

        if (!quotedRaw) {
          await reply(sock, msg, `👁 *Usage:* Reply to a view-once message with *${prefix}vo* to reveal it.`);
          break;
        }

        // Primary: look up the original message in our cache by stanzaId
        const stanzaId = quotedCtx?.stanzaId;
        const cachedEntry = stanzaId ? security.getCachedMessage(stanzaId) : null;
        const originalMsg = cachedEntry?.msg;

        // Extract voInner — prefer original cached message (has real media keys),
        // fall back to the stripped quoted context copy
        const voInner = extractViewOnce(originalMsg?.message) || extractViewOnce(quotedRaw);

        if (!voInner) {
          await reply(sock, msg, "❌ That is not a view-once message.");
          break;
        }

        await reply(sock, msg, "🔓 Decrypting view-once...");
        try {
          // Use the real key from the cached original so media can be downloaded
          const ctxForDecrypt = originalMsg
            ? { remoteJid: originalMsg.key?.remoteJid || from, stanzaId: originalMsg.key?.id, participant: originalMsg.key?.participant }
            : quotedCtx;
          const revealed = await decryptViewOnce(sock, voInner, ctxForDecrypt, from);
          if (!revealed) { await reply(sock, msg, "❌ Could not download the media. It may have expired."); break; }
          await sendRevealedMedia(sock, from, revealed, msg);
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "tr":
      case "translate": {
        const parts = text.split(" ");
        const targetLang = parts[0];
        const textToTranslate = parts.slice(1).join(" ");
        if (!targetLang || !textToTranslate) {
          await reply(sock, msg, `🌍 Usage: *${prefix}tr [lang] [text]*\nExample: *${prefix}tr es Hello*`);
          break;
        }
        if (!translator.isValidLang(targetLang)) {
          await reply(sock, msg, `❌ Unknown lang code. Use *${prefix}langs*`);
          break;
        }
        const result = await translator.translate(textToTranslate, targetLang);
        await reply(sock, msg, `🌍 *Translation (${targetLang}):*\n\n${result.text}`);
        break;
      }

      case "langs":
        await reply(sock, msg, `🌍 *Supported Languages:*\n\n${lang.getLangList()}`);
        break;

      case "lang": {
        if (!text) { await reply(sock, msg, `🌍 Usage: *${prefix}lang [code]*`); break; }
        const set = lang.setUserLang(senderJid, text.toLowerCase());
        if (set) await reply(sock, msg, `✅ Language set to *${lang.supportedLanguages[text.toLowerCase()]}*`);
        else await reply(sock, msg, `❌ Unknown language. Use *${prefix}langs*`);
        break;
      }

      case "dl":
      case "download": {
        const dlUrl    = args.find(a => a.startsWith("http"));
        const dlFormat = args.find(a => ["audio","video","mp3","mp4"].includes(a?.toLowerCase()))?.toLowerCase();
        if (!dlUrl) {
          await reply(sock, msg,
            `📥 *Universal Downloader*\n\n` +
            `Supports: YouTube, TikTok, Instagram, Twitter/X, Facebook, Pinterest & more\n\n` +
            `*Choose format:*\n` +
            `› *${prefix}dl [url] audio* — Download as MP3 audio\n` +
            `› *${prefix}dl [url] video* — Download as MP4 video\n\n` +
            `Examples:\n` +
            `› \`${prefix}dl https://youtu.be/xxx video\`\n` +
            `› \`${prefix}dl https://vm.tiktok.com/xxx audio\`\n` +
            `› \`${prefix}dl https://instagram.com/reel/xxx video\``
          );
          break;
        }
        const wantAudio = dlFormat === "audio" || dlFormat === "mp3";
        await reply(sock, msg, wantAudio ? "🎵 Downloading as *audio*..." : "🎬 Downloading as *video*...");
        try {
          const dlResult = wantAudio
            ? await downloader.downloadAudio(dlUrl)
            : await downloader.downloadVideo(dlUrl);
          if (wantAudio) {
            await sock.sendMessage(from, {
              audio: fs.readFileSync(dlResult.path), mimetype: "audio/mpeg", ptt: false,
            }, { quoted: msg });
          } else {
            await sock.sendMessage(from, {
              video: fs.readFileSync(dlResult.path),
              caption: `🎬 *${dlResult.title}*\n_Powered by NEXUS-MD ⚡_`, mimetype: "video/mp4",
            }, { quoted: msg });
          }
          try { fs.unlinkSync(dlResult.path); } catch {}
        } catch (e) {
          await reply(sock, msg, `❌ Download failed: ${e.message}`);
        }
        break;
      }

      case "yt":
      case "ytdl":
      case "audio": {
        const ytUrl    = args.find(a => a.startsWith("http"));
        const ytFormat = args.find(a => ["audio","video","mp3","mp4"].includes(a?.toLowerCase()))?.toLowerCase();
        if (!ytUrl) {
          await reply(sock, msg,
            `🎵 *YouTube Downloader*\n\n` +
            `*Format options:*\n` +
            `› *${prefix}yt [url] audio* — MP3 audio\n` +
            `› *${prefix}yt [url] video* — MP4 video\n\n` +
            `Default (no format): *audio*\n\n` +
            `Example:\n` +
            `› \`${prefix}yt https://youtu.be/xxx audio\`\n` +
            `› \`${prefix}yt https://youtu.be/xxx video\``
          );
          break;
        }
        const wantVideo = ytFormat === "video" || ytFormat === "mp4";
        await reply(sock, msg, wantVideo ? "🎬 Downloading YouTube video..." : "🎵 Downloading YouTube audio...");
        try {
          const dlResult = wantVideo
            ? await downloader.downloadVideo(ytUrl)
            : await downloader.downloadAudio(ytUrl);
          if (wantVideo) {
            await sock.sendMessage(from, {
              video: fs.readFileSync(dlResult.path),
              caption: `🎬 *${dlResult.title}*\n_Powered by NEXUS-MD ⚡_`, mimetype: "video/mp4",
            }, { quoted: msg });
          } else {
            await sock.sendMessage(from, {
              audio: fs.readFileSync(dlResult.path), mimetype: "audio/mpeg", ptt: false,
            }, { quoted: msg });
            await reply(sock, msg, `🎵 *${dlResult.title}*\n_Powered by NEXUS-MD ⚡_`);
          }
          try { fs.unlinkSync(dlResult.path); } catch {}
        } catch (e) {
          await reply(sock, msg, `❌ Download failed: ${e.message}`);
        }
        break;
      }

      case "music": {
        if (!text) { await reply(sock, msg, `🎵 Usage: *${prefix}music [query]*`); break; }
        await reply(sock, msg, `🔍 Searching: _${text}_...`);
        const results = await downloader.searchYouTube(text);
        if (!results.length) { await reply(sock, msg, "❌ No results found."); break; }
        let txt = `🎵 *Music Results:*\n\n`;
        results.forEach((r, i) => {
          txt += `${i + 1}. *${r.title}*\n   👤 ${r.channel || "Unknown"} | ⏱ ${r.duration || "?"}\n   🔗 ${r.url}\n\n`;
        });
        txt += `_Use *${prefix}yt [url]* to download_`;
        await reply(sock, msg, txt);
        break;
      }

      case "play":
      case "song":
      case "p": {
        if (!text) {
          await reply(sock, msg,
            `🎵 *Play Song*\n\n` +
            `Usage: *${prefix}play [song name]*\n\n` +
            `Examples:\n` +
            `› *${prefix}play vimbanda*\n` +
            `› *${prefix}play la minyo nestra phonk*\n` +
            `› *${prefix}play rema calm down*`
          );
          break;
        }
        await sock.sendPresenceUpdate("recording", from).catch(() => {});
        await reply(sock, msg, `🔍 Searching for *${text}*...`);
        try {
          const results = await downloader.searchYouTube(text);
          if (!results.length) { await reply(sock, msg, "❌ No results found. Try a different song name."); break; }
          const top = results[0];
          await reply(sock, msg,
            `🎵 *Found:* ${top.title}\n` +
            `👤 ${top.channel || "Unknown"} | ⏱ ${top.duration || "?"}\n` +
            `⬇️ Downloading...`
          );
          const dlResult = await downloader.downloadAudio(top.url);
          const audioBuf = fs.readFileSync(dlResult.path);
          await sock.sendMessage(from, {
            audio:    audioBuf,
            mimetype: "audio/mpeg",
            ptt:      false,
          }, { quoted: msg });
          await reply(sock, msg,
            `✅ *${dlResult.title}*\n` +
            `🔗 ${top.url}\n` +
            `_Powered by NEXUS-MD ⚡_`
          );
          fs.unlinkSync(dlResult.path);
        } catch (e) {
          await reply(sock, msg, `❌ Could not play song: ${e.message}`);
        }
        break;
      }

      case "fbdl":
      case "facebook": {
        const fbUrl    = args.find(a => a.startsWith("http"));
        const fbFormat = args.find(a => ["audio","video","mp3","mp4"].includes(a?.toLowerCase()))?.toLowerCase();
        if (!fbUrl) {
          await reply(sock, msg,
            `📥 *Facebook Downloader*\n\n` +
            `Usage:\n` +
            `› *${prefix}fbdl [url] video* — download as MP4\n` +
            `› *${prefix}fbdl [url] audio* — download as MP3\n\n` +
            `Example: \`${prefix}fbdl https://fb.com/xxx video\``
          );
          break;
        }
        const fbAudio = fbFormat === "audio" || fbFormat === "mp3";
        await reply(sock, msg, fbAudio ? "🎵 Downloading Facebook audio..." : "📥 Downloading Facebook video...");
        try {
          const result = fbAudio
            ? await downloader.downloadAudio(fbUrl)
            : await downloader.downloadUniversal(fbUrl, "auto");
          if (fbAudio || result.type === "audio") {
            await sock.sendMessage(from, {
              audio: fs.readFileSync(result.path), mimetype: "audio/mpeg", ptt: false,
            }, { quoted: msg });
          } else {
            await sock.sendMessage(from, {
              video: fs.readFileSync(result.path),
              caption: `🎬 *${result.title}*\n_Powered by NEXUS-MD ⚡_`, mimetype: "video/mp4",
            }, { quoted: msg });
          }
          try { fs.unlinkSync(result.path); } catch {}
        } catch (e) {
          await reply(sock, msg, `❌ Facebook download failed: ${e.message}`);
        }
        break;
      }

      case "pindl":
      case "pinterest": {
        const pinUrl    = args.find(a => a.startsWith("http"));
        const pinFormat = args.find(a => ["audio","video","mp3","mp4","image","photo"].includes(a?.toLowerCase()))?.toLowerCase();
        if (!pinUrl) {
          await reply(sock, msg,
            `📌 *Pinterest Downloader*\n\n` +
            `Usage:\n` +
            `› *${prefix}pindl [url] video* — download video as MP4\n` +
            `› *${prefix}pindl [url] audio* — download as MP3\n` +
            `› *${prefix}pindl [url]* — auto-detect (image or video)\n\n` +
            `Example: \`${prefix}pindl https://pin.it/xxx video\``
          );
          break;
        }
        const pinAudio = pinFormat === "audio" || pinFormat === "mp3";
        await reply(sock, msg, pinAudio ? "🎵 Downloading Pinterest audio..." : "📌 Downloading Pinterest media...");
        try {
          const result = pinAudio
            ? await downloader.downloadAudio(pinUrl)
            : await downloader.downloadUniversal(pinUrl, "auto");
          if (pinAudio || result.type === "audio") {
            await sock.sendMessage(from, {
              audio: fs.readFileSync(result.path), mimetype: "audio/mpeg", ptt: false,
            }, { quoted: msg });
            try { fs.unlinkSync(result.path); } catch {}
          } else if (result.type === "video") {
            await sock.sendMessage(from, {
              video: fs.readFileSync(result.path),
              caption: `📌 *${result.title}*\n_Powered by NEXUS-MD ⚡_`, mimetype: "video/mp4",
            }, { quoted: msg });
            try { fs.unlinkSync(result.path); } catch {}
          } else if (result.buffer) {
            await sock.sendMessage(from, {
              image: result.buffer,
              caption: `📌 *${result.title}*\n_Powered by NEXUS-MD ⚡_`,
            }, { quoted: msg });
          }
        } catch (e) {
          await reply(sock, msg, `❌ Pinterest download failed: ${e.message}`);
        }
        break;
      }

      case "convert": {
        const quotedMsg = getQuotedMsg(msg);
        if (!quotedMsg) {
          await reply(sock, msg, `📁 Reply to a file with *${prefix}convert*\n\n${converter.getSupportedFormats()}`);
          break;
        }
        await reply(sock, msg, "🔄 Converting...");
        const quotedType = Object.keys(quotedMsg)[0];
        const mediaBuf = await getMediaBuffer(sock, { key: msg.key, message: quotedMsg });
        if (!mediaBuf) { await reply(sock, msg, "❌ Could not read the file."); break; }
        if (quotedType === "videoMessage") {
          const audioBuf = await converter.videoToAudio(mediaBuf);
          await sock.sendMessage(from, { audio: audioBuf, mimetype: "audio/mpeg" }, { quoted: msg });
        } else if (quotedType === "imageMessage") {
          const format = (text || "pdf").toLowerCase();
          if (format === "pdf") {
            const pdfBuf = await converter.imageToPdf(mediaBuf);
            await sock.sendMessage(from, { document: pdfBuf, mimetype: "application/pdf", fileName: "converted.pdf" }, { quoted: msg });
          } else {
            const convertedBuf = await converter.convertImage(mediaBuf, format);
            await sock.sendMessage(from, { image: convertedBuf, caption: `✅ Converted to ${format.toUpperCase()}` }, { quoted: msg });
          }
        } else if (quotedType === "audioMessage") {
          const oggBuf = await converter.audioToOgg(mediaBuf);
          await sock.sendMessage(from, { audio: oggBuf, mimetype: "audio/ogg; codecs=opus", ptt: true }, { quoted: msg });
        } else {
          await reply(sock, msg, "❌ Unsupported file type.");
        }
        break;
      }

      case "shop":
      case "catalog":
        await reply(sock, msg, store.formatCatalog());
        break;

      case "order": {
        if (!text) { await reply(sock, msg, `🛒 Usage: *${prefix}order [id]*`); break; }
        const order = store.placeOrder(senderJid, parseInt(text), 1);
        if (!order) { await reply(sock, msg, "❌ Product not found. Use *!shop*"); break; }
        if (order.error) { await reply(sock, msg, `❌ ${order.error}`); break; }
        await reply(sock, msg,
          `✅ *Order Placed!*\n\n📦 ${order.productName}\n🔢 #${order.id}\n💰 $${order.total}\n\n_We'll contact you shortly._`
        );
        break;
      }

      case "myorders": {
        const orders = store.getUserOrders(senderJid);
        if (!orders.length) { await reply(sock, msg, "🛒 No orders yet."); break; }
        let txt = `🛒 *Your Orders:*\n\n`;
        orders.forEach((o) => {
          txt += `📦 *#${o.id}* — ${o.productName} | $${o.total} | ${o.status}\n`;
        });
        await reply(sock, msg, txt);
        break;
      }

      case "services":
        await reply(sock, msg, booking.formatServiceList());
        break;

      case "book": {
        const [serviceNum, date, time] = args;
        if (!serviceNum || !date || !time) {
          await reply(sock, msg, `📅 Usage: *${prefix}book [#] [date] [time]*\nEx: *${prefix}book 1 2024-12-25 14:00*`);
          break;
        }
        const b = booking.book(senderJid, serviceNum, date, time);
        await reply(sock, msg,
          `✅ *Booking Confirmed!*\n\n📋 #${b.id} — ${b.service}\n📆 ${b.date} at ${b.time}\n\n_Cancel with: *${prefix}cancel ${b.id}*_`
        );
        break;
      }

      case "mybookings":
        await reply(sock, msg, booking.formatUserBookings(senderJid));
        break;

      case "cancel": {
        if (!text) { await reply(sock, msg, `Usage: *${prefix}cancel [id]*`); break; }
        const cancelled = booking.cancelBooking(senderJid, parseInt(text));
        await reply(sock, msg, cancelled ? `✅ Booking #${text} cancelled.` : `❌ Booking not found.`);
        break;
      }

      case "stats":
        await reply(sock, msg, await analytics.formatStatsMessage());
        break;

      case "msglogs":
      case "dblogs":
      case "messagelog": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        await reply(sock, msg, "📊 Fetching message logs from Postgres...");
        try {
          const s = await db.getMessageStats();
          if (!s) { await reply(sock, msg, "❌ Database not available or no logs yet."); break; }

          const typeList = s.byType.map(t => `  ${t.type}: ${t.count}`).join("\n") || "  none yet";
          const topList  = s.topSenders.slice(0, 5).map((u, i) => `  ${i+1}. +${u.jid} — ${u.count} msgs`).join("\n") || "  none yet";
          const recentList = s.recent.slice(0, 5).map(r => {
            const ts   = new Date(r.created_at).toLocaleTimeString();
            const who  = (r.sender_jid || "?").split("@")[0];
            const body = r.body ? r.body.slice(0, 40) : `[${r.msg_type}]`;
            return `  [${ts}] +${who}: ${body}`;
          }).join("\n") || "  none yet";

          await reply(sock, msg,
            `🗄️ *Postgres Message Log*\n` +
            `${"─".repeat(28)}\n\n` +
            `📨 *Total messages:* ${s.total}\n` +
            `⚡ *Commands:* ${s.commands}\n` +
            `👤 *Unique users:* ${s.uniqueUsers}\n` +
            `👥 *Active groups:* ${s.activeGroups}\n\n` +
            `📁 *By type:*\n${typeList}\n\n` +
            `🏆 *Top senders:*\n${topList}\n\n` +
            `🕐 *Recent (5):*\n${recentList}\n\n` +
            `_Every message is auto-logged. Powered by NEXUS-MD ⚡_`
          );
        } catch (e) {
          await reply(sock, msg, `❌ Could not fetch logs: ${e.message}`);
        }
        break;
      }

      case "groupinfo": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        const info = await groups.getGroupInfo(sock, from);
        if (!info) { await reply(sock, msg, "❌ Could not fetch info."); break; }
        await reply(sock, msg,
          `📋 *Group Info*\n\n📛 ${info.name}\n👥 ${info.memberCount} members\n👑 ${info.admins} admins\n📅 Created: ${info.creation}` +
          (info.description ? `\n📝 ${info.description}` : "")
        );
        break;
      }

      case "botsettings":
        await reply(sock, msg, settings.formatSettingsMessage());
        break;

      case "features":
      case "featurelist":
        await reply(sock, msg, buildFeatureList(isGroup ? from : null));
        break;

      case "feature":
      case "toggle": {
        const featureName = args[0]?.toLowerCase();
        const featureVal  = args[1]?.toLowerCase();

        if (!featureName) {
          await reply(sock, msg, buildFeatureList(isGroup ? from : null));
          break;
        }

        const feat = FEATURE_MAP[featureName];
        if (!feat) {
          const names = Object.keys(FEATURE_MAP).join(", ");
          await reply(sock, msg, `❓ Unknown feature *${featureName}*\n\nAvailable: ${names}\n\nUsage: *${prefix}feature [name] on/off*`);
          break;
        }

        // Permission check
        if (feat.cat === "global" && !isSuperAdminUser()) {
          await reply(sock, msg, "🔒 Super admin only for global features.");
          break;
        }
        if (feat.cat === "group") {
          if (!isGroup) { await reply(sock, msg, "❌ This feature only works in groups. Run this command inside a group."); break; }
          if (!isAdminUser) { await reply(sock, msg, "🔒 Group admin only."); break; }
        }

        // If no on/off given, show current status and toggle hint
        if (featureVal !== "on" && featureVal !== "off") {
          const current = feat.cat === "group" ? feat.get(from) : feat.get();
          await reply(sock, msg,
            `${feat.emoji} *${feat.label}*\n\nCurrent: ${current ? "✅ ON" : "❌ OFF"}\n\nUsage: *${prefix}feature ${featureName} on/off*`
          );
          break;
        }

        const newVal = featureVal === "on";
        if (feat.cat === "group") {
          feat.set(newVal, from);
        } else {
          feat.set(newVal);
        }

        await reply(sock, msg,
          `${feat.emoji} *${feat.label}* — ${newVal ? "✅ *Enabled*" : "❌ *Disabled*"}\n\n_Use \`${prefix}features\` to see all features_`
        );
        break;
      }

      case "mode":
      case "setmode": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const mode = args[0]?.toLowerCase();
        if (!["public", "private", "group"].includes(mode)) {
          const cur = settings.get("mode") || "public";
          const icons = { public: "🌍", private: "🔒", group: "👥" };
          await reply(sock, msg,
            `⚙️ *Bot Mode*\n\n` +
            `Current: ${icons[cur]} *${cur.toUpperCase()}*\n\n` +
            `Usage: *${prefix}setmode [mode]*\n\n` +
            `🌍 *public*  — Responds to everyone\n` +
            `🔒 *private* — Super admins only\n` +
            `👥 *group*   — Groups only\n\n` +
            `Example: *${prefix}setmode public*`
          );
          break;
        }
        settings.set("mode", mode);
        const modeIcons = { public: "🌍", private: "🔒", group: "👥" };
        await reply(sock, msg, `${modeIcons[mode]} Bot mode set to *${mode.toUpperCase()}*\n\n_All users will ${mode === "public" ? "now be able to use the bot." : mode === "private" ? "no longer be able to use the bot (admins only)." : "only use the bot in groups."}_`);
        break;
      }

      case "setowner":
      case "setownername": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        if (!text) {
          const cur = settings.get("ownerName") || "Nexus Tech";
          await reply(sock, msg,
            `👤 *Set Owner Name*\n\n` +
            `Current: *${cur}*\n\n` +
            `Usage: *${prefix}setowner [name]*\n` +
            `Example: *${prefix}setowner ignatius*`
          );
          break;
        }
        settings.set("ownerName", text.trim());
        await reply(sock, msg, `✅ Owner name set to *${text.trim()}*\n_This name now appears in the bot menu._`);
        break;
      }

      case "setbotname": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        if (!text) {
          const cur = settings.get("botName") || botName || "NEXUS-MD";
          await reply(sock, msg,
            `🤖 *Set Bot Name*\n\n` +
            `Current: *${cur}*\n\n` +
            `Usage: *${prefix}setbotname [name]*\n` +
            `Example: *${prefix}setbotname IgniteBot Pro*`
          );
          break;
        }
        settings.set("botName", text.trim());
        await reply(sock, msg, `✅ Bot name set to *${text.trim()}*\n_This name now appears in the menu header._`);
        break;
      }

      case "sudo": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const mentioned = getMentioned(msg);
        const numArg = normalizePhone(text);
        const targetJid = mentioned[0] || (numArg ? `${numArg}@s.whatsapp.net` : null);
        if (!targetJid) { await reply(sock, msg, `👑 Usage: *${prefix}sudo @user* or *${prefix}sudo 254XXXXXXX*`); break; }
        admin.addSudo(targetJid);
        const phone = targetJid.split("@")[0].split(":")[0];
        await reply(sock, msg, `👑 *+${phone}* has been granted *Super Admin* privileges!`);
        break;
      }

      case "removesudo":
      case "unsudo": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const mentioned = getMentioned(msg);
        const numArg = normalizePhone(text);
        const targetJid = mentioned[0] || (numArg ? `${numArg}@s.whatsapp.net` : null);
        if (!targetJid) { await reply(sock, msg, `Usage: *${prefix}removesudo @user*`); break; }
        admin.removeSudo(targetJid);
        const phone = targetJid.split("@")[0].split(":")[0];
        await reply(sock, msg, `✅ *+${phone}* removed from Super Admins.`);
        break;
      }

      case "sudolist": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const dynSudos = admin.getDynamicSudos();
        const { admins: envAdmins } = require("../config");
        const allAdmins = [...new Set([...envAdmins, ...dynSudos])];
        if (!allAdmins.length) { await reply(sock, msg, "👑 No super admins configured."); break; }
        const list = allAdmins.map((n, i) => `${i + 1}. +${n}`).join("\n");
        await reply(sock, msg, `👑 *Super Admins* (${allAdmins.length})\n\n${list}`);
        break;
      }

      case "setprefix": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const newPrefix = args[0];
        if (!newPrefix || newPrefix.length > 3) {
          await reply(sock, msg, `📌 Usage: *${prefix}setprefix [char]*\nExample: *${prefix}setprefix !*`);
          break;
        }
        settings.set("prefix", newPrefix);
        await reply(sock, msg, `✅ Prefix changed to *${newPrefix}*\nNow use *${newPrefix}menu* to open the menu.`);
        break;
      }

      case "settimezone": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const tzArg = args[0]; // e.g. Africa/Nairobi
        if (!tzArg) {
          const cur = settings.get("timezone") || "Africa/Nairobi";
          await reply(sock, msg,
            `🌍 *Timezone Setting*\n\n` +
            `📍 *Current:* ${cur}\n\n` +
            `Usage: *${prefix}settimezone [IANA timezone]*\n` +
            `Examples:\n• ${prefix}settimezone Africa/Nairobi\n• ${prefix}settimezone Africa/Lagos\n• ${prefix}settimezone Asia/Kolkata\n• ${prefix}settimezone America/New_York\n• ${prefix}settimezone Europe/London`
          );
          break;
        }
        // Validate by attempting to format a date with the given timezone
        try {
          new Date().toLocaleString("en-GB", { timeZone: tzArg });
        } catch {
          await reply(sock, msg, `❌ *"${tzArg}"* is not a valid IANA timezone.\n\nExamples: Africa/Nairobi, America/New_York, Europe/London`);
          break;
        }
        settings.set("timezone", tzArg);
        await reply(sock, msg, `✅ Timezone set to *${tzArg}*\nDate/time commands will now show local time.`);
        break;
      }

      case "setcountry": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const ccArg = args[0]?.replace(/\D/g, "");
        if (!ccArg) {
          const cur = settings.get("countryCode") || "254";
          await reply(sock, msg,
            `📞 *Country Code Setting*\n\n` +
            `📍 *Current:* +${cur}\n\n` +
            `Usage: *${prefix}setcountry [code]*\n` +
            `Examples:\n• ${prefix}setcountry 254  _(Kenya)_\n• ${prefix}setcountry 234  _(Nigeria)_\n• ${prefix}setcountry 27   _(South Africa)_\n• ${prefix}setcountry 44   _(UK)_\n\n` +
            `_This allows typing local numbers like 07XXXXXXXX instead of 2547XXXXXXXX_`
          );
          break;
        }
        settings.set("countryCode", ccArg);
        await reply(sock, msg, `✅ Country code set to *+${ccArg}*\nLocal numbers starting with *0* will now be expanded to *${ccArg}XXXXXXXXX*.`);
        break;
      }

      case "prefixless": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const plVal = args[0]?.toLowerCase();
        if (plVal !== "on" && plVal !== "off") {
          await reply(sock, msg, `📌 Usage: *${prefix}prefixless on/off*\n\n_When ON, commands work without the prefix (e.g. just type \`menu\` or \`ping\`)_`);
          break;
        }
        settings.set("prefixless", plVal === "on");
        await reply(sock, msg, `📌 Prefixless mode ${plVal === "on" ? "✅ *enabled* — commands work without prefix" : "❌ *disabled* — prefix required"}`);
        break;
      }

      case "autoview": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}autoview on/off*`); break; }
        settings.set("autoViewStatus", val === "on");
        await reply(sock, msg, `👁 Auto view status ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "autolike": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}autolike on/off*`); break; }
        settings.set("autoLikeStatus", val === "on");
        await reply(sock, msg, `❤️ Auto like status ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "alwaysonline": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}alwaysonline on/off*`); break; }
        settings.set("alwaysOnline", val === "on");
        await reply(sock, msg, `🟢 Always online ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "anticall": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}anticall on/off*`); break; }
        settings.set("antiCall", val === "on");
        await reply(sock, msg, `📵 Anti-call ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "antideletestatus": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antideletestatus on/off*`); break; }
        settings.set("antiDeleteStatus", val === "on");
        await reply(sock, msg, `🗑 Anti-delete status ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "viewonce":
      case "antiviewonce":
      case "voreveal": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (!val) {
          const cur = settings.get("voReveal");
          await reply(sock, msg,
            `👁 *View-Once Auto-Reveal*\n\n` +
            `📍 *Current:* ${cur ? "✅ ON" : "❌ OFF"}\n\n` +
            `When enabled, any view-once photo, video or audio sent in a chat where the bot is present will be automatically re-sent as a normal (saveable) message.\n\n` +
            `Usage: *${prefix}viewonce on* / *${prefix}viewonce off*`
          );
          break;
        }
        if (val !== "on" && val !== "off") {
          await reply(sock, msg, `Usage: *${prefix}viewonce on/off*`);
          break;
        }
        settings.set("voReveal", val === "on");
        await reply(sock, msg,
          val === "on"
            ? `👁 *View-Once Auto-Reveal* ✅ *enabled*\n\nAll view-once photos, videos and audio messages will now be automatically decrypted and re-sent as normal saveable messages.`
            : `👁 *View-Once Auto-Reveal* ❌ *disabled*\n\nView-once messages will expire normally.`
        );
        break;
      }

      case "antimentiongroup": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antimentiongroup on/off*`); break; }
        security.setGroupSetting(from, "antiMentionGroup", val === "on");
        await reply(sock, msg, `🚫 Anti-mention group ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "antitag": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antitag on/off*`); break; }
        security.setGroupSetting(from, "antiTag", val === "on");
        await reply(sock, msg, `🏷 Anti-tag ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "antisticker": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antisticker on/off*`); break; }
        security.setGroupSetting(from, "antiSticker", val === "on");
        await reply(sock, msg, `🚫 Anti-sticker ${val === "on" ? "✅ *enabled* — stickers will be deleted" : "❌ *disabled*"}`);
        break;
      }

      case "antimention": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antimention on/off*`); break; }
        security.setGroupSetting(from, "antiMentionGroup", val === "on");
        await reply(sock, msg, `🔕 Anti-mention ${val === "on" ? "✅ *enabled* — mass mentions will be deleted" : "❌ *disabled*"}`);
        break;
      }

      case "setmenuvideo": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const vidMsg = msg.message?.videoMessage || getQuotedMsg(msg)?.videoMessage;
        if (!vidMsg) { await reply(sock, msg, `🎬 Reply to a video with *${prefix}setmenuvideo* to set it as the menu video.`); break; }
        await reply(sock, msg, "⏳ Saving menu video...");
        const targetMsg = msg.message?.videoMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
        const videoBuf = await getMediaBuffer(sock, targetMsg);
        if (!videoBuf) { await reply(sock, msg, "❌ Could not download video."); break; }
        settings.setMenuVideo(videoBuf);
        await reply(sock, msg, "✅ Menu video set! Now the menu will send a video with the commands.");
        break;
      }

      case "clearmenuvideo": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        settings.clearMenuVideo();
        await reply(sock, msg, "✅ Menu video cleared.");
        break;
      }

      case "setmenuimage": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const imgMsg = msg.message?.imageMessage || getQuotedMsg(msg)?.imageMessage;
        if (!imgMsg) { await reply(sock, msg, `🖼 Reply to an image with *${prefix}setmenuimage* to set it as the menu image.`); break; }
        await reply(sock, msg, "⏳ Saving menu image...");
        const targetImgMsg = msg.message?.imageMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
        const imgBuf = await getMediaBuffer(sock, targetImgMsg);
        if (!imgBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
        settings.setMenuImage(imgBuf);
        clearCombinedMenuVideo();
        await reply(sock, msg, "✅ Menu image set! It will now appear when someone opens the menu.");
        break;
      }

      case "clearmenuimage": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        settings.clearMenuImage();
        clearCombinedMenuVideo();
        await reply(sock, msg, "✅ Menu image cleared. The default image will be used.");
        break;
      }

      case "setmenusong": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const audioMsg = msg.message?.audioMessage || getQuotedMsg(msg)?.audioMessage;
        if (!audioMsg) {
          await reply(sock, msg, `🎵 Reply to an audio/song with *${prefix}setmenusong* to set it as the menu song.\n\nTip: Use *${prefix}yt [youtube url]* to download a song first, then reply to it with this command.`);
          break;
        }
        await reply(sock, msg, "⏳ Saving menu song...");
        const targetAudioMsg = msg.message?.audioMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
        const audioBuf = await getMediaBuffer(sock, targetAudioMsg);
        if (!audioBuf) { await reply(sock, msg, "❌ Could not download audio."); break; }
        settings.setMenuSong(audioBuf);
        clearCombinedMenuVideo();
        await reply(sock, msg, "✅ Menu song set! It will play every time someone opens the menu 🎵");
        break;
      }

      case "clearmenusong": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        settings.clearMenuSong();
        clearCombinedMenuVideo();
        await reply(sock, msg, "✅ Menu song cleared.");
        break;
      }

      case "menutype": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const choice = text.trim().toLowerCase();
        if (!choice) {
          const current = settings.getMenuType();
          await reply(sock, msg,
            `📋 *Menu Type*\n\n` +
            `Current: *${current === "video" ? "🎬 Video" : "🖼 Image"}*\n\n` +
            `Usage:\n` +
            `• *${prefix}menutype video* — Send menu as a video (default; uses bundled video or your custom one)\n` +
            `• *${prefix}menutype image* — Send menu as an image (uses your set menu image)`
          );
          break;
        }
        if (choice !== "video" && choice !== "image") {
          await reply(sock, msg, `❌ Invalid option. Use *${prefix}menutype video* or *${prefix}menutype image*`);
          break;
        }
        settings.setMenuType(choice);
        const label = choice === "video" ? "🎬 Video" : "🖼 Image";
        await reply(sock, msg, `✅ Menu type set to *${label}*! The menu will now be sent as a ${choice}.`);
        break;
      }

      case "pairing": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        await reply(sock, msg, `🔗 To get a pairing code, visit:\n*${process.env.APP_URL || "your-app-url"}/pair*\n\nOr use the web dashboard to enter your phone number.`);
        break;
      }

      case "keywords": {
        const kws = keywords.getAll();
        if (!kws.length) { await reply(sock, msg, "🔑 No keywords set."); break; }
        let txt = `🔑 *Keywords:*\n\n`;
        kws.forEach((kw) => {
          txt += `• *${kw.keyword}* → ${kw.response.slice(0, 40)}${kw.response.length > 40 ? "..." : ""}\n`;
        });
        await reply(sock, msg, txt);
        break;
      }

      case "setkeyword": {
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const parts = text.split("|");
        if (parts.length < 2) {
          await reply(sock, msg, `Usage: *${prefix}setkeyword [trigger]|[response]*`);
          break;
        }
        keywords.add(parts[0].trim(), parts.slice(1).join("|").trim());
        await reply(sock, msg, `✅ Keyword set: *${parts[0].trim()}*`);
        break;
      }

      case "delkeyword": {
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}delkeyword [trigger]*`); break; }
        keywords.remove(text.trim());
        await reply(sock, msg, `✅ Keyword removed: *${text.trim()}*`);
        break;
      }

      case "broadcast": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}broadcast [message]*`); break; }
        const recipients = broadcast.getRecipients();
        if (!recipients.length) { await reply(sock, msg, "📢 No recipients yet."); break; }
        await reply(sock, msg, `📢 Sending to ${recipients.length} contacts...`);
        const results = await broadcast.broadcast(sock, text, recipients);
        await reply(sock, msg, `✅ Done!\n📤 Sent: ${results.sent} | ❌ Failed: ${results.failed}`);
        break;
      }

      case "antilink": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antilink on/off*`); break; }
        security.setGroupSetting(from, "antiLink", val === "on");
        await reply(sock, msg, `🔐 Anti-link ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "antispam": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antispam on/off*`); break; }
        security.setGroupSetting(from, "antiSpam", val === "on");
        await reply(sock, msg, `🛡 Anti-spam ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "antilongtext":
      case "antiflood": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") {
          const grp = security.getGroupSettings(from);
          await reply(sock, msg,
            `📝 *Anti Long-Text*\n\n` +
            `Status: ${grp.antiLongText ? "✅ ON" : "❌ OFF"}\n` +
            `Max chars: *${grp.maxTextLen || 500}*\n` +
            `Warnings before kick: *3*\n\n` +
            `Usage: *${prefix}antilongtext on/off*\n` +
            `Set limit: *${prefix}setmaxtextlen [number]*\n\n` +
            `_Members who send oversized messages will be warned 3 times then kicked._`
          );
          break;
        }
        security.setGroupSetting(from, "antiLongText", val === "on");
        const limit = security.getGroupSettings(from).maxTextLen || 500;
        await reply(sock, msg,
          `📝 Anti long-text ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}` +
          (val === "on" ? `\n_Messages over *${limit} characters* will be deleted + warned. 3 warnings = kick._` : "")
        );
        break;
      }

      case "setmaxtextlen":
      case "settextlimit": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const num = parseInt(args[0]);
        if (!num || num < 50 || num > 10000) {
          await reply(sock, msg,
            `📏 *Set Max Text Length*\n\n` +
            `Current limit: *${security.getGroupSettings(from).maxTextLen || 500} chars*\n\n` +
            `Usage: *${prefix}setmaxtextlen [50–10000]*\n` +
            `Example: *${prefix}setmaxtextlen 300*`
          );
          break;
        }
        security.setGroupSetting(from, "maxTextLen", num);
        await reply(sock, msg, `✅ Max text length set to *${num} characters*\n_${prefix}antilongtext must be ON for this to take effect._`);
        break;
      }

      case "antidelete": {
        if (!isAdminUser && !isSuperAdminUser()) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        const VALID_MODES = ["chat","group","status","both","all","on","off"];
        const modeLabels  = {
          chat:   "💬 Chat (DMs only)",
          group:  "👥 Group (groups only)",
          status: "📸 Status (status updates only)",
          both:   "🔁 Both (DMs + Groups)",
          all:    "🌐 All (DMs + Groups + Status)",
          off:    "❌ Disabled",
        };

        if (!val || !VALID_MODES.includes(val)) {
          const curMode = settings.get("antiDeleteMode") || "off";
          const grpOn   = isGroup ? security.getGroupSettings(from).antiDelete : null;
          await reply(sock, msg,
            `🗑 *Anti-Delete Settings*\n` +
            `${"─".repeat(28)}\n\n` +
            `🌐 Global mode: *${(curMode).toUpperCase()}*\n` +
            (isGroup ? `👥 This group: *${grpOn ? "ON" : "OFF"}*\n` : "") +
            `\n*Available modes:*\n` +
            `› *${prefix}antidelete chat*   — Monitor DM deletions\n` +
            `› *${prefix}antidelete group*  — Monitor group deletions\n` +
            `› *${prefix}antidelete status* — Monitor status deletions\n` +
            `› *${prefix}antidelete both*   — DMs + Groups\n` +
            `› *${prefix}antidelete all*    — Everything\n` +
            `› *${prefix}antidelete off*    — Disable all\n\n` +
            `_Recovered content is sent to the chat AND to your DM._`
          );
          break;
        }

        if (val === "off") {
          settings.set("antiDeleteMode", "off");
          if (isGroup) security.setGroupSetting(from, "antiDelete", false);
          await reply(sock, msg, "🗑 Anti-delete ❌ *disabled globally*");
          break;
        }

        if (val === "on") {
          // "on" in a group enables for that group; globally sets to "both"
          const newMode = isGroup ? "group" : "both";
          settings.set("antiDeleteMode", newMode);
          if (isGroup) security.setGroupSetting(from, "antiDelete", true);
          await reply(sock, msg, `🗑 Anti-delete ✅ *enabled*\nMode: *${newMode.toUpperCase()}*\n_${modeLabels[newMode]}_`);
          break;
        }

        // Specific mode selected
        settings.set("antiDeleteMode", val);
        if (val === "group" || val === "both" || val === "all") {
          if (isGroup) security.setGroupSetting(from, "antiDelete", true);
        }
        await reply(sock, msg,
          `🗑 Anti-delete mode set to *${val.toUpperCase()}*\n` +
          `${modeLabels[val]}\n\n` +
          `✅ *What gets recovered:*\n` +
          `› Text, Images, Videos, Audio\n` +
          `› Voice notes, Stickers, Documents\n\n` +
          `📍 *Where it's sent:*\n` +
          `› Back in the original chat\n` +
          `› Copy to your private DM\n` +
          `› Warning sent to the deleter (groups)`
        );
        break;
      }

      case "kick": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const mentioned = getMentioned(msg);
        const target = mentioned[0] || getQuotedJid(msg);
        if (!target) { await reply(sock, msg, `Usage: *${prefix}kick @user*`); break; }
        await admin.kickMember(sock, from, target);
        await reply(sock, msg, `✅ Kicked @${target.split("@")[0]}`);
        break;
      }

      case "promote": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const mentioned = getMentioned(msg);
        if (!mentioned.length) { await reply(sock, msg, `Usage: *${prefix}promote @user*`); break; }
        await admin.promoteMember(sock, from, mentioned[0]);
        await reply(sock, msg, `⬆️ @${mentioned[0].split("@")[0]} promoted to admin.`);
        break;
      }

      case "demote": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const mentioned = getMentioned(msg);
        if (!mentioned.length) { await reply(sock, msg, `Usage: *${prefix}demote @user*`); break; }
        await admin.demoteMember(sock, from, mentioned[0]);
        await reply(sock, msg, `⬇️ @${mentioned[0].split("@")[0]} demoted.`);
        break;
      }

      case "mute": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        await admin.muteGroup(sock, from);
        await reply(sock, msg, "🔇 Group muted. Only admins can message.");
        break;
      }

      case "unmute": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        await admin.unmuteGroup(sock, from);
        await reply(sock, msg, "🔊 Group unmuted.");
        break;
      }

      case "tagall": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        await groups.tagAll(sock, from, text || "📢 Attention everyone!");
        break;
      }

      case "setwelcome": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}setwelcome [msg]*\nUse {{name}} and {{group}}`); break; }
        groups.setWelcomeMessage(from, text);
        await reply(sock, msg, "✅ Welcome message updated!");
        break;
      }

      case "ban": {
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const mentioned = getMentioned(msg);
        if (!mentioned.length) { await reply(sock, msg, `Usage: *${prefix}ban @user*`); break; }
        security.banUser(mentioned[0]);
        await reply(sock, msg, `🔨 @${mentioned[0].split("@")[0]} banned from bot.`);
        break;
      }

      case "unban": {
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const mentioned = getMentioned(msg);
        if (!mentioned.length) { await reply(sock, msg, `Usage: *${prefix}unban @user*`); break; }
        security.unbanUser(mentioned[0]);
        await reply(sock, msg, `✅ @${mentioned[0].split("@")[0]} unbanned.`);
        break;
      }

      case "warn": {
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const mentioned = getMentioned(msg);
        if (!mentioned.length) { await reply(sock, msg, `Usage: *${prefix}warn @user*`); break; }
        const warnCount = security.warnUser(mentioned[0]);
        await reply(sock, msg,
          `⚠️ @${mentioned[0].split("@")[0]} warned!\n📊 Warnings: *${warnCount}/3*` +
          (warnCount >= 3 ? "\n🚨 Warning limit reached!" : "")
        );
        break;
      }

      case "warnings": {
        const mentioned = getMentioned(msg);
        const target = mentioned[0] || senderJid;
        const warnCount = security.getWarnings(target);
        await reply(sock, msg, `⚠️ @${target.split("@")[0]}: *${warnCount}* warning(s).`);
        break;
      }

      case "time":
      case "date": {
        const tz = settings.get("timezone") || "Africa/Nairobi";
        await reply(sock, msg,
          `🕐 *Date & Time*\n\n` +
          `📅 *Date:* ${getFormattedDate()}\n` +
          `⏰ *Time:* ${getFormattedTime()}\n` +
          `🌍 *Timezone:* ${tz}`
        );
        break;
      }

      case "uptime": {
        const ut = process.uptime();
        const h = Math.floor(ut / 3600), m = Math.floor((ut % 3600) / 60), s = Math.floor(ut % 60);
        const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        await reply(sock, msg,
          `╔══════════════════╗\n║  ⚡ *NEXUS-MD STATUS*  ║\n╚══════════════════╝\n\n` +
          `🟢 *Status:* Online\n⏱ *Uptime:* ${h}h ${m}m ${s}s\n💾 *RAM:* ${mem} MB\n🤖 *Prefix:* ${prefix}\n📅 *Date:* ${getFormattedDateTime()}`
        );
        break;
      }

      case "alive": {
        await reply(sock, msg,
          `╔═══════════════════╗\n║  🤖 *NEXUS-MD ALIVE* ║\n╚═══════════════════╝\n\n` +
          `✅ I am alive and kicking!\n\n🔋 *System:* All systems go\n⚡ *Prefix:* ${prefix}\n👑 *Master:* Set via ADMIN_NUMBERS\n\n_Type \`${prefix}menu\` to see all commands_`
        );
        break;
      }

      // ── Fun & utility ────────────────────────────────────────────────────
      case "flip": {
        const result = Math.random() < 0.5 ? "🪙 *Heads!*" : "🪙 *Tails!*";
        await reply(sock, msg, `Flipping a coin...\n\n${result}`);
        break;
      }

      case "roll": {
        const max = parseInt(args[0]) || 6;
        if (max < 2 || max > 1000) { await reply(sock, msg, "🎲 Usage: `.roll [max]` e.g. `.roll 6`"); break; }
        const rolled = Math.floor(Math.random() * max) + 1;
        await reply(sock, msg, `🎲 Rolling 1–${max}...\n\n🎯 *You got: ${rolled}*`);
        break;
      }

      case "8ball": {
        if (!text) { await reply(sock, msg, "🎱 Ask a question! e.g. `.8ball Will I be rich?`"); break; }
        const answers = [
          "✅ It is certain.", "✅ Without a doubt!", "✅ Yes, definitely.", "✅ You may rely on it.",
          "✅ As I see it, yes.", "✅ Most likely.", "✅ Outlook good.", "✅ Signs point to yes.",
          "🤔 Reply hazy, try again.", "🤔 Ask again later.", "🤔 Better not tell you now.",
          "❌ Don't count on it.", "❌ My reply is no.", "❌ My sources say no.",
          "❌ Outlook not so good.", "❌ Very doubtful."
        ];
        await reply(sock, msg, `🎱 *Magic 8-Ball*\n\n❓ _${text}_\n\n${answers[Math.floor(Math.random() * answers.length)]}`);
        break;
      }

      case "quote":
      case "inspire": {
        await reply(sock, msg, "⏳ Fetching a quote...");
        try {
          const r = await axios.get("https://zenquotes.io/api/random", { timeout: 8000 });
          const q = r.data[0];
          await reply(sock, msg, `💬 *"${q.q}"*\n\n— _${q.a}_`);
        } catch {
          const fallbacks = [
            `"The only way to do great work is to love what you do." — Steve Jobs`,
            `"In the middle of difficulty lies opportunity." — Albert Einstein`,
            `"It always seems impossible until it's done." — Nelson Mandela`,
          ];
          await reply(sock, msg, `💬 ${fallbacks[Math.floor(Math.random() * fallbacks.length)]}`);
        }
        break;
      }

      case "joke": {
        await reply(sock, msg, "😂 Loading a joke...");
        try {
          const r = await axios.get("https://v2.jokeapi.dev/joke/Any?safe-mode&type=twopart", { timeout: 8000 });
          await reply(sock, msg, `😂 *Joke Time!*\n\n${r.data.setup}\n\n||${r.data.delivery}||`);
        } catch {
          await reply(sock, msg, "😂 Why don't scientists trust atoms?\n\n||Because they make up everything!||");
        }
        break;
      }

      case "fact": {
        await reply(sock, msg, "🧠 Fetching a fact...");
        try {
          const r = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en", { timeout: 8000 });
          await reply(sock, msg, `🧠 *Random Fact*\n\n${r.data.text}`);
        } catch {
          await reply(sock, msg, "🧠 Honey never spoils — archaeologists have found 3000-year-old honey in Egyptian tombs that was still edible!");
        }
        break;
      }

      case "weather": {
        if (!text) { await reply(sock, msg, "🌤 Usage: `.weather Lagos` or `.weather London`"); break; }
        await reply(sock, msg, "🌤 Checking weather...");
        try {
          const city = encodeURIComponent(text.trim());
          const r = await axios.get(`https://wttr.in/${city}?format=j1`, { timeout: 10000 });
          const w = r.data.current_condition[0];
          const area = r.data.nearest_area[0];
          const areaName = area.areaName[0].value;
          const country = area.country[0].value;
          const desc = w.weatherDesc[0].value;
          const temp = w.temp_C;
          const feels = w.FeelsLikeC;
          const humidity = w.humidity;
          const wind = w.windspeedKmph;
          const vis = w.visibility;
          await reply(sock, msg,
            `🌤 *Weather: ${areaName}, ${country}*\n\n` +
            `🌡 *Temp:* ${temp}°C  _(feels ${feels}°C)_\n` +
            `⛅ *Condition:* ${desc}\n` +
            `💧 *Humidity:* ${humidity}%\n` +
            `💨 *Wind:* ${wind} km/h\n` +
            `👁 *Visibility:* ${vis} km`
          );
        } catch { await reply(sock, msg, "❌ Could not fetch weather. Try a different city name."); }
        break;
      }

      case "epl":
      case "eplscores":
      case "premierleague":
      case "pl": {
        await reply(sock, msg, "⚽ Fetching Premier League scores...");
        try {
          const subCmd = (args[0] || "scores").toLowerCase();

          if (subCmd === "table" || subCmd === "standings" || subCmd === "stand") {
            const r = await axios.get(
              "https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings",
              { timeout: 12000 }
            );
            const entries = r.data?.standings?.[0]?.entries || [];
            if (!entries.length) { await reply(sock, msg, "❌ Could not fetch standings."); break; }
            let out = `🏴󠁧󠁢󠁥󠁮󠁧󠁿 *Premier League Standings*\n${"─".repeat(30)}\n`;
            out += `${"Pos".padEnd(4)} ${"Club".padEnd(22)} ${"P".padEnd(3)} ${"W".padEnd(3)} ${"D".padEnd(3)} ${"L".padEnd(3)} ${"Pts"}\n`;
            out += `${"─".repeat(45)}\n`;
            entries.slice(0, 20).forEach((e, i) => {
              const team = (e.team?.shortDisplayName || e.team?.displayName || "?").slice(0, 20);
              const stats = {};
              (e.stats || []).forEach(s => { stats[s.name] = s.value; });
              const pos = (i + 1).toString().padEnd(4);
              out += `${pos} ${team.padEnd(22)} ${String(stats.gamesPlayed || 0).padEnd(3)} ${String(stats.wins || 0).padEnd(3)} ${String(stats.ties || 0).padEnd(3)} ${String(stats.losses || 0).padEnd(3)} ${stats.points || 0}\n`;
            });
            await reply(sock, msg, `\`\`\`${out}\`\`\`\n_Use *${prefix}epl scores* for today's matches_`);
            break;
          }

          const r = await axios.get(
            "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",
            { timeout: 12000 }
          );
          const events = r.data?.events || [];
          if (!events.length) {
            await reply(sock, msg,
              `⚽ *Premier League*\n\n_No matches scheduled today._\n\nUse *${prefix}epl table* for standings\nUse *${prefix}epl next* for upcoming fixtures`
            );
            break;
          }

          let out = `⚽ *Premier League — Today's Matches*\n${"─".repeat(32)}\n\n`;
          for (const ev of events) {
            const comp = ev.competitions?.[0];
            if (!comp) continue;
            const home  = comp.competitors?.find(c => c.homeAway === "home");
            const away  = comp.competitors?.find(c => c.homeAway === "away");
            const status = comp.status?.type?.shortDetail || comp.status?.type?.name || "?";
            const state  = comp.status?.type?.state || "";
            const homeName  = home?.team?.shortDisplayName || home?.team?.displayName || "?";
            const awayName  = away?.team?.shortDisplayName || away?.team?.displayName || "?";
            const homeScore = home?.score ?? "";
            const awayScore = away?.score ?? "";

            let scoreStr;
            if (state === "in") {
              scoreStr = `🟢 *LIVE* ${homeName} *${homeScore}* - *${awayScore}* ${awayName}  _(${status})_`;
            } else if (state === "post") {
              scoreStr = `✅ *FT* ${homeName} *${homeScore}* - *${awayScore}* ${awayName}`;
            } else {
              scoreStr = `🕐 ${homeName} vs ${awayName}  _(${status})_`;
            }
            out += `${scoreStr}\n`;
          }
          out += `\n_Use *${prefix}epl table* for standings_`;
          await reply(sock, msg, out);
        } catch (e) {
          await reply(sock, msg, `❌ Could not fetch EPL data: ${e.message}`);
        }
        break;
      }

      case "wiki":
      case "wikipedia": {
        if (!text) { await reply(sock, msg, "📖 Usage: `.wiki Albert Einstein`"); break; }
        await reply(sock, msg, "📖 Searching Wikipedia...");
        try {
          const q = encodeURIComponent(text.trim());
          const r = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${q}`, { timeout: 10000 });
          const d = r.data;
          await reply(sock, msg,
            `📖 *${d.title}*\n\n${d.extract.slice(0, 900)}${d.extract.length > 900 ? "..." : ""}\n\n🔗 ${d.content_urls?.desktop?.page || ""}`
          );
        } catch { await reply(sock, msg, "❌ No Wikipedia article found. Try a more specific search."); }
        break;
      }

      case "define":
      case "dict": {
        if (!text) { await reply(sock, msg, "📚 Usage: `.define serendipity`"); break; }
        await reply(sock, msg, "📚 Looking up definition...");
        try {
          const word = text.trim().split(" ")[0];
          const r = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { timeout: 8000 });
          const entry = r.data[0];
          const meanings = entry.meanings.slice(0, 2).map(m => {
            const defs = m.definitions.slice(0, 2).map((d, i) => `  ${i + 1}. ${d.definition}`).join("\n");
            return `*${m.partOfSpeech}*\n${defs}`;
          }).join("\n\n");
          const phonetic = entry.phonetic || entry.phonetics?.[0]?.text || "";
          await reply(sock, msg, `📚 *${entry.word}* ${phonetic}\n\n${meanings}`);
        } catch { await reply(sock, msg, `❌ No definition found for "*${text}*".`); }
        break;
      }

      case "calc":
      case "calculate": {
        if (!text) { await reply(sock, msg, "🧮 Usage: `.calc 25 * 4 + 10` or `.calc 2^8`"); break; }
        try {
          const result = safeCalc(text);
          await reply(sock, msg, `🧮 *Calculator*\n\n📥 Input: \`${text}\`\n📤 Result: *${result}*`);
        } catch (e) {
          await reply(sock, msg, `❌ Math error: ${e.message}`);
        }
        break;
      }

      case "qr": {
        if (!text) { await reply(sock, msg, "📱 Usage: `.qr https://example.com` or `.qr Hello World`"); break; }
        await reply(sock, msg, "📱 Generating QR code...");
        try {
          const encoded = encodeURIComponent(text.trim());
          const r = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}`, { responseType: "arraybuffer", timeout: 10000 });
          await sock.sendMessage(from, { image: Buffer.from(r.data), caption: `📱 *QR Code*\n\n_Data: ${text.slice(0, 50)}_` }, { quoted: msg });
        } catch { await reply(sock, msg, "❌ Failed to generate QR code."); }
        break;
      }

      case "short":
      case "shorten": {
        if (!text || !text.startsWith("http")) { await reply(sock, msg, "🔗 Usage: `.short https://example.com/very/long/url`"); break; }
        await reply(sock, msg, "🔗 Shortening URL...");
        try {
          const r = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text.trim())}`, { timeout: 8000 });
          await reply(sock, msg, `🔗 *URL Shortened!*\n\n📎 Long: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}\n✂️ Short: *${r.data}*`);
        } catch { await reply(sock, msg, "❌ Failed to shorten URL."); }
        break;
      }

      // ── Text transformers ────────────────────────────────────────────────
      case "reverse": {
        if (!text) { await reply(sock, msg, "🔁 Usage: `.reverse Hello World`"); break; }
        await reply(sock, msg, `🔁 *Reversed:*\n\n${reverseText(text)}`);
        break;
      }
      case "mock": {
        if (!text) { await reply(sock, msg, "🧽 Usage: `.mock Hello World`"); break; }
        await reply(sock, msg, `🧽 ${mockText(text)}`);
        break;
      }
      case "aesthetic":
      case "ae": {
        if (!text) { await reply(sock, msg, "✨ Usage: `.aesthetic Hello World`"); break; }
        await reply(sock, msg, `✨ ${aestheticText(text)}`);
        break;
      }
      case "bold": {
        if (!text) { await reply(sock, msg, "𝗕 Usage: `.bold Hello World`"); break; }
        await reply(sock, msg, boldText(text));
        break;
      }
      case "italic": {
        if (!text) { await reply(sock, msg, "𝘐 Usage: `.italic Hello World`"); break; }
        await reply(sock, msg, italicText(text));
        break;
      }
      case "emojify":
      case "emoji": {
        if (!text) { await reply(sock, msg, "🔤 Usage: `.emojify Hello`"); break; }
        await reply(sock, msg, emojifyText(text));
        break;
      }
      case "upper": {
        if (!text) { await reply(sock, msg, "🔠 Usage: `.upper hello world`"); break; }
        await reply(sock, msg, text.toUpperCase());
        break;
      }
      case "lower": {
        if (!text) { await reply(sock, msg, "🔡 Usage: `.lower HELLO WORLD`"); break; }
        await reply(sock, msg, text.toLowerCase());
        break;
      }
      case "repeat": {
        const times = parseInt(args[0]) || 3;
        const repeatText = args.slice(1).join(" ");
        if (!repeatText) { await reply(sock, msg, "🔂 Usage: `.repeat 3 Hello!`"); break; }
        if (times > 20) { await reply(sock, msg, "❌ Max repeat is 20."); break; }
        await reply(sock, msg, Array(times).fill(repeatText).join("\n"));
        break;
      }

      // ── Profile / user info ──────────────────────────────────────────────
      case "pp":
      case "pfp":
      case "getpp": {
        const mentioned = getMentioned(msg);
        const targetJid = mentioned[0] || senderJid;
        const targetPhone = targetJid.split("@")[0];
        await reply(sock, msg, "🖼 Fetching profile picture...");
        const ppUrl = await getPpUrl(sock, targetJid);
        if (!ppUrl) { await reply(sock, msg, "❌ No profile picture found or it is private."); break; }
        try {
          const r = await axios.get(ppUrl, { responseType: "arraybuffer", timeout: 10000 });
          await sock.sendMessage(from, {
            image: Buffer.from(r.data),
            caption: `🖼 *Profile Picture*\n📞 +${targetPhone}`,
          }, { quoted: msg });
        } catch { await reply(sock, msg, "❌ Could not download the picture."); }
        break;
      }

      case "whois":
      case "profile": {
        if (!isGroup) { await reply(sock, msg, "👤 This command works in groups only."); break; }
        const mentionedW = getMentioned(msg);
        const targetW = mentionedW[0] || senderJid;
        const phoneW = targetW.split("@")[0];
        const ppUrlW = await getPpUrl(sock, targetW);
        const participants = await getParticipants(sock, from);
        const part = participants.find(p => p.id === targetW);
        const role = part?.admin === "superadmin" ? "👑 Super Admin" : part?.admin === "admin" ? "🛡 Admin" : "👤 Member";
        const card =
          `┌─────────────────────\n` +
          `│ 👤 *WHOIS CARD*\n` +
          `├─────────────────────\n` +
          `│ 📞 *Number:* +${phoneW}\n` +
          `│ 🏅 *Role:* ${role}\n` +
          `│ 🔗 *JID:* ${targetW}\n` +
          `└─────────────────────`;
        if (ppUrlW) {
          try {
            const r = await axios.get(ppUrlW, { responseType: "arraybuffer", timeout: 10000 });
            await sock.sendMessage(from, { image: Buffer.from(r.data), caption: card }, { quoted: msg });
          } catch { await reply(sock, msg, card); }
        } else {
          await reply(sock, msg, card);
        }
        break;
      }

      // ── Group management ─────────────────────────────────────────────────
      case "link":
      case "invitelink": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          const code = await sock.groupInviteCode(from);
          await reply(sock, msg, `🔗 *Group Invite Link*\n\nhttps://chat.whatsapp.com/${code}\n\n_Share responsibly!_`);
        } catch { await reply(sock, msg, "❌ Could not get invite link. Make sure I am an admin."); }
        break;
      }

      case "revoke":
      case "resetlink": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          const newCode = await sock.groupRevokeInvite(from);
          await reply(sock, msg, `🔄 *Invite link revoked!*\n\nNew link:\nhttps://chat.whatsapp.com/${newCode}`);
        } catch { await reply(sock, msg, "❌ Could not revoke invite link. Make sure I am an admin."); }
        break;
      }

      case "open": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          await sock.groupSettingUpdate(from, "not_announcement");
          await reply(sock, msg, "🔓 *Group is now OPEN!*\n\n_All members can send messages._");
        } catch { await reply(sock, msg, "❌ Failed. Make sure I am an admin."); }
        break;
      }

      case "close": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          await sock.groupSettingUpdate(from, "announcement");
          await reply(sock, msg, "🔒 *Group is now CLOSED!*\n\n_Only admins can send messages._");
        } catch { await reply(sock, msg, "❌ Failed. Make sure I am an admin."); }
        break;
      }

      case "setdesc":
      case "desc": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        if (!text) { await reply(sock, msg, `📝 Usage: \`${prefix}setdesc New description here\``); break; }
        try {
          await sock.groupUpdateDescription(from, text);
          await reply(sock, msg, `📝 *Group description updated!*\n\n_${text}_`);
        } catch { await reply(sock, msg, "❌ Failed to update description. Make sure I am an admin."); }
        break;
      }

      case "setname":
      case "rename": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        if (!text) { await reply(sock, msg, `✏️ Usage: \`${prefix}setname New Group Name\``); break; }
        try {
          await sock.groupUpdateSubject(from, text);
          await reply(sock, msg, `✏️ *Group name changed to:* _${text}_`);
        } catch { await reply(sock, msg, "❌ Failed to change group name."); }
        break;
      }

      case "seticon":
      case "setgrouppp": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const iconImg = msg.message?.imageMessage || getQuotedMsg(msg)?.imageMessage;
        if (!iconImg) { await reply(sock, msg, "🖼 Reply to an image to set it as the group icon."); break; }
        try {
          const targetIconMsg = msg.message?.imageMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
          const iconBuf = await getMediaBuffer(sock, targetIconMsg);
          if (!iconBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          await sock.updateProfilePicture(from, iconBuf);
          await reply(sock, msg, "🖼 *Group icon updated successfully!*");
        } catch { await reply(sock, msg, "❌ Failed to set group icon. Make sure I am an admin."); }
        break;
      }

      case "add": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const numToAdd = normalizePhone(text);
        if (!numToAdd || numToAdd.length < 7) { await reply(sock, msg, `➕ Usage: \`${prefix}add 2348012345678\` or \`${prefix}add 07XXXXXXXX\``); break; }
        const addJid = `${numToAdd}@s.whatsapp.net`;
        try {
          const res = await sock.groupParticipantsUpdate(from, [addJid], "add");
          const status = res?.[0]?.status;
          if (status === "200" || status === 200) {
            await reply(sock, msg, `✅ *+${numToAdd}* has been added to the group!`);
          } else {
            await reply(sock, msg, `⚠️ Could not add *+${numToAdd}*. They may have privacy settings that prevent adding to groups.`);
          }
        } catch { await reply(sock, msg, "❌ Failed to add member."); }
        break;
      }

      case "admins": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        const allParts = await getParticipants(sock, from);
        const groupAdmins = allParts.filter(p => p.admin);
        if (!groupAdmins.length) { await reply(sock, msg, "No admins found."); break; }
        const adminList = groupAdmins.map((p, i) => `${i + 1}. @${p.id.split("@")[0]}`).join("\n");
        await sock.sendMessage(from, {
          text: `👑 *Group Admins* (${groupAdmins.length})\n\n${adminList}`,
          mentions: groupAdmins.map(p => p.id),
        }, { quoted: msg });
        break;
      }

      case "members":
      case "count": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const total = meta.participants.length;
          const numAdmins = meta.participants.filter(p => p.admin).length;
          const numMembers = total - numAdmins;
          await reply(sock, msg,
            `👥 *Group Members*\n\n` +
            `📊 *Total:* ${total}\n` +
            `👑 *Admins:* ${numAdmins}\n` +
            `👤 *Members:* ${numMembers}\n\n` +
            `_${meta.subject}_`
          );
        } catch { await reply(sock, msg, "❌ Could not fetch member info."); }
        break;
      }

      case "everyone":
      case "all": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const everyoneParts = await getParticipants(sock, from);
        const everyoneJids = everyoneParts.map(p => p.id);
        const everyoneMsg = text || "📢 Attention everyone!";
        const tagLines = everyoneParts.map(p => `@${p.id.split("@")[0]}`).join(" ");
        await sock.sendMessage(from, {
          text: `${everyoneMsg}\n\n${tagLines}`,
          mentions: everyoneJids,
        }, { quoted: msg });
        break;
      }

      case "hidetag":
      case "htag":
      case "stag": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const hideParts = await getParticipants(sock, from);
        const hideJids = hideParts.map(p => p.id);
        await sock.sendMessage(from, {
          text: text || "📢",
          mentions: hideJids,
        }, { quoted: msg });
        break;
      }

      case "poll": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        const pollParts = text.split("|").map(s => s.trim()).filter(Boolean);
        if (pollParts.length < 3) {
          await reply(sock, msg, `📊 Usage: \`${prefix}poll Question | Option 1 | Option 2 | Option 3\`\n\nExample:\n\`${prefix}poll Best color? | Red | Blue | Green\``);
          break;
        }
        const pollQ = pollParts[0];
        const pollOpts = pollParts.slice(1, 13);
        try {
          await sock.sendMessage(from, {
            poll: { name: pollQ, values: pollOpts, selectableCount: 1 },
          }, { quoted: msg });
        } catch { await reply(sock, msg, "❌ Could not create poll."); }
        break;
      }

      case "del":
      case "delete": {
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const quotedDel = msg.message?.extendedTextMessage?.contextInfo;
        if (!quotedDel?.stanzaId) { await reply(sock, msg, `🗑 Reply to a message with \`${prefix}del\` to delete it.`); break; }
        try {
          await sock.sendMessage(from, {
            delete: {
              remoteJid: from,
              id: quotedDel.stanzaId,
              participant: quotedDel.participant || undefined,
              fromMe: false,
            },
          });
        } catch { await reply(sock, msg, "❌ Could not delete message. Make sure I am an admin."); }
        break;
      }

      case "grouplink":
      case "glink": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        try {
          const code = await sock.groupInviteCode(from);
          const meta = await sock.groupMetadata(from);
          await sock.sendMessage(senderJid, {
            text: `🔗 *${meta.subject}*\n\nhttps://chat.whatsapp.com/${code}`,
          });
          await reply(sock, msg, "✅ Group link sent to your DM!");
        } catch { await reply(sock, msg, "❌ Failed. Make sure I am an admin."); }
        break;
      }

      // ── Perez AI Commands ──────────────────────────────────────────────
      case "gpt": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}gpt [question]*`); break; }
        await reply(sock, msg, "🤖 Thinking...");
        const gptReply = await perez.gptChat(text, "llama");
        await reply(sock, msg, gptReply);
        break;
      }

      case "gpt2": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}gpt2 [question]*`); break; }
        await reply(sock, msg, "🤖 Thinking...");
        const gpt2Reply = await perez.gptChat(text, "jeeves");
        await reply(sock, msg, gpt2Reply);
        break;
      }

      case "gpt3": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}gpt3 [question]*`); break; }
        await reply(sock, msg, "🤖 Thinking...");
        const gpt3Reply = await perez.gptChat(text, "blackbox");
        await reply(sock, msg, gpt3Reply);
        break;
      }

      case "darkgpt": {
        if (!text) { await reply(sock, msg, `😈 Usage: *${prefix}darkgpt [question]*`); break; }
        await reply(sock, msg, "😈 DarkGPT processing...");
        const darkReply = await perez.darkGpt(text);
        await reply(sock, msg, darkReply);
        break;
      }

      // ── Perez Downloader Commands ───────────────────────────────────────
      case "tiktok":
      case "tikdl": {
        const tikUrl = args.find(a => a.startsWith("http"));
        if (!tikUrl) { await reply(sock, msg, `📥 Usage: *${prefix}tiktok [url]*`); break; }
        await reply(sock, msg, "📥 Downloading TikTok video...");
        try {
          const tikResult = await perez.downloadTikTok(tikUrl);
          await sock.sendMessage(from, {
            video: tikResult.buffer,
            caption: tikResult.caption,
            mimetype: "video/mp4",
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ TikTok download failed: ${e.message}`);
        }
        break;
      }

      case "twitter":
      case "twtdl": {
        const twtUrl = args.find(a => a.startsWith("http"));
        if (!twtUrl) { await reply(sock, msg, `📥 Usage: *${prefix}twitter [url]*`); break; }
        await reply(sock, msg, "📥 Downloading Twitter video...");
        try {
          const twtResult = await perez.downloadTwitter(twtUrl);
          const twtBuf = await axios.get(twtResult.videoUrl, { responseType: "arraybuffer", timeout: 60000 });
          await sock.sendMessage(from, {
            video: Buffer.from(twtBuf.data),
            caption: "🐦 *Twitter Video*\n_Powered by NEXUS-MD ⚡_",
            mimetype: "video/mp4",
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Twitter download failed: ${e.message}`);
        }
        break;
      }

      case "instagram":
      case "igdl": {
        const igUrl = args.find(a => a.startsWith("http"));
        if (!igUrl) { await reply(sock, msg, `📥 Usage: *${prefix}instagram [url]*`); break; }
        await reply(sock, msg, "📥 Downloading Instagram media...");
        try {
          const igUrls = await perez.downloadInstagram(igUrl);
          let igSent = 0, igFailed = 0;
          for (const mediaUrl of igUrls.slice(0, 5)) {
            try {
              const igBuf = await axios.get(mediaUrl, { responseType: "arraybuffer", timeout: 60000 });
              const contentType = igBuf.headers["content-type"] || "";
              if (contentType.includes("video")) {
                await sock.sendMessage(from, { video: Buffer.from(igBuf.data), mimetype: "video/mp4" }, { quoted: msg });
              } else {
                await sock.sendMessage(from, { image: Buffer.from(igBuf.data) }, { quoted: msg });
              }
              igSent++;
            } catch { igFailed++; }
          }
          if (igSent === 0) { await reply(sock, msg, "❌ Could not download any media from that post."); }
          else if (igFailed > 0) { await reply(sock, msg, `📥 Sent ${igSent} media, ${igFailed} failed.`); }
        } catch (e) {
          await reply(sock, msg, `❌ Instagram download failed: ${e.message}`);
        }
        break;
      }

      case "ytmp3":
      case "yta": {
        const ytaUrl = args.find(a => a.startsWith("http"));
        if (!ytaUrl) { await reply(sock, msg, `🎵 Usage: *${prefix}ytmp3 [youtube url]*`); break; }
        await reply(sock, msg, "🎵 Downloading audio...");
        try {
          const ytaResult = await perez.ytAudioApi(ytaUrl);
          const ytaBuf = await axios.get(ytaResult.audioUrl, { responseType: "arraybuffer", timeout: 60000 });
          await sock.sendMessage(from, {
            audio: Buffer.from(ytaBuf.data), mimetype: "audio/mpeg", ptt: false,
          }, { quoted: msg });
          await reply(sock, msg, `🎵 *${ytaResult.title}*\n_Powered by NEXUS-MD ⚡_`);
        } catch (e) {
          await reply(sock, msg, `❌ Audio download failed: ${e.message}`);
        }
        break;
      }

      case "ytmp4":
      case "ytv": {
        const ytvUrl = args.find(a => a.startsWith("http"));
        if (!ytvUrl) { await reply(sock, msg, `🎬 Usage: *${prefix}ytmp4 [youtube url]*`); break; }
        await reply(sock, msg, "🎬 Downloading video...");
        try {
          const ytvResult = await perez.ytVideoApi(ytvUrl);
          const ytvBuf = await axios.get(ytvResult.videoUrl, { responseType: "arraybuffer", timeout: 60000 });
          await sock.sendMessage(from, {
            video: Buffer.from(ytvBuf.data),
            caption: `🎬 *${ytvResult.title}*\n_Powered by NEXUS-MD ⚡_`,
            mimetype: "video/mp4",
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Video download failed: ${e.message}`);
        }
        break;
      }

      case "song2":
      case "play2": {
        if (!text) { await reply(sock, msg, `🎵 Usage: *${prefix}song2 [song name]*`); break; }
        await reply(sock, msg, `🔍 Searching for *${text}*...`);
        try {
          const ytResults = await perez.searchYouTube(text);
          if (!ytResults.length) { await reply(sock, msg, "❌ No results found."); break; }
          const top = ytResults[0];
          await reply(sock, msg, `🎵 *Found:* ${top.title}\n⬇️ Downloading via API...`);
          const s2Result = await perez.ytAudioApi(top.url);
          const s2Buf = await axios.get(s2Result.audioUrl, { responseType: "arraybuffer", timeout: 60000 });
          await sock.sendMessage(from, {
            audio: Buffer.from(s2Buf.data), mimetype: "audio/mpeg", ptt: false,
          }, { quoted: msg });
          await reply(sock, msg, `🎵 *${top.title}*\n_Powered by NEXUS-MD ⚡_`);
        } catch (e) {
          await reply(sock, msg, `❌ Could not play song: ${e.message}`);
        }
        break;
      }

      case "video": {
        if (!text) { await reply(sock, msg, `🎬 Usage: *${prefix}video [search query]*`); break; }
        await reply(sock, msg, `🔍 Searching for *${text}*...`);
        try {
          const vidResults = await perez.searchYouTube(text);
          if (!vidResults.length) { await reply(sock, msg, "❌ No results found."); break; }
          const top = vidResults[0];
          await reply(sock, msg, `🎬 *Found:* ${top.title}\n⬇️ Downloading video...`);
          const vidResult = await perez.ytVideoApi(top.url);
          const vidBuf = await axios.get(vidResult.videoUrl, { responseType: "arraybuffer", timeout: 60000 });
          await sock.sendMessage(from, {
            video: Buffer.from(vidBuf.data),
            caption: `🎬 *${top.title}*\n_Powered by NEXUS-MD ⚡_`,
            mimetype: "video/mp4",
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Video download failed: ${e.message}`);
        }
        break;
      }

      case "lyrics": {
        if (!text) { await reply(sock, msg, `🎤 Usage: *${prefix}lyrics [song name]*`); break; }
        await reply(sock, msg, "🎤 Searching lyrics...");
        try {
          const lyrResult = await perez.getLyrics(text);
          if (!lyrResult) { await reply(sock, msg, "❌ Lyrics not found."); break; }
          const lyrText = `🎤 *${lyrResult.title || text}*\n👤 ${lyrResult.artist || "Unknown"}\n\n${lyrResult.lyrics.slice(0, 3000)}`;
          await reply(sock, msg, lyrText);
        } catch (e) {
          await reply(sock, msg, `❌ Could not fetch lyrics: ${e.message}`);
        }
        break;
      }

      case "yts": {
        if (!text) { await reply(sock, msg, `🔍 Usage: *${prefix}yts [search query]*`); break; }
        await reply(sock, msg, `🔍 Searching YouTube for *${text}*...`);
        try {
          const ytsResults = await perez.searchYouTube(text);
          if (!ytsResults.length) { await reply(sock, msg, "❌ No results found."); break; }
          let ytsTxt = `🔍 *YouTube Search Results*\n\n`;
          ytsResults.slice(0, 10).forEach((r, i) => {
            ytsTxt += `${i + 1}. *${r.title}*\n   👤 ${r.author?.name || "Unknown"} | ⏱ ${r.timestamp || "?"}\n   🔗 ${r.url}\n\n`;
          });
          ytsTxt += `_Use *${prefix}ytmp3 [url]* or *${prefix}ytmp4 [url]* to download_`;
          await reply(sock, msg, ytsTxt);
        } catch (e) {
          await reply(sock, msg, `❌ Search failed: ${e.message}`);
        }
        break;
      }

      // ── Sports Commands ─────────────────────────────────────────────────
      case "laliga": {
        await reply(sock, msg, "⚽ Fetching La Liga standings...");
        const laResult = await sports.getStandings("laliga");
        await reply(sock, msg, laResult.error || laResult.text);
        break;
      }

      case "bundesliga": {
        await reply(sock, msg, "⚽ Fetching Bundesliga standings...");
        const buResult = await sports.getStandings("bundesliga");
        await reply(sock, msg, buResult.error || buResult.text);
        break;
      }

      case "seriea": {
        await reply(sock, msg, "⚽ Fetching Serie A standings...");
        const saResult = await sports.getStandings("seriea");
        await reply(sock, msg, saResult.error || saResult.text);
        break;
      }

      case "ligue1": {
        await reply(sock, msg, "⚽ Fetching Ligue 1 standings...");
        const l1Result = await sports.getStandings("ligue1");
        await reply(sock, msg, l1Result.error || l1Result.text);
        break;
      }

      case "fixtures":
      case "matches": {
        await reply(sock, msg, "⚽ Fetching today's fixtures...");
        const fixMsg = await sports.getFixtures();
        await reply(sock, msg, fixMsg);
        break;
      }

      // ── Text Art Commands ───────────────────────────────────────────────
      case "textart": {
        const styleList = textart.getStyleList();
        await reply(sock, msg,
          `🎨 *Text Art Styles*\n\n${styleList}\n\n_Usage: *${prefix}[style] [your text]*_\nExample: *${prefix}metallic Hello*`
        );
        break;
      }

      case "metallic": case "ice": case "snow": case "impressive":
      case "noel": case "water": case "matrix": case "light":
      case "neon": case "silver": case "devil": case "typography":
      case "purple": case "thunder": case "leaves": case "1917":
      case "arena": case "hacker": case "sand": case "dragonball":
      case "naruto": case "graffiti": case "cat": case "gold":
      case "child": {
        if (!text) { await reply(sock, msg, `🎨 Usage: *${prefix}${cmd} [your text]*`); break; }
        await reply(sock, msg, `🎨 Generating *${cmd}* text art...`);
        try {
          const artResult = await textart.generateTextArt(cmd, text);
          if (artResult.error) { await reply(sock, msg, `❌ ${artResult.error}`); break; }
          const artBuf = await axios.get(artResult.imageUrl, { responseType: "arraybuffer", timeout: 30000 });
          await sock.sendMessage(from, {
            image: Buffer.from(artBuf.data),
            caption: `🎨 *${artResult.style}* — _${text}_\n_Powered by NEXUS-MD ⚡_`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Text art failed: ${e.message}`);
        }
        break;
      }

      // ── Misc Perez Commands ─────────────────────────────────────────────
      case "carbon": {
        const codeText = text || getQuotedMsg(msg)?.conversation || getQuotedMsg(msg)?.extendedTextMessage?.text;
        if (!codeText) { await reply(sock, msg, `💻 Usage: *${prefix}carbon [code]* or reply to a message`); break; }
        await reply(sock, msg, "💻 Generating carbon image...");
        try {
          const carbonBuf = await perez.carbonCode(codeText);
          await sock.sendMessage(from, {
            image: carbonBuf,
            caption: "💻 *Carbon Code*\n_Powered by NEXUS-MD ⚡_",
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Carbon failed: ${e.message}`);
        }
        break;
      }

      case "screenshot":
      case "ss": {
        if (!text || !text.startsWith("http")) { await reply(sock, msg, `📸 Usage: *${prefix}ss [url]*\nExample: *${prefix}ss https://google.com*`); break; }
        await reply(sock, msg, "📸 Taking screenshot...");
        try {
          const ssUrl = await perez.screenshot(text.trim());
          const ssBuf = await axios.get(ssUrl, { responseType: "arraybuffer", timeout: 30000 });
          await sock.sendMessage(from, {
            image: Buffer.from(ssBuf.data),
            caption: `📸 *Screenshot*\n🔗 ${text.trim().slice(0, 50)}`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Screenshot failed: ${e.message}`);
        }
        break;
      }

      case "anime": {
        await reply(sock, msg, "🎌 Fetching random anime...");
        try {
          const animeData = await perez.getAnime();
          let animeTxt = `🎌 *${animeData.title}*\n\n`;
          if (animeData.episodes) animeTxt += `📺 Episodes: ${animeData.episodes}\n`;
          if (animeData.status) animeTxt += `📡 Status: ${animeData.status}\n`;
          if (animeData.synopsis) animeTxt += `\n📝 ${animeData.synopsis.slice(0, 500)}`;
          if (animeData.url) animeTxt += `\n\n🔗 ${animeData.url}`;
          if (animeData.imageUrl) {
            const animeBuf = await axios.get(animeData.imageUrl, { responseType: "arraybuffer", timeout: 15000 });
            await sock.sendMessage(from, { image: Buffer.from(animeBuf.data), caption: animeTxt }, { quoted: msg });
          } else {
            await reply(sock, msg, animeTxt);
          }
        } catch (e) {
          await reply(sock, msg, `❌ Could not fetch anime: ${e.message}`);
        }
        break;
      }

      case "movie": {
        if (!text) { await reply(sock, msg, `🎬 Usage: *${prefix}movie [name]*`); break; }
        await reply(sock, msg, "🎬 Searching movie...");
        try {
          const movieData = await perez.getMovie(text);
          if (!movieData) { await reply(sock, msg, "❌ Movie not found."); break; }
          let movieTxt = `🎬 *${movieData.Title}* (${movieData.Year})\n\n`;
          movieTxt += `⭐ IMDB: ${movieData.imdbRating}/10\n`;
          movieTxt += `🎭 Genre: ${movieData.Genre}\n`;
          movieTxt += `🎬 Director: ${movieData.Director}\n`;
          movieTxt += `⏱ Runtime: ${movieData.Runtime}\n`;
          movieTxt += `\n📝 ${movieData.Plot?.slice(0, 500) || "No plot available"}`;
          if (movieData.Poster && movieData.Poster !== "N/A") {
            const posterBuf = await axios.get(movieData.Poster, { responseType: "arraybuffer", timeout: 15000 });
            await sock.sendMessage(from, { image: Buffer.from(posterBuf.data), caption: movieTxt }, { quoted: msg });
          } else {
            await reply(sock, msg, movieTxt);
          }
        } catch (e) {
          await reply(sock, msg, `❌ Could not fetch movie: ${e.message}`);
        }
        break;
      }

      case "github": {
        if (!text) { await reply(sock, msg, `🐙 Usage: *${prefix}github [username]*`); break; }
        await reply(sock, msg, "🐙 Fetching GitHub profile...");
        try {
          const ghData = await perez.getGithubUser(text.trim());
          let ghTxt = `🐙 *${ghData.login}*\n\n`;
          if (ghData.name) ghTxt += `👤 Name: ${ghData.name}\n`;
          if (ghData.bio) ghTxt += `📝 Bio: ${ghData.bio}\n`;
          ghTxt += `📦 Repos: ${ghData.public_repos}\n`;
          ghTxt += `👥 Followers: ${ghData.followers} | Following: ${ghData.following}\n`;
          if (ghData.location) ghTxt += `📍 Location: ${ghData.location}\n`;
          ghTxt += `\n🔗 ${ghData.html_url}`;
          if (ghData.avatar_url) {
            const ghBuf = await axios.get(ghData.avatar_url, { responseType: "arraybuffer", timeout: 15000 });
            await sock.sendMessage(from, { image: Buffer.from(ghBuf.data), caption: ghTxt }, { quoted: msg });
          } else {
            await reply(sock, msg, ghTxt);
          }
        } catch (e) {
          await reply(sock, msg, `❌ GitHub user not found: ${e.message}`);
        }
        break;
      }

      case "pickupline": {
        try {
          const line = await perez.getPickupLine();
          await reply(sock, msg, `😏 *Pickup Line*\n\n${line}`);
        } catch {
          await reply(sock, msg, "😏 Are you a magician? Because every time I look at you, everyone else disappears!");
        }
        break;
      }

      case "catfact": {
        try {
          const cfact = await perez.getCatFact();
          await reply(sock, msg, `🐱 *Cat Fact*\n\n${cfact}`);
        } catch {
          await reply(sock, msg, "🐱 Cats sleep for about 70% of their lives.");
        }
        break;
      }

      case "advise": {
        try {
          const advData = await axios.get("https://api.adviceslip.com/advice", { timeout: 8000 });
          await reply(sock, msg, `💡 *Advice*\n\n${advData.data.slip.advice}`);
        } catch {
          await reply(sock, msg, "💡 Always be kind to others.");
        }
        break;
      }

      case "hack": {
        const hackTarget = getMentioned(msg)[0] || getQuotedJid(msg);
        const hackName = hackTarget ? `@${hackTarget.split("@")[0]}` : (text || "target");
        const hackMentions = hackTarget ? [hackTarget] : [];
        const hackSteps = [
          `🔓 Initializing hack on ${hackName}...`,
          `📡 Connecting to WhatsApp servers...`,
          `🔍 Retrieving account data...`,
          `📱 Accessing device information...`,
          `💾 Downloading media files...`,
          `🔐 Decrypting messages...`,
          `📤 Uploading data to cloud...`,
          `✅ Hack complete!\n\n_Just kidding! 😂 This is a prank command._`,
        ];
        for (const step of hackSteps) {
          await sock.sendMessage(from, { text: step, mentions: hackMentions }, { quoted: msg });
          await new Promise(r => setTimeout(r, 1500));
        }
        break;
      }

      case "apk":
      case "app": {
        if (!text) { await reply(sock, msg, `📦 Usage: *${prefix}apk [app name]*`); break; }
        await reply(sock, msg, `📦 Searching for *${text}*...`);
        try {
          const apkData = await perez.getApk(text);
          if (!apkData?.dllink) { await reply(sock, msg, "❌ App not found or download unavailable."); break; }
          let apkTxt = `📦 *${apkData.name || text}*\n\n`;
          if (apkData.package) apkTxt += `📋 Package: ${apkData.package}\n`;
          if (apkData.lastup) apkTxt += `📅 Updated: ${apkData.lastup}\n`;
          if (apkData.size) apkTxt += `💾 Size: ${apkData.size}\n`;
          apkTxt += `\n⬇️ Downloading...`;
          await reply(sock, msg, apkTxt);
          const apkBuf = await axios.get(apkData.dllink, { responseType: "arraybuffer", timeout: 120000 });
          await sock.sendMessage(from, {
            document: Buffer.from(apkBuf.data),
            mimetype: "application/vnd.android.package-archive",
            fileName: `${apkData.name || text}.apk`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ APK download failed: ${e.message}`);
        }
        break;
      }

      case "news": {
        await reply(sock, msg, "📰 Fetching latest news...");
        try {
          const newsData = await axios.get("https://api.dreaded.site/api/news", { timeout: 15000 });
          if (!newsData.data?.articles?.length) { await reply(sock, msg, "❌ No news available."); break; }
          let newsTxt = "📰 *Latest News*\n\n";
          newsData.data.articles.slice(0, 5).forEach((a, i) => {
            newsTxt += `${i + 1}. *${a.title}*\n${a.description?.slice(0, 100) || ""}\n🔗 ${a.url || ""}\n\n`;
          });
          await reply(sock, msg, newsTxt);
        } catch {
          try {
            const hnData = await axios.get("https://hacker-news.firebaseio.com/v0/topstories.json?limitToFirst=5&orderBy=%22$key%22", { timeout: 10000 });
            let hnTxt = "📰 *Top Tech News*\n\n";
            for (const id of hnData.data.slice(0, 5)) {
              const item = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 5000 });
              hnTxt += `• *${item.data.title}*\n  🔗 ${item.data.url || ""}\n\n`;
            }
            await reply(sock, msg, hnTxt);
          } catch {
            await reply(sock, msg, "❌ Could not fetch news.");
          }
        }
        break;
      }

      case "tweet": {
        if (!text) { await reply(sock, msg, `🐦 Usage: *${prefix}tweet [text]*`); break; }
        try {
          const tweetParts = text.split("|").map(s => s.trim());
          const username = tweetParts[1] || msg.pushName || senderPhone;
          const tweetText = tweetParts[0];
          const tweetUrl = `https://some-random-api.com/canvas/misc/tweet?avatar=https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&username=${encodeURIComponent(username)}&displayname=${encodeURIComponent(username)}&comment=${encodeURIComponent(tweetText)}`;
          const tweetBuf = await axios.get(tweetUrl, { responseType: "arraybuffer", timeout: 15000 });
          await sock.sendMessage(from, {
            image: Buffer.from(tweetBuf.data),
            caption: `🐦 *Fake Tweet*\n_Powered by NEXUS-MD ⚡_`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Tweet generation failed: ${e.message}`);
        }
        break;
      }

      case "pin": {
        if (!text) { await reply(sock, msg, `📌 Usage: *${prefix}pin [search query]*`); break; }
        await reply(sock, msg, "📌 Searching Pinterest...");
        try {
          const pinData = await axios.get(`https://api.dreaded.site/api/pinterest?query=${encodeURIComponent(text)}`, { timeout: 15000 });
          const pinResults = pinData.data?.data || pinData.data?.result;
          if (!pinResults?.length) { await reply(sock, msg, "❌ No results found."); break; }
          const pinImg = pinResults[Math.floor(Math.random() * Math.min(pinResults.length, 10))];
          const pinImgUrl = typeof pinImg === "string" ? pinImg : pinImg?.url || pinImg?.images_url;
          if (!pinImgUrl) { await reply(sock, msg, "❌ No images found."); break; }
          const pinBuf = await axios.get(pinImgUrl, { responseType: "arraybuffer", timeout: 15000 });
          await sock.sendMessage(from, {
            image: Buffer.from(pinBuf.data),
            caption: `📌 *Pinterest* — _${text}_`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Pinterest search failed: ${e.message}`);
        }
        break;
      }

      // ── Owner/Super Admin Commands ──────────────────────────────────────
      case "block": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const blockTarget = getMentioned(msg)[0] || getQuotedJid(msg) || (text ? `${normalizePhone(text)}@s.whatsapp.net` : null);
        if (!blockTarget) { await reply(sock, msg, `Usage: *${prefix}block @user* or *${prefix}block 254XXXXXXX*`); break; }
        try {
          await sock.updateBlockStatus(blockTarget, "block");
          await reply(sock, msg, `🚫 *+${blockTarget.split("@")[0]}* has been blocked.`);
        } catch (e) {
          await reply(sock, msg, `❌ Block failed: ${e.message}`);
        }
        break;
      }

      case "unblock": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const unblockTarget = getMentioned(msg)[0] || getQuotedJid(msg) || (text ? `${normalizePhone(text)}@s.whatsapp.net` : null);
        if (!unblockTarget) { await reply(sock, msg, `Usage: *${prefix}unblock @user*`); break; }
        try {
          await sock.updateBlockStatus(unblockTarget, "unblock");
          await reply(sock, msg, `✅ *+${unblockTarget.split("@")[0]}* has been unblocked.`);
        } catch (e) {
          await reply(sock, msg, `❌ Unblock failed: ${e.message}`);
        }
        break;
      }

      case "join": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}join [invite link]*`); break; }
        const inviteMatch = text.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
        if (!inviteMatch) { await reply(sock, msg, "❌ Invalid invite link."); break; }
        try {
          await sock.groupAcceptInvite(inviteMatch[1]);
          await reply(sock, msg, "✅ Successfully joined the group!");
        } catch (e) {
          await reply(sock, msg, `❌ Join failed: ${e.message}`);
        }
        break;
      }

      case "restart": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        await reply(sock, msg, "🔄 Restarting bot...");
        setTimeout(() => process.exit(0), 1500);
        break;
      }

      case "save": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const quotedSave = getQuotedMsg(msg);
        if (!quotedSave) { await reply(sock, msg, `💾 Reply to any message with *${prefix}save* to forward it to your DM.`); break; }
        try {
          const saveType = Object.keys(quotedSave)[0];
          if (saveType === "conversation" || saveType === "extendedTextMessage") {
            const saveText = quotedSave.conversation || quotedSave.extendedTextMessage?.text || "";
            await sock.sendMessage(senderJid, { text: `💾 *Saved Message:*\n\n${saveText}` });
          } else {
            const saveBuf = await getMediaBuffer(sock, { key: msg.key, message: quotedSave });
            if (saveBuf) {
              if (saveType === "imageMessage") {
                await sock.sendMessage(senderJid, { image: saveBuf, caption: "💾 *Saved Image*" });
              } else if (saveType === "videoMessage") {
                await sock.sendMessage(senderJid, { video: saveBuf, caption: "💾 *Saved Video*", mimetype: "video/mp4" });
              } else if (saveType === "audioMessage") {
                await sock.sendMessage(senderJid, { audio: saveBuf, mimetype: "audio/mpeg" });
              } else if (saveType === "documentMessage") {
                await sock.sendMessage(senderJid, { document: saveBuf, mimetype: quotedSave.documentMessage?.mimetype || "application/octet-stream", fileName: quotedSave.documentMessage?.fileName || "saved_file" });
              } else if (saveType === "stickerMessage") {
                await sock.sendMessage(senderJid, { sticker: saveBuf });
              }
            }
          }
          await reply(sock, msg, "✅ Saved to your DM!");
        } catch (e) {
          await reply(sock, msg, `❌ Save failed: ${e.message}`);
        }
        break;
      }

      case "broadcastgroups":
      case "cast": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}cast [message]*`); break; }
        try {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);
          await reply(sock, msg, `📢 Broadcasting to ${groupIds.length} groups...`);
          let castSent = 0, castFail = 0;
          for (const gid of groupIds) {
            try {
              await sock.sendMessage(gid, { text: `📢 *Broadcast*\n\n${text}\n\n_Sent by ${botName}_ ⚡` });
              castSent++;
            } catch { castFail++; }
          }
          await reply(sock, msg, `✅ Broadcast complete!\n📤 Sent: ${castSent} | ❌ Failed: ${castFail}`);
        } catch (e) {
          await reply(sock, msg, `❌ Broadcast failed: ${e.message}`);
        }
        break;
      }

      case "botpp": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const ppImg = msg.message?.imageMessage || getQuotedMsg(msg)?.imageMessage;
        if (!ppImg) { await reply(sock, msg, `🖼 Reply to an image with *${prefix}botpp* to set it as the bot's profile picture.`); break; }
        try {
          const ppTarget = msg.message?.imageMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
          const ppBuf = await getMediaBuffer(sock, ppTarget);
          if (!ppBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          await sock.updateProfilePicture(sock.user.id, ppBuf);
          await reply(sock, msg, "✅ Bot profile picture updated!");
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "kickall": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
          const toKick = meta.participants.filter(p => !p.admin && p.id !== botId && p.id !== senderJid);
          if (!toKick.length) { await reply(sock, msg, "No non-admin members to kick."); break; }
          await reply(sock, msg, `🗑 Kicking ${toKick.length} members...`);
          for (const member of toKick) {
            try { await sock.groupParticipantsUpdate(from, [member.id], "remove"); } catch {}
          }
          await reply(sock, msg, `✅ Kicked ${toKick.length} members.`);
        } catch (e) {
          await reply(sock, msg, `❌ Kickall failed: ${e.message}`);
        }
        break;
      }

      case "promoteall": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const toPromote = meta.participants.filter(p => !p.admin);
          if (!toPromote.length) { await reply(sock, msg, "All members are already admins."); break; }
          for (const member of toPromote) {
            try { await sock.groupParticipantsUpdate(from, [member.id], "promote"); } catch {}
          }
          await reply(sock, msg, `⬆️ Promoted ${toPromote.length} members to admin.`);
        } catch (e) {
          await reply(sock, msg, `❌ Promote all failed: ${e.message}`);
        }
        break;
      }

      case "demoteall": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
          const toDemote = meta.participants.filter(p => p.admin && p.id !== botId && p.id !== senderJid);
          if (!toDemote.length) { await reply(sock, msg, "No other admins to demote."); break; }
          for (const member of toDemote) {
            try { await sock.groupParticipantsUpdate(from, [member.id], "demote"); } catch {}
          }
          await reply(sock, msg, `⬇️ Demoted ${toDemote.length} admins.`);
        } catch (e) {
          await reply(sock, msg, `❌ Demote all failed: ${e.message}`);
        }
        break;
      }

      case "leave": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        await reply(sock, msg, "👋 Goodbye! Leaving group...");
        try { await sock.groupLeave(from); } catch (e) { await reply(sock, msg, `❌ Failed: ${e.message}`); }
        break;
      }

      case "creategroup": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}creategroup [name]*`); break; }
        try {
          const newGroup = await sock.groupCreate(text.trim(), [senderJid]);
          await reply(sock, msg, `✅ Group *${text.trim()}* created!\n\nID: ${newGroup.id}`);
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "setgoodbye": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}setgoodbye [msg]*\nUse {{name}} for the person's name`); break; }
        groups.setGoodbyeMessage(from, text);
        await reply(sock, msg, "✅ Goodbye message updated!");
        break;
      }

      case "welcome": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        const curWelcome = groups.getWelcomeMessage(from);
        await reply(sock, msg, curWelcome
          ? `👋 *Current Welcome Message:*\n\n${curWelcome}`
          : `👋 No custom welcome message set.\n\nUse *${prefix}setwelcome [message]* to set one.`
        );
        break;
      }

      case "goodbye": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        const curGoodbye = groups.getGoodbyeMessage(from);
        await reply(sock, msg, curGoodbye
          ? `👋 *Current Goodbye Message:*\n\n${curGoodbye}`
          : `👋 No custom goodbye message set.\n\nUse *${prefix}setgoodbye [message]* to set one.`
        );
        break;
      }

      case "resetwarn": {
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const rwMentioned = getMentioned(msg);
        if (!rwMentioned.length) { await reply(sock, msg, `Usage: *${prefix}resetwarn @user*`); break; }
        security.clearWarnings(rwMentioned[0]);
        await reply(sock, msg, `✅ Warnings reset for @${rwMentioned[0].split("@")[0]}.`);
        break;
      }

      case "autoread": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const arVal = args[0]?.toLowerCase();
        if (arVal !== "on" && arVal !== "off") { await reply(sock, msg, `Usage: *${prefix}autoread on/off*`); break; }
        settings.set("autoReadMessages", arVal === "on");
        await reply(sock, msg, `📖 Auto-read ${arVal === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "gctime": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const creation = new Date(meta.creation * 1000);
          await reply(sock, msg,
            `⏰ *Group Created:*\n\n📅 ${creation.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}\n🕐 ${creation.toLocaleTimeString()}\n📛 ${meta.subject}`
          );
        } catch { await reply(sock, msg, "❌ Could not fetch group creation time."); }
        break;
      }

      // ── Group Join Request Commands ─────────────────────────────────────
      case "approve":
      case "approve-all": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          const pendingList = await sock.groupRequestParticipantsList(from);
          if (!pendingList.length) { await reply(sock, msg, "No pending join requests."); break; }
          let approved = 0;
          for (const participant of pendingList) {
            try {
              await sock.groupRequestParticipantsUpdate(from, [participant.jid], "approve");
              approved++;
            } catch {}
          }
          await reply(sock, msg, `✅ Approved ${approved} pending participant(s).`);
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "reject":
      case "reject-all": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          const pendingList = await sock.groupRequestParticipantsList(from);
          if (!pendingList.length) { await reply(sock, msg, "No pending join requests."); break; }
          let rejected = 0;
          for (const participant of pendingList) {
            try {
              await sock.groupRequestParticipantsUpdate(from, [participant.jid], "reject");
              rejected++;
            } catch {}
          }
          await reply(sock, msg, `❌ Rejected ${rejected} pending participant(s).`);
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "gcprofile": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        try {
          const ppUrl = await getPpUrl(sock, from);
          if (!ppUrl) { await reply(sock, msg, "❌ No group profile picture set."); break; }
          const ppBuf = await axios.get(ppUrl, { responseType: "arraybuffer", timeout: 10000 });
          const meta = await sock.groupMetadata(from);
          await sock.sendMessage(from, {
            image: Buffer.from(ppBuf.data),
            caption: `🖼 *Group Profile Picture*\n📛 ${meta.subject}`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Could not fetch group profile: ${e.message}`);
        }
        break;
      }

      // ── AI Image Analysis Commands ──────────────────────────────────────
      case "ai2":
      case "ai3": {
        const aiQuoted = getQuotedMsg(msg);
        const aiImgMsg = aiQuoted?.imageMessage;
        if (!aiImgMsg || !text) {
          await reply(sock, msg, `🤖 *AI Image Analysis*\n\nQuote an image with instructions.\nUsage: Reply to an image with *${prefix}${cmd} [instruction]*\nExample: *${prefix}${cmd} describe this image*`);
          break;
        }
        await reply(sock, msg, "🤖 Analyzing image...");
        try {
          const imgBuf = await getMediaBuffer(sock, { key: msg.key, message: aiQuoted });
          if (!imgBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          const FormData = require("form-data");
          const aiForm = new FormData();
          aiForm.append("reqtype", "fileupload");
          aiForm.append("time", "1h");
          aiForm.append("fileToUpload", imgBuf, { filename: "image.jpg", contentType: "image/jpeg" });
          const uploadResp = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", aiForm,
            { timeout: 30000, headers: aiForm.getHeaders() }
          ).catch(() => null);
          let imgUrl = uploadResp?.data;
          if (!imgUrl || typeof imgUrl !== "string" || !imgUrl.startsWith("http")) {
            await reply(sock, msg, "❌ Could not upload image for analysis. Please try again.");
            break;
          }
          const visionResp = await perez.fetchJson(`https://api.dreaded.site/api/gemini-vision?url=${encodeURIComponent(imgUrl)}&instruction=${encodeURIComponent(text)}`);
          if (visionResp?.result) {
            await reply(sock, msg, visionResp.result);
          } else {
            const bk9Alt = await perez.fetchJson(`https://bk9.fun/ai/geminiimg?url=${encodeURIComponent(imgUrl)}&q=${encodeURIComponent(text)}`);
            await reply(sock, msg, bk9Alt?.BK9 || "❌ Could not analyze image.");
          }
        } catch (e) {
          await reply(sock, msg, `❌ Image analysis failed: ${e.message}`);
        }
        break;
      }

      case "dalle":
      case "createimage": {
        if (!text) { await reply(sock, msg, `🎨 Usage: *${prefix}dalle [prompt]*`); break; }
        await reply(sock, msg, "🎨 Generating AI image...");
        try {
          const dalleResp = await axios.get(`https://bk9.fun/ai/magicstudio?prompt=${encodeURIComponent(text)}`, { timeout: 60000 });
          if (dalleResp.data?.BK9) {
            const dalBuf = await axios.get(dalleResp.data.BK9, { responseType: "arraybuffer", timeout: 30000 });
            await sock.sendMessage(from, { image: Buffer.from(dalBuf.data), caption: `🎨 *AI Image*\n_${text.slice(0, 80)}_` }, { quoted: msg });
          } else {
            const imgResult = await ai.generateImage(text);
            if (imgResult.error) { await reply(sock, msg, imgResult.error); break; }
            const imgBuf = await axios.get(imgResult.url, { responseType: "arraybuffer", timeout: 30000 });
            await sock.sendMessage(from, { image: Buffer.from(imgBuf.data), caption: `🎨 *AI Image*\n_${text.slice(0, 80)}_` }, { quoted: msg });
          }
        } catch (e) {
          await reply(sock, msg, `❌ Image generation failed: ${e.message}`);
        }
        break;
      }

      case "remini": {
        const remQuoted = getQuotedMsg(msg);
        const remImg = remQuoted?.imageMessage;
        if (!remImg) { await reply(sock, msg, `🖼 Quote an image with *${prefix}remini* to enhance it.`); break; }
        await reply(sock, msg, "🖼 Enhancing image...");
        try {
          const remBuf = await getMediaBuffer(sock, { key: msg.key, message: remQuoted });
          if (!remBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          const FormData = require("form-data");
          const form = new FormData();
          form.append("image", remBuf, { filename: "image.jpg", contentType: "image/jpeg" });
          const remResp = await axios.post("https://inferenceengine.vyro.ai/enhance", form, {
            headers: { ...form.getHeaders() }, responseType: "arraybuffer", timeout: 60000,
          }).catch(() => null);
          if (remResp?.data) {
            await sock.sendMessage(from, { image: Buffer.from(remResp.data), caption: "🖼 *Enhanced Image*\n_Powered by NEXUS-MD ⚡_" }, { quoted: msg });
          } else {
            await reply(sock, msg, "❌ Image enhancement service unavailable.");
          }
        } catch (e) {
          await reply(sock, msg, `❌ Enhancement failed: ${e.message}`);
        }
        break;
      }

      // ── Sticker & Meme Commands ─────────────────────────────────────────
      case "quotely": {
        if (!text) { await reply(sock, msg, `💬 Usage: *${prefix}quotely [text]*`); break; }
        try {
          const avatar = "https://ui-avatars.com/api/?name=" + encodeURIComponent(msg.pushName || senderPhone);
          const quotelyUrl = `https://aemt.me/quotely?avatar=${encodeURIComponent(avatar)}&name=${encodeURIComponent(msg.pushName || senderPhone)}&text=${encodeURIComponent(text)}`;
          const qBuf = await axios.get(quotelyUrl, { responseType: "arraybuffer", timeout: 15000 });
          await sock.sendMessage(from, { sticker: Buffer.from(qBuf.data) }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Quotely failed: ${e.message}`);
        }
        break;
      }

      case "attp": {
        if (!text) { await reply(sock, msg, `✨ Usage: *${prefix}attp [text]*`); break; }
        try {
          const attApiKey = process.env.LOLHUMAN_API_KEY || "cde5404984da80591a2692b6";
          const attUrl = `https://api.lolhuman.xyz/api/attp?apikey=${attApiKey}&text=${encodeURIComponent(text)}`;
          const attBuf = await axios.get(attUrl, { responseType: "arraybuffer", timeout: 15000 });
          await sock.sendMessage(from, { sticker: Buffer.from(attBuf.data) }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ ATTP failed: ${e.message}`);
        }
        break;
      }

      case "smeme": {
        const smQuoted = getQuotedMsg(msg);
        const smImg = smQuoted?.imageMessage || msg.message?.imageMessage;
        if (!smImg || !text) {
          await reply(sock, msg, `😂 Usage: Reply to an image with *${prefix}smeme top text|bottom text*`);
          break;
        }
        try {
          const smBuf = await getMediaBuffer(sock, smImg === msg.message?.imageMessage ? msg : { key: msg.key, message: smQuoted });
          if (!smBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          const smParts = text.split("|").map(s => s.trim());
          const topText = encodeURIComponent(smParts[0] || "-");
          const botText = encodeURIComponent(smParts[1] || "-");
          const FormData = require("form-data");
          const form = new FormData();
          form.append("image", smBuf, { filename: "meme.jpg", contentType: "image/jpeg" });
          const upResp = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php",
            (() => { const f = new FormData(); f.append("reqtype", "fileupload"); f.append("time", "1h"); f.append("fileToUpload", smBuf, { filename: "meme.jpg", contentType: "image/jpeg" }); return f; })(),
            { timeout: 30000 }
          ).catch(() => null);
          if (!upResp?.data || !String(upResp.data).startsWith("http")) {
            await reply(sock, msg, "❌ Could not upload image for meme generation.");
            break;
          }
          const memeUrl = `https://api.memegen.link/images/custom/${botText}/${topText}.png?background=${encodeURIComponent(upResp.data)}`;
          const memeBuf = await axios.get(memeUrl, { responseType: "arraybuffer", timeout: 15000 });
          await sock.sendMessage(from, { sticker: Buffer.from(memeBuf.data) }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Meme generation failed: ${e.message}`);
        }
        break;
      }

      case "take": {
        const takeQuoted = getQuotedMsg(msg);
        if (!takeQuoted) { await reply(sock, msg, `🎨 Reply to a sticker/image with *${prefix}take* to re-watermark it.`); break; }
        const takeType = Object.keys(takeQuoted)[0];
        if (!["imageMessage", "videoMessage", "stickerMessage"].includes(takeType)) {
          await reply(sock, msg, "❌ Reply to a sticker, image, or short video.");
          break;
        }
        try {
          const takeBuf = await getMediaBuffer(sock, { key: msg.key, message: takeQuoted });
          if (!takeBuf) { await reply(sock, msg, "❌ Could not download media."); break; }
          const stickerBuf = await sticker.imageToSticker(takeBuf, msg.pushName || "NEXUS-MD", msg.pushName || "User");
          await sock.sendMessage(from, { sticker: stickerBuf }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Take failed: ${e.message}`);
        }
        break;
      }

      // ── Code Compilation Commands ───────────────────────────────────────
      case "compile-js": {
        const jsCode = text || getQuotedMsg(msg)?.conversation || getQuotedMsg(msg)?.extendedTextMessage?.text;
        if (!jsCode) { await reply(sock, msg, `💻 Usage: *${prefix}compile-js [code]* or reply to a message`); break; }
        await reply(sock, msg, "💻 Compiling JavaScript...");
        try {
          const compResp = await axios.post("https://emkc.org/api/v2/piston/execute", {
            language: "javascript", version: "18.15.0", files: [{ content: jsCode }],
          }, { timeout: 30000 });
          const output = compResp.data?.run?.output || compResp.data?.run?.stderr || "No output";
          await reply(sock, msg, `💻 *JavaScript Output:*\n\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``);
        } catch (e) {
          await reply(sock, msg, `❌ Compilation failed: ${e.message}`);
        }
        break;
      }

      case "compile-py": {
        const pyCode = text || getQuotedMsg(msg)?.conversation || getQuotedMsg(msg)?.extendedTextMessage?.text;
        if (!pyCode) { await reply(sock, msg, `🐍 Usage: *${prefix}compile-py [code]* or reply to a message`); break; }
        await reply(sock, msg, "🐍 Compiling Python...");
        try {
          const compResp = await axios.post("https://emkc.org/api/v2/piston/execute", {
            language: "python", version: "3.10.0", files: [{ content: pyCode }],
          }, { timeout: 30000 });
          const output = compResp.data?.run?.output || compResp.data?.run?.stderr || "No output";
          await reply(sock, msg, `🐍 *Python Output:*\n\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``);
        } catch (e) {
          await reply(sock, msg, `❌ Python compilation failed: ${e.message}`);
        }
        break;
      }

      case "compile-c": {
        const cCode = text || getQuotedMsg(msg)?.conversation || getQuotedMsg(msg)?.extendedTextMessage?.text;
        if (!cCode) { await reply(sock, msg, `⚙️ Usage: *${prefix}compile-c [code]* or reply to a message`); break; }
        await reply(sock, msg, "⚙️ Compiling C...");
        try {
          const compResp = await axios.post("https://emkc.org/api/v2/piston/execute", {
            language: "c", version: "10.2.0", files: [{ content: cCode }],
          }, { timeout: 30000 });
          const output = compResp.data?.run?.output || compResp.data?.run?.stderr || "No output";
          await reply(sock, msg, `⚙️ *C Output:*\n\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``);
        } catch (e) {
          await reply(sock, msg, `❌ C compilation failed: ${e.message}`);
        }
        break;
      }

      case "compile-c++":
      case "compile-cpp": {
        const cppCode = text || getQuotedMsg(msg)?.conversation || getQuotedMsg(msg)?.extendedTextMessage?.text;
        if (!cppCode) { await reply(sock, msg, `⚙️ Usage: *${prefix}compile-c++ [code]* or reply to a message`); break; }
        await reply(sock, msg, "⚙️ Compiling C++...");
        try {
          const compResp = await axios.post("https://emkc.org/api/v2/piston/execute", {
            language: "c++", version: "10.2.0", files: [{ content: cppCode }],
          }, { timeout: 30000 });
          const output = compResp.data?.run?.output || compResp.data?.run?.stderr || "No output";
          await reply(sock, msg, `⚙️ *C++ Output:*\n\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``);
        } catch (e) {
          await reply(sock, msg, `❌ C++ compilation failed: ${e.message}`);
        }
        break;
      }

      // ── Misc Commands ───────────────────────────────────────────────────
      case "runtime": {
        const ut = process.uptime();
        const days = Math.floor(ut / 86400);
        const hrs = Math.floor((ut % 86400) / 3600);
        const mins = Math.floor((ut % 3600) / 60);
        const secs = Math.floor(ut % 60);
        const memUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        const memTotal = (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1);
        await reply(sock, msg,
          `⏱ *Bot Runtime*\n\n` +
          `📅 ${days} days, ${hrs} hours, ${mins} minutes, ${secs} seconds\n` +
          `💾 Memory: ${memUsed}MB / ${memTotal}MB\n` +
          `☁ Platform: ${detectPlatform()}\n` +
          `🤖 Node.js: ${process.version}`
        );
        break;
      }

      case "sc":
      case "script":
      case "repo": {
        const repoCaption =
          `╭━━━〔 🤖 𝑵𝑬𝑿𝑼𝑺-𝑴𝑫 〕━━━╮\n` +
          `┃\n` +
          `┃ 📦 *GitHub Repository*\n` +
          `┃ Fork • Deploy • Copy URL\n` +
          `┃ 🔗 https://github.com/ignatiusmkuu-spec/IgniteBot\n` +
          `┃\n` +
          `┃ 🌐 *Pairing Site*\n` +
          `┃ Connect your bot here:\n` +
          `┃ 🔗 https://web-production-9e409.up.railway.app/pair\n` +
          `┃\n` +
          `┃ ⭐ Fork & give a star!\n` +
          `╰━━━〔 made. by Ignatius 〕━━━╯`;
        try {
          const bannerPath = path.join(__dirname, "..", "assets", "repo-banner.jpg");
          const bannerBuf = fs.readFileSync(bannerPath);
          await sock.sendMessage(from, { image: bannerBuf, caption: repoCaption }, { quoted: msg });
        } catch {
          await reply(sock, msg, repoCaption);
        }
        break;
      }

      case "request":
      case "reportbug": {
        if (!text) { await reply(sock, msg, `📝 Usage: *${prefix}request [your message/bug report]*`); break; }
        try {
          const { admins: ownerNums } = require("../config");
          const dynSudos = admin.getDynamicSudos();
          const allOwners = [...new Set([...ownerNums, ...dynSudos])];
          const reportText = `📝 *Request/Bug Report*\n\n👤 From: @${senderPhone}\n📌 ${text}`;
          for (const ownerNum of allOwners) {
            try {
              await sock.sendMessage(`${ownerNum}@s.whatsapp.net`, { text: reportText, mentions: [senderJid] });
            } catch {}
          }
          await reply(sock, msg, "✅ Your request has been forwarded to the bot owner(s). Please wait for a response.");
        } catch (e) {
          await reply(sock, msg, `❌ Failed to send report: ${e.message}`);
        }
        break;
      }

      case "gitclone": {
        if (!text || !text.includes("github.com")) { await reply(sock, msg, `📦 Usage: *${prefix}gitclone [github repo url]*`); break; }
        await reply(sock, msg, "📦 Cloning repository...");
        try {
          const repoMatch = text.match(/github\.com\/([^\/]+)\/([^\/\s]+)/);
          if (!repoMatch) { await reply(sock, msg, "❌ Invalid GitHub URL."); break; }
          const [, owner, repo] = repoMatch;
          const cleanRepo = repo.replace(/\.git$/, "");
          const zipUrl = `https://api.github.com/repos/${owner}/${cleanRepo}/zipball`;
          const zipResp = await axios.get(zipUrl, { responseType: "arraybuffer", timeout: 60000, maxRedirects: 5 });
          await sock.sendMessage(from, {
            document: Buffer.from(zipResp.data),
            mimetype: "application/zip",
            fileName: `${cleanRepo}.zip`,
          }, { quoted: msg });
          await reply(sock, msg, `📦 *${owner}/${cleanRepo}* cloned successfully!`);
        } catch (e) {
          await reply(sock, msg, `❌ Clone failed: ${e.message}`);
        }
        break;
      }

      case "fullpp": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const fpImg = msg.message?.imageMessage || getQuotedMsg(msg)?.imageMessage;
        if (!fpImg) { await reply(sock, msg, `🖼 Reply to an image with *${prefix}fullpp* to set full-size profile picture.`); break; }
        try {
          const fpTarget = msg.message?.imageMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
          const fpBuf = await getMediaBuffer(sock, fpTarget);
          if (!fpBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          const { S_WHATSAPP_NET } = require("@whiskeysockets/baileys");
          await sock.query({
            tag: "iq",
            attrs: { target: undefined, to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" },
            content: [{ tag: "picture", attrs: { type: "image" }, content: fpBuf }],
          });
          await reply(sock, msg, "✅ Full-size profile picture updated!");
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "tovideo":
      case "mp4":
      case "tovid": {
        const tvQuoted = getQuotedMsg(msg);
        const tvSticker = tvQuoted?.stickerMessage;
        if (!tvSticker) { await reply(sock, msg, `🎬 Reply to an animated sticker with *${prefix}tovideo*`); break; }
        try {
          const tvBuf = await getMediaBuffer(sock, { key: msg.key, message: tvQuoted });
          if (!tvBuf) { await reply(sock, msg, "❌ Could not download sticker."); break; }
          if (tvSticker.isAnimated) {
            await sock.sendMessage(from, { video: tvBuf, mimetype: "video/mp4", gifPlayback: true }, { quoted: msg });
          } else {
            await reply(sock, msg, "❌ This is not an animated sticker.");
          }
        } catch (e) {
          await reply(sock, msg, `❌ Conversion failed: ${e.message}`);
        }
        break;
      }

      case "say": {
        if (!text) { await reply(sock, msg, `🔊 Usage: *${prefix}say [text]*`); break; }
        await reply(sock, msg, "🔊 Converting to speech...");
        const sayPath = path.join(os.tmpdir(), `say_${Date.now()}.mp3`);
        const sayResult = await ai.textToSpeech(text, sayPath);
        if (sayResult.error) { await reply(sock, msg, sayResult.error); break; }
        await sock.sendMessage(from, {
          audio: fs.readFileSync(sayResult.path), mimetype: "audio/mpeg", ptt: true,
        }, { quoted: msg });
        try { fs.unlinkSync(sayResult.path); } catch {}
        break;
      }

      case "upload":
      case "url": {
        const ulQuoted = getQuotedMsg(msg);
        if (!ulQuoted) { await reply(sock, msg, `📤 Reply to an image or video with *${prefix}upload* to get a URL.`); break; }
        const ulType = Object.keys(ulQuoted)[0];
        if (!["imageMessage", "videoMessage", "audioMessage", "documentMessage"].includes(ulType)) {
          await reply(sock, msg, "❌ Reply to an image, video, audio, or document."); break;
        }
        await reply(sock, msg, "📤 Uploading media...");
        try {
          const ulBuf = await getMediaBuffer(sock, { key: msg.key, message: ulQuoted });
          if (!ulBuf) { await reply(sock, msg, "❌ Could not download media."); break; }
          if (ulBuf.length > 10 * 1024 * 1024) { await reply(sock, msg, "❌ File too large (max 10MB)."); break; }
          const FormData = require("form-data");
          const ulForm = new FormData();
          ulForm.append("reqtype", "fileupload");
          ulForm.append("fileToUpload", ulBuf, { filename: "upload." + (ulType === "imageMessage" ? "jpg" : ulType === "videoMessage" ? "mp4" : "bin") });
          const ulResp = await axios.post("https://catbox.moe/user/api.php", ulForm, { timeout: 60000, headers: ulForm.getHeaders() });
          if (ulResp.data && String(ulResp.data).startsWith("http")) {
            const sizeMB = (ulBuf.length / 1024 / 1024).toFixed(2);
            await reply(sock, msg, `📤 *Upload Complete*\n\n🔗 ${ulResp.data}\n📦 Size: ${sizeMB} MB`);
          } else {
            await reply(sock, msg, "❌ Upload failed. Please try again.");
          }
        } catch (e) {
          await reply(sock, msg, `❌ Upload failed: ${e.message}`);
        }
        break;
      }

      case "hacker2": {
        const h2Quoted = getQuotedMsg(msg);
        const h2Img = h2Quoted?.imageMessage;
        if (!h2Img) { await reply(sock, msg, `🖥️ Reply to an image with *${prefix}hacker2* to apply hacker filter.`); break; }
        try {
          const h2Buf = await getMediaBuffer(sock, { key: msg.key, message: h2Quoted });
          if (!h2Buf) { await reply(sock, msg, "❌ Could not download image."); break; }
          const FormData = require("form-data");
          const h2Form = new FormData();
          h2Form.append("reqtype", "fileupload");
          h2Form.append("time", "1h");
          h2Form.append("fileToUpload", h2Buf, { filename: "image.jpg", contentType: "image/jpeg" });
          const h2Upload = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", h2Form, { timeout: 30000 });
          if (!h2Upload.data || !String(h2Upload.data).startsWith("http")) {
            await reply(sock, msg, "❌ Could not upload image.");
            break;
          }
          const h2Url = `https://aemt.me/hacker2?link=${encodeURIComponent(h2Upload.data)}`;
          const h2Result = await axios.get(h2Url, { responseType: "arraybuffer", timeout: 30000 });
          await sock.sendMessage(from, { image: Buffer.from(h2Result.data), caption: "🖥️ *Hacker Filter Applied*\n_Powered by NEXUS-MD ⚡_" }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Hacker filter failed: ${e.message}`);
        }
        break;
      }

      case "disp-1":
      case "disp-7":
      case "disp-90":
      case "disp-off": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          const dispMap = { "disp-1": 86400, "disp-7": 604800, "disp-90": 7776000, "disp-off": 0 };
          const dispVal = dispMap[cmd];
          await sock.groupToggleEphemeral(from, dispVal);
          await reply(sock, msg, dispVal === 0
            ? "🔓 Disappearing messages *disabled*."
            : `⏳ Disappearing messages set to *${cmd.replace("disp-", "")} ${dispVal === 86400 ? "day" : "days"}*.`
          );
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "foreigners": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const botJid = sock.user?.id;
          const botNum = botJid?.split(":")[0] || botJid?.split("@")[0] || "";
          const myCode = senderPhone.slice(0, 3);
          const foreignMembers = meta.participants
            .filter(p => !p.admin)
            .map(p => p.id)
            .filter(id => !id.startsWith(myCode) && id !== botJid);
          if (!foreignMembers.length) { await reply(sock, msg, "✅ No foreigners detected."); break; }
          if (args[0] === "-x") {
            await reply(sock, msg, `🌍 Removing ${foreignMembers.length} foreigners...`);
            for (const fid of foreignMembers) {
              try { await sock.groupParticipantsUpdate(from, [fid], "remove"); } catch {}
            }
            await reply(sock, msg, `✅ Removed ${foreignMembers.length} foreigners.`);
          } else {
            let txt = `🌍 *Foreigners Detected (code ≠ ${myCode}):* ${foreignMembers.length}\n\n`;
            for (const fid of foreignMembers) txt += `👤 @${fid.split("@")[0]}\n`;
            txt += `\nTo remove them: *${prefix}foreigners -x*`;
            await sock.sendMessage(from, { text: txt, mentions: foreignMembers }, { quoted: msg });
          }
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "hidetag":
      case "tag": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const allIds = meta.participants.map(p => p.id);
          const tagText = text || "📢 Attention everyone!";
          await sock.sendMessage(from, { text: tagText, mentions: allIds }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "icon": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const iconImg = msg.message?.imageMessage || getQuotedMsg(msg)?.imageMessage;
        if (!iconImg) { await reply(sock, msg, `🖼 Send or tag an image with *${prefix}icon*`); break; }
        try {
          const iconTarget = msg.message?.imageMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
          const iconBuf = await getMediaBuffer(sock, iconTarget);
          if (!iconBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          await sock.updateProfilePicture(from, iconBuf);
          await reply(sock, msg, "✅ Group icon updated!");
        } catch (e) {
          await reply(sock, msg, `❌ Failed to update icon: ${e.message}`);
        }
        break;
      }

      case "subject":
      case "changesubject": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}subject [new group name]*`); break; }
        try {
          await sock.groupUpdateSubject(from, text);
          await reply(sock, msg, "✅ Group name updated!");
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "desc":
      case "setdesc": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        if (!text) { await reply(sock, msg, `Usage: *${prefix}desc [new description]*`); break; }
        try {
          await sock.groupUpdateDescription(from, text);
          await reply(sock, msg, "✅ Group description updated!");
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "vv":
      case "retrieve": {
        const vvCtx    = msg.message?.extendedTextMessage?.contextInfo;
        const vvQuoted = getQuotedMsg(msg);
        if (!vvQuoted) { await reply(sock, msg, "👁 Quote a view-once message to retrieve."); break; }
        try {
          // Use cached original first (has real media keys)
          const vvStanzaId = vvCtx?.stanzaId;
          const vvCached   = vvStanzaId ? security.getCachedMessage(vvStanzaId)?.msg : null;
          const innerMsg   = extractViewOnce(vvCached?.message) || extractViewOnce(vvQuoted);
          if (!innerMsg) { await reply(sock, msg, "❌ That's not a view-once message."); break; }
          const vvCtxKey   = vvCached
            ? { remoteJid: vvCached.key?.remoteJid || from, stanzaId: vvCached.key?.id, participant: vvCached.key?.participant }
            : vvCtx;
          const revealed   = await decryptViewOnce(sock, innerMsg, vvCtxKey, from);
          if (!revealed) { await reply(sock, msg, "❌ Could not download view-once media."); break; }
          await sendRevealedMedia(sock, from, revealed, msg);
        } catch (e) {
          await reply(sock, msg, `❌ Retrieve failed: ${e.message}`);
        }
        break;
      }

      case "toimage":
      case "photo": {
        const tiQuoted = getQuotedMsg(msg);
        const tiSticker = tiQuoted?.stickerMessage;
        if (!tiSticker) { await reply(sock, msg, `🖼 Reply to a sticker with *${prefix}toimage*`); break; }
        try {
          const tiBuf = await getMediaBuffer(sock, { key: msg.key, message: tiQuoted });
          if (!tiBuf) { await reply(sock, msg, "❌ Could not download sticker."); break; }
          await sock.sendMessage(from, { image: tiBuf, caption: "🖼 *Converted to Image*" }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Conversion failed: ${e.message}`);
        }
        break;
      }

      case "removebg": {
        const rbQuoted = getQuotedMsg(msg);
        const rbImg = rbQuoted?.imageMessage || msg.message?.imageMessage;
        if (!rbImg) { await reply(sock, msg, `🖼 Reply to an image with *${prefix}removebg*`); break; }
        await reply(sock, msg, "🖼 Removing background...");
        try {
          const rbTarget = msg.message?.imageMessage ? msg : { key: msg.key, message: rbQuoted };
          const rbBuf = await getMediaBuffer(sock, rbTarget);
          if (!rbBuf) { await reply(sock, msg, "❌ Could not download image."); break; }
          const FormData = require("form-data");
          const rbForm = new FormData();
          rbForm.append("image", rbBuf, { filename: "image.jpg", contentType: "image/jpeg" });
          const FormData2 = require("form-data");
          const rbForm2 = new FormData2();
          rbForm2.append("reqtype", "fileupload");
          rbForm2.append("time", "1h");
          rbForm2.append("fileToUpload", rbBuf, { filename: "image.jpg", contentType: "image/jpeg" });
          const rbUp = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", rbForm2, { timeout: 30000, headers: rbForm2.getHeaders() }).catch(() => null);
          if (rbUp?.data && String(rbUp.data).startsWith("http")) {
            const removeBgApiKey = process.env.REMOVE_BG_API_KEY;
            let bgResult = null;
            if (removeBgApiKey) {
              bgResult = await axios.post("https://api.remove.bg/v1.0/removebg", rbForm, {
                headers: { ...rbForm.getHeaders(), "X-Api-Key": removeBgApiKey },
                responseType: "arraybuffer", timeout: 30000,
              }).catch(() => null);
            }
            if (!bgResult?.data) {
              bgResult = await axios.get(`https://api.dreaded.site/api/removebg?url=${encodeURIComponent(rbUp.data)}`, { responseType: "arraybuffer", timeout: 30000 }).catch(() => null);
            }
            if (bgResult?.data) {
              await sock.sendMessage(from, { image: Buffer.from(bgResult.data), caption: "🖼 *Background Removed*" }, { quoted: msg });
            } else {
              await reply(sock, msg, "❌ Background removal service unavailable.");
            }
          } else {
            await reply(sock, msg, "❌ Could not upload image for processing.");
          }
        } catch (e) {
          await reply(sock, msg, `❌ Remove BG failed: ${e.message}`);
        }
        break;
      }

      case "trt":
      case "translate": {
        if (!text) { await reply(sock, msg, `🌐 Usage: *${prefix}trt [lang] [text]*\nExample: *${prefix}trt es hello world*`); break; }
        const trtArgs = text.split(" ");
        if (trtArgs.length < 2) { await reply(sock, msg, `🌐 Usage: *${prefix}trt [lang code] [text]*`); break; }
        const targetLang = trtArgs[0];
        const textToTranslate = trtArgs.slice(1).join(" ");
        try {
          const trtResp = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=en|${targetLang}`, { timeout: 15000 });
          const translated = trtResp.data?.responseData?.translatedText;
          if (!translated) { await reply(sock, msg, "❌ Translation not available."); break; }
          await reply(sock, msg, `🌐 *Translation (${targetLang}):*\n\n${translated}`);
        } catch (e) {
          await reply(sock, msg, `❌ Translation failed: ${e.message}`);
        }
        break;
      }

      case "inspect": {
        if (!text) { await reply(sock, msg, `🔍 Usage: *${prefix}inspect [url]*`); break; }
        if (!/^https?:\/\//i.test(text)) { await reply(sock, msg, "❌ URL must start with http:// or https://"); break; }
        await reply(sock, msg, "🔍 Inspecting webpage...");
        try {
          const inspResp = await axios.get(text, { timeout: 15000, maxContentLength: 500000 });
          const html = typeof inspResp.data === "string" ? inspResp.data : JSON.stringify(inspResp.data);
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
          const imgCount = (html.match(/<img/gi) || []).length;
          const linkCount = (html.match(/<a\s/gi) || []).length;
          await reply(sock, msg,
            `🔍 *Web Inspection*\n\n` +
            `🌐 URL: ${text}\n` +
            `📛 Title: ${titleMatch?.[1] || "N/A"}\n` +
            `📝 Description: ${metaDesc?.[1]?.slice(0, 200) || "N/A"}\n` +
            `🖼 Images: ${imgCount}\n` +
            `🔗 Links: ${linkCount}\n` +
            `📦 Size: ${(html.length / 1024).toFixed(1)} KB`
          );
        } catch (e) {
          await reply(sock, msg, `❌ Inspection failed: ${e.message}`);
        }
        break;
      }

      case "eval": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const evalCode = text || getQuotedMsg(msg)?.conversation || getQuotedMsg(msg)?.extendedTextMessage?.text;
        if (!evalCode) { await reply(sock, msg, `⚡ Usage: *${prefix}eval [code]*`); break; }
        try {
          let evaled = await eval(evalCode);
          if (typeof evaled !== "string") evaled = require("util").inspect(evaled);
          await reply(sock, msg, `⚡ *Eval Result:*\n\n\`\`\`\n${String(evaled).slice(0, 2000)}\n\`\`\``);
        } catch (e) {
          await reply(sock, msg, `❌ ${e.message}`);
        }
        break;
      }

      case "kill":
      case "kill2": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          const botId = sock.user?.id;
          const killTargets = meta.participants
            .filter(p => !p.admin && p.id !== botId)
            .map(p => p.id);
          if (!killTargets.length) { await reply(sock, msg, "No non-admin members to remove."); break; }
          await reply(sock, msg, `⚠️ Removing ${killTargets.length} members...`);
          for (const kid of killTargets) {
            try { await sock.groupParticipantsUpdate(from, [kid], "remove"); } catch {}
          }
          await reply(sock, msg, `✅ Removed ${killTargets.length} members.`);
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
        }
        break;
      }

      case "dp": {
        const dpUser = getMentioned(msg)[0] || senderJid;
        try {
          const dpUrl = await getPpUrl(sock, dpUser);
          if (!dpUrl) { await reply(sock, msg, "❌ No profile picture set."); break; }
          const dpBuf = await axios.get(dpUrl, { responseType: "arraybuffer", timeout: 10000 });
          await sock.sendMessage(from, {
            image: Buffer.from(dpBuf.data),
            caption: `🖼 *Profile Picture*\n👤 @${dpUser.split("@")[0]}`,
            mentions: [dpUser],
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Could not fetch profile picture: ${e.message}`);
        }
        break;
      }

      case "mail": {
        if (!text || !text.includes("@")) {
          await reply(sock, msg, `📧 Usage: *${prefix}mail [email]*\nFetches messages from a tempmail inbox.`);
          break;
        }
        try {
          const mailResp = await axios.get(`https://tempmail.apinepdev.workers.dev/api/getmessage?email=${encodeURIComponent(text)}`, { timeout: 15000 });
          const messages = mailResp.data;
          if (!messages?.length) { await reply(sock, msg, "📧 No messages found."); break; }
          let mailTxt = `📧 *Inbox for ${text}*\n\n`;
          for (const m of messages.slice(0, 5)) {
            mailTxt += `📨 *From:* ${m.from || "Unknown"}\n📛 *Subject:* ${m.subject || "No subject"}\n📝 ${(m.body || "").slice(0, 200)}\n\n`;
          }
          await reply(sock, msg, mailTxt);
        } catch (e) {
          await reply(sock, msg, `❌ Mail fetch failed: ${e.message}`);
        }
        break;
      }

      case "vcf":
      case "group-vcf": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        try {
          const meta = await sock.groupMetadata(from);
          let vcfContent = "";
          for (const p of meta.participants) {
            const phone = p.id.split("@")[0].split(":")[0];
            vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:${phone}\nTEL;type=CELL:+${phone}\nEND:VCARD\n`;
          }
          await sock.sendMessage(from, {
            document: Buffer.from(vcfContent),
            mimetype: "text/vcard",
            fileName: `${meta.subject}_contacts.vcf`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ VCF export failed: ${e.message}`);
        }
        break;
      }

      case "whatsong":
      case "shazam": {
        const wsQuoted = getQuotedMsg(msg);
        if (!wsQuoted) { await reply(sock, msg, `🎵 Reply to a video or audio with *${prefix}whatsong*`); break; }
        const wsType = Object.keys(wsQuoted)[0];
        if (!["videoMessage", "audioMessage"].includes(wsType)) {
          await reply(sock, msg, "❌ Reply to a video or audio message."); break;
        }
        await reply(sock, msg, "🎵 Analyzing audio...");
        try {
          const wsBuf = await getMediaBuffer(sock, { key: msg.key, message: wsQuoted });
          if (!wsBuf) { await reply(sock, msg, "❌ Could not download media."); break; }
          const FormData = require("form-data");
          const wsForm = new FormData();
          wsForm.append("reqtype", "fileupload");
          wsForm.append("time", "1h");
          wsForm.append("fileToUpload", wsBuf, { filename: "audio.mp3", contentType: "audio/mpeg" });
          const wsUp = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", wsForm, { timeout: 30000, headers: wsForm.getHeaders() }).catch(() => null);
          if (wsUp?.data && String(wsUp.data).startsWith("http")) {
            const wsResp = await perez.fetchJson(`https://api.dreaded.site/api/shazam?url=${encodeURIComponent(wsUp.data)}`);
            if (wsResp?.result) {
              const track = wsResp.result;
              await reply(sock, msg,
                `🎵 *Song Identified*\n\n` +
                `🎶 Title: ${track.title || "Unknown"}\n` +
                `🎤 Artist: ${track.artist || "Unknown"}\n` +
                `💿 Album: ${track.album || "N/A"}\n` +
                `📅 Year: ${track.year || "N/A"}`
              );
            } else {
              await reply(sock, msg, "❌ Could not identify the song.");
            }
          } else {
            await reply(sock, msg, "❌ Could not upload audio for analysis.");
          }
        } catch (e) {
          await reply(sock, msg, `❌ Song identification failed: ${e.message}`);
        }
        break;
      }

      case "antileave": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const alVal = args[0]?.toLowerCase();
        if (alVal !== "on" && alVal !== "off") {
          await reply(sock, msg, `Usage: *${prefix}antileave on/off*\n_When ON, members who leave will be re-added._`);
          break;
        }
        security.setGroupSetting(from, "antiLeave", alVal === "on");
        await reply(sock, msg, `🚪 Anti-leave ${alVal === "on" ? "✅ *enabled* — members who leave will be re-added" : "❌ *disabled*"}`);
        break;
      }

      // ── Flirt ───────────────────────────────────────────────────────────────
      case "flirt": {
        try {
          const flirtRes = await axios.get("https://shizoapi.onrender.com/api/texts/flirt?apikey=shizo", { timeout: 10000 });
          const flirtMsg = flirtRes.data?.result || "You must be a magician, because whenever I look at you, everyone else disappears! 😍";
          await reply(sock, msg, `💌 *Flirt Line*\n\n${flirtMsg}`);
        } catch {
          const fallbacks = [
            "Are you a bank loan? Because you have my interest! 💘",
            "Do you have a map? I keep getting lost in your eyes. 👀",
            "If you were a vegetable, you'd be a cute-cumber. 🥒",
            "Are you a parking ticket? Because you've got 'Fine' written all over you. 😏",
            "Is your name Google? Because you have everything I've been searching for. 🔍",
          ];
          await reply(sock, msg, `💌 *Flirt Line*\n\n${fallbacks[Math.floor(Math.random() * fallbacks.length)]}`);
        }
        break;
      }

      // ── Dare ────────────────────────────────────────────────────────────────
      case "dare": {
        try {
          const dareRes = await axios.get("https://shizoapi.onrender.com/api/texts/dare?apikey=shizo", { timeout: 10000 });
          const dareMsg = dareRes.data?.result || "Send a voice message saying 'I am a potato' in your most dramatic voice!";
          await reply(sock, msg, `🎯 *DARE*\n\n${dareMsg}`);
        } catch {
          const dareFallbacks = [
            "Text your last contact a random emoji with no context.",
            "Send a voice message singing happy birthday to no one.",
            "Change your status to 'I am embarrassed right now' for 5 minutes.",
            "Send a selfie with your silliest face.",
            "Call someone and speak only in whispers for the whole conversation.",
          ];
          await reply(sock, msg, `🎯 *DARE*\n\n${dareFallbacks[Math.floor(Math.random() * dareFallbacks.length)]}`);
        }
        break;
      }

      // ── Compliment ──────────────────────────────────────────────────────────
      case "compliment": {
        const mentioned = getMentioned(msg);
        const compliments = [
          "You make the world a better place just by being in it! 🌟",
          "You're stronger than you think and braver than you believe! 💪",
          "Your smile can light up an entire room! ☀️",
          "You have an incredible work ethic and it shows! 🏆",
          "You bring out the best in people around you! 🌸",
          "Your kindness makes the world a better place! 💚",
          "You have a unique and wonderful perspective! 🎯",
          "Your enthusiasm is truly inspiring! 🔥",
          "You are capable of achieving great things! 🚀",
          "You always know how to make someone feel special! 💝",
          "Your confidence is absolutely admirable! ✨",
          "You have a beautiful soul inside and out! 💫",
          "Your generosity knows no limits! 🎁",
          "You are an amazing listener and a great friend! 👂",
          "Your laughter is the most infectious thing ever! 😄",
        ];
        const complimentText = compliments[Math.floor(Math.random() * compliments.length)];
        if (mentioned.length) {
          await sock.sendMessage(from, {
            text: `💌 *Compliment for @${mentioned[0].split("@")[0]}*\n\n${complimentText}`,
            mentions: [mentioned[0]],
          }, { quoted: msg });
        } else {
          await reply(sock, msg, `💌 *Compliment*\n\n${complimentText}\n\n_Tip: mention someone to compliment them! e.g. \`${prefix}compliment @user\`_`);
        }
        break;
      }

      // ── Character Analysis ───────────────────────────────────────────────────
      case "character": {
        const charTarget = getMentioned(msg)[0] || senderJid;
        const traits = [
          "Intelligent","Creative","Determined","Ambitious","Caring","Charismatic",
          "Confident","Empathetic","Energetic","Friendly","Generous","Honest",
          "Humorous","Imaginative","Independent","Intuitive","Kind","Logical",
          "Loyal","Optimistic","Passionate","Patient","Persistent","Reliable",
          "Resourceful","Sincere","Thoughtful","Understanding","Versatile","Wise",
        ];
        const vibes = ["🔥 Fire Starter","🌊 Deep Thinker","🌟 Natural Leader","🎭 Social Butterfly","🧩 Problem Solver","🦋 Free Spirit"];
        const shuffle = (a) => a.sort(() => Math.random() - 0.5);
        const picked = shuffle([...traits]).slice(0, 5);
        const vibe = vibes[Math.floor(Math.random() * vibes.length)];
        const iq = Math.floor(Math.random() * 41) + 80;
        const charm = Math.floor(Math.random() * 51) + 50;
        const loyalty = Math.floor(Math.random() * 51) + 50;
        const humor = Math.floor(Math.random() * 51) + 50;
        await sock.sendMessage(from, {
          text:
            `🔍 *Character Analysis*\n` +
            `👤 @${charTarget.split("@")[0]}\n` +
            `━━━━━━━━━━━━━━━━━━━\n\n` +
            `🎭 *Vibe:* ${vibe}\n\n` +
            `✨ *Top Traits:*\n${picked.map(t => `  • ${t}`).join("\n")}\n\n` +
            `📊 *Stats:*\n` +
            `  🧠 IQ: ${iq}\n` +
            `  💫 Charm: ${charm}%\n` +
            `  💎 Loyalty: ${loyalty}%\n` +
            `  😂 Humor: ${humor}%`,
          mentions: [charTarget],
        }, { quoted: msg });
        break;
      }

      // ── GIF Search ──────────────────────────────────────────────────────────
      case "gif": {
        if (!text) { await reply(sock, msg, `🎬 Usage: *${prefix}gif [search term]*\nExample: *${prefix}gif funny cat*`); break; }
        await reply(sock, msg, "🎬 Searching for GIF...");
        try {
          const gifQuery = encodeURIComponent(text.trim());
          const tenorKey = "AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ";
          const gifRes = await axios.get(
            `https://tenor.googleapis.com/v2/search?q=${gifQuery}&key=${tenorKey}&limit=8&media_filter=gif`,
            { timeout: 10000 }
          );
          const results = gifRes.data?.results;
          if (!results?.length) { await reply(sock, msg, "❌ No GIF found. Try a different search term."); break; }
          const pick = results[Math.floor(Math.random() * results.length)];
          const gifUrl = pick?.media_formats?.gif?.url || pick?.url;
          if (!gifUrl) { await reply(sock, msg, "❌ Could not retrieve GIF."); break; }
          const gifBuf = await axios.get(gifUrl, { responseType: "arraybuffer", timeout: 20000 });
          await sock.sendMessage(from, {
            video: Buffer.from(gifBuf.data),
            caption: `🎬 *${text}*`,
            gifPlayback: true,
            mimetype: "video/mp4",
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ GIF search failed: ${e.message}`);
        }
        break;
      }

      // ── Emoji Mix ───────────────────────────────────────────────────────────
      case "emojimix": {
        if (!text || !text.includes("+")) {
          await reply(sock, msg, `🎴 *Emoji Mix*\n\nMix two emojis together!\n\n*Usage:* ${prefix}emojimix 😎+🥰\n_Separate the emojis with a + sign_`);
          break;
        }
        const [em1, em2] = text.split("+").map(e => e.trim());
        if (!em1 || !em2) { await reply(sock, msg, "❌ Provide two emojis separated by +\nExample: `.emojimix 😂+😭`"); break; }
        await reply(sock, msg, `🎨 Mixing ${em1} + ${em2}...`);
        try {
          const tenorKey2 = "AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ";
          const mixUrl = `https://tenor.googleapis.com/v2/featured?key=${tenorKey2}&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(em1)}_${encodeURIComponent(em2)}`;
          const mixRes = await axios.get(mixUrl, { timeout: 10000 });
          const mixResults = mixRes.data?.results;
          if (!mixResults?.length) { await reply(sock, msg, "❌ These emojis cannot be mixed! Try different ones."); break; }
          const mixImageUrl = mixResults[0]?.url;
          if (!mixImageUrl) { await reply(sock, msg, "❌ Could not retrieve mixed emoji."); break; }
          const mixBuf = await axios.get(mixImageUrl, { responseType: "arraybuffer", timeout: 15000 });
          await sock.sendMessage(from, {
            image: Buffer.from(mixBuf.data),
            caption: `✨ *Emoji Mix:* ${em1} + ${em2}`,
          }, { quoted: msg });
        } catch (e) {
          await reply(sock, msg, `❌ Emoji mix failed: ${e.message}`);
        }
        break;
      }

      // ── Encrypt / Decrypt (Caesar Cipher) ───────────────────────────────────
      case "encrypt": {
        if (!text) { await reply(sock, msg, `🔐 *Encrypt Text*\n\nUsage: *${prefix}encrypt [text]*\nDecrypt with: *${prefix}decrypt [text]*`); break; }
        const shift = 13;
        const encrypted = text.replace(/[a-zA-Z]/g, (c) => {
          const base = c < 'a' ? 65 : 97;
          return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base);
        });
        await reply(sock, msg, `🔐 *Encrypted Text (ROT13)*\n\n📥 Original: \`${text}\`\n🔒 Encrypted: \`${encrypted}\`\n\n_Decrypt with: ${prefix}decrypt_`);
        break;
      }

      case "decrypt": {
        if (!text) { await reply(sock, msg, `🔓 *Decrypt Text*\n\nUsage: *${prefix}decrypt [encrypted text]*`); break; }
        const dShift = 13;
        const decrypted = text.replace(/[a-zA-Z]/g, (c) => {
          const base = c < 'a' ? 65 : 97;
          return String.fromCharCode(((c.charCodeAt(0) - base + dShift) % 26) + base);
        });
        await reply(sock, msg, `🔓 *Decrypted Text (ROT13)*\n\n🔒 Encrypted: \`${text}\`\n📤 Decrypted: \`${decrypted}\``);
        break;
      }

      // ── Disappearing Messages ────────────────────────────────────────────────
      case "disp": {
        if (!isOwner && !isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const dispOpts = { "off": 0, "24h": 86400, "7d": 604800, "90d": 7776000 };
        const dispArg = (args[0] || "").toLowerCase();
        if (!dispArg || !(dispArg in dispOpts)) {
          await reply(sock, msg,
            `⏳ *Disappearing Messages*\n\n` +
            `Set message expiry for this chat.\n\n` +
            `*Usage:*\n` +
            `  ${prefix}disp off   — Disable\n` +
            `  ${prefix}disp 24h   — 24 hours\n` +
            `  ${prefix}disp 7d    — 7 days\n` +
            `  ${prefix}disp 90d   — 90 days`
          );
          break;
        }
        const dispDuration = dispOpts[dispArg];
        try {
          await sock.sendMessage(from, { disappearingMessagesInChat: dispDuration });
          const labels = { "off": "❌ Disabled", "24h": "⏱ 24 hours", "7d": "📅 7 days", "90d": "🗓 90 days" };
          await reply(sock, msg, `⏳ *Disappearing Messages*\n\nStatus: ${labels[dispArg]}`);
        } catch (e) {
          await reply(sock, msg, `❌ Failed to set disappearing messages: ${e.message}`);
        }
        break;
      }

      // ── DeepSeek AI ─────────────────────────────────────────────────────────
      case "deepseek":
      case "ds": {
        if (!text) { await reply(sock, msg, `🤖 *DeepSeek AI*\n\nUsage: *${prefix}deepseek [question]*\nExample: *${prefix}deepseek What is black hole?*`); break; }
        await reply(sock, msg, "🤖 Thinking with DeepSeek...");
        try {
          const dsUrl = `https://meta-api.zone.id/ai/copilot?message=${encodeURIComponent(text)}`;
          const dsRes = await axios.get(dsUrl, { timeout: 30000 });
          const dsAnswer = dsRes.data?.answer || dsRes.data?.result || dsRes.data?.response;
          if (!dsAnswer) throw new Error("No response from DeepSeek API");
          await reply(sock, msg,
            `🤖 *DeepSeek AI*\n\n` +
            `📝 *Question:* ${text}\n\n` +
            `💬 *Answer:*\n${dsAnswer.trim()}`
          );
        } catch (e) {
          try {
            const dsBackup = await axios.get(`https://api.dreaded.site/api/llm/deepseek?text=${encodeURIComponent(text)}`, { timeout: 20000 });
            const dsAns2 = dsBackup.data?.result || dsBackup.data?.response || dsBackup.data?.message;
            if (dsAns2) {
              await reply(sock, msg, `🤖 *DeepSeek AI*\n\n📝 *Q:* ${text}\n\n💬 *A:* ${dsAns2.trim()}`);
            } else {
              await reply(sock, msg, "❌ DeepSeek AI is currently unavailable. Try `.ai` instead!");
            }
          } catch {
            await reply(sock, msg, "❌ DeepSeek AI is currently unavailable. Try `.ai` instead!");
          }
        }
        break;
      }

      // ── Auto Typing ──────────────────────────────────────────────────────────
      case "autotyping": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const atVal = (args[0] || "").toLowerCase();
        const atCurrent = !!settings.get("autoTyping");
        const atNew = atVal === "on" ? true : atVal === "off" ? false : !atCurrent;
        settings.set("autoTyping", atNew);
        await reply(sock, msg, `⌨️ Auto Typing ${atNew ? "✅ *enabled*\n_Bot will appear as typing before each reply_" : "❌ *disabled*"}`);
        break;
      }

      // ── Auto Recording ───────────────────────────────────────────────────────
      case "autorecord":
      case "autorecording": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const arVal = (args[0] || "").toLowerCase();
        const arCurrent = !!settings.get("autoRecording");
        const arNew = arVal === "on" ? true : arVal === "off" ? false : !arCurrent;
        settings.set("autoRecording", arNew);
        await reply(sock, msg, `🎙️ Auto Recording ${arNew ? "✅ *enabled*\n_Bot will appear as recording before voice/audio replies_" : "❌ *disabled*"}`);
        break;
      }

      // ── Auto Both (Typing + Recording) ──────────────────────────────────────
      case "autoboth": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const abVal = (args[0] || "").toLowerCase();
        const abCurrent = !!settings.get("autoBoth");
        const abNew = abVal === "on" ? true : abVal === "off" ? false : !abCurrent;
        settings.set("autoBoth", abNew);
        settings.set("autoTyping", abNew);
        settings.set("autoRecording", abNew);
        await reply(sock, msg, `🔄 Auto Both (Typing + Recording) ${abNew ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      // ── Auto Font ────────────────────────────────────────────────────────────
      case "autofont": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const afVal = (args[0] || "").toLowerCase();
        const afCurrent = !!settings.get("autoFont");
        const afNew = afVal === "on" ? true : afVal === "off" ? false : !afCurrent;
        settings.set("autoFont", afNew);
        await reply(sock, msg, `🔤 Auto Font ${afNew ? "✅ *enabled*\n_Bot replies will use styled text_" : "❌ *disabled*"}`);
        break;
      }

      // ── Channel Info ─────────────────────────────────────────────────────────
      case "chanel":
      case "channel": {
        if (!text) { await reply(sock, msg, `📢 *Channel Info*\n\nUsage: *${prefix}channel [channel username or link]*\nExample: *${prefix}channel @Nexus_MD*`); break; }
        await reply(sock, msg, "📢 Fetching channel info...");
        try {
          const chanQuery = text.replace(/^@/, "").trim();
          const chanRes = await axios.get(`https://api.dreaded.site/api/whatsapp/channel?q=${encodeURIComponent(chanQuery)}`, { timeout: 10000 });
          const chanData = chanRes.data?.result || chanRes.data;
          if (!chanData) throw new Error("No data");
          await reply(sock, msg,
            `📢 *Channel Info*\n\n` +
            `📛 Name: ${chanData.name || chanQuery}\n` +
            `👥 Followers: ${chanData.followers || chanData.subscribers || "N/A"}\n` +
            `📝 Description: ${chanData.description || "N/A"}\n` +
            `🔗 Link: ${chanData.link || chanData.inviteLink || "N/A"}`
          );
        } catch {
          await reply(sock, msg, `❌ Could not fetch channel info for "${text}". Make sure to provide the channel username.`);
        }
        break;
      }

      // ── Anti Bad Word ────────────────────────────────────────────────────────
      case "antibadword": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const abwVal = (args[0] || "").toLowerCase();
        const abwWord = args.slice(1).join(" ").toLowerCase();
        const abwGrp = security.getGroupSettings(from);
        const abwWords = abwGrp.badWords || [];
        const abwEnabled = !!abwGrp.badWordsEnabled;
        if (abwVal === "on") {
          security.setGroupSetting(from, "badWordsEnabled", true);
          await reply(sock, msg, `🚫 Anti Bad Word ✅ *enabled*\n_Messages with banned words will be deleted_\n\nAdd words with: *${prefix}antibadword add [word]*`);
        } else if (abwVal === "off") {
          security.setGroupSetting(from, "badWordsEnabled", false);
          await reply(sock, msg, "🚫 Anti Bad Word ❌ *disabled*");
        } else if (abwVal === "add" && abwWord) {
          if (!abwWords.includes(abwWord)) abwWords.push(abwWord);
          security.setGroupSetting(from, "badWords", abwWords);
          security.setGroupSetting(from, "badWordsEnabled", true);
          await reply(sock, msg, `✅ Added "*${abwWord}*" to the bad word list.\n📋 Total: ${abwWords.length} word(s)`);
        } else if (abwVal === "remove" && abwWord) {
          const filtered = abwWords.filter(w => w !== abwWord);
          security.setGroupSetting(from, "badWords", filtered);
          await reply(sock, msg, `✅ Removed "*${abwWord}*" from the bad word list.`);
        } else if (abwVal === "list") {
          const list = abwWords.length ? abwWords.map((w, i) => `${i + 1}. ${w}`).join("\n") : "No banned words set.";
          await reply(sock, msg, `🚫 *Bad Word List*\n\nStatus: ${abwEnabled ? "✅ ON" : "❌ OFF"}\n\n${list}`);
        } else {
          await reply(sock, msg,
            `🚫 *Anti Bad Word*\n\n` +
            `*Commands:*\n` +
            `  ${prefix}antibadword on — Enable\n` +
            `  ${prefix}antibadword off — Disable\n` +
            `  ${prefix}antibadword add [word] — Add bad word\n` +
            `  ${prefix}antibadword remove [word] — Remove word\n` +
            `  ${prefix}antibadword list — See all banned words\n\n` +
            `Status: ${abwEnabled ? "✅ ON" : "❌ OFF"}`
          );
        }
        break;
      }

      // ── Anti Bot ──────────────────────────────────────────────────────────────
      case "antibot": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const antibotVal = (args[0] || "").toLowerCase();
        const antibotCurrent = security.getGroupSettings(from).antiBot;
        if (antibotVal === "on") {
          security.setGroupSetting(from, "antiBot", true);
          await reply(sock, msg, `🤖 Anti Bot ✅ *enabled*\n_Suspected bots joining the group will be removed_`);
        } else if (antibotVal === "off") {
          security.setGroupSetting(from, "antiBot", false);
          await reply(sock, msg, "🤖 Anti Bot ❌ *disabled*");
        } else {
          await reply(sock, msg,
            `🤖 *Anti Bot Settings*\n\n` +
            `Status: ${antibotCurrent ? "✅ ON" : "❌ OFF"}\n\n` +
            `*Commands:*\n` +
            `  ${prefix}antibot on — Enable auto-removal of bots\n` +
            `  ${prefix}antibot off — Disable`
          );
        }
        break;
      }

      // ── Anti Image ────────────────────────────────────────────────────────────
      case "antiimage": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const aiVal = (args[0] || "").toLowerCase();
        const aiCurrent = security.getGroupSettings(from).antiImage;
        if (aiVal === "on") {
          security.setGroupSetting(from, "antiImage", true);
          await reply(sock, msg, `📸 Anti Image ✅ *enabled*\n_Images sent by non-admins will be deleted_`);
        } else if (aiVal === "off") {
          security.setGroupSetting(from, "antiImage", false);
          await reply(sock, msg, "📸 Anti Image ❌ *disabled*");
        } else {
          await reply(sock, msg,
            `📸 *Anti Image Settings*\n\n` +
            `Status: ${aiCurrent ? "✅ ON" : "❌ OFF"}\n\n` +
            `*Commands:*\n` +
            `  ${prefix}antiimage on — Only admins can send images\n` +
            `  ${prefix}antiimage off — Everyone can send images`
          );
        }
        break;
      }

      // ── Anti Demote ────────────────────────────────────────────────────────────
      case "antidemote": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const adVal = (args[0] || "").toLowerCase();
        const adCurrent = security.getGroupSettings(from).antiDemote;
        if (adVal === "on") {
          security.setGroupSetting(from, "antiDemote", true);
          await reply(sock, msg, `🛡️ Anti Demote ✅ *enabled*\n_If a bot admin is demoted, the demoting admin will be removed_`);
        } else if (adVal === "off") {
          security.setGroupSetting(from, "antiDemote", false);
          await reply(sock, msg, "🛡️ Anti Demote ❌ *disabled*");
        } else {
          await reply(sock, msg,
            `🛡️ *Anti Demote*\n\n` +
            `Status: ${adCurrent ? "✅ ON" : "❌ OFF"}\n\n` +
            `*Commands:*\n` +
            `  ${prefix}antidemote on — Enable\n` +
            `  ${prefix}antidemote off — Disable`
          );
        }
        break;
      }

      // ── Anti Promote ────────────────────────────────────────────────────────────
      case "antipromote": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const apVal = (args[0] || "").toLowerCase();
        const apCurrent = security.getGroupSettings(from).antiPromote;
        if (apVal === "on") {
          security.setGroupSetting(from, "antiPromote", true);
          await reply(sock, msg, `⬆️ Anti Promote ✅ *enabled*\n_Unauthorized promotions will be reversed_`);
        } else if (apVal === "off") {
          security.setGroupSetting(from, "antiPromote", false);
          await reply(sock, msg, "⬆️ Anti Promote ❌ *disabled*");
        } else {
          await reply(sock, msg,
            `⬆️ *Anti Promote*\n\n` +
            `Status: ${apCurrent ? "✅ ON" : "❌ OFF"}\n\n` +
            `*Commands:*\n` +
            `  ${prefix}antipromote on — Enable\n` +
            `  ${prefix}antipromote off — Disable`
          );
        }
        break;
      }

      // ── Anti Edit ────────────────────────────────────────────────────────────
      case "antiedit": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const aeVal = (args[0] || "").toLowerCase();
        const aeCurrent = security.getGroupSettings(from).antiEdit;
        if (aeVal === "on") {
          security.setGroupSetting(from, "antiEdit", true);
          await reply(sock, msg, `✏️ Anti Edit ✅ *enabled*\n_Edited messages will be flagged/deleted_`);
        } else if (aeVal === "off") {
          security.setGroupSetting(from, "antiEdit", false);
          await reply(sock, msg, "✏️ Anti Edit ❌ *disabled*");
        } else {
          await reply(sock, msg,
            `✏️ *Anti Edit*\n\n` +
            `Status: ${aeCurrent ? "✅ ON" : "❌ OFF"}\n\n` +
            `*Commands:*\n` +
            `  ${prefix}antiedit on — Alert when messages are edited\n` +
            `  ${prefix}antiedit off — Disable`
          );
        }
        break;
      }

      // ── Clear Temp Files ─────────────────────────────────────────────────────
      case "cleartmp": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        try {
          const tmpDir = require("path").join(process.cwd(), "tmp");
          let deleted = 0;
          if (require("fs").existsSync(tmpDir)) {
            const files = require("fs").readdirSync(tmpDir);
            for (const f of files) {
              try {
                require("fs").unlinkSync(require("path").join(tmpDir, f));
                deleted++;
              } catch {}
            }
          }
          await reply(sock, msg,
            `🧹 *Temp Files Cleared*\n\n` +
            `✅ Deleted: ${deleted} file(s)\n` +
            `📁 Directory: /tmp`
          );
        } catch (e) {
          await reply(sock, msg, `❌ Failed to clear temp files: ${e.message}`);
        }
        break;
      }

      // ── Clear Session ─────────────────────────────────────────────────────────
      case "clearsession": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        try {
          const sessDir = require("path").join(process.cwd(), "auth_info_baileys");
          let deleted = 0, skipped = 0;
          if (require("fs").existsSync(sessDir)) {
            const files = require("fs").readdirSync(sessDir);
            for (const f of files) {
              if (f === "creds.json") { skipped++; continue; }
              try {
                require("fs").unlinkSync(require("path").join(sessDir, f));
                deleted++;
              } catch {}
            }
          }
          await reply(sock, msg,
            `🗂️ *Session Files Cleared*\n\n` +
            `✅ Deleted: ${deleted} file(s)\n` +
            `🔒 Skipped: ${skipped} (creds.json kept)\n\n` +
            `_Bot will continue running normally_`
          );
        } catch (e) {
          await reply(sock, msg, `❌ Failed to clear session: ${e.message}`);
        }
        break;
      }

      // ── Auto Status (view + react to status updates) ─────────────────────────
      case "autostatus": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const asArg = (args[0] || "").toLowerCase();
        if (asArg === "on") {
          settings.set("autoViewStatus", true);
          await reply(sock, msg, `👁️ *Auto Status: ENABLED*\n\nBot will automatically view all status updates.\n\nTip: use *${prefix}autostatus react on* to also react to statuses.`);
        } else if (asArg === "off") {
          settings.set("autoViewStatus", false);
          settings.set("autoLikeStatus", false);
          await reply(sock, msg, "👁️ *Auto Status: DISABLED*\n\nBot will stop viewing status updates.");
        } else if (asArg === "react") {
          const asReactArg = (args[1] || "").toLowerCase();
          if (asReactArg === "on") {
            settings.set("autoViewStatus", true);
            settings.set("autoLikeStatus", true);
            await reply(sock, msg, "❤️ *Auto Status React: ENABLED*\n\nBot will view AND react to all status updates with a random emoji.");
          } else if (asReactArg === "off") {
            settings.set("autoLikeStatus", false);
            await reply(sock, msg, "❤️ *Auto Status React: DISABLED*\n\nBot will still view but not react to status updates.");
          } else {
            await reply(sock, msg, `❤️ Usage: *${prefix}autostatus react on/off*`);
          }
        } else {
          const asView = !!settings.get("autoViewStatus");
          const asReact = !!settings.get("autoLikeStatus");
          await reply(sock, msg,
            `👁️ *Auto Status Settings*\n\n` +
            `• View Status: ${asView ? "✅ ON" : "❌ OFF"}\n` +
            `• React to Status: ${asReact ? "✅ ON" : "❌ OFF"}\n\n` +
            `*Commands:*\n` +
            `• *${prefix}autostatus on* — Enable auto-view\n` +
            `• *${prefix}autostatus off* — Disable all\n` +
            `• *${prefix}autostatus react on/off* — Toggle reactions`
          );
        }
        break;
      }

      // ── Channel JID Lookup ────────────────────────────────────────────────────
      case "chaneljid":
      case "channeljid":
      case "chjid": {
        if (!text) { await reply(sock, msg, `📢 Usage: *${prefix}chaneljid [WhatsApp channel link]*\n\nExample: _${prefix}chaneljid https://whatsapp.com/channel/..._`); break; }
        const chjidUrl = text.trim();
        if (!chjidUrl.includes("whatsapp.com/channel/")) { await reply(sock, msg, "❌ Invalid WhatsApp channel link. It should contain whatsapp.com/channel/"); break; }
        try {
          await sock.sendMessage(from, { react: { text: "🔍", key: msg.key } });
          const chjidCode = chjidUrl.split("whatsapp.com/channel/")[1]?.split(/[/?]/)[0];
          if (!chjidCode) { await reply(sock, msg, "❌ Could not extract channel code from link."); break; }
          const chjidRes = await sock.newsletterMetadata("invite", chjidCode);
          await reply(sock, msg,
            `📢 *Channel Info*\n\n` +
            `🆔 *JID:* ${chjidRes.id}\n` +
            `📛 *Name:* ${chjidRes.name || "N/A"}\n` +
            `👥 *Followers:* ${chjidRes.subscribers || chjidRes.followers || "N/A"}\n` +
            `📡 *State:* ${chjidRes.state || "N/A"}\n` +
            `✅ *Verified:* ${chjidRes.verification === "VERIFIED" ? "Yes" : "No"}`
          );
        } catch (e) {
          await reply(sock, msg, `❌ Failed to fetch channel info: ${e.message}`);
        }
        break;
      }

      // ── Auto Read Receipts ────────────────────────────────────────────────────
      case "autoreadreceipts":
      case "readreceipts": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Owner only."); break; }
        const arrArg = (args[0] || "").toLowerCase();
        const arrOpts = ["all", "contacts", "none"];
        if (!arrArg) {
          const arrCurr = settings.get("readReceipts") || "all";
          await reply(sock, msg,
            `📱 *Read Receipts Status:* ${arrCurr}\n\n` +
            `Usage: *${prefix}autoreadreceipts [option]*\n` +
            `Options: *all, contacts, none*\n\n` +
            `• *all* — Show read receipts to everyone\n` +
            `• *contacts* — Only contacts see receipts\n` +
            `• *none* — Hide read receipts from everyone`
          );
          break;
        }
        if (!arrOpts.includes(arrArg)) { await reply(sock, msg, `❌ Invalid option. Use: *all, contacts, none*`); break; }
        settings.set("readReceipts", arrArg);
        await reply(sock, msg, `📱 *Read Receipts* set to: *${arrArg.toUpperCase()}*`);
        break;
      }

      // ── Clear Messages (bulk delete bot's own messages) ───────────────────────
      case "clearmessages": {
        if (!isSuperAdminUser() && !isAdminUser) { await reply(sock, msg, "🔒 Admin or Owner only."); break; }
        const clNum = parseInt(args[0], 10) || 10;
        if (clNum > 100) { await reply(sock, msg, "❌ Max 100 messages at once."); break; }
        await reply(sock, msg, `🗑️ Attempting to delete up to ${clNum} of the bot's recent messages...`);
        let clDeleted = 0;
        try {
          for (let i = 0; i < clNum; i++) {
            try {
              const clFakeKey = { remoteJid: from, fromMe: true, id: `3EB0${Date.now()}${i}` };
              await sock.sendMessage(from, { delete: clFakeKey });
              clDeleted++;
              await new Promise(r => setTimeout(r, 100));
            } catch {}
          }
        } catch {}
        await reply(sock, msg, `✅ Done. Processed ${clDeleted} deletion attempt(s).`);
        break;
      }

      // ── Animu (anime GIF/image types) ─────────────────────────────────────────
      case "animu": {
        const animuTypes = ["nom", "poke", "cry", "kiss", "pat", "hug", "wink", "face-palm", "quote", "waifu", "neko", "loli"];
        const animuSub = (args[0] || "").toLowerCase().replace("_", "-");
        if (!animuSub || !animuTypes.includes(animuSub)) {
          await reply(sock, msg, `🎌 *Animu Command*\n\nUsage: *${prefix}animu [type]*\n\nTypes: ${animuTypes.join(", ")}\n\n_Example: ${prefix}animu hug_`);
          break;
        }
        try {
          if (animuSub === "waifu" || animuSub === "neko") {
            const animuRes = await axios.get(`https://api.siputzx.my.id/api/r/${animuSub}`, { responseType: "arraybuffer", timeout: 20000 });
            await sock.sendMessage(from, { image: Buffer.from(animuRes.data), caption: `🎌 anime: ${animuSub}` }, { quoted: msg });
          } else if (animuSub === "loli") {
            const animuRes = await axios.get("https://shizoapi.onrender.com/api/sfw/loli?apikey=shizo", { responseType: "arraybuffer", timeout: 20000 });
            await sock.sendMessage(from, { image: Buffer.from(animuRes.data), caption: `🎌 anime: ${animuSub}` }, { quoted: msg });
          } else {
            const animuRes = await axios.get(`https://api.some-random-api.com/animu/${animuSub}`, { timeout: 20000 });
            const animuData = animuRes.data;
            if (animuData?.link) {
              await sock.sendMessage(from, { image: { url: animuData.link }, caption: `🎌 anime: ${animuSub}` }, { quoted: msg });
            } else if (animuData?.quote) {
              await reply(sock, msg, animuData.quote);
            } else {
              await reply(sock, msg, "❌ Failed to fetch animu content.");
            }
          }
        } catch (e) {
          await reply(sock, msg, `❌ Animu fetch failed: ${e.message}`);
        }
        break;
      }

      // ── Fancy Text ────────────────────────────────────────────────────────────
      case "fancy": {
        const fancyStyleNames = Object.keys(FANCY_STYLES);
        let fancyQuery = text.trim();
        if (!fancyQuery) {
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          fancyQuery = quoted?.conversation || quoted?.extendedTextMessage?.text || "";
        }
        if (!fancyQuery) {
          await reply(sock, msg, `✨ *Fancy Text*\n\nUsage: *${prefix}fancy [text]*\nOr reply to a message with *${prefix}fancy*\n\n_Converts your text into stylish Unicode fonts_`);
          break;
        }
        if (fancyQuery.length > 200) { await reply(sock, msg, "📝 Text too long! Max 200 characters."); break; }
        let fancyOut = `✨ *Fancy Styles for:* ${fancyQuery}\n\n`;
        fancyStyleNames.forEach((styleName, i) => {
          fancyOut += `*${i + 1}.* [${styleName}]\n${applyFancyStyle(fancyQuery, styleName)}\n\n`;
        });
        fancyOut += `📌 Reply with a number (1-${fancyStyleNames.length}) to copy just that style.`;
        const fancySent = await sock.sendMessage(from, { text: fancyOut }, { quoted: msg });
        fancyReplyHandlers.set(fancySent.key.id, { styles: fancyStyleNames, query: fancyQuery });
        setTimeout(() => fancyReplyHandlers.delete(fancySent?.key?.id), 120000);
        break;
      }

      // ── Fetch URL ─────────────────────────────────────────────────────────────
      case "fetchurl":
      case "fetch": {
        if (!text) { await reply(sock, msg, `🔗 *Fetch URL*\n\nUsage: *${prefix}fetch [url]*\n\n_Downloads and sends the content of any URL_`); break; }
        const fetchTarget = text.trim().startsWith("http") ? text.trim() : `https://${text.trim()}`;
        try {
          await sock.sendMessage(from, { react: { text: "⏳", key: msg.key } });
          const fetchRes = await axios.get(fetchTarget, { responseType: "arraybuffer", timeout: 30000, maxContentLength: 50 * 1024 * 1024 });
          const fetchCT = fetchRes.headers["content-type"] || "";
          const fetchBuf = Buffer.from(fetchRes.data);
          const fetchFname = fetchTarget.split("/").pop().split("?")[0] || "file";
          if (fetchCT.includes("image/")) {
            await sock.sendMessage(from, { image: fetchBuf, caption: `🔗 ${fetchTarget.slice(0, 60)}` }, { quoted: msg });
          } else if (fetchCT.includes("video/")) {
            await sock.sendMessage(from, { video: fetchBuf, caption: `🔗 ${fetchTarget.slice(0, 60)}` }, { quoted: msg });
          } else if (fetchCT.includes("audio/")) {
            await sock.sendMessage(from, { audio: fetchBuf, mimetype: fetchCT, ptt: false }, { quoted: msg });
          } else if (fetchCT.includes("text/")) {
            const fetchText = fetchBuf.toString("utf8").slice(0, 4000);
            await reply(sock, msg, `🔗 *${fetchTarget.slice(0, 60)}*\n\n${fetchText}`);
          } else {
            await sock.sendMessage(from, { document: fetchBuf, mimetype: fetchCT || "application/octet-stream", fileName: fetchFname }, { quoted: msg });
          }
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `❌ Fetch failed: ${e.message}`);
        }
        break;
      }

      // ── Connect Four Game ─────────────────────────────────────────────────────
      case "connect4":
      case "c4": {
        const c4Sender = senderJid;
        const alreadyIn = Object.values(c4Games).find(g => (g.game.playerRed === c4Sender || g.game.playerYellow === c4Sender) && g.state !== "ENDED");
        if (alreadyIn) { await reply(sock, msg, "❌ You are already in a Connect Four game! Type *.forfeit* to quit."); break; }
        Object.keys(c4Games).forEach(id => {
          if (c4Games[id].state === "ENDED" || Date.now() - parseInt(id.split("-")[1] || 0) > 3600000) delete c4Games[id];
        });
        const c4Waiting = Object.values(c4Games).find(g => g.state === "WAITING" && g.chatId === from);
        if (c4Waiting) {
          c4Waiting.game.playerYellow = c4Sender;
          c4Waiting.state = "PLAYING";
          const c4Board = c4Waiting.game.render();
          await sock.sendMessage(from, {
            text: `🎮 *Connect Four Started!*\n\n${c4Board}\n\n🔴 Red: @${c4Waiting.game.playerRed.split("@")[0]}\n🟡 Yellow: @${c4Sender.split("@")[0]}\n\n🔴 Red goes first! Use *.drop [1-7]* to drop a disc.`,
            mentions: [c4Waiting.game.playerRed, c4Sender]
          }, { quoted: msg });
        } else {
          const c4Id = `c4-${Date.now()}`;
          c4Games[c4Id] = { id: c4Id, chatId: from, game: new ConnectFour(c4Sender, ""), state: "WAITING" };
          await reply(sock, msg, `⏳ *Connect Four Room Created!*\n\nWaiting for an opponent...\nType *.connect4* to join!\n\n🔴 You will be Red.\n\n*Commands:*\n• *.drop [1-7]* — Drop disc in column\n• *.forfeit* — Give up\n\n_Room expires in 5 minutes_`);
          setTimeout(() => {
            const g = c4Games[c4Id];
            if (g && g.state === "WAITING") { delete c4Games[c4Id]; sock.sendMessage(from, { text: "⌛ Connect Four room expired. No one joined." }).catch(() => {}); }
          }, 300000);
        }
        break;
      }

      case "drop": {
        const c4Col = args[0];
        if (!c4Col) { await reply(sock, msg, "Usage: *.drop [1-7]*"); break; }
        const c4Game = Object.values(c4Games).find(g => g.chatId === from && g.state === "PLAYING");
        if (!c4Game) { await reply(sock, msg, "❌ No active Connect Four game in this chat. Start one with *.connect4*"); break; }
        const c4G = c4Game.game;
        if (senderJid !== c4G.playerRed && senderJid !== c4G.playerYellow) { await reply(sock, msg, "❌ You are not a player in this game!"); break; }
        if (senderJid !== c4G.currentTurn) { await reply(sock, msg, `⏳ Not your turn! Waiting for @${c4G.currentTurn.split("@")[0]}`, ); break; }
        const c4Result = c4G.drop(c4Col);
        if (c4Result.error) { await reply(sock, msg, `❌ ${c4Result.error}`); break; }
        const c4Board = c4G.render();
        if (c4Result.winner) {
          c4Game.state = "ENDED";
          await sock.sendMessage(from, { text: `🎉 *Game Over!*\n\n${c4Board}\n\n🏆 @${senderJid.split("@")[0]} wins!`, mentions: [senderJid] }, { quoted: msg });
          delete c4Games[c4Game.id];
        } else if (c4Result.draw) {
          c4Game.state = "ENDED";
          await reply(sock, msg, `🤝 *Draw!*\n\n${c4Board}\n\nNo more moves!`);
          delete c4Games[c4Game.id];
        } else {
          const c4Next = c4G.currentTurn;
          await sock.sendMessage(from, {
            text: `${c4Board}\n\n${c4Next === c4G.playerRed ? "🔴" : "🟡"} @${c4Next.split("@")[0]}'s turn! Use *.drop [1-7]*`,
            mentions: [c4Next]
          }, { quoted: msg });
        }
        break;
      }

      case "forfeit": {
        const c4ForfGame = Object.values(c4Games).find(g => g.chatId === from && (g.game.playerRed === senderJid || g.game.playerYellow === senderJid) && g.state !== "ENDED");
        if (!c4ForfGame) { await reply(sock, msg, "❌ You are not in an active Connect Four game."); break; }
        const c4Opp = c4ForfGame.game.playerRed === senderJid ? c4ForfGame.game.playerYellow : c4ForfGame.game.playerRed;
        c4ForfGame.state = "ENDED";
        await sock.sendMessage(from, {
          text: `🏳️ @${senderJid.split("@")[0]} forfeited! ${c4Opp ? `🏆 @${c4Opp.split("@")[0]} wins!` : ""}`,
          mentions: [senderJid, c4Opp].filter(Boolean)
        }, { quoted: msg });
        delete c4Games[c4ForfGame.id];
        break;
      }

      // ── Chatbot Mode Toggle ───────────────────────────────────────────────────
      case "chatbot": {
        if (!isSuperAdminUser() && !isAdminUser) { await reply(sock, msg, "🔒 Admin or Owner only."); break; }
        const cbArg = (args[0] || "").toLowerCase();
        if (cbArg === "on") {
          setChatbotEnabled(from, true);
          await reply(sock, msg, `🤖 *Chatbot ENABLED* in this chat!\n\n_I will now reply to all messages with AI. Use *${prefix}chatbot off* to stop._`);
        } else if (cbArg === "off") {
          setChatbotEnabled(from, false);
          await reply(sock, msg, "🤖 *Chatbot DISABLED* in this chat.");
        } else {
          const cbStatus = isChatbotEnabled(from);
          await reply(sock, msg, `🤖 *Chatbot Status:* ${cbStatus ? "✅ ENABLED" : "❌ DISABLED"}\n\nUsage:\n• *${prefix}chatbot on* — Enable AI replies\n• *${prefix}chatbot off* — Disable AI replies`);
        }
        break;
      }

      // ── AI Variants ───────────────────────────────────────────────────────────
      case "bard":
      case "googleai": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}bard [question]*\n\nExample: _${prefix}bard What is AI?_`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📥", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const bardRes = await axios.get(`https://apiskeith.top/ai/bard?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!bardRes.data?.status || !bardRes.data?.result) throw new Error("No response from Bard");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *Google Bard AI*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${bardRes.data.result.trim()}\n\n> _Powered by Bard AI_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 Bard AI error: ${e.message}`);
        }
        break;
      }

      case "blackbox":
      case "bb": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}blackbox [question]*`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📥", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const bbRes = await axios.get(`https://apiskeith.top/ai/blackbox?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!bbRes.data?.status || !bbRes.data?.result) throw new Error("No response");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *BlackBox AI*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${bbRes.data.result.trim()}\n\n> _Powered by BlackBox AI_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 BlackBox AI error: ${e.message}`);
        }
        break;
      }

      case "copilot":
      case "msai": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}copilot [question]*`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📥", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const cpRes = await axios.get(`https://apiskeith.top/ai/copilot?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!cpRes.data?.status || !cpRes.data?.result) throw new Error("No response");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *Microsoft Copilot*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${cpRes.data.result.trim()}\n\n> _Powered by Copilot_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 Copilot error: ${e.message}`);
        }
        break;
      }

      case "ilama":
      case "llama": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}ilama [question]*`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📥", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const ilamaRes = await axios.get(`https://apiskeith.top/ai/ilama?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!ilamaRes.data?.status || !ilamaRes.data?.result) throw new Error("No response");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *iLama AI*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${ilamaRes.data.result.trim()}\n\n> _Powered by iLama AI_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 iLama AI error: ${e.message}`);
        }
        break;
      }

      case "metai":
      case "metalai": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}metai [question]*`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "⤵️", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const metaiRes = await axios.get(`https://apiskeith.top/ai/metai?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!metaiRes.data?.status || !metaiRes.data?.result) throw new Error("No response");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *Meta AI*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${metaiRes.data.result.trim()}\n\n> _Powered by Meta AI_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 Meta AI error: ${e.message}`);
        }
        break;
      }

      case "mistral": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}mistral [question]*`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📥", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const mistralRes = await axios.get(`https://apiskeith.top/ai/mistral?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!mistralRes.data?.status || !mistralRes.data?.result) throw new Error("No response");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *Mistral AI*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${mistralRes.data.result.trim()}\n\n> _Powered by Mistral_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 Mistral error: ${e.message}`);
        }
        break;
      }

      case "perplexity":
      case "pplx": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}perplexity [question]*`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📥", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const pplxRes = await axios.get(`https://apiskeith.top/ai/perplexity?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!pplxRes.data?.status || !pplxRes.data?.result) throw new Error("No response");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *Perplexity AI*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${pplxRes.data.result.trim()}\n\n> _Powered by Perplexity_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 Perplexity error: ${e.message}`);
        }
        break;
      }

      case "speechwriter":
      case "speech": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}speechwriter [topic/text]*\n\nGenerates a full speech on any topic`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📝", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const swRes = await axios.get(`https://apiskeith.top/ai/speechwriter?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          if (!swRes.data?.status || !swRes.data?.result) throw new Error("No response");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `📜 *Speechwriter AI*\n\n*Topic:* ${text}\n\n${swRes.data.result.trim()}\n\n> _Powered by Speechwriter AI_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 Speechwriter error: ${e.message}`);
        }
        break;
      }

      case "gpt4":
      case "aigpt4": {
        if (!text) { await reply(sock, msg, `🤖 Usage: *${prefix}gpt4 [question]*`); break; }
        try {
          await sock.sendMessage(from, { react: { text: "📥", key: msg.key } });
          await sock.sendPresenceUpdate("composing", from);
          const gpt4Res = await axios.get(`https://apiskeith.top/ai/gpt4?q=${encodeURIComponent(text)}`, { timeout: 30000 });
          const gpt4Answer = gpt4Res.data?.result || gpt4Res.data?.message || gpt4Res.data?.reply;
          if (!gpt4Answer) throw new Error("No response from GPT-4");
          await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
          await reply(sock, msg, `🤖 *GPT-4 AI*\n\n📝 *Query:* ${text}\n\n💬 *Response:*\n${gpt4Answer.trim()}\n\n> _Powered by GPT-4_`);
        } catch (e) {
          await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
          await reply(sock, msg, `🚫 GPT-4 error: ${e.message}`);
        }
        break;
      }

      default:
        await reply(sock, msg, `❓ Unknown: *${cmd}*\nType *${prefix}menu* to see all commands.`);
    }
  } catch (err) {
    console.error(`[CMD ERROR] ${cmd}:`, err.message);
    await reply(sock, msg, `❌ Error: ${err.message}`).catch(() => {});
  }
}

module.exports = { handle, buildCombinedMenuVideo, getCombinedMenuVideo, clearCombinedMenuVideo, isChatbotEnabled, setChatbotEnabled, fancyReplyHandlers };
