import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBankEmail, decodeWords } from "../src/alerts/email.ts";

type Verify = NonNullable<Parameters<typeof checkBankEmail>[2]>;
const pass = (domain: string, aligned = true) =>
  (async () => ({ results: [{ signingDomain: domain, status: { result: "pass", aligned: aligned ? domain : false } }] })) as unknown as Verify;

const MAIL = [
  "From: HDFC Bank InstaAlerts <alerts@hdfcbank.net>",
  "Subject: =?UTF-8?Q?=E2=82=B9_499.01_credited?=",
  "Date: Sun, 22 Nov 2026 11:31:00 +0530",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<p>Dear Customer,</p><p>Rs.499.01 has been credited to account **1234 by VPA asha@okicici on 22-11-26. Your UPI transaction=",
  " reference number is 412345678901.</p>",
  "--b1--",
  "",
].join("\r\n");

test("a DKIM-signed bank email is read into text", async () => {
  const r = await checkBankEmail(Buffer.from(MAIL), ["hdfcbank.net"], pass("hdfcbank.net"));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.text, /₹ 499\.01 credited/);
  assert.match(r.text, /reference number is 412345678901/);
  assert.equal(r.date, Date.parse("2026-11-22T06:01:00Z"));
});

test("emails without a passing, aligned signature from an allowed bank are refused", async () => {
  assert.equal((await checkBankEmail(Buffer.from(MAIL), ["hdfcbank.net"], pass("gmail.com"))).ok, false);
  assert.equal((await checkBankEmail(Buffer.from(MAIL), ["hdfcbank.net"], pass("hdfcbank.net", false))).ok, false);
  const failed = (async () => ({ results: [{ signingDomain: "hdfcbank.net", status: { result: "fail" } }] })) as unknown as Verify;
  assert.equal((await checkBankEmail(Buffer.from(MAIL), ["hdfcbank.net"], failed)).ok, false);
  // A look-alike domain doesn't count as a subdomain.
  assert.equal((await checkBankEmail(Buffer.from(MAIL), ["hdfcbank.net"], pass("evilhdfcbank.net"))).ok, false);
});

test("encoded header words are decoded", () => {
  assert.equal(decodeWords("=?utf-8?B?4oK5IDUwMA==?= received"), "₹ 500 received");
});
