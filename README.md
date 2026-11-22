<p align="center">
  <img src="public/wordmark.svg" alt="Noha Pay" width="300">
</p>

<p align="center">
  UPI payments straight into your own bank account, confirmed for you.<br>
  Plus Noha Money, a store wallet your customers can top up and spend.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-0E5A4A"></a>
  <img alt="Node 24" src="https://img.shields.io/badge/node-24-0E5A4A">
  <img alt="Two runtime dependencies" src="https://img.shields.io/badge/dependencies-2-C98A1C">
</p>

---

Noha Pay is a small server you run yourself. Your customer scans a QR code or taps a button, pays
from any UPI app, and the money goes directly to your UPI ID. Noha Pay never touches the money. It
works out which order each payment belongs to, tells your website, and keeps a tidy record.

It's made by [Asanoha](https://asanoha.co.in) and runs the checkouts of our own products.

## Before you use it

Please read this once. It's short.

- **It isn't a licensed payment gateway.** Noha Pay is software. It isn't approved by NPCI, RBI or
  any bank, and running it doesn't make you a payment aggregator. If you collect money on behalf of
  other businesses, get legal advice first.
- **Use a business UPI ID.** Many banks don't allow business payments into a personal account and
  may limit one that receives them. Ask your bank what they allow.
- **A typed UTR isn't proof.** Noha Pay only marks an order paid on its own when a bank alert matches
  it. Anything doubtful waits for you to check your bank app.
- **No warranty.** It's provided as is, under the AGPL-3.0 license. Test with small amounts first.

## How it works

1. Your server asks Noha Pay for an order of, say, ₹499.
2. The customer opens the checkout page and pays the exact amount shown. If another ₹499 order is
   already open, this one asks for ₹499.01, so the two can't be confused.
3. Your bank tells you the money arrived: by app notification, SMS or email. Noha Pay hears about
   it in one of three ways:
   - **Your phone.** The Noha Pay Alerts app forwards credit notifications from the apps you choose.
   - **Email.** Bank alert emails are forwarded to a private address. Only emails with a genuine
     DKIM signature from a bank are read.
   - **You.** The customer types their UTR, and you approve it in the dashboard after checking your
     bank app.
4. When exactly one open order matches the amount, it's marked paid and your server gets a signed
   webhook. If two orders could match, or none, the alert waits in the dashboard for you.

The full reasoning is in [docs/design.md](docs/design.md).

## What's included

- **Checkout page** with QR code, a "Pay with a UPI app" button on phones, a countdown, and a UTR box.
- **Merchant API** with live and test keys. Test orders can be marked paid with one click, so you
  can build your integration without moving money.
- **Signed webhooks** with automatic retries for `order.claimed`, `order.paid`, `order.declined`,
  `order.expired`, `order.refunded` and `wallet.updated`.
- **Dashboard** for orders, payments to review, unmatched alerts, Noha Money, paired phones, email
  alerts, API keys and webhook history.
- **Noha Money**, a closed-loop wallet. Customers top it up through a normal checkout, you add
  cashback, and they spend it with you. There's no way to withdraw it or send it to someone else,
  which keeps it outside RBI's prepaid-instrument licensing.
- **Android alert app** in [`android/`](android), with no third-party libraries.
- **Many merchants on one server**, so you can host it for others.

## Set it up

You need Node.js 24 or newer.

```bash
git clone https://github.com/jervis446/NohaPI-PG.git noha-pay
cd noha-pay
npm ci --ignore-scripts
cp .env.example .env
```

Edit `.env` and set `PUBLIC_URL` to the address people will use, such as `https://pay.yourshop.in`.
Then create your business and your login:

```bash
npm run cli -- merchant:create --name "Your Shop" --vpa yourshop@okhdfcbank
npm run cli -- user:create --merchant mch_xxxxxxxx --email you@yourshop.in
```

The second command prints a password once. Start the server:

```bash
npm start
```

Open `PUBLIC_URL/login`, sign in, and create a test API key under **Developers**.

Put Noha Pay behind HTTPS before taking real payments. Caddy, nginx or a Cloudflare Tunnel all
work. If you use a proxy, set `TRUST_PROXY=1`.

### With Docker

```bash
cp .env.example .env    # then edit it
docker compose up -d
docker compose exec noha-pay node --disable-warning=ExperimentalWarning src/cli.ts merchant:create --name "Your Shop" --vpa yourshop@okhdfcbank
```

