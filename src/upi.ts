// UPI ids and payment links. The link format (upi://pay?pa=...&pn=...&am=...) is the public one
// every UPI app understands.

const VPA = /^[a-z0-9][a-z0-9._-]{1,254}@[a-z][a-z0-9.-]{1,63}$/i;

export function cleanVpa(raw: string): string | null {
  const vpa = raw.trim().toLowerCase();
  return VPA.test(vpa) ? vpa : null;
}

/** Paise to "499.01". */
export function rupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Paise to "₹1,499.01" with Indian digit grouping. */
export function inr(paise: number): string {
  const [whole, frac] = rupees(Math.abs(paise)).split(".");
  const w = whole!;
  const grouped = w.length <= 3 ? w : `${w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${w.slice(-3)}`;
  return `${paise < 0 ? "-" : ""}₹${grouped}.${frac}`;
}

/** "1,499.50" or "1499.5" to 149950 paise, or null if it isn't a plain amount. */
export function parsePaise(text: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.replace(/,/g, "").trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export interface UpiLink {
  vpa: string;
  payeeName: string;
  paise: number;
  note: string;
  ref: string;
}

export function upiUrl(l: UpiLink): string {
  const q = new URLSearchParams({
    pa: l.vpa,
    pn: l.payeeName.slice(0, 50),
    am: rupees(l.paise),
    cu: "INR",
    tn: l.note.slice(0, 50),
    tr: l.ref.slice(0, 35),
  });
  // UPI apps expect %20 for spaces, not "+".
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}
