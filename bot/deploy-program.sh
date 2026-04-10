#!/bin/bash
# Deploy the Atomic Arb program to Solana mainnet
# Run on your VPS: bash deploy-program.sh
set -e

echo "═══════════════════════════════════════════════════"
echo "  ATOMIC ARB — Solana Program Deployment"
echo "═══════════════════════════════════════════════════"

# 1. Install Rust + Solana CLI + Anchor if not present
if ! command -v rustup &> /dev/null; then
  echo "[1/5] Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

if ! command -v solana &> /dev/null; then
  echo "[2/5] Installing Solana CLI..."
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi

if ! command -v anchor &> /dev/null; then
  echo "[3/5] Installing Anchor CLI..."
  cargo install --git https://github.com/coral-xyz/anchor avm --force
  avm install 0.30.1
  avm use 0.30.1
fi

# 2. Configure Solana for mainnet
echo "[4/5] Configuring Solana CLI for mainnet..."
solana config set --url https://api.mainnet-beta.solana.com

# Import keypair from SOLANA_PRIVATE_KEY env var if wallet doesn't exist
if [ ! -f ~/.config/solana/id.json ]; then
  echo "⚠️  No Solana wallet found at ~/.config/solana/id.json"
  echo "   Create one with: solana-keygen new"
  echo "   Or import your existing key"
  exit 1
fi

WALLET=$(solana address)
BALANCE=$(solana balance | awk '{print $1}')
echo "   Wallet: $WALLET"
echo "   Balance: $BALANCE SOL"
echo "   ⚠️  Program deployment costs ~2-3 SOL"

# 3. Build the program
echo "[5/5] Building Anchor program..."
cd "$(dirname "$0")/programs/atomic-arb"
anchor build

# 4. Get the program ID
PROGRAM_ID=$(anchor keys list | grep atomic_arb | awk '{print $NF}')
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Program built successfully!"
echo "  Program ID: $PROGRAM_ID"
echo "═══════════════════════════════════════════════════"
echo ""

# Update the program ID in lib.rs and Anchor.toml
sed -i "s/declare_id!(\"[^\"]*\")/declare_id!(\"$PROGRAM_ID\")/" src/lib.rs
sed -i "s/atomic_arb = \"[^\"]*\"/atomic_arb = \"$PROGRAM_ID\"/" Anchor.toml

# Rebuild with correct program ID
anchor build

echo "Ready to deploy. Run:"
echo "  anchor deploy --provider.cluster mainnet"
echo ""
echo "After deployment, set this env var on your VPS:"
echo "  export ATOMIC_ARB_PROGRAM_ID=$PROGRAM_ID"
echo ""
echo "Then restart the triad engine:"
echo "  pm2 restart ricky-triad"
