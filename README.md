# Brewery Tap Display with Plaato Keg Integration

A complete Docker-based setup for displaying real-time keg levels from Plaato Keg Scales on a web dashboard.

## Architecture

```
┌─────────────────┐     WiFi (2.4GHz)      ┌──────────────────────┐
│  Plaato Keg     │ ◄─────────────────────► │  open-plaato-keg     │
│  Scale (HW)     │     Blynk Protocol     │  (Docker, port 1234) │
└─────────────────┘                        └──────────┬───────────┘
                                                       │ HTTP API + WS (8085)
                                                       ▼
                                              ┌──────────────────────┐
                                              │  brewery-tap-display │
                                              │  (Docker, port 3000) │
                                              └──────────┬───────────┘
                                                         │ Serves frontend
                                                         ▼
                                                  ┌──────────────┐
                                                  │  Web Browser │
                                                  │  / TV Display│
                                                  └──────────────┘
```

## Quick Start

```bash
# 1. Clone/navigate to project
cd /home/koppaarch/koding/bar_display

# 2. Run startup script (creates data dir, starts containers)
./start.sh

# 3. Configure your Plaato device(s) - see below

# 4. Edit config.json with your auth tokens

# 5. Restart display to pick up new config
docker compose restart tap_display
```

## Detailed Setup

### 1. Start the Stack

```bash
./start.sh
```

This starts two containers:
- **open-plaato-keg** (port 8085) - bridges Plaato hardware to HTTP/WebSocket API
- **tap_display** (port 3000) - your web dashboard, proxies Plaato API

### 2. Configure Plaato Keg Scale(s)

For **each** Plaato Keg Scale:

1. **Reset the device**: Use the yellow reset key (or fridge magnet) on bottom — hold ~5 seconds until LEDs cycle
2. **Connect to hotspot**: Join WiFi network `PLAATO-XXXXX` (device-specific)
3. **Open config page**: Browse to `http://192.168.4.1`
4. **Enter settings**:
   - **WiFi SSID**: Your 2.4GHz network (5GHz NOT supported!)
   - **Password**: Your WiFi password
   - **Auth Token**: 32-char hex string — **generate one per keg**
   - **Host**: IP of this machine (e.g., `192.168.1.50`)
   - **Port**: `1234`

> **Generate auth token**: `openssl rand -hex 16` → produces 32-char hex string

**Alternative (via URL)**:
```
http://192.168.4.1/config?ssid=MyWifi&pass=password&blynk=YOUR_32CHAR_TOKEN&host=192.168.1.50&port=1234
```

### 3. Update config.json

Edit `config.json` with your actual auth tokens:

```json
{
  "plaatoServer": "http://open_plaato_keg:8085",
  "taps": [
    {
      "id": "a1b2c3d4e5f6789012345678901234ab",
      "name": "Tap 1",
      "beerName": "House IPA",
      "beerStyle": "IPA"
    },
    {
      "id": "f6e5d4c3b2a10987654321fedcba9876",
      "name": "Tap 2",
      "beerName": "Seasonal Stout",
      "beerStyle": "Stout"
    }
  ],
  "serverPort": 3000
}
```

The `id` **must match** the auth token you configured on the device.

### 4. Restart Display

```bash
docker compose restart tap_display
```

### 5. View Your Dashboard

Open **http://localhost:3000** — you'll see real-time keg levels, temperature, pour detection, and more!

## Access Points

| Service | URL | Purpose |
|---------|-----|---------|
| **Tap Display** | http://localhost:3000 | Your public-facing dashboard |
| **Plaato Web UI** | http://localhost:8085 | Device config, calibration, beverage library |
| **Plaato API (kegs)** | http://localhost:8085/api/kegs | REST endpoint for keg data |
| **Plaato WebSocket** | ws://localhost:8085/ws | Real-time updates |

## Plaato Web UI Features

At http://localhost:8085 you can:
- View all connected kegs/airlocks
- **Calibrate** scales (known weight)
- **Tare** scales (zero current weight)
- Set **beverage type** per keg (from library or custom)
- Configure **tap mappings** for BarHelper
- Enable **MQTT** for Home Assistant integration
- Monitor device health (RSSI, uptime, errors)

## Common Operations

```bash
# View logs (both services)
docker compose logs -f

# View specific service logs
docker compose logs -f open_plaato_keg
docker compose logs -f tap_display

# Restart everything
docker compose restart

# Stop everything
docker compose down

# Stop and remove data volumes (fresh start)
docker compose down -v

# Update images
docker compose pull
docker compose up -d
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No Taps Configured" | Edit `config.json` with real auth tokens, restart `tap_display` |
| Device won't connect | Verify 2.4GHz WiFi, correct host IP, port 1234, auth token matches |
| No data in dashboard | Check `curl http://localhost:8085/api/kegs` — if empty, device not connected |
| WebSocket errors | Ensure `plaatoServer` in config.json uses `http://open_plaato_keg:8085` (Docker internal) |
| "Disconnected" status | Check `docker compose logs open_plaato_keg` for device connection errors |

## Network Requirements

- **Plaato device** → **open-plaato-keg**: Port 1234 (TCP, Blynk protocol)
- **tap_display** → **open-plaato-keg**: Port 8085 (HTTP + WebSocket)
- **Browser** → **tap_display**: Port 3000 (HTTP)

All services must be on the same LAN. For remote access, use a reverse proxy (nginx, Traefik, Caddy) with HTTPS.

## Data Persistence

- Plaato data: `./plaato-data/` (bind-mounted to `/db` in container)
- Survives container restarts and updates
- To backup: `tar -czf plaato-backup.tar.gz plaato-data/`

## Environment Variables

### open-plaato-keg
| Variable | Default | Description |
|----------|---------|-------------|
| `KEG_LISTENER_PORT` | 1234 | TCP port for device connections |
| `HTTP_LISTENER_PORT` | 8085 | HTTP API / WebSocket / Web UI |
| `DATABASE_FILE_PATH` | /db/keg_data.bin | Persistent storage |
| `MQTT_ENABLED` | false | Enable MQTT publishing |
| `MQTT_HOST` | - | MQTT broker hostname |
| `BARHELPER_ENABLED` | false | BarHelper integration |

### tap_display
| Variable | Default | Description |
|----------|---------|-------------|
| `PLAATO_SERVER` | http://open_plaato_keg:8085 | Plaato API endpoint |
| `SERVER_PORT` | 3000 | HTTP port for dashboard |
| `NODE_ENV` | production | Node environment |

## Hardware Notes

- **Plaato Keg** — Scale-based, measures weight, temperature, pour detection
- **Plaato Airlock** — Fermentation sensor (bubble count, temperature) — also supported!
- **WiFi**: 2.4 GHz **only** — device will not connect to 5 GHz networks
- **Power**: USB-C (5V), can run on power bank for portable use
- **Reset**: Yellow key or strong magnet on bottom center

## Generating Auth Tokens

```bash
# Single token
openssl rand -hex 16

# Multiple tokens (for multiple kegs)
for i in {1..4}; do openssl rand -hex 16; done
```

Example output:
```
a1b2c3d4e5f6789012345678901234ab
f6e5d4c3b2a10987654321fedcba9876
1234567890abcdef1234567890abcdef
fedcba0987654321fedcba0987654321
```

## License

MIT — Based on [open-plaato-keg](https://github.com/DarkJaeger/open-plaato-keg) (reverse-engineered Blynk protocol for Plaato devices)