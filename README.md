# ⚡ IgniteBot — Full-Featured WhatsApp Bot

> A powerful WhatsApp bot built with Node.js and Baileys with 30+ features including AI chat, sticker maker, media downloader, group management, e-commerce, booking system, and a live analytics dashboard.
<div align="center">


<a href="https://heroku.com/deploy?template=https://github.com/ignatiusmkuu-spec/IgniteBot">

<button style="
background: linear-gradient(45deg,#ff0000,#ff7300,#fffb00,#48ff00,#00ffd5,#002bff,#7a00ff,#ff00c8);
border: none;
color: white;
padding: 15px 40px;
font-size: 20px;
border-radius: 30px;
cursor: pointer;
box-shadow: 0 0 20px #ff00c8;
animation: glow 2s infinite alternate;
">

🚀 Deploy IgniteBot

</button>

</a>

</div>

<style>
@keyframes glow {
from {
box-shadow: 0 0 10px #ff00c8;
}
to {
box-shadow: 0 0 30px #ff00c8;
}
}
</style>

## 🚀 Features

### 🤖 AI Powered
| Feature | Command |
|---------|---------|
| Smart AI Chat | `!ai [message]` |
| Ask Questions | `!ask [question]` |
| Summarize Text | `!summarize [text]` |
| Generate AI Images | `!imagine [prompt]` |
| Text to Speech | `!tts [text]` |
| Clear AI History | `!clearchat` |

### 🌍 Tools
| Feature | Command |
|---------|---------|
| Translate Messages | `!tr [lang] [text]` |
| Download Videos | `!dl [url]` |
| Download Audio | `!yt [url]` |
| Music Search | `!music [query]` |
| Sticker Maker | `!sticker` (reply to image/video) |
| File Converter | `!convert` (reply to file) |

### 🛡 Security & Protection
| Feature | Command |
|---------|---------|
| Anti-Spam | `!antispam on/off` |
| Anti-Link | `!antilink on/off` |
| Anti-Delete | `!antidelete on/off` |
| Anti-Delete Status | `!antideletestatus on/off` |
| Anti-Call | `!anticall on/off` |
| Anti-Mention Group | `!antimentiongroup on/off` |
| Anti-Tag | `!antitag on/off` |

### ⚙️ Bot Controls
| Feature | Command |
|---------|---------|
| Bot Mode (public/private/group) | `!mode public` |
| Auto View Status | `!autoview on/off` |
| Auto Like Status | `!autolike on/off` |
| Always Online | `!alwaysonline on/off` |
| Auto Read Messages | Built-in |
| Auto Detect Typed Messages | Built-in |

### 👥 Group Management
| Feature | Command |
|---------|---------|
| Welcome Messages | `!setwelcome [message]` |
| Tag All Members | `!tagall [message]` |
| Kick Member | `!kick @user` |
| Promote/Demote | `!promote / !demote @user` |
| Mute/Unmute Group | `!mute / !unmute` |

### 🛒 E-Commerce & Booking
| Feature | Command |
|---------|---------|
| Product Catalog | `!shop` |
| Place Order | `!order [id]` |
| Book Appointment | `!book [#] [date] [time]` |
| View Bookings | `!mybookings` |
| Broadcast Messages | `!broadcast [message]` |

### 📊 Analytics Dashboard
- Real-time bot statistics
- Command usage tracking
- User activity monitoring
- Booking & order management
- Broadcast history
- Accessible at `/dashboard`

---

## 🖥 Heroku Deployment

### Option 1: One-Click Deploy (Recommended)

1. Click the **Deploy to Heroku** button at the top
2. Fill in the app name and environment variables
3. Click **Deploy App**
4. Once deployed, click **Open App**
5. Scan the QR code or use **Pair Device** to connect

> ⚠️ **Important:** After deploying, Heroku's free dynos sleep after 30 minutes. Use a paid dyno or [Kaffeine](https://kaffeine.herokuapp.com/) to keep it alive.

### Option 2: Manual Heroku Deployment

**Prerequisites:** [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) installed

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/ignitebot
cd ignitebot

# 2. Login to Heroku
heroku login

# 3. Create a new Heroku app
heroku create your-ignitebot-name

# 4. Set environment variables
heroku config:set OPENAI_API_KEY=your_openai_key_here
heroku config:set ADMIN_NUMBERS=12345678901,447911123456
heroku config:set NODE_ENV=production

# 5. Deploy
git push heroku main

# 6. Ensure at least one dyno is running
heroku ps:scale web=1

# 7. Open your app
heroku open
```

### Option 3: Heroku via GitHub

1. Push your code to GitHub
2. Go to [Heroku Dashboard](https://dashboard.heroku.com) → New → Create new app
3. Go to **Deploy** tab → Connect to GitHub
4. Search for your repository and connect
5. Enable **Automatic Deploys** (optional)
6. Click **Deploy Branch**
7. Open the app and connect your WhatsApp

---

## 🔗 Pairing Session

There are two ways to connect your WhatsApp account:

### Method 1: QR Code (Default)
1. Open your deployed app URL
2. A QR code will be displayed on the page
3. Open WhatsApp → Menu (⋮) → Linked Devices → Link a Device
4. Scan the QR code

### Method 2: Phone Number Pairing (No QR)
1. Open your deployed app URL
2. Click **🔗 Pair Device** button
3. Enter your phone number in international format (e.g., `12345678901`)
4. Click **Get Pairing Code**
5. Open WhatsApp → Menu (⋮) → Linked Devices → Link with phone number
6. Enter the 8-character code displayed

### Re-Pairing
If the session expires or you get logged out:
- The bot automatically clears the session and shows a new QR code
- Just scan again or use the pairing code method

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---------|---------|-------------|
| `OPENAI_API_KEY` | Optional | Enables AI chat, image generation, TTS. Get from [platform.openai.com](https://platform.openai.com/api-keys) |
| `ADMIN_NUMBERS` | Optional | Comma-separated admin phone numbers (no `+`). Example: `12345678901,447911123456` |
| `PORT` | Auto | Set automatically by Heroku |
| `NODE_ENV` | Optional | Set to `production` for production |

---

## 💬 Bot Commands

Type `!menu` in any WhatsApp chat to see all available commands.

### Command Prefix
The default command prefix is `!` — all commands start with `!`.

### Mode Settings
| Mode | Description |
|------|-------------|
| `!mode public` | Bot responds to everyone (default) |
| `!mode private` | Bot only responds to admins |
| `!mode group` | Bot only responds in groups |

### Keyword Triggers
Set custom auto-replies for specific words:
```
!setkeyword hello|Hi there! Welcome! 👋
!setkeyword price|Check our products with !shop
!delkeyword hello
!keywords
```

### Menu Video
Send a video as your menu instead of text:
```
1. Send/forward a video to any chat
2. Reply to it with: !setmenuvideo
3. Now !menu sends that video with the menu text as caption
4. To remove: !clearmenuvideo
```

---

## 🛠 Local Development

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/ignitebot
cd ignitebot

# Install dependencies
npm install

# Set environment (optional)
export OPENAI_API_KEY=your_key
export ADMIN_NUMBERS=your_number

# Start
npm start
```

Open [http://localhost:5000](http://localhost:5000) and scan the QR code.

---

## 📁 Project Structure

```
ignitebot/
├── index.js              # Main entry + web server
├── config.js             # Bot configuration
├── Procfile              # Heroku process file
├── app.json              # Heroku deploy button config
├── lib/
│   ├── commands.js       # Command router (all commands)
│   ├── ai.js             # OpenAI integration
│   ├── sticker.js        # Sticker creation
│   ├── downloader.js     # Media downloader
│   ├── translator.js     # Translation
│   ├── converter.js      # File conversion
│   ├── analytics.js      # Usage tracking
│   ├── store.js          # E-commerce
│   ├── booking.js        # Booking system
│   ├── broadcast.js      # Mass messaging
│   ├── security.js       # Anti-spam/link/delete
│   ├── groups.js         # Group management
│   ├── settings.js       # Bot global settings
│   ├── admin.js          # Admin controls
│   ├── keywords.js       # Keyword triggers
│   ├── language.js       # Multi-language support
│   └── datastore.js      # JSON data store
├── web/
│   └── dashboard.js      # Analytics dashboard
└── data/                 # Runtime data (gitignored)
```

---

## 📝 Notes

- **Session persistence on Heroku:** Heroku's ephemeral filesystem means the WhatsApp session (`auth_info_baileys/`) is lost on dyno restart. To persist sessions, connect a database add-on or use a persistent storage solution.
- **Rate limits:** Avoid sending too many messages rapidly to prevent WhatsApp from temporarily banning your number.
- **AI features:** Requires a valid `OPENAI_API_KEY`. Without it, AI commands show a helpful error message.

---

## 📄 License

MIT License — free to use and modify.

---

Made with ❤️ using [Baileys](https://github.com/WhiskeySockets/Baileys) and [OpenAI](https://openai.com)
