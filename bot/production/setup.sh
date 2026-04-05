#!/bin/bash
set -e

echo "═══════════════════════════════════════════════════"
echo "  RICKY TRADES — Production Setup"
echo "═══════════════════════════════════════════════════"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install it first:"
  echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "   sudo apt-get install -y nodejs"
  exit 1
fi

echo "✓ Node.js $(node -v)"

# Install PM2 globally if not present
if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
fi
echo "✓ PM2 $(pm2 -v)"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Check for .env
if [ ! -f .env ]; then
  echo ""
  echo "⚠️  No .env file found!"
  echo "   Copy the example and fill in your values:"
  echo ""
  echo "   cp .env.example .env"
  echo "   nano .env"
  echo ""
  echo "Required keys:"
  echo "  • SOLANA_PRIVATE_KEY  — Your wallet's base58 private key"
  echo "  • HELIUS_RPC_URL      — Get free at https://helius.dev"
  echo "  • SUPABASE_SERVICE_ROLE_KEY — From Lovable Cloud settings"
  echo ""
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ Setup complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Commands:"
echo "  npm run mev        — Start MEV engine only"
echo "  npm run arb        — Start Arb engine only"
echo "  npm run both       — Start both engines"
echo ""
echo "PM2 (recommended for production):"
echo "  pm2 start ecosystem.config.js"
echo "  pm2 logs"
echo "  pm2 status"
echo "  pm2 stop all"
echo "  pm2 save && pm2 startup  — Auto-restart on reboot"
echo ""
