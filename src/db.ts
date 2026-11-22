import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

// Each entry runs once, in order. Add new steps at the end; never edit a step that has shipped.
const STEPS: string[] = [
  `
  create table merchants (
    id text primary key,
    name text not null,
    vpa text not null,
    payee_name text not null,
    order_minutes integer,
    webhook_url text,
    webhook_secret text not null,
    email_token text not null unique,
    extra_bank_domains text not null default '[]',
    created_at integer not null
  );

  create table users (
    id text primary key,
    merchant_id text not null references merchants(id),
    email text not null unique collate nocase,
    password_hash text not null,
    created_at integer not null
  );

  create table sessions (
    token_hash text primary key,
    user_id text not null references users(id) on delete cascade,
    csrf text not null,
    expires_at integer not null
  );

  create table api_keys (
    id text primary key,
    merchant_id text not null references merchants(id),
    name text not null,
    mode text not null check (mode in ('live', 'test')),
    prefix text not null,
    key_hash text not null unique,
    created_at integer not null,
    last_used_at integer,
    revoked_at integer
  );

  create table orders (
    id text primary key,
    merchant_id text not null references merchants(id),
    mode text not null check (mode in ('live', 'test')),
    reference text not null,
    purpose text not null check (purpose in ('payment', 'wallet_topup')),
    amount integer not null check (amount > 0),
    pay_amount integer not null check (pay_amount >= amount),
    customer_id text,
    customer_name text,
    customer_email text,
    customer_phone text,
    notes text,
    return_url text,
    status text not null check (status in ('created', 'claimed', 'paid', 'declined', 'expired', 'refunded')),
    utr text,
    paid_via text check (paid_via in ('alert', 'utr_and_alert', 'merchant', 'test')),
    alert_id text,
    created_at integer not null,
    expires_at integer not null,
    claimed_at integer,
    paid_at integer,
    closed_at integer,
    unique (merchant_id, mode, reference)
  );
  create index orders_open on orders (merchant_id, mode, pay_amount, status);
  create index orders_recent on orders (merchant_id, created_at desc);

  create table devices (
    id text primary key,
    merchant_id text not null references merchants(id),
    name text not null,
    secret text not null,
    created_at integer not null,
    last_seen_at integer,
    revoked_at integer
  );

  create table alerts (
    id text primary key,
    merchant_id text not null references merchants(id),
    source text not null check (source in ('device', 'email')),
    device_id text,
    amount integer not null,
    utr text,
    payer_vpa text,
    received_at integer not null,
    text text,
    status text not null check (status in ('matched', 'unmatched', 'dismissed')),
    reason text,
    order_id text,
    created_at integer not null
  );
  create unique index alerts_utr on alerts (merchant_id, utr) where utr is not null;
  create index alerts_recent on alerts (merchant_id, status, received_at desc);

  create table webhooks (
    id text primary key,
    merchant_id text not null references merchants(id),
    type text not null,
    body text not null,
    status text not null check (status in ('pending', 'delivered', 'failed')),
    attempts integer not null default 0,
    next_attempt_at integer,
    last_code integer,
    last_error text,
    created_at integer not null,
    delivered_at integer
  );
  create index webhooks_due on webhooks (status, next_attempt_at);

  create table wallet_entries (
    id text primary key,
    merchant_id text not null references merchants(id),
    customer_id text not null,
    kind text not null check (kind in ('topup', 'cashback', 'spend', 'refund', 'adjust')),
    amount integer not null check (amount <> 0),
    balance_after integer not null check (balance_after >= 0),
    order_id text,
    note text,
    idem_key text not null,
    created_at integer not null,
    unique (merchant_id, idem_key)
  );
  create index wallet_by_customer on wallet_entries (merchant_id, customer_id, created_at desc);
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  db.exec("create table if not exists schema_steps (step integer primary key, applied_at integer not null)");
  const done = new Set(
    (db.prepare("select step from schema_steps").all() as { step: number }[]).map((r) => r.step),
  );
  STEPS.forEach((sql, i) => {
    if (done.has(i)) return;
    tx(db, () => {
      db.exec(sql);
      db.prepare("insert into schema_steps (step, applied_at) values (?, ?)").run(i, Date.now());
    });
  });
  return db;
}

/**
 * Runs fn inside a transaction. node:sqlite is synchronous, so nothing else runs in between.
 * Called inside another transaction, it simply joins it.
 */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}
