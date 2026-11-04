#!/bin/bash
# Startup script for Brewery Tap Display with Plaato Keg Bridge

set -e

echo "🍺 Brewery Tap Display - Docker Startup"
echo "========================================"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Check if config.json has placeholder tokens
if grep -q "KEG_AUTH_TOKEN" config.json; then
    echo ""
    echo "⚠️  WARNING: config.json still contains placeholder auth tokens!"
    echo "   You need to:"
    echo "   1. Configure your Plaato device(s) with auth tokens (see below)"
    echo "   2. Edit config.json with your actual 32-char hex auth tokens"
    echo ""
    echo "   Generating example auth token: $(openssl rand -hex 16 2>/dev/null || echo 'a1b2c3d4e5f6789012345678901234ab')"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "📦 Starting containers..."
docker compose up -d

echo ""
echo "⏳ Waiting for services to be healthy..."
sleep 3

# Check service status
if docker compose ps | grep -q "Up"; then
    echo ""
    echo "✅ Services started successfully!"
    echo ""
    echo "📍 Access Points:"
    echo "   • Tap Display (your website):     http://localhost:3000"
    echo "   • Plaato Web UI / API:            http://localhost:8085"
    echo "   • Plaato REST API (kegs):         http://localhost:8085/api/kegs"
    echo "   • Plaato WebSocket:               ws://localhost:8085/ws"
    echo ""
    echo "📋 Next Steps:"
    echo "   1. Open http://localhost:8085 to access Plaato Web UI"
    echo "   2. Configure your Plaato Keg Scale(s):"
    echo "      - Reset device (yellow key/magnet, hold 5 sec)"
    echo "      - Connect to PLAATO-XXXXX WiFi hotspot"
    echo "      - Browse to http://192.168.4.1"
    # Try to detect local IP for user convenience
LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_MACHINE_IP")
echo "      - Enter WiFi (2.4GHz only), auth token, and host: ${LOCAL_IP}:1234"
    echo "   3. Update config.json with your device auth tokens"
    echo "   4. Restart: docker compose restart tap_display"
    echo ""
    echo "📝 View logs: docker compose logs -f"
    echo "🛑 Stop:      docker compose down"
else
    echo ""
    echo "❌ Some services failed to start. Check logs:"
    docker compose logs
    exit 1
fi