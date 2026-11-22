import assert from "node:assert/strict";
import { test } from "node:test";
import { recordAlert, attachAlert } from "../src/alerts/match.ts";
import { claimOrder, createOrder, expireDue, getOrder, markRefunded, merchantDecide, OrderError } from "../src/orders.ts";
import { balance, credit as walletCredit, debit } from "../src/wallet.ts";
import { credit, setup, T0 } from "./helpers.ts";

const alert = (ctx: ReturnType<typeof setup>, text: string, at = T0 + 60_000) =>
  recordAlert(ctx.db, ctx.cfg, { merchantId: ctx.merchant.id, source: "device", text, receivedAt: at }, at);

test("open orders at the same price get different amounts, and a retry returns the same order", () => {
  const c = setup();
  const a = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 49900, reference: "A1" }, T0);
  const b = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 49900, reference: "A2" }, T0);
  const again = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 49900, reference: "A1" }, T0);
  assert.equal(a.order.pay_amount, 49900);
  assert.equal(b.order.pay_amount, 49901);
  assert.equal(again.created, false);
  assert.equal(again.order.id, a.order.id);
  assert.throws(() => createOrder(c.db, c.cfg, c.merchant, "live", { amount: 100, reference: "A1" }, T0), /different amount/);
  // Test orders don't take live amounts.
  assert.equal(createOrder(c.db, c.cfg, c.merchant, "test", { amount: 49900, reference: "T1" }, T0).order.pay_amount, 49900);
});

test("all 100 slots for one price in use: the next order is refused", () => {
  const c = setup();
  for (let i = 0; i < 100; i++) createOrder(c.db, c.cfg, c.merchant, "live", { amount: 10000, reference: `R${i}` }, T0);
  assert.throws(() => createOrder(c.db, c.cfg, c.merchant, "live", { amount: 10000, reference: "R100" }, T0), (e: unknown) => e instanceof OrderError && e.code === "amount_busy");
});

test("bad input is refused with a clear message", () => {
  const c = setup();
  const bad = (input: Record<string, unknown>, code: string) =>
    assert.throws(() => createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1000, reference: "X", ...input }, T0), (e: unknown) => e instanceof OrderError && e.code === code);
  bad({ amount: 99 }, "invalid_amount");
  bad({ amount: 10.5 }, "invalid_amount");
  bad({ reference: "has space" }, "invalid_reference");
  bad({ purpose: "wallet_topup" }, "customer_required");
  bad({ return_url: "javascript:alert(1)" }, "invalid_return_url");
  bad({ expires_in: 30 }, "invalid_expires_in");
});

test("a matching bank alert marks the order paid", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 49900, reference: "A1" }, T0);
  const out = alert(c, credit("499.00"));
  assert.equal(out.result, "matched");
  const o = getOrder(c.db, order.id)!;
  assert.equal(o.status, "paid");
  assert.equal(o.paid_via, "alert");
  assert.equal(o.utr, "412345678901");
  // The same alert again (say by email too) is a duplicate, not a second payment.
  assert.equal(alert(c, credit("499.00")).result, "duplicate");
});

test("an alert that fits no order, or an old one, waits for the merchant", () => {
  const c = setup();
  createOrder(c.db, c.cfg, c.merchant, "live", { amount: 49900, reference: "A1" }, T0);
  const none = alert(c, credit("123.00", "400000000001"));
  assert.equal(none.result, "unmatched");
  // Paid an hour after the order closed: too late to match on its own.
  const late = alert(c, credit("499.00", "400000000002"), T0 + 15 * 60_000 + 31 * 60_000);
  assert.equal(late.result, "unmatched");
  assert.equal(alert(c, "Hello", T0).result, "ignored");
});

test("a late alert within the grace period still confirms an expired order", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 20000, reference: "G1" }, T0);
  assert.equal(expireDue(c.db, c.cfg, T0 + 16 * 60_000), 1);
  assert.equal(getOrder(c.db, order.id)!.status, "expired");
  const at = T0 + 20 * 60_000;
  assert.equal(alert(c, credit("200.00", "400000000003"), at).result, "matched");
  assert.equal(getOrder(c.db, order.id)!.status, "paid");
});