The database is one SQLite file in the `noha-data` volume. Back it up like any other file.

## Take a payment

Create an order from your server:

```bash
curl https://pay.yourshop.in/v1/orders \
  -H "Authorization: Bearer np_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49900,
    "reference": "order-1001",
    "customer": { "id": "cust_42", "name": "Ravi" },
    "return_url": "https://yourshop.in/thanks"
  }'
```

Amounts are in paise, so `49900` is ₹499. The `reference` is your own order number. Sending the
same one again returns the same order, so retries are safe. The answer includes:

- `checkout_url`: send the customer here.
- `upi_url`: a `upi://pay` link, if you'd rather show your own page.
- `pay_amount`: the exact amount the customer pays, which may be a few paise more than `amount`.

After paying, the customer is sent back to your `return_url` with `noha_order` and `noha_status`
added. Don't trust those query values alone; wait for the webhook or call `GET /v1/orders/:id`.

### Webhooks

Set your webhook URL under **Developers**. Each request carries a `Noha-Signature` header:

```
Noha-Signature: t=1795302876,v1=5f2b...
```

`v1` is the hex HMAC-SHA256 of `t + "." + body`, made with your signing secret. Reject anything
older than five minutes. A working receiver is in
[examples/webhook-receiver.mjs](examples/webhook-receiver.mjs).

### Noha Money

```bash
# Balance
curl https://pay.yourshop.in/v1/wallets/cust_42 -H "Authorization: Bearer np_live_..."

# Add cashback (send a unique Idempotency-Key so a retry doesn't count twice)
curl -X POST https://pay.yourshop.in/v1/wallets/cust_42/credit \
  -H "Authorization: Bearer np_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: cashback-order-1001" \
  -d '{"amount": 2500, "kind": "cashback", "note": "5% back on order 1001"}'

# Spend at checkout
curl -X POST https://pay.yourshop.in/v1/wallets/cust_42/spend \
  -H "Authorization: Bearer np_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: spend-order-1002" \
  -d '{"amount": 10000, "note": "Order 1002"}'
```

To let a customer add money, create an order with `"purpose": "wallet_topup"` and their
`customer.id`. When it's paid, the wallet is credited automatically. Test keys use separate test
wallets.

## Confirm payments automatically

### The Android alert app

Build it with Android Studio, or from the command line with the Android SDK installed:

```bash
cd android
./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

For a Play Store or long-term install, sign a release build with your own key
(`./gradlew assembleRelease`, then `apksigner`).

Install it on the phone that receives your bank's alerts. Then, in the dashboard, go to
**Alert sources → Pair a phone** and scan the code with the phone's camera. In the app, allow
notification access and tick your bank app and SMS app. Only notifications that look like money
coming in are sent, signed with a key only that phone has.

### Bank alert emails

Under **Alert sources → Email alerts** you'll find a private address. Anything that can POST a raw
email to it will work. The simplest route is a free Cloudflare Email Worker:
[examples/cloudflare-email-worker.js](examples/cloudflare-email-worker.js). Then forward your
bank's credit alerts to that Cloudflare address.

Emails are read only if they carry a valid DKIM signature from a known bank domain. If your bank
isn't on the built-in list, add its domain on the same page.

## Hosted Noha Pay

Don't want to run a server? We host Noha Pay for businesses in India, with backups, HTTPS and
updates looked after. Open an issue on this repository to ask about it.

## Develop

```bash
npm test            # 41 tests: alert reading, matching, wallets, webhooks, HTTP end to end
npm run typecheck
npm run dev         # restarts on changes
```

Node runs the TypeScript directly; there's no build step. The only runtime dependencies are
[`qrcode`](https://www.npmjs.com/package/qrcode) and [`mailauth`](https://www.npmjs.com/package/mailauth)
(for DKIM).

## Security

Found a problem? Please don't open a public issue. Use GitHub's private vulnerability reporting
on this repository instead, and we'll reply within a few days.

## License

Copyright © 2026 Asanoha LLP.

Noha Pay is free software under the [GNU Affero General Public License v3.0](LICENSE). You can
run, change and share it. If you run a changed version as a service for others, you must offer
them the source of your changes.

Noha Pay was written from scratch from [our own design notes](docs/design.md). It contains no
code from other payment gateway projects.
