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
                                              │  (Docker, port 3005) │
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
- **tap_display** (port 3005) - your web dashboard, proxies Plaato API

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
  "serverPort": 3005
}
```

The `id` **must match** the auth token you configured on the device.

### 4. Restart Display

```bash
docker compose restart tap_display
```

### 5. View Your Dashboard

Open **http://localhost:3005** — you'll see real-time keg levels, temperature, pour detection, and more!

## Access Points

| Service | URL | Purpose |
|---------|-----|---------|
| **Tap Display** | http://localhost:3005 | Your public-facing dashboard |
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
- **Browser** → **tap_display**: Port 3005 (HTTP)

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
| `SERVER_PORT` | 3005 | HTTP port for dashboard |
| `NODE_ENV` | production | Node environment |

## Estimated Helles tap (BodenBar integration)

Tap 3 is configured as `{"id":"helles-lager","source":"estimated"}`. Its stable ID is not a Plaato token or beer-name match. Taps 1 and 2 retain their existing placeholder IDs; replace those with your actual scale tokens. An omitted `source` defaults to `plaato`. No real IDs, capacity or current litres are guessed.

Tracking remains opt-in on the POS: in its admin estimated-keg controls select the actual product IDs (including member/free equivalents), enable tracking, and enter capacity/current litres. Each selected registered serving consumes 0.5 L. Undo restores attributable servings; price-only corrections and payment do not change volume. New-keg reset isolates previous-keg undo/corrections. Manual calibration establishes a new accounting baseline. This is sales-based, not a measurement: spillage/unregistered pours require calibration.

Set these server-side environment variables in the display's local `.env` (and recreate `tap_display` after changing them):

- `POS_SERVER_URL`: origin-only HTTP(S) URL reachable **from the display container**, with no path, credentials, query or fragment. Use the POS service's actual network alias on the optional shared Docker network, or its private LAN address and published port. Container `localhost` is not the POS.
- `KEG_TRACKING_SECRET`: same dedicated random value on POS and display, at least 32 printable non-space ASCII characters (`openssl rand -hex 32`). Keep it out of Git, `config.json`, frontend code and URLs. It is separate from `PAYMENT_DISPLAY_SECRET`. Both variables may be empty to leave polling disabled; partial/invalid configuration fails startup.

The display polls `GET ${POS_SERVER_URL}/api/integrations/kegs` with `Authorization: Bearer <secret>`. Redirects are rejected. Requests time out after 2 seconds and the next poll is scheduled 2 seconds after completion, without overlap. No history is replayed and no volume is subtracted locally. POS responds with `{kegs: []}` when disabled, or a list of `{id, source: "estimated", amount_left, max_keg_volume, percent_of_beer_left, updatedAt}` (volumes in litres; ISO timestamp).

Until configured, the virtual tap reads **Estimated · Unavailable**, not zero. Failed/invalid requests retain the last valid snapshot; 10 seconds after the last successful response it reads **Estimated · Stale (POS unavailable)**. Explicit disabled/empty snapshots immediately clear old data. Recovery is automatic. Temperature, pouring and last-pour measurements are hidden on the virtual tap. POS and Plaato failures do not block updates from the other source. Existing Vipps overlays are unchanged.

Display REST `/api/kegs` and `/api/kegs/connected` retain their array response; `/api/kegs/:id` retains its single-object response. Add `?snapshot=1` (as the frontend does) for a complete merged snapshot envelope: `{type: "kegs", generation, seq, kegs: [...]}`; individual lookup has one keg in that envelope. WebSocket keg messages always use the complete envelope. The generation changes when the display process restarts; sequence increases on source updates. The frontend still accepts legacy Plaato arrays/single updates and payment/config messages. Versioned snapshots prevent a delayed initial REST response from replacing newer WebSocket data; reconnect immediately receives cached merged state. Configured virtual IDs are excluded from Plaato updates. An unavailable virtual keg has `available: false`, without fabricated volume; available estimates include `available: true` and `stale`.

## Vipps QR on the TV (optional BodenBar integration)

BodenBar can send the selected customer's outstanding amount to the TV. The TV shows your **existing Vipps QR image and amount for 30 seconds**, then returns to the taps. Tap data continues updating underneath. No customer name or customer ID is sent to the TV, and this never marks a tab as paid.

1. Put your own verified merchant/account QR image at `public/images/vipps-qr.png` (PNG or JPEG content, maximum 5 MB). Create the `public/images` folder if necessary. Keep the original image uncropped, including its white quiet zone. **Do not use a made-up QR or an unrelated payment link.** Requests fail with a setup error until the image exists. Outside Docker, `VIPPS_QR_IMAGE_PATH` can select another local file.
2. Set `PAYMENT_DISPLAY_SECRET` in a local `.env` on **both** servers to the same randomly generated value, at least 32 characters. Generate one with `openssl rand -hex 32`. Never put it in `config.json`, browser code, URLs or Git. Set BodenBar's `TAP_DISPLAY_URL` to the TV origin (see below). The feature stays disabled if configuration is missing.
3. On the same Pi, the recommended connection is an opt-in shared Docker network. Create it once:

```bash
docker network create bodenbar-display
```

Start Tap Display with its optional network override (the existing Plaato network is retained):

```bash
docker compose -f docker-compose.yml -f compose.payment-display.yaml up -d --build
```

In BodenBar, set `TAP_DISPLAY_URL=http://tap-display:3005` and use its matching `compose.payment-display.yaml` override. See BodenBar's `DOCKER.md` for its startup command. Continue using these override files for later updates. Rebuild Tap Display after replacing the bundled QR image.

Alternatively, the POS can use `TAP_DISPLAY_URL=http://10.0.0.33:3005` over your trusted private LAN if Docker can reach the Pi's published port. No shared-network override is needed in that case. `localhost` inside the POS container is **not** the TV container. Use encrypted transport if crossing an untrusted network. Tailscale remote browser access remains `http://100.101.106.50:3005`; Plaato scales still connect to `10.0.0.33:1234`.

**Privacy and payment limits:** the existing TV HTTP/WebSocket interface is not login-protected. All reachable TV browsers can receive the displayed amount, so restrict port 3005 to trusted LAN/Tailscale devices using firewall and Tailscale ACLs; do not publish it to the internet. The server secret protects sending new displays, not viewing the screen. The amount is a snapshot at button press, not a payment request that tracks future purchases. Scanning the static QR may require **manual amount entry in Vipps**. Verify the recipient and scan behavior from the physical TV before use, and confirm payment manually in BodenBar. A success message only confirms the TV server accepted the request, not that a physical screen rendered it or payment was received.

### Development checks

```bash
npm test
```

The test suite uses disposable image fixtures and fake clocks; no real payment QR or customer data is required.

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
