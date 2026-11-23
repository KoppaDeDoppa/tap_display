/**
 * Brewery Tap Display - Frontend Application
 * Connects to WebSocket for real-time keg data updates
 */

// State
let tapsConfig = [];
let tapElements = {};
let ws = null;
let reconnectTimer = null;
let lastUpdateTime = null;
let snapshotGeneration = null;
let snapshotSequence = -1;
let websocketSnapshotVersion = 0;
// DOM Elements
const tapsGrid = document.getElementById('tapsGrid');
const connectionStatus = document.getElementById('connectionStatus');
const statusText = connectionStatus.querySelector('.status-text');
const lastUpdatedEl = document.getElementById('lastUpdated');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  renderTapCards();
  connectWebSocket();
  fetchInitialData();
});

// Load tap configuration from server
async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Failed to load config');
    const data = await response.json();
    tapsConfig = data.taps || [];
    console.log('Loaded tap config:', tapsConfig);
  } catch (error) {
    console.error('Error loading config:', error);
    // Fallback to empty config - cards will show "No Data"
    tapsConfig = [];
  }
}

// Render tap cards based on config
function renderTapCards() {
  tapsGrid.innerHTML = '';

  tapsConfig.forEach((tap, index) => {
    // Reattach existing cards so their latest data survives the leaderboard view.
    const card = tapElements[tap.id] || createTapCard(tap, index);
    tapsGrid.appendChild(card);
    tapElements[tap.id] = card;
  });

  // If no taps configured, show placeholder
  if (tapsConfig.length === 0) {
    tapsGrid.innerHTML = `
      <div class="tap-card no-data" style="grid-column: 1 / -1; text-align: center; padding: 60px 20px;">
        <h2 style="color: var(--text-muted); margin-bottom: 16px;">No Taps Configured</h2>
        <p style="color: var(--text-muted);">Edit config.json with your keg auth tokens</p>
      </div>
    `;
  }
}

// Create a single tap card element
function createTapCard(tap, index) {
  const card = document.createElement('article');
  card.className = 'tap-card loading';
  card.dataset.tapId = tap.id;
  card.innerHTML = `
    <header class="tap-header">
      <div class="tap-number">${tap.name}</div>
      <div class="tap-beer-info">
        <div class="tap-beer-name">${escapeHtml(tap.beerName)}</div>
        <div class="tap-beer-style">${escapeHtml(tap.beerStyle)}${tap.abv != null ? `<span class="tap-beer-abv"> ${escapeHtml(String(tap.abv))}%</span>` : ''}</div>
      </div>
    </header>

    <section class="volume-section">
      <div class="volume-label">Remaining</div>
      <div class="volume-value" data-field="volume">--.-</div>
      <div class="volume-unit">L</div>
    </section>

    <section class="percentage-section">
      <div class="percentage-row">
        <span class="percentage-label">Full</span>
        <span class="percentage-value" data-field="percentage">--%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" data-field="progress" style="width: 0%"></div>
      </div>
    </section>

    <footer class="stats-row">
      <div class="stat-item">
        <span class="stat-label">Temp</span>
        <span class="stat-value temp" data-field="temperature">--.-°C</span>
      </div>
      <div class="pour-indicator idle" data-field="pourIndicator">
        <svg class="pour-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v20M6 12h12M6 8h12M6 16h12"/>
        </svg>
        <span class="pour-text">Idle</span>
      </div>
    </footer>

    <div class="last-pour">
      Last pour: <span class="last-pour-value" data-field="lastPour">--</span>
    </div>
  `;
  if (tap.source === 'estimated') {
    card.classList.add('estimated');
    card.querySelector('.volume-label').textContent = 'Estimated remaining';
    card.querySelector('.stats-row').hidden = true;
    card.querySelector('.last-pour').hidden = true;
    const freshness = document.createElement('div');
    freshness.className = 'estimate-status';
    freshness.dataset.field = 'estimateStatus';
    freshness.setAttribute('role', 'status');
    freshness.textContent = 'Estimated · Unavailable';
    card.appendChild(freshness);
  }
  return card;
}

