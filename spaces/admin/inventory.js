import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';

let authState = null;
let activeSubtab = 'dashboard';
const loadedTabs = new Set();

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function badge(text, color = 'gray') { return `<span class="inv-badge inv-badge-${color}">${esc(text)}</span>`; }

function detailsBlock(title, meta, bodyHtml) {
  return `<details class="inv-details">
    <summary>${esc(title)}<span class="inv-summary-meta">${meta}</span></summary>
    <div class="inv-details-body">${bodyHtml}</div>
  </details>`;
}

function tableHtml(headers, rows) {
  return `<div class="inv-table-wrap"><table class="inv-table">
    <thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// ══════════════════════════════════════════════════════════════
// STATIC DATA ARRAYS
// ══════════════════════════════════════════════════════════════

const INFRASTRUCTURE = [
  {
    name: 'Alpuca Mac Mini M4',
    meta: '192.168.1.200 · Apple M4 (10-core) · 24 GB LPDDR5 · 256 GB SSD',
    body: `<p>Primary host machine running all local services, VMs, cron jobs, and file syncs. Serves as the on-premise hub connecting cloud services to physical devices.</p>
      <dl>
        <dt>Model</dt><dd>Mac mini (Mac16,10) — Model Z1CF0001ELL/A</dd>
        <dt>Chip</dt><dd>Apple M4 — 10 cores (4P + 6E), 10-core GPU (Metal 4)</dd>
        <dt>Memory</dt><dd>24 GB LPDDR5 (Hynix)</dd>
        <dt>Storage</dt><dd>APPLE SSD AP0256Z — 245 GB APFS, 60 GB free (18% used)</dd>
        <dt>Display</dt><dd>Samsung LS32D80xU — 3840×2160 4K @ 60 Hz (UI scaled 1920×1080)</dd>
        <dt>OS</dt><dd>macOS 26.4 (Build 25E246) — Apple Silicon</dd>
        <dt>Firmware</dt><dd>18000.101.7</dd>
        <dt>Hostname</dt><dd>Alpuca.local</dd>
        <dt>Network</dt><dd>Ethernet en0 (DHCP) — MAC d0:11:e5:af:d9:4c</dd>
        <dt>SSH</dt><dd><code>ssh paca@192.168.1.200</code> (key auth only, password disabled)</dd>
        <dt>Serial</dt><dd>C9F44FC69D</dd>
        <dt>Uptime</dt><dd>Queried 2026-03-30: 2 days, 23h — load avg 2.0</dd>
        <dt>Runtimes</dt><dd>Node.js v20.20.1 (nvm, also v18.20.8), Python 3.14.3 / 3.13 / 3.12</dd>
        <dt>Key Software</dt><dd>QEMU, Ollama, MLX, Colima/Docker, cloudflared, rclone, ffmpeg, gh, jq, awscli, mas, tmux, Gradle</dd>
        <dt>Key Roles</dt><dd>Home Assistant VM host, rclone sync, media processing (ffmpeg), Docker (Colima), Cloudflare Tunnel endpoint, Claude remote-control, Music Assistant, Uptime Kuma, all LaunchAgent services</dd>
        <dt>External Drives</dt><dd>
          rvault20 — 20 TB Seagate (ExFAT, 3.9 TB free) at <code>/Volumes/rvault20/</code><br>
          RVaultBack1 — 16 TB WD Elements (ExFAT, 4.8 TB free) at <code>/Volumes/RVaultBack1/</code><br>
          Terramass — 10 TB Seagate (NTFS read-only, 2.2 TB free) at <code>/Volumes/Terramass/</code>
        </dd>
        <dt>Logs</dt><dd><code>/Users/alpuca/logs/</code> — finleg-backup, alpacapps-backup, gdrive-sync, up-sense-monitor, backup-trigger-poller</dd>
      </dl>`
  },
  {
    name: 'UniFi Dream Machine Pro',
    meta: '192.168.1.1 · 8 cameras',
    body: `<p>Network gateway and security camera NVR. Runs UniFi Protect with 8 cameras for property surveillance. Firmware 5.0.12.</p>
      <dl>
        <dt>Web UI</dt><dd><code>https://192.168.1.1/</code></dd>
        <dt>Cameras</dt><dd>8 UniFi Protect cameras (outdoor and indoor coverage)</dd>
        <dt>Access</dt><dd>UDM Tunnel LaunchAgent proxies Protect API for remote access</dd>
      </dl>`
  },
  {
    name: 'Home Assistant OS (HAOS)',
    meta: '192.168.1.39:8123 · QEMU VM',
    body: `<p>Central smart home automation hub running as a QEMU virtual machine on the Alpuca Mac. Manages WiZ bulbs, Sonos, Cast devices, TP-Link switches, and Music Assistant.</p>
      <dl>
        <dt>Web UI</dt><dd><code>http://192.168.1.39:8123</code></dd>
        <dt>Version</dt><dd>HAOS 17.1</dd>
        <dt>Auto-start</dt><dd>LaunchDaemon: <code>com.alpacapps.homeassistant-vm.plist</code></dd>
        <dt>Start Script</dt><dd><code>~/homeassistant-vm/start-ha.sh</code></dd>
        <dt>Integrations</dt><dd>WiZ, Sonos, Google Cast, TP-Link Kasa, HP Printer, Music Assistant</dd>
      </dl>`
  },
  {
    name: 'rvault20 — Seagate Expansion HDD',
    meta: 'USB · 20 TB ExFAT · 3.9 TB free',
    body: `<p>Primary external storage drive for all Google Drive syncs, Google Takeout exports, Tesla cam footage, and weekly repo backups.</p>
      <dl>
        <dt>Mount Point</dt><dd><code>/Volumes/rvault20/</code></dd>
        <dt>Capacity</dt><dd>20 TB (ExFAT) — 3.94 TB free (80% used)</dd>
        <dt>Protocol</dt><dd>USB · GPT partition</dd>
        <dt>Key Folders</dt>
        <dd>
          <code>googledrivesync-rahulioson/</code> — Rahul's GDrive (~5.5 GB, syncs every 4h)<br>
          <code>googledrivesync-tesloop/</code> — TesLoop GDrive (~512 MB, Sundays 3am)<br>
          <code>GoogleTakeout/</code> — Photos takeout exports<br>
          <code>TESLACAM/</code> — Tesla dashcam footage<br>
          <code>backups/</code> — Weekly repo backups<br>
          <code>Terraformer/</code> — Infrastructure configs
        </dd>
      </dl>`
  },
  {
    name: 'RVaultBack1 — WD Elements 25A3',
    meta: 'USB · 16 TB ExFAT · 4.8 TB free',
    body: `<p>Secondary backup drive for tiered backup strategy.</p>
      <dl>
        <dt>Mount Point</dt><dd><code>/Volumes/RVaultBack1/</code></dd>
        <dt>Capacity</dt><dd>16 TB (ExFAT) — 4.76 TB free (70% used)</dd>
        <dt>Protocol</dt><dd>USB · GPT partition</dd>
      </dl>`
  },
  {
    name: 'Terramass — Seagate Expansion Desk',
    meta: 'USB · 10 TB NTFS (read-only) · 2.2 TB free',
    body: `<p>Legacy archive drive. NTFS formatted — mounted read-only on macOS.</p>
      <dl>
        <dt>Mount Point</dt><dd><code>/Volumes/Terramass/</code></dd>
        <dt>Capacity</dt><dd>10 TB (NTFS) — 2.19 TB free (78% used)</dd>
        <dt>Protocol</dt><dd>USB · GPT partition</dd>
        <dt>Note</dt><dd>Read-only — requires NTFS driver for writes</dd>
      </dl>`
  },
  {
    name: 'Hostinger VPS',
    meta: '93.188.164.224 · Batch Processing',
    body: `<p>Remote virtual private server used for background workers and batch processing that don't need to run locally.</p>
      <dl>
        <dt>IP</dt><dd>93.188.164.224</dd>
        <dt>Runs</dt><dd>Bug Scout, Feature Builder, PAI Discord bot</dd>
      </dl>`
  }
];

const DATA_ASSETS = [
  {
    name: 'Google Drive — rahulioson@gmail.com',
    meta: badge('Syncing', 'green') + ' ~5.5 GB',
    body: `<p>Personal Google Drive synced to RVAULT20 via rclone every 4 hours. Contains documents, spreadsheets, and project files.</p>
      <dl>
        <dt>Local Path</dt><dd><code>/Volumes/RVAULT20/googledrivesync-rahulioson/</code></dd>
        <dt>Sync Schedule</dt><dd>Every 4 hours at :07 — <code>sync-gdrive-to-rvault.sh rahulioson</code></dd>
        <dt>rclone Remote</dt><dd><code>gdrive-rahulioson:</code></dd>
      </dl>`
  },
  {
    name: 'Google Drive — tesloop@gmail.com',
    meta: badge('Syncing', 'green') + ' ~512 MB',
    body: `<p>TesLoop company Google Drive synced weekly. Contains historical business documents and operational files.</p>
      <dl>
        <dt>Local Path</dt><dd><code>/Volumes/RVAULT20/googledrivesync-tesloop/</code></dd>
        <dt>Sync Schedule</dt><dd>Sundays 3:07 AM — <code>sync-gdrive-to-rvault.sh tesloop</code></dd>
        <dt>rclone Remote</dt><dd><code>gdrive-tesloop:</code></dd>
      </dl>`
  },
  {
    name: 'Google Photos — rahulioson@gmail.com',
    meta: badge('Complete', 'blue') + ' via Takeout',
    body: `<p>Full photo library exported via Google Takeout. Downloaded and stored on RVAULT20.</p>
      <dl><dt>Location</dt><dd><code>/Volumes/RVAULT20/GoogleTakeout/</code></dd></dl>`
  },
  {
    name: 'Google Photos — tesloop@gmail.com',
    meta: badge('Missing', 'red') + ' Takeout expired',
    body: `<p>Takeout was initiated March 17 but download links expired March 23 before completion. Needs a new takeout request from the TesLoop Google account.</p>
      <dl><dt>Action Required</dt><dd>Re-request Google Takeout from tesloop@gmail.com (Photos only)</dd></dl>`
  },
  {
    name: 'Tesla Dashcam Footage',
    meta: 'RVAULT20',
    body: `<p>Tesla vehicle dashcam recordings archived on external storage. Last batch from November 2024.</p>
      <dl><dt>Location</dt><dd><code>/Volumes/RVAULT20/TESLACAM/</code></dd></dl>`
  },
  {
    name: 'Supabase Database',
    meta: badge('Live', 'green') + ' 70+ tables',
    body: `<p>Primary cloud database (PostgreSQL) hosting all application data. Includes core entities, payments, smart home configs, AI prompts, and audit trails.</p>
      <dl>
        <dt>Project</dt><dd><code>aphrrfprbixmhissnjfn</code> — us-east-1</dd>
        <dt>Table Groups</dt><dd>Core (spaces, people, assignments), Payments (ledger, payments), Comms (SMS, email), Smart Home (govee, nest, tesla, lg, anova), AI (prompts, image_gen_jobs), Admin (bug_reports, audit_log)</dd>
      </dl>`
  },
  {
    name: 'Cloudflare R2 Storage',
    meta: badge('Active', 'blue'),
    body: `<p>Object storage for documents, lease agreements, and uploaded files. Configured via <code>r2_config</code> Supabase table.</p>`
  },
  {
    name: 'Weekly Repo Backups',
    meta: badge('Automated', 'green'),
    body: `<p>Automated weekly backups of code repositories to RVAULT20.</p>
      <dl>
        <dt>finleg</dt><dd>Sundays 5:00 AM → <code>/Volumes/RVAULT20/backups/</code></dd>
        <dt>alpacapps</dt><dd>Mondays 1:00 AM → <code>/Volumes/RVAULT20/backups/</code></dd>
      </dl>`
  }
];

const SOFTWARE = [
  { name: 'rclone', desc: 'Cloud file synchronization — syncs Google Drive accounts to RVAULT20 on schedule.', tags: ['sync', 'backup'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'ffmpeg', desc: 'Media processing — video transcoding, thumbnail generation, audio extraction for property media and dashcam footage.', tags: ['media', 'video', 'audio'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'Node.js v20', desc: 'JavaScript runtime for all local services (Sonos HTTP API, WiZ Proxy, File Search, etc.) and development tooling.', tags: ['runtime', 'services'], where: 'Alpuca Mac (Homebrew, nvm)' },
  { name: 'Python 3.12 / 3.14', desc: 'Used for utility scripts including UPSense monitor, automation helpers, and data processing.', tags: ['runtime', 'scripts'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'Colima + Docker', desc: 'Lightweight Docker runtime on macOS via Lima VMs. Used for containerized services.', tags: ['containers', 'infra'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'QEMU', desc: 'Virtual machine hypervisor running the Home Assistant OS VM.', tags: ['vm', 'infra'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'cloudflared', desc: 'Cloudflare Tunnel client — exposes local services (Sonos API, WiZ Proxy, HAOS) to the internet securely without port forwarding.', tags: ['tunnel', 'infra'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'Tailwind CSS v4', desc: 'Utility-first CSS framework used across all AlpacApps pages. Custom <code>aap-*</code> design tokens defined in config. Run <code>npm run css:build</code> after adding new classes.', tags: ['frontend', 'css'], where: 'alpacapps repo (npm)' },
  { name: 'Capacitor 8', desc: 'Cross-platform mobile app framework. Wraps AlpacApps web UI into native iOS and Android apps with camera feeds, Sonos control, and device management.', tags: ['mobile', 'ios', 'android'], where: 'alpacapps/mobile/' },
  { name: 'Supabase CLI', desc: 'Local development, migrations, and edge function deployment for the Supabase backend.', tags: ['database', 'deploy'], where: 'Alpuca Mac (npm)' },
  { name: 'gh (GitHub CLI)', desc: 'GitHub command-line tool for PR management, releases, and CI/CD interaction.', tags: ['git', 'deploy'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'jq', desc: 'JSON query tool used in shell scripts for parsing API responses and config files.', tags: ['utility'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'Ollama', desc: 'Local LLM inference server for Apple Silicon. Runs open-source models (Qwen, Llama, etc.) on the M4 with 24 GB unified memory.', tags: ['ai', 'local'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'MLX / MLX-C', desc: 'Apple\'s machine learning framework optimized for Apple Silicon — used for local model inference and fine-tuning.', tags: ['ai', 'local'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'awscli', desc: 'AWS command-line tool — used for S3 operations and Cloudflare R2 compatible storage.', tags: ['cloud', 'storage'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'tmux', desc: 'Terminal multiplexer for persistent shell sessions on Alpuca.', tags: ['utility'], where: 'Alpuca Mac (Homebrew)' },
  { name: 'Gradle', desc: 'Build tool for Android (Alpaca Kiosk app) and JVM projects.', tags: ['build', 'android'], where: 'Alpuca Mac (Homebrew)' },
];

const SERVICES_AGENTS = [
  { name: 'Sonos HTTP API', plist: 'com.sonos.httpapi', port: 5005, desc: 'RESTful API for controlling Sonos speakers — play, pause, volume, grouping, favorites.' },
  { name: 'WiZ Proxy', plist: 'com.alpacapps.wiz-proxy', port: 8902, desc: 'HTTP proxy for WiZ smart bulb UDP protocol — enables cloud control of local bulbs.' },
  { name: 'Music Assistant', plist: 'com.music-assistant.server', port: 8095, desc: 'Music library aggregator integrating Spotify, YouTube Music, and local files through HAOS.' },
  { name: 'File Search API', plist: 'com.alpacapps.file-search-api', port: null, desc: 'Full-text search service for property documents and files.' },
  { name: 'PTZ Proxy', plist: 'com.alpacapps.ptz-proxy', port: null, desc: 'Pan-tilt-zoom camera control proxy for PTZ-capable UniFi cameras.' },
  { name: 'UDM Tunnel', plist: 'com.alpacapps.udm-tunnel', port: null, desc: 'Reverse tunnel to UniFi Dream Machine Protect API for remote camera access.' },
  { name: 'Cloudflare Tunnel', plist: 'com.cloudflare.tunnel', port: null, desc: 'Secure tunnel exposing local services to the internet without port forwarding.' },
  { name: 'Colima (Docker)', plist: 'com.alpacapps.colima', port: null, desc: 'Lightweight Docker runtime on macOS — manages containerized services.' },
  { name: 'MediaMTX', plist: 'com.mediamtx', port: null, desc: 'RTSP/HLS media streaming server — restreams camera feeds for web playback.' },
  { name: 'go2rtc', plist: 'com.go2rtc', port: null, desc: 'Camera stream proxy — converts RTSP to WebRTC/HLS for browser-based camera viewing.' },
  { name: 'Blink Poller', plist: 'com.blink-poller', port: null, desc: 'Polls Blink camera API for motion events and stores clips.' },
  { name: 'PAI Wallpaper Rotator', plist: 'com.alpuca.pai-wallpaper-rotate', port: null, desc: 'Rotates AI-generated wallpapers on the Alpuca Mac desktop.' },
  { name: 'Printer Proxy', plist: 'com.printer-proxy', port: null, desc: 'HTTP proxy for FlashForge 3D printer TCP protocol.' },
  { name: 'PO Token Server', plist: 'com.po-token-server', port: null, desc: 'Token generation server for YouTube playback authentication.' },
  { name: 'Home Assistant VM', plist: 'com.alpacapps.homeassistant-vm (daemon)', port: null, desc: 'Auto-starts the HAOS QEMU VM on boot via LaunchDaemon.' },
  { name: 'Claude Remote Control', plist: 'com.alpacapps.claude-remote', port: null, desc: 'Claude Code remote control daemon — allows remote agent sessions via Cloudflare Tunnel.' },
  { name: 'Claude Task Poller', plist: 'com.alpacapps.claude-task-poller', port: null, desc: 'Polls Supabase for queued Claude tasks and executes them locally.' },
  { name: 'Uptime Kuma', plist: 'com.uptime-kuma', port: null, desc: 'Self-hosted uptime monitoring dashboard (v1.23.x, Node 18). Monitors all services and endpoints.' },
  { name: 'Light API', plist: 'com.alpacapps.light-api', port: null, desc: 'REST API for controlling smart lights across all protocols (WiZ, HAOS, Govee).' },
  { name: 'Talkback Relay', plist: 'com.talkback-relay', port: null, desc: 'Two-way audio relay for intercom and talkback functionality.' },
  { name: 'Ollama', plist: 'homebrew.mxcl.ollama', port: 11434, desc: 'Local LLM inference server — runs open-source models on Apple Silicon (M4, 24 GB).' },
  { name: 'File Search Indexer (Gunicorn)', plist: 'com.alpacapps.file-search-api', port: null, desc: 'Python gunicorn workers (5 processes) indexing and serving full-text file search.' },
  { name: 'Caffeinate', plist: 'com.caffeinate (daemon)', port: null, desc: 'Prevents macOS from sleeping — keeps Alpuca always awake for services.' },
];

const CRON_JOBS = [
  { schedule: '0:30 AM daily', cmd: 'nightly-cleanup.sh', desc: 'Nightly cleanup of temp files and stale data.' },
  { schedule: 'Sun 5:00 AM', cmd: 'backup-finleg-to-rvault.sh', desc: 'Weekly backup of finleg repository to RVAULT20.' },
  { schedule: 'Every 2 hours', cmd: 'up-sense-monitor.py', desc: 'UPS power monitoring — checks battery status and logs events.' },
  { schedule: 'Mon 1:00 AM', cmd: 'backup-alpacapps-to-rvault.sh', desc: 'Weekly backup of alpacapps repository to RVAULT20.' },
  { schedule: 'Every 4h at :07', cmd: 'sync-gdrive-to-rvault.sh rahulioson', desc: 'Syncs rahulioson Google Drive to RVAULT20.' },
  { schedule: 'Sun 3:07 AM', cmd: 'sync-gdrive-to-rvault.sh tesloop', desc: 'Syncs tesloop Google Drive to RVAULT20.' },
  { schedule: '3:17 AM daily', cmd: 'backup-haos.sh', desc: 'Backs up HAOS VM snapshots to local storage.' },
  { schedule: '2:00 AM daily', cmd: 'haos-backup-sync.sh', desc: 'Syncs HAOS backups to Supabase — requires HA token and service key.' },
  { schedule: 'Every 5 min', cmd: 'backup-trigger-poller.sh', desc: 'Polls Supabase for backup trigger requests and executes them.' },
  { schedule: 'Every 10 min', cmd: 'haos-watchdog.sh', desc: 'Monitors HAOS VM health — auto-restarts QEMU if unresponsive, updates scripts on IP change.' },
];

const CLOUD_SERVICES = {
  'Platform & Hosting': [
    { name: 'Supabase', desc: 'Database, Auth, Edge Functions, Storage — primary backend', badge: badge('Core', 'green') },
    { name: 'GitHub + Pages', desc: 'Code hosting, CI/CD via Actions, static site deployment', badge: badge('Core', 'green') },
    { name: 'Cloudflare', desc: 'DNS management, R2 object storage, Tunnel for local services', badge: badge('Core', 'green') },
    { name: 'DigitalOcean', desc: 'Droplet VPS for background workers (Bug Scout, PAI Discord)', badge: badge('Active', 'blue') },
  ],
  'Payments': [
    { name: 'Stripe', desc: 'Primary payment processor — ACH (0.8% capped $5), cards (2.9% + $0.30), Connect for associate payouts', badge: badge('Active', 'green') },
    { name: 'Square', desc: 'Backup payment processing (2.6% + $0.10)', badge: badge('Active', 'green') },
    { name: 'PayPal', desc: 'Associate payouts ($0.25 per payout)', badge: badge('Active', 'green') },
  ],
  'Communications': [
    { name: 'Resend', desc: 'Transactional email (100/day free) — notifications, branded templates, inbound webhook', badge: badge('Active', 'green') },
    { name: 'Telnyx', desc: 'SMS sending/receiving for property notifications', badge: badge('Active', 'green') },
    { name: 'SignWell', desc: 'E-signature platform for rental agreements and legal documents', badge: badge('Active', 'blue') },
    { name: 'Vapi', desc: 'Voice AI assistant — PAI phone interface for concierge calls', badge: badge('Active', 'blue') },
  ],
  'AI & Data': [
    { name: 'Gemini', desc: 'Image generation, PAI chat, payment matching, identity verification (Vision)', badge: badge('Active', 'green') },
    { name: 'Brave Search', desc: 'Web search API for PAI knowledge retrieval', badge: badge('Active', 'blue') },
    { name: 'OpenWeatherMap', desc: 'Weather forecasts for property dashboard', badge: badge('Active', 'blue') },
  ],
  'Device APIs': [
    { name: 'Google SDM API', desc: 'Nest thermostat control via OAuth (3 devices)', badge: badge('Active', 'green') },
    { name: 'Tesla Fleet API', desc: 'Vehicle data, commands (lock, unlock, flash, honk) for 5 vehicles', badge: badge('Active', 'green') },
    { name: 'LG ThinQ API', desc: 'Washer/dryer monitoring and control', badge: badge('Active', 'blue') },
    { name: 'Govee Cloud API', desc: 'RGB lighting control (57 devices)', badge: badge('Active', 'green') },
    { name: 'Anova Developer API', desc: 'Precision oven control via WebSocket', badge: badge('Active', 'blue') },
    { name: 'Glowforge Cloud API', desc: 'Laser cutter status monitoring (undocumented API)', badge: badge('Passive', 'gray') },
    { name: 'FlashForge TCP API', desc: '3D printer control via local TCP proxy', badge: badge('Active', 'blue') },
  ],
};

const DEVICES = {
  'Computers & Kiosks — 4 devices': [
    { name: 'Alpuca — Mac Mini M4', count: 1, desc: 'Primary home server. Apple M4 (10-core: 4P+6E), 24 GB LPDDR5, 256 GB SSD (60 GB free). macOS 26.4. 10-core GPU (Metal 4). Samsung 4K display. Serial C9F44FC69D. IP 192.168.1.200. Runs HAOS VM, 24 LaunchAgents, 10 cron jobs, 3 external drives (rvault20 20TB, RVaultBack1 16TB, Terramass 10TB). SSH: <code>ssh paca@192.168.1.200</code>' },
    { name: 'Rahul M4 Airtop — MacBook Air M4', count: 1, desc: 'Primary dev machine. Apple M4 (10-core: 4P+6E), 24 GB LPDDR5, 512 GB SSD (109 GB free). macOS 26.3.1. Built-in Liquid Retina 2880×1864. Serial MP3QRJVT03. IP 192.168.1.87. Runs Claude Code, Xcode, dev tooling.' },
    { name: 'AlpineMac — MacBook Pro 2015', count: 1, desc: 'Kiosk display machine. Intel Core i5 2.7 GHz (2-core HT), 8 GB DDR3, 128 GB SSD (89 GB free). macOS 12.7.6 Monterey. Retina 2560×1600. Serial C02RFWAYFVH3. IP 192.168.1.61, Tailscale 100.67.3.39. Chrome kiosk auto-launches alpacaplayhouse.com/kiosks/hall/ on login. 114 alpaca screensaver images. SSH: <code>sshpass -p "Pokpok00" ssh alpine@192.168.1.61</code>' },
    { name: 'Entry Alpaca Tablet — Samsung Galaxy Tab A9', count: 1, desc: 'Front hallway entry kiosk. Model SM-X210, Android 16. Kiosk app v260314.0348. WiFi RSSI -44 dBm. Always charging (100%). LAN 192.168.1.239, Tailscale 100.103.110.7. Kiosk API port 2323. Loads alpacaplayhouse.com/kiosks/hall/. BRMesh key 9246 for 5 flood lights. ADB: <code>adb connect 100.103.110.7:5555</code>' },
  ],
  'Lighting — 91 devices': [
    { name: 'WiZ RGB Tunable Bulbs', count: 26, desc: 'WiFi-connected smart bulbs across all rooms + outdoor. Controlled via WiZ Proxy (port 8902) and Home Assistant.' },
    { name: 'Govee Lights', count: 57, desc: '16 light bars + 41 AiDot/OREIN. Groups: Garage Mahal (17), Spartan (14), Outhouse (6), fence/string lights. Cloud API controlled.' },
    { name: 'TP-Link Smart Switches', count: 3, desc: 'KL135 (Cabin 1, .180), HS220 Dimmer (Nook, .101), HS210 (Stair Landing, .230). Local Kasa protocol via HAOS.' },
    { name: 'OREIN Matter Bulbs', count: 5, desc: 'Master Bathroom. Currently blocked in HAOS — need Matter bridge setup.' },
  ],
  'Climate — 3 devices': [
    { name: 'Nest Thermostat — Kitchen', count: 1, desc: 'IP: 192.168.1.139. Google SDM API with OAuth token refresh.' },
    { name: 'Nest Thermostat — Master Bedroom', count: 1, desc: 'IP: 192.168.1.111' },
    { name: 'Nest Thermostat — Skyloft', count: 1, desc: 'IP: 192.168.1.249' },
  ],
  'Audio — 9+ speakers': [
    { name: 'Sonos Speakers', count: 9, desc: 'Zones: Living Sound, Kitchen, Skyloft Sound, DJ Room, Dining Sound, Office, Bedroom, TV Room, Bathroom. Garage Outdoors, Outhouse, Front Outside Sound. Controlled via Sonos HTTP API (port 5005) + HAOS.' },
    { name: 'WiiM Speaker (Spartan)', count: 1, desc: 'LinkPlay compatible speaker in Spartan room.' },
  ],
  'Cameras — 11 devices': [
    { name: 'UniFi Protect Cameras', count: 8, desc: 'On UDM Pro NVR. RTSP streams proxied via go2rtc/MediaMTX for web viewing.' },
    { name: 'Blink Cameras', count: 3, desc: 'Wireless battery cameras. Polled by blink-poller daemon for motion events.' },
  ],
  'Vehicles — 5 Teslas': [
    { name: 'Tesla Fleet', count: 5, desc: 'Monitored by tesla-poller daemon (every 2 hours). Commands: lock, unlock, wake, flash, honk via Tesla Fleet API edge function.' },
  ],
  'Appliances': [
    { name: 'LG Washer/Dryer', count: 2, desc: 'ThinQ API integration with cycle monitoring and laundry_watchers table for notifications.' },
    { name: 'Anova Precision Oven', count: 1, desc: 'WebSocket API for cook start/stop and temperature monitoring.' },
    { name: 'Glowforge Laser Cutter', count: 1, desc: 'Status-only monitoring via undocumented cloud API.' },
    { name: 'FlashForge 3D Printer', count: 1, desc: 'TCP protocol via printer-proxy LaunchAgent.' },
    { name: 'HP ENVY Photo 7800', count: 1, desc: 'Network printer with ink level monitoring via HAOS.' },
  ],
};

const REPOS = [
  {
    name: 'alpacapps',
    desc: 'Main property management platform — admin, resident portal, payment, smart home control, AI assistant (PAI)',
    tech: 'Vanilla HTML/JS + Tailwind v4 + Supabase + GitHub Pages + Capacitor 8',
    stats: '103 dirs · 66 edge functions · 49 shared modules · 36 migrations',
    url: 'https://github.com/rsonnad/alpacapps',
    live: 'https://alpacaplayhouse.com/',
  },
  {
    name: 'finleg',
    desc: 'Financial and legal document management — QuickBooks integration, flow migration automation',
    tech: 'Next.js 16 + React 19 + Tailwind + Supabase + AWS S3',
    stats: 'Hosted on Hostinger VPS',
    url: 'https://github.com/rsonnad/finleg',
  },
  {
    name: 'sponic-garden',
    desc: 'Horticulture and growing project management',
    tech: 'Next.js + Supabase',
    stats: '264 subdirs in branding',
    url: 'https://github.com/rsonnad/sponic-garden',
  },
  {
    name: 'AlpacApps Mobile',
    desc: 'Native iOS + Android app wrapping the web platform with camera feeds, music control, lights, climate, and vehicle tabs',
    tech: 'Capacitor 8 + Vanilla JS',
    stats: 'Located at alpacapps/mobile/',
  },
];

const EDGE_FUNCTION_GROUPS = {
  'Payments (14)': ['process-stripe-payment', 'stripe-payout', 'stripe-webhook', 'stripe-connect-onboard', 'stripe-connect-link', 'process-square-payment', 'square-webhook', 'refund-square-payment', 'paypal-payout', 'paypal-webhook', 'record-payment', 'resolve-payment', 'confirm-deposit-payment', 'event-payment-reminder'],
  'Communications (8)': ['send-email', 'send-sms', 'send-whatsapp', 'resend-inbound-webhook', 'telnyx-webhook', 'approve-email', 'edit-email-template', 'reprocess-pai-email'],
  'Smart Home (12)': ['sonos-control', 'govee-control', 'nest-control', 'nest-token-refresh', 'tesla-command', 'lg-control', 'anova-control', 'glowforge-control', 'printer-control', 'home-assistant-control', 'alexa-room-control', 'gemini-weather'],
  'AI & Documents (6)': ['alpaca-pai', 'verify-identity', 'ask-question', 'vapi-server', 'vapi-webhook', 'error-report'],
  'Account & Auth (3)': ['create-tesla-account', 'stripe-connect-onboard', 'stripe-connect-link'],
  'Scheduling & Sync (7)': ['ical', 'regenerate-ical', 'airbnb-sync', 'generate-daily-fact', 'generate-1099-data', 'weekly-payroll-summary', 'weekly-schedule-report'],
  'Utility (8)': ['api', 'release-info', 'share-space', 'contact-form', 'guestbook-upload', 'w9-submit', 'lesson-nav', 'audit-email-compliance'],
};

const DB_TABLE_GROUPS = [
  { name: 'Core Entities', icon: '🏠', color: '#b8a88a', desc: 'Spaces, people, bookings, media', tables: ['spaces', 'people', 'assignments', 'assignment_spaces', 'media', 'media_spaces', 'media_tags', 'media_tag_assignments', 'app_users', 'user_invitations', 'rental_applications', 'documents', 'document_index'] },
  { name: 'Payments & Accounting', icon: '💳', color: '#059669', desc: 'Payments, ledger, billing config', tables: ['payments', 'ledger_entries', 'api_usage_log', 'square_config', 'stripe_config', 'signwell_config', 'payment_methods', 'pending_payments'] },
  { name: 'Communications', icon: '💬', color: '#2563eb', desc: 'SMS, email, templates', tables: ['sms_messages', 'telnyx_config', 'inbound_emails', 'pending_email_approvals', 'email_type_approval_config', 'email_templates'] },
  { name: 'Smart Home', icon: '🔌', color: '#7c3aed', desc: 'IoT devices, thermostats, vehicles', tables: ['govee_config', 'govee_devices', 'govee_models', 'nest_config', 'nest_devices', 'thermostat_rules', 'tesla_accounts', 'vehicles', 'vehicle_drivers', 'vehicle_rentals', 'lg_config', 'lg_appliances', 'push_tokens', 'laundry_watchers', 'anova_config', 'anova_ovens', 'glowforge_config', 'glowforge_machines', 'printer_config', 'printer_devices', 'camera_streams'] },
  { name: 'Audio & Media', icon: '🎵', color: '#db2777', desc: 'Sonos zones, Spotify, schedules', tables: ['sonos_config', 'sonos_schedules', 'sonos_zones', 'spotify_config'] },
  { name: 'Property Config', icon: '⚙️', color: '#6b7280', desc: 'Brand, weather, storage config', tables: ['brand_config', 'config', 'weather_config', 'r2_config'] },
  { name: 'AI & Automation', icon: '🤖', color: '#f59e0b', desc: 'Prompts, image gen, PAI', tables: ['prompts', 'image_gen_jobs', 'faq_entries', 'pai_config', 'life_of_pai_backstory', 'pai_email_classifications'] },
  { name: 'Events', icon: '📅', color: '#0891b2', desc: 'Events, applications, agreements', tables: ['events', 'event_applications', 'event_templates', 'event_agreements'] },
  { name: 'Documents & Legal', icon: '📄', color: '#64748b', desc: 'Lease & work-trade templates', tables: ['lease_templates', 'worktrade_templates'] },
  { name: 'Admin & Audit', icon: '🛡️', color: '#dc2626', desc: 'Bug reports, features, audit trail', tables: ['bug_reports', 'feature_requests', 'work_entries', 'password_vault', 'audit_log'] },
];

// ── DB Explorer state ──
let _dbActiveGroup = null;
let _dbActiveTable = null;
let _dbRowCounts = {};     // { tableName: count }
let _dbTableData = {};     // { tableName: { columns, rows, totalCount } }

async function fetchTableRowCount(tableName) {
  if (_dbRowCounts[tableName] !== undefined) return _dbRowCounts[tableName];
  try {
    const { count, error } = await supabase.from(tableName).select('*', { count: 'exact', head: true });
    if (error) { _dbRowCounts[tableName] = '?'; return '?'; }
    _dbRowCounts[tableName] = count;
    return count;
  } catch { _dbRowCounts[tableName] = '?'; return '?'; }
}

async function fetchTableDetail(tableName, offset = 0, limit = 25) {
  const cacheKey = `${tableName}:${offset}`;
  if (_dbTableData[cacheKey]) return _dbTableData[cacheKey];
  try {
    const [countRes, dataRes] = await Promise.all([
      supabase.from(tableName).select('*', { count: 'exact', head: true }),
      supabase.from(tableName).select('*').range(offset, offset + limit - 1).limit(limit),
    ]);
    const totalCount = countRes.count ?? '?';
    const rows = dataRes.data || [];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const result = { columns, rows, totalCount, offset, limit };
    _dbTableData[cacheKey] = result;
    _dbRowCounts[tableName] = totalCount;
    return result;
  } catch (e) {
    return { columns: [], rows: [], totalCount: '?', offset, limit, error: e.message };
  }
}

function renderDbGroupCards() {
  const totalTables = DB_TABLE_GROUPS.reduce((s, g) => s + g.tables.length, 0);
  return `
    <div class="inv-section">
      <h3 class="inv-section-title">Database Tables <span class="inv-badge inv-badge-blue">${totalTables}</span></h3>
      <p class="inv-section-sub">Supabase PostgreSQL tables grouped by domain. Click a group to explore tables, then click a table to inspect its schema and data.</p>
      <div class="db-group-grid" id="dbGroupGrid">
        ${DB_TABLE_GROUPS.map((g, i) => `
          <div class="db-group-card${_dbActiveGroup === i ? ' active' : ''}" data-group="${i}" style="--db-accent:${g.color}">
            <div class="db-group-icon">${g.icon}</div>
            <div class="db-group-name">${esc(g.name)}</div>
            <div class="db-group-meta">
              <span>${g.tables.length} tables</span>
              <span class="db-rows" id="dbGroupRows${i}"></span>
            </div>
            <div style="font-size:0.75rem;color:var(--text-muted,#9ca3af);margin-top:0.25rem">${esc(g.desc)}</div>
          </div>
        `).join('')}
      </div>
      <div id="dbTablePanel"></div>
    </div>`;
}

function renderDbTablePanel(groupIdx) {
  const group = DB_TABLE_GROUPS[groupIdx];
  if (!group) return '';
  return `
    <div class="db-table-panel" style="--db-accent:${group.color}">
      <div class="db-table-panel-header">
        <span style="font-size:1.125rem">${group.icon}</span>
        <h4>${esc(group.name)}</h4>
        <span class="inv-badge inv-badge-blue">${group.tables.length} tables</span>
        <button class="db-table-panel-close" id="dbPanelClose">&times;</button>
      </div>
      <div class="db-search-wrap">
        <input type="text" class="db-search" id="dbTableSearch" placeholder="Filter tables...">
      </div>
      <div class="db-table-list" id="dbTableList">
        ${group.tables.map(t => `
          <div class="db-table-item${_dbActiveTable === t ? ' active' : ''}" data-table="${esc(t)}">
            <span class="db-table-item-name">${esc(t)}</span>
            <span class="db-table-item-count" id="dbCount-${esc(t)}">${_dbRowCounts[t] !== undefined ? (_dbRowCounts[t] === '?' ? '—' : _dbRowCounts[t].toLocaleString() + ' rows') : '...'}</span>
            <span class="db-table-item-arrow">›</span>
          </div>
        `).join('')}
      </div>
      <div id="dbDetailPanel"></div>
    </div>`;
}

function renderDbDetail(tableName, data) {
  if (data.error) return `<div class="db-detail-panel"><p style="color:#ef4444">Error: ${esc(data.error)}</p></div>`;
  const { columns, rows, totalCount, offset, limit } = data;

  const colChips = columns.map(c => {
    const isPk = c === 'id';
    const isFk = c.endsWith('_id') && c !== 'id';
    const sampleVal = rows[0]?.[c];
    const inferredType = sampleVal === null ? '' : typeof sampleVal === 'number' ? (Number.isInteger(sampleVal) ? 'int' : 'float') : typeof sampleVal === 'boolean' ? 'bool' : (typeof sampleVal === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sampleVal)) ? 'timestamp' : typeof sampleVal === 'object' ? 'json' : 'text';
    return `<div class="db-col-chip">
      ${isPk ? '<span class="db-col-pk">PK</span>' : ''}${isFk ? '<span class="db-col-fk">FK</span>' : ''}
      <span class="db-col-name">${esc(c)}</span>
      <span class="db-col-type">${inferredType}</span>
    </div>`;
  }).join('');

  const hasData = rows.length > 0;
  const showingEnd = Math.min(offset + rows.length, typeof totalCount === 'number' ? totalCount : offset + rows.length);
  const canPrev = offset > 0;
  const canNext = typeof totalCount === 'number' && (offset + limit) < totalCount;

  let dataTable = '';
  if (hasData) {
    const headerRow = columns.map(c => `<th>${esc(c)}</th>`).join('');
    const bodyRows = rows.map(r => `<tr>${columns.map(c => {
      const v = r[c];
      if (v === null) return '<td class="db-null">null</td>';
      if (typeof v === 'object') return `<td title="${esc(JSON.stringify(v))}">${esc(JSON.stringify(v).slice(0, 60))}${JSON.stringify(v).length > 60 ? '...' : ''}</td>`;
      const s = String(v);
      return `<td title="${esc(s)}">${esc(s.length > 80 ? s.slice(0, 80) + '...' : s)}</td>`;
    }).join('')}</tr>`).join('');
    dataTable = `
      <div class="db-data-wrap">
        <table class="db-data-table"><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>
      </div>
      <div class="db-data-footer">
        <span>Showing ${offset + 1}–${showingEnd} of ${typeof totalCount === 'number' ? totalCount.toLocaleString() : '?'}</span>
        <div style="display:flex;gap:0.375rem">
          ${canPrev ? `<button class="db-detail-btn" data-page-offset="${offset - limit}">← Prev</button>` : ''}
          ${canNext ? `<button class="db-detail-btn" data-page-offset="${offset + limit}">Next →</button>` : ''}
        </div>
      </div>`;
  } else {
    dataTable = '<div class="db-loading">No rows in this table</div>';
  }

  return `
    <div class="db-detail-panel">
      <div class="db-detail-header">
        <h5>${esc(tableName)}</h5>
        ${badge(typeof totalCount === 'number' ? totalCount.toLocaleString() + ' rows' : '—', 'blue')}
        ${badge(columns.length + ' columns', 'gray')}
      </div>
      <div style="margin-bottom:0.5rem;font-size:0.75rem;font-weight:500;color:#6b7280;text-transform:uppercase;letter-spacing:0.03em">Columns</div>
      <div class="db-columns-grid">${colChips}</div>
      <div style="margin-top:1rem;margin-bottom:0.5rem;font-size:0.75rem;font-weight:500;color:#6b7280;text-transform:uppercase;letter-spacing:0.03em">Data Preview</div>
      ${dataTable}
    </div>`;
}

function bindDbExplorerEvents() {
  // Group card clicks
  document.getElementById('dbGroupGrid')?.addEventListener('click', (e) => {
    const card = e.target.closest('.db-group-card');
    if (!card) return;
    const idx = parseInt(card.dataset.group);
    if (_dbActiveGroup === idx) {
      // Toggle off
      _dbActiveGroup = null;
      _dbActiveTable = null;
      card.classList.remove('active');
      document.getElementById('dbTablePanel').innerHTML = '';
      return;
    }
    _dbActiveGroup = idx;
    _dbActiveTable = null;
    document.querySelectorAll('.db-group-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    const panel = document.getElementById('dbTablePanel');
    panel.innerHTML = renderDbTablePanel(idx);
    bindDbTablePanelEvents(idx);
    // Fetch row counts for all tables in group
    const group = DB_TABLE_GROUPS[idx];
    group.tables.forEach(async (t) => {
      const count = await fetchTableRowCount(t);
      const el = document.getElementById(`dbCount-${t}`);
      if (el) el.textContent = count === '?' ? '—' : count.toLocaleString() + ' rows';
    });
  });

  // Lazy-load group row totals
  DB_TABLE_GROUPS.forEach(async (g, i) => {
    let total = 0;
    let allResolved = true;
    for (const t of g.tables) {
      const c = await fetchTableRowCount(t);
      if (typeof c === 'number') total += c; else allResolved = false;
    }
    const el = document.getElementById(`dbGroupRows${i}`);
    if (el) el.textContent = allResolved ? `${total.toLocaleString()} rows` : '';
  });
}

function bindDbTablePanelEvents(groupIdx) {
  // Close button
  document.getElementById('dbPanelClose')?.addEventListener('click', () => {
    _dbActiveGroup = null;
    _dbActiveTable = null;
    document.querySelectorAll('.db-group-card').forEach(c => c.classList.remove('active'));
    document.getElementById('dbTablePanel').innerHTML = '';
  });

  // Search filter
  document.getElementById('dbTableSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#dbTableList .db-table-item').forEach(item => {
      item.style.display = !q || item.dataset.table.includes(q) ? '' : 'none';
    });
  });

  // Table item clicks
  document.getElementById('dbTableList')?.addEventListener('click', async (e) => {
    const item = e.target.closest('.db-table-item');
    if (!item) return;
    const tableName = item.dataset.table;
    if (_dbActiveTable === tableName) {
      _dbActiveTable = null;
      item.classList.remove('active');
      document.getElementById('dbDetailPanel').innerHTML = '';
      return;
    }
    _dbActiveTable = tableName;
    document.querySelectorAll('.db-table-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    const detailEl = document.getElementById('dbDetailPanel');
    detailEl.innerHTML = '<div class="db-loading">Loading table data...</div>';
    const data = await fetchTableDetail(tableName, 0, 25);
    detailEl.innerHTML = renderDbDetail(tableName, data);
    bindDbPaginationEvents(tableName);
  });
}

function bindDbPaginationEvents(tableName) {
  document.getElementById('dbDetailPanel')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-page-offset]');
    if (!btn) return;
    const offset = parseInt(btn.dataset.pageOffset);
    const detailEl = document.getElementById('dbDetailPanel');
    detailEl.innerHTML = '<div class="db-loading">Loading...</div>';
    const data = await fetchTableDetail(tableName, offset, 25);
    detailEl.innerHTML = renderDbDetail(tableName, data);
    bindDbPaginationEvents(tableName);
  });
}

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'inventory',
    requiredRole: 'staff',
    section: 'staff',
    onReady: async () => {
      initSubtabs();
    }
  });
});

// ── Subtab routing ──
function initSubtabs() {
  const hash = location.hash.replace('#', '');
  if (hash && document.getElementById(`inv-panel-${hash}`)) activeSubtab = hash;

  document.querySelectorAll('.inv-subtab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      switchSubtab(btn.dataset.tab);
    });
  });
  switchSubtab(activeSubtab);
}

function switchSubtab(tab) {
  activeSubtab = tab;
  location.hash = tab === 'dashboard' ? '' : tab;

  document.querySelectorAll('.inv-subtab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.inv-panel').forEach(p => {
    p.style.display = p.id === `inv-panel-${tab}` ? '' : 'none';
  });

  if (!loadedTabs.has(tab)) {
    loadedTabs.add(tab);
    const loaders = {
      dashboard: loadDashboard,
      infrastructure: loadInfrastructure,
      data: loadData,
      software: loadSoftware,
      services: loadServices,
      cloud: loadCloud,
      devices: loadDevices,
      codebase: loadCodebase,
    };
    loaders[tab]?.();
  }
}

// ══════════════════════════════════════════════════════════════
// TAB LOADERS
// ══════════════════════════════════════════════════════════════

async function loadDashboard() {
  // Fetch live Supabase table count
  try {
    const tables = ['spaces', 'people', 'assignments', 'payments', 'media', 'events', 'sms_messages', 'bug_reports'];
    const results = await Promise.all(
      tables.map(t => supabase.from(t).select('*', { count: 'exact', head: true }).then(r => ({ table: t, count: r.count ?? '?' })).catch(() => ({ table: t, count: '?' })))
    );
    const total = results.reduce((s, r) => s + (typeof r.count === 'number' ? r.count : 0), 0);
    const el = document.getElementById('statTables');
    if (el) el.innerHTML = `70+<br><span style="font-size:0.6em;font-weight:400">${total.toLocaleString()} rows</span>`;
  } catch (e) {
    console.error('Dashboard stats error:', e);
  }
  // Fetch live device count from devices_unified view
  try {
    const { count } = await supabase.from('devices_unified').select('*', { count: 'exact', head: true });
    const devEl = document.getElementById('statDevices');
    if (devEl && typeof count === 'number') devEl.textContent = count.toLocaleString();
  } catch (e) {
    console.error('Device count error:', e);
  }
}

function loadInfrastructure() {
  const el = document.getElementById('infraContent');
  el.innerHTML = INFRASTRUCTURE.map(i => detailsBlock(i.name, i.meta, i.body)).join('');
}

function loadData() {
  const el = document.getElementById('dataContent');
  el.innerHTML = DATA_ASSETS.map(d => detailsBlock(d.name, d.meta, d.body)).join('');
}

function loadSoftware() {
  const el = document.getElementById('softwareContent');
  el.innerHTML = `<div class="inv-card-grid">${SOFTWARE.map(s => `
    <div class="inv-card">
      <h4>${esc(s.name)}</h4>
      <div class="inv-card-sub">${esc(s.where)}</div>
      <p>${s.desc}</p>
      <div>${s.tags.map(t => `<span class="inv-tag">${esc(t)}</span>`).join('')}</div>
    </div>
  `).join('')}</div>`;
}

let _servicesCache = null;

async function loadServices() {
  const el = document.getElementById('servicesContent');
  el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Loading services...</p>';

  const agentRows = SERVICES_AGENTS.map(s => [
    `<strong>${esc(s.name)}</strong>`,
    s.port ? `<code>${s.port}</code>` : '<span style="color:#9ca3af">—</span>',
    `<code style="font-size:0.7rem">${esc(s.plist)}</code>`,
    esc(s.desc),
  ]);
  const cronRows = CRON_JOBS.map(c => [
    `<strong>${esc(c.schedule)}</strong>`,
    `<code>${esc(c.cmd)}</code>`,
    esc(c.desc),
  ]);

  // Live service connections from DB
  let connectionsHtml = '';
  try {
    const { data, error } = await supabase.from('service_connections').select('*').order('display_order').order('name');
    if (error) throw error;
    _servicesCache = data || [];
    const statusColors = { working: 'green', degraded: 'amber', down: 'red', unknown: 'gray', decommissioned: 'gray' };
    const catColors = { server: 'blue', api: 'purple', storage: 'green', database: 'amber', iot: 'purple', network: 'blue' };
    const statusCounts = {};
    for (const s of _servicesCache) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    const statusSummary = ['working', 'degraded', 'down', 'unknown', 'decommissioned']
      .filter(st => statusCounts[st])
      .map(st => `${badge(statusCounts[st] + ' ' + st, statusColors[st])}`)
      .join(' ');

    // Build categories and protocols for filters
    const categories = [...new Set(_servicesCache.map(s => s.category).filter(Boolean))].sort();
    const protocols = [...new Set(_servicesCache.map(s => s.protocol).filter(Boolean))].sort();

    connectionsHtml = `<div class="inv-section">
      <h3 class="inv-section-title">Service Connections <span class="inv-badge inv-badge-blue">${_servicesCache.length}</span></h3>
      <div style="margin-bottom:0.75rem">${statusSummary}</div>
      <div class="inv-device-filters">
        <input type="text" class="inv-device-search" id="invServiceSearch" placeholder="Search services...">
        <select class="inv-device-select" id="invServiceCategory"><option value="">All Categories</option>${categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
        <select class="inv-device-select" id="invServiceStatus"><option value="">All Status</option><option value="working">Working</option><option value="degraded">Degraded</option><option value="down">Down</option><option value="decommissioned">Decommissioned</option></select>
      </div>
      <div class="inv-table-wrap"><table class="inv-table" id="invServiceTable">
        <thead><tr><th></th><th>Name</th><th>Category</th><th>Host</th><th>Protocol</th><th>Auth</th><th>Tags</th></tr></thead>
        <tbody>${_servicesCache.map(s => {
          const tags = (s.tags || []).slice(0, 3).map(t => `<span class="inv-tag" style="margin-top:0">${esc(t)}</span>`).join(' ');
          const authLabels = { key: 'SSH Key', password: 'Password', token: 'Token', s3_keys: 'S3 Keys', none: 'None' };
          return `<tr data-slug="${esc(s.slug)}" data-category="${esc(s.category || '')}" data-status="${esc(s.status || '')}" data-search="${esc([s.name, s.host, s.protocol, s.category, (s.tags||[]).join(' '), s.notes].join(' ').toLowerCase())}" style="cursor:pointer">
            <td>${badge(s.status || '?', statusColors[s.status] || 'gray')}</td>
            <td><strong>${esc(s.name)}</strong></td>
            <td>${badge(s.category || '', catColors[s.category] || 'gray')}</td>
            <td>${s.host ? `<code style="font-size:0.7rem">${esc(s.host)}${s.port ? ':' + s.port : ''}</code>` : '—'}</td>
            <td>${esc(s.protocol || '')}</td>
            <td>${esc(authLabels[s.auth_method] || s.auth_method || '')}</td>
            <td>${tags}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <div id="invServiceDetail" style="display:none;margin-top:1rem;background:white;border:1px solid var(--border-color,#e5e7eb);border-radius:8px;padding:1.25rem;position:relative;">
        <button onclick="document.getElementById('invServiceDetail').style.display='none'" style="position:absolute;top:0.5rem;right:0.75rem;background:none;border:none;font-size:1.25rem;cursor:pointer;color:var(--text-muted)">&times;</button>
        <div id="invServiceDetailContent"></div>
      </div>
    </div>`;
  } catch (e) { connectionsHtml = `<p style="color:#ef4444">Error: ${esc(e.message)}</p>`; }

  el.innerHTML = `${connectionsHtml}
    <div class="inv-section" style="margin-top: 2rem;">
      <h3 class="inv-section-title">LaunchAgents <span class="inv-badge inv-badge-blue">${SERVICES_AGENTS.length}</span></h3>
      <p class="inv-section-sub">Background services via macOS LaunchAgents.</p>
      ${tableHtml(['Service', 'Port', 'Plist', 'Description'], agentRows)}
    </div>
    <div class="inv-section" style="margin-top: 2rem;">
      <h3 class="inv-section-title">Cron Jobs <span class="inv-badge inv-badge-blue">${CRON_JOBS.length}</span></h3>
      ${tableHtml(['Schedule', 'Command', 'Description'], cronRows)}
    </div>
    <div class="inv-section" style="margin-top: 2rem;">
      <h3 class="inv-section-title">Supabase pg_cron</h3>
      ${tableHtml(['Schedule', 'Job', 'Description'], [
        ['Every 5 min', '<code>sonos-schedule-runner</code>', 'Executes Sonos music schedules'],
        ['Scheduled', '<code>nest-token-refresh</code>', 'Refreshes Google SDM OAuth tokens'],
        ['Daily', '<code>event-payment-reminder</code>', 'Payment reminders for events'],
      ])}
    </div>`;

  // Service connection filters
  const searchEl = document.getElementById('invServiceSearch');
  const catEl = document.getElementById('invServiceCategory');
  const statusEl = document.getElementById('invServiceStatus');
  const filterServiceRows = () => {
    const q = (searchEl?.value || '').toLowerCase();
    const cat = catEl?.value || '';
    const st = statusEl?.value || '';
    document.querySelectorAll('#invServiceTable tbody tr').forEach(row => {
      const matchSearch = !q || (row.dataset.search || '').includes(q);
      const matchCat = !cat || row.dataset.category === cat;
      const matchStatus = !st || row.dataset.status === st;
      row.style.display = (matchSearch && matchCat && matchStatus) ? '' : 'none';
    });
  };
  searchEl?.addEventListener('input', filterServiceRows);
  catEl?.addEventListener('change', filterServiceRows);
  statusEl?.addEventListener('change', filterServiceRows);

  // Row click → detail panel
  document.getElementById('invServiceTable')?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-slug]');
    if (!row || !_servicesCache) return;
    const svc = _servicesCache.find(s => s.slug === row.dataset.slug);
    if (!svc) return;
    const detail = document.getElementById('invServiceDetail');
    const content = document.getElementById('invServiceDetailContent');
    const gotchas = (svc.gotchas || []);
    const tags = (svc.tags || []);
    let cmds = [];
    try { cmds = typeof svc.common_commands === 'string' ? JSON.parse(svc.common_commands) : (svc.common_commands || []); } catch { cmds = []; }

    content.innerHTML = `
      <h3 style="margin:0 0 0.25rem;font-size:1.1rem;font-weight:700">${esc(svc.name)}</h3>
      <div style="font-size:0.75rem;margin-bottom:1rem">${badge(svc.status || '?', {working:'green',degraded:'amber',down:'red'}[svc.status]||'gray')} ${svc.category ? badge(svc.category, 'blue') : ''}</div>
      ${svc.host ? `<div style="font-size:0.8rem;margin-bottom:0.25rem"><strong>Host:</strong> <code>${esc(svc.host)}${svc.port ? ':' + svc.port : ''}</code></div>` : ''}
      ${svc.protocol ? `<div style="font-size:0.8rem;margin-bottom:0.25rem"><strong>Protocol:</strong> ${esc(svc.protocol)}</div>` : ''}
      ${svc.bw_item_name ? `<div style="font-size:0.8rem;margin-bottom:0.25rem"><strong>Credential:</strong> ${esc(svc.bw_item_name)}${svc.bw_field_name ? ' → ' + esc(svc.bw_field_name) : ''}</div>` : ''}
      ${svc.connect_command ? `<div style="margin:0.75rem 0"><div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.25rem">Connect Command</div><pre style="background:#1e1e2e;color:#cdd6f4;padding:0.75rem;border-radius:6px;font-size:0.72rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all">${esc(svc.connect_command)}</pre></div>` : ''}
      ${cmds.length ? `<div style="margin:0.75rem 0"><div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.25rem">Common Commands</div>${cmds.map(c => `<div style="background:var(--bg-muted,#f5f4ef);border:1px solid var(--border-color,#e5e7eb);border-radius:6px;padding:0.5rem 0.75rem;margin-bottom:0.35rem"><div style="font-size:0.7rem;font-weight:600;color:var(--text-muted)">${esc(c.label)}</div><code style="font-size:0.7rem">${esc(c.command)}</code></div>`).join('')}</div>` : ''}
      ${gotchas.length ? `<div style="margin:0.75rem 0"><div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.25rem">Gotchas</div>${gotchas.map(g => `<div style="font-size:0.78rem;margin-bottom:0.25rem">⚠ ${esc(g)}</div>`).join('')}</div>` : ''}
      ${svc.notes ? `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.5rem">${esc(svc.notes)}</div>` : ''}
      ${tags.length ? `<div style="margin-top:0.5rem">${tags.map(t => `<span class="inv-tag">${esc(t)}</span>`).join(' ')}</div>` : ''}
    `;
    detail.style.display = '';
  });
}

function loadCloud() {
  const el = document.getElementById('cloudContent');
  el.innerHTML = Object.entries(CLOUD_SERVICES).map(([group, items]) => `
    <div class="inv-section">
      <h3 class="inv-section-title">${esc(group)}</h3>
      ${tableHtml(['Service', 'Description', 'Status'], items.map(i => [
        `<strong>${esc(i.name)}</strong>`,
        esc(i.desc),
        i.badge,
      ]))}
    </div>
  `).join('');
}

// ── Live device loading ──
const DOMAIN_LABELS = { lighting: 'Lighting', climate: 'Climate', appliance: 'Appliance', security: 'Security', vehicle: 'Vehicle' };
const DOMAIN_ICONS = { lighting: '💡', climate: '🌡️', appliance: '🧺', security: '📹', vehicle: '🚗' };
const PROTOCOL_LABELS = { light_api: 'Light API', govee_lan: 'Govee LAN', nest_sdm: 'Nest SDM', lg_thinq: 'LG ThinQ', rtsp: 'RTSP', tesla_api: 'Tesla API' };
let _devicesCache = null, _recipesCache = null, _lightingCache = null, _deviceView = 'all';

async function loadDevices() {
  const el = document.getElementById('devicesContent');
  el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Loading devices...</p>';

  document.querySelectorAll('#deviceViewToggle .inv-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _deviceView = btn.dataset.view;
      document.querySelectorAll('#deviceViewToggle .inv-view-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderDeviceView();
    });
  });

  try {
    const [devRes, recRes] = await Promise.all([
      supabase.from('devices_unified').select('*'),
      supabase.from('device_control_recipes').select('*').order('display_order'),
    ]);
    if (devRes.error) throw devRes.error;
    if (recRes.error) throw recRes.error;
    _devicesCache = devRes.data || [];
    _recipesCache = recRes.data || [];
    renderDeviceView();
  } catch (e) {
    el.innerHTML = `<p style="color:#ef4444;padding:1rem">Error: ${esc(e.message)}</p>`;
  }
}

function renderDeviceView() {
  if (_deviceView === 'lighting') renderLightingDetail();
  else renderAllDevices();
}

function renderAllDevices() {
  const el = document.getElementById('devicesContent');
  const devices = (_devicesCache || []).filter(d => d.is_active);
  const recipes = _recipesCache || [];
  const recipeMap = {};
  for (const r of recipes) {
    const key = `${r.device_table}:${r.device_id}`;
    if (!recipeMap[key]) recipeMap[key] = [];
    recipeMap[key].push(r);
  }

  const groups = {};
  const rooms = new Set();
  const protocols = new Set();
  for (const d of devices) {
    if (!groups[d.domain]) groups[d.domain] = [];
    const devWithRecipes = { ...d, recipes: recipeMap[`${d.source_table}:${d.id}`] || [] };
    groups[d.domain].push(devWithRecipes);
    if (d.room) rooms.add(d.room);
    if (d.protocol) protocols.add(d.protocol);
  }

  const domainOrder = ['lighting', 'climate', 'appliance', 'security', 'vehicle'];
  const sortedRooms = [...rooms].sort();
  const sortedProtocols = [...protocols].sort();

  // Filter bar (inside dark wrapper)
  let html = `<div class="inv-dev-wrap"><div class="inv-dev-filters">
    <input type="text" id="invDevSearch" placeholder="Search devices...">
    <select id="invDevDomain"><option value="">All Domains</option>${domainOrder.filter(d => groups[d]).map(d => `<option value="${d}">${DOMAIN_LABELS[d]}</option>`).join('')}</select>
    <select id="invDevRoom"><option value="">All Rooms</option>${sortedRooms.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
    <select id="invDevProtocol"><option value="">All Protocols</option>${sortedProtocols.map(p => `<option value="${p}">${esc(PROTOCOL_LABELS[p] || p)}</option>`).join('')}</select>
  </div>`;

  // Grouped table
  html += `<div class="inv-table-wrap"><table class="inv-table" id="invDeviceTable">
    <thead><tr><th style="width:1.5rem"></th><th>Name</th><th>Room</th><th>Protocol</th><th style="width:4.5rem;text-align:center">Recipes</th></tr></thead>
    <tbody>`;

  for (const domain of domainOrder) {
    const items = groups[domain];
    if (!items?.length) continue;
    // Group header row
    html += `<tr class="inv-dev-group-header" data-domain="${domain}">
      <td colspan="5">
        <div class="inv-dev-group-inner">
          <span class="inv-dev-chevron">▾</span>
          <span class="inv-dev-accent inv-dev-accent-${domain}"></span>
          <span>${DOMAIN_ICONS[domain]} ${DOMAIN_LABELS[domain]}</span>
          <span class="inv-dev-group-count">${items.length} device${items.length !== 1 ? 's' : ''}</span>
        </div>
      </td>
    </tr>`;

    for (const d of items) {
      const rc = d.recipes.length;
      const searchStr = [d.name, d.room, d.domain, d.protocol, ...(d.recipes.map(r => r.action))].join(' ').toLowerCase();
      html += `<tr class="inv-dev-row" data-domain="${d.domain}" data-room="${esc(d.room || '')}" data-protocol="${d.protocol || ''}" data-search="${esc(searchStr)}" data-device-id="${d.source_table}:${d.id}">
        <td><span class="inv-dev-status inv-dev-status-active"></span></td>
        <td><strong>${esc(d.name)}</strong></td>
        <td>${esc(d.room || '')}</td>
        <td>${d.protocol ? `<span class="inv-dev-proto-badge">${esc(PROTOCOL_LABELS[d.protocol] || d.protocol)}</span>` : ''}</td>
        <td style="text-align:center">${rc > 0
          ? `<span class="inv-dev-recipe-count has-recipes">${rc}</span>`
          : `<span class="inv-dev-recipe-count no-recipes">—</span>`}</td>
      </tr>`;

      // Expandable recipe sub-row (hidden by default)
      if (rc > 0) {
        html += `<tr class="inv-dev-expand-row" data-domain="${d.domain}" data-room="${esc(d.room || '')}" data-protocol="${d.protocol || ''}" style="display:none">
          <td colspan="5"><div class="inv-dev-expand-inner">`;
        for (const r of d.recipes) {
          const tags = (r.tags || []).map(t => `<span class="inv-dev-recipe-tag">${esc(t)}</span>`).join('');
          const verified = r.last_verified_at ? new Date(r.last_verified_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
          html += `<div class="inv-dev-recipe-item">
            <span class="inv-dev-recipe-action">${esc(r.action)}</span>
            <span class="inv-dev-recipe-proto">${esc(r.protocol || '')}</span>
            <span class="inv-dev-recipe-cmd" title="${esc(r.command_template || '')}">${esc((r.command_template || '').slice(0, 80))}</span>
            ${tags ? `<span>${tags}</span>` : ''}
            ${r.gotchas ? `<span class="inv-dev-recipe-gotcha">⚠ ${esc(r.gotchas)}</span>` : ''}
            ${verified ? `<span class="inv-dev-recipe-verified">✓ ${verified}</span>` : ''}
          </div>`;
        }
        html += `</div></td></tr>`;
      }
    }
  }
  html += '</tbody></table></div>';
  html += `<div class="inv-dev-summary">${devices.length} devices across ${domainOrder.filter(d => groups[d]).length} domains · ${[...rooms].length} rooms</div>`;
  html += '</div>'; // close .inv-dev-wrap
  el.innerHTML = html;

  // Group header collapse/expand
  el.querySelectorAll('.inv-dev-group-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const collapsed = hdr.classList.toggle('collapsed');
      const chevron = hdr.querySelector('.inv-dev-chevron');
      if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
      let s = hdr.nextElementSibling;
      while (s && !s.classList.contains('inv-dev-group-header')) {
        s.style.display = collapsed ? 'none' : '';
        s = s.nextElementSibling;
      }
    });
  });

  // Row expand/collapse on click
  el.querySelectorAll('.inv-dev-row').forEach(row => {
    row.addEventListener('click', () => {
      const expandRow = row.nextElementSibling;
      if (!expandRow || !expandRow.classList.contains('inv-dev-expand-row')) return;
      const isOpen = expandRow.style.display !== 'none';
      expandRow.style.display = isOpen ? 'none' : '';
      row.style.background = isOpen ? '' : '#f9fafb';
    });
  });

  // Filtering
  const searchEl = document.getElementById('invDevSearch');
  const domainEl = document.getElementById('invDevDomain');
  const roomEl = document.getElementById('invDevRoom');
  const protoEl = document.getElementById('invDevProtocol');
  const filterAll = () => {
    const q = (searchEl?.value || '').toLowerCase();
    const dom = domainEl?.value || '';
    const room = roomEl?.value || '';
    const proto = protoEl?.value || '';

    // Track which group headers should show
    const groupVis = {};

    document.querySelectorAll('#invDeviceTable tbody tr.inv-dev-row').forEach(row => {
      const show = (!q || (row.dataset.search || '').includes(q))
        && (!dom || row.dataset.domain === dom)
        && (!room || row.dataset.room === room)
        && (!proto || row.dataset.protocol === proto);
      row.style.display = show ? '' : 'none';
      // Hide expand row too when filtering
      const expandRow = row.nextElementSibling;
      if (expandRow?.classList.contains('inv-dev-expand-row')) {
        expandRow.style.display = 'none';
        row.style.background = '';
      }
      if (show) groupVis[row.dataset.domain] = true;
    });

    // Show/hide group headers based on whether any child rows are visible
    document.querySelectorAll('#invDeviceTable tbody tr.inv-dev-group-header').forEach(hdr => {
      hdr.style.display = groupVis[hdr.dataset.domain] ? '' : 'none';
    });
  };
  searchEl?.addEventListener('input', filterAll);
  domainEl?.addEventListener('change', filterAll);
  roomEl?.addEventListener('change', filterAll);
  protoEl?.addEventListener('change', filterAll);
}

async function renderLightingDetail() {
  const el = document.getElementById('devicesContent');
  el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Loading lighting details...</p>';
  try {
    if (!_lightingCache) {
      const [devRes, modelsRes] = await Promise.all([
        supabase.from('govee_devices').select('*').eq('is_active', true).order('area').order('name'),
        supabase.from('govee_models').select('sku, model_name'),
      ]);
      if (devRes.error) throw devRes.error;
      const models = new Map((modelsRes.data || []).map(m => [m.sku, m.model_name]));
      _lightingCache = (devRes.data || []).map(d => ({ ...d, model_name: models.get(d.sku) || d.sku || '' }));
    }
    const groups = _lightingCache.filter(d => d.is_group);
    const individuals = _lightingCache.filter(d => !d.is_group);

    let html = `<div style="margin-bottom:0.75rem;font-size:0.8rem;color:var(--text-muted)">${groups.length} groups · ${individuals.length} individual devices</div>
      <div class="inv-device-filters"><input type="text" class="inv-device-search" id="invLightSearch" placeholder="Search lighting..."></div>`;

    html += `<div class="inv-section"><h3 class="inv-section-title">Light Groups <span class="inv-badge inv-badge-blue">${groups.length}</span></h3>
      ${tableHtml(['Group', 'Area', 'Devices'], groups.map(g => {
        const kids = individuals.filter(i => i.parent_group_id === g.device_id);
        return [`<strong>${esc(g.name)}</strong>`, esc(g.area || ''), String(kids.length)];
      }))}</div>`;

    html += `<div class="inv-section" style="margin-top:1.5rem"><h3 class="inv-section-title">Individual Devices <span class="inv-badge inv-badge-blue">${individuals.length}</span></h3>
      ${tableHtml(['Name', 'Area', 'Model', 'SKU', 'Group'], individuals.map(d => {
        const pg = groups.find(g => g.device_id === d.parent_group_id);
        return [`<strong>${esc(d.name)}</strong>`, esc(d.area || ''), esc(d.model_name), `<code style="font-size:0.7rem">${esc(d.sku || '')}</code>`, pg ? esc(pg.name) : '<span style="color:#d1d5db">—</span>'];
      }))}</div>`;

    el.innerHTML = html;
    const searchEl = document.getElementById('invLightSearch');
    searchEl?.addEventListener('input', () => {
      const q = searchEl.value.toLowerCase();
      el.querySelectorAll('.inv-table tbody tr').forEach(row => {
        row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  } catch (e) {
    el.innerHTML = `<p style="color:#ef4444;padding:1rem">Error: ${esc(e.message)}</p>`;
  }
}

function loadCodebase() {
  const el = document.getElementById('codebaseContent');

  const repoCards = REPOS.map(r => `
    <div class="inv-card">
      <h4>${esc(r.name)} ${r.url ? `<a href="${r.url}" target="_blank" style="font-size:0.75rem;color:var(--accent,#b8a88a)">GitHub</a>` : ''}</h4>
      <div class="inv-card-sub">${esc(r.tech)}</div>
      <p>${esc(r.desc)}</p>
      <p style="margin-top:0.5rem;font-size:0.75rem;color:#6b7280">${esc(r.stats)}</p>
      ${r.live ? `<p style="margin-top:0.25rem"><a href="${r.live}" target="_blank" style="font-size:0.75rem;color:var(--accent,#b8a88a)">${r.live}</a></p>` : ''}
    </div>
  `).join('');

  const fnSection = Object.entries(EDGE_FUNCTION_GROUPS).map(([group, fns]) =>
    detailsBlock(group, `${fns.length} functions`, `<p>${fns.map(f => `<code style="font-size:0.75rem;margin:0.125rem;display:inline-block;padding:0.125rem 0.375rem;background:#f3f4f6;border-radius:4px">${esc(f)}</code>`).join(' ')}</p>`)
  ).join('');

  el.innerHTML = `
    <div class="inv-section">
      <h3 class="inv-section-title">Repositories</h3>
      <div class="inv-card-grid">${repoCards}</div>
    </div>
    <div class="inv-section">
      <h3 class="inv-section-title">Edge Functions <span class="inv-badge inv-badge-blue">66</span></h3>
      <p class="inv-section-sub">Supabase Deno edge functions organized by domain.</p>
      ${fnSection}
    </div>
    ${renderDbGroupCards()}
  `;
  bindDbExplorerEvents();
}
