// The page the customer sees: amount, QR code, a button for UPI apps, and a box for the UTR.

import QRCode from "qrcode";
import { claimOrder, getMerchant, getOrder, OrderError, upiFor, type OrderRow } from "../orders.ts";
import { inr } from "../upi.ts";
import { HttpError, limiter, readForm, redirect, sendHtml, sendJson, type Ctx, type Router } from "./core.ts";
import { html, page, raw } from "./views.ts";

function load(ctx: Ctx) {
  const o = getOrder(ctx.db, ctx.params.id!);
  if (!o) throw new HttpError(404, "not_found", "This payment link isn't valid");
  return { o, m: getMerchant(ctx.db, o.merchant_id)! };
}

function returnTo(o: OrderRow): string | null {
  if (!o.return_url) return null;
  const u = new URL(o.return_url);
  u.searchParams.set("noha_order", o.id);
  u.searchParams.set("noha_status", o.status);
  return u.toString();
}

// Errors travel as short codes so nobody can put their own words on a payment page.
const UTR_ERRORS: Record<string, string> = {
  invalid_utr: "The UTR is the 12-digit number your UPI app shows after paying.",
  utr_used: "That UTR has already been used for another payment.",
  closed: "This payment is closed. If you paid, contact the shop with your UTR.",
  not_found: "This payment link isn't valid.",
  busy: "Too many tries. Wait a few minutes and try again.",
};

const STATUS_TEXT: Record<string, string> = {
  claimed: "Thanks. The shop is checking your payment. You can close this page; they'll confirm by email or message.",
  paid: "Payment received. Thank you!",
  declined: "The shop couldn't find this payment. If money left your account, contact them with your UTR.",
  expired: "This payment link has expired. If you already paid, enter your UTR below so the shop can find it.",
  refunded: "This payment was refunded.",
};

export function checkoutRoutes(r: Router): void {
  r.on("GET", "/pay/:id", async (ctx) => {
    const { o, m } = load(ctx);
    const open = o.status === "created";
    const graceOpen = o.status === "expired" && o.expires_at > ctx.now - ctx.cfg.graceMinutes * 60_000;
    const link = upiFor(m, o);
    const qr = open ? await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : "";
    const extra = o.pay_amount - o.amount;
    const error = UTR_ERRORS[ctx.url.searchParams.get("error") ?? ""];
    const body = html`
<main class="checkout" data-order="${o.id}" data-status="${o.status}" data-expires="${o.expires_at}" data-return="${returnTo(o) ?? ""}">
  <header class="checkout-head">
    <img src="/static/logo.svg" alt="" width="28" height="28">
    <span>${m.name}</span>
  </header>
  ${o.mode === "test" ? html`<p class="badge warn">Test payment: no real money moves</p>` : ""}
  <p class="label">Pay exactly</p>
  <p class="amount">${inr(o.pay_amount)}</p>
  ${extra > 0 ? html`<p class="hint">That's ${inr(o.amount)} plus ${extra} paise, so we can tell your payment apart. Please don't round it.</p>` : ""}
  ${open ? html`
  <div class="qr" aria-label="UPI QR code">${raw(qr)}</div>
  <a class="button primary app-only" href="${link}">Pay with a UPI app</a>
  <p class="hint">Scan with any UPI app, or tap the button on your phone. Paying to <strong>${m.vpa}</strong>.</p>
  <p class="timer" id="timer" aria-live="polite"></p>` : html`<p class="status-text" id="status-text">${STATUS_TEXT[o.status] ?? ""}</p>`}
  ${open || graceOpen ? html`
  <form method="post" action="/pay/${o.id}/utr" class="utr">
    <label for="utr">Paid already? Enter the 12-digit UTR from your UPI app</label>
    ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
    <div class="row">
      <input id="utr" name="utr" inputmode="numeric" autocomplete="off" pattern="[0-9 ]{12,15}" maxlength="15" required placeholder="e.g. 412345678901">
      <button class="button" type="submit">Submit</button>
    </div>
  </form>` : ""}
  ${open ? html`<p class="status-text" id="status-text" hidden></p>` : ""}
  ${o.status === "paid" && returnTo(o) ? html`<a class="button primary" href="${returnTo(o)!}">Back to ${m.name}</a>` : ""}
  <footer class="checkout-foot">Secured by Noha Pay · money goes straight to ${m.name}'s bank account</footer>
</main>`;
    sendHtml(ctx.res, 200, page({ title: `Pay ${m.name}`, body, bodyClass: "checkout-page", scripts: ["/static/checkout.js"] }));
  });

  r.on("GET", "/pay/:id/status", (ctx) => {
    const { o } = load(ctx);
    sendJson(ctx.res, 200, { status: o.status, message: STATUS_TEXT[o.status] ?? null, return_url: o.status === "paid" ? returnTo(o) : null });
  });

  r.on("POST", "/pay/:id/utr", async (ctx) => {
    const id = ctx.params.id!;
    const back = (code?: string) => redirect(ctx.res, `/pay/${encodeURIComponent(id)}${code ? `?error=${code in UTR_ERRORS ? code : "closed"}` : ""}`);
    if (!limiter.take(`utr:${ctx.ip}`, 10, 10 * 60_000, ctx.now) || !limiter.take(`utr-order:${id}`, 5, 60 * 60_000, ctx.now)) {
      back("busy");
      return;
    }
    const form = await readForm(ctx.req);
    try {
      claimOrder(ctx.db, ctx.cfg, id, form.get("utr") ?? "", ctx.now);
      back();
    } catch (e) {
      if (e instanceof OrderError) back(e.code);
      else throw e;
    }
  });
}
