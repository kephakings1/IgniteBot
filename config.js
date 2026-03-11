const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(name, defaults) {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return defaults;
  }
}

function saveJSON(name, data) {
  const file = path.join(DATA_DIR, `${name}.json`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

module.exports = {
  botName: "IgniteBot",
  prefix: ".",
  admins: (process.env.ADMIN_NUMBERS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
  openaiModel: "gpt-4o-mini",
  openaiImageModel: "dall-e-3",
  maxAIHistory: 10,
  DATA_DIR,
  loadJSON,
  saveJSON,

  defaultProducts: [
    {
      id: 1,
      name: "Premium Plan",
      price: 9.99,
      description: "Full access to all premium features",
      stock: 999,
      emoji: "⭐",
    },
    {
      id: 2,
      name: "Basic Plan",
      price: 4.99,
      description: "Essential features for personal use",
      stock: 999,
      emoji: "🟢",
    },
    {
      id: 3,
      name: "Enterprise Plan",
      price: 29.99,
      description: "Advanced features for businesses",
      stock: 50,
      emoji: "🏢",
    },
  ],

  defaultServices: [
    "Consultation (30 min)",
    "Meeting (1 hour)",
    "Support Session (45 min)",
    "Demo Call (20 min)",
  ],

  supportedLanguages: {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    pt: "Portuguese",
    ar: "Arabic",
    zh: "Chinese",
    hi: "Hindi",
    ja: "Japanese",
    ko: "Korean",
    ru: "Russian",
    it: "Italian",
  },

  spamThreshold: 5,
  spamWindowMs: 10000,
};
