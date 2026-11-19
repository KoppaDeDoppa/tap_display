/** Display proxy with independent Plaato and POS estimated-keg sources. */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { createPaymentDisplay } = require('./payment-display');
const { createEstimatedPoller, createLeaderboardPoller, validateLeaderboard, createKegStore } = require('./estimated-keg');

function createDisplayServer({ config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')),
  env = process.env, fetchImpl = fetch } = {}) {
  const taps = config.taps;
  const plaatoBaseUrl = (env.PLAATO_SERVER || config.plaatoServer).replace(/\/+$/, '');
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const store = createKegStore(taps);
  let plaatoWs, reconnectTimer, stopped = false, started = false;
  let upstreamRevision = 0;
  const frontendClients = new Set();
  const publicTaps = taps.map(({ id, name, beerName, beerStyle, source }) => ({ id, name, beerName, beerStyle, source: source || 'plaato' }));
  function broadcastToFrontend(message) {
    const data = JSON.stringify(message);
    for (const client of frontendClients) if (client.readyState === WebSocket.OPEN) client.send(data);
  }
  const estimated = createEstimatedPoller({ origin: env.POS_SERVER_URL || '', secret: env.KEG_TRACKING_SECRET || '',
    fetchImpl, onChange: kegs => broadcastToFrontend(store.estimated(kegs)) });
  let lastLeaderboard = null;
  const leaderboard = createLeaderboardPoller({ origin: env.POS_SERVER_URL || '', secret: env.KEG_TRACKING_SECRET || '',
    fetchImpl, onChange: data => {
      const validated = validateLeaderboard(data);
      if (validated) lastLeaderboard = validated;
      broadcastToFrontend({ type: 'leaderboard', ...validated });
    } });
  const paymentDisplay = createPaymentDisplay({ secret: env.PAYMENT_DISPLAY_SECRET || '',
    imagePath: env.VIPPS_QR_IMAGE_PATH, broadcast: broadcastToFrontend });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/leaderboard', (_req, res) => res.sendFile(path.join(__dirname, 'public/leaderboard.html')));
  app.use('/api', paymentDisplay.router);
  app.get('/health', (_req, res) => res.json({ status: 'ok', server: 'tap-display', plaatoServer: plaatoBaseUrl }));
  app.get('/api/config', (_req, res) => res.json({ taps: publicTaps }));
  async function plaatoFetch(route) {
    const response = await fetchImpl(`${plaatoBaseUrl}${route}`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Plaato request failed');
    return response;
  }
  async function refreshPlaato() {
    const revision = upstreamRevision;
    try {
      const data = await (await plaatoFetch('/api/kegs')).json();
      if (!Array.isArray(data)) throw new Error('Invalid Plaato snapshot');
      // A slow HTTP result must not roll back a WebSocket update or newer REST refresh.
      if (!stopped && revision === upstreamRevision) {
        upstreamRevision++;
        broadcastToFrontend(store.plaato(data));
      }
    } catch { /* POS and cached measured taps remain usable during a Plaato outage. */ }
    return store.snapshot();
  }
  app.get('/api/kegs', async (req, res) => {
    const snapshot = await refreshPlaato();
    res.set('Cache-Control', 'no-store').json(req.query.snapshot === '1' ? snapshot : snapshot.kegs);
  });
  // Register the named route before /:id. Connected uses the same merged snapshot.
  app.get('/api/kegs/connected', async (req, res) => {
    const snapshot = await refreshPlaato();
    res.set('Cache-Control', 'no-store').json(req.query.snapshot === '1' ? snapshot : snapshot.kegs);
  });
  app.get('/api/kegs/:id', async (req, res) => {
    if (!taps.some(tap => tap.id === req.params.id && tap.source === 'estimated')) await refreshPlaato();
    const snapshot = store.snapshot();
    const keg = snapshot.kegs.find(item => item.id === req.params.id);
    res.set('Cache-Control', 'no-store');
    if (!keg) return res.status(404).json({ error: 'Keg unavailable' });
    res.json(req.query.snapshot === '1' ? { ...snapshot, kegs: [keg] } : keg);
  });
  app.get('/api/metrics', async (_req, res) => {
    try { res.type('text/plain').send(await (await plaatoFetch('/api/metrics')).text()); }
    catch { res.status(502).json({ error: 'Failed to fetch metrics' }); }
  });
  function connectToPlaatoWs() {
    if (stopped) return;
    plaatoWs = new WebSocket(plaatoBaseUrl.replace(/^http/, 'ws') + '/ws');
    plaatoWs.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (Array.isArray(message) || message?.id) {
          upstreamRevision++;
          broadcastToFrontend(store.plaato(message));
        }
      } catch { /* Ignore malformed upstream messages without exposing credentials. */ }
    });
    plaatoWs.on('error', () => {});
    plaatoWs.on('close', () => {
      if (!stopped) { reconnectTimer = setTimeout(connectToPlaatoWs, 5000); reconnectTimer.unref?.(); }
    });
  }
  wss.on('connection', client => {
    frontendClients.add(client);
    client.send(JSON.stringify({ type: 'config', taps: publicTaps }));
    client.send(JSON.stringify(store.snapshot()));
    client.send(JSON.stringify(paymentDisplay.snapshot()));
    if (lastLeaderboard) client.send(JSON.stringify({ type: 'leaderboard', ...lastLeaderboard }));
    client.on('close', () => frontendClients.delete(client));
    client.on('error', () => frontendClients.delete(client));
  });
  function start() {
    if (started) return;
    started = true;
    estimated.start();
    leaderboard.start();
    connectToPlaatoWs();
    server.listen(Number(env.SERVER_PORT || config.serverPort));
  }
  function close() {
    stopped = true; estimated.close(); leaderboard.close(); paymentDisplay.close(); clearTimeout(reconnectTimer);
    plaatoWs?.terminate();
    for (const client of frontendClients) client.terminate();
    wss.close();
    server.close();
  }
  return { app, server, store, estimated, start, close, refreshPlaato };
}
if (require.main === module) {
  const display = createDisplayServer();
  display.start();
  process.once('SIGINT', () => display.close());
  process.once('SIGTERM', () => display.close());
}
module.exports = { createDisplayServer };
