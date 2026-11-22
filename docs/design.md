# Noha Pay design notes

These notes are the source for the code in this repository. They were written from our own needs
(People Pitchers, Kosmik, Wearday and the Asanoha shop) and from public material: the UPI deep-link
format that every UPI app accepts, and the credit alerts Indian banks send by SMS, app notification
and email. No code from any other payment project was read or copied while writing Noha Pay.

## What it is

Noha Pay lets a business take UPI payments straight into its own bank account. The customer scans a
QR code or taps a link, pays from any UPI app, and the money lands in the merchant's account. Noha Pay
never holds the money. Its job is to work out which order a payment belongs to, tell the merchant's
server, and keep a record.

Noha Money is a store wallet that sits next to it. A customer can top it up, earn cashback, and spend
it on the same merchant's goods. It can't be withdrawn as cash or sent to anyone else.

## Who uses it

- **Operator:** whoever runs the server. That's us for the hosted version, or a business that
  self-hosts. The operator creates merchants from the command line.
- **Merchant:** a business with a UPI ID. It gets a dashboard, API keys and webhooks.
- **Customer:** the person paying. They see only the checkout page.

One server can host many merchants. Every table row belongs to one merchant, and every query filters
by merchant.

## The hard problem: which order was that payment for?

A UPI payment to a plain UPI ID doesn't come back to us. We learn about it in one of three ways:

1. **The customer tells us the UTR.** The UTR is the 12-digit reference every UPI app shows after a
   payment. A typed UTR is a claim, not proof.
2. **The merchant's phone sees the bank alert.** A small Android app reads the bank's credit
   notification or SMS and sends it to Noha Pay, signed with a key only that phone has.
3. **The bank's email alert arrives.** The merchant forwards credit alerts to a private address. We
   accept an email only if its DKIM signature is valid and was made by a bank domain on the allowed list.

Alerts carry an amount and usually a UTR, but never our order number. So we make the amount itself
unique: while an order is open, no other open order for the same merchant asks for the exact same
amount in paise. If a ₹499.00 order is already waiting, the next one asks for ₹499.01, then ₹499.02,
up to ₹499.99. The checkout page shows the exact figure in large type, and the UPI link pre-fills it.
If 100 orders at the same price are open at once, the next one is refused until one closes.

An order is confirmed when:

- a credit alert arrives whose amount equals the order's exact amount, the alert time falls within the
  order's open window (plus a grace period for slow alerts), its UTR hasn't been used before, and
  exactly one open order matches; or
- the customer's UTR matches a credit alert we already hold with the same amount; or
- the merchant looks at the payment in their bank app and approves it in the dashboard.

Anything doubtful waits for a person. If an alert matches two orders, matches none, or has a UTR we've
already used, it goes to the dashboard's unmatched list. Nothing is auto-confirmed on a guess.

## Order life

```
created ──(customer types UTR)──> claimed ──(alert or merchant approves)──> paid
   │                                 │
   │                                 └──(merchant declines)──> declined
   ├──(matching alert)──> paid
   └──(time runs out, default 15 min)──> expired
```

A late alert can still mark an expired order paid within the grace period (default 30 minutes), because
the money did arrive. A paid order never changes again. Refunds happen in the merchant's own UPI app;
the dashboard can mark an order refunded for the record.

Each change sends a webhook: `order.claimed`, `order.paid`, `order.declined`, `order.expired`,
`order.refunded`. A merchant that wants to grant access the moment a UTR is typed (as Kosmik does) acts
on `order.claimed`, and takes that risk knowingly.

## Merchant API

- Keys look like `np_live_` or `np_test_` plus 40 random characters. We store only a SHA-256 hash and
  show the key once.
- `POST /v1/orders` creates an order: `amount` in paise, `reference` (the merchant's own id, unique per
  merchant, so retries are safe), optional `customer` (`id`, `name`, `email`, `phone`), `purpose`
  (`payment` or `wallet_topup`), `return_url`, `notes`, and `expires_in` in seconds (2 to 60 minutes).
  It returns the order with its `checkout_url`, `upi_url` and `pay_amount`.
