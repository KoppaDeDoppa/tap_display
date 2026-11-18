const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEstimatedPoller, createKegStore, validateConnection, validateSnapshot } = require('../estimated-keg');
const { createDisplayServer } = require('../server');
const keg = (amount = 30) => ({ id: 'helles-lager', source: 'estimated', amount_left: amount,
  max_keg_volume: 30, percent_of_beer_left: amount / 30 * 100, updatedAt: '2026-11-18T12:00:00.000Z' });
const taps = [{ id: 'scale' }, { id: 'helles-lager', source: 'estimated' }];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function clock() {
  let now = 0, next = 0;
  const tasks = new Map();
  return { now: () => now,
    schedule(fn, delay) { const id = ++next; tasks.set(id, { at: now + delay, fn }); return id; },
    cancel(id) { tasks.delete(id); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; tasks.delete(entry[0]); entry[1].fn(); await flush();
      }
      now = end; await flush();
    }, count: () => tasks.size,
  };
}
function setup(fetchImpl) {
  const time = clock(), changes = [];
  const poller = createEstimatedPoller({ ...time, origin: 'http://pos:3000', secret: 'x'.repeat(32), fetchImpl,
    onChange: data => changes.push(data) });
  return { time, changes, poller };
}
const response = data => ({ ok: true, json: async () => data });

test('connection is optional but rejects paths, credentials, redirects targets and weak secrets', () => {
  assert.equal(validateConnection('', ''), null);
  assert.equal(validateConnection('https://pos:3000/', 'x'.repeat(32)), 'https://pos:3000');
  for (const url of ['http://pos/path', 'http://a:b@pos', 'ftp://pos', 'http://pos?x=1', 'http://pos#x']) {
    assert.throws(() => validateConnection(url, 'x'.repeat(32)));
  }
  for (const secret of ['short', ' '.repeat(32), '\n'.repeat(32), 'é'.repeat(32)]) assert.throws(() => validateConnection('http://pos', secret));
});

test('snapshot validation drops unrelated fields and rejects malformed/duplicate volumes', () => {
  assert.equal(validateSnapshot({ kegs: [{ ...keg(), customer: 'private' }] })[0].customer, undefined);
  for (const data of [{}, { kegs: [keg(), keg()] }, { kegs: [keg(NaN)] }, { kegs: [{ ...keg(), source: 'plaato' }] },
    { kegs: [{ ...keg(), updatedAt: 'invalid' }] }, { kegs: [keg(-1)] }]) assert.throws(() => validateSnapshot(data));
});

