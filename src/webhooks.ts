// Signed webhooks with retries. Events are written in the same transaction as the change they
// describe, so a crash can delay a webhook but never lose one.

import type { DB } from "./db.ts";
import { lookup } from "node:dns/promises";
import { lookup as lookupCb, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { hmacHex, newId, sameText } from "./crypto.ts";

// Minutes to wait after each failed attempt. After the last one, the webhook is marked failed.
export const RETRY_MINUTES = [1, 5, 30, 120, 720];

export interface Merchant {
  id: string;
  webhook_url: string | null;
  webhook_secret: string;
}

export function enqueue(db: DB, merchantId: string, type: string, data: unknown, now = Date.now()): void {
  const id = newId("evt");
  const body = JSON.stringify({ id, type, created_at: new Date(now).toISOString(), data });
  db.prepare(
    `insert into webhooks (id, merchant_id, type, body, status, next_attempt_at, created_at)
     values (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, merchantId, type, body, now, now);
}

export function signature(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacHex(secret, `${unixSeconds}.${body}`)}`;
}

/** For merchants' servers: checks a Noha-Signature header. Exported so the README example is real. */
export function verifySignature(secret: string, body: string, header: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  return sameText(hmacHex(secret, `${t}.${body}`), parts.v1);
}

// Hosted servers must not let a merchant point webhooks at the server's own network.
const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4mapped) return PRIVATE.check(v4mapped, "ipv4");
  const family = isIP(ip);
  return family === 0 ? true : PRIVATE.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Null if the URL is fine to call, else why not. */
export async function webhookProblem(url: string, allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOKS === "1"): Promise<string | null> {
  let u: URL;
  try { u = new URL(url); } catch { return "Not a valid URL"; }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) return "Webhook URLs must start with https://";
  if (u.username || u.password) return "Leave the user name and password out of the URL";
  if (allowPrivate) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) return "That host name doesn't resolve";
  return addrs.some(isPrivateAddress) ? "Webhook URLs must point to a public address" : null;
}

/** Rejects private addresses at connect time too, so a host can't pass the check and then change its DNS. */
function guardedLookup(hostname: string, opts: LookupOptions, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
  lookupCb(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as LookupAddress[];
    if (list.some((a) => isPrivateAddress(a.address))) return cb(new Error("Webhook URLs must point to a public address"), "");
    if (opts.all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  });
}

export type Sender = (url: string, headers: Record<string, string>, body: string) => Promise<number>;

/** POSTs a webhook and returns the HTTP status. Doesn't follow redirects. */
export const postWebhook: Sender = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOKS === "1";
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      timeout: 10_000,
      ...(allowPrivate ? {} : { lookup: guardedLookup }),
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("Timed out after 10 seconds")));
    req.on("error", reject);
    req.end(body);
  });

interface Due {
  id: string;
  body: string;
  attempts: number;
  webhook_url: string | null;
  webhook_secret: string;
}

/** Sends every webhook that is due. Returns how many were attempted. */
export async function deliverDue(db: DB, send: Sender = postWebhook, now = Date.now()): Promise<number> {
  const due = db.prepare(
    `select w.id, w.body, w.attempts, m.webhook_url, m.webhook_secret
       from webhooks w join merchants m on m.id = w.merchant_id
      where w.status = 'pending' and w.next_attempt_at <= ?
      order by w.next_attempt_at limit 50`,
  ).all(now) as unknown as Due[];

  for (const w of due) {
    if (!w.webhook_url) {
      // No URL set: keep the event in the log as delivered-nowhere so it doesn't retry forever.
      db.prepare("update webhooks set status = 'failed', last_error = 'No webhook URL set' where id = ?").run(w.id);
      continue;
    }
    let code: number | null = null;
    let error: string | null = await webhookProblem(w.webhook_url);
    if (!error) try {
      code = await send(w.webhook_url, {
        "Content-Type": "application/json",
        "User-Agent": "NohaPay-Webhooks/1",
        "Noha-Signature": signature(w.webhook_secret, w.body, Math.floor(now / 1000)),
      }, w.body);
      if (code < 200 || code >= 300) error = `HTTP ${code}`;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : "request failed";
    }
    const attempts = w.attempts + 1;
    if (!error) {
      db.prepare("update webhooks set status = 'delivered', attempts = ?, last_code = ?, last_error = null, delivered_at = ? where id = ?")
        .run(attempts, code, now, w.id);
    } else {
      const wait = RETRY_MINUTES[attempts - 1];
      db.prepare("update webhooks set status = ?, attempts = ?, last_code = ?, last_error = ?, next_attempt_at = ? where id = ?")
        .run(wait === undefined ? "failed" : "pending", attempts, code, error, wait === undefined ? null : now + wait * 60_000, w.id);
    }
  }
  return due.length;
}

/** Puts a failed or delivered webhook back in the queue, from the dashboard. */
export function resend(db: DB, merchantId: string, id: string, now = Date.now()): boolean {
  const r = db.prepare("update webhooks set status = 'pending', next_attempt_at = ? where id = ? and merchant_id = ?").run(now, id, merchantId);
  return r.changes === 1;
}
