import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrder, merchantDecide } from "../src/orders.ts";
import { createServer } from "node:http";
import { deliverDue, isPrivateAddress, postWebhook, signature, verifySignature, webhookProblem } from "../src/webhooks.ts";
import { setup, T0 } from "./helpers.ts";

test("signatures verify, and old or altered ones don't", () => {
  const sig = signature("whsec_x", '{"a":1}', 1000);
  assert.ok(verifySignature("whsec_x", '{"a":1}', sig, 300, 1100));
  assert.equal(verifySignature("whsec_x", '{"a":2}', sig, 300, 1100), false);
  assert.equal(verifySignature("whsec_y", '{"a":1}', sig, 300, 1100), false);
  assert.equal(verifySignature("whsec_x", '{"a":1}', sig, 300, 2000), false);
});

test("private and local addresses are refused as webhook targets", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.match((await webhookProblem("http://example.com/x", false))!, /https/);
  assert.match((await webhookProblem("https://127.0.0.1/x", false))!, /public address/);
  assert.equal(await webhookProblem("http://127.0.0.1:9000/x", true), null);
});

test("delivery signs the body, retries failures, and gives up after the last retry", async () => {
  const c = setup();
  c.db.prepare("update merchants set webhook_url = ? where id = ?").run("http://127.0.0.1:9/hook", c.merchant.id);
  process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
  try {
    const { order } = createOrder(c.db, c.cfg, c.merchant, "live", { amount: 1000, reference: "H1" }, T0);
    merchantDecide(c.db, c.cfg, c.merchant.id, order.id, true, T0);
    const seen: { sig: string; body: string }[] = [];
    let fail = true;
    const fake = async (_url: string, headers: Record<string, string>, body: string) => {
      seen.push({ sig: headers["Noha-Signature"]!, body });
      return fail ? 500 : 204;
    };

    assert.equal(await deliverDue(c.db, fake, T0), 1);
    const secret = c.merchant.webhook_secret;
    assert.ok(verifySignature(secret, seen[0]!.body, seen[0]!.sig, 300, Math.floor(T0 / 1000)));
    assert.equal(JSON.parse(seen[0]!.body).type, "order.paid");
    // Not due yet: nothing sent.
    assert.equal(await deliverDue(c.db, fake, T0 + 30_000), 0);
    fail = false;
    assert.equal(await deliverDue(c.db, fake, T0 + 61_000), 1);
    const row = c.db.prepare("select status, attempts from webhooks").get() as { status: string; attempts: number };
    assert.deepEqual({ ...row }, { status: "delivered", attempts: 2 });

    // A webhook that keeps failing is retried five times, then marked failed.
    fail = true;
    c.db.prepare("update webhooks set status = 'pending', attempts = 0, next_attempt_at = ?").run(T0);
    let now = T0;
    for (let i = 0; i < 6; i++) { await deliverDue(c.db, fake, now); now += 13 * 3600_000; }
    const last = c.db.prepare("select status, attempts from webhooks").get() as { status: string; attempts: number };
    assert.deepEqual({ ...last }, { status: "failed", attempts: 6 });
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
  }
});

test("the real sender refuses private addresses at connect time, and posts when allowed", async () => {
  const got: string[] = [];
  const server = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)).on("end", () => { got.push(b); res.end(); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(postWebhook(`http://localhost:${port}/hook`, {}, "{}"), /public address/);
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    assert.equal(await postWebhook(`http://127.0.0.1:${port}/hook`, {}, '{"a":1}'), 200);
    assert.deepEqual(got, ['{"a":1}']);
  } finally {
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    server.close();
  }
});
