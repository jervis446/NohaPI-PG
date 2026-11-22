import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAlert } from "../src/alerts/parse.ts";

const ok = (text: string) => {
  const r = parseAlert(text);
  assert.ok(r.ok, `expected a credit: ${text} (${r.ok ? "" : r.reason})`);
  return r.alert;
};
const no = (text: string) => {
  const r = parseAlert(text);
  assert.equal(r.ok, false, `expected no credit: ${text}`);
  return r.ok ? "" : r.reason;
};

test("reads common credit alert shapes", () => {
  assert.deepEqual(ok("Rs.499.01 credited to A/c XX1234 on 22-11-26 by UPI Ref No 412345678901."), { amount: 49901, utr: "412345678901", payerVpa: null });
  assert.deepEqual(ok("You have received INR 1,250.00 from asha.k@okicici. UPI Ref: 512398765432"), { amount: 125000, utr: "512398765432", payerVpa: "asha.k@okicici" });
  assert.equal(ok("₹75 has been credited to your account. RRN 333344445555").amount, 7500);
  assert.equal(ok("Acct XX99 Cr. with Rs 20.5 via UPI 610000000001").amount, 2050);
});

test("an unlabelled 12-digit number is used only when it is the only one", () => {
  assert.equal(ok("Rs 100 credited via UPI 412345678901 on 22-11").utr, "412345678901");
  assert.equal(ok("Rs 100 credited to 123456789012 via UPI 412345678901").utr, null);
});

test("the payment amount is read, not the balance", () => {
  assert.equal(ok("Avl Bal Rs 9,999.00. Rs 150.00 credited by UPI Ref 412345678901").amount, 15000);
});

test("debits, OTPs and requests are not credits", () => {
  no("Rs.500 debited from A/c XX1234 to merchant@ybl. UPI Ref 412345678901");
  no("Your OTP is 123456. Do not share. Rs 500 credited");
  no("asha@okicici has requested money Rs 200 from you. Collect request");
  no("Sent Rs.20 to friend@ybl");
  no("Payment of Rs 499.01 received towards your Credit Card ending 1234");
  no("Refund of Rs 250.00 credited to your account. Ref 412345678901");
  no("Cashback of Rs 25 credited to your account");
  no("EMI payment of Rs 5,000 received for loan a/c 1234");
  assert.equal(no("Your account statement is ready"), "no credit word");
  assert.equal(no("Rs credited to your account"), "no amount");
});
