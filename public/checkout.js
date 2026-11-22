// Checkout page: counts down, and checks every few seconds whether the payment has arrived.
(function () {
  const root = document.querySelector(".checkout");
  if (!root) return;
  const id = root.dataset.order;
  const expires = Number(root.dataset.expires);
  const timer = document.getElementById("timer");
  const statusText = document.getElementById("status-text");
  let status = root.dataset.status;

  function showTime() {
    if (!timer) return;
    const left = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, "0");
    timer.textContent = left > 0 ? `Time left to pay: ${m}:${s}` : "Time's up. If you already paid, enter your UTR below.";
  }

  async function check() {
    try {
      const res = await fetch(`/pay/${encodeURIComponent(id)}/status`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === status) return;
      status = data.status;
      if (data.status === "paid" && data.return_url) {
        window.location.assign(data.return_url);
        return;
      }
      // Anything else changed: reload so the page shows the right state.
      window.location.reload();
    } catch {
      // Offline for a moment; try again on the next tick.
    }
  }

  if (status === "created" || status === "claimed") {
    showTime();
    setInterval(showTime, 1000);
    setInterval(check, 4000);
  }
  if (statusText && !statusText.textContent) statusText.hidden = true;
})();
