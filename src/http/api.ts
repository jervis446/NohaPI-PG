// The merchant API (/v1), the alert app's endpoint and the email intake.

import { getDevice, keyOwner } from "../accounts.ts";
import { checkBankEmail } from "../alerts/email.ts";
import { recordAlert, type AlertOutcome } from "../alerts/match.ts";
import { hmacHex, sameText } from "../crypto.ts";
import { createOrder, getOrder, listOrders, OrderError, orderJson, type Mode, type MerchantRow, type Status } from "../orders.ts";
import { balance, checkCustomer, credit, debit, entries, entryJson, WalletError } from "../wallet.ts";
import { HttpError, limiter, readBody, readJson, sendJson, type Ctx, type Router } from "./core.ts";

function auth(ctx: Ctx): { merchant: MerchantRow; mode: Mode } {
  const header = ctx.req.headers.authorization ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim();
  if (!limiter.take(`api-ip:${ctx.ip}`, 1000, 60_000, ctx.now)) throw new HttpError(429, "rate_limited", "Too many requests");
  const owner = key ? keyOwner(ctx.db, key, ctx.now) : null;
  if (!owner) throw new HttpError(401, "unauthorized", "Send your API key as: Authorization: Bearer np_live_...");
  if (!limiter.take(`api:${owner.merchant.id}`, 600, 60_000, ctx.now)) throw new HttpError(429, "rate_limited", "Slow down: 600 requests a minute per merchant");
  return owner;
}

// Test-mode wallets are kept apart from real ones by a prefix only the server adds.
const walletId = (mode: Mode, customer: string) => (mode === "test" ? `test:${customer}` : customer);

function customerParam(ctx: Ctx): string {
  const c = checkCustomer(ctx.params.customer);
  if (c.startsWith("test:")) throw new HttpError(400, "invalid_customer", "Customer ids can't start with test:");
  return c;
}

const entryOut = (e: ReturnType<typeof entryJson>) => ({ ...e, customer_id: e.customer_id.replace(/^test:/, "") });

const STATUSES: Status[] = ["created", "claimed", "paid", "declined", "expired", "refunded"];

// Device requests carry a signature; one seen recently is refused so a captured request can't be replayed.
const seenSignatures = new Map<string, number>();

function verifyDevice(ctx: Ctx, body: Buffer) {
  const id = String(ctx.req.headers["noha-device"] ?? "");
  const ts = Number(ctx.req.headers["noha-timestamp"]);
  const sig = String(ctx.req.headers["noha-signature"] ?? "");
  const device = id ? getDevice(ctx.db, id) : undefined;
  if (!device || device.revoked_at) throw new HttpError(401, "unknown_device", "This phone isn't paired. Pair it again from the dashboard.");
  if (!Number.isInteger(ts) || Math.abs(ctx.now / 1000 - ts) > 300) throw new HttpError(401, "clock", "The phone's clock is more than 5 minutes off");
  if (!sameText(hmacHex(device.secret, `${ts}.${body.toString("utf8")}`), sig)) throw new HttpError(401, "bad_signature", "Signature doesn't match");
  for (const [s, until] of seenSignatures) if (until < ctx.now) seenSignatures.delete(s);
  if (seenSignatures.has(sig)) throw new HttpError(409, "replay", "This request was already received");
  seenSignatures.set(sig, ctx.now + 600_000);
  ctx.db.prepare("update devices set last_seen_at = ? where id = ?").run(ctx.now, device.id);
  return device;
}

function walletError(e: unknown): never {
  if (e instanceof WalletError || e instanceof OrderError) throw new HttpError(e.status, e.code, e.message);
  throw e;
}