// Fetch initial keg data via REST
async function fetchInitialData() {
  const wsVersion = websocketSnapshotVersion;
  try {
    const response = await fetch('/api/kegs?snapshot=1');
    if (!response.ok) throw new Error('Failed to fetch kegs');
    const kegs = await response.json();
    console.log('Initial keg data:', kegs);
    if (wsVersion === websocketSnapshotVersion) {
      if (!acceptSnapshot(kegs, false)) {
        if (Array.isArray(kegs) && snapshotGeneration === null) updateAllTaps(kegs);
      }
    }
  } catch (error) {
    console.error('Error fetching initial data:', error);
    if (wsVersion === websocketSnapshotVersion && snapshotSequence < 0) showConnectionError();
  }
}

// Connect to WebSocket for real-time updates
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  console.log('Connecting to WebSocket:', wsUrl);
  updateConnectionStatus('connecting');

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    updateConnectionStatus('connected');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateConnectionStatus('disconnected');
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    updateConnectionStatus('disconnected');
    scheduleReconnect();
  };
}

// Schedule WebSocket reconnection
function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('Reconnecting to WebSocket...');
    connectWebSocket();
  }, 5000);
}

// A process generation permits sequence resets on restart. REST may never undo a
// snapshot received over WebSocket while its initial request was in flight.
function acceptSnapshot(message, fromWebSocket) {
  if (message?.type !== 'kegs' || typeof message.generation !== 'string' ||
      !Number.isSafeInteger(message.seq) || !Array.isArray(message.kegs)) return false;
  if (fromWebSocket) websocketSnapshotVersion++;
  if (snapshotGeneration !== message.generation) {
    snapshotGeneration = message.generation;
    snapshotSequence = -1;
  }
  if (message.seq <= snapshotSequence) return true;
  snapshotSequence = message.seq;
  updateAllTaps(message.kegs);
  return true;
}

// Handle incoming WebSocket messages
function handleWebSocketMessage(message) {
  if (message?.type === 'payment-display') {
    window.paymentOverlay.handle(message);
    return;
  }
  if (acceptSnapshot(message, true)) return;
  // Messages can be:
  // 1. Config message (sent on connect)
  // 2. Keg data array (from /api/kegs)
  // 3. Single keg update

  if (message.type === 'config') {
    // Config already loaded via REST, but we can update if needed
    return;
  }

  // Handle array of kegs (initial load or full update)
  if (Array.isArray(message)) {
    websocketSnapshotVersion++;
    updateAllTaps(message);
    return;
  }

  // Handle single keg update
  if (message && message.id) {
    websocketSnapshotVersion++;
    updateTap(message);
  }
}


// Update all taps with keg data array
function updateAllTaps(kegs) {
  const kegMap = new Map();
  kegs.forEach(keg => {
    if (keg.id) kegMap.set(keg.id, keg);
  });

  tapsConfig.forEach(tap => {
    const keg = kegMap.get(tap.id);
    if (keg) {
      updateTap(keg);
    } else {
      setTapNoData(tap.id);
    }
  });

  updateLastUpdated();
}