test("a typed UTR alone only claims; the alert or the merchant confirms", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 30000, reference: "U1" }, T0);
  assert.throws(() => claimOrder(c.db, c.cfg, order.id, "12345", T0), /12-digit/);
  assert.equal(claimOrder(c.db, c.cfg, order.id, "4123 4567 8901", T0).status, "claimed");
  // Claimed orders don't expire on their own: the customer says they paid.
  expireDue(c.db, c.cfg, T0 + 60 * 60_000);
  assert.equal(getOrder(c.db, order.id)!.status, "claimed");
  assert.equal(alert(c, credit("300.00", "412345678901"), T0 + 2 * 60_000).result, "matched");
  assert.equal(getOrder(c.db, order.id)!.paid_via, "utr_and_alert");
});

test("a UTR that matches an alert already received confirms at once", () => {
  const c = setup();
  // The money arrived before the order existed, so the alert couldn't match on its own.
  assert.equal(alert(c, credit("300.00", "400000000009"), T0).result, "unmatched");
  const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 30000, reference: "U2" }, T0 + 5 * 60_000);
  const o = claimOrder(c.db, c.cfg, order.id, "400000000009", T0 + 6 * 60_000);
  assert.equal(o.status, "paid");
  assert.equal(o.paid_via, "utr_and_alert");
  // A UTR whose alert has a different amount only claims.
  const other = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1000, reference: "U3" }, T0).order;
  alert(c, credit("11.00", "400000000010"), T0);
  assert.equal(claimOrder(c.db, c.cfg, other.id, "400000000010", T0 + 60_000).status, "claimed");
});

test("one UTR can't pay for two orders", () => {
  const c = setup();
  const a = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1000, reference: "D1" }, T0).order;
  const b = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 2000, reference: "D2" }, T0).order;
  claimOrder(c.db, c.cfg, a.id, "499999999999", T0);
  assert.throws(() => claimOrder(c.db, c.cfg, b.id, "499999999999", T0), /already been used/);
});

test("a claim with a different UTR doesn't let another payment's alert take the order", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 5000, reference: "W1" }, T0);
  claimOrder(c.db, c.cfg, order.id, "411111111111", T0);
  assert.equal(alert(c, credit("50.00", "422222222222")).result, "unmatched");
  assert.equal(getOrder(c.db, order.id)!.status, "claimed");
});

test("the merchant can attach an unmatched alert, approve, decline and record a refund", () => {
  const c = setup();
  const a = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1500, reference: "M1" }, T0).order;
  const out = alert(c, credit("99.00", "433333333333"));
  assert.equal(out.result, "unmatched");
  if (out.result !== "unmatched") return;
  attachAlert(c.db, c.cfg, c.merchant.id, out.alertId, a.id, T0 + 1000);
  assert.equal(getOrder(c.db, a.id)!.status, "paid");
  assert.equal(markRefunded(c.db, c.cfg, c.merchant.id, a.id, T0 + 2000).status, "refunded");

  const b = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1500, reference: "M2" }, T0).order;
  assert.equal(merchantDecide(c.db, c.cfg, c.merchant.id, b.id, false, T0).status, "declined");
  assert.throws(() => merchantDecide(c.db, c.cfg, c.merchant.id, b.id, true, T0), /can't be marked paid/);
  // Another merchant can't touch it.
  assert.throws(() => merchantDecide(c.db, c.cfg, "mch_other", b.id, true, T0), /not found/i);
});

test("a paid wallet top-up adds Noha Money once", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 50000, reference: "TOP1", purpose: "wallet_topup", customer: { id: "cust_1" } }, T0);
  alert(c, credit("500.00", "444444444444"));
  assert.equal(getOrder(c.db, order.id)!.status, "paid");
  assert.equal(balance(c.db, c.merchant.id, "cust_1"), 50000);
});

