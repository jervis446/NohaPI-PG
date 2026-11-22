// Bank alert emails. An email counts only if it carries a valid DKIM signature from a bank domain
// we trust, aligned with its From address. A forwarded or hand-written email can't pass that.

import { dkimVerify } from "mailauth";

export type EmailCheck =
  | { ok: true; text: string; domain: string; date: number | null }
  | { ok: false; reason: string };

const domainOk = (domain: string, allowed: string[]) =>
  allowed.some((a) => domain === a || domain.endsWith(`.${a}`));

export async function checkBankEmail(raw: Buffer, allowed: string[], verify = dkimVerify): Promise<EmailCheck> {
  if (raw.length > 512 * 1024) return { ok: false, reason: "email is too large" };
  let results;
  try {
    results = (await verify(raw)).results ?? [];
  } catch {
    return { ok: false, reason: "couldn't read the DKIM signature" };
  }
  const good = results.find((r) => {
    const d = r.signingDomain?.toLowerCase();
    return r.status?.result === "pass" && !!r.status?.aligned && !!d && domainOk(d, allowed);
  });
  if (!good) return { ok: false, reason: "no passing DKIM signature from an allowed bank domain" };

  const { headers, body } = splitMessage(raw.toString("latin1"));
  const dateHeader = headerValue(headers, "date");
  const date = dateHeader ? Date.parse(dateHeader) : NaN;
  const subject = decodeWords(headerValue(headers, "subject") ?? "");
  const text = `${subject}\n${bodyText(headers, body)}`.trim();
  return { ok: true, text, domain: good.signingDomain!.toLowerCase(), date: Number.isFinite(date) ? date : null };
}

// A small MIME reader: enough for bank alerts, which are short text or HTML parts.

function splitMessage(s: string): { headers: string; body: string } {
  const at = s.search(/\r?\n\r?\n/);
  if (at < 0) return { headers: s, body: "" };
  return { headers: s.slice(0, at), body: s.slice(at).replace(/^\r?\n\r?\n/, "") };
}

function headerValue(headers: string, name: string): string | null {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(unfolded);
  return m ? m[1]!.trim() : null;
}

function param(value: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function decodeTransfer(body: string, encoding: string | null, charset: string | null): string {
  const enc = (encoding ?? "").toLowerCase();
  let bytes: Buffer;
  if (enc === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") {
    const soft = body.replace(/=\r?\n/g, "");
    const parts: number[] = [];
    for (let i = 0; i < soft.length; i++) {
      const hex = soft.slice(i + 1, i + 3);
      if (soft[i] === "=" && /^[0-9a-f]{2}$/i.test(hex)) { parts.push(parseInt(hex, 16)); i += 2; }
      else parts.push(soft.charCodeAt(i) & 0xff);
    }
    bytes = Buffer.from(parts);
  } else bytes = Buffer.from(body, "latin1");
  const cs = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#8377;|&#x20b9;/gi, "₹").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ");
}

function bodyText(headers: string, body: string, depth = 0): string {
  const type = headerValue(headers, "content-type") ?? "text/plain";
  const encoding = headerValue(headers, "content-transfer-encoding");
  if (/^multipart\//i.test(type) && depth < 5) {
    const boundary = param(type, "boundary");
    if (!boundary) return "";
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--"));
    const read = parts.map((p) => splitMessage(p.replace(/^\r?\n/, "")));
    const plain = read.find((p) => /^text\/plain/i.test(headerValue(p.headers, "content-type") ?? "text/plain"));
    const pick = plain ?? read.find((p) => /^(text\/html|multipart\/)/i.test(headerValue(p.headers, "content-type") ?? ""));
    return pick ? bodyText(pick.headers, pick.body, depth + 1) : "";
  }
  const decoded = decodeTransfer(body, encoding, param(type, "charset"));
  return /^text\/html/i.test(type) ? htmlToText(decoded) : decoded;
}

/** Decodes =?utf-8?B?...?= and =?utf-8?Q?...?= words in headers. */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs: string, kind: string, data: string) => {
    if (kind.toLowerCase() === "b") return decodeTransfer(data, "base64", cs);
    return decodeTransfer(data.replace(/_/g, " "), "quoted-printable", cs);
  });
}
