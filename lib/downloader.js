const axios  = require("axios");
const path   = require("path");
const fs     = require("fs");
const os     = require("os");

const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffmpeg          = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const COBALT_API  = "https://api.cobalt.tools/";
const USER_AGENT  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function cobaltFetch(url, mode = "auto", quality = "720") {
  const body = {
    url,
    downloadMode:   mode,
    audioFormat:    "mp3",
    videoQuality:   quality,
    filenameStyle:  "basic",
  };
  const res = await axios.post(COBALT_API, body, {
    headers: {
      "Accept":       "application/json",
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
  const d = res.data;
  if (!d || d.status === "error") {
    throw new Error(d?.error?.code || d?.text || "Cobalt API error");
  }
  if (d.status === "picker") {
    const first = d.picker?.[0];
    if (!first?.url) throw new Error("No media found for that URL.");
    return { downloadUrl: first.url, filename: d.filename || "media" };
  }
  if (!d.url) throw new Error("No download URL returned.");
  return { downloadUrl: d.url, filename: d.filename || "media" };
}

async function streamToFile(downloadUrl, outPath) {
  const res = await axios({
    url:          downloadUrl,
    method:       "GET",
    responseType: "stream",
    timeout:      120000,
    headers:      { "User-Agent": USER_AGENT },
    maxRedirects: 10,
  });
  const writer = fs.createWriteStream(outPath);
  res.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

async function downloadAudio(url) {
  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `audio_${Date.now()}.mp3`);

  try {
    const { downloadUrl, filename } = await cobaltFetch(url, "audio", "720");
    const title = (filename || "audio").replace(/\.[^.]+$/, "").slice(0, 80);

    const rawPath = path.join(tmpDir, `raw_${Date.now()}`);
    await streamToFile(downloadUrl, rawPath);

    await new Promise((resolve, reject) => {
      ffmpeg(rawPath)
        .audioCodec("libmp3lame")
        .audioBitrate(192)
        .on("end", resolve)
        .on("error", () => {
          fs.renameSync(rawPath, outPath);
          resolve();
        })
        .save(outPath);
    });

    try { fs.unlinkSync(rawPath); } catch {}
    return { path: outPath, title };
  } catch (err) {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    throw new Error(`Audio download failed: ${err.message}`);
  }
}

async function downloadVideo(url, quality = "720") {
  const tmpDir  = os.tmpdir();
  const outPath = path.join(tmpDir, `video_${Date.now()}.mp4`);

  try {
    const { downloadUrl, filename } = await cobaltFetch(url, "auto", quality);
    const title = (filename || "video").replace(/\.[^.]+$/, "").slice(0, 80);

    const rawPath = path.join(tmpDir, `rawvid_${Date.now()}`);
    await streamToFile(downloadUrl, rawPath);

    await new Promise((resolve, reject) => {
      ffmpeg(rawPath)
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions("-movflags", "faststart")
        .on("end", resolve)
        .on("error", () => {
          fs.renameSync(rawPath, outPath);
          resolve();
        })
        .save(outPath);
    });

    try { fs.unlinkSync(rawPath); } catch {}
    return { path: outPath, title };
  } catch (err) {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    throw new Error(`Video download failed: ${err.message}`);
  }
}

async function downloadUniversal(url, mode = "auto") {
  const tmpDir = os.tmpdir();
  const ts     = Date.now();

  const { downloadUrl, filename } = await cobaltFetch(url, mode, "720");
  const ext   = (filename.match(/\.([^.]+)$/) || [, "mp4"])[1].toLowerCase();
  const title = filename.replace(/\.[^.]+$/, "").slice(0, 80);
  const isAudio = ["mp3", "ogg", "wav", "opus", "m4a", "aac"].includes(ext);

  const outPath = path.join(tmpDir, `uni_${ts}.${isAudio ? "mp3" : "mp4"}`);
  const rawPath = path.join(tmpDir, `uniraw_${ts}.${ext}`);

  await streamToFile(downloadUrl, rawPath);

  if (ext === (isAudio ? "mp3" : "mp4")) {
    fs.renameSync(rawPath, outPath);
  } else {
    await new Promise((resolve) => {
      const cmd = ffmpeg(rawPath);
      if (isAudio) cmd.audioCodec("libmp3lame").audioBitrate(192);
      else         cmd.videoCodec("libx264").audioCodec("aac").outputOptions("-movflags", "faststart");
      cmd.on("end", resolve).on("error", () => { try { fs.renameSync(rawPath, outPath); } catch {} resolve(); }).save(outPath);
    });
    try { fs.unlinkSync(rawPath); } catch {}
  }

  return { path: outPath, title, type: isAudio ? "audio" : "video" };
}

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

async function downloadFacebook(url) {
  return downloadUniversal(url, "auto");
}

async function downloadPinterest(url) {
  return downloadUniversal(url, "auto");
}

module.exports = {
  downloadAudio,
  downloadVideo,
  downloadUniversal,
  searchYouTube,
  downloadFacebook,
  downloadPinterest,
};
