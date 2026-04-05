# Background Worker Setup

Optional step for deploying background pollers and bots to a cloud server.

## When to Use Workers

Workers are Node.js processes that run continuously on a server. Use them for:
- **Device polling** — Periodically query device APIs and cache state in Supabase (Tesla, LG, cameras)
- **Queue processing** — Poll a database table for pending jobs and process them (image generation, bug fixing)
- **Bot bridges** — Connect chat platforms (Discord, Slack) to your AI assistant

## Worker Architecture

```
┌─────────────┐     poll/push      ┌──────────────┐
│   Worker     │ ──────────────────→│   Supabase   │
│ (systemd)   │                    │   Database   │
│             │ ←──────────────────│              │
└─────────────┘     read state     └──────────────┘
       │
       │ API calls
       ↓
┌─────────────┐
│  External   │
│  Device API │
└─────────────┘
```

## Poller Base Pattern

Create `workers/{name}/poller.js`:

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30000'); // 30s default
let running = true;

async function poll() {
  try {
    // 1. Read config from DB
    // 2. Call external API
    // 3. Write results to DB
    console.log(`[${new Date().toISOString()}] Poll complete`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
  }
}

async function main() {
  console.log(`Starting ${process.env.WORKER_NAME || 'worker'} (interval: ${POLL_INTERVAL}ms)`);

  // Graceful shutdown
  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });

  while (running) {
    await poll();
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  console.log('Worker stopped gracefully');
  process.exit(0);
}

main();
```

## systemd Service Template

Create `/etc/systemd/system/{worker-name}.service`:

```ini
[Unit]
Description={WORKER_DESCRIPTION}
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/{worker-name}
ExecStart=/usr/bin/node poller.js
Restart=always
RestartSec=10
Environment=SUPABASE_URL={SUPABASE_URL}
Environment=SUPABASE_SERVICE_ROLE_KEY={SERVICE_ROLE_KEY}
Environment=POLL_INTERVAL={INTERVAL_MS}
Environment=WORKER_NAME={worker-name}

[Install]
WantedBy=multi-user.target
```

### Deploy Commands

```bash
# Copy worker to server
scp -r workers/{name}/ root@{SERVER_IP}:~/{name}/

# Install dependencies on server
ssh root@{SERVER_IP} "cd ~/{name} && npm install"

# Create and enable service
ssh root@{SERVER_IP} "systemctl daemon-reload && systemctl enable {name} && systemctl start {name}"

# Check status
ssh root@{SERVER_IP} "systemctl status {name}"

# View logs
ssh root@{SERVER_IP} "journalctl -u {name} -f"
```

## Feature → Worker Mapping

| Feature | Worker | Poll Interval | Description |
|---------|--------|---------------|-------------|
| vehicles | tesla-poller | 5 min | Cache Tesla battery, location, lock state |
| laundry | lg-poller | 30 sec | Cache LG washer/dryer cycle status |
| cameras | camera-event-poller | 60 sec | Check for motion events |
| pai | image-gen | 10 sec | Process async image generation queue |

## Server Options

### Oracle Cloud Always Free (Recommended)
- 4 ARM cores, 24 GB RAM, 200 GB storage — **always free**
- See `references/server-setup.md` → "Oracle Cloud"

### DigitalOcean Droplet
- ~$12/month for 2 GB RAM
- See `references/server-setup.md` → "DigitalOcean"

## Environment Variables

All workers need:
- `SUPABASE_URL` — Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key (server-side only, never expose to clients)
- `POLL_INTERVAL` — Milliseconds between polls
- `WORKER_NAME` — For logging

Device-specific workers also need:
- API keys for the external service (stored in Supabase, read at startup)

## Health Monitoring

Add a health check endpoint or use Supabase to track worker heartbeats:

```javascript
// In your poll() function, update a heartbeat
await supabase.from('worker_heartbeats').upsert({
  worker_name: process.env.WORKER_NAME,
  last_heartbeat: new Date().toISOString(),
  status: 'healthy'
}, { onConflict: 'worker_name' });
```

Monitor with Uptime Kuma or similar tool on your server.
