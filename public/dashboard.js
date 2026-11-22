// Dashboard: ask before actions that can't be undone.
(function () {
  const confirmText = {
    approve: "Only approve if you can see this money in your bank app. Mark it paid?",
    decline: "Decline this payment? The customer will be told it wasn't found.",
    revoke: "Revoke this? Anything using it stops working straight away.",
    rotate: "The old address stops working straight away. Continue?",
    secret: "The old signing secret stops working straight away. Continue?",
  };
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const action = form.getAttribute("action") || "";
    const key = /\/approve$/.test(action) ? "approve"
      : /\/decline$/.test(action) ? "decline"
      : /\/revoke$/.test(action) ? "revoke"
      : /\/email\/rotate$/.test(action) ? "rotate"
      : /\/webhook\/secret$/.test(action) ? "secret" : null;
    if (key && !window.confirm(confirmText[key])) e.preventDefault();
  });
})();
