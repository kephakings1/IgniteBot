<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Black+Ops+One&size=52&pause=1000&color=00FF88&center=true&width=900&height=110&lines=⚡+NEXUS-MD;WHATSAPP+BOT+REDEFINED;AI+•+SPEED+•+INTELLIGENCE" alt="NEXUS-MD" />

<img src="assets/banner.gif" width="100%" style="border-radius:16px; margin: 16px 0;" />

<br/>

[![Creator](https://img.shields.io/badge/BY-IGNATIUS%20PEREZ-00ff88?style=for-the-badge&logo=github&logoColor=black)](https://github.com/ignatiusmkuu-spec)
[![Node](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/MIT-License-00e5ff?style=for-the-badge)](LICENSE)
[![Heroku](https://img.shields.io/badge/Deploy-Heroku-430098?style=for-the-badge&logo=heroku&logoColor=white)](https://heroku.com/deploy?template=https://github.com/ignatiusmkuu-spec/IgniteBot)

<br/>

[![Stars](https://img.shields.io/github/stars/ignatiusmkuu-spec/IgniteBot?style=flat-square&color=00ff88&label=⭐+Stars)](https://github.com/ignatiusmkuu-spec/IgniteBot/stargazers)
[![Forks](https://img.shields.io/github/forks/ignatiusmkuu-spec/IgniteBot?style=flat-square&color=00e5ff&label=🍴+Forks)](https://github.com/ignatiusmkuu-spec/IgniteBot/fork)
[![Issues](https://img.shields.io/github/issues/ignatiusmkuu-spec/IgniteBot?style=flat-square&color=ff6b6b&label=🐛+Issues)](https://github.com/ignatiusmkuu-spec/IgniteBot/issues)
[![WhatsApp](https://img.shields.io/badge/Contact%20Dev-25D366?style=flat-square&logo=whatsapp&logoColor=white)](https://api.whatsapp.com/send?phone=254706535581&text=Hello+NEXUS-MD+dev)

</div>

---

## ✨ Features

<div align="center">

| Category | Features |
|:---|:---|
| 🤖 **AI Engine** | GPT-powered chat, image generation (DALL-E), TTS, text summariser |
| 📥 **Media Downloads** | YouTube, Facebook, Pinterest audio & video downloader |
| 🛡 **Group Guard** | Anti-link, anti-spam, anti-flood, anti-mention, word filter, warn system |
| 🚫 **Anti-Delete** | Recovers deleted text, images, video, stickers, audio & voice notes |
| ✏️ **Anti-Edit** | Logs original message before & after edits |
| 🎨 **Sticker Maker** | Convert images/videos/GIFs to WhatsApp stickers |
| 📊 **Analytics** | Message stats, command usage charts, uptime dashboard |
| 🔎 **Search Hub** | Wikipedia, weather, dictionary, translator (12 languages) |
| ⚽ **Sports** | Live EPL / Premier League scores |
| 🛒 **Store System** | Shop catalog, order management, service bookings |
| 👑 **Admin Tools** | Broadcast, sudo system, multi-admin support |
| ⚙️ **Auto Mod** | Anti-call, always-online, view-once revealer, auto-tag |
| 🎵 **Menu Song** | Plays a song + animated banner on every `.menu` call |
| 🌐 **Multi-Platform** | Auto-detects Heroku · Railway · Render · Fly.io · VPS |

</div>

---

## 🚀 Deploy in 3 Steps

<div align="center">

**① Fork the repo**

[![Fork](https://img.shields.io/badge/FORK%20REPO-6f42c1?style=for-the-badge&logo=github&logoColor=white)](https://github.com/ignatiusmkuu-spec/IgniteBot/fork)

**② Get your WhatsApp session ID**

[![Session](https://img.shields.io/badge/GET%20SESSION%20ID-00ff88?style=for-the-badge&logo=whatsapp&logoColor=black)](https://nexs-session-1.replit.app)

**③ Deploy to Heroku**

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/ignatiusmkuu-spec/IgniteBot)

</div>

> **Tip:** After deploying, visit `https://your-app.herokuapp.com/dashboard` to manage your bot, view analytics, and push config vars.

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|:---|:---:|:---|
| `SESSION_ID` | ✅ | WhatsApp session string — get it at [nexs-session-1.replit.app](https://nexs-session-1.replit.app) |
| `ADMIN_NUMBERS` | ✅ | Owner phone number(s) without `+`. Comma-separated for multiple owners. e.g. `254706535581` |
| `DATABASE_URL` | ⬜ | PostgreSQL connection string. Auto-filled by Heroku Postgres add-on. Falls back to local file storage if not set |
| `BOTNAME` | ⬜ | Bot display name shown in menus (default: `NEXUS-MD`) |
| `HEROKU_API` | ⬜ | Heroku API key — required only for the "Push to Heroku" dashboard feature |
| `PORT` | ⬜ | HTTP server port (default: `5000`) |

---

## 📁 Project Structure

```
IgniteBot/
│
├── index.js              # Main entry — bot core, Express server, message router
├── config.js             # Global config (bot name, prefix, spam settings, products)
├── package.json          # Dependencies & npm scripts
├── Procfile              # Heroku process definition
├── app.json              # Heroku one-click deploy manifest
│
├── lib/                  # Modular feature library
│   ├── ai.js             # OpenAI/Groq chat, image generation (DALL-E), TTS
│   ├── admin.js          # Admin & sudo management commands
│   ├── analytics.js      # Message stats, command tracking, hourly charts
│   ├── antidelete.js     # Anti-delete & anti-edit — recovers all media types
│   ├── booking.js        # Service booking & appointment system
│   ├── broadcast.js      # Group/contact broadcast with history tracking
│   ├── catbox.js         # Catbox.moe file upload helper
│   ├── commands.js       # Command dispatcher (routes .commands to handlers)
│   ├── converter.js      # Media conversion utilities (FFmpeg wrappers)
│   ├── datastore.js      # Persistent key-value store abstraction
│   ├── db.js             # PostgreSQL pool + local-file fallback storage
│   ├── downloader.js     # YouTube, Facebook, Pinterest downloader (yt-dlp)
│   ├── groups.js         # Group management (kick, mute, warn, welcome, etc.)
│   ├── imgur.js          # Imgur image upload helper
│   ├── keywords.js       # Keyword auto-reply system
│   ├── language.js       # Multi-language support & translation
│   ├── perez.js          # Text art & creative effects (ephoto360)
│   ├── platform.js       # Auto-detects deployment platform (Heroku/Railway/VPS…)
│   ├── premium.js        # Premium user management
│   ├── remini.js         # AI image enhancement (Remini/Vyro)
│   ├── security.js       # Message cache, spam detection, anti-link engine
│   ├── settings.js       # Bot settings persistence (prefix, mode, menu assets)
│   ├── sports.js         # Live EPL / Premier League scores scraper
│   ├── sticker.js        # Sticker creation from images, videos & GIFs
│   ├── store.js          # Product catalog & order management
│   ├── textart.js        # Text styling (bold, italic, aesthetic, mock, etc.)
│   └── translator.js     # Multi-language translation (Google TTS API)
│
├── web/
│   └── dashboard.js      # Express router — analytics dashboard UI & REST API
│
├── assets/
│   ├── banner.gif        # Animated banner shown in menu
│   ├── menu.mp4          # Default menu video (GIF playback)
│   ├── menu.mp3          # Default menu audio track
│   └── alive.mp3         # Bot alive/ping audio
│
├── data/                 # Runtime data (git-ignored)
│   ├── botstore.json     # Local key-value persistence (no-DB fallback)
│   └── settings.json     # Active bot settings snapshot
│
├── database/
│   └── config.js         # PostgreSQL table definitions & migration helpers
│
├── scripts/
│   ├── obfuscate.js      # Source obfuscator for distribution builds
│   ├── panel.sh          # Panel/VPS quick-install helper script
│   └── post-merge.sh     # Auto-runs `npm install` after branch merges
│
├── bin/
│   └── yt-dlp            # Bundled yt-dlp binary for media downloads
│
└── .github/
    └── workflows/
        └── node.js.yml   # CI — install & lint on Node 18/20/22
```

---

## 📖 Command Reference

<details>
<summary><b>⚙️ System Core</b></summary>

| Command | Description |
|:---|:---|
| `.menu` / `.help` | Full command list with bot stats |
| `.ping` | Bot latency & status |
| `.alive` | Bot alive check with uptime |
| `.stats` | Memory, uptime, platform info |
| `.uptime` | How long the bot has been running |
| `.time` / `.date` | Current time / date |

</details>

<details>
<summary><b>🧠 AI Engine</b></summary>

| Command | Description |
|:---|:---|
| `.ai [text]` / `.chat` / `.ask` | Chat with AI (GPT-powered) |
| `.imagine [prompt]` / `.image` | Generate an image with DALL-E |
| `.tts [text]` | Convert text to speech |
| `.summarize [text]` / `.summary` | Summarise long text |
| `.clearchat` | Clear your AI conversation history |

</details>

<details>
<summary><b>🔎 Search Hub</b></summary>

| Command | Description |
|:---|:---|
| `.weather [city]` | Current weather for any city |
| `.wiki [query]` / `.wikipedia` | Wikipedia summary |
| `.define [word]` / `.dict` | Dictionary definition |
| `.tr [lang] [text]` / `.translate` | Translate text to another language |
| `.langs` | List all supported languages |

</details>

<details>
<summary><b>⚽ Sports</b></summary>

| Command | Description |
|:---|:---|
| `.epl` / `.eplscores` / `.pl` / `.premierleague` | Live EPL match scores |

</details>

<details>
<summary><b>🎮 Fun Zone</b></summary>

| Command | Description |
|:---|:---|
| `.8ball [question]` | Magic 8-ball answer |
| `.fact` | Random interesting fact |
| `.flip` | Flip a coin |
| `.joke` | Random joke |
| `.quote` / `.inspire` | Inspirational quote |
| `.roll` | Roll a dice |

</details>

<details>
<summary><b>✍️ Text Lab</b></summary>

| Command | Description |
|:---|:---|
| `.aesthetic [text]` / `.ae` | Aesthetic text style |
| `.bold [text]` | Bold text |
| `.italic [text]` | Italic text |
| `.mock [text]` | SpOnGeBoB mock case |
| `.reverse [text]` | Reverse text |
| `.emojify [text]` / `.emoji` | Add emojis between letters |
| `.upper [text]` / `.lower` | UPPERCASE / lowercase |
| `.repeat [n] [text]` | Repeat text n times |
| `.calc [expression]` / `.calculate` | Calculator |

</details>

<details>
<summary><b>🎧 Media Station</b></summary>

| Command | Description |
|:---|:---|
| `.play [query]` / `.song` / `.yt` / `.audio` / `.music` | Download YouTube audio |
| `.dl [url]` / `.download` | Download media from a URL |
| `.fbdl [url]` / `.facebook` | Download Facebook video |
| `.pindl [url]` / `.pinterest` | Download Pinterest image/video |
| `.sticker` / `.s` / `.convert` | Convert image/video/GIF to sticker |
| `.viewonce` / `.vo` / `.v` | Reveal a view-once message |
| `.reveal` | Reveal view-once media |

</details>

<details>
<summary><b>🧰 Utilities</b></summary>

| Command | Description |
|:---|:---|
| `.pp [mention]` / `.pfp` / `.getpp` | Get a user's profile picture |
| `.qr [text]` | Generate a QR code |
| `.short [url]` / `.shorten` | Shorten a URL |
| `.whois [mention]` / `.profile` | Get a user's WhatsApp info |

</details>

<details>
<summary><b>👥 Group Control</b></summary>

| Command | Description |
|:---|:---|
| `.add [number]` | Add a member to the group |
| `.kick [mention]` | Remove a member |
| `.kickall` | Remove all non-admin members |
| `.promote [mention]` / `.promoteall` | Make member(s) admin |
| `.demote [mention]` / `.demoteall` | Remove admin from member(s) |
| `.ban [mention]` / `.unban` / `.clearbanlist` | Ban / unban members |
| `.mute` / `.unmute` | Mute / unmute the group |
| `.open` / `.close` | Open / close group messaging |
| `.warn [mention]` / `.resetwarn` / `.setwarn` / `.warnings` | Warning system |
| `.delete` | Delete a message (reply to it) |
| `.leave` | Bot leaves the group |
| `.creategroup [name]` | Create a new group |

</details>

<details>
<summary><b>📊 Group Info</b></summary>

| Command | Description |
|:---|:---|
| `.admins` | List group admins |
| `.members` / `.count` | List members / total count |
| `.groupinfo` | Full group information |
| `.link` / `.invitelink` / `.glink` / `.grouplink` | Get group invite link |
| `.revoke` / `.resetlink` | Reset the invite link |
| `.setname [name]` / `.rename` | Change group name |
| `.setdesc [text]` / `.desc` | Set group description |
| `.seticon` | Set group profile photo |
| `.setgrouppp` | Set group profile picture |
| `.everyone` / `.tagall` / `.hidetag` / `.htag` / `.stag` | Tag all members |
| `.poll [question]` | Create a group poll |

</details>

<details>
<summary><b>🤖 Auto Moderation</b></summary>

| Command | Description |
|:---|:---|
| `.antilink on/off` | Block external links in group |
| `.antispam on/off` | Enable spam detection |
| `.antiflood on/off` | Enable flood protection |
| `.antilongtext on/off` / `.settextlimit [n]` | Block overly long messages |
| `.antimention on/off` / `.antitag on/off` | Block mass mentions |
| `.antisticker on/off` | Block stickers in group |
| `.antidelete on/off/chat/private/both` | Recover deleted messages |
| `.anticall on/off` | Auto-reject incoming calls |
| `.alwaysonline on/off` | Keep bot presence always online |
| `.voreveal on/off` | Auto-reveal view-once messages |

</details>

<details>
<summary><b>⚙️ Bot Settings</b></summary>

| Command | Description |
|:---|:---|
| `.botsettings` / `.features` / `.featurelist` / `.feature` | View all toggleable features |
| `.toggle [feature]` | Toggle a specific feature on/off |
| `.setmode public/private/groups` / `.mode` | Change bot access mode |
| `.lang [code]` | Change bot language |
| `.setprefix [char]` | Change the command prefix |
| `.prefixless on/off` | Toggle prefix-free commands |
| `.setowner [number]` / `.setownername` / `.setbotname` | Update owner / bot name |

</details>

<details>
<summary><b>🛒 Store System</b></summary>

| Command | Description |
|:---|:---|
| `.shop` / `.catalog` | View product catalog |
| `.order [id]` | Place an order |
| `.myorders` | View your orders |
| `.services` | View available services |
| `.book [service]` | Book a service appointment |
| `.mybookings` | View your bookings |
| `.cancel [id]` | Cancel a booking |

</details>

<details>
<summary><b>👑 Super Admin</b></summary>

| Command | Description |
|:---|:---|
| `.sudo [number]` | Add a sudo admin |
| `.removesudo [number]` / `.unsudo` | Remove sudo admin |
| `.sudolist` | List all sudo admins |
| `.broadcast [message]` | Broadcast to all chats |
| `.pairing` | Show pairing / session info |
| `.setmenuimage` / `.clearmenuimage` | Set / clear menu image |
| `.setmenuvideo` / `.clearmenuvideo` | Set / clear menu video |
| `.setmenusong` / `.clearmenusong` | Set / clear menu song |

</details>

---

## 🗄️ Database

NEXUS-MD supports two storage backends — it picks the right one automatically:

| Mode | When | What's stored |
|:---|:---|:---|
| **PostgreSQL** | `DATABASE_URL` env var is set | All settings, analytics, message logs, session data |
| **Local file** | No `DATABASE_URL` | `data/botstore.json` — key-value store, survives restarts |

The Heroku Postgres add-on is provisioned automatically when deploying via the deploy button.

---

## 🌐 Dashboard

Visit `https://your-app.herokuapp.com/dashboard` after deploying to access:

- 📊 **Overview** — message stats, top commands, activity charts, recent bookings & broadcasts
- 🔑 **Session ID** — view, copy, and reload your WhatsApp session
- ⚙️ **Setup** — push config vars directly to Heroku, change bot settings
- ➕ **Add Session** — deploy a new bot instance from the dashboard

---

## 🛠️ Local Development

```bash
# 1. Clone
git clone https://github.com/ignatiusmkuu-spec/IgniteBot.git
cd IgniteBot

# 2. Install dependencies
npm install

# 3. Set environment variables
export SESSION_ID="NEXUS-MD:~..."
export ADMIN_NUMBERS="254706535581"

# 4. Start
node index.js
```

The bot starts on `http://localhost:5000`. Visit `/dashboard` to set up your session.

---

## 📋 Requirements

- **Node.js** 20 or higher
- **FFmpeg** (bundled via `@ffmpeg-installer/ffmpeg`)
- **PostgreSQL** (optional — falls back to local file storage)

---

## 📜 License

```
MIT License — © 2025 Ignatius Perez / NEXUS-MD

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

Do not remove the original credits from the codebase or dashboard.
```

---

<div align="center">

*Built with [Baileys](https://github.com/whiskeysockets/Baileys) by Ignatius Perez · NEXUS-MD © 2025*

[![WhatsApp](https://img.shields.io/badge/Contact%20Dev-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://api.whatsapp.com/send?phone=254706535581&text=Hello+NEXUS-MD+dev)
[![GitHub](https://img.shields.io/badge/GitHub-ignatiusmkuu--spec-181717?style=for-the-badge&logo=github)](https://github.com/ignatiusmkuu-spec)

</div>
