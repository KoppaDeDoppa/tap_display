const { randomUUID } = require('node:crypto');

function validateConnection(origin, secret) {
  if (!origin && !secret) return null;
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !/^[\x21-\x7e]{32,}$/.test(secret)) {
    throw new Error('Invalid estimated-keg connection configuration');
  }
  return url.origin;
}

function validateSnapshot(data) {
  if (!data || !Array.isArray(data.kegs)) throw new Error('Invalid keg snapshot');
  const ids = new Set();
  return data.kegs.map(keg => {
    if (!keg || typeof keg.id !== 'string' || !keg.id || ids.has(keg.id) || keg.source !== 'estimated' ||
        !Number.isFinite(keg.amount_left) || !Number.isFinite(keg.max_keg_volume) ||
        !Number.isFinite(keg.percent_of_beer_left) || keg.max_keg_volume <= 0 ||
        keg.amount_left < 0 || keg.amount_left > keg.max_keg_volume ||
        keg.percent_of_beer_left < 0 || keg.percent_of_beer_left > 100 ||
        typeof keg.updatedAt !== 'string' || !Number.isFinite(Date.parse(keg.updatedAt))) {
      throw new Error('Invalid estimated keg');
    }
    ids.add(keg.id);
    return { id: keg.id, source: 'estimated', amount_left: keg.amount_left,
      max_keg_volume: keg.max_keg_volume, percent_of_beer_left: keg.percent_of_beer_left,
      updatedAt: keg.updatedAt, available: true, stale: false };
  });
}

function createEstimatedPoller({ origin = '', secret = '', fetchImpl = fetch, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, interval = 2000, timeout = 2000,
  staleAfter = 10000, onChange = () => {} } = {}) {
  const base = validateConnection(origin, secret);
  let kegs = [], lastSuccess = null, nextTimer, staleTimer, timeoutTimer, controller;
  let stopped = false, running = false, started = false;
  function publish(next) {
    if (JSON.stringify(next) !== JSON.stringify(kegs)) { kegs = next; onChange(snapshot()); }
  }
  function snapshot() { return kegs.map(keg => ({ ...keg })); }
  function armStale() {
    cancel(staleTimer);
    if (kegs.length) staleTimer = schedule(() => {
      if (!stopped && lastSuccess !== null && now() - lastSuccess >= staleAfter) {
        publish(kegs.map(keg => ({ ...keg, stale: true })));
      }
    }, staleAfter);
    staleTimer?.unref?.();
  }
  async function poll() {
    if (stopped || running || !base) return;
    running = true;
    controller = new AbortController();
    let rejectTimeout;
    const expired = new Promise((_, reject) => { rejectTimeout = reject; });
    timeoutTimer = schedule(() => {
      controller.abort(); rejectTimeout(new Error('Keg request timed out'));
    }, timeout);
    timeoutTimer?.unref?.();
    try {
      const result = await Promise.race([(async () => {
        const response = await fetchImpl(`${base}/api/integrations/kegs`, {
          headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Keg request failed');
        return validateSnapshot(await response.json());
      })(), expired]);
      if (!stopped) { lastSuccess = now(); publish(result); armStale(); }
    } catch { /* Retain last snapshot; its independent freshness timer marks it stale. */ }
    finally {
      cancel(timeoutTimer); running = false;
      if (!stopped) { nextTimer = schedule(poll, interval); nextTimer?.unref?.(); }
    }
  }
  return { snapshot, poll, start() { if (!started) { started = true; void poll(); } },
    close() { stopped = true; cancel(nextTimer); cancel(staleTimer); cancel(timeoutTimer); controller?.abort(); } };
}

// Every transport publishes the same complete, process-versioned snapshot.
function createKegStore(taps, generation = randomUUID()) {
  const virtualIds = new Set(taps.filter(tap => tap.source === 'estimated').map(tap => tap.id));
  let measured = new Map(), estimated = new Map(), seq = 0;
  function snapshot() {
    return { type: 'kegs', generation, seq, kegs: [...measured.values(), ...[...virtualIds].map(id =>
      estimated.get(id) || { id, source: 'estimated', available: false, stale: false })] };
  }
  return { snapshot,
    plaato(data) {
      if (Array.isArray(data)) measured = new Map(data.filter(keg => keg?.id && !virtualIds.has(keg.id)).map(keg => [keg.id, keg]));
      else if (data?.id && !virtualIds.has(data.id)) measured.set(data.id, { ...measured.get(data.id), ...data });
      else return snapshot();
      seq++; return snapshot();
    },
    estimated(data) { estimated = new Map(data.filter(keg => virtualIds.has(keg.id)).map(keg => [keg.id, keg])); seq++; return snapshot(); },
  };
}
function createLeaderboardPoller({ origin = '', secret = '', fetchImpl = fetch, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout, interval = 60000, timeout = 4000,
    onChange = () => {} } = {}) {
  const base = validateConnection(origin, secret);
  let data = null, stopped = false, running = false, nextTimer, controller;
  function poll() {
    if (stopped || running || !base) return;
    running = true;
    controller = new AbortController();
    let rejectTimeout;
    const expired = new Promise((_, reject) => { rejectTimeout = reject; });
    const timeoutTimer = schedule(() => {
      controller.abort(); rejectTimeout(new Error('Leaderboard request timed out'));
    }, timeout);
    timeoutTimer?.unref?.();
    (async () => {
      try {
        const response = await fetchImpl(`${base}/api/integrations/leaderboard`, {
          headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Leaderboard request failed');
        const result = await response.json();
        if (!stopped) { data = result; onChange(data); }
      } catch { /* Retain last data */ }
      finally {
        cancel(timeoutTimer); running = false;
        if (!stopped) { nextTimer = schedule(poll, interval); nextTimer?.unref?.(); }
      }
    })();
  }
  return { snapshot() { return data; }, start() { if (!running && base) poll(); }, close() { stopped = true; cancel(nextTimer); controller?.abort(); } };
}

function validateLeaderboard(data) {
  if (!data || !Array.isArray(data.byDrinks) || !Array.isArray(data.bySpent) || typeof data.period !== 'string') return null;
  return {
    byDrinks: data.byDrinks.slice(0, 5).map((e, i) => ({ rank: i + 1, name: String(e.name || ''), value: Number(e.value) || 0 })),
    bySpent: data.bySpent.slice(0, 5).map((e, i) => ({ rank: i + 1, name: String(e.name || ''), value: Number(e.value) || 0 })),
    period: String(data.period)
  };
}

module.exports = { validateConnection, validateSnapshot, createEstimatedPoller, createLeaderboardPoller, validateLeaderboard, createKegStore };
