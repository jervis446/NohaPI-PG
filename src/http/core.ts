// Small helpers over node:http: bodies, responses, cookies, routing and rate limits.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  db: DB;
  cfg: Config;
  ip: string;
  now: number;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, "json_required", "Send the body as JSON with Content-Type: application/json");
  try {
    const v = JSON.parse((await readBody(req)).toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid_json", "The body isn't valid JSON");
  }
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(req, 32 * 1024)).toString("utf8"));
}

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function sendHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP, ...headers });
  res.end(body);
}

export function redirect(res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { ...BASE_HEADERS, Location: to, ...headers });
  res.end();
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    try {
      out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      // A malformed cookie set by something else: ignore it rather than fail the page.
    }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAgeSec?: number; secure: boolean }): string {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure) bits.push("Secure");
  if (opts.maxAgeSec !== undefined) bits.push(`Max-Age=${opts.maxAgeSec}`);
  return bits.join("; ");
}

export function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === "1") {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

// Routing: "GET /v1/orders/:id" style patterns.

interface Route { method: string; parts: string[]; handler: Handler }

export class Router {
  routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }

  find(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | "wrong_method" | null {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(":")) {
          try { params[p.slice(1)] = decodeURIComponent(parts[i]!); } catch { return false; }
          return true;
        }
        return p === parts[i];
      });
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method || (r.method === "GET" && method === "HEAD")) return { handler: r.handler, params };
    }
    return pathMatched ? "wrong_method" : null;
  }
}

/** Fixed-window counters kept in memory. Good enough for one process; resets on restart. */
export class Limiter {
  hits = new Map<string, { count: number; until: number }>();

  /** True if this key is still under `max` hits in the current window. */
  take(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.until <= now) {
      this.hits.set(key, { count: 1, until: now + windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    h.count++;
    return h.count <= max;
  }

  sweep(now = Date.now()): void {
    for (const [k, h] of this.hits) if (h.until <= now) this.hits.delete(k);
  }
}

export const limiter = new Limiter();
