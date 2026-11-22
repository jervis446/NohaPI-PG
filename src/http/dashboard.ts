// The merchant dashboard: orders, unmatched alerts, Noha Money, alert sources, developer settings.

import QRCode from "qrcode";
import {
  createApiKey, createDevice, listDevices, listKeys, pairingCode, revokeDevice, revokeKey, rotateEmailToken,
  rotateWebhookSecret, sessionFor, signIn, signOut, updateSettings, type Session,
} from "../accounts.ts";
import { attachAlert, dismissAlert } from "../alerts/match.ts";
import { randomText, sameText } from "../crypto.ts";
import { getOrder, listOrders, markRefunded, merchantDecide, OrderError, type OrderRow } from "../orders.ts";
import { inr, parsePaise } from "../upi.ts";
import { balance, checkCustomer, credit, debit, entries, outstanding, WalletError } from "../wallet.ts";
import { resend, webhookProblem } from "../webhooks.ts";
import { cookie, cookies, HttpError, limiter, readForm, redirect, sendHtml, type Ctx, type Router } from "./core.ts";
import { dateTime, html, page, raw, type Safe } from "./views.ts";

const SESSION_COOKIE = "np_session";
const FLASH_COOKIE = "np_flash";

function session(ctx: Ctx): Session | null {
  return sessionFor(ctx.db, cookies(ctx.req)[SESSION_COOKIE], ctx.now);
}

function requireSession(ctx: Ctx): Session {
  const s = session(ctx);
  if (!s) throw new LoginNeeded();
  return s;
}

class LoginNeeded extends Error {}

/** Reads a POSTed form and checks it came from our own page. */
async function postedForm(ctx: Ctx, s: Session): Promise<URLSearchParams> {
  const origin = ctx.req.headers.origin;
  if (origin && origin !== new URL(ctx.cfg.publicUrl).origin) throw new HttpError(403, "bad_origin", "This form came from another site");
  const form = await readForm(ctx.req);
  if (!sameText(form.get("csrf") ?? "", s.csrf)) throw new HttpError(403, "bad_csrf", "This page was open too long. Reload it and try again.");
  return form;
}

function flash(ctx: Ctx, to: string, kind: "ok" | "err", message: string) {
  redirect(ctx.res, to, { "Set-Cookie": cookie(FLASH_COOKIE, `${kind}:${message}`, { maxAgeSec: 60, secure: ctx.cfg.secureCookies }) });
}

function takeFlash(ctx: Ctx): { kind: string; message: string } | null {
  const v = cookies(ctx.req)[FLASH_COOKIE];
  if (!v) return null;
  ctx.res.setHeader("Set-Cookie", cookie(FLASH_COOKIE, "", { maxAgeSec: 0, secure: ctx.cfg.secureCookies }));
  const at = v.indexOf(":");
  return { kind: v.slice(0, at), message: v.slice(at + 1).slice(0, 300) };
}

const NAV: [string, string][] = [
  ["/dashboard", "Orders"],
  ["/dashboard/alerts", "Unmatched alerts"],
  ["/dashboard/wallets", "Noha Money"],
  ["/dashboard/sources", "Alert sources"],
  ["/dashboard/developers", "Developers"],
  ["/dashboard/settings", "Settings"],
];

function shell(ctx: Ctx, s: Session, title: string, content: Safe, notice?: { kind: string; message: string } | null): string {
  const f = notice === undefined ? takeFlash(ctx) : notice;
  const here = ctx.url.pathname;
  const unmatched = (ctx.db.prepare("select count(*) as n from alerts where merchant_id = ? and status = 'unmatched'").get(s.merchant.id) as { n: number }).n;
  const review = (ctx.db.prepare("select count(*) as n from orders where merchant_id = ? and status = 'claimed'").get(s.merchant.id) as { n: number }).n;
  const body = html`
<div class="shell">
  <nav class="side" aria-label="Main">
    <a class="brand" href="/dashboard"><img src="/static/logo.svg" alt="" width="26" height="26"> Noha Pay</a>
    <p class="merchant-name">${s.merchant.name}</p>
    <ul>
      ${NAV.map(([href, label]) => {
        const count = href === "/dashboard" ? review : href === "/dashboard/alerts" ? unmatched : 0;
        const current = href === here || (href !== "/dashboard" && here.startsWith(href));
        return html`<li><a href="${href}" ${current ? raw('aria-current="page"') : ""}>${label}${count ? html` <span class="count">${count}</span>` : ""}</a></li>`;
      })}
    </ul>
    <form method="post" action="/logout" class="signout">
      <input type="hidden" name="csrf" value="${s.csrf}">
      <button class="link" type="submit">Sign out ${s.email}</button>
    </form>
  </nav>
  <main class="content">
    <h1>${title}</h1>
    ${f ? html`<p class="notice ${f.kind}" role="status">${f.message}</p>` : ""}
    ${content}
  </main>
</div>`;
  return page({ title: `${title} · Noha Pay`, body, scripts: ["/static/dashboard.js"] });
}

