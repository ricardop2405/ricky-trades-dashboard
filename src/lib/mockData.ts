const TOKEN_NAMES = ["SOL", "BONK", "WIF", "JUP", "PYTH", "ORCA", "RAY", "MNGO", "STEP", "SRM", "FIDA", "COPE"];
const WALLETS = [
  "7xKX...q3Fp", "DRpb...kN4e", "9vMs...r2Wt", "Hk4e...bY7n", "Aq3j...mP8x",
  "Fx9w...dL2k", "Bm7v...sQ4r", "Lp2n...wK8f", "Cv5t...hR3m", "Ys8g...jN6b",
];

export interface WhaleTrade {
  id: string;
  timestamp: Date;
  wallet: string;
  tokenIn: string;
  tokenOut: string;
  amountUSD: number;
  txSignature: string;
  direction: "buy" | "sell";
}

export interface BundleResult {
  id: string;
  timestamp: Date;
  route: string;
  entryAmount: number;
  exitAmount: number;
  profit: number;
  jitoTip: number;
  status: "success" | "reverted";
  txSignature: string;
  triggerTx: string;
  latencyMs: number;
}

export interface PriceCandle {
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface TokenStat {
  token: string;
  tradeCount: number;
  totalVolume: number;
  buyCount: number;
  sellCount: number;
}

export interface WalletStat {
  wallet: string;
  tradeCount: number;
  totalVolume: number;
  lastSeen: Date;
  avgSize: number;
}

export interface VolumeBucket {
  time: string;
  volume: number;
  tradeCount: number;
}

export function deriveTokenStats(trades: WhaleTrade[]): TokenStat[] {
  const map = new Map<string, TokenStat>();
  for (const t of trades) {
    const token = t.direction === "buy" ? t.tokenOut : t.tokenIn;
    const existing = map.get(token) || { token, tradeCount: 0, totalVolume: 0, buyCount: 0, sellCount: 0 };
    existing.tradeCount++;
    existing.totalVolume += t.amountUSD;
    if (t.direction === "buy") existing.buyCount++;
    else existing.sellCount++;
    map.set(token, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.totalVolume - a.totalVolume);
}

export function deriveWalletStats(trades: WhaleTrade[]): WalletStat[] {
  const map = new Map<string, WalletStat>();
  for (const t of trades) {
    const existing = map.get(t.wallet) || { wallet: t.wallet, tradeCount: 0, totalVolume: 0, lastSeen: t.timestamp, avgSize: 0 };
    existing.tradeCount++;
    existing.totalVolume += t.amountUSD;
    if (t.timestamp > existing.lastSeen) existing.lastSeen = t.timestamp;
    map.set(t.wallet, existing);
  }
  return Array.from(map.values())
    .map(w => ({ ...w, avgSize: w.totalVolume / w.tradeCount }))
    .sort((a, b) => b.totalVolume - a.totalVolume);
}

export function deriveVolumeBuckets(trades: WhaleTrade[], bucketMinutes = 5): VolumeBucket[] {
  if (trades.length === 0) return [];
  const now = Date.now();
  const bucketMs = bucketMinutes * 60 * 1000;
  const bucketCount = 24; // show last N buckets
  const buckets: VolumeBucket[] = [];

  for (let i = bucketCount - 1; i >= 0; i--) {
    const start = now - (i + 1) * bucketMs;
    const end = now - i * bucketMs;
    const inBucket = trades.filter(t => t.timestamp.getTime() >= start && t.timestamp.getTime() < end);
    buckets.push({
      time: new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      volume: inBucket.reduce((s, t) => s + t.amountUSD, 0),
      tradeCount: inBucket.length,
    });
  }
  return buckets;
}

let tradeIdCounter = 0;
let bundleIdCounter = 0;

export function generateWhaleTrade(): WhaleTrade {
  const tokenIn = TOKEN_NAMES[Math.floor(Math.random() * TOKEN_NAMES.length)];
  let tokenOut = TOKEN_NAMES[Math.floor(Math.random() * TOKEN_NAMES.length)];
  while (tokenOut === tokenIn) tokenOut = TOKEN_NAMES[Math.floor(Math.random() * TOKEN_NAMES.length)];
  const amountUSD = Math.random() > 0.3
    ? 5000 + Math.random() * 15000
    : 20000 + Math.random() * 480000;

  return {
    id: `trade-${++tradeIdCounter}`,
    timestamp: new Date(),
    wallet: WALLETS[Math.floor(Math.random() * WALLETS.length)],
    tokenIn,
    tokenOut,
    amountUSD,
    txSignature: `${Math.random().toString(36).slice(2, 10)}...${Math.random().toString(36).slice(2, 6)}`,
    direction: Math.random() > 0.5 ? "buy" : "sell",
  };
}

export function generateBundleResult(trigger: WhaleTrade): BundleResult {
  const isSuccess = Math.random() > 0.35;
  const jitoTip = 0.001 + Math.random() * 0.01;
  const entryAmount = 100 + Math.random() * 400;
  const profit = isSuccess ? 0.05 + Math.random() * 2.5 : 0;

  return {
    id: `bundle-${++bundleIdCounter}`,
    timestamp: new Date(),
    route: `USDC → SOL → ${trigger.tokenOut} → USDC`,
    entryAmount,
    exitAmount: isSuccess ? entryAmount + profit : entryAmount,
    profit,
    jitoTip,
    status: isSuccess ? "success" : "reverted",
    txSignature: `${Math.random().toString(36).slice(2, 10)}...${Math.random().toString(36).slice(2, 6)}`,
    triggerTx: trigger.txSignature,
    latencyMs: 50 + Math.floor(Math.random() * 300),
  };
}

export function generate5MinCandles(count: number): PriceCandle[] {
  const candles: PriceCandle[] = [];
  let price = 145 + Math.random() * 10;
  const now = Date.now();

  for (let i = count - 1; i >= 0; i--) {
    const open = price;
    const change = (Math.random() - 0.48) * 3;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * 1.5;
    const low = Math.min(open, close) - Math.random() * 1.5;
    const time = new Date(now - i * 5 * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    candles.push({ time, open, close, high, low, volume: 1000 + Math.random() * 5000 });
    price = close;
  }
  return candles;
}
