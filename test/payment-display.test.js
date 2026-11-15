const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createPaymentDisplay, DISPLAY_MS } = require('../payment-display');

const secret = 'local-test-secret-not-for-deployment-123456';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
async function fixture(t, overrides = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-test-'));
  const imagePath = path.join(folder, 'qr.png');
  fs.writeFileSync(imagePath, png);
  let time = 1_000_000;
  const tasks = [];
  const events = [];
  const display = createPaymentDisplay({ secret, imagePath, now: () => time,
    schedule: (fn, delay) => { const task = { fn, delay }; tasks.push(task); return task; },
    cancel: task => { if (task) task.cancelled = true; }, broadcast: event => events.push(event), ...overrides });
  const app = express();
  app.use('/api', display.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { display.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(folder, { recursive: true }); });
  return { display, events, tasks, imagePath, setTime: value => { time = value; },
    get: route => fetch(url + route),
    body: (amount = 150) => ({ amount, requestId: crypto.randomUUID(), deadline: time + 5000 }),
    post: (body, auth = `Bearer ${secret}`) => fetch(url + '/api/payment-display', {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) };
}

test('authentication, disabled configuration and missing image fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(f.body(), '')).status, 401);
  assert.equal((await f.post(f.body(), 'Bearer wrong')).status, 401);
  fs.unlinkSync(f.imagePath);
  assert.equal((await f.post(f.body())).status, 503);
  assert.equal((await f.get('/api/payment-qr')).status, 503);
  assert.equal(f.events.length, 0);
  const disabled = await fixture(t, { secret: '' });
  assert.equal((await disabled.post(disabled.body())).status, 503);
});

test('validates payload and size without broadcasting private fields', async t => {
  const f = await fixture(t);
  for (const amount of [null, 0, -1, 2.5, '150', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await f.post(f.body(amount))).status, 400);
  }
  for (const extra of [{ customerId: 'private' }, { customerName: 'private' }, { imageUrl: 'https://example.com' },
    { requestId: 'not-uuid' }, { deadline: 1 }, { deadline: 1_020_000 }]) {
    assert.equal((await f.post({ ...f.body(), ...extra })).status, 400);
  }
  assert.equal((await f.post({ ...f.body(), padding: 'x'.repeat(2000) })).status, 413);
  const response = await f.post(f.body());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.expiresAt, 1_000_000 + DISPLAY_MS);
  assert.deepEqual(Object.keys(f.events[0]).sort(), ['active', 'amount', 'currency', 'expiresAt', 'requestId', 'type']);
  const image = await f.get('/api/payment-qr');
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'no-store');
});

test('reconnect and duplicate requests retain expiry, old timers cannot clear replacements', async t => {
  const f = await fixture(t);
  const first = f.body();
  await f.post(first);
  const original = f.display.snapshot();
  f.setTime(1_004_000);
  const duplicate = await (await f.post(first)).json();
  assert.equal(duplicate.expiresAt, original.expiresAt);
  assert.equal(f.tasks.length, 1);
  assert.equal((await f.post({ ...first, amount: 200 })).status, 409);
  f.setTime(1_029_000);
  assert.equal(f.display.snapshot().expiresAt, original.expiresAt);
  const second = f.body(250);
  await f.post(second);
  f.tasks[0].fn();
  assert.equal(f.display.snapshot().requestId, second.requestId);
  f.setTime(1_059_000);
  f.tasks[1].fn();
  assert.deepEqual(f.display.snapshot(), { type: 'payment-display', active: false });
  assert.equal(f.events.at(-1).requestId, second.requestId);
  f.display.close();
  assert.equal(f.display.snapshot().active, false);
});

test('expired snapshot clears state even when scheduled callback is delayed', async t => {
  const f = await fixture(t);
  await f.post(f.body());
  f.setTime(1_031_000);
  assert.equal(f.display.snapshot().active, false);
  assert.equal(f.events.at(-1).active, false);
});

test('invalid image type is not accepted', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.imagePath, '<svg onload="alert(1)"></svg>');
  assert.equal((await f.post(f.body())).status, 503);
  assert.equal((await f.get('/api/payment-qr')).status, 503);
});