const csrf = (s: Session) => html`<input type="hidden" name="csrf" value="${s.csrf}">`;

const STATUS_LABEL: Record<string, string> = {
  created: "Waiting", claimed: "Needs review", paid: "Paid", declined: "Declined", expired: "Expired", refunded: "Refunded",
};
const VIA_LABEL: Record<string, string> = {
  alert: "bank alert", utr_and_alert: "UTR and bank alert", merchant: "you approved it", test: "test",
};

const statusBadge = (st: string) => html`<span class="badge s-${st}">${STATUS_LABEL[st] ?? st}</span>`;

function orderTable(rows: OrderRow[]): Safe {
  if (rows.length === 0) return html`<p class="empty">No orders here yet.</p>`;
  return html`
<div class="table-wrap"><table>
  <thead><tr><th>Created</th><th>Reference</th><th>Customer</th><th class="num">Amount</th><th>Status</th><th>UTR</th></tr></thead>
  <tbody>${rows.map((o) => html`
    <tr>
      <td>${dateTime(o.created_at)}</td>
      <td><a href="/dashboard/orders/${o.id}">${o.reference}</a>${o.mode === "test" ? html` <span class="badge warn">test</span>` : ""}</td>
      <td>${o.customer_name ?? o.customer_email ?? o.customer_id ?? ""}</td>
      <td class="num">${inr(o.pay_amount)}</td>
      <td>${statusBadge(o.status)}</td>
      <td class="mono">${o.utr ?? ""}</td>
    </tr>`)}
  </tbody>
</table></div>`;
}

function fail(ctx: Ctx, to: string, e: unknown) {
  if (e instanceof OrderError || e instanceof WalletError || e instanceof HttpError || e instanceof Error) {
    flash(ctx, to, "err", e.message);
    return;
  }
  throw e;
}

