#!/bin/bash
# Install LG ThinQ poller on DigitalOcean droplet
# Run as root: bash install.sh

set -e

INSTALL_DIR="/opt/lg-poller"
SERVICE_NAME="lg-poller"
USER="bugfixer"

echo "=== Installing LG ThinQ Poller ==="

# Create directory
mkdir -p "$INSTALL_DIR"

# Copy files
cp worker.js "$INSTALL_DIR/"
cp package.json "$INSTALL_DIR/"

# Create .env template if it doesn't exist
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat > "$INSTALL_DIR/.env" <<'EOF'
SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=<paste-service-role-key>
POLL_INTERVAL_MS=30000
API_DELAY_MS=1000
# FCM push notifications (optional - set up Firebase first)
# FCM_PROJECT_ID=<firebase-project-id>
# GOOGLE_APPLICATION_CREDENTIALS=/opt/lg-poller/firebase-service-account.json
EOF
  echo "Created .env template — edit with real keys: $INSTALL_DIR/.env"
fi

# Install dependencies
cd "$INSTALL_DIR" && npm install

# Set ownership
chown -R "$USER:$USER" "$INSTALL_DIR"

# Install systemd service
cp "$INSTALL_DIR/../lg-poller.service" "/etc/systemd/system/$SERVICE_NAME.service" 2>/dev/null || \
  cp "$(dirname "$0")/lg-poller.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

echo ""
echo "=== Installation complete ==="
echo "1. Edit .env:           nano $INSTALL_DIR/.env"
echo "2. Start service:       systemctl start $SERVICE_NAME"
echo "3. Check logs:          journalctl -u $SERVICE_NAME -f"
