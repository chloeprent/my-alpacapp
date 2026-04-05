#!/bin/bash
# ============================================
# Camera Event Poller - Installation Script
# Run on DigitalOcean droplet as root
# ============================================

set -e

echo "=== YOUR_APP_NAME Camera Event Poller - Installation ==="

WORKER_DIR="/opt/camera-event-poller"

# ---- Prerequisites ----
echo ""
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not installed."
    exit 1
fi
echo "  Node.js: $(node --version)"

# ---- Directory Setup ----
echo ""
echo "Setting up directories..."
mkdir -p "$WORKER_DIR"

# ---- Copy Worker Files ----
echo "Copying worker files..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/worker.js" "$WORKER_DIR/"
cp "$SCRIPT_DIR/package.json" "$WORKER_DIR/"

# ---- Install Dependencies ----
echo ""
echo "Installing dependencies..."
cd "$WORKER_DIR"
npm install

# ---- Set Ownership ----
chown -R bugfixer:bugfixer "$WORKER_DIR"

# ---- Environment File ----
ENV_FILE="$WORKER_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo ""
    echo "Creating environment file..."
    cat > "$ENV_FILE" << 'ENVEOF'
SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
UDM_HOST=192.168.1.1
UDM_USER=alpacaauto
UDM_PASS=your-udm-password
POLL_INTERVAL_MS=10000
ENVEOF
    chown bugfixer:bugfixer "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "  Created $ENV_FILE - PLEASE EDIT WITH YOUR API KEYS"
else
    echo "  Environment file already exists at $ENV_FILE"
fi

# ---- Systemd Service ----
echo ""
echo "Installing systemd service..."
cp "$SCRIPT_DIR/camera-event-poller.service" /etc/systemd/system/camera-event-poller.service
systemctl daemon-reload
echo "  Service installed"

# ---- Summary ----
echo ""
echo "============================================"
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Edit /opt/camera-event-poller/.env with SUPABASE_SERVICE_ROLE_KEY and UDM_PASS"
echo ""
echo "  2. Start the service:"
echo "     systemctl enable camera-event-poller"
echo "     systemctl start camera-event-poller"
echo ""
echo "  3. Check logs:"
echo "     journalctl -u camera-event-poller -f"
echo "============================================"
