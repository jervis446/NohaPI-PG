// Settings come from environment variables, so the same code runs on a laptop, a VM or in Docker.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Domains that sign Indian bank alert emails. An email counts only if one of these made its DKIM
// signature. Operators can replace the list with BANK_EMAIL_DOMAINS, and merchants can add their own.
export const DEFAULT_BANK_DOMAINS = [
  "hdfcbank.net", "hdfcbank.com", "hdfcbank.bank.in",
  "icicibank.com", "icici.bank.in",
  "sbi.co.in", "sbi.bank.in",
  "axisbank.com", "axis.bank.in",
  "kotak.com", "kotak.bank.in",
  "yesbank.in", "indusind.com", "idfcfirstbank.com",
  "pnb.co.in", "pnb.bank.in", "bankofbaroda.com", "bankofbaroda.bank.in",
  "canarabank.com", "unionbankofindia.co.in", "federalbank.co.in", "aubank.in",
];

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dbPath: string;
  orderMinutes: number;
  graceMinutes: number;
  alertKeepDays: number;
  bankDomains: string[];
  secureCookies: boolean;
}

export function loadConfig(): Config {
  const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:8080").replace(/\/+$/, "");
  return {
    port: num("PORT", 8080),
    host: process.env.HOST ?? "0.0.0.0",
    publicUrl,
    dbPath: process.env.DB_PATH ?? "data/noha-pay.db",
    orderMinutes: num("ORDER_MINUTES", 15),
    graceMinutes: num("GRACE_MINUTES", 30),
    alertKeepDays: num("ALERT_KEEP_DAYS", 30),
    bankDomains: list("BANK_EMAIL_DOMAINS", DEFAULT_BANK_DOMAINS),
    secureCookies: publicUrl.startsWith("https://"),
  };
}
