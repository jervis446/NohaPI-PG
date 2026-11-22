// A minimal webhook receiver for your own server (Node 18+). Run: WEBHOOK_SECRET=whsec_... node webhook-receiver.mjs
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const secret = process.env.WEBHOOK_SECRET;

function verify(body, header) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!parts.t || !parts.v1 || age > 300) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest("hex");
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!verify(body, req.headers["noha-signature"] ?? "")) {
    res.writeHead(400).end("bad signature");
    return;
  }
  const event = JSON.parse(body);
  if (event.type === "order.paid") {
    const order = event.data.order;
    console.log(`Paid: ${order.reference}, ₹${order.amount / 100}, UTR ${order.utr}`);
    // Mark the order paid in your own database here. Events can arrive twice: use event.id to skip repeats.
  }
  res.writeHead(200).end("ok");
}).listen(3000, () => console.log("Listening on http://localhost:3000"));
