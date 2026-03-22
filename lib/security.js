const db = require('./datastore');
const { spamThreshold, spamWindowMs } = require('../config');

const DEFAULTS = {
  groupSettings: {},
  warnings: {},
  bannedUsers: [],
};

const spamTracker = new Map();
const messageCache = new Map();
const statusCache = new Map();
const longTextWarn = new Map();

const URL_REGEX = /(?:https?:\/\/|www\.)[a-zA-Z0-9-]+(?:\.[a-zA-Z]{2,})+(?:\/[^\s]*)?/gi;

const GROUP_DEFAULTS = {
  antiLink: false,
  antiSpam: true,
  antiDelete: false,
  antiMentionGroup: false,
  antiTag: false,
  antiSticker: false,
  antiLongText: false,
  antiLeave: false,
  maxTextLen: 500,
  linkWhitelist: [],
};

function getGroupSettings(groupId) {
  const data = db.read('security', DEFAULTS);
  return Object.assign({}, GROUP_DEFAULTS, data.groupSettings[groupId] || {});
}

function setGroupSetting(groupId, key, value) {
  db.update('security', DEFAULTS, (data) => {
    if (!data.groupSettings[groupId]) {
      data.groupSettings[groupId] = { ...GROUP_DEFAULTS };
    }
    data.groupSettings[groupId][key] = value;
  });
}

function isSpam(userId) {
  const now = Date.now();
  if (!spamTracker.has(userId)) spamTracker.set(userId, []);
  const timestamps = spamTracker.get(userId).filter((t) => now - t < spamWindowMs);
  timestamps.push(now);
  spamTracker.set(userId, timestamps);
  return timestamps.length > spamThreshold;
}

function hasLink(text) {
  const re = new RegExp(URL_REGEX.source, 'gi');
  return re.test(text);
}

function hasMassMention(msg, threshold = 5) {
  const mentions =
    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    msg.message?.imageMessage?.contextInfo?.mentionedJid ||
    msg.message?.videoMessage?.contextInfo?.mentionedJid ||
    [];
  return mentions.length >= threshold;
}

function cacheMessage(key, msgObj) {
  messageCache.set(key, { msg: msgObj, time: Date.now() });
  if (messageCache.size > 1000) {
    const oldest = [...messageCache.keys()][0];
    messageCache.delete(oldest);
  }
}

function getCachedMessage(key) {
  return messageCache.get(key);
}

function cacheStatus(key, msgObj) {
  statusCache.set(key, { msg: msgObj, time: Date.now() });
  if (statusCache.size > 500) {
    const oldest = [...statusCache.keys()][0];
    statusCache.delete(oldest);
  }
}

function getCachedStatus(key) {
  return statusCache.get(key);
}

function warnUser(userId) {
  let count = 0;
  db.update('security', DEFAULTS, (data) => {
    data.warnings[userId] = (data.warnings[userId] || 0) + 1;
    count = data.warnings[userId];
  });
  return count;
}

function getWarnings(userId) {
  const data = db.read('security', DEFAULTS);
  return data.warnings[userId] || 0;
}

function clearWarnings(userId) {
  db.update('security', DEFAULTS, (data) => {
    data.warnings[userId] = 0;
  });
}

function isBanned(userId) {
  const data = db.read('security', DEFAULTS);
  return (data.bannedUsers || []).includes(userId);
}

function banUser(userId) {
  db.update('security', DEFAULTS, (data) => {
    if (!data.bannedUsers) data.bannedUsers = [];
    if (!data.bannedUsers.includes(userId)) data.bannedUsers.push(userId);
  });
}

function unbanUser(userId) {
  db.update('security', DEFAULTS, (data) => {
    data.bannedUsers = (data.bannedUsers || []).filter((u) => u !== userId);
  });
}

function trackLongText(userId, groupId, limit = 3) {
  const key = userId + ':' + groupId;
  const count = (longTextWarn.get(key) || 0) + 1;
  longTextWarn.set(key, count);
  return count;
}

function clearLongTextWarn(userId, groupId) {
  longTextWarn.delete(userId + ':' + groupId);
}

module.exports = {
  getGroupSettings,
  setGroupSetting,
  isSpam,
  hasLink,
  hasMassMention,
  cacheMessage,
  getCachedMessage,
  cacheStatus,
  getCachedStatus,
  warnUser,
  getWarnings,
  clearWarnings,
  isBanned,
  banUser,
  unbanUser,
  trackLongText,
  clearLongTextWarn,
};
