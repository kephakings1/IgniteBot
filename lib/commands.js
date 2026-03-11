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

function section(title, cmds) {
  return (
    `¬──f *${title}* ¬\n` +
    cmds.map((c) => ` ${c}`).join("\n") +
    `\n                              L`
  );
}

function buildMenu(p, senderName) {
  if (!p) p = getPrefix();
  const uptime = process.uptime();
  const hrs  = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const secs = Math.floor(uptime % 60);
  const mem      = process.memoryUsage();
  const usedMB   = (mem.heapUsed  / 1024 / 1024).toFixed(1);
  const totalMB  = (mem.heapTotal / 1024 / 1024).toFixed(1);
  const ramPct   = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const bar      = ramBar(ramPct);
  const mode     = settings.get("mode") || "public";
  const modeMap  = { public: "🌍 Public", private: "🔒 Private", group: "👥 Group" };
  const name     = senderName || "User";
  const BN        = settings.get("botName") || botName || "NEXUS V2";
  const ownerName = settings.get("ownerName") || "Nexus Tech";

  return (
    `¬──f *${BN}* ¬\n` +
    `| User: 🤖 ~•~ *${name}*\n` +
    `|\n` +
    `| Owner: *${ownerName}*\n` +
    `| Mode: ${modeMap[mode] || "🌍 Public"}\n` +
    `| Prefix: [${p}]\n` +
    `| Version: *2.0*\n` +
    `| Platform: 🤖 Replit\n` +
    `| Status: *Active*\n` +
    `| Uptime: *${hrs}h ${mins}m ${secs}s*\n` +
    `| RAM: ${bar} ${ramPct}%\n` +
    `| Memory: *${usedMB}MB / ${totalMB}MB*\n` +
    `                              L`
  );
}

function buildMenuSections(_p) {
  return [
    section("GENERAL", [
      "menu", "help", "menuv",
      "ping", "alive", "time", "date", "uptime", "stats",
    ]),
    section("AI & SMART", [
      "ai", "chat", "ask",
      "imagine", "image",
      "tts", "summarize", "summary", "clearchat",
    ]),
    section("SEARCH & INFO", [
      "weather",
      "wiki", "wikipedia",
      "define", "dict",
      "tr", "translate", "langs",
    ]),
    section("FUN & GAMES", [
      "8ball", "fact", "flip",
      "joke", "quote", "inspire", "roll",
    ]),
    section("TEXT TOOLS", [
      "aesthetic", "ae", "bold", "italic",
      "mock", "reverse", "emojify", "emoji",
      "upper", "lower", "repeat",
      "calc", "calculate",
    ]),
    section("MEDIA & MUSIC", [
      "play", "song", "p",
      "yt", "ytdl", "audio",
      "music", "dl", "download",
      "fbdl", "facebook",
      "pindl", "pinterest",
      "sticker", "s", "convert",
      "v", "vo", "viewonce", "reveal",
    ]),
    section("UTILITIES", [
      "pp", "pfp", "getpp",
      "qr", "short", "shorten",
      "whois", "profile",
    ]),
    section("GROUP MANAGEMENT", [
      "add", "kick", "kickall",
      "promote", "promoteall",
      "demote", "demoteall",
      "ban", "unban", "clearbanlist",
      "mute", "unmute", "open", "close",
      "warn", "resetwarn", "setwarn", "warnings",
      "del", "delete", "leave", "creategroup",
    ]),
    section("GROUP INFO & TAGGING", [
      "admins", "members", "count", "groupinfo",
      "link", "invitelink", "revoke", "resetlink",
      "glink", "grouplink",
      "setname", "rename",
      "setdesc", "desc",
      "seticon", "setgrouppp",
      "everyone", "all", "tagall",
      "hidetag", "htag", "stag", "poll",
    ]),
    section("WELCOME & GOODBYE", [
      "setwelcome", "setgoodbye",
      "welcome", "goodbye",
      "gctime", "antileave",
    ]),
    section("KEYWORDS & FILTER", [
      "addbadword", "removebadword", "listbadword",
      "keywords", "setkeyword", "delkeyword",
    ]),
    section("AUTO MODERATION", [
      "antisticker", "antimention", "antimentiongroup",
      "antitag", "antilink", "antispam",
      "antidelete", "antideletestatus",
      "anticall", "autoview", "autolike",
      "alwaysonline", "voreveal",
    ]),
    section("SETTINGS", [
      "botsettings", "features", "featurelist",
      "feature", "toggle",
      "setmode", "mode", "lang", "setprefix", "prefixless",
      "setowner", "setownername", "setbotname",
    ]),
    section("STORE & BOOKING", [
      "shop", "catalog", "order", "myorders",
      "services", "book", "mybookings", "cancel",
    ]),
    section("SUPER ADMIN", [
      "sudo", "removesudo", "unsudo", "sudolist",
      "broadcast", "pairing",
      "setmenuimage", "clearmenuimage",
      "setmenuvideo", "clearmenuvideo",
      "setmenusong", "clearmenusong",
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
        const fullCaption  = header + "\n\n" + sectionsText;

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
        if (!text) { await reply(sock, msg, `📥 Usage: *${prefix}dl [url]*`); break; }
        await reply(sock, msg, "📥 Downloading...");
        try {
          const info = await downloader.getVideoInfo(text);
          const mins = Math.floor(info.duration / 60);
          if (mins > 10) { await reply(sock, msg, `⚠️ Video too long (${mins} min). Max 10 min.`); break; }
          const dlResult = await downloader.downloadVideo(text);
          await sock.sendMessage(from, {
            video: fs.readFileSync(dlResult.path),
            caption: `🎬 *${dlResult.title}*`, mimetype: "video/mp4",
          }, { quoted: msg });
          fs.unlinkSync(dlResult.path);
        } catch (e) {
          await reply(sock, msg, `❌ Download failed: ${e.message}`);
        }
        break;
      }

      case "yt":
      case "ytdl":
      case "audio": {
        if (!text) { await reply(sock, msg, `🎵 Usage: *${prefix}yt [url]*`); break; }
        await reply(sock, msg, "🎵 Downloading audio...");
        try {
          const dlResult = await downloader.downloadAudio(text);
          await sock.sendMessage(from, {
            audio: fs.readFileSync(dlResult.path), mimetype: "audio/mpeg", ptt: false,
          }, { quoted: msg });
          await reply(sock, msg, `🎵 *${dlResult.title}*`);
          fs.unlinkSync(dlResult.path);
        } catch (e) {
          await reply(sock, msg, `❌ Failed: ${e.message}`);
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
        if (!text) { await reply(sock, msg, `📥 Usage: *${prefix}fbdl [facebook video url]*`); break; }
        await reply(sock, msg, "📥 Downloading Facebook video...");
        try {
          const result = await downloader.downloadFacebook(text);
          await sock.sendMessage(from, {
            video: fs.readFileSync(result.path),
            caption: `🎬 *${result.title}*\n_Downloaded via Nexus V2_`,
            mimetype: "video/mp4",
          }, { quoted: msg });
          fs.unlinkSync(result.path);
        } catch (e) {
          await reply(sock, msg, `❌ Facebook download failed: ${e.message}`);
        }
        break;
      }

      case "pindl":
      case "pinterest": {
        if (!text) { await reply(sock, msg, `📌 Usage: *${prefix}pindl [pinterest url]*`); break; }
        await reply(sock, msg, "📌 Downloading Pinterest media...");
        try {
          const result = await downloader.downloadPinterest(text);
          if (result.type === "video") {
            await sock.sendMessage(from, {
              video: fs.readFileSync(result.path),
              caption: `📌 *${result.title}*\n_Downloaded via Nexus V2_`,
              mimetype: "video/mp4",
            }, { quoted: msg });
            fs.unlinkSync(result.path);
          } else {
            await sock.sendMessage(from, {
              image: result.buffer,
              caption: `📌 *${result.title}*\n_Downloaded via Nexus V2_`,
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

      case "antidelete": {
        if (!isGroup) { await reply(sock, msg, "❌ Group only."); break; }
        if (!isAdminUser) { await reply(sock, msg, "🔒 Admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}antidelete on/off*`); break; }
        security.setGroupSetting(from, "antiDelete", val === "on");
        await reply(sock, msg, `🗑 Anti-delete ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
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

      default:
        await reply(sock, msg, `❓ Unknown: *${cmd}*\nType *${prefix}menu* to see all commands.`);
    }
  } catch (err) {
    console.error(`[CMD ERROR] ${cmd}:`, err.message);
    await reply(sock, msg, `❌ Error: ${err.message}`).catch(() => {});
  }
}

module.exports = { handle };
