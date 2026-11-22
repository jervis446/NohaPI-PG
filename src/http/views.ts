// HTML with escaping by default. Values interpolated into html`` are escaped unless they are
// themselves html`` results.

export class Safe {
  value: string;
  constructor(value: string) { this.value = value; }
  toString() { return this.value; }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

type Value = Safe | string | number | null | undefined | false | Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (v instanceof Safe) return v.value;
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Safe {
  let out = strings[0]!;
  values.forEach((v, i) => { out += render(v) + strings[i + 1]!; });
  return new Safe(out);
}

export const raw = (s: string) => new Safe(s);

export function page(opts: { title: string; body: Safe; bodyClass?: string; scripts?: string[] }): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.title}</title>
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
</head>
<body class="${opts.bodyClass ?? ""}">
${opts.body}
${(opts.scripts ?? []).map((s) => html`<script src="${s}" defer></script>`)}
</body>
</html>`.value;
}

export const when = (cond: unknown, v: () => Safe) => (cond ? v() : "");

export function dateTime(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
