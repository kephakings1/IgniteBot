const db = require("./datastore");
const fs = require("fs");
const path = require("path");

const config = require("../config");

const DEFAULTS = {
  mode: "public",
  prefix: config.prefix,
  prefixless: false,
  autoViewStatus: false,
  autoLikeStatus: false,
  alwaysOnline: false,
  antiCall: false,
  antiDeleteStatus: false,
  autoReadMessages: true,
  menuVideoPath: null,
};

function get(key) {
  const data = db.read("settings", DEFAULTS);
  return key in data ? data[key] : DEFAULTS[key];
}

function set(key, value) {
  db.update("settings", DEFAULTS, (data) => {
    data[key] = value;
  });
}

function getAll() {
  return db.read("settings", DEFAULTS);
}

function toggle(key) {
  const current = get(key);
  set(key, !current);
  return !current;
}

function setMenuVideo(buffer) {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "menu_video.mp4");
  fs.writeFileSync(filePath, buffer);
  set("menuVideoPath", filePath);
  return filePath;
}

function getMenuVideo() {
  const filePath = get("menuVideoPath");
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function clearMenuVideo() {
  const filePath = get("menuVideoPath");
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
  set("menuVideoPath", null);
}

function formatSettingsMessage() {
  const s = getAll();
  const on = (v) => (v ? "✅ ON" : "❌ OFF");
  const modeIcon = s.mode === "public" ? "🌍" : s.mode === "private" ? "🔒" : "👥";

  return `⚙️ *Bot Settings*\n\n` +
    `${modeIcon} Mode: *${s.mode.toUpperCase()}*\n` +
    `👁 Auto View Status: ${on(s.autoViewStatus)}\n` +
    `❤️ Auto Like Status: ${on(s.autoLikeStatus)}\n` +
    `🟢 Always Online: ${on(s.alwaysOnline)}\n` +
    `📵 Anti Call: ${on(s.antiCall)}\n` +
    `🗑 Anti Delete Status: ${on(s.antiDeleteStatus)}\n` +
    `📖 Auto Read Messages: ${on(s.autoReadMessages)}\n` +
    `🎬 Menu Video: ${s.menuVideoPath ? "✅ Set" : "❌ Not set"}\n\n` +
    `_Use commands to toggle each setting_`;
}

module.exports = { get, set, toggle, getAll, setMenuVideo, getMenuVideo, clearMenuVideo, formatSettingsMessage };
