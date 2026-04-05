#!/bin/bash
# ═══════════════════════════════════════════════════
#  RICKY TRADES — One-Line Download & Setup
# ═══════════════════════════════════════════════════
#
#  Run this on your computer:
#    curl -sL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/bot/production/download.sh | bash
#
#  OR if you already cloned the repo:
#    cd bot/production && chmod +x download.sh && ./download.sh
#
set -e

echo "═══════════════════════════════════════════════════"
echo "  RICKY TRADES — Quick Setup"
echo "═══════════════════════════════════════════════════"
echo ""

# Detect if we're inside the repo already
if [ -f "src/mev-engine.ts" ]; then
  echo "✓ Already in bot/production directory"
  BOT_DIR="$(pwd)"
elif [ -f "bot/production/src/mev-engine.ts" ]; then
  echo "✓ Found bot/production from repo root"
  BOT_DIR="$(pwd)/bot/production"
  cd "$BOT_DIR"
else
  echo "⚠️  Can't find bot files. Make sure you're in the repo root or bot/production/"
  exit 1
fi

echo ""
echo "📁 Bot directory: $BOT_DIR"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install it:"
  echo "   https://nodejs.org/en/download"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Install PM2
if ! command -v pm2 &> /dev/null; then
  echo "📦 Installing PM2..."
  npm install -g pm2
fi
echo "✓ PM2 $(pm2 -v)"

# Install deps
echo ""
echo "📦 Installing dependencies..."
cd "$BOT_DIR"
npm install

# Setup .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  📝 CONFIGURE YOUR .env FILE"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  Open: $BOT_DIR/.env"
  echo ""
  echo "  Fill in these 3 required keys:"
  echo ""
  echo "  1. SOLANA_PRIVATE_KEY=<your base58 private key>"
  echo "  2. HELIUS_RPC_URL=wss://mainnet.helius-rpc.com/?api-key=<YOUR_KEY>"
  echo "  3. SUPABASE_SERVICE_ROLE_KEY=<from Lovable Cloud>"
  echo ""
  echo "  Then run:  pm2 start ecosystem.config.js"
  echo "═══════════════════════════════════════════════════"
else
  echo "✓ .env already exists"
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  ✅ Ready to go!"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  Start:   pm2 start ecosystem.config.js"
  echo "  Logs:    pm2 logs"
  echo "  Status:  pm2 status"
  echo "  Stop:    pm2 stop all"
  echo "═══════════════════════════════════════════════════"
fi