test('poll auth, retries are snapshots, stale at 10s, recovery, and explicit disable clears', async () => {
  let mode = 'ok', calls = 0;
  const { poller, time, changes } = setup(async (url, options) => {
    calls++; assert.equal(url, 'http://pos:3000/api/integrations/kegs');
    assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(32)}`);
    assert.equal(options.redirect, 'error');
    if (mode === 'failure') throw new Error('offline');
    if (mode === 'bad') return response({ kegs: [keg(-1)] });
    return response({ kegs: mode === 'disabled' ? [] : [keg()] });
  });
  poller.start(); await flush();
  assert.equal(poller.snapshot()[0].amount_left, 30);
  await time.advance(2000); assert.equal(changes.length, 1); // repeated reads never consume beer
  mode = 'failure'; await time.advance(9999); assert.equal(poller.snapshot()[0].stale, false);
  await time.advance(1); assert.equal(poller.snapshot()[0].stale, true);
  mode = 'bad'; await time.advance(2000); assert.equal(poller.snapshot()[0].amount_left, 30);
  mode = 'ok'; await time.advance(2000); assert.equal(poller.snapshot()[0].stale, false);
  mode = 'disabled'; await time.advance(2000); assert.deepEqual(poller.snapshot(), []);
  assert.ok(calls > 3); poller.close(); assert.equal(time.count(), 0);
});

test('no overlapping polls, timeout abort, shutdown prevents rescheduling', async () => {
  let active = 0, maximum = 0, calls = 0;
  const { poller, time } = setup((_url, { signal }) => new Promise((_resolve, reject) => {
    calls++; active++; maximum = Math.max(maximum, active);
    signal.addEventListener('abort', () => { active--; reject(new Error('aborted')); }, { once: true });
  }));
  poller.start(); void poller.poll(); assert.equal(calls, 1);
  await time.advance(2000); assert.equal(active, 0);
  await time.advance(2000); assert.equal(calls, 2); assert.equal(maximum, 1);
  poller.close(); await flush(); assert.equal(active, 0); assert.equal(time.count(), 0);
  await time.advance(20000); assert.equal(calls, 2);
});

test('unconfigured poller never fetches', async () => {
  let calls = 0;
  const poller = createEstimatedPoller({ fetchImpl: () => { calls++; } });
  poller.start(); await poller.poll(); poller.close(); assert.equal(calls, 0);
});

test('arrays, singles, disable, reconnect and independent outages share merged generation/sequence', () => {
  const store = createKegStore(taps, 'process-a');
  assert.equal(store.snapshot().kegs[0].available, false);
  store.estimated([{ ...keg(), available: true, stale: false }]);
  store.plaato([{ id: 'scale', amount_left: 12, keg_temperature: 4 }, { id: 'helles-lager', amount_left: 999 }]);
  store.plaato({ id: 'scale', amount_left: 11 });
  assert.equal(store.snapshot().kegs[0].keg_temperature, 4);
  assert.equal(store.snapshot().kegs[1].amount_left, 30);
  const seq = store.snapshot().seq;
  store.plaato({ id: 'helles-lager', amount_left: 999 }); assert.equal(store.snapshot().seq, seq);
  store.estimated([{ ...keg(), available: true, stale: true }]);
  assert.equal(store.snapshot().kegs[0].amount_left, 11);
  store.plaato([]); assert.equal(store.snapshot().kegs[0].amount_left, 30);
  store.estimated([]); assert.equal(store.snapshot().kegs[0].available, false);
  assert.equal(store.snapshot().generation, 'process-a');
  assert.equal(createKegStore(taps, 'process-b').snapshot().generation, 'process-b');
});

test('REST arrays/single-object compatibility and opt-in envelope include estimates during Plaato outage', async () => {
  const display = createDisplayServer({ config: { taps, plaatoServer: 'http://plaato', serverPort: 0 }, env: {},
    fetchImpl: async () => { throw new Error('offline'); } });
  display.store.estimated([keg(20)]);
  const routes = display.app._router.stack.filter(layer => layer.route).map(layer => layer.route);
  assert.ok(routes.findIndex(route => route.path === '/api/kegs/connected') < routes.findIndex(route => route.path === '/api/kegs/:id'));
  async function get(route, query = {}, params = {}) {
    let body, status = 200;
    const res = { set() { return this; }, status(value) { status = value; return this; }, json(value) { body = value; } };
    await routes.find(item => item.path === route).stack[0].handle({ query, params }, res);
    return { body, status };
  }
  assert.equal((await get('/api/kegs')).body[0].amount_left, 20);
  assert.equal((await get('/api/kegs/connected')).body[0].source, 'estimated');
  const envelope = (await get('/api/kegs', { snapshot: '1' })).body;
  assert.equal(envelope.type, 'kegs'); assert.equal(envelope.kegs[0].amount_left, 20);
  assert.equal((await get('/api/kegs/:id', {}, { id: 'helles-lager' })).body.amount_left, 20);
  assert.equal((await get('/api/kegs/:id', {}, { id: 'missing' })).status, 404);
  display.close();
});

test('slow REST cannot replace newer Plaato WS data; Plaato failure retains estimated state', async () => {
  const requests = [];
  const display = createDisplayServer({ config: { taps, plaatoServer: 'http://plaato', serverPort: 0 }, env: {},
    fetchImpl: () => new Promise(done => { requests.push(done); }) });
  const pending = display.refreshPlaato();
  const newer = display.refreshPlaato();
  requests[1](response([{ id: 'scale', amount_left: 9 }])); await newer;
  display.store.estimated([keg(20)]);
  requests[0](response([{ id: 'scale', amount_left: 12 }])); await pending;
  assert.equal(display.store.snapshot().kegs[0].amount_left, 9);
  const failed = display.refreshPlaato();
  requests[2]({ ok: false }); await failed;
  assert.equal(display.store.snapshot().kegs[1].amount_left, 20);
  display.close();
});
