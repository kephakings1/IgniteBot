const { maxAIHistory } = require("../config");
const db   = require("./datastore");
const fs   = require("fs");
const path = require("path");
const axios = require("axios");

// ── Provider priority: xAI → Groq → OpenAI ──────────────────────────────────
// xAI (Grok) uses an OpenAI-compatible API at https://api.x.ai/v1
// Groq is free at https://console.groq.com/keys
// OpenAI as final fallback

let _client = null;
let _provider = null;

function getClient() {
  if (_client) return { client: _client, provider: _provider };

  if (process.env.XAI_API_KEY) {
    const { OpenAI } = require("openai");
    _client   = new OpenAI({
      apiKey:  process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
    _provider = "xai";
    return { client: _client, provider: _provider };
  }

  if (process.env.GROQ_API_KEY) {
    const Groq = require("groq-sdk");
    _client   = new Groq({ apiKey: process.env.GROQ_API_KEY });
    _provider = "groq";
    return { client: _client, provider: _provider };
  }

  if (process.env.OPENAI_API_KEY) {
    const { OpenAI } = require("openai");
    _client   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    _provider = "openai";
    return { client: _client, provider: _provider };
  }

  return { client: null, provider: null };
}

function getModel(provider) {
  if (provider === "xai")    return "grok-3-mini";
  if (provider === "groq")   return "llama3-70b-8192";
  if (provider === "openai") return require("../config").openaiModel || "gpt-4o-mini";
  return "grok-3-mini";
}

const NO_KEY_MSG =
  `⚠️ *AI not configured.*\n\n` +
  `To enable AI, add your free *Groq API key*:\n` +
  `1. Visit *console.groq.com/keys*\n` +
  `2. Create a free API key\n` +
  `3. Add it as secret *GROQ_API_KEY* in your Replit project\n\n` +
  `_Groq is free — no credit card needed._`;

const HISTORY_DEFAULTS = { conversations: {} };

const SYSTEM_PROMPT = `You are NEXUS V2, a friendly and helpful WhatsApp assistant made by Nexus Tech. 
You respond concisely and helpfully. You use WhatsApp formatting: *bold*, _italic_, ~strikethrough~.
Keep responses brief and relevant. Use emojis appropriately.`;

function getUserHistory(jid) {
  const data = db.read("ai_history", HISTORY_DEFAULTS);
  return data.conversations[jid] || [];
}

function saveHistory(jid, messages) {
  db.update("ai_history", HISTORY_DEFAULTS, (data) => {
    data.conversations[jid] = messages.slice(-maxAIHistory * 2);
  });
}

function clearHistory(jid) {
  db.update("ai_history", HISTORY_DEFAULTS, (data) => {
    delete data.conversations[jid];
  });
}

// ── Chat with history ────────────────────────────────────────────────────────
async function chat(jid, userMessage) {
  const { client, provider } = getClient();
  if (!client) return NO_KEY_MSG;

  const history  = getUserHistory(jid);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.chat.completions.create({
      model:      getModel(provider),
      messages,
      max_tokens: 600,
    });
    const reply = response.choices[0].message.content;
    saveHistory(jid, [
      ...history,
      { role: "user",      content: userMessage },
      { role: "assistant", content: reply },
    ]);
    return reply;
  } catch (err) {
    return `❌ AI error: ${err.message}`;
  }
}

// ── Single question, no history ──────────────────────────────────────────────
async function ask(question) {
  const { client, provider } = getClient();
  if (!client) return NO_KEY_MSG;
  try {
    const response = await client.chat.completions.create({
      model:      getModel(provider),
      messages: [
        { role: "system", content: "You are a helpful assistant. Answer questions accurately and concisely. Use WhatsApp markdown: *bold*, _italic_." },
        { role: "user",   content: question },
      ],
      max_tokens: 700,
    });
    return response.choices[0].message.content;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

// ── Summarise text ───────────────────────────────────────────────────────────
async function summarize(text) {
  const { client, provider } = getClient();
  if (!client) return NO_KEY_MSG;
  try {
    const response = await client.chat.completions.create({
      model:      getModel(provider),
      messages: [
        { role: "system", content: "Summarize the following text clearly and concisely using bullet points. Use WhatsApp formatting (*bold*, _italic_)." },
        { role: "user",   content: text },
      ],
      max_tokens: 500,
    });
    return response.choices[0].message.content;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

// ── Image generation via Pollinations.ai (free, no key needed) ───────────────
async function generateImage(prompt) {
  try {
    const encoded = encodeURIComponent(prompt);
    const seed    = Math.floor(Math.random() * 9999999);
    // Pollinations generates the image on-the-fly when the URL is fetched
    const url = `https://image.pollinations.ai/prompt/${encoded}?seed=${seed}&width=1024&height=1024&nologo=true&model=flux`;
    return { url };
  } catch (err) {
    return { error: `❌ Image generation error: ${err.message}` };
  }
}

// ── Text-to-speech (free via VoiceRSS or fallback message) ──────────────────
async function textToSpeech(text, outputPath) {
  // Try OpenAI TTS if key is available
  const { client, provider } = getClient();
  if (client && provider === "openai") {
    try {
      const response = await client.audio.speech.create({
        model: "tts-1",
        voice: "nova",
        input: text.slice(0, 4096),
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(outputPath, buffer);
      return { path: outputPath };
    } catch (err) {
      return { error: `❌ TTS error: ${err.message}` };
    }
  }

  // Free TTS fallback via VoiceRSS
  const voiceRssKey = process.env.VOICERSS_KEY;
  if (voiceRssKey) {
    try {
      const res = await axios.get("https://api.voicerss.org/", {
        params: {
          key: voiceRssKey,
          hl:  "en-us",
          src: text.slice(0, 500),
          c:   "MP3",
          f:   "44khz_16bit_stereo",
        },
        responseType: "arraybuffer",
        timeout: 15000,
      });
      fs.writeFileSync(outputPath, res.data);
      return { path: outputPath };
    } catch (err) {
      return { error: `❌ TTS error: ${err.message}` };
    }
  }

  return { error: `⚠️ TTS requires an OpenAI API key or VOICERSS_KEY. Groq doesn't support audio generation.` };
}

// ── Translation ──────────────────────────────────────────────────────────────
async function translateWithAI(text, targetLang) {
  const { client, provider } = getClient();
  if (!client) return null;
  try {
    const response = await client.chat.completions.create({
      model:      getModel(provider),
      messages: [
        { role: "system", content: `Translate the following text to ${targetLang}. Return only the translated text, nothing else.` },
        { role: "user",   content: text },
      ],
      max_tokens: 500,
    });
    return response.choices[0].message.content;
  } catch {
    return null;
  }
}

module.exports = { chat, ask, summarize, generateImage, textToSpeech, translateWithAI, clearHistory };
