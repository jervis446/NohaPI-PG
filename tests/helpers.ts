import { createMerchant } from "../src/accounts.ts";
import type { Config } from "../src/config.ts";
import { DEFAULT_BANK_DOMAINS } from "../src/config.ts";
import { openDb } from "../src/db.ts";

export const T0 = Date.UTC(2026, 10, 22, 6, 0, 0);

export function setup(over: Partial<Config> = {}) {
  const cfg: Config = {
    port: 0, host: "127.0.0.1", publicUrl: "http://localhost:8080", dbPath: ":memory:",
    orderMinutes: 15, graceMinutes: 30, alertKeepDays: 30, bankDomains: DEFAULT_BANK_DOMAINS, secureCookies: false, ...over,
  };
  const db = openDb(":memory:");
  const merchant = createMerchant(db, { name: "Asha Stores", vpa: "asha@okhdfcbank" }, T0);
  return { db, cfg, merchant };
}

export const credit = (paise: string, utr = "412345678901") =>
  `Rs.${paise} credited to your A/c XX1234 on 22-11-26 by UPI Ref No ${utr}. -HDFC Bank`;
