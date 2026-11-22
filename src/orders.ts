// Orders: creating them with a unique amount, and every way they can change state.

import type { Config } from "./config.ts";
import { randomText } from "./crypto.ts";
import { tx, type DB } from "./db.ts";
import { upiUrl } from "./upi.ts";
import { enqueue } from "./webhooks.ts";
import { balance, credit, debit, WALLET_LIMIT, WalletError } from "./wallet.ts";

export type Mode = "live" | "test";
export type Status = "created" | "claimed" | "paid" | "declined" | "expired" | "refunded";
export type PaidVia = "alert" | "utr_and_alert" | "merchant" | "test";

export interface MerchantRow {
  id: string;
  name: string;
  vpa: string;
  payee_name: string;
  order_minutes: number | null;
  webhook_url: string | null;
  webhook_secret: string;
  email_token: string;
  extra_bank_domains: string;
  created_at: number;
}

export interface OrderRow {
  id: string;
  merchant_id: string;
  mode: Mode;
  reference: string;
  purpose: "payment" | "wallet_topup";
  amount: number;
  pay_amount: number;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  notes: string | null;
  return_url: string | null;
  status: Status;
  utr: string | null;
  paid_via: PaidVia | null;
  alert_id: string | null;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  paid_at: number | null;
  closed_at: number | null;
}

export class OrderError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Highest number of paise added to keep amounts apart. 0 to 99 gives 100 slots per price. */
const MAX_OFFSET = 99;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function checkoutUrl(cfg: Config, id: string): string {
  return `${cfg.publicUrl}/pay/${id}`;
}

export function upiFor(m: MerchantRow, o: OrderRow): string {
  return upiUrl({ vpa: m.vpa, payeeName: m.payee_name, paise: o.pay_amount, note: `Order ${o.reference}`, ref: o.id });
}

/** The order as merchants see it in the API and in webhooks. */
export function orderJson(cfg: Config, m: MerchantRow, o: OrderRow) {
  return {
    id: o.id,
    object: "order",
    mode: o.mode,
    reference: o.reference,
    purpose: o.purpose,
    amount: o.amount,
    pay_amount: o.pay_amount,
    currency: "INR",
    status: o.status,
    utr: o.utr,
    paid_via: o.paid_via,
    customer: o.customer_id || o.customer_name || o.customer_email || o.customer_phone
      ? { id: o.customer_id, name: o.customer_name, email: o.customer_email, phone: o.customer_phone }
      : null,
    notes: o.notes,
    return_url: o.return_url,
    checkout_url: checkoutUrl(cfg, o.id),
    upi_url: o.status === "created" || o.status === "claimed" ? upiFor(m, o) : null,
    created_at: iso(o.created_at),
    expires_at: iso(o.expires_at),
    claimed_at: iso(o.claimed_at),
    paid_at: iso(o.paid_at),
    closed_at: iso(o.closed_at),
  };
}

export interface NewOrder {
  amount?: unknown;
  reference?: unknown;
  purpose?: unknown;
  customer?: unknown;
  notes?: unknown;
  return_url?: unknown;
  expires_in?: unknown;
}

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

function cleanReturnUrl(v: unknown): string | null {
  const s = text(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.toString();
  } catch { /* falls through */ }
  throw new OrderError(400, "invalid_return_url", "return_url must be an https:// address");
}

