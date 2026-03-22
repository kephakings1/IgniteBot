const db = require("./datastore");
const fs = require("fs");
const path = require("path");

const config = require("../config");

const DEFAULTS = {
  mode:             "public",
  prefix:           config.prefix,
  prefixless:       false,
  autoTyping:       true,
  typingDelay:      true,
  autoRecording:    true,
  autoViewStatus:   true,
  autoLikeStatus:   false,
  alwaysOnline:     false,
  antiCall:         false,
  antiDeleteStatus: false,
  autoReadMessages: true,
  voReveal:         false,
  language:         "en",
  menuType:         "video",   // "video" | "image"
  timezone:         "Africa/Nairobi",   // IANA timezone — used in all date/time displays
  countryCode:      "254",              // Dialling code (no +), used to expand local numbers (07xx → 2547xx)
};

// Settings that changed default value — migrate existing DBs that still have the old value
const _MIGRATIONS = {
  autoViewStatus: { from: false, to: true },
};

function initSettings() {
  db.update("settings", DEFAULTS, (data) => {
    // Add any missing keys with their defaults
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (!(k in data)) data[k] = v;
    }
    // Apply migrations: update settings that are still at an old default value
    for (const [k, { from, to }] of Object.entries(_MIGRATIONS)) {
      if (data[k] === from) data[k] = to;
    }
  });
}

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

// ── Binary asset helpers — stored as base64 in PostgreSQL so they survive ──
// Heroku dyno restarts (ephemeral filesystem would wipe local data/ files).

function _setAsset(dbKey, buffer) {
  if (!buffer) { db.write(dbKey, { data: null }); return; }
  db.write(dbKey, { data: buffer.toString("base64") });
}

function _getAsset(dbKey) {
  const row = db.read(dbKey, { data: null });
  if (!row || !row.data) return null;
  return Buffer.from(row.data, "base64");
}

function _clearAsset(dbKey) {
  db.write(dbKey, { data: null });
}

// ── Menu Video (user-set via .setmenuvideo) ───────────────────────────────
function setMenuVideo(buffer) {
  _setAsset("menuVideo", buffer);
}
function getMenuVideo() {
  // Try DB first (custom user-set video)
  const fromDb = _getAsset("menuVideo");
  if (fromDb) return fromDb;
  // Fallback: bundled default video (data/ first, then assets/)
  for (const rel of ["data/menu_video.mp4", "assets/menu.mp4"]) {
    const p = path.join(process.cwd(), rel);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  return null;
}
function clearMenuVideo() {
  _clearAsset("menuVideo");
}

// ── Menu Type ("video" | "image") ─────────────────────────────────────────
function getMenuType() {
  return get("menuType") || "video";
}
function setMenuType(value) {
  const v = (value || "video").toLowerCase();
  if (v !== "video" && v !== "image") throw new Error('menuType must be "video" or "image"');
  set("menuType", v);
}

// ── Menu Image ────────────────────────────────────────────────────────────
function setMenuImage(buffer) {
  _setAsset("menuImage", buffer);
}
function getMenuImage() {
  // Try DB first (Heroku / any deploy)
  const fromDb = _getAsset("menuImage");
  if (fromDb) return fromDb;
  // Fallback: bundled default image (data/ first, then assets/)
  for (const rel of ["data/menu_image.jpg", "assets/menu_image.jpg"]) {
    const p = path.join(process.cwd(), rel);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  return null;
}
function clearMenuImage() {
  _clearAsset("menuImage");
}

// ── Menu Song ─────────────────────────────────────────────────────────────
function setMenuSong(buffer) {
  _setAsset("menuSong", buffer);
}
function getMenuSong() {
  // Try DB first (custom user-set song via .setmenusong)
  const fromDb = _getAsset("menuSong");
  if (fromDb) return fromDb;
  // Fallback: bundled default song (data/ first, then assets/)
  for (const rel of ["data/menu_song.mp3", "assets/menu.mp3"]) {
    const p = path.join(process.cwd(), rel);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  return null;
}
function clearMenuSong() {
  _clearAsset("menuSong");
}

// ── Combined menu video (ffmpeg image+audio merge, cached in Postgres) ────
// Saves Heroku from re-running ffmpeg after every dyno restart.
function setMenuCombined(buffer) {
  _setAsset("menuCombined", buffer);
}
function getMenuCombined() {
  return _getAsset("menuCombined");
}
function clearMenuCombined() {
  _clearAsset("menuCombined");
}

function formatSettingsMessage() {
  const s = getAll();
  const on  = (v) => v ? "✅ ON" : "❌ OFF";
  const modeIcon = s.mode === "public" ? "🌍" : s.mode === "private" ? "🔒" : "👥";
  const hasVideo    = !!getMenuVideo();
  const hasImage    = !!getMenuImage();
  const hasSong     = !!getMenuSong();
  const hasCombined = !!getMenuCombined();

  const menuTypeLabel = (s.menuType || "video") === "video"
    ? "🎬 Video"
    : "🖼 Image";

  return (
    `⚙️ *Bot Settings — NEXUS-MD*\n\n` +
    `${modeIcon} *Mode:* ${s.mode.toUpperCase()}\n` +
    `🤖 *Prefix:* \`${s.prefix || "."}\`\n` +
    `🌐 *Language:* ${s.language || "en"}\n\n` +
    `⌨️ *Auto Typing:* ${on(s.autoTyping)}\n` +
    `🎤 *Auto Recording:* ${on(s.autoRecording)}\n` +
    `⏱ *Typing Delay:* ${on(s.typingDelay)}\n` +
    `📌 *Prefixless:* ${on(s.prefixless)}\n\n` +
    `👁 *Auto View Status:* ${on(s.autoViewStatus)}\n` +
    `❤️ *Auto Like Status:* ${on(s.autoLikeStatus)}\n` +
    `🟢 *Always Online:* ${on(s.alwaysOnline)}\n` +
    `📖 *Auto Read Messages:* ${on(s.autoReadMessages)}\n` +
    `📵 *Anti Call:* ${on(s.antiCall)}\n` +
    `🗑 *Anti Delete Status:* ${on(s.antiDeleteStatus)}\n` +
    `👁 *Auto Reveal View-Once:* ${on(s.voReveal)}\n\n` +
    `📋 *Menu Type:* ${menuTypeLabel}\n` +
    `🖼 *Menu Image:* ${hasImage ? "✅ Set" : "❌ None"}\n` +
    `🎵 *Menu Song:* ${hasSong ? "✅ Set" : "❌ None"}\n` +
    `🎬 *Menu Video:* ${hasVideo ? "✅ Custom set" : "✅ Default bundled"}\n\n` +
    `_Use \`${s.prefix || "."}feature [name] on/off\` to toggle_\n` +
    `_Use \`${s.prefix || "."}menutype video\` or \`image\` to switch menu style_`
  );
}

module.exports = {
  get, set, toggle, getAll, initSettings,
  setMenuVideo, getMenuVideo, clearMenuVideo,
  setMenuImage, getMenuImage, clearMenuImage,
  setMenuSong,  getMenuSong,  clearMenuSong,
  setMenuCombined, getMenuCombined, clearMenuCombined,
  getMenuType, setMenuType,
  formatSettingsMessage,
};
