const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const MEDIA_TYPES = [
  'imageMessage', 'videoMessage', 'audioMessage',
  'stickerMessage', 'documentMessage', 'ptvMessage',
];

// Batch pending deletions per chat — collects rapid multi-deletes into one alert
const _pendingDeletes = new Map();
const BATCH_WINDOW_MS = 2500;

// Format a raw JID number as a proper phone number with + prefix
function _phone(jid = '') {
  const num = jid.split('@')[0].split(':')[0];
  return num ? `+${num}` : '?';
}

module.exports = async function handleProtocolMessage(
  sock, msg, settings, security, mediaCache, ownerJid
) {
  const proto = msg.message?.protocolMessage;
  if (!proto) return false;

  const from      = msg.key.remoteJid;
  const senderJid = msg.key.participant || from;
  const isGroup   = from.endsWith('@g.us');
  const _tz       = settings.get('timezone') || 'Africa/Nairobi';

  const now = () => new Date();

  function _timeStr(d = now()) {
    return d.toLocaleTimeString('en-US',
      { timeZone: _tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }
  function _dateStr(d = now()) {
    return d.toLocaleDateString('en-GB',
      { timeZone: _tz, day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── ANTIDELETE ────────────────────────────────────────────────────────────
  if (proto.type === 0 && proto.key?.id) {
    const mode = settings.get('antiDeleteMode') || 'off';
    if (mode === 'off') return true;

    const deletedId  = proto.key.id;
    const deleterJid = senderJid;
    const cached     = security.getCachedMessage(deletedId);
    const original   = cached?.msg;

    if (!original) return true;
    if (msg.key.fromMe) return true;

    // Stamp the exact deletion time right now before the batch timer fires
    const deletedAt = now();

    const batchKey = from + '::' + mode;
    if (!_pendingDeletes.has(batchKey)) {
      _pendingDeletes.set(batchKey, { timer: null, items: [], from, isGroup, mode });
    }
    const batch = _pendingDeletes.get(batchKey);
    batch.items.push({ original, deletedId, deleterJid, deletedAt });

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      _pendingDeletes.delete(batchKey);
      await _flushBatch(batch, sock, settings, mediaCache, ownerJid, _timeStr, _dateStr);
    }, BATCH_WINDOW_MS);

    return true;
  }

  // ── ANTIEDIT ──────────────────────────────────────────────────────────────
  const editedText =
    proto.editedMessage?.conversation ||
    proto.editedMessage?.extendedTextMessage?.text;

  if (editedText) {
    const mode = settings.get('antiEditMode') || 'off';
    if (mode === 'off') return true;

    const editedId  = proto.key?.id;
    const editorJid = senderJid;
    const cached    = security.getCachedMessage(editedId);
    const original  = cached?.msg;

    if (!original) return true;

    const senderNum    = _phone(original.key?.participant || original.key?.remoteJid);
    const editorNum    = _phone(editorJid);
    const originalText = original.message?.conversation ||
                         original.message?.extendedTextMessage?.text || '_(non-text)_';
    const chatLabel    = isGroup ? 'Group Chat' : 'Private Chat';
    const editedAt     = now();

    const report =
      `✏️ *EDITED MESSAGE DETECTED* ✏️\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Sender:* ${senderNum}\n` +
      `✏️ *Edited by:* ${editorNum}\n` +
      `⏰ *Edited at:* ${_timeStr(editedAt)}\n` +
      `📅 *Date:* ${_dateStr(editedAt)}\n` +
      `💬 *Chat:* ${chatLabel}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📝 *Original message:*\n${originalText}\n\n` +
      `✏️ *Edited to:*\n${editedText}`;

    const mentions = [
      original.key?.participant || original.key?.remoteJid,
      editorJid,
    ].filter(Boolean);

    const sendToChat  = ['chat', 'group', 'both', 'all'].includes(mode);
    const sendToOwner = ['private', 'both', 'all', 'on'].includes(mode);

    if (sendToChat)
      await sock.sendMessage(from, { text: report, mentions }).catch(() => {});
    if (sendToOwner && ownerJid && ownerJid !== from)
      await sock.sendMessage(ownerJid, { text: report, mentions }).catch(() => {});

    return true;
  }

  return true;
};

// ── Flush batched deletions as one alert ──────────────────────────────────
async function _flushBatch(batch, sock, settings, mediaCache, ownerJid, _timeStr, _dateStr) {
  const { items, from, isGroup, mode } = batch;
  if (!items.length) return;

  const sendToChat  = ['chat', 'group', 'both', 'all'].includes(mode) &&
                      (isGroup || mode === 'chat' || mode === 'both' || mode === 'all');
  const sendToOwner = ['private', 'both', 'all', 'on'].includes(mode);

  const chatLabel    = isGroup ? 'Group Chat' : 'Private Chat';
  const count        = items.length;
  const deleterNum   = _phone(items[0].deleterJid);
  const deletedAt    = items[0].deletedAt; // time of first deletion in the batch

  // ── Single deletion — full detail + media recovery ──────────────────────
  if (count === 1) {
    const { original, deletedId, deleterJid, deletedAt: dat } = items[0];
    const senderNum = _phone(original.key?.participant || original.key?.remoteJid);

    const header =
      `🗑️ *DELETED MESSAGE* 🗑️\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Sender:* ${senderNum}\n` +
      `🗑️ *Deleted by:* ${_phone(deleterJid)}\n` +
      `⏰ *Deleted at:* ${_timeStr(dat)}\n` +
      `📅 *Date:* ${_dateStr(dat)}\n` +
      `💬 *Chat:* ${chatLabel}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━`;

    const mentions = [
      original.key?.participant || original.key?.remoteJid,
      deleterJid,
    ].filter(Boolean);

    const sendFn = (dest) => _sendRecovered(
      sock, dest, original, deletedId, mediaCache, header, mentions
    );

    if (sendToChat)  await sendFn(from);
    if (sendToOwner && ownerJid && ownerJid !== from) await sendFn(ownerJid);
    return;
  }

  // ── Multiple deletions — one combined summary ────────────────────────────
  const allMentions = [];
  const lines = [];

  for (let i = 0; i < items.length; i++) {
    const { original, deleterJid, deletedAt: dat } = items[i];
    const senderNum = _phone(original.key?.participant || original.key?.remoteJid);
    const origMsg   = original.message || {};
    const origType  = Object.keys(origMsg)[0];
    const text      = origMsg.conversation || origMsg.extendedTextMessage?.text;
    const content   = text
      ? `"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`
      : `[${(origType || 'unknown').replace('Message', '')}]`;

    lines.push(
      `🗑️ *#${i + 1}*\n` +
      `   👤 From: ${senderNum}\n` +
      `   ⏰ At: ${_timeStr(dat)}\n` +
      `   💬 ${content}`
    );

    const sJid = original.key?.participant || original.key?.remoteJid;
    if (sJid && !allMentions.includes(sJid))        allMentions.push(sJid);
    if (!allMentions.includes(deleterJid))           allMentions.push(deleterJid);
  }

  const combined =
    `🗑️ *DELETED MESSAGES DETECTED* 🗑️\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🗑️ *Deleted by:* ${deleterNum}\n` +
    `⏰ *Time:* ${_timeStr(deletedAt)}\n` +
    `📅 *Date:* ${_dateStr(deletedAt)}\n` +
    `💬 *Chat:* ${chatLabel}\n` +
    `🔢 *Count:* ${count} messages\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    lines.join('\n\n');

  if (sendToChat)
    await sock.sendMessage(from, { text: combined, mentions: allMentions }).catch(() => {});
  if (sendToOwner && ownerJid && ownerJid !== from)
    await sock.sendMessage(ownerJid, { text: combined, mentions: allMentions }).catch(() => {});
}

// ── Send a single recovered message (text or media) ───────────────────────
async function _sendRecovered(sock, destJid, original, deletedId, mediaCache, header, mentions) {
  try {
    const origMsg  = original.message || {};
    const origType = Object.keys(origMsg)[0];
    const text     = origMsg.conversation || origMsg.extendedTextMessage?.text;

    if (text) {
      await sock.sendMessage(destJid, {
        text: `${header}\n\n🗑️ *Deleted message:*\n${text}`,
        mentions,
      }).catch(() => {});
      return;
    }

    if (!MEDIA_TYPES.includes(origType)) {
      await sock.sendMessage(destJid, {
        text: `${header}\n\n🗑️ _[${(origType || 'unknown').replace('Message', '')} — could not retrieve]_`,
      }).catch(() => {});
      return;
    }

    const eager   = mediaCache.get(deletedId);
    let mediaBuf  = eager?.buffer || null;
    let msgData   = origMsg[origType] || {};

    if (eager) {
      msgData = {
        mimetype:    eager.mimetype    || msgData.mimetype,
        ptt:         eager.ptt         ?? msgData.ptt,
        caption:     eager.caption     || msgData.caption,
        fileName:    eager.fileName    || msgData.fileName,
        gifPlayback: eager.gifPlayback ?? msgData.gifPlayback,
      };
    }

    if (!mediaBuf) {
      mediaBuf = await downloadMediaMessage(original, 'buffer', {}).catch(() => null);
    }

    if (!mediaBuf) {
      await sock.sendMessage(destJid, {
        text: `${header}\n\n🗑️ _[Media could not be retrieved — it may have expired]_`,
      }).catch(() => {});
      return;
    }

    const caption = `${header}${msgData.caption ? `\n\n🗑️ _${msgData.caption}_` : ''}`;

    if (origType === 'stickerMessage') {
      await sock.sendMessage(destJid, { sticker: mediaBuf }).catch(() => {});
      await sock.sendMessage(destJid, { text: `${header}\n\n🗑️ _(sticker deleted)_` }).catch(() => {});
    } else if (origType === 'audioMessage') {
      await sock.sendMessage(destJid, {
        audio:    mediaBuf,
        mimetype: msgData.mimetype || (msgData.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
        ptt:      msgData.ptt || false,
      }).catch(() => {});
      await sock.sendMessage(destJid, {
        text: `${header}\n\n🗑️ _(${msgData.ptt ? 'voice note' : 'audio'} deleted)_`,
      }).catch(() => {});
    } else if (origType === 'videoMessage' || origType === 'ptvMessage') {
      await sock.sendMessage(destJid, {
        video:       mediaBuf,
        caption,
        mimetype:    msgData.mimetype || 'video/mp4',
        gifPlayback: msgData.gifPlayback || false,
      }).catch(() => {});
    } else if (origType === 'imageMessage') {
      await sock.sendMessage(destJid, {
        image:   mediaBuf,
        caption,
      }).catch(() => {});
    } else if (origType === 'documentMessage') {
      await sock.sendMessage(destJid, {
        document: mediaBuf,
        mimetype: msgData.mimetype || 'application/octet-stream',
        fileName: msgData.fileName || 'file',
        caption:  header,
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[antidelete] sendRecovered error:', err.message);
  }
}