function clean(input: NewOrder, defaultMinutes: number) {
  const amount = input.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 100 || amount > 100_000_00) {
    throw new OrderError(400, "invalid_amount", "amount must be a whole number of paise between 100 (₹1) and 1,00,00,000 (₹1 lakh)");
  }
  const reference = text(input.reference, 64);
  if (!reference || !/^[\w.:\/-]+$/.test(reference)) {
    throw new OrderError(400, "invalid_reference", "reference is required: your own order id, up to 64 letters, digits, - _ . : /");
  }
  const purpose = input.purpose ?? "payment";
  if (purpose !== "payment" && purpose !== "wallet_topup") {
    throw new OrderError(400, "invalid_purpose", "purpose must be payment or wallet_topup");
  }
  const c = (input.customer && typeof input.customer === "object" ? input.customer : {}) as Record<string, unknown>;
  const customer = {
    id: text(c.id, 64),
    name: text(c.name, 100),
    email: text(c.email, 200),
    phone: text(c.phone, 20),
  };
  if (customer.id && !/^[\w.:@-]{1,64}$/.test(customer.id)) {
    throw new OrderError(400, "invalid_customer", "customer.id must be up to 64 letters, digits or - _ . : @");
  }
  if (purpose === "wallet_topup" && !customer.id) {
    throw new OrderError(400, "customer_required", "customer.id is required for wallet_topup, so the money goes to the right wallet");
  }
  let minutes = defaultMinutes;
  if (input.expires_in !== undefined) {
    const s = input.expires_in;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 120 || s > 3600) {
      throw new OrderError(400, "invalid_expires_in", "expires_in must be between 120 and 3600 seconds");
    }
    minutes = s / 60;
  }
  return { amount, reference, purpose, customer, notes: text(input.notes, 500), returnUrl: cleanReturnUrl(input.return_url), minutes } as const;
}

/** Statuses (and recently expired orders) whose exact amount is still reserved for a late alert. */
const RESERVED = `(status in ('created', 'claimed') or (status = 'expired' and expires_at > ?))`;

function pickPayAmount(db: DB, merchantId: string, mode: Mode, amount: number, graceCutoff: number): number {
  const taken = new Set(
    (db.prepare(
      `select pay_amount from orders where merchant_id = ? and mode = ? and pay_amount between ? and ? and ${RESERVED}`,
    ).all(merchantId, mode, amount, amount + MAX_OFFSET, graceCutoff) as { pay_amount: number }[]).map((r) => r.pay_amount),
  );
  for (let p = amount; p <= amount + MAX_OFFSET; p++) if (!taken.has(p)) return p;
  throw new OrderError(503, "amount_busy", "Too many open payments for this amount right now. Try again in a few minutes.");
}

