import assert from "node:assert/strict";
import { test } from "node:test";
import { balance, credit, debit, entries, outstanding, WalletError } from "../src/wallet.ts";
import { setup, T0 } from "./helpers.ts";

test("cashback, spends and corrections keep a running balance", () => {
  const { db, merchant } = setup();
  credit(db, merchant.id, "c1", "cashback", 5000, "k-cashback-1", { now: T0 });
  debit(db, merchant.id, "c1", "spend", 2000, "k-spend-0001", { now: T0 + 1 });
  credit(db, merchant.id, "c1", "refund", 500, "k-refund-001", { now: T0 + 2 });
  assert.equal(balance(db, merchant.id, "c1"), 3500);
  assert.deepEqual(entries(db, merchant.id, "c1").map((e) => e.balance_after), [3500, 3000, 5000]);
  assert.deepEqual(outstanding(db, merchant.id), { wallets: 1, total: 3500 });
});

test("a spend can't go below zero", () => {
  const { db, merchant } = setup();
  credit(db, merchant.id, "c1", "cashback", 1000, "k-cashback-1", { now: T0 });
  assert.throws(() => debit(db, merchant.id, "c1", "spend", 1001, "k-spend-0001", { now: T0 }), (e: unknown) => e instanceof WalletError && e.code === "insufficient_balance");
  assert.equal(balance(db, merchant.id, "c1"), 1000);
});

test("a retried request with the same key counts once", () => {
  const { db, merchant } = setup();
  const a = credit(db, merchant.id, "c1", "cashback", 1000, "same-key-1", { now: T0 });
  const b = credit(db, merchant.id, "c1", "cashback", 1000, "same-key-1", { now: T0 + 5 });
  assert.equal(a.id, b.id);
  assert.equal(balance(db, merchant.id, "c1"), 1000);
  assert.throws(() => credit(db, merchant.id, "c1", "cashback", 2000, "same-key-1"), /different wallet change/);
  assert.throws(() => credit(db, merchant.id, "c1", "cashback", 1000, "short"), /Idempotency-Key/);
});

test("wallets of different merchants are separate", () => {
  const { db, merchant } = setup();
  credit(db, merchant.id, "c1", "cashback", 1000, "k-cashback-1", { now: T0 });
  assert.equal(balance(db, "mch_other", "c1"), 0);
});

test("there is no way to withdraw or transfer", async () => {
  const wallet = await import("../src/wallet.ts");
  for (const name of Object.keys(wallet)) assert.doesNotMatch(name, /withdraw|transfer|payout|cash/i);
});