export function dashboardRoutes(r: Router): void {
  // Sign in and out

  r.on("GET", "/login", (ctx) => {
    if (session(ctx)) return redirect(ctx.res, "/dashboard");
    const f = takeFlash(ctx);
    const body = html`
<main class="login">
  <img src="/static/logo.svg" alt="" width="48" height="48">
  <h1>Sign in to Noha Pay</h1>
  ${f ? html`<p class="notice ${f.kind}" role="alert">${f.message}</p>` : ""}
  <form method="post" action="/login">
    <label>Email <input type="email" name="email" autocomplete="username" required></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <button class="button primary" type="submit">Sign in</button>
  </form>
  <p class="hint">Accounts are created by whoever runs this server. Ask them if you need one.</p>
</main>`;
    sendHtml(ctx.res, 200, page({ title: "Sign in · Noha Pay", body, bodyClass: "login-page" }));
  });

  r.on("POST", "/login", async (ctx) => {
    const form = await readForm(ctx.req);
    const email = (form.get("email") ?? "").trim().toLowerCase();
    if (!limiter.take(`login-ip:${ctx.ip}`, 20, 15 * 60_000, ctx.now) || !limiter.take(`login:${email}`, 8, 15 * 60_000, ctx.now)) {
      return flash(ctx, "/login", "err", "Too many tries. Wait 15 minutes and try again.");
    }
    const out = await signIn(ctx.db, email, form.get("password") ?? "", ctx.now);
    if (!out) return flash(ctx, "/login", "err", "That email and password don't match.");
    redirect(ctx.res, "/dashboard", { "Set-Cookie": cookie(SESSION_COOKIE, out.token, { maxAgeSec: 14 * 86400, secure: ctx.cfg.secureCookies }) });
  });

  r.on("POST", "/logout", async (ctx) => {
    const s = requireSession(ctx);
    await postedForm(ctx, s);
    signOut(ctx.db, s.tokenHash);
    redirect(ctx.res, "/login", { "Set-Cookie": cookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure: ctx.cfg.secureCookies }) });
  });

  // Orders

  r.on("GET", "/dashboard", (ctx) => {
    const s = requireSession(ctx);
    const tab = ctx.url.searchParams.get("tab") ?? "all";
    const status = tab === "review" ? "claimed" : tab === "paid" ? "paid" : undefined;
    const mode = ctx.url.searchParams.get("mode") === "test" ? "test" : "live";
    const rows = listOrders(ctx.db, s.merchant.id, { status, mode, limit: 100 });
    const tabs: [string, string][] = [["all", "All"], ["review", "Needs review"], ["paid", "Paid"]];
    const today = ctx.db.prepare(
      "select count(*) as n, coalesce(sum(amount), 0) as total from orders where merchant_id = ? and mode = 'live' and status = 'paid' and paid_at >= ?",
    ).get(s.merchant.id, ctx.now - 86400_000) as { n: number; total: number };
    const content = html`
<p class="lede">Last 24 hours: <strong>${today.n}</strong> paid, <strong>${inr(Number(today.total))}</strong> received.</p>
<div class="tabs">
  ${tabs.map(([k, label]) => html`<a href="/dashboard?tab=${k}&mode=${mode}" ${k === tab ? raw('aria-current="page"') : ""}>${label}</a>`)}
  <a class="right" href="/dashboard?tab=${tab}&mode=${mode === "live" ? "test" : "live"}">${mode === "live" ? "Show test orders" : "Show live orders"}</a>
</div>
${tab === "review" ? html`<p class="hint">The customer typed a UTR, but no bank alert has confirmed it. Check your bank app, then approve or decline.</p>` : ""}
${orderTable(rows)}`;
    sendHtml(ctx.res, 200, shell(ctx, s, "Orders", content));
  });

  r.on("GET", "/dashboard/orders/:id", (ctx) => {
    const s = requireSession(ctx);
    const o = getOrder(ctx.db, ctx.params.id!);
    if (!o || o.merchant_id !== s.merchant.id) throw new HttpError(404, "not_found", "Order not found");
    const alert = o.alert_id ? ctx.db.prepare("select * from alerts where id = ?").get(o.alert_id) as { source: string; text: string | null; received_at: number } | undefined : undefined;
    const open = o.status === "created" || o.status === "claimed" || o.status === "expired";
    const action = (name: string, label: string, cls = "button") => html`
      <form method="post" action="/dashboard/orders/${o.id}/${name}" class="inline">${csrf(s)}<button class="${cls}" type="submit">${label}</button></form>`;
    const content = html`
<p><a href="/dashboard">← All orders</a></p>
<dl class="facts">
  <dt>Status</dt><dd>${statusBadge(o.status)}${o.paid_via ? html` <span class="hint">via ${VIA_LABEL[o.paid_via]}</span>` : ""}</dd>
  <dt>Reference</dt><dd>${o.reference}${o.mode === "test" ? html` <span class="badge warn">test</span>` : ""}</dd>
  <dt>Amount</dt><dd>${inr(o.amount)}${o.pay_amount !== o.amount ? html` <span class="hint">(customer pays ${inr(o.pay_amount)})</span>` : ""}</dd>
  <dt>Purpose</dt><dd>${o.purpose === "wallet_topup" ? "Noha Money top-up" : "Payment"}</dd>
  <dt>UTR</dt><dd class="mono">${o.utr ?? "—"}</dd>
  <dt>Customer</dt><dd>${[o.customer_name, o.customer_email, o.customer_phone, o.customer_id].filter(Boolean).join(" · ") || "—"}</dd>
  <dt>Created</dt><dd>${dateTime(o.created_at)}</dd>
  <dt>Expires</dt><dd>${dateTime(o.expires_at)}</dd>
  ${o.paid_at ? html`<dt>Paid</dt><dd>${dateTime(o.paid_at)}</dd>` : ""}
  ${o.notes ? html`<dt>Notes</dt><dd>${o.notes}</dd>` : ""}
  <dt>Order id</dt><dd class="mono">${o.id}</dd>
</dl>
${alert ? html`<h2>Bank alert</h2><p class="hint">From ${alert.source === "device" ? "your phone" : "email"} at ${dateTime(alert.received_at)}</p>
  ${alert.text ? html`<pre class="alert-text">${alert.text}</pre>` : html`<p class="hint">The alert text was deleted after the keep period.</p>`}` : ""}
<div class="actions">
  ${open && o.mode === "live" ? [action("approve", "I received this money", "button primary"), action("decline", "Decline")] : ""}
  ${open && o.mode === "test" ? [action("approve", "Mark test payment paid", "button primary"), action("decline", "Decline")] : ""}
  ${o.status === "paid" ? action("refund", "Mark as refunded") : ""}
</div>
${open && o.mode === "live" ? html`<p class="hint">Approve only after you see the money in your bank app. A typed UTR on its own isn't proof.</p>` : ""}
${o.status === "paid" ? html`<p class="hint">Refunds are sent from your own UPI app. This just records that you did.</p>` : ""}`;
    sendHtml(ctx.res, 200, shell(ctx, s, `Order ${o.reference}`, content));
  });

  r.on("POST", "/dashboard/orders/:id/:action", async (ctx) => {
    const s = requireSession(ctx);
    await postedForm(ctx, s);
    const id = ctx.params.id!;
    const to = `/dashboard/orders/${encodeURIComponent(id)}`;
    try {
      const a = ctx.params.action;
      if (a === "approve") merchantDecide(ctx.db, ctx.cfg, s.merchant.id, id, true, ctx.now);
      else if (a === "decline") merchantDecide(ctx.db, ctx.cfg, s.merchant.id, id, false, ctx.now);
      else if (a === "refund") markRefunded(ctx.db, ctx.cfg, s.merchant.id, id, ctx.now);
      else throw new HttpError(404, "not_found", "Unknown action");
      flash(ctx, to, "ok", a === "approve" ? "Marked paid. Your server has been told." : a === "decline" ? "Declined." : "Marked as refunded.");
    } catch (e) { fail(ctx, to, e); }
  });

  // Unmatched alerts

  r.on("GET", "/dashboard/alerts", (ctx) => {
    const s = requireSession(ctx);
    const rows = ctx.db.prepare(
      "select * from alerts where merchant_id = ? and status = 'unmatched' order by received_at desc limit 100",
    ).all(s.merchant.id) as { id: string; source: string; amount: number; utr: string | null; payer_vpa: string | null; received_at: number; reason: string | null; text: string | null }[];
    const content = html`
<p class="lede">Credit alerts that didn't fit exactly one order. Attach each to the right order, or dismiss it if it wasn't a customer payment.</p>
${rows.length === 0 ? html`<p class="empty">Nothing waiting. Every alert found its order.</p>` : rows.map((a) => html`
<section class="card">
  <p><strong>${inr(a.amount)}</strong> · ${dateTime(a.received_at)} · from ${a.source === "device" ? "your phone" : "email"}
     ${a.utr ? html` · UTR <span class="mono">${a.utr}</span>` : ""}${a.payer_vpa ? html` · ${a.payer_vpa}` : ""}</p>
  <p class="hint">${a.reason ?? ""}</p>
  ${a.text ? html`<details><summary>Alert text</summary><pre class="alert-text">${a.text}</pre></details>` : ""}
  <div class="row">
    <form method="post" action="/dashboard/alerts/${a.id}/attach" class="inline">${csrf(s)}
      <label class="sr-only" for="o-${a.id}">Order id or reference</label>
      <input id="o-${a.id}" name="order" placeholder="Order id or reference" required>
      <button class="button primary" type="submit">Attach and mark paid</button>
    </form>
    <form method="post" action="/dashboard/alerts/${a.id}/dismiss" class="inline">${csrf(s)}<button class="button" type="submit">Dismiss</button></form>
  </div>
</section>`)}`;
    sendHtml(ctx.res, 200, shell(ctx, s, "Unmatched alerts", content));
  });

  r.on("POST", "/dashboard/alerts/:id/:action", async (ctx) => {
    const s = requireSession(ctx);
    const form = await postedForm(ctx, s);
    try {
      if (ctx.params.action === "dismiss") {
        dismissAlert(ctx.db, s.merchant.id, ctx.params.id!);
        return flash(ctx, "/dashboard/alerts", "ok", "Dismissed.");
      }
      if (ctx.params.action !== "attach") throw new HttpError(404, "not_found", "Unknown action");
      const q = (form.get("order") ?? "").trim();
      const row = ctx.db.prepare("select id from orders where merchant_id = ? and (id = ? or reference = ?) and mode = 'live' order by created_at desc limit 1")
        .get(s.merchant.id, q, q) as { id: string } | undefined;
      if (!row) throw new Error(`No live order with id or reference "${q}"`);
      attachAlert(ctx.db, ctx.cfg, s.merchant.id, ctx.params.id!, row.id, ctx.now);
      flash(ctx, "/dashboard/alerts", "ok", "Attached. The order is now paid.");
    } catch (e) { fail(ctx, "/dashboard/alerts", e); }
  });

  // Noha Money

  r.on("GET", "/dashboard/wallets", (ctx) => {
    const s = requireSession(ctx);
    const q = (ctx.url.searchParams.get("customer") ?? "").trim();
    const owed = outstanding(ctx.db, s.merchant.id);
    let found: Safe | string = "";
    if (q) {
      let ok = true;
      try { checkCustomer(q); } catch { ok = false; }
      if (!ok || q.startsWith("test:")) found = html`<p class="notice err">That isn't a valid customer id.</p>`;
      else {
        const list = entries(ctx.db, s.merchant.id, q, 50);
        found = html`
<section class="card">
  <h2>${q}</h2>
  <p class="big">${inr(balance(ctx.db, s.merchant.id, q))}</p>
  <form method="post" action="/dashboard/wallets/change" class="stack">${csrf(s)}
    <input type="hidden" name="customer" value="${q}">
    <div class="row">
      <label>Change <select name="kind">
        <option value="cashback">Add cashback</option>
        <option value="adjust_up">Correct: add</option>
        <option value="adjust_down">Correct: take away</option>
      </select></label>
      <label>Amount (₹) <input name="amount" inputmode="decimal" required placeholder="50.00"></label>
    </div>
    <label>Note (the customer may see this) <input name="note" maxlength="200" required></label>
    <input type="hidden" name="idem" value="${`dash:${randomText(24)}`}">
    <button class="button primary" type="submit">Save</button>
  </form>
  ${list.length ? html`<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>What</th><th class="num">Change</th><th class="num">Balance</th><th>Note</th></tr></thead>
    <tbody>${list.map((e) => html`<tr><td>${dateTime(e.created_at)}</td><td>${e.kind}</td><td class="num">${e.amount > 0 ? "+" : ""}${inr(e.amount)}</td><td class="num">${inr(e.balance_after)}</td><td>${e.note ?? ""}</td></tr>`)}</tbody>
  </table></div>` : html`<p class="empty">No Noha Money activity for this customer yet.</p>`}
</section>`;
      }
    }
    const content = html`
<p class="lede">${owed.wallets} customers hold <strong>${inr(owed.total)}</strong> in Noha Money with you. It can only be spent at ${s.merchant.name}; it can't be withdrawn or sent to anyone else.</p>
<form method="get" action="/dashboard/wallets" class="row">
  <label class="grow">Customer id <input name="customer" value="${q}" placeholder="The id your app uses for this customer"></label>
  <button class="button" type="submit">Look up</button>
</form>
${found}`;
    sendHtml(ctx.res, 200, shell(ctx, s, "Noha Money", content));
  });

  r.on("POST", "/dashboard/wallets/change", async (ctx) => {
    const s = requireSession(ctx);
    const form = await postedForm(ctx, s);
    const customer = (form.get("customer") ?? "").trim();
    const to = `/dashboard/wallets?customer=${encodeURIComponent(customer)}`;
    try {
      if (customer.startsWith("test:")) throw new Error("That isn't a valid customer id.");
      const paise = parsePaise(form.get("amount") ?? "");
      if (!paise) throw new Error("Enter an amount like 50 or 49.50");
      const note = (form.get("note") ?? "").trim().slice(0, 200);
      if (!note) throw new Error("Add a note saying why");
      const idem = (form.get("idem") ?? "").slice(0, 90);
      const kind = form.get("kind");
      if (kind === "cashback") credit(ctx.db, s.merchant.id, customer, "cashback", paise, idem, { note, now: ctx.now });
      else if (kind === "adjust_up") credit(ctx.db, s.merchant.id, customer, "adjust", paise, idem, { note, now: ctx.now });
      else if (kind === "adjust_down") debit(ctx.db, s.merchant.id, customer, "adjust", paise, idem, { note, now: ctx.now });
      else throw new Error("Pick what to change");
      flash(ctx, to, "ok", "Saved.");
    } catch (e) { fail(ctx, to, e); }
  });

  // Alert sources: phones and email

  const sourcesPage = async (ctx: Ctx, s: Session, newDevice?: { name: string; code: string }) => {
    const devices = listDevices(ctx.db, s.merchant.id);
    const domains = JSON.parse(s.merchant.extra_bank_domains) as string[];
    const qr = newDevice ? await QRCode.toString(newDevice.code, { type: "svg", margin: 1 }) : "";
    const content = html`
<section class="card">
  <h2>Phones</h2>
  <p class="hint">Install the Noha Pay Alerts app on the phone that gets your bank's credit alerts, then pair it here. It sends only alerts that look like money coming in.</p>
  ${newDevice ? html`
  <div class="notice ok">
    <p><strong>Pair "${newDevice.name}" now.</strong> In the app, tap Pair and scan this code, or paste the text below. It's shown only once.</p>
    <div class="qr small">${raw(qr)}</div>
    <p><code class="secret">${newDevice.code}</code></p>
  </div>` : ""}
  ${devices.length ? html`<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Paired</th><th>Last alert</th><th></th></tr></thead>
    <tbody>${devices.map((d) => html`<tr>
      <td>${d.name}</td><td>${dateTime(d.created_at)}</td><td>${d.revoked_at ? "Unpaired" : d.last_seen_at ? dateTime(d.last_seen_at) : "Not yet"}</td>
      <td>${d.revoked_at ? "" : html`<form method="post" action="/dashboard/sources/devices/${d.id}/revoke" class="inline">${csrf(s)}<button class="link danger" type="submit">Unpair</button></form>`}</td>
    </tr>`)}</tbody></table></div>` : ""}
  <form method="post" action="/dashboard/sources/devices" class="row">${csrf(s)}
    <label class="grow">Phone name <input name="name" maxlength="60" placeholder="Shop phone" required></label>
    <button class="button primary" type="submit">Pair a phone</button>
  </form>
</section>
<section class="card">
  <h2>Email alerts</h2>
  <p class="hint">Have a mail service POST each bank alert email, raw, to this private address. Only emails with a valid DKIM signature from a bank domain are read; anything else is ignored.</p>
  <p><code class="secret">${ctx.cfg.publicUrl}/v1/inbound/email/${s.merchant.email_token}</code></p>
  <form method="post" action="/dashboard/sources/email/rotate" class="inline">${csrf(s)}<button class="button" type="submit">Make a new address</button></form>
  <form method="post" action="/dashboard/sources/email/domains" class="stack">${csrf(s)}
    <label>Extra bank domains, comma-separated (if your bank isn't on the built-in list)
      <input name="domains" value="${domains.join(", ")}" placeholder="mybank.co.in"></label>
    <button class="button" type="submit">Save domains</button>
  </form>
  <details><summary>Built-in bank domains</summary><p class="hint">${ctx.cfg.bankDomains.join(", ")}</p></details>
</section>`;
    return shell(ctx, s, "Alert sources", content, newDevice ? null : undefined);
  };

  r.on("GET", "/dashboard/sources", async (ctx) => {
    const s = requireSession(ctx);
    sendHtml(ctx.res, 200, await sourcesPage(ctx, s));
  });

  r.on("POST", "/dashboard/sources/devices", async (ctx) => {
    const s = requireSession(ctx);
    const form = await postedForm(ctx, s);
    const d = createDevice(ctx.db, s.merchant.id, form.get("name") ?? "", ctx.now);
    sendHtml(ctx.res, 200, await sourcesPage(ctx, s, { name: d.name, code: pairingCode(ctx.cfg.publicUrl, d) }));
  });

  r.on("POST", "/dashboard/sources/devices/:id/revoke", async (ctx) => {
    const s = requireSession(ctx);
    await postedForm(ctx, s);
    revokeDevice(ctx.db, s.merchant.id, ctx.params.id!, ctx.now);
    flash(ctx, "/dashboard/sources", "ok", "Unpaired. That phone can't send alerts any more.");
  });

  r.on("POST", "/dashboard/sources/email/rotate", async (ctx) => {
    const s = requireSession(ctx);
    await postedForm(ctx, s);
    rotateEmailToken(ctx.db, s.merchant.id);
    flash(ctx, "/dashboard/sources", "ok", "New address made. Update your mail service; the old one stopped working.");
  });

  r.on("POST", "/dashboard/sources/email/domains", async (ctx) => {
    const s = requireSession(ctx);
    const form = await postedForm(ctx, s);
    updateSettings(ctx.db, s.merchant.id, { extraBankDomains: (form.get("domains") ?? "").split(",") });
    flash(ctx, "/dashboard/sources", "ok", "Saved.");
  });

  // Developers: API keys and webhooks

  const devPage = (ctx: Ctx, s: Session, newKey?: string) => {
    const keys = listKeys(ctx.db, s.merchant.id);
    const hooks = ctx.db.prepare("select * from webhooks where merchant_id = ? order by created_at desc limit 30").all(s.merchant.id) as
      { id: string; type: string; status: string; attempts: number; last_code: number | null; last_error: string | null; created_at: number }[];
    const content = html`
<section class="card">
  <h2>API keys</h2>
  ${newKey ? html`<div class="notice ok"><p><strong>Copy this key now.</strong> It won't be shown again.</p><p><code class="secret">${newKey}</code></p></div>` : ""}
  ${keys.length ? html`<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Key</th><th>Mode</th><th>Last used</th><th></th></tr></thead>
    <tbody>${keys.map((k) => html`<tr>
      <td>${k.name}</td><td class="mono">${k.prefix}…</td><td>${k.mode}</td>
      <td>${k.revoked_at ? "Revoked" : k.last_used_at ? dateTime(k.last_used_at) : "Never"}</td>
      <td>${k.revoked_at ? "" : html`<form method="post" action="/dashboard/developers/keys/${k.id}/revoke" class="inline">${csrf(s)}<button class="link danger" type="submit">Revoke</button></form>`}</td>
    </tr>`)}</tbody></table></div>` : ""}
  <form method="post" action="/dashboard/developers/keys" class="row">${csrf(s)}
    <label class="grow">Name <input name="name" maxlength="60" placeholder="Website server" required></label>
    <label>Mode <select name="mode"><option value="test">Test</option><option value="live">Live</option></select></label>
    <button class="button primary" type="submit">Create key</button>
  </form>
</section>
<section class="card">
  <h2>Webhooks</h2>
  <form method="post" action="/dashboard/developers/webhook" class="row">${csrf(s)}
    <label class="grow">Send events to <input name="url" type="url" value="${s.merchant.webhook_url ?? ""}" placeholder="https://example.com/noha-pay/webhook"></label>
    <button class="button primary" type="submit">Save</button>
  </form>
  <p class="hint">Check the <code>Noha-Signature</code> header with your signing secret. It starts <code>${s.merchant.webhook_secret.slice(0, 10)}…</code>.</p>
  <form method="post" action="/dashboard/developers/webhook/secret" class="inline">${csrf(s)}<button class="button" type="submit">Show a new signing secret</button></form>
  ${hooks.length ? html`<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Event</th><th>Result</th><th></th></tr></thead>
    <tbody>${hooks.map((w) => html`<tr>
      <td>${dateTime(w.created_at)}</td><td class="mono">${w.type}</td>
      <td>${w.status === "delivered" ? `Delivered (${w.last_code})` : w.status === "pending" ? (w.attempts ? `Retrying: ${w.last_error ?? ""}` : "Sending") : `Failed: ${w.last_error ?? ""}`}</td>
      <td>${w.status === "pending" ? "" : html`<form method="post" action="/dashboard/developers/webhooks/${w.id}/resend" class="inline">${csrf(s)}<button class="link" type="submit">Send again</button></form>`}</td>
    </tr>`)}</tbody></table></div>` : html`<p class="empty">No events sent yet.</p>`}
</section>`;
    return shell(ctx, s, "Developers", content, newKey ? null : undefined);
  };

  r.on("GET", "/dashboard/developers", (ctx) => {
    const s = requireSession(ctx);
    sendHtml(ctx.res, 200, devPage(ctx, s));
  });

  r.on("POST", "/dashboard/developers/keys", async (ctx) => {
    const s = requireSession(ctx);
    const form = await postedForm(ctx, s);
    try {
      const { key } = createApiKey(ctx.db, s.merchant.id, form.get("name") ?? "", form.get("mode") === "live" ? "live" : "test", ctx.now);
      sendHtml(ctx.res, 200, devPage(ctx, s, key));
    } catch (e) { fail(ctx, "/dashboard/developers", e); }
  });

  r.on("POST", "/dashboard/developers/keys/:id/revoke", async (ctx) => {
    const s = requireSession(ctx);
    await postedForm(ctx, s);
    revokeKey(ctx.db, s.merchant.id, ctx.params.id!, ctx.now);
    flash(ctx, "/dashboard/developers", "ok", "Key revoked.");
  });

  r.on("POST", "/dashboard/developers/webhook", async (ctx) => {
    const s = requireSession(ctx);
    const form = await postedForm(ctx, s);
    const url = (form.get("url") ?? "").trim();
    const problem = url ? await webhookProblem(url) : null;
    if (problem) return flash(ctx, "/dashboard/developers", "err", problem);
    updateSettings(ctx.db, s.merchant.id, { webhookUrl: url || null });
    flash(ctx, "/dashboard/developers", "ok", url ? "Saved. New events go to this address." : "Webhooks turned off.");
  });

  r.on("POST", "/dashboard/developers/webhook/secret", async (ctx) => {
    const s = requireSession(ctx);
    await postedForm(ctx, s);
    const secret = rotateWebhookSecret(ctx.db, s.merchant.id);
    const fresh = sessionFor(ctx.db, cookies(ctx.req)[SESSION_COOKIE], ctx.now)!;
    const content = html`<div class="notice ok"><p><strong>New signing secret.</strong> Put it in your server now; the old one stopped working.</p><p><code class="secret">${secret}</code></p></div>
      <p><a href="/dashboard/developers">Back to Developers</a></p>`;
    sendHtml(ctx.res, 200, shell(ctx, fresh, "Developers", content, null));
  });

  r.on("POST", "/dashboard/developers/webhooks/:id/resend", async (ctx) => {
    const s = requireSession(ctx);
    await postedForm(ctx, s);
    resend(ctx.db, s.merchant.id, ctx.params.id!, ctx.now);
    flash(ctx, "/dashboard/developers", "ok", "Queued to send again.");
  });

  // Settings

  r.on("GET", "/dashboard/settings", (ctx) => {
    const s = requireSession(ctx);
    const m = s.merchant;
    const content = html`
<form method="post" action="/dashboard/settings" class="stack card">${csrf(s)}
  <label>Business name <input name="name" value="${m.name}" maxlength="100" required></label>
  <label>UPI id that receives payments <input name="vpa" value="${m.vpa}" required placeholder="shop@okhdfcbank"></label>
  <label>Name shown in UPI apps <input name="payee" value="${m.payee_name}" maxlength="50" required></label>
  <label>Minutes a customer has to pay <input name="minutes" type="number" min="2" max="60" value="${m.order_minutes ?? ctx.cfg.orderMinutes}"></label>
  <button class="button primary" type="submit">Save</button>
</form>
<p class="hint">Use a business or current-account UPI id. Many banks don't allow business payments into a personal one and may limit the account.</p>`;
    sendHtml(ctx.res, 200, shell(ctx, s, "Settings", content));
  });

  r.on("POST", "/dashboard/settings", async (ctx) => {
    const s = requireSession(ctx);
    const form = await postedForm(ctx, s);
    try {
      updateSettings(ctx.db, s.merchant.id, {
        name: form.get("name") ?? "",
        vpa: form.get("vpa") ?? "",
        payeeName: form.get("payee") ?? "",
        orderMinutes: Number(form.get("minutes")) || null,
      });
      flash(ctx, "/dashboard/settings", "ok", "Saved.");
    } catch (e) { fail(ctx, "/dashboard/settings", e); }
  });
}

export { LoginNeeded };
