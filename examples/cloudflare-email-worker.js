// A Cloudflare Email Worker that passes bank alert emails to Noha Pay, untouched.
//
// 1. In Cloudflare, turn on Email Routing for a domain you own and create an address such as
//    alerts@yourshop.in that sends to this Worker.
// 2. Set the Worker variable NOHA_INGEST_URL to the private address shown in your dashboard
//    under Alert sources -> Email alerts.
// 3. In your bank email inbox (Gmail, Outlook), forward the bank's credit alerts to alerts@yourshop.in.
//
// The raw message is sent as-is so the bank's DKIM signature can still be checked.

export default {
  async email(message, env) {
    const res = await fetch(env.NOHA_INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "message/rfc822" },
      body: message.raw,
    });
    if (!res.ok) message.setReject(`Noha Pay answered ${res.status}`);
  },
};
