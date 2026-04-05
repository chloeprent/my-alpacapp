# Server Setup

For running bots, workers, pollers, and background automation.

---

## DigitalOcean Droplet

### Ask User

> If you already have a DigitalOcean droplet:
> 1. Paste the **droplet IPv4 address**
> 2. Paste the **SSH key path** (e.g., `~/.ssh/id_rsa` or `~/.ssh/do_key`)
> 3. What **SSH user** do you connect as? (e.g., `root`)
>
> If you need a new droplet, create one at https://cloud.digitalocean.com/droplets/new
> — recommended: Ubuntu 22.04, Basic plan, $12/mo (2 GB / 1 vCPU)

### Then

1. Test SSH: `ssh -o ConnectTimeout=5 -i {KEY_PATH} {USER}@{IP} "echo connected"`
2. If running services that clone the repo, configure git permissions:
   ```bash
   ssh -i {KEY_PATH} {USER}@{IP} "cd /path/to/repo && git config core.sharedRepository group"
   ```
3. Ensure repo is owned by correct service user:
   ```bash
   ssh -i {KEY_PATH} {USER}@{IP} "chown -R {SERVICE_USER}:{SERVICE_USER} /path/to/repo/.git"
   ```
4. Append to CLAUDE.md: droplet role (bots, workers), repo clone for automation
5. Append to CLAUDE.local.md:
   - IP, SSH command, OS/specs, cost
   - **If SSH uses password auth** (no key): use password file — document `sshpass -f ~/.ssh/alpacapps-<service>.pass ssh ...` and one-time setup: `echo 'BASE64' | base64 -d > ~/.ssh/alpacapps-<service>.pass && chmod 600 ~/.ssh/alpacapps-<service>.pass`. Store the password base64 in CLAUDE.local.md so the password never appears on the command line (see "Passwords and shell escaping" in initial scaffold).
   - Service users and working directories
   - Repo paths with `core.sharedRepository=group` note
   - Troubleshooting: ownership fix for `.git/objects`

### Common Workers

Typical systemd services to set up on a droplet:
- **Bot service** — Discord/Slack bot (runs as dedicated user)
- **Poller service** — Polls external APIs on interval (Tesla, LG, etc.)
- **Worker service** — Processes job queue (image gen, bug fixing, etc.)

Each service needs:
- `.env` file with API keys (in working directory)
- systemd unit file (ExecStart, WorkingDirectory, User, Restart=always)
- Log access: `journalctl -u {service} -f`

---

## Oracle Cloud Always Free (Alternative to DigitalOcean)

4 Ampere Altra cores, 24 GB RAM, 200 GB storage — genuinely free forever.

### Ask User

> If you already have an Oracle Cloud instance:
> 1. Paste the **instance public IP**
> 2. Paste the **SSH key path** (e.g., `~/.ssh/oracle_key`)
> 3. What **SSH user**? (usually `ubuntu`)
>
> If you need a new instance:
> 1. Sign up at https://cloud.oracle.com (credit card required, never charged)
> 2. Create ARM instance: Compute → Create Instance
>    - Image: Ubuntu 22.04
>    - Shape: VM.Standard.A1.Flex (4 OCPU, 24 GB RAM)
>    - Boot volume: 200 GB
> 3. Download SSH private key or add your public key
> 4. Note the public IP
> 5. **Important:** Open ports in security list:
>    Networking → Virtual Cloud Networks → your VCN → Security Lists →
>    add ingress rules for ports 22 (SSH), 80/443 (HTTP/S)

### Then

1. Test SSH: `ssh -o ConnectTimeout=5 -i {KEY_PATH} {USER}@{IP} "echo connected"`
2. Install dependencies:
   ```bash
   # Node.js 20
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # Git (should be pre-installed on Ubuntu)
   sudo apt-get install -y git
   ```
3. Clone repo: `git clone https://github.com/{OWNER}/{REPO}.git /opt/{PROJECT}`
4. Set up systemd services for workers
5. Install Tailscale (if bridging to local LAN):
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
6. Set up Caddy reverse proxy (if needed for camera/media proxying)
7. Append to CLAUDE.md: Oracle Cloud specs, services, Tailscale mesh
8. Append to CLAUDE.local.md: login credentials, Cloud Account Name, console URL, IP, SSH command. **If the instance uses password auth** (e.g. before key is set): use password file and base64 as in "Passwords and shell escaping"; document `sshpass -f ~/.ssh/alpacapps-oracle.pass ssh ...` and one-time file setup.

### Oracle vs DigitalOcean Comparison

| Feature | Oracle Cloud | DigitalOcean |
|---------|-------------|--------------|
| Cost | $0/month (Always Free) | $12-24/month |
| CPU | 4 ARM cores | 1-2 Intel vCPUs |
| RAM | 24 GB | 2-4 GB |
| Storage | 200 GB | 60-120 GB |
| Architecture | ARM64 (aarch64) | x86_64 |
| Setup complexity | Higher (VCN, security lists) | Lower (simple droplet) |

**Note:** ARM architecture means some npm packages may need recompilation. Most pure JS packages work fine. C/C++ addons need ARM builds.
