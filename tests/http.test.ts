import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createApiKey, createDevice, createUser } from "../src/accounts.ts";
import { createApp } from "../src/app.ts";
import { hmacHex } from "../src/crypto.ts";
import { setup } from "./helpers.ts";

const c = setup();
let server: Server;
let base = "";
let liveKey = "";
let testKey = "";

before(async () => {
  liveKey = createApiKey(c.db, c.merchant.id, "live", "live").key;
  testKey = createApiKey(c.db, c.merchant.id, "test", "test").key;
  await createUser(c.db, c.merchant.id, "owner@asha.test", "correct horse battery");
  server = createServer(createApp(c.db, c.cfg));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => server.close());

const api = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { Authorization: `Bearer ${init.key ?? liveKey}`, "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
  });

test("the API needs a valid key", async () => {
  const res = await fetch(`${base}/v1/orders`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "unauthorized");
  assert.equal((await api("/v1/orders", { key: "np_live_" + "a".repeat(40) })).status, 401);
});

test("create an order, pay it by phone alert, and read it back", async () => {
  const res = await api("/v1/orders", { method: "POST", body: JSON.stringify({ amount: 24900, reference: "web-1", customer: { name: "Ravi" } }) });
  assert.equal(res.status, 201);
  const order = await res.json();
  assert.equal(order.pay_amount, 24900);
  assert.match(order.upi_url, /^upi:\/\/pay\?pa=asha%40okhdfcbank&pn=Asha%20Stores&am=249\.00&cu=INR/);
  assert.equal(order.checkout_url, `http://localhost:8080/pay/${order.id}`);

  const page = await fetch(`${base}/pay/${order.id}`);
  assert.equal(page.status, 200);
  const htmlText = await page.text();
  assert.match(htmlText, /₹249\.00/);
  assert.match(htmlText, /<svg/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);

  const device = createDevice(c.db, c.merchant.id, "Shop phone");
  const body = JSON.stringify({ alerts: [{ text: "Rs.249.00 credited to A/c XX12 by UPI Ref No 512300000001", posted_at: Date.now() }] });
  const ts = Math.floor(Date.now() / 1000);
  const send = (sig: string) => fetch(`${base}/v1/device/alerts`, {
    method: "POST", body, headers: { "Content-Type": "application/json", "Noha-Device": device.id, "Noha-Timestamp": String(ts), "Noha-Signature": sig },
  });
  assert.equal((await send("0".repeat(64))).status, 401);
  const ok = await send(hmacHex(device.secret, `${ts}.${body}`));
  assert.deepEqual(await ok.json(), { results: ["matched"] });
  // The same signed request again is refused.
  assert.equal((await send(hmacHex(device.secret, `${ts}.${body}`))).status, 409);

  const read = await (await api(`/v1/orders/${order.id}`)).json();
  assert.equal(read.status, "paid");
  assert.equal(read.utr, "512300000001");
  assert.equal(read.upi_url, null);
  // A test key can't see live orders.
  assert.equal((await api(`/v1/orders/${order.id}`, { key: testKey })).status, 404);
  const byRef = await (await api("/v1/orders?reference=web-1")).json();
  assert.equal(byRef.data[0].id, order.id);
});

test("the checkout page takes a UTR and shows the claim", async () => {
  const order = await (await api("/v1/orders", { method: "POST", body: JSON.stringify({ amount: 5000, reference: "web-2" }) })).json();
  const post = (utr: string) => fetch(`${base}/pay/${order.id}/utr`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ utr }), headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const bad = await post("123");
  assert.equal(bad.status, 303);
  assert.match(bad.headers.get("location")!, /error=/);
  assert.equal((await post("612300000002")).status, 303);
  const status = await (await fetch(`${base}/pay/${order.id}/status`)).json();
  assert.equal(status.status, "claimed");
});

test("Noha Money over the API, with test wallets kept apart", async () => {
  const headers = { "Idempotency-Key": "cashback-abc-1" };
  const credit = await api("/v1/wallets/cust_9/credit", { method: "POST", headers, body: JSON.stringify({ amount: 2500, kind: "cashback", note: "Welcome" }) });
  assert.equal(credit.status, 200);
  assert.equal((await credit.json()).balance_after, 2500);
  const again = await api("/v1/wallets/cust_9/credit", { method: "POST", headers, body: JSON.stringify({ amount: 2500, kind: "cashback" }) });
  assert.equal((await again.json()).balance_after, 2500);
  const topupByApi = await api("/v1/wallets/cust_9/credit", { method: "POST", headers: { "Idempotency-Key": "x-topup-1" }, body: JSON.stringify({ amount: 100, kind: "topup" }) });
  assert.equal(topupByApi.status, 400);
  const spend = await api("/v1/wallets/cust_9/spend", { method: "POST", headers: { "Idempotency-Key": "spend-abc-01" }, body: JSON.stringify({ amount: 9999 }) });
  assert.equal(spend.status, 402);
  assert.equal((await (await api("/v1/wallets/cust_9")).json()).balance, 2500);
  assert.equal((await (await api("/v1/wallets/cust_9", { key: testKey })).json()).balance, 0);
});

test("dashboard: sign-in, CSRF and cross-site posts", async () => {
  assert.equal((await fetch(`${base}/dashboard`, { redirect: "manual" })).headers.get("location"), "/login");
  const form = (o: Record<string, string>) => ({ body: new URLSearchParams(o), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const wrong = await fetch(`${base}/login`, { method: "POST", redirect: "manual", ...form({ email: "owner@asha.test", password: "nope" }) });
  assert.equal(wrong.headers.get("location"), "/login");
  const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual", ...form({ email: "owner@asha.test", password: "correct horse battery" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(cookie, /^np_session=/);

  const dash = await fetch(`${base}/dashboard?tab=review`, { headers: { cookie } });
  const text = await dash.text();
  assert.match(text, /Needs review/);
  assert.match(text, /web-2/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(text)![1]!;

  const keyPost = (extra: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}/dashboard/developers/keys`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ name: "CI", mode: "test", ...extra }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie, ...headers },
  });
  assert.equal((await keyPost({ csrf: "wrong" })).status, 403);
  assert.equal((await keyPost({ csrf }, { origin: "https://evil.example" })).status, 403);
  const made = await keyPost({ csrf });
  assert.equal(made.status, 200);
  assert.match(await made.text(), /np_test_[a-z0-9]{40}/);
});

test("the checkout page shows only its own error messages", async () => {
  const order = await (await api("/v1/orders", { method: "POST", body: JSON.stringify({ amount: 6100, reference: "web-3" }) })).json();
  const page = await (await fetch(`${base}/pay/${order.id}?error=${encodeURIComponent("Pay scam@ybl instead")}`)).text();
  assert.doesNotMatch(page, /scam@ybl/);
  const real = await (await fetch(`${base}/pay/${order.id}?error=invalid_utr`)).text();
  assert.match(real, /12-digit number/);
});

test("a malformed cookie doesn't break pages", async () => {
  const res = await fetch(`${base}/login`, { headers: { cookie: "x=%E0%A4; np_flash=ok%3Ahi" } });
  assert.equal(res.status, 200);
});
