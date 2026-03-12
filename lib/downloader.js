const axios   = require("axios");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const { execFile, spawn } = require("child_process");

const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffmpeg          = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── yt-dlp binary path ───────────────────────────────────────────────────────
const YTDLP_BIN = path.join(__dirname, "..", "bin", "yt-dlp");

function isYouTube(url) {
  return url.includes("youtube.com") || url.includes("youtu.be");
}

// ── Run yt-dlp and return { path, title } ────────────────────────────────────
async function ytdlpDownload(url, opts = {}) {
  const tmpDir = os.tmpdir();
  const ts     = Date.now();
  const template = path.join(tmpDir, `ytdlp_${ts}_%(title).80s.%(ext)s`);

  const args = [
    url,
    "-o", template,
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--print", "after_move:filepath",   // print final file path
    "--print", "title",                  // also print the title
    "--ffmpeg-location", ffmpegInstaller.path,
    ...(opts.audioOnly
      ? ["-x", "--audio-format", "mp3", "--audio-quality", "0"]
      : ["--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
         "--recode-video", "mp4"]),
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        const errLine = stderr.split("\n").filter(Boolean).pop() || "yt-dlp failed";
        return reject(new Error(errLine));
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      // yt-dlp prints title at pre-download stage (first) then after_move:filepath (second)
      const title    = lines[0]?.trim() || "audio";
      const filePath = lines[1]?.trim();
      if (!filePath || !fs.existsSync(filePath)) {
        // fallback: look for any matching file in tmpdir
        try {
          const prefix = `ytdlp_${ts}_`;
          const found = fs.readdirSync(tmpDir).find(f => f.startsWith(prefix));
          if (found) return resolve({ path: path.join(tmpDir, found), title });
        } catch {}
        return reject(new Error("Downloaded file not found"));
      }
      resolve({ path: filePath, title });
    });
    proc.on("error", reject);
  });
}

// ── Download audio (returns .mp3) ────────────────────────────────────────────
async function downloadAudio(url) {
  try {
    return await ytdlpDownload(url, { audioOnly: true });
  } catch (err) {
    throw new Error(`Audio download failed: ${err.message}`);
  }
}

// ── Download video (returns .mp4) ────────────────────────────────────────────
async function downloadVideo(url, quality = "720") {
  try {
    return await ytdlpDownload(url, { audioOnly: false });
  } catch (err) {
    throw new Error(`Video download failed: ${err.message}`);
  }
}

// ── Universal downloader — .dl, .fbdl, .pindl ───────────────────────────────
async function downloadUniversal(url, mode = "auto") {
  const audioOnly = mode === "audio";
  try {
    const result = await ytdlpDownload(url, { audioOnly });
    return { ...result, type: audioOnly ? "audio" : "video" };
  } catch (err) {
    throw new Error(`Download failed: ${err.message}`);
  }
}

// ── YouTube search (scrape ytInitialData) ────────────────────────────────────
async function searchYouTube(query) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await axios.get(searchUrl, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 10000,
    });
    const html  = res.data;
    const match = html.match(/var ytInitialData = (.+?);<\/script>/);
    if (match) {
      const data   = JSON.parse(match[1]);
      const videos =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
      const results = [];
      for (const item of videos) {
        const v = item?.videoRenderer;
        if (v && results.length < 5) {
          results.push({
            title:    v.title?.runs?.[0]?.text,
            url:      `https://www.youtube.com/watch?v=${v.videoId}`,
            duration: v.lengthText?.simpleText,
            channel:  v.ownerText?.runs?.[0]?.text,
            views:    v.viewCountText?.simpleText,
          });
        }
      }
      return results;
    }
  } catch {}
  return [];
}

async function downloadFacebook(url)  { return downloadUniversal(url, "auto");  }
async function downloadPinterest(url) { return downloadUniversal(url, "auto");  }

module.exports = {
  downloadAudio,
  downloadVideo,
  downloadUniversal,
  searchYouTube,
  downloadFacebook,
  downloadPinterest,
};