export function createOrder(db: DB, cfg: Config, m: MerchantRow, mode: Mode, input: NewOrder, now = Date.now()): { order: OrderRow; created: boolean } {
  const c = clean(input, m.order_minutes ?? cfg.orderMinutes);
  return tx(db, () => {
    const existing = db.prepare("select * from orders where merchant_id = ? and mode = ? and reference = ?")
      .get(m.id, mode, c.reference) as OrderRow | undefined;
    if (existing) {
      // Same reference again: a retry. Return the first order if it asked for the same thing.
      if (existing.amount !== c.amount || existing.purpose !== c.purpose) {
        throw new OrderError(409, "reference_taken", "An order with this reference already exists with a different amount");
      }
      return { order: existing, created: false };
    }
    if (c.purpose === "wallet_topup") {
      const wid = mode === "test" ? `test:${c.customer.id}` : c.customer.id!;
      if (balance(db, m.id, wid) + c.amount > WALLET_LIMIT) {
        throw new OrderError(400, "wallet_limit", "This top-up would take the wallet over ₹2,00,000");
      }
    }
    const payAmount = pickPayAmount(db, m.id, mode, c.amount, now - cfg.graceMinutes * 60_000);
    const id = `ord_${randomText(24)}`;
    db.prepare(
      `insert into orders (id, merchant_id, mode, reference, purpose, amount, pay_amount, customer_id, customer_name,
         customer_email, customer_phone, notes, return_url, status, created_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
    ).run(id, m.id, mode, c.reference, c.purpose, c.amount, payAmount, c.customer.id, c.customer.name,
      c.customer.email, c.customer.phone, c.notes, c.returnUrl, now, now + c.minutes * 60_000);
    return { order: getOrder(db, id)!, created: true };
  });
}

export const getOrder = (db: DB, id: string) => db.prepare("select * from orders where id = ?").get(id) as OrderRow | undefined;

export const getMerchant = (db: DB, id: string) => db.prepare("select * from merchants where id = ?").get(id) as MerchantRow | undefined;

function emit(db: DB, cfg: Config, type: string, o: OrderRow, now: number) {
  const m = getMerchant(db, o.merchant_id)!;
  enqueue(db, m.id, type, { order: orderJson(cfg, m, o) }, now);
}

/** Test top-ups go to a separate test wallet, never the customer's real one. */
const walletId = (o: OrderRow) => (o.mode === "test" ? `test:${o.customer_id}` : o.customer_id!);

export function isUtr(s: string): boolean {
  return /^\d{12}$/.test(s);
}

/** The customer says they paid and gives the UTR. Confirms at once if a matching alert is already here. */
export function claimOrder(db: DB, cfg: Config, id: string, utrRaw: string, now = Date.now()): OrderRow {
  const utr = utrRaw.replace(/\s+/g, "");
  if (!isUtr(utr)) throw new OrderError(400, "invalid_utr", "The UTR is the 12-digit number your UPI app shows after paying");
  return tx(db, () => {
    const o = getOrder(db, id);
    if (!o) throw new OrderError(404, "not_found", "Order not found");
    if (o.status === "paid" || o.status === "refunded") return o;
    // A claimed order can be claimed again: the customer may be correcting a mistyped UTR.
    const open = o.status === "created" || o.status === "claimed";
    if (!open && !(o.status === "expired" && o.expires_at > now - cfg.graceMinutes * 60_000)) {
      throw new OrderError(409, "closed", "This payment is closed. If you paid, contact the shop with your UTR.");
    }
    if (o.status === "claimed" && o.utr === utr) return o;
    const used = db.prepare("select id from orders where merchant_id = ? and utr = ? and id <> ? and status in ('claimed', 'paid', 'refunded')")
      .get(o.merchant_id, utr, o.id);
    if (used) throw new OrderError(409, "utr_used", "That UTR has already been used for another payment");

    const alert = db.prepare("select * from alerts where merchant_id = ? and utr = ?").get(o.merchant_id, utr) as AlertLike | undefined;
    if (alert && alert.status === "unmatched" && alert.amount === o.pay_amount && o.mode === "live") {
      return markPaid(db, cfg, o, "utr_and_alert", now, utr, alert.id);
    }
    db.prepare("update orders set status = 'claimed', utr = ?, claimed_at = ? where id = ?").run(utr, now, o.id);
    const claimed = getOrder(db, o.id)!;
    emit(db, cfg, "order.claimed", claimed, now);
    return claimed;
  });
}

interface AlertLike { id: string; status: string; amount: number }

export function markPaid(db: DB, cfg: Config, o: OrderRow, via: PaidVia, now = Date.now(), utr: string | null = o.utr, alertId: string | null = null): OrderRow {
  return tx(db, () => {
    const r = db.prepare(
      `update orders set status = 'paid', paid_via = ?, utr = ?, alert_id = ?, paid_at = ?, closed_at = ?
        where id = ? and status in ('created', 'claimed', 'expired')`,
    ).run(via, utr, alertId, now, now, o.id);
    if (r.changes === 0) throw new OrderError(409, "not_open", "This order can't be marked paid now");
    if (alertId) db.prepare("update alerts set status = 'matched', order_id = ?, reason = null where id = ?").run(o.id, alertId);
    const paid = getOrder(db, o.id)!;
    if (paid.purpose === "wallet_topup" && paid.customer_id) {
      try {
        credit(db, paid.merchant_id, walletId(paid), "topup", paid.amount, `topup:${paid.id}`, { orderId: paid.id, note: `Top-up ${paid.reference}`, now });
      } catch (e) {
        // The money arrived, so the order stays paid; the merchant is told the wallet wasn't credited.
        if (!(e instanceof WalletError)) throw e;
        enqueue(db, paid.merchant_id, "wallet.topup_failed", { order_id: paid.id, reason: e.message }, now);
      }
    }
    emit(db, cfg, "order.paid", paid, now);
    return paid;
  });
}

/** The merchant checked their bank and approves (or declines) a claimed or open order. */
export function merchantDecide(db: DB, cfg: Config, merchantId: string, id: string, approve: boolean, now = Date.now()): OrderRow {
  return tx(db, () => {
    const o = getOrder(db, id);
    if (!o || o.merchant_id !== merchantId) throw new OrderError(404, "not_found", "Order not found");
    if (approve) return markPaid(db, cfg, o, o.mode === "test" ? "test" : "merchant", now);
    const r = db.prepare("update orders set status = 'declined', closed_at = ? where id = ? and status in ('created', 'claimed', 'expired')").run(now, id);
    if (r.changes === 0) throw new OrderError(409, "not_open", "Only open, claimed or expired orders can be declined");
    const declined = getOrder(db, id)!;
    emit(db, cfg, "order.declined", declined, now);
    return declined;
  });
}

/** For the record only: the merchant sent the money back from their own UPI app. */
export function markRefunded(db: DB, cfg: Config, merchantId: string, id: string, now = Date.now()): OrderRow {
  return tx(db, () => {
    const r = db.prepare("update orders set status = 'refunded', closed_at = ? where id = ? and merchant_id = ? and status = 'paid'").run(now, id, merchantId);
    if (r.changes === 0) throw new OrderError(409, "not_paid", "Only paid orders can be marked refunded");
    const refunded = getOrder(db, id)!;
    if (refunded.purpose === "wallet_topup" && refunded.customer_id) {
      // Take the topped-up Noha Money back. If it's already been spent, refuse: refund less instead.
      const topup = db.prepare("select 1 from wallet_entries where merchant_id = ? and idem_key = ?").get(merchantId, `topup:${id}`);
      if (topup) {
        try {
          debit(db, merchantId, walletId(refunded), "adjust", refunded.amount, `refund:${id}`, { orderId: id, note: `Top-up ${refunded.reference} refunded`, now });
        } catch (e) {
          if (e instanceof WalletError && e.code === "insufficient_balance") {
            throw new OrderError(409, "wallet_spent", "Part of this top-up has already been spent, so it can't be refunded in full. Refund the unspent part and correct the wallet by hand.");
          }
          throw e;
        }
      }
    }
    const o = getOrder(db, id)!;
    emit(db, cfg, "order.refunded", o, now);
    return o;
  });
}

/** Closes orders whose time ran out. Run every minute. */
export function expireDue(db: DB, cfg: Config, now = Date.now()): number {
  return tx(db, () => {
    // Claimed orders aren't expired: the customer says they paid, so they wait for the merchant.
    const due = db.prepare("select * from orders where status = 'created' and expires_at <= ? limit 500").all(now) as unknown as OrderRow[];
    for (const o of due) {
      db.prepare("update orders set status = 'expired', closed_at = ? where id = ?").run(now, o.id);
      emit(db, cfg, "order.expired", { ...o, status: "expired", closed_at: now }, now);
    }
    return due.length;
  });
}

export function listOrders(db: DB, merchantId: string, opts: { status?: string; mode?: Mode; limit?: number; before?: number } = {}): OrderRow[] {
  const where = ["merchant_id = ?"];
  const args: (string | number)[] = [merchantId];
  if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  if (opts.mode) { where.push("mode = ?"); args.push(opts.mode); }
  if (opts.before) { where.push("created_at < ?"); args.push(opts.before); }
  args.push(Math.min(Math.max(opts.limit ?? 50, 1), 100));
  return db.prepare(`select * from orders where ${where.join(" and ")} order by created_at desc limit ?`).all(...args) as unknown as OrderRow[];
}

