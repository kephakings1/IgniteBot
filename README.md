<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Black+Ops+One&size=48&pause=1000&color=00FF88&center=true&width=900&height=100&lines=⚡+NEXUS-MD;WHATSAPP+BOT+REDEFINED;AI+•+SPEED+•+INTELLIGENCE" alt="NEXUS-MD" />

<img src="assets/banner.gif" width="100%" style="border-radius:16px; margin: 12px 0;" />

<br/>

[![Creator](https://img.shields.io/badge/BY-IGNATIUS%20PEREZ-00ff88?style=for-the-badge&logo=github&logoColor=black)](https://github.com/ignatiusmkuu-spec)
[![Node](https://img.shields.io/badge/Node.js-20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/MIT-License-00e5ff?style=for-the-badge)](LICENSE)

[![Stars](https://img.shields.io/github/stars/ignatiusmkuu-spec/IgniteBot?style=flat-square&color=00ff88&label=⭐+Stars)](https://github.com/ignatiusmkuu-spec/IgniteBot/stargazers)
[![Forks](https://img.shields.io/github/forks/ignatiusmkuu-spec/IgniteBot?style=flat-square&color=00e5ff&label=🍴+Forks)](https://github.com/ignatiusmkuu-spec/IgniteBot/fork)
[![WhatsApp](https://img.shields.io/badge/Contact-25D366?style=flat-square&logo=whatsapp&logoColor=white)](https://api.whatsapp.com/send?phone=254706535581&text=Hello+NEXUS-MD+dev)

</div>

---

<div align="center">

## ✨ Features

| 🤖 AI Chat | 📥 Media Download | 🛡 Group Guard | 🎵 Menu Song |
|:---:|:---:|:---:|:---:|
| 👁 View-Once Reveal | 🔴 EPL Live Scores | 🎨 Sticker Maker | 📊 Analytics |
| 👋 Welcome / Goodbye | 🚫 Anti-Delete | 🏷 Auto Tag All | ⏱ Always Online |

</div>

---

<div align="center">

## 🚀 Deploy in 3 Steps

**① Fork the repo**

[![Fork](https://img.shields.io/badge/FORK%20REPO-6f42c1?style=for-the-badge&logo=github&logoColor=white)](https://github.com/ignatiusmkuu-spec/IgniteBot/fork)

**② Get your session ID**

[![Session](https://img.shields.io/badge/PAIR%20SESSION-00ff88?style=for-the-badge&logo=whatsapp&logoColor=black)](https://nexs-session-1.replit.app)

**③ Deploy to Heroku**

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/ignatiusmkuu-spec/IgniteBot)

> Set `SESSION_ID` and `ADMIN_NUMBERS` in your Heroku Config Vars.

</div>

---

<div align="center">

## 🖥️ Panel Deployment (Pterodactyl / cPanel / VPS)

**① Download the bot as a ZIP**

[![Download ZIP](https://img.shields.io/badge/DOWNLOAD%20ZIP-FF6B35?style=for-the-badge&logo=github&logoColor=white)](https://github.com/ignatiusmkuu-spec/IgniteBot/archive/refs/heads/main.zip)

**② Upload & extract on your panel, then set up your config**

```bash
cp .env.example .env   # copy the template
nano .env              # fill in your SESSION_ID and ADMIN_NUMBERS
```

**③ Start the bot using the panel script (handles everything)**

```bash
bash scripts/panel.sh
```

> The script auto-installs dependencies, creates required folders, and starts the bot. On first run with no session it will print a QR code to scan.

**Or start manually:**

```bash
npm install
node index.js
```

**Required environment variables**

| Variable | Description |
|:---|:---|
| `SESSION_ID` | Your WhatsApp session (from pairing site) |
| `ADMIN_NUMBERS` | Your number e.g. `254706535581` |
| `PORT` | Dashboard port (default: `5000`) |
| `DATABASE_URL` | PostgreSQL URL — *optional*, local file used if blank |

> ℹ️ No database needed on panels — session and settings are automatically saved to `data/botstore.json` on the panel's persistent filesystem.

</div>

---

<div align="center">

## ⚙️ Key Commands

| Command | Action |
|:---|:---|
| `.menu` | Full command list |
| `.ping` | Bot status & latency |
| `.ai [text]` | Chat with AI |
| `.sticker` | Convert media to sticker |
| `.yt [url]` | Download YouTube audio |
| `.epl` | Live EPL scores |
| `.tagall` | Tag all group members |
| `.antidelete on` | Recover deleted messages |

</div>

---

<div align="center">

<img src="assets/footer.svg" width="100%" />

</div>
