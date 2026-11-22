// Starts Noha Pay: the web server plus the minute-by-minute jobs.

import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { forgetOldAlertText } from "./alerts/match.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { limiter } from "./http/core.ts";
import { expireDue } from "./orders.ts";
import { deliverDue } from "./webhooks.ts";

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const server = createServer(createApp(db, cfg));
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    expireDue(db, cfg);
    await deliverDue(db);
  } catch (e) {
    console.error("background job failed:", e instanceof Error ? e.message : e);
  } finally {
    busy = false;
  }
}

const every15s = setInterval(tick, 15_000);
const hourly = setInterval(() => {
  forgetOldAlertText(db, cfg);
  limiter.sweep();
}, 3600_000);

server.listen(cfg.port, cfg.host, () => {
  console.log(`Noha Pay is running at ${cfg.publicUrl} (listening on ${cfg.host}:${cfg.port})`);
});

function stop() {
  clearInterval(every15s);
  clearInterval(hourly);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
