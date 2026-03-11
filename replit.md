# IgniteBot — WhatsApp Bot

A full-featured WhatsApp bot with 30+ features built on Node.js and Baileys.

## Architecture

- **Runtime**: Node.js 20
- **WhatsApp library**: @whiskeysockets/baileys
- **Web server**: Express (port 5000 in dev, `process.env.PORT` on Heroku)
- **Data storage**: JSON files in `data/` directory
- **AI**: OpenAI (chat, images, TTS, translation)

## Project Structure

```
index.js          — Main entry: web server + all WA event handlers
config.js         — Bot configuration and defaults
Procfile          — Heroku start command
app.json          — Heroku one-click deploy config
lib/
  commands.js     — All command handlers (30+ commands)
  ai.js           — OpenAI: chat, images, TTS, summarize
  sticker.js      — Image/video to WebP sticker
  downloader.js   — YouTube media downloader
  translator.js   — Translation via OpenAI / MyMemory API
  converter.js    — File format conversion (ffmpeg, sharp, pdf-lib)
  analytics.js    — Usage tracking and statistics
  store.js        — E-commerce product catalog and orders
  booking.js      — Appointment booking system
  broadcast.js    — Mass messaging
  security.js     — Anti-spam, anti-link, anti-delete, anti-mention
  groups.js       — Welcome/goodbye messages, tag all, group info
  settings.js     — Global bot settings (mode, autoview, anticall, etc.)
  admin.js        — Admin validation and group controls
  keywords.js     — Custom keyword auto-replies
  language.js     — Per-user language preferences
  datastore.js    — JSON file data layer
web/
  dashboard.js    — Analytics dashboard Express routes + HTML
data/             — Runtime JSON data (gitignored)
```

## Features (30+)

### Core
- `!menu` / `!help` — Command menu (text or video format)
- `!ping` — Health check
- `!time` — Server time
- `!stats` — Analytics dashboard

### AI (requires OPENAI_API_KEY)
- `!ai [text]` — Smart AI chat with conversation history
- `!ask [question]` — One-shot questions
- `!summarize [text]` — Summarize any text
- `!imagine [prompt]` — DALL-E image generation
- `!tts [text]` — OpenAI text-to-speech
- `!clearchat` — Clear AI conversation history

### Tools
- `!tr [lang] [text]` — Translate (OpenAI + MyMemory fallback)
- `!langs` — List supported languages
- `!dl [url]` — Download YouTube video
- `!yt [url]` — Download YouTube audio (MP3)
- `!music [query]` — Search YouTube for music
- `!sticker` — Convert image/video to WhatsApp sticker
- `!convert` — Convert file formats (video→audio, image→PDF, etc.)

### New Features Added
- `!autoview on/off` — Auto view all WhatsApp statuses
- `!autolike on/off` — Auto like statuses with ❤️
- `!mode public/private/group` — Control who bot responds to
- `!alwaysonline on/off` — Keep presence as "Online"
- `!anticall on/off` — Auto-reject incoming calls
- `!antideletestatus on/off` — Cache and forward deleted statuses to admin
- `!antimentiongroup on/off` — Block mass @mentions in groups
- `!antitag on/off` — Block mass tag spam in groups
- `!setmenuvideo` — Set a video for the !menu command
- `!clearmenuvideo` — Remove menu video
- `!pairing` — Get WhatsApp pairing code (no QR needed)
- Auto detect typing — Logs when users type in subscribed chats
- Auto-read messages — Marks messages as read on receipt

### Group Management
- `!setwelcome [msg]` — Custom welcome message (use {{name}}, {{group}})
- `!tagall [msg]` — Mention all group members
- `!groupinfo` — Group details
- `!kick / !promote / !demote` — Manage members
- `!mute / !unmute` — Control who can send messages
- `!antilink on/off` — Delete links from non-admins
- `!antispam on/off` — Rate-limit messages
- `!antidelete on/off` — Show deleted messages

### Security
- `!ban / !unban @user` — Block users from bot
- `!warn @user` — Issue warnings (3 = alert)
- `!warnings @user` — Check warning count

### E-Commerce
- `!shop / !catalog` — View product catalog
- `!order [id]` — Place an order
- `!myorders` — View order history

### Booking
- `!services` — Available booking services
- `!book [#] [date] [time]` — Book appointment
- `!mybookings` — View bookings
- `!cancel [id]` — Cancel booking

### Broadcast
- `!broadcast [msg]` — Send to all registered contacts
- Auto-registers users who message the bot

### Keywords & Settings
- `!setkeyword [trigger]|[response]` — Add auto-reply
- `!delkeyword [trigger]` — Remove auto-reply
- `!keywords` — List all keywords
- `!botsettings` — View current bot settings
- `!lang [code]` — Set personal language preference

## Web Routes
- `/` — Main page (QR code or bot status)
- `/pair` — Phone number pairing page (no QR needed)
- `/dashboard` — Analytics dashboard
- `/api/stats` — JSON stats endpoint
- `/api/products` — Product catalog
- `/api/bookings` — Booking list
- `/api/broadcasts` — Broadcast history
- `/status` — Bot status JSON

## Environment Variables
- `OPENAI_API_KEY` — For AI features (optional but recommended)
- `ADMIN_NUMBERS` — Comma-separated admin phone numbers without `+`
- `PORT` — Auto-set by Heroku

## Heroku Deployment
- `Procfile`: `web: node index.js`
- `app.json`: One-click deploy config
- Deploy button in README.md
- Session note: WhatsApp session stored in `auth_info_baileys/` (ephemeral on Heroku — re-pair on dyno restart)

## Authentication
- QR code via web page (auto-refreshes every 5 seconds)
- Phone pairing code via `/pair` page (no QR needed)
- Auto-reconnect on disconnect
- Auto-clear session and re-pair on logout
