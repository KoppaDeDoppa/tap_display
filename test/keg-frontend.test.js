const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function browser() {
  const rendered = [], payments = [];
  let resolveFetch;
  const element = { querySelector: () => ({ textContent: '' }), textContent: '' };
  const context = vm.createContext({ console, Date, Map, Number, window: { paymentOverlay: { handle: data => payments.push(data) } },
    document: { getElementById: () => element, addEventListener() {} }, setInterval() {},
    fetch: () => new Promise(resolve => { resolveFetch = resolve; }), rendered });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext('updateAllTaps = kegs => rendered.push(kegs);', context);
  return { context, rendered, payments, resolve(data) { resolveFetch({ ok: true, json: async () => data }); },
    send(data) { context.handleWebSocketMessage(data); } };
}
const snapshot = (generation, seq, amount) => ({ type: 'kegs', generation, seq, kegs: [{ id: 'helles-lager', amount_left: amount }] });
test('delayed REST cannot overwrite websocket snapshot, even across process generation changes', async () => {
  const b = browser();
  const pending = b.context.fetchInitialData();
  b.send(snapshot('new', 1, 29.5));
  b.resolve(snapshot('old', 500, 30)); await pending;
  assert.equal(b.rendered.length, 1); assert.equal(b.rendered[0][0].amount_left, 29.5);
  b.send(snapshot('new', 0, 30)); assert.equal(b.rendered.length, 1);
  b.send(snapshot('restarted', 0, 29)); assert.equal(b.rendered.at(-1)[0].amount_left, 29);
  b.send({ type: 'payment-display', active: false }); assert.equal(b.payments.length, 1);
});
test('virtual tap shows stale retained litres and unavailable rather than zero', () => {
  const b = browser();
  const classes = new Set(), fields = {};
  for (const name of ['volume', 'percentage', 'estimateStatus', 'progress', 'temperature', 'lastPour']) {
    fields[name] = { textContent: '', style: {}, classList: { remove() {}, add() {} } };
  }
  const card = { classList: { remove(...names) { names.forEach(name => classes.delete(name)); },
    add(...names) { names.forEach(name => classes.add(name)); }, toggle(name, value) { value ? classes.add(name) : classes.delete(name); } },
    querySelector(selector) { return fields[selector.match(/data-field="([^"]+)"/)?.[1]] || null; } };
  b.context.card = card;
  vm.runInContext("tapElements['helles-lager'] = card;", b.context);
  b.context.updateTap({ id: 'helles-lager', source: 'estimated', available: true, stale: true,
    amount_left: 29.5, max_keg_volume: 30, percent_of_beer_left: 98 });
  assert.equal(fields.volume.textContent, '29.5'); assert.match(fields.estimateStatus.textContent, /Stale/);
  assert.ok(classes.has('stale')); assert.equal(fields.temperature.textContent, '');
  b.context.updateTap({ id: 'helles-lager', source: 'estimated', available: false });
  assert.equal(fields.volume.textContent, '--.-'); assert.match(fields.estimateStatus.textContent, /Unavailable/);
  assert.ok(!classes.has('stale'));
});

test('REST-only snapshots and legacy websocket arrays/single updates remain supported', async () => {
  const b = browser();
  const pending = b.context.fetchInitialData(); b.resolve(snapshot('one', 2, 30)); await pending;
  b.send([{ id: 'scale', amount_left: 12 }]);
  vm.runInContext('updateTap = keg => rendered.push([keg]);', b.context);
  b.send({ id: 'scale', amount_left: 11 });
  assert.equal(b.rendered.length, 3); assert.equal(b.rendered.at(-1)[0].amount_left, 11);
});