- `GET /v1/orders/:id` and `GET /v1/orders?reference=` read an order. `GET /v1/orders` lists the newest.
- Test-mode keys create test orders. Those can be marked paid from the dashboard with one button, so a
  merchant can build their integration without moving money.

## Webhooks

The body is JSON: `{id, type, created_at, data: {order}}`. The header is
`Noha-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body" with the merchant's webhook secret>`.
Merchants should reject signatures more than 5 minutes old. Failed deliveries are retried after 1, 5
and 30 minutes, then 2 and 12 hours, then marked failed. They can be sent again from the dashboard.

## Bank alert reading

The parser looks for:

- a credit word (credited, received, deposited) and no debit word (debited, spent, withdrawn, sent);
- an amount after `Rs`, `INR` or `₹`;
- a 12-digit reference after UTR, RRN, Ref No or UPI Ref, or else a lone 12-digit number;
- the sender's UPI ID if one is shown.

Alerts that look like OTPs, debits or balance updates are dropped. The raw text is kept for 30 days
so a merchant can check what was read, then deleted.

## The Android alert app

The app listens to notifications from apps the merchant ticks (their bank app, their SMS app). When a
notification looks like a credit alert, it sends the title and text to `POST /v1/device/alerts`.
Each request carries the device id, a timestamp and an HMAC of the body made with the device's
secret. Pairing happens once: the dashboard shows a pairing code, and the merchant pastes or scans it
into the app. A lost phone is unpaired from the dashboard. The app has no access to SMS permissions;
it reads only notifications the merchant allows in Android settings.

## Email alerts

Each merchant gets a private ingest URL. Anything that can POST a raw email can use it: a Cloudflare
Email Worker, a Mailgun or Postmark route, or a short script. We check DKIM ourselves and accept only
signatures from the bank domains the operator lists (and any the merchant adds). Without DKIM, the
email is ignored, because a forwarded email with a faked "From" line would otherwise mark orders paid.

## Noha Money

- One wallet per customer per merchant. A wallet is a list of entries; the balance is their sum.
- Entry kinds: `topup` (from a paid `wallet_topup` order), `cashback`, `spend`, `refund` (a spend
  returned) and `adjust` (a merchant correction with a note).
- Spends never take the balance below zero. Every write carries an idempotency key, so a retried
  request doesn't count twice.
- No API exists to withdraw, pay out or move money between customers. That keeps it a closed-loop
  wallet, which in India doesn't need RBI authorisation. A wallet that could be spent at other
  merchants or cashed out would.
- `wallet.updated` webhooks report each change.

## Dashboard

Server-rendered pages with no client framework. Pages: orders (filter by status, approve or decline a
claim, mark refunded), unmatched alerts (attach one to an order), wallets (look up a customer, add
cashback or an adjustment), devices, email alerts, API keys, webhooks with the delivery log, and
settings (UPI ID, display name, order timeout). Merchant users sign in with email and password
(scrypt-hashed). Sessions are random tokens in an HttpOnly cookie, and every form carries a CSRF token.

## Storage and running

SQLite through Node's built-in `node:sqlite`, in WAL mode, one file. That's plenty for thousands of
orders a day and keeps self-hosting to one process and one file to back up. Node 24 runs the
TypeScript directly, with no build step. A Dockerfile is included.

## Rules we won't bend

- Never hold or move a customer's money.
- A typed UTR alone never marks an order paid.
- Never confirm on a guess: ambiguous alerts wait for a person.
- Never log API keys, webhook secrets, device secrets or full alert text in server logs.
- Say plainly in the README that Noha Pay is not a licensed payment aggregator and isn't approved by
  NPCI, RBI or any bank, and that merchants should check their bank's terms for business use of
  their UPI ID.