// Update a single tap with keg data
function updateTap(keg) {
  const card = tapElements[keg.id];
  if (!card) {
    console.warn('No card found for keg:', keg.id);
    return;
  }

  if (keg.source === 'estimated') {
    if (keg.available === false || !Number.isFinite(keg.amount_left)) {
      setTapNoData(keg.id);
      return;
    }
    card.classList.toggle('stale', !!keg.stale);
    setField(card, 'estimateStatus', keg.stale ? 'Estimated · Stale (POS unavailable)' : 'Estimated · Sales-based');
  }
  card.classList.remove('loading', 'no-data');

  // Volume remaining
  const volume = parseFloat(keg.amount_left) || 0;
  const maxVolume = parseFloat(keg.max_keg_volume) || 0;
  const percentage = parseFloat(keg.percent_of_beer_left) || 0;

  // Update volume display
  setField(card, 'volume', volume.toFixed(1));
  setField(card, 'percentage', `${Math.round(percentage)}%`);

  // Update progress bar with color coding
  const progressFill = card.querySelector('[data-field="progress"]');
  if (progressFill) {
    progressFill.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
    progressFill.classList.remove('mid', 'low', 'critical');
    if (percentage <= 10) {
      progressFill.classList.add('critical');
    } else if (percentage <= 30) {
      progressFill.classList.add('low');
    } else if (percentage <= 60) {
      progressFill.classList.add('mid');
    }
  }

  if (keg.source === 'estimated') return;

  // Temperature
  const temp = parseFloat(keg.keg_temperature);
  if (!isNaN(temp)) {
    setField(card, 'temperature', `${temp.toFixed(1)}°C`);
  }

  // Pour status
  const isPouring = keg.is_pouring === '255' || keg.is_pouring === 255;
  const pourIndicator = card.querySelector('[data-field="pourIndicator"]');
  if (pourIndicator) {
    if (isPouring) {
      pourIndicator.classList.remove('idle');
      pourIndicator.classList.add('active');
      pourIndicator.querySelector('.pour-text').textContent = 'Pouring';
      card.classList.add('pouring');
    } else {
      pourIndicator.classList.remove('active');
      pourIndicator.classList.add('idle');
      pourIndicator.querySelector('.pour-text').textContent = 'Idle';
      card.classList.remove('pouring');
    }
  }

  // Last pour
  if (keg.last_pour_string) {
    setField(card, 'lastPour', keg.last_pour_string);
  } else if (keg.last_pour) {
    const lastPour = parseFloat(keg.last_pour);
    if (!isNaN(lastPour) && lastPour > 0) {
      setField(card, 'lastPour', `${lastPour.toFixed(2)} L`);
    }
  }
}

// Set tap to no-data state
function setTapNoData(tapId) {
  const card = tapElements[tapId];
  if (!card) return;
  card.classList.remove('loading');
  card.classList.add('no-data');
  card.classList.remove('stale', 'pouring');
  setField(card, 'estimateStatus', 'Estimated · Unavailable');
  setField(card, 'volume', '--.-');
  setField(card, 'percentage', '--%');
  const progressFill = card.querySelector('[data-field="progress"]');
  if (progressFill) progressFill.style.width = '0%';
  setField(card, 'temperature', '--.-°C');
  setField(card, 'lastPour', '--');
}

// Helper to set field value
function setField(card, field, value) {
  const el = card.querySelector(`[data-field="${field}"]`);
  if (el) {
    el.textContent = value;
  }
}

// Update connection status indicator
function updateConnectionStatus(status) {
  connectionStatus.className = 'status-indicator ' + status;
  switch (status) {
    case 'connected':
      statusText.textContent = 'Live';
      break;
    case 'connecting':
      statusText.textContent = 'Connecting...';
      break;
    case 'disconnected':
      statusText.textContent = 'Disconnected';
      break;
  }
}

// Show connection error state
function showConnectionError() {
  updateConnectionStatus('disconnected');
  tapsConfig.forEach(tap => setTapNoData(tap.id));
}

// Update last updated timestamp
function updateLastUpdated() {
  lastUpdateTime = new Date();
  const timeStr = lastUpdateTime.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  lastUpdatedEl.textContent = `Last updated: ${timeStr}`;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Handle visibility change - reconnect when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!ws || ws.readyState !== WebSocket.OPEN)) {
    console.log('Tab visible, checking connection...');
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }
  }
});

// Periodic time update for last updated display
setInterval(() => {
  if (lastUpdateTime) {
    updateLastUpdated();
  }
}, 1000);

// Export for debugging
window.tapDisplay = {
  tapsConfig,
  tapElements,
  ws,
  renderTapCards
};
