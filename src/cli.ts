// Command line for whoever runs the server: create merchants, users and keys.
//   npm run cli -- merchant:create --name "Asha Stores" --vpa asha@okhdfcbank
//   npm run cli -- user:create --merchant mch_... --email owner@example.com
//   npm run cli -- user:password --email owner@example.com
//   npm run cli -- key:create --merchant mch_... --mode test
//   npm run cli -- merchant:list

import { parseArgs } from "node:util";
import { createApiKey, createMerchant, createUser, setPassword } from "./accounts.ts";
import { loadConfig } from "./config.ts";
import { randomText } from "./crypto.ts";
import { openDb } from "./db.ts";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    name: { type: "string" }, vpa: { type: "string" }, payee: { type: "string" },
    merchant: { type: "string" }, email: { type: "string" }, mode: { type: "string" },
  },
});

const cfg = loadConfig();
const db = openDb(cfg.dbPath);

function need(v: string | undefined, flag: string): string {
  if (!v) {
    console.error(`Missing --${flag}`);
    process.exit(1);
  }
  return v;
}

// Password from NOHA_PASSWORD if set, otherwise a random one printed once.
function password(): { value: string; generated: boolean } {
  const fromEnv = process.env.NOHA_PASSWORD;
  return fromEnv ? { value: fromEnv, generated: false } : { value: randomText(16), generated: true };
}

try {
  switch (command) {
    case "merchant:create": {
      const m = createMerchant(db, { name: need(values.name, "name"), vpa: need(values.vpa, "vpa"), payeeName: values.payee });
      console.log(`Created merchant ${m.name}: ${m.id}`);
      console.log(`Next: npm run cli -- user:create --merchant ${m.id} --email you@example.com`);
      break;
    }
    case "merchant:list": {
      const rows = db.prepare("select id, name, vpa from merchants order by created_at").all() as { id: string; name: string; vpa: string }[];
      for (const m of rows) console.log(`${m.id}  ${m.name}  ${m.vpa}`);
      if (rows.length === 0) console.log("No merchants yet.");
      break;
    }
    case "user:create": {
      const pw = password();
      await createUser(db, need(values.merchant, "merchant"), need(values.email, "email"), pw.value);
      console.log(`Created ${values.email}. Sign in at ${cfg.publicUrl}/login`);
      if (pw.generated) console.log(`Password (shown once): ${pw.value}`);
      break;
    }
    case "user:password": {
      const pw = password();
      if (!(await setPassword(db, need(values.email, "email"), pw.value))) throw new Error("No user with that email");
      console.log(`Password changed for ${values.email}. Their other sessions were signed out.`);
      if (pw.generated) console.log(`New password (shown once): ${pw.value}`);
      break;
    }
    case "key:create": {
      const mode = values.mode === "live" ? "live" : "test";
      const { key } = createApiKey(db, need(values.merchant, "merchant"), "Created from the command line", mode);
      console.log(`${mode} key (shown once): ${key}`);
      break;
    }
    default:
      console.log("Commands: merchant:create, merchant:list, user:create, user:password, key:create");
      console.log("See the top of src/cli.ts for examples.");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