test("a test top-up fills the test wallet, not the real one", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "test", { amount: 1000, reference: "TT1", purpose: "wallet_topup", customer: { id: "cust_2" } }, T0);
  merchantDecide(c.db, c.cfg, c.merchant.id, order.id, true, T0);
  assert.equal(balance(c.db, c.merchant.id, "cust_2"), 0);
  assert.equal(balance(c.db, c.merchant.id, "test:cust_2"), 1000);
});

test("alerts never confirm test orders", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "test", { amount: 7700, reference: "T1" }, T0);
  assert.equal(alert(c, credit("77.00", "455555555555")).result, "unmatched");
  assert.equal(merchantDecide(c.db, c.cfg, c.merchant.id, order.id, true, T0).paid_via, "test");
});

test("each change queues a webhook", () => {
  const c = setup();
  const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1000, reference: "H1" }, T0);
  claimOrder(c.db, c.cfg, order.id, "466666666666", T0);
  merchantDecide(c.db, c.cfg, c.merchant.id, order.id, true, T0);
  const types = (c.db.prepare("select type from webhooks order by created_at, rowid").all() as { type: string }[]).map((r) => r.type);
  assert.deepEqual(types, ["order.claimed", "order.paid"]);
});

test("expiry isn't held up by many claimed orders", () => {
  const c = setup();
  for (let i = 0; i < 3; i++) {
    const o = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1000 + i * 100, reference: `CL${i}` }, T0).order;
    claimOrder(c.db, c.cfg, o.id, `40000000010${i}`, T0);
  }
  const open = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 9900, reference: "OPEN" }, T0).order;
  assert.equal(expireDue(c.db, c.cfg, T0 + 16 * 60_000), 1);
  assert.equal(getOrder(c.db, open.id)!.status, "expired");
});

test("a top-up that would overfill the wallet is refused up front, and a paid one is never lost", () => {
  const c = setup();
  walletCredit(c.db, c.merchant.id, "rich", "cashback", 2_00_000_00 - 100, "seed-rich-1", { now: T0 });
  assert.throws(() => createOrder(c.db, c.cfg, c.merchant, "live", { amount: 500, reference: "TOPX", purpose: "wallet_topup", customer: { id: "rich" } }, T0), /over/);
  // Created while there was room, filled up before the money arrived: the order is still paid.
  const c2 = setup();
  const { order } = createOrder(c2.db, c2.cfg, c2.merchant, "live", { amount: 500, reference: "TOPY", purpose: "wallet_topup", customer: { id: "rich" } }, T0);
  walletCredit(c2.db, c2.merchant.id, "rich", "cashback", 2_00_000_00 - 100, "seed-rich-2", { now: T0 + 1 });
  assert.equal(alert(c2, credit("5.00", "477777777777")).result, "matched");
  assert.equal(getOrder(c2.db, order.id)!.status, "paid");
  const types = (c2.db.prepare("select type from webhooks").all() as { type: string }[]).map((r) => r.type);
  assert.ok(types.includes("wallet.topup_failed"));
});

test("refunding a top-up takes the Noha Money back, unless it was spent", () => {
  const c = setup();
  const a = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 50000, reference: "R1", purpose: "wallet_topup", customer: { id: "cust_r" } }, T0).order;
  merchantDecide(c.db, c.cfg, c.merchant.id, a.id, true, T0);
  assert.equal(balance(c.db, c.merchant.id, "cust_r"), 50000);
  markRefunded(c.db, c.cfg, c.merchant.id, a.id, T0 + 1);
  assert.equal(balance(c.db, c.merchant.id, "cust_r"), 0);

  const b = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 50000, reference: "R2", purpose: "wallet_topup", customer: { id: "cust_r" } }, T0).order;
  merchantDecide(c.db, c.cfg, c.merchant.id, b.id, true, T0 + 2);
  debit(c.db, c.merchant.id, "cust_r", "spend", 10000, "spend-r2-0001", { now: T0 + 3 });
  assert.throws(() => markRefunded(c.db, c.cfg, c.merchant.id, b.id, T0 + 4), /already been spent/);
  assert.equal(getOrder(c.db, b.id)!.status, "paid");
});
