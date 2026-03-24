#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────
#  NEXUS-MD / IgniteBot — Panel Startup Script
#  For: Pterodactyl, cPanel, DirectAdmin, FastPanel, VPS/bare-metal
#
#  Usage:
#    bash scripts/panel.sh
#
#  Environment variables (create a .env file or set them in your panel):
#    SESSION_ID      — Your WhatsApp session ID (any format)
#    ADMIN_NUMBERS   — Comma-separated owner phone numbers (no +)
#    PORT            — HTTP port for the web dashboard (default: 5000)
#    PRINT_QR        — Set to "true" to print QR code in terminal on first run
#    APP_URL         — Leave blank on panels (persistent filesystem, no sleep)
#
#  .env file example:
#    SESSION_ID=NEXUS-MD:~xxxxxxxxxxxxx
#    ADMIN_NUMBERS=254706535581
#    PORT=5000
# ────────────────────────────────────────────────────────────────

# NOTE: Do NOT use set -e here. Minor issues (missing .env, etc.) should
# not abort the startup — the bot handles errors internally.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$BOT_DIR"

# ── Load .env if present ─────────────────────────────────────────
if [ -f ".env" ]; then
  echo "📄 Loading .env..."
  # export each non-comment, non-empty line
  set -o allexport
  # shellcheck disable=SC1091
  source .env || echo "⚠️  .env load had warnings (continuing anyway)"
  set +o allexport
fi

# ── Defaults ──────────────────────────────────────────────────────
export PORT="${PORT:-5000}"
export NODE_ENV="${NODE_ENV:-production}"
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}"
# On panels the filesystem is persistent — no DATABASE_URL needed.
# Settings and session metadata are saved to data/botstore.json automatically.

# ── Check Node.js ─────────────────────────────────────────────────
NODE_MIN=20
NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [ "$NODE_VER" -lt "$NODE_MIN" ] 2>/dev/null; then
  echo "❌  Node.js $NODE_MIN+ required (found v$NODE_VER). Please upgrade."
  exit 1
fi
echo "✅  Node.js $(node --version) detected"

# ── Install dependencies if node_modules is missing ──────────────
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies (this may take a minute)..."
  npm install --omit=dev --no-audit --no-fund
  if [ $? -ne 0 ]; then
    echo "⚠️  npm install had errors — trying without --omit=dev..."
    npm install --no-audit --no-fund
  fi
fi

# ── Create required directories ───────────────────────────────────
mkdir -p data auth_info_baileys

# ── Print first-run hint ──────────────────────────────────────────
if [ ! -f "auth_info_baileys/creds.json" ] && [ -z "$SESSION_ID" ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " 🔑 FIRST RUN: No session found."
  echo " Get a session ID at: https://nexs-session-1.replit.app"
  echo " Add it to your .env as:  SESSION_ID=NEXUS-MD:~..."
  echo " OR set SESSION_ID in your panel environment variables."
  echo " OR: a QR code will appear — scan it with WhatsApp."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  export PRINT_QR=true
fi

# ── Launch bot ────────────────────────────────────────────────────
echo "🚀 Starting NEXUS-MD bot (port $PORT)..."
exec node --max-old-space-size=512 index.js
