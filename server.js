/**
 * Brewery Tap Display - Express + WebSocket Proxy Server
 * Proxies requests to open-plaato-keg server and serves the frontend
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Environment variables override config.json (for Docker)
const plaatoServer = process.env.PLAATO_SERVER || config.plaatoServer;
const serverPort = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT, 10) : config.serverPort;
const taps = config.taps;

const app = express();
const server = http.createServer(app);

// Extract base URL for proxying
const plaatoBaseUrl = plaatoServer.replace(/\/+$/, ''); // Remove trailing slash

// Parse WebSocket URL from HTTP URL
const plaatoWsUrl = plaatoBaseUrl.replace(/^http/, 'ws') + '/ws';

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'tap-display', plaatoServer: plaatoBaseUrl });
});

// REST API Proxy: GET /api/kegs -> open-plaato-keg /api/kegs
app.get('/api/kegs', async (req, res) => {
  try {
    const response = await fetch(`${plaatoBaseUrl}/api/kegs`);
    if (!response.ok) {
      throw new Error(`Plaato server responded with ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error proxying /api/kegs:', error.message);
    res.status(502).json({ error: 'Failed to fetch kegs from Plaato server', details: error.message });
  }
});

// REST API Proxy: GET /api/kegs/:id -> open-plaato-keg /api/kegs/:id
app.get('/api/kegs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await fetch(`${plaatoBaseUrl}/api/kegs/${id}`);
    if (!response.ok) {
      throw new Error(`Plaato server responded with ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(`Error proxying /api/kegs/${req.params.id}:`, error.message);
    res.status(502).json({ error: 'Failed to fetch keg from Plaato server', details: error.message });
  }
});

// REST API Proxy: GET /api/kegs/connected -> open-plaato-keg /api/kegs/connected
app.get('/api/kegs/connected', async (req, res) => {
  try {
    const response = await fetch(`${plaatoBaseUrl}/api/kegs/connected`);
    if (!response.ok) {
      throw new Error(`Plaato server responded with ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error proxying /api/kegs/connected:', error.message);
    res.status(502).json({ error: 'Failed to fetch connected kegs', details: error.message });
  }
});

// REST API Proxy: GET /api/metrics -> open-plaato-keg /api/metrics (Prometheus)
app.get('/api/metrics', async (req, res) => {
  try {
    const response = await fetch(`${plaatoBaseUrl}/api/metrics`);
    if (!response.ok) {
      throw new Error(`Plaato server responded with ${response.status}`);
    }
    const data = await response.text();
    res.set('Content-Type', 'text/plain');
    res.send(data);
  } catch (error) {
    console.error('Error proxying /api/metrics:', error.message);
    res.status(502).json({ error: 'Failed to fetch metrics', details: error.message });
  }
});

// Config endpoint for frontend - returns tap configuration (without sensitive IDs in production)
app.get('/api/config', (req, res) => {
  // Return tap config for frontend (beer names, styles, etc.)
  // We include the IDs so frontend can map WebSocket data to taps
  res.json({
    taps: taps.map(tap => ({
      id: tap.id,
      name: tap.name,
      beerName: tap.beerName,
      beerStyle: tap.beerStyle
    }))
  });
});

// WebSocket Proxy
const wss = new WebSocketServer({ server, path: '/ws' });

let plaatoWs = null;
let plaatoWsReconnectTimer = null;
const frontendClients = new Set();

function connectToPlaatoWs() {
  if (plaatoWs && plaatoWs.readyState === WebSocket.OPEN) {
    return; // Already connected
  }

  console.log(`Connecting to Plaato WebSocket: ${plaatoWsUrl}`);
  plaatoWs = new WebSocket(plaatoWsUrl);

  plaatoWs.onopen = () => {
    console.log('Connected to Plaato WebSocket');
  };

  plaatoWs.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data.toString());
      // Broadcast to all connected frontend clients
      broadcastToFrontend(message);
    } catch (error) {
      console.error('Error parsing Plaato WebSocket message:', error.message);
    }
  };

  plaatoWs.onerror = (error) => {
    console.error('Plaato WebSocket error:', error.message);
  };

  plaatoWs.onclose = () => {
    console.log('Plaato WebSocket disconnected, scheduling reconnect...');
    plaatoWs = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (plaatoWsReconnectTimer) {
    clearTimeout(plaatoWsReconnectTimer);
  }
  plaatoWsReconnectTimer = setTimeout(() => {
    connectToPlaatoWs();
  }, 5000); // Reconnect after 5 seconds
}

function broadcastToFrontend(message) {
  const data = JSON.stringify(message);
  for (const client of frontendClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws, req) => {
  console.log('Frontend client connected');
  frontendClients.add(ws);

  // Send initial config to frontend
  ws.send(JSON.stringify({
    type: 'config',
    taps: taps.map(tap => ({
      id: tap.id,
      name: tap.name,
      beerName: tap.beerName,
      beerStyle: tap.beerStyle
    }))
  }));

  ws.on('close', () => {
    console.log('Frontend client disconnected');
    frontendClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('Frontend WebSocket error:', error.message);
    frontendClients.delete(ws);
  });
});

// Start the initial connection to Plaato WebSocket
connectToPlaatoWs();

// Start HTTP server
server.listen(serverPort, () => {
  console.log(`\n🍺 Brewery Tap Display Server running on http://localhost:${serverPort}`);
  console.log(`📡 Proxying to Plaato server: ${plaatoBaseUrl}`);
  console.log(`🔌 WebSocket proxy: ws://localhost:${serverPort}/ws -> ${plaatoWsUrl}`);
  console.log(`\nConfigured taps:`);
  taps.forEach((tap, i) => {
    console.log(`  ${i + 1}. ${tap.name} - ${tap.beerName} (${tap.beerStyle}) [ID: ${tap.id.substring(0, 8)}...]`);
  });
  console.log('\nPress Ctrl+C to stop\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (plaatoWsReconnectTimer) {
    clearTimeout(plaatoWsReconnectTimer);
  }
  if (plaatoWs) {
    plaatoWs.close();
  }
  for (const client of frontendClients) {
    client.close();
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  if (plaatoWsReconnectTimer) {
    clearTimeout(plaatoWsReconnectTimer);
  }
  if (plaatoWs) {
    plaatoWs.close();
  }
  for (const client of frontendClients) {
    client.close();
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});