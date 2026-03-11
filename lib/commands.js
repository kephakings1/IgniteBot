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

function getMentioned(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

function getQuotedMsg(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
}

function getQuotedJid(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.participant;
}

function buildMenu(p) {
  if (!p) p = getPrefix();
  const pl = isPrefixless();
  const pNote = pl ? `\n_✅ Prefixless mode ON — commands work with or without \`${p}\`_` : "";
  return `╔═══════════════════════╗
║     ⚡ *${botName}* ⚡     ║
╚═══════════════════════╝
_Prefix: \`${p}\`  • Prefixless: ${pl ? "ON" : "OFF"}_${pNote}

🤖 *AI Features*
› \`${p}ai [text]\` — Smart AI chat
› \`${p}ask [question]\` — Get answers
› \`${p}imagine [prompt]\` — Generate image
› \`${p}tts [text]\` — Text to speech
› \`${p}summarize [text]\` — Summarize text
› \`${p}clearchat\` — Clear AI history

🌍 *Tools*
› \`${p}tr [lang] [text]\` — Translate text
› \`${p}langs\` — List languages
› \`${p}dl [url]\` — Download video
› \`${p}yt [url]\` — Download audio
› \`${p}music [query]\` — Search music
› \`${p}convert\` — Convert file (reply)
› \`${p}sticker\` — Make sticker (reply)

🛒 *Shopping*
› \`${p}shop\` — View product catalog
› \`${p}order [id]\` — Place an order
› \`${p}myorders\` — Your orders

📅 *Booking*
› \`${p}services\` — Available services
› \`${p}book [#] [date] [time]\` — Book
› \`${p}mybookings\` — Your bookings
› \`${p}cancel [id]\` — Cancel booking

📊 *Info & Settings*
› \`${p}stats\` — Bot analytics
› \`${p}groupinfo\` — Group info
› \`${p}lang [code]\` — Set language
› \`${p}botsettings\` — View settings
› \`${p}ping\` — Check bot status
› \`${p}menu\` — This menu

🔒 *Group Admin*
› \`${p}kick @user\` — Kick member
› \`${p}promote @user\` — Promote
› \`${p}demote @user\` — Demote
› \`${p}mute\` / \`${p}unmute\`
› \`${p}tagall [msg]\` — Tag all
› \`${p}antilink on/off\`
› \`${p}antispam on/off\`
› \`${p}antidelete on/off\`
› \`${p}antimentiongroup on/off\`
› \`${p}antitag on/off\`
› \`${p}setwelcome [msg]\`

⚙️ *Bot Admin Controls*
› \`${p}mode public/private/group\`
› \`${p}setprefix [char]\` — Change prefix
› \`${p}prefixless on/off\` — Toggle prefixless
› \`${p}autoview on/off\`
› \`${p}autolike on/off\`
› \`${p}alwaysonline on/off\`
› \`${p}anticall on/off\`
› \`${p}antideletestatus on/off\`
› \`${p}broadcast [msg]\`
› \`${p}setkeyword [trigger]|[reply]\`
› \`${p}delkeyword [trigger]\`
› \`${p}keywords\`
› \`${p}setmenuvideo\` — Set menu video
› \`${p}clearmenuvideo\`
› \`${p}ban @user\` / \`${p}unban\`
› \`${p}warn @user\`

🔗 *Session*
› \`${p}pairing [number]\` — Get pairing code

_Type \`${p}menu\` anytime for this list_`;
}

async function handle(sock, msg) {
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  const senderJid = isGroup
    ? msg.key.participant || msg.key.remoteJid
    : msg.key.remoteJid;
  const senderPhone = senderJid.split("@")[0].split(":")[0];

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
  const isAdminUser = admin.isAdmin(senderJid, groupParticipants);

  const botMode = settings.get("mode");
  if (botMode === "private" && !admin.isSuperAdmin(senderJid)) return;
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

  await sock.sendPresenceUpdate("composing", from).catch(() => {});

  try {
    switch (cmd) {

      case "menu":
      case "help":
      case "menuv": {
        const menuVideo = settings.getMenuVideo();
        if (menuVideo) {
          await sock.sendMessage(from, {
            video: menuVideo,
            caption: buildMenu(),
            mimetype: "video/mp4",
            gifPlayback: false,
          }, { quoted: msg });
        } else {
          await reply(sock, msg, buildMenu());
        }
        break;
      }

      case "ping": {
        const start = Date.now();
        await sock.sendPresenceUpdate("composing", from).catch(() => {});
        const latency = Date.now() - start;
        const uptime = process.uptime();
        const hrs = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        const secs = Math.floor(uptime % 60);
        const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
        await reply(sock, msg,
          `🏓 *Pong!*\n\n` +
          `⚡ *${botName}* is online\n` +
          `📶 Latency: *${latency}ms*\n` +
          `⏱ Uptime: *${hrs}h ${mins}m ${secs}s*\n` +
          `🧠 Memory: *${memMB} MB*\n` +
          `📌 Prefix: *${prefix}*  |  Prefixless: *${prefixless ? "ON" : "OFF"}*`
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

      case "mode": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const mode = args[0]?.toLowerCase();
        if (!["public", "private", "group"].includes(mode)) {
          await reply(sock, msg, `⚙️ Usage: *${prefix}mode public/private/group*\n\n🌍 *public* — Responds to everyone\n🔒 *private* — Super admins only\n👥 *group* — Groups only`);
          break;
        }
        settings.set("mode", mode);
        const icons = { public: "🌍", private: "🔒", group: "👥" };
        await reply(sock, msg, `${icons[mode]} Bot mode set to *${mode.toUpperCase()}*`);
        break;
      }

      case "setprefix": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
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
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
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
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}autoview on/off*`); break; }
        settings.set("autoViewStatus", val === "on");
        await reply(sock, msg, `👁 Auto view status ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "autolike": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}autolike on/off*`); break; }
        settings.set("autoLikeStatus", val === "on");
        await reply(sock, msg, `❤️ Auto like status ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "alwaysonline": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}alwaysonline on/off*`); break; }
        settings.set("alwaysOnline", val === "on");
        await reply(sock, msg, `🟢 Always online ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "anticall": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const val = args[0]?.toLowerCase();
        if (val !== "on" && val !== "off") { await reply(sock, msg, `Usage: *${prefix}anticall on/off*`); break; }
        settings.set("antiCall", val === "on");
        await reply(sock, msg, `📵 Anti-call ${val === "on" ? "✅ *enabled*" : "❌ *disabled*"}`);
        break;
      }

      case "antideletestatus": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
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

      case "setmenuvideo": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
        const vidMsg = msg.message?.videoMessage || getQuotedMsg(msg)?.videoMessage;
        if (!vidMsg) { await reply(sock, msg, `🎬 Reply to a video with *${prefix}setmenuvideo* to set it as the menu video.`); break; }
        await reply(sock, msg, "⏳ Saving menu video...");
        const targetMsg = msg.message?.videoMessage ? msg : { key: msg.key, message: getQuotedMsg(msg) };
        const videoBuf = await getMediaBuffer(sock, targetMsg);
        if (!videoBuf) { await reply(sock, msg, "❌ Could not download video."); break; }
        settings.setMenuVideo(videoBuf);
        await reply(sock, msg, "✅ Menu video set! Now *!menu* will send a video with the menu.");
        break;
      }

      case "clearmenuvideo": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
        settings.clearMenuVideo();
        await reply(sock, msg, "✅ Menu video cleared.");
        break;
      }

      case "pairing": {
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
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
        if (!admin.isSuperAdmin(senderJid)) { await reply(sock, msg, "🔒 Super admin only."); break; }
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
        await reply(sock, msg, `🕐 *Time:* ${new Date().toUTCString()}`);
        break;

      default:
        await reply(sock, msg, `❓ Unknown: *${cmd}*\nType *${prefix}menu* to see all commands.`);
    }
  } catch (err) {
    console.error(`[CMD ERROR] ${cmd}:`, err.message);
    await reply(sock, msg, `❌ Error: ${err.message}`).catch(() => {});
  }
}

module.exports = { handle };
