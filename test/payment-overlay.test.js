const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browser() {
  let now = 100_000;
  const elements = Object.fromEntries(['paymentOverlay', 'paymentQr', 'paymentAmount', 'paymentSeconds'].map(id => [id, { hidden: true, textContent: '', removeAttribute(key) { delete this[key]; } }]));
  const timers = [];
  const listeners = {};
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/payment.js'), 'utf8'), {
    window, document: { getElementById: id => elements[id], addEventListener: (name, fn) => { listeners[name] = fn; } },
    Date: { now: () => now }, Intl,
    setTimeout: (fn, delay) => { const task = { fn, delay }; timers.push(task); return task; },
    clearTimeout: task => { if (task) task.cancelled = true; },
  });
  return { elements, timers, listeners, handle: window.paymentOverlay.handle, time(value) { now = value; },
    message: (id = 'one', amount = 250, expiresAt = 130_000) => ({ type: 'payment-display', active: true, requestId: id, amount, expiresAt, currency: 'NOK' }) };
}

test('overlay waits for image and expires locally without a server clear', () => {
  const b = browser();
  b.handle(b.message());
  assert.equal(b.elements.paymentOverlay.hidden, true);
  b.elements.paymentQr.onload();
  assert.equal(b.elements.paymentOverlay.hidden, false);
  assert.match(b.elements.paymentAmount.textContent, /250.*kr/);
  b.time(130_000);
  b.timers.at(-1).fn();
  assert.equal(b.elements.paymentOverlay.hidden, true);
});

test('replacement survives stale clear/image events and reconnect does not extend expiry', () => {
  const b = browser();
  b.handle(b.message());
  const oldLoad = b.elements.paymentQr.onload;
  b.time(110_000);
  b.handle(b.message('two', 400, 140_000));
  oldLoad();
  assert.equal(b.elements.paymentOverlay.hidden, true);
  b.elements.paymentQr.onload();
  b.handle({ active: false, requestId: 'one' });
  assert.equal(b.elements.paymentOverlay.hidden, false);
  b.handle(b.message('two', 400, 145_000));
  b.time(140_000);
  b.listeners.visibilitychange();
  assert.equal(b.elements.paymentOverlay.hidden, true);
});

test('missing or failed image never shows a payment screen', () => {
  const b = browser();
  b.handle(b.message());
  b.elements.paymentQr.onerror();
  assert.equal(b.elements.paymentOverlay.hidden, true);
  b.handle(b.message('old', 500, 50_000));
  assert.equal(b.elements.paymentOverlay.hidden, true);
});
