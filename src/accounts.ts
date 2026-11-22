// Merchants, their users and sessions, API keys and paired phones.

import { checkPassword, hashPassword, newId, randomText, sha256 } from "./crypto.ts";
import { tx, type DB } from "./db.ts";
import type { Mode, MerchantRow } from "./orders.ts";
import { cleanVpa } from "./upi.ts";

const SESSION_DAYS = 14;

export function createMerchant(db: DB, input: { name: string; vpa: string; payeeName?: string }, now = Date.now()): MerchantRow {
  const name = input.name.trim().slice(0, 100);
  const vpa = cleanVpa(input.vpa);
  if (!name) throw new Error("A merchant needs a name");
  if (!vpa) throw new Error(`"${input.vpa}" isn't a UPI id. It looks like name@bank.`);
  const id = newId("mch");
  db.prepare(
    `insert into merchants (id, name, vpa, payee_name, webhook_secret, email_token, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, vpa, (input.payeeName ?? name).trim().slice(0, 50), `whsec_${randomText(32)}`, randomText(32), now);
  return db.prepare("select * from merchants where id = ?").get(id) as unknown as MerchantRow;
}

export async function createUser(db: DB, merchantId: string, email: string, password: string, now = Date.now()): Promise<string> {
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("That email address doesn't look right");
  if (password.length < 10) throw new Error("Use a password of at least 10 characters");
  const id = newId("usr");
  db.prepare("insert into users (id, merchant_id, email, password_hash, created_at) values (?, ?, ?, ?, ?)")
    .run(id, merchantId, clean, await hashPassword(password), now);
  return id;
}

export async function setPassword(db: DB, email: string, password: string): Promise<boolean> {
  if (password.length < 10) throw new Error("Use a password of at least 10 characters");
  const r = db.prepare("update users set password_hash = ? where email = ?").run(await hashPassword(password), email.trim().toLowerCase());
  if (r.changes === 1) db.prepare("delete from sessions where user_id = (select id from users where email = ?)").run(email.trim().toLowerCase());
  return r.changes === 1;
}

// A real hash to compare against when the email is unknown, so both cases take the same time.
let decoy: Promise<string> | null = null;

export async function signIn(db: DB, email: string, password: string, now = Date.now()): Promise<{ token: string } | null> {
  const user = db.prepare("select id, password_hash from users where email = ?").get(email.trim().toLowerCase()) as
    | { id: string; password_hash: string } | undefined;
  decoy ??= hashPassword(randomText(16));
  const ok = await checkPassword(password, user?.password_hash ?? (await decoy));
  if (!user || !ok) return null;
  const token = randomText(40);
  db.prepare("insert into sessions (token_hash, user_id, csrf, expires_at) values (?, ?, ?, ?)")
    .run(sha256(token), user.id, randomText(32), now + SESSION_DAYS * 86400_000);
  db.prepare("delete from sessions where expires_at < ?").run(now);
  return { token };
}

export interface Session {
  userId: string;
  email: string;
  csrf: string;
  merchant: MerchantRow;
  tokenHash: string;
}

export function sessionFor(db: DB, token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const row = db.prepare(
    `select s.token_hash, s.csrf, s.expires_at, u.id as user_id, u.email, u.merchant_id
       from sessions s join users u on u.id = s.user_id where s.token_hash = ?`,
  ).get(sha256(token)) as { token_hash: string; csrf: string; expires_at: number; user_id: string; email: string; merchant_id: string } | undefined;
  if (!row || row.expires_at < now) return null;
  const merchant = db.prepare("select * from merchants where id = ?").get(row.merchant_id) as unknown as MerchantRow;
  return { userId: row.user_id, email: row.email, csrf: row.csrf, merchant, tokenHash: row.token_hash };
}

export const signOut = (db: DB, tokenHash: string) => db.prepare("delete from sessions where token_hash = ?").run(tokenHash);

// API keys: np_live_... or np_test_..., shown once, stored as a SHA-256 hash.

export interface KeyRow {
  id: string; merchant_id: string; name: string; mode: Mode; prefix: string;
  created_at: number; last_used_at: number | null; revoked_at: number | null;
}

export function createApiKey(db: DB, merchantId: string, name: string, mode: Mode, now = Date.now()): { key: string; row: KeyRow } {
  const active = (db.prepare("select count(*) as n from api_keys where merchant_id = ? and revoked_at is null").get(merchantId) as { n: number }).n;
  if (active >= 10) throw new Error("You can have 10 active keys. Revoke one first.");
  const key = `np_${mode}_${randomText(40)}`;
  const id = newId("key");
  db.prepare("insert into api_keys (id, merchant_id, name, mode, prefix, key_hash, created_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run(id, merchantId, name.trim().slice(0, 60) || "Key", mode, key.slice(0, 14), sha256(key), now);
  return { key, row: db.prepare("select * from api_keys where id = ?").get(id) as unknown as KeyRow };
}

export function keyOwner(db: DB, key: string, now = Date.now()): { merchant: MerchantRow; mode: Mode } | null {
  if (!/^np_(live|test)_[a-z0-9]{40}$/.test(key)) return null;
  const row = db.prepare("select id, merchant_id, mode, revoked_at from api_keys where key_hash = ?").get(sha256(key)) as
    | { id: string; merchant_id: string; mode: Mode; revoked_at: number | null } | undefined;
  if (!row || row.revoked_at) return null;
  db.prepare("update api_keys set last_used_at = ? where id = ?").run(now, row.id);
  return { merchant: db.prepare("select * from merchants where id = ?").get(row.merchant_id) as unknown as MerchantRow, mode: row.mode };
}

export const listKeys = (db: DB, merchantId: string) =>
  db.prepare("select * from api_keys where merchant_id = ? order by revoked_at is not null, created_at desc").all(merchantId) as unknown as KeyRow[];

export const revokeKey = (db: DB, merchantId: string, id: string, now = Date.now()) =>
  db.prepare("update api_keys set revoked_at = ? where id = ? and merchant_id = ? and revoked_at is null").run(now, id, merchantId).changes === 1;

// Phones running the alert app. The secret signs every alert the phone sends.

export interface DeviceRow {
  id: string; merchant_id: string; name: string; secret: string;
  created_at: number; last_seen_at: number | null; revoked_at: number | null;
}

export function createDevice(db: DB, merchantId: string, name: string, now = Date.now()): DeviceRow {
  const id = newId("dev");
  db.prepare("insert into devices (id, merchant_id, name, secret, created_at) values (?, ?, ?, ?, ?)")
    .run(id, merchantId, name.trim().slice(0, 60) || "Phone", randomText(40), now);
  return db.prepare("select * from devices where id = ?").get(id) as unknown as DeviceRow;
}

export const getDevice = (db: DB, id: string) => db.prepare("select * from devices where id = ?").get(id) as DeviceRow | undefined;

export const listDevices = (db: DB, merchantId: string) =>
  db.prepare("select * from devices where merchant_id = ? order by revoked_at is not null, created_at desc").all(merchantId) as unknown as DeviceRow[];

export const revokeDevice = (db: DB, merchantId: string, id: string, now = Date.now()) =>
  db.prepare("update devices set revoked_at = ? where id = ? and merchant_id = ? and revoked_at is null").run(now, id, merchantId).changes === 1;

/** The text the merchant pastes into the app (or scans as a QR code) to pair it. */
export function pairingCode(publicUrl: string, d: DeviceRow): string {
  return `nohapay://pair?server=${encodeURIComponent(publicUrl)}&device=${d.id}&secret=${d.secret}`;
}

export interface Settings { name?: string; payeeName?: string; vpa?: string; orderMinutes?: number | null; webhookUrl?: string | null; extraBankDomains?: string[] }

export function updateSettings(db: DB, merchantId: string, s: Settings): void {
  tx(db, () => {
    if (s.name !== undefined) {
      const name = s.name.trim().slice(0, 100);
      if (!name) throw new Error("The business name can't be empty");
      db.prepare("update merchants set name = ? where id = ?").run(name, merchantId);
    }
    if (s.payeeName !== undefined) db.prepare("update merchants set payee_name = ? where id = ?").run(s.payeeName.trim().slice(0, 50) || "Merchant", merchantId);
    if (s.vpa !== undefined) {
      const vpa = cleanVpa(s.vpa);
      if (!vpa) throw new Error("That isn't a UPI id. It looks like name@bank.");
      db.prepare("update merchants set vpa = ? where id = ?").run(vpa, merchantId);
    }
    if (s.orderMinutes !== undefined) {
      if (s.orderMinutes !== null && (!Number.isInteger(s.orderMinutes) || s.orderMinutes < 2 || s.orderMinutes > 60)) {
        throw new Error("Payment time must be between 2 and 60 minutes");
      }
      db.prepare("update merchants set order_minutes = ? where id = ?").run(s.orderMinutes, merchantId);
    }
    if (s.webhookUrl !== undefined) db.prepare("update merchants set webhook_url = ? where id = ?").run(s.webhookUrl || null, merchantId);
    if (s.extraBankDomains !== undefined) {
      const domains = s.extraBankDomains.map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).slice(0, 20);
      db.prepare("update merchants set extra_bank_domains = ? where id = ?").run(JSON.stringify(domains), merchantId);
    }
  });
}

export function rotateWebhookSecret(db: DB, merchantId: string): string {
  const secret = `whsec_${randomText(32)}`;
  db.prepare("update merchants set webhook_secret = ? where id = ?").run(secret, merchantId);
  return secret;
}

export function rotateEmailToken(db: DB, merchantId: string): string {
  const token = randomText(32);
  db.prepare("update merchants set email_token = ? where id = ?").run(token, merchantId);
  return token;
}
