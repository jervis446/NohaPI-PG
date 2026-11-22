// Turns a bank credit alert into a confirmed order, but only when exactly one order fits.

import type { Config } from "../config.ts";
import { newId } from "../crypto.ts";
import { tx, type DB } from "../db.ts";
import { markPaid, type OrderRow } from "../orders.ts";
import { parseAlert } from "./parse.ts";

export type AlertOutcome =
  | { result: "matched"; alertId: string; orderId: string }
  | { result: "unmatched"; alertId: string; reason: string }
  | { result: "duplicate" }
  | { result: "ignored"; reason: string };

export interface IncomingAlert {
  merchantId: string;
  source: "device" | "email";
  deviceId?: string | null;
  text: string;
  receivedAt: number;
}

// Alerts dated far from now are refused: a phone with a wrong clock, or a replayed message.
const MAX_SKEW_MS = 24 * 3600_000;

export function recordAlert(db: DB, cfg: Config, a: IncomingAlert, now = Date.now()): AlertOutcome {
  if (Math.abs(now - a.receivedAt) > MAX_SKEW_MS) return { result: "ignored", reason: "alert time is more than a day off" };
  const parsed = parseAlert(a.text);
  if (!parsed.ok) return { result: "ignored", reason: parsed.reason };
  const { amount, utr, payerVpa } = parsed.alert;

  return tx(db, () => {
    if (utr && db.prepare("select 1 from alerts where merchant_id = ? and utr = ?").get(a.merchantId, utr)) {
      // The same payment seen twice, say by the phone and by email.
      return { result: "duplicate" } as const;
    }
    const id = newId("alr");
    const graceStart = a.receivedAt - cfg.graceMinutes * 60_000;
    // Orders that were open when the money arrived: created before the alert, and not closed long before it.
    const candidates = db.prepare(
      `select * from orders
        where merchant_id = ? and mode = 'live' and pay_amount = ?
          and created_at <= ? and expires_at >= ?
          and (status in ('created', 'claimed') or (status = 'expired' and expires_at >= ?))`,
    ).all(a.merchantId, amount, a.receivedAt + 60_000, graceStart, now - cfg.graceMinutes * 60_000) as unknown as OrderRow[];

    let reason: string | null = null;
    let order: OrderRow | undefined;
    if (utr) {
      const byUtr = candidates.filter((o) => o.utr === utr);
      if (byUtr.length === 1) order = byUtr[0];
    }
    if (!order) {
      // A claim with a different UTR means someone else's payment; don't let this alert take it.
      const open = candidates.filter((o) => !(o.status === "claimed" && o.utr && o.utr !== utr));
      if (open.length === 1) order = open[0];
      else reason = open.length === 0 ? "No open order for this amount" : `${open.length} open orders have this amount`;
    }
    if (utr && order && db.prepare("select 1 from orders where merchant_id = ? and utr = ? and id <> ?").get(a.merchantId, utr, order.id)) {
      order = undefined;
      reason = "This UTR was already used on another order";
    }

    db.prepare(
      `insert into alerts (id, merchant_id, source, device_id, amount, utr, payer_vpa, received_at, text, status, reason, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', ?, ?)`,
    ).run(id, a.merchantId, a.source, a.deviceId ?? null, amount, utr, payerVpa, a.receivedAt, a.text.slice(0, 2000), reason, now);

    if (!order) return { result: "unmatched", alertId: id, reason: reason ?? "No match" } as const;
    const via = order.status === "claimed" && order.utr === utr ? "utr_and_alert" : "alert";
    markPaid(db, cfg, order, via, now, utr ?? order.utr, id);
    return { result: "matched", alertId: id, orderId: order.id } as const;
  });
}

/** From the dashboard: the merchant says this unmatched alert belongs to this order. */
export function attachAlert(db: DB, cfg: Config, merchantId: string, alertId: string, orderId: string, now = Date.now()): OrderRow {
  return tx(db, () => {
    const alert = db.prepare("select * from alerts where id = ? and merchant_id = ? and status = 'unmatched'").get(alertId, merchantId) as
      | { id: string; utr: string | null } | undefined;
    if (!alert) throw new Error("That alert isn't waiting to be matched");
    const order = db.prepare("select * from orders where id = ? and merchant_id = ?").get(orderId, merchantId) as OrderRow | undefined;
    if (!order) throw new Error("Order not found");
    return markPaid(db, cfg, order, "merchant", now, alert.utr ?? order.utr, alert.id);
  });
}

export function dismissAlert(db: DB, merchantId: string, alertId: string): boolean {
  return db.prepare("update alerts set status = 'dismissed' where id = ? and merchant_id = ? and status = 'unmatched'").run(alertId, merchantId).changes === 1;
}

/** Deletes the raw alert text after the keep period. The amount and UTR stay for the record. */
export function forgetOldAlertText(db: DB, cfg: Config, now = Date.now()): number {
  return Number(db.prepare("update alerts set text = null where text is not null and created_at < ?").run(now - cfg.alertKeepDays * 86400_000).changes);
}
