# ⚡ Ignitebot —
<div align="center">
  <a href="https://git.io/typing-svg">
    <img src="https://readme-typing-svg.demolab.com?font=Black+Ops+One&size=50&pause=1000&color=25D366&center=true&width=910&height=100&lines=IGNITEBOT+WHATSAPP+BOT;30%2B+FEATURES+BUILT+IN;AI+%7C+STICKERS+%7C+GROUPS;ALWAYS+ONLINE+%26+READY" alt="Typing SVG" />
  </a>
</div>

<p align="center">
<img src="https://files.catbox.moe/t7qghl.jpg" width="400" height="400"/>
</p>

<p align="center">
  <a href="#"><img title="Creator" src="https://img.shields.io/badge/Creator-IGNATIUS_PEREZ-blue.svg?style=for-the-badge&logo=github"></a>
  <a href="#"><img title="Language" src="https://img.shields.io/badge/Node.js-20-339933?style=for-the-badge&logo=node.js&logoColor=white"></a>
  <a href="#"><img title="License" src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge"></a>
</p>

---

## 📞 Contact

<p align="center">
<a href="https://api.whatsapp.com/send?phone=254781346242&text=Hello+IgniteBot+dev+i+need+your+Help+on..."><img src="https://img.shields.io/badge/WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" /></a>
</p>

> **Built with [Node.js](https://nodejs.org) and [Baileys](https://github.com/whiskeysockets/Baileys)**

---

## ⚠️ DISCLAIMER

- Modifying the bot structure is at your own risk.
- Do not remove credits — you may add yourself instead.
- This bot is for educational purposes only.

---

## ✨ FEATURES

| Category | Features |
|---|---|
| 🤖 AI | Chat, Image Generation, TTS, Summarize |
| 🎨 Media | Sticker maker, Video/Audio downloader, Converter |
| 🌍 Tools | Translator, Text-to-Speech, YouTube downloader |
| 👥 Groups | Welcome/Goodbye, Tag-all, Anti-link, Anti-spam |
| 🛒 E-Commerce | Product catalog, Order system |
| 📅 Booking | Services, Appointments, Cancellation |
| 📢 Broadcast | Mass messaging to all users |
| 🔒 Security | Ban/unban, Warnings, Anti-call, Anti-delete |
| ⚙️ Settings | Mode control, Always-online, Auto-view status |

---

## 🚀 SETUP

### Step 1 — Fork this repo

<p align="center">
<a href="https://github.com/ignatiusmkuu-spec/IgniteBot/fork"><img src="https://img.shields.io/badge/Fork%20Repo-6f42c1?style=for-the-badge&logo=github&logoColor=white" alt="Fork" width="160"></a>
</p>

---

### Step 2 — Get your Session ID (Pairing)

> Open the pairing site, enter your WhatsApp number, scan the code, and copy your **Session ID**.

<p align="center">
<a href="https://nexs-md-pair.onrender.com">
  <img src="https://img.shields.io/badge/🔗_Get_Session_ID-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Get Session ID" />
</a>
</p>

**Pairing Site:** `https://web-production-9e409.up.railway.app/pair`

> Replace `https://web-production-9e409.up.railway.app/pair` with your Heroku app URL or Replit deployment URL.  
> Example: `https://my-ignitebot.herokuapp.com/session`

#### How pairing works:
1. Open the pairing link above
2. Enter your WhatsApp number (international format, no `+`)
3. Open WhatsApp → **Menu → Linked Devices → Link a Device → Link with phone number**
4. Enter the 8-character code shown on the pairing page
5. **Copy the Session ID** that appears after connecting
6. Paste it as `SESSION_ID` in your Heroku Config Vars

---

### Step 3 — Deploy to Heroku

<p align="center">
  <a href="https://heroku.com/deploy">
    <img src="https://www.herokucdn.com/deploy/button.svg" alt="Deploy to Heroku"/>
  </a>
</p>

Fill in these Config Vars during deployment:

| Variable | Description | Required |
|---|---|---|
| `SESSION_ID` | Your Session ID from the pairing site | ✅ |
| `ADMIN_NUMBERS` | Your phone number(s) without `+`, comma-separated | ⭐ |
| `OPENAI_API_KEY` | For AI features (chat, images, TTS) | ➕ Optional |

---

## 🔄 Keeping the Bot Online

On **Heroku**, the bot loses its session when the dyno restarts. To fix this permanently:

1. Deploy and open your app URL
2. Visit `/session` on your app and pair your number
3. Copy the **Session ID**
4. Go to Heroku → Settings → Config Vars → add `SESSION_ID`
5. Bot will now auto-reconnect on every restart ✅

---

## 📋 Commands

### 🤖 AI Commands
| Command | Description |
|---|---|
| `!ai [text]` | Chat with AI |
| `!ask [question]` | Quick question |
| `!imagine [prompt]` | Generate image |
| `!tts [text]` | Text to speech |
| `!summarize [text]` | Summarize text |

### 🛠️ Tools
| Command | Description |
|---|---|
| `!tr [lang] [text]` | Translate |
| `!dl [url]` | Download video |
| `!yt [url]` | Download audio |
| `!sticker` | Make sticker |

### ⚙️ Bot Settings
| Command | Description |
|---|---|
| `!mode public/private/group` | Set bot mode |
| `!autoview on/off` | Auto view statuses |
| `!autolike on/off` | Auto like statuses |
| `!alwaysonline on/off` | Stay always online |
| `!anticall on/off` | Reject calls |

### 👥 Group Management
| Command | Description |
|---|---|
| `!setwelcome [msg]` | Set welcome message |
| `!tagall [msg]` | Tag all members |
| `!kick @user` | Remove member |
| `!antilink on/off` | Block links |
| `!antispam on/off` | Block spam |

---

## 📜 License

[MIT License](https://github.com/HunterNick2/RAVEN-BOT/blob/main/LICENSE)

Copyright (c) 2025 IgniteBot — IGNATIUS PEREZ
