// Noha Money: a store wallet per customer per merchant. It can be topped up, earn cashback and be
// spent at the same merchant. There is deliberately no way to withdraw it or send it to someone else.

import { newId } from "./crypto.ts";
import { tx, type DB } from "./db.ts";
import { enqueue } from "./webhooks.ts";

export type EntryKind = "topup" | "cashback" | "spend" | "refund" | "adjust";

export interface Entry {
  id: string;
  merchant_id: string;
  customer_id: string;
  kind: EntryKind;
  amount: number;
  balance_after: number;
  order_id: string | null;
  note: string | null;
  idem_key: string;
  created_at: number;
}

export class WalletError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const WALLET_LIMIT = 2_00_000_00; // ₹2 lakh, the most one wallet can hold
const LIMIT = WALLET_LIMIT;

export function balance(db: DB, merchantId: string, customerId: string): number {
  const row = db.prepare(
    "select balance_after from wallet_entries where merchant_id = ? and customer_id = ? order by created_at desc, rowid desc limit 1",
  ).get(merchantId, customerId) as { balance_after: number } | undefined;
  return row?.balance_after ?? 0;
}

export function entryJson(e: Entry) {
  return {
    id: e.id,
    object: "wallet_entry",
    customer_id: e.customer_id,
    kind: e.kind,
    amount: e.amount,
    balance_after: e.balance_after,
    order_id: e.order_id,
    note: e.note,
    idempotency_key: e.idem_key,
    created_at: new Date(e.created_at).toISOString(),
  };
}

interface Extra { orderId?: string | null; note?: string | null; now?: number }

function write(db: DB, merchantId: string, customerId: string, kind: EntryKind, signed: number, idemKey: string, extra: Extra): Entry {
  const now = extra.now ?? Date.now();
  return tx(db, () => {
    const seen = db.prepare("select * from wallet_entries where merchant_id = ? and idem_key = ?").get(merchantId, idemKey) as Entry | undefined;
    if (seen) {
      if (seen.customer_id !== customerId || seen.amount !== signed || seen.kind !== kind) {
        throw new WalletError(409, "idempotency_conflict", "This idempotency key was already used for a different wallet change");
      }
      return seen;
    }
    const after = balance(db, merchantId, customerId) + signed;
    if (after < 0) throw new WalletError(402, "insufficient_balance", "Not enough Noha Money in this wallet");
    if (after > LIMIT) throw new WalletError(400, "wallet_limit", "A wallet can hold at most ₹2,00,000");
    const id = newId("wal");
    db.prepare(
      `insert into wallet_entries (id, merchant_id, customer_id, kind, amount, balance_after, order_id, note, idem_key, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, merchantId, customerId, kind, signed, after, extra.orderId ?? null, extra.note ?? null, idemKey, now);
    const entry = db.prepare("select * from wallet_entries where id = ?").get(id) as unknown as Entry;
    const test = customerId.startsWith("test:");
    const json = entryJson(entry);
    enqueue(db, merchantId, "wallet.updated", { mode: test ? "test" : "live", entry: { ...json, customer_id: json.customer_id.replace(/^test:/, "") } }, now);
    return entry;
  });
}

function checkAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > LIMIT) {
    throw new WalletError(400, "invalid_amount", "amount must be a whole number of paise above 0");
  }
  return amount;
}

export function checkCustomer(id: unknown): string {
  if (typeof id !== "string" || !/^[\w.:@-]{1,64}$/.test(id)) {
    throw new WalletError(400, "invalid_customer", "customer id must be up to 64 letters, digits or - _ . : @");
  }
  return id;
}

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length < 8 || key.length > 100) {
    throw new WalletError(400, "idempotency_key_required", "Send an Idempotency-Key header (8 to 100 characters) so a retry doesn't count twice");
  }
  return key;
}

/** Adds money: a paid top-up, cashback, a returned spend, or a positive correction. */
export function credit(db: DB, merchantId: string, customerId: string, kind: "topup" | "cashback" | "refund" | "adjust", amount: number, idemKey: string, extra: Extra = {}): Entry {
  return write(db, merchantId, checkCustomer(customerId), kind, checkAmount(amount), checkKey(idemKey), extra);
}

/** Takes money: a purchase at this merchant, or a negative correction. Never below zero. */
export function debit(db: DB, merchantId: string, customerId: string, kind: "spend" | "adjust", amount: number, idemKey: string, extra: Extra = {}): Entry {
  return write(db, merchantId, checkCustomer(customerId), kind, -checkAmount(amount), checkKey(idemKey), extra);
}

export function entries(db: DB, merchantId: string, customerId: string, limit = 50): Entry[] {
  return db.prepare(
    "select * from wallet_entries where merchant_id = ? and customer_id = ? order by created_at desc, rowid desc limit ?",
  ).all(merchantId, customerId, Math.min(Math.max(limit, 1), 200)) as unknown as Entry[];
}

/** Total Noha Money a merchant owes its customers, for their books. */
export function outstanding(db: DB, merchantId: string): { wallets: number; total: number } {
  const r = db.prepare(
    `select count(*) as wallets, coalesce(sum(balance_after), 0) as total from (
       select customer_id, balance_after, row_number() over (partition by customer_id order by created_at desc, rowid desc) as n
         from wallet_entries where merchant_id = ?) where n = 1 and balance_after > 0`,
  ).get(merchantId) as { wallets: number; total: number };
  return { wallets: Number(r.wallets), total: Number(r.total) };
}