export function apiRoutes(r: Router): void {
  r.on("POST", "/v1/orders", async (ctx) => {
    const { merchant, mode } = auth(ctx);
    const body = await readJson(ctx.req);
    try {
      const { order, created } = createOrder(ctx.db, ctx.cfg, merchant, mode, body, ctx.now);
      sendJson(ctx.res, created ? 201 : 200, orderJson(ctx.cfg, merchant, order));
    } catch (e) { walletError(e); }
  });

  r.on("GET", "/v1/orders", (ctx) => {
    const { merchant, mode } = auth(ctx);
    const reference = ctx.url.searchParams.get("reference");
    if (reference) {
      const o = ctx.db.prepare("select id from orders where merchant_id = ? and mode = ? and reference = ?").get(merchant.id, mode, reference) as { id: string } | undefined;
      const order = o && getOrder(ctx.db, o.id);
      sendJson(ctx.res, 200, { data: order ? [orderJson(ctx.cfg, merchant, order)] : [] });
      return;
    }
    const status = ctx.url.searchParams.get("status") as Status | null;
    if (status && !STATUSES.includes(status)) throw new HttpError(400, "invalid_status", `status must be one of ${STATUSES.join(", ")}`);
    const before = ctx.url.searchParams.get("before");
    const rows = listOrders(ctx.db, merchant.id, {
      mode, status: status ?? undefined,
      limit: Number(ctx.url.searchParams.get("limit") ?? 50) || 50,
      before: before ? Date.parse(before) || undefined : undefined,
    });
    sendJson(ctx.res, 200, { data: rows.map((o) => orderJson(ctx.cfg, merchant, o)) });
  });

  r.on("GET", "/v1/orders/:id", (ctx) => {
    const { merchant, mode } = auth(ctx);
    const o = getOrder(ctx.db, ctx.params.id!);
    if (!o || o.merchant_id !== merchant.id || o.mode !== mode) throw new HttpError(404, "not_found", "Order not found");
    sendJson(ctx.res, 200, orderJson(ctx.cfg, merchant, o));
  });

  // Noha Money

  r.on("GET", "/v1/wallets/:customer", (ctx) => {
    const { merchant, mode } = auth(ctx);
    try {
      const c = customerParam(ctx);
      sendJson(ctx.res, 200, { object: "wallet", customer_id: c, balance: balance(ctx.db, merchant.id, walletId(mode, c)), currency: "INR" });
    } catch (e) { walletError(e); }
  });

  r.on("GET", "/v1/wallets/:customer/entries", (ctx) => {
    const { merchant, mode } = auth(ctx);
    try {
      const c = customerParam(ctx);
      const rows = entries(ctx.db, merchant.id, walletId(mode, c), Number(ctx.url.searchParams.get("limit") ?? 50) || 50);
      sendJson(ctx.res, 200, { data: rows.map((e) => entryOut(entryJson(e))) });
    } catch (e) { walletError(e); }
  });

  r.on("POST", "/v1/wallets/:customer/credit", async (ctx) => {
    const { merchant, mode } = auth(ctx);
    const body = await readJson(ctx.req);
    try {
      const c = customerParam(ctx);
      const kind = body.kind ?? "cashback";
      if (kind !== "cashback" && kind !== "refund" && kind !== "adjust") {
        throw new WalletError(400, "invalid_kind", "kind must be cashback, refund or adjust. Top-ups come from paid wallet_topup orders.");
      }
      const key = String(ctx.req.headers["idempotency-key"] ?? "");
      const e = credit(ctx.db, merchant.id, walletId(mode, c), kind, body.amount as number, `api:${key}`, {
        note: typeof body.note === "string" ? body.note.slice(0, 200) : null, now: ctx.now,
      });
      sendJson(ctx.res, 200, entryOut(entryJson(e)));
    } catch (e) { walletError(e); }
  });

  r.on("POST", "/v1/wallets/:customer/spend", async (ctx) => {
    const { merchant, mode } = auth(ctx);
    const body = await readJson(ctx.req);
    try {
      const c = customerParam(ctx);
      const key = String(ctx.req.headers["idempotency-key"] ?? "");
      const e = debit(ctx.db, merchant.id, walletId(mode, c), "spend", body.amount as number, `api:${key}`, {
        note: typeof body.note === "string" ? body.note.slice(0, 200) : null, now: ctx.now,
      });
      sendJson(ctx.res, 200, entryOut(entryJson(e)));
    } catch (e) { walletError(e); }
  });

  // The Android alert app

  r.on("POST", "/v1/device/ping", async (ctx) => {
    const body = await readBody(ctx.req, 4096);
    const device = verifyDevice(ctx, body);
    const m = ctx.db.prepare("select name from merchants where id = ?").get(device.merchant_id) as { name: string };
    sendJson(ctx.res, 200, { ok: true, merchant: m.name, device: device.name });
  });

  r.on("POST", "/v1/device/alerts", async (ctx) => {
    const body = await readBody(ctx.req, 64 * 1024);
    const device = verifyDevice(ctx, body);
    if (!limiter.take(`device:${device.id}`, 120, 60_000, ctx.now)) throw new HttpError(429, "rate_limited", "Too many alerts");
    let parsed: { alerts?: { text?: unknown; posted_at?: unknown }[] };
    try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new HttpError(400, "invalid_json", "The body isn't valid JSON"); }
    const list = Array.isArray(parsed.alerts) ? parsed.alerts.slice(0, 20) : [];
    const results: AlertOutcome[] = list.map((a) => {
      const text = typeof a.text === "string" ? a.text.slice(0, 2000) : "";
      const at = typeof a.posted_at === "number" ? a.posted_at : ctx.now;
      return recordAlert(ctx.db, ctx.cfg, { merchantId: device.merchant_id, source: "device", deviceId: device.id, text, receivedAt: at }, ctx.now);
    });
    sendJson(ctx.res, 200, { results: results.map((x) => x.result) });
  });

  // Bank alert emails, POSTed raw (message/rfc822) by an email worker or forwarding service.

  r.on("POST", "/v1/inbound/email/:token", async (ctx) => {
    const m = ctx.db.prepare("select * from merchants where email_token = ?").get(ctx.params.token!) as MerchantRow | undefined;
    if (!m) throw new HttpError(404, "not_found", "Unknown address");
    if (!limiter.take(`email:${m.id}`, 120, 60_000, ctx.now)) throw new HttpError(429, "rate_limited", "Too many emails");
    const raw = await readBody(ctx.req, 512 * 1024);
    const allowed = [...ctx.cfg.bankDomains, ...(JSON.parse(m.extra_bank_domains) as string[])];
    const check = await checkBankEmail(raw, allowed);
    if (!check.ok) {
      // 200 so forwarding services don't retry an email that will never pass.
      sendJson(ctx.res, 200, { result: "ignored", reason: check.reason });
      return;
    }
    const out = recordAlert(ctx.db, ctx.cfg, { merchantId: m.id, source: "email", text: check.text, receivedAt: check.date ?? ctx.now }, ctx.now);
    sendJson(ctx.res, 200, { result: out.result, ...(out.result === "ignored" ? { reason: out.reason } : {}) });
  });
}
