import { TOKEN_NAMES } from "./constants";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.toLowerCase().includes("rate limited");
}

export function getTokenName(mint: string): string {
  return TOKEN_NAMES[mint] || mint.slice(0, 4) + "..." + mint.slice(-4);
}
