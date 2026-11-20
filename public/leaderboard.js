/**
 * Standalone leaderboard screen for the Brewery Tap Display.
 * Shows only the drinks leaderboard — open it on a second screen at /leaderboard
 * while the tap display runs on the other one. Driven by the same WebSocket
 * updates as the main screen, so nothing extra needs configuring.
 */

const leaderboardGrid = document.getElementById('leaderboardGrid');
const leaderboardRoot = document.getElementById('leaderboard');
const connectionStatus = document.getElementById('connectionStatus');
const statusText = connectionStatus.querySelector('.status-text');
const lastUpdatedEl = document.getElementById('lastUpdated');

let ws = null;
let reconnectTimer = null;
let leaderboardData = null;

document.addEventListener('DOMContentLoaded', connectWebSocket);

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  updateConnectionStatus('connecting');

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    updateConnectionStatus('connected');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message?.type === 'leaderboard') {
        leaderboardData = {
          byDrinks: message.byDrinks || [],
          bySpent: message.bySpent || [],
          period: message.period || ''
        };
        renderLeaderboard();
      }
    } catch { /* Ignore malformed messages. */ }
  };

  ws.onerror = () => updateConnectionStatus('disconnected');

  ws.onclose = () => {
    updateConnectionStatus('disconnected');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 3000);
}

function renderLeaderboard() {
  const data = leaderboardData;
  const periodLabel = data?.period ? `Måned: ${escapeHtml(data.period)}` : '';

  // Use only byDrinks for leaderboard (show units only, not spent)
  const byDrinks = data?.byDrinks || [];

  const combined = byDrinks.map(d => ({
    name: d.name,
    drinks: d.value
  })).sort((a, b) => b.drinks - a.drinks);

  // Take top 13 (3 top + 10 rest)
  const top13 = combined.slice(0, 13);
  const top3 = top13.slice(0, 3);
  const rest = top13.slice(3);

  const container = document.createElement('div');
  container.className = 'leaderboard-container';
  container.innerHTML = `
    <header class="leaderboard-header">
      <h2>Leaderboard</h2>
      <p class="leaderboard-period">${periodLabel}</p>
    </header>
    <section class="leaderboard-top3" id="top3Section"></section>
    <section class="leaderboard-rest" id="restSection"></section>
  `;
  leaderboardRoot.innerHTML = '';
  leaderboardRoot.appendChild(container);
  // Single-column grid so the leaderboard card takes full width, matching the main screen
  leaderboardGrid.style.gridTemplateColumns = '1fr';

  const top3Section = container.querySelector('#top3Section');
  const restSection = container.querySelector('#restSection');

  // Render top 3 in order: #2, #1, #3 (visual: #2 left, #1 middle highest, #3 right)
  const top3Order = [1, 0, 2]; // indices: 1=#2, 0=#1, 2=#3
  const rankLabels = [`#2 Plass`, `#1 Plass`, `#3 Plass`];
  const rankClasses = ['rank-2', 'rank-1', 'rank-3']; // #2 gets rank-2 (left), #1 gets rank-1 (middle highest), #3 gets rank-3 (right)

  top3Order.forEach((originalIndex, displayIndex) => {
    const person = top3[originalIndex];
    if (!person) return;
    const rank = originalIndex + 1;
    const rankLabel = rankLabels[displayIndex];
    const rankClass = rankClasses[displayIndex];

    const card = document.createElement('div');
    card.className = `leaderboard-top3-card ${rankClass}`;
    card.innerHTML = `
      <div class="top3-rank">${escapeHtml(rankLabel)}</div>
      <div class="top3-name">${escapeHtml(person.name)}</div>
      <div class="top3-stats">
        <div class="top3-stat-row">
          <span class="top3-stat-value">${person.drinks} enheter</span>
        </div>
      </div>
    `;
    top3Section.appendChild(card);
  });

  // Render rest (4-13) in two columns: left=4-8, right=9-13
  if (rest.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'leaderboard-rest-grid';

    // Split rest into two equal columns
    const mid = Math.ceil(rest.length / 2);
    const leftColumn = rest.slice(0, mid); // ranks 4-8 (upper half)
    const rightColumn = rest.slice(mid);   // ranks 9-13 (lower half)

    // Left column (4-8)
    const leftDiv = document.createElement('div');
    leftDiv.className = 'leaderboard-rest-column';
    const leftList = document.createElement('ol');
    leftColumn.forEach((person, index) => {
      const rank = index + 4;
      const li = document.createElement('li');
      li.innerHTML = `<span class="rest-rank">#${rank}</span> <span class="rest-name">${escapeHtml(person.name)}</span> <span class="rest-stats">${person.drinks} enheter</span>`;
      leftList.appendChild(li);
    });
    leftDiv.appendChild(leftList);
    grid.appendChild(leftDiv);

    // Right column (9-13)
    const rightDiv = document.createElement('div');
    rightDiv.className = 'leaderboard-rest-column';
    const rightList = document.createElement('ol');
    rightColumn.forEach((person, index) => {
      const rank = mid + index + 4;
      const li = document.createElement('li');
      li.innerHTML = `<span class="rest-rank">#${rank}</span> <span class="rest-name">${escapeHtml(person.name)}</span> <span class="rest-stats">${person.drinks} enheter</span>`;
      rightList.appendChild(li);
    });
    rightDiv.appendChild(rightList);
    grid.appendChild(rightDiv);

    restSection.appendChild(grid);
  } else if (top3.length === 0) {
    top3Section.innerHTML = '<p class="leaderboard-empty">Ingen data ennå</p>';
  }

  updateLastUpdated();
}

// Update all taps with keg data array
function updateLastUpdated() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  lastUpdatedEl.textContent = `Last updated: ${timeStr}`;
}

// Update connection status indicator
function updateConnectionStatus(status) {
  connectionStatus.className = 'status-indicator ' + status;
  switch (status) {
    case 'connected':
      statusText.textContent = 'Live';
      break;
    case 'connecting':
      statusText.textContent = 'Kobler til...';
      break;
    case 'disconnected':
      statusText.textContent = 'Kobling tapt';
      break;
  }
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
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }
  }
});
