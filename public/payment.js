// Independent lifecycle so tap updates continue while the payment screen is visible.
(() => {
  const overlay = document.getElementById('paymentOverlay');
  const image = document.getElementById('paymentQr');
  const amount = document.getElementById('paymentAmount');
  const seconds = document.getElementById('paymentSeconds');
  let current = null;
  let timer = null;
  const format = new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });

  function hide() {
    clearTimeout(timer);
    timer = null;
    current = null;
    overlay.hidden = true;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
  }
  function tick() {
    if (!current) return;
    const remaining = current.expiresAt - Date.now();
    if (remaining <= 0) return hide();
    seconds.textContent = String(Math.ceil(remaining / 1000));
    timer = setTimeout(tick, Math.min(remaining, 250));
  }
  function handle(message) {
    if (!message.active) {
      if (!message.requestId || message.requestId === current?.requestId) hide();
      return;
    }
    if (typeof message.requestId !== 'string' || !Number.isSafeInteger(message.amount) || message.amount <= 0 ||
        !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= Date.now() ||
        message.expiresAt > Date.now() + 31_000 || message.currency !== 'NOK') return;
    if (current?.requestId === message.requestId) return; // Reconnects never extend expiry.
    hide();
    current = { requestId: message.requestId, expiresAt: message.expiresAt };
    const id = current.requestId;
    amount.textContent = format.format(message.amount);
    image.onload = () => {
      if (current?.requestId !== id) return;
      if (current.expiresAt <= Date.now()) return hide();
      overlay.hidden = false;
    };
    image.onerror = () => {
      if (current?.requestId === id) hide();
    };
    image.src = '/api/payment-qr';
    tick();
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    tick();
  });
  window.paymentOverlay = { handle };
})();
