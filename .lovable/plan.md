

# Fix MEV Engine Startup Errors

## Two Problems

### 1. Missing `@solana/spl-token` package
The engine imports `getAssociatedTokenAddress` and `getAccount` from `@solana/spl-token`, but this package isn't in `package.json`. That's causing the TS2305 errors.

**Fix**: Add `"@solana/spl-token": "^0.4.6"` to `package.json` dependencies.

### 2. Helius WebSocket DNS failure
The error `getaddrinfo ENOTFOUND mainnet.helius-rpc.com` means your `HELIUS_WS` env var is pointing to a wrong hostname. Helius WebSocket URLs look like:
```
wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```
If you don't have `HELIUS_WS` set in `.env`, the fallback tries to convert `HELIUS_HTTP` but may produce a bad URL.

**Fix**: Make sure your `.env` has the correct Helius endpoints with your API key:
```
HELIUS_HTTP=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

Also update the `mev` script to use `--transpile-only` (skips type checking, runs faster — same as the other engines):
```
"mev": "ts-node --transpile-only src/mev-engine.ts"
```

## Steps After I Apply Changes

Run on your machine:
```bash
cd bot/production
npm install
# Update .env with correct HELIUS_HTTP and HELIUS_WS
pm2 restart ricky-mev
pm2 logs ricky-mev
```

## Files Changed

| File | Change |
|------|--------|
| `bot/production/package.json` | Add `@solana/spl-token` dependency, update mev script to `--transpile-only` |

