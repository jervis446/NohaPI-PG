// Wires the routes together into one request handler. Kept apart from server.ts so tests can use it.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { apiRoutes } from "./http/api.ts";
import { checkoutRoutes } from "./http/checkout.ts";
import { clientIp, HttpError, redirect, Router, sendError, sendHtml, type Ctx } from "./http/core.ts";
import { dashboardRoutes, LoginNeeded } from "./http/dashboard.ts";
import { html, page } from "./http/views.ts";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const rel = normalize(pathname.replace(/^\/static\//, "")).replace(/^(\.\.[/\\])+/, "");
  const type = TYPES[extname(rel)];
  if (!type || rel.includes("..")) return false;
  try {
    const body = await readFile(join(PUBLIC, rel));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function createApp(db: DB, cfg: Config, clock: () => number = Date.now) {
  const router = new Router();
  apiRoutes(router);
  checkoutRoutes(router);
  dashboardRoutes(router);
  router.on("GET", "/", (ctx) => redirect(ctx.res, "/dashboard"));
  router.on("GET", "/healthz", (ctx) => { ctx.res.writeHead(200, { "Content-Type": "text/plain" }); ctx.res.end("ok"); });

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://local");
    const isApi = url.pathname.startsWith("/v1/") || url.pathname.endsWith("/status");
    try {
      if (url.pathname.startsWith("/static/") && (req.method === "GET" || req.method === "HEAD")) {
        if (await serveStatic(res, url.pathname)) return;
      }
      const found = router.find(req.method ?? "GET", url.pathname);
      if (found === null) throw new HttpError(404, "not_found", "Nothing here");
      if (found === "wrong_method") throw new HttpError(405, "method_not_allowed", "Method not allowed");
      const ctx: Ctx = { req, res, url, params: found.params, db, cfg, ip: clientIp(req), now: clock() };
      await found.handler(ctx);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof LoginNeeded) return redirect(res, "/login");
      const err = e instanceof HttpError ? e : null;
      if (!err) console.error(`${req.method} ${url.pathname}:`, e instanceof Error ? e.stack : e);
      const status = err?.status ?? 500;
      const message = err?.message ?? "Something went wrong on our side. Try again in a moment.";
      if (isApi) return sendError(res, status, err?.code ?? "server_error", message);
      sendHtml(res, status, page({
        title: "Noha Pay",
        bodyClass: "login-page",
        body: html`<main class="login"><img src="/static/logo.svg" alt="" width="48" height="48"><h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><p>${message}</p></main>`,
      }));
    }
  };
}
