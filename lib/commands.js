const path = require("path");
const fs = require("fs");
const os = require("os");
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
const keywords = require("./keywords");
const admin = require("./admin");
const settings = require("./settings");
const db = require("./db");
const textart = require("./textart");
const sports = require("./sports");
const perez = require("./perez");
const { prefix: defaultPrefix, botName } = require("../config");

function getPrefix() {
  return settings.get("prefix") || defaultPrefix;
}

function isPrefixless() {
  return !!settings.get("prefixless");
}

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
async function decryptViewOnce(sock, voInner, quotedCtx, fallbackJid) {
  const { downloadMediaMessage } = require("@whiskeysockets/baileys");
  const mediaType = Object.keys(voInner)[0]; // imageMessage | videoMessage | audioMessage
  if (!["imageMessage", "videoMessage", "audioMessage"].includes(mediaType)) return null;

  const fakeMsg = {
    key: {
      remoteJid: quotedCtx?.remoteJid || fallbackJid,
      id:        quotedCtx?.stanzaId  || ("vo-" + Date.now()),
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
  const caption = `🔓 *View Once Revealed* by Nexus V2\n${media.caption ? `_${media.caption}_` : ""}`.trim();
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
    `╭━━━〔 🤖 𝑵𝑬𝑿𝑼𝑺 𝑽2 𝑪𝑶𝑹𝑬 〕━━━╮\n` +
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
      "anime", "movie", "github", "gitclone",
      "apk", "app", "news", "inspect",
      "tweet", "pin", "quotely",
      "remini", "removebg", "attp", "smeme", "take",
      "request", "reportbug", "runtime",
      "upload", "hacker2", "trt", "translate",
      "mail", "whatsong", "shazam",
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
    ]),
    section("⚙️ BOT SETTINGS", [
      "botsettings", "features", "featurelist",
      "feature", "toggle",
      "setmode", "mode", "lang",
      "setprefix", "prefixless",
      "setowner", "setownername", "setbotname",
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

  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    "";

  analytics.trackMessage(senderJid).catch(() => {});

  if (settings.get("autoReadMessages")) {
    await sock.readMessages([msg.key]).catch(() => {});
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
        const menuPrefix   = getPrefix();
        const senderName   = msg.pushName || senderPhone;
        const header       = buildMenu(menuPrefix, senderName);
        const sections     = buildMenuSections(menuPrefix);
        const sectionsText = sections.join("\n\n");
        const footer       =
          `\n╭━━━〔 🚀 𝑵𝑬𝑿𝑼𝑺 𝑻𝑬𝑪𝑯 〕━━━╮\n` +
          `┃ Power • Speed • Intelligence\n` +
          `┃ made. by Ignatius\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯`;
        const fullCaption  = header + "\n\n" + sectionsText + "\n" + footer;

        // Send phonk song before the menu if one is set
        if (menuSong) {
          await sock.sendMessage(from, {
            audio:    menuSong,
            mimetype: "audio/mpeg",
            ptt:      false,
          }, { quoted: msg }).catch(() => {});
        }

        if (menuVideo) {
          await sock.sendMessage(from, {
            video:       menuVideo,
            caption:     fullCaption,
            mimetype:    "video/mp4",
            gifPlayback: false,
          }, { quoted: msg });
        } else if (menuImage) {
          await sock.sendMessage(from, {
            image:   menuImage,
            caption: fullCaption,
          }, { quoted: msg });
        } else {
          await reply(sock, msg, fullCaption);
        }
        break;
      }

      case "ping": {
        const start = Date.now();
        await sock.sendPresenceUpdate("recording", from).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        const latency = Date.now() - start - 500;
        const uptime = process.uptime();
        const hrs = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        const secs = Math.floor(uptime % 60);
        const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        const now = new Date();
        const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
        const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
        await reply(sock, msg,
          `🏓 *Pong!*\n\n` +
          `⚡ *${botName}* is online\n` +
          `📶 Latency: *${latency}ms*\n` +
          `⏱ Uptime: *${hrs}h ${mins}m ${secs}s*\n` +
          `🧠 Memory: *${memMB} MB*\n` +
          `📌 Prefix: *${prefix}*  |  Prefixless: *${prefixless ? "ON" : "OFF"}*\n` +
          `📅 Date: *${dateStr}*\n` +
          `🕐 Time: *${timeStr}*\n\n` +
          `_Made by Nexus V2_ ⚡`
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
          await reply(sock, msg, `👁 *Usage:* Reply to a view-once message with *${prefix}v* to reveal it.`);
          break;
        }

        // Extract the inner message from any view-once container variant
        const voInner =
          quotedRaw.viewOnceMessage?.message ||
          quotedRaw.viewOnceMessageV2?.message ||
          quotedRaw.viewOnceMessageV2Extension?.message;

        if (!voInner) {
          await reply(sock, msg, "❌ That is not a view-once message.");
          break;
        }

        await reply(sock, msg, "🔓 Decrypting view-once...");
        try {
          const revealed = await decryptViewOnce(sock, voInner, quotedCtx, from);
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
              caption: `🎬 *${dlResult.title}*\n_Powered by Nexus V2 ⚡_`, mimetype: "video/mp4",
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
              caption: `🎬 *${dlResult.title}*\n_Powered by Nexus V2 ⚡_`, mimetype: "video/mp4",
            }, { quoted: msg });
          } else {
            await sock.sendMessage(from, {
              audio: fs.readFileSync(dlResult.path), mimetype: "audio/mpeg", ptt: false,
            }, { quoted: msg });
            await reply(sock, msg, `🎵 *${dlResult.title}*\n_Powered by Nexus V2 ⚡_`);
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
            `_Powered by Nexus V2 ⚡_`
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
              caption: `🎬 *${result.title}*\n_Powered by Nexus V2 ⚡_`, mimetype: "video/mp4",
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
              caption: `📌 *${result.title}*\n_Powered by Nexus V2 ⚡_`, mimetype: "video/mp4",
            }, { quoted: msg });
            try { fs.unlinkSync(result.path); } catch {}
          } else if (result.buffer) {
            await sock.sendMessage(from, {
              image: result.buffer,
              caption: `📌 *${result.title}*\n_Powered by Nexus V2 ⚡_`,
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
            `_Every message is auto-logged. Powered by Nexus V2 ⚡_`
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
          const cur = settings.get("botName") || botName || "NEXUS V2";
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
        const numArg = text.replace(/\D/g, "");
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
        const numArg = text.replace(/\D/g, "");
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
        await reply(sock, msg, "✅ Menu image set! It will now appear when someone opens the menu.");
        break;
      }

      case "clearmenuimage": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        settings.clearMenuImage();
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
        await reply(sock, msg, "✅ Menu song set! It will play every time someone opens the menu 🎵");
        break;
      }

      case "clearmenusong": {
        if (!isSuperAdminUser()) { await reply(sock, msg, "🔒 Super admin only."); break; }
        settings.clearMenuSong();
        await reply(sock, msg, "✅ Menu song cleared.");
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
      case "date":
        await reply(sock, msg, `🕐 *Time:* ${new Date().toUTCString()}`);
        break;

      case "uptime": {
        const ut = process.uptime();
        const h = Math.floor(ut / 3600), m = Math.floor((ut % 3600) / 60), s = Math.floor(ut % 60);
        const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        await reply(sock, msg,
          `╔══════════════════╗\n║  ⚡ *NEXUS V2 STATUS*  ║\n╚══════════════════╝\n\n` +
          `🟢 *Status:* Online\n⏱ *Uptime:* ${h}h ${m}m ${s}s\n💾 *RAM:* ${mem} MB\n🤖 *Prefix:* ${prefix}\n📅 *Date:* ${new Date().toUTCString()}`
        );
        break;
      }

      case "alive": {
        await reply(sock, msg,
          `╔═══════════════════╗\n║  🤖 *NEXUS V2 ALIVE* ║\n╚═══════════════════╝\n\n` +
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
        const numToAdd = text.replace(/\D/g, "");
        if (!numToAdd || numToAdd.length < 7) { await reply(sock, msg, `➕ Usage: \`${prefix}add 2348012345678\``); break; }
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
            caption: "🐦 *Twitter Video*\n_Powered by Nexus V2 ⚡_",
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
          await reply(sock, msg, `🎵 *${ytaResult.title}*\n_Powered by Nexus V2 ⚡_`);
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
            caption: `🎬 *${ytvResult.title}*\n_Powered by Nexus V2 ⚡_`,
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
          await reply(sock, msg, `🎵 *${top.title}*\n_Powered by Nexus V2 ⚡_`);
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
            caption: `🎬 *${top.title}*\n_Powered by Nexus V2 ⚡_`,
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
            caption: `🎨 *${artResult.style}* — _${text}_\n_Powered by Nexus V2 ⚡_`,
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
            caption: "💻 *Carbon Code*\n_Powered by Nexus V2 ⚡_",
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
            caption: `🐦 *Fake Tweet*\n_Powered by Nexus V2 ⚡_`,
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
        const blockTarget = getMentioned(msg)[0] || getQuotedJid(msg) || (text ? `${text.replace(/\D/g, "")}@s.whatsapp.net` : null);
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
        const unblockTarget = getMentioned(msg)[0] || getQuotedJid(msg) || (text ? `${text.replace(/\D/g, "")}@s.whatsapp.net` : null);
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
            await sock.sendMessage(from, { image: Buffer.from(remResp.data), caption: "🖼 *Enhanced Image*\n_Powered by Nexus V2 ⚡_" }, { quoted: msg });
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
          const stickerBuf = await sticker.imageToSticker(takeBuf, msg.pushName || "Nexus V2", msg.pushName || "User");
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
          `╭━━━〔 🤖 𝑵𝑬𝑿𝑼𝑺 𝑽2 〕━━━╮\n` +
          `┃\n` +
          `┃ 📦 *GitHub Repository*\n` +
          `┃ Fork • Deploy • Copy URL\n` +
          `┃ 🔗 https://github.com/Ignatiusperez/Perez/\n` +
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
          await sock.sendMessage(from, { image: Buffer.from(h2Result.data), caption: "🖥️ *Hacker Filter Applied*\n_Powered by Nexus V2 ⚡_" }, { quoted: msg });
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
        const vvQuoted = getQuotedMsg(msg);
        if (!vvQuoted) { await reply(sock, msg, "👁 Quote a view-once message to retrieve."); break; }
        try {
          const vvType = Object.keys(vvQuoted)[0];
          if (vvQuoted.imageMessage?.viewOnce || vvQuoted.videoMessage?.viewOnce || vvType === "viewOnceMessage" || vvType === "viewOnceMessageV2") {
            const innerMsg = vvQuoted.viewOnceMessage?.message || vvQuoted.viewOnceMessageV2?.message || vvQuoted;
            const vvBuf = await getMediaBuffer(sock, { key: msg.key, message: innerMsg });
            if (!vvBuf) { await reply(sock, msg, "❌ Could not download view-once media."); break; }
            if (innerMsg.imageMessage) {
              await sock.sendMessage(from, { image: vvBuf, caption: "👁 *View Once Retrieved*" }, { quoted: msg });
            } else if (innerMsg.videoMessage) {
              await sock.sendMessage(from, { video: vvBuf, caption: "👁 *View Once Retrieved*" }, { quoted: msg });
            } else {
              await reply(sock, msg, "❌ Unsupported view-once type.");
            }
          } else {
            await reply(sock, msg, "❌ That's not a view-once message.");
          }
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

      default:
        await reply(sock, msg, `❓ Unknown: *${cmd}*\nType *${prefix}menu* to see all commands.`);
    }
  } catch (err) {
    console.error(`[CMD ERROR] ${cmd}:`, err.message);
    await reply(sock, msg, `❌ Error: ${err.message}`).catch(() => {});
  }
}

module.exports = { handle };
