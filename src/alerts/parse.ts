// Reads a bank's credit alert (SMS, app notification or email text) into amount, UTR and payer.
// Banks word these differently, so the rules are deliberately loose about layout and strict about
// meaning: a credit word must be present, no debit word may be, and the amount must be explicit.

import { parsePaise } from "../upi.ts";

export interface ParsedAlert {
  amount: number;
  utr: string | null;
  payerVpa: string | null;
}

export type ParseResult = { ok: true; alert: ParsedAlert } | { ok: false; reason: string };

const CREDIT = /\b(credited|received|deposited|has been added|cr\.?)\b/i;
const DEBIT = /\b(debited|spent|withdrawn|sent|paid to|purchase|dr\.?|debit)\b/i;
// Messages that mention money arriving but aren't a customer paying you: OTPs, mandates, card-bill
// payments, loan or EMI receipts, refunds, reversals and cashback.
const NOISE = /\b(otp|one time password|verification code|do not share|mandate|autopay|request(?:ed)? money|collect request|credit card|card bill|towards (?:your )?card|card (?:no|ending)|loan|emi|refund(?:ed)?|revers(?:al|ed)|cashback)\b/i;
const AMOUNT = /(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
const LABELLED_REF = /(?:utr|rrn|upi\s*ref(?:erence)?|ref(?:erence)?|txn|transaction)\s*(?:no\.?|number|id)?\s*[:.#-]?\s*(\d{12})\b/i;
const LONE_12 = /(?<![\d])(\d{12})(?![\d])/g;
const VPA = /\b([a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,30})\b/i;
// "Avl Bal Rs 5,000" and similar: amounts after these words are balances, not the payment.
const BALANCE_BEFORE = /(?:bal(?:ance)?|avl\.?|available|limit)\s*(?:is|:)?\s*$/i;

export function parseAlert(raw: string): ParseResult {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (NOISE.test(text)) return { ok: false, reason: "not a payment alert" };
  if (!CREDIT.test(text)) return { ok: false, reason: "no credit word" };
  if (DEBIT.test(text)) return { ok: false, reason: "looks like a debit" };

  let amount: number | null = null;
  for (const m of text.matchAll(AMOUNT)) {
    const before = text.slice(Math.max(0, m.index - 25), m.index);
    if (BALANCE_BEFORE.test(before)) continue;
    amount = parsePaise(m[1]!);
    if (amount) break;
  }
  if (!amount) return { ok: false, reason: "no amount" };

  let utr = LABELLED_REF.exec(text)?.[1] ?? null;
  if (!utr) {
    const lone = [...text.matchAll(LONE_12)].map((m) => m[1]!);
    // Only trust an unlabelled number when there is exactly one; two could be an account and a ref.
    if (lone.length === 1) utr = lone[0]!;
  }

  const vpa = VPA.exec(text)?.[1]?.toLowerCase() ?? null;
  return { ok: true, alert: { amount, utr, payerVpa: vpa } };
}
