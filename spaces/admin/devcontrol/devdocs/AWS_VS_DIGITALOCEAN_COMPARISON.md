# AWS vs DigitalOcean: Cost & Features Comparison

**Context:** This compares hosting our current **DigitalOcean droplet** workload (workers, bot, proxies) on **Amazon AWS** — for cost, features, and migration effort.

**Current DO setup (from CLAUDE.md / ARCHITECTURE.md):** One droplet (~$12–24/mo), workers (Bug Scout, Feature Builder, Tesla/LG/Image Gen pollers, OpenClaw), Caddy, nginx, Tailscale, Puppeteer, Ubuntu + Node + systemd.

---

## 3-column comparison (DigitalOcean | AWS)

### Cost — monthly plans (like-for-like)

| Tier / Specs | DigitalOcean | AWS |
|--------------|--------------|-----|
| **Entry (2 GB)** | Basic Droplet: 1 vCPU, 2 GB RAM, 50 GB SSD — **$12/mo** | Lightsail: 2 vCPU, 2 GB, 60 GB SSD, 3 TB — **$12/mo**. EC2 t3.small + EBS ≈ **$18–22/mo** |
| **Recommended (4 GB)** | Basic Droplet: 2 vCPU, 4 GB RAM, 80 GB SSD — **$24/mo** | Lightsail: 2 vCPU, 4 GB, 80 GB SSD, 4 TB — **$24/mo**. EC2 t3.medium + EBS ≈ **$35–48/mo** |
| **What’s included** | Transfer 2–4 TB, SSD, no extra for static IP | Lightsail: same idea (transfer, SSD, static IP). EC2: EBS + Elastic IP + pay-for-transfer after 100 GB |

### Features & operations

| Aspect | DigitalOcean | AWS |
|--------|--------------|-----|
| **Simplicity** | Very simple: droplet, SSH, firewall | Lightsail: simple (instance, SSH, firewall). EC2: more complex (VPC, security groups, IAM) |
| **Pricing model** | Fixed $/mo per droplet | Lightsail: fixed $/mo. EC2: on-demand / Reserved / Savings Plans + EBS + transfer |
| **Static IP** | Included | Lightsail: included. EC2: Elastic IP (free while attached) |
| **Transfer** | 2–4 TB included (plan-dependent) | Lightsail: 2–4 TB included. EC2: first 100 GB out free, then ~$0.09/GB (us-east-1) |
| **Regions** | Fewer, simple | Many regions; Lightsail and full EC2 in most |
| **Integrations** | App Platform, Spaces, DBs | Lambda, S3, RDS, SQS, EventBridge, etc. (especially with EC2/VPC) |
| **Backups / snapshots** | Droplet snapshots (paid) | Lightsail: instance snapshots. EC2: EBS snapshots, AMIs, more automation |
| **Scaling** | Manual (resize droplet) | Lightsail: manual. EC2: Auto Scaling, Load Balancer, etc. |
| **Tailscale / VPN** | Works (install on droplet) | Works (install on instance) |
| **Puppeteer / Chromium** | Works | Works (same Linux) |

### Minimum cost that supports our current infra

| Question | DigitalOcean | AWS |
|----------|--------------|-----|
| **Minimum monthly cost** | **$12/mo** (2 GB) or **$24/mo** (4 GB recommended) | **$12/mo** (Lightsail 2 GB) or **$24/mo** (Lightsail 4 GB). EC2: ~$18–48/mo depending on size |
| **Easiest match to DO** | — | Lightsail ($12 or $24), same “one VM, fixed price” model |

---

## 1. Cost summary

- **DO and Lightsail** line up: $12 (2 GB) and $24 (4 GB) with transfer + SSD + static IP.
- **EC2** is variable: ~$18–22 (t3.small) or ~$35–48 (t3.medium) once you add EBS and transfer.
- **Minimum AWS that supports our stack:** **~$12/mo** (Lightsail 2 GB); **~$24/mo** (Lightsail 4 GB) recommended for Puppeteer + 5 workers.

---

## 4. How easily can we set up AWS and migrate?

### Ease of setup: **Easy (Lightsail) to Moderate (EC2)**

- **Lightsail:** Create AWS account → Create instance (Ubuntu) → SSH in. Comparable to creating a DO droplet. No VPC/security-group setup required for a single instance.
- **EC2:** Create VPC (or use default), launch instance, security groups, EBS, Elastic IP. More steps, more concepts.

### Migration effort: **Low to moderate (same “one VM” approach)**

Your workload is **one Linux VM** with:

- systemd units (bug-fixer, feature-builder, tesla-poller, image-gen, lg-poller, OpenClaw)
- Node.js workers
- Caddy + nginx
- Tailscale
- Puppeteer
- Git clone of repo

**No application code changes** are required if you keep the same architecture (one VM). Migration steps:

1. **Create AWS instance** (Lightsail or EC2) — Ubuntu 22.04 LTS, same size as current (2 GB or 4 GB).
2. **Install stack:** Node, Caddy, nginx, Tailscale, Chromium (for Puppeteer). Copy or re-run your existing `install.sh` / setup scripts for each worker.
3. **Copy config and code:** Clone repo, copy env files, Caddyfile, nginx config, systemd unit files from DO droplet.
4. **Tailscale:** Install Tailscale on the new instance, re-auth, re-enable subnet routing from Alpaca Mac if needed. Same Tailnet, new node.
5. **DNS:** Point `cam.alpacaplayhouse.com` (and any other A records pointing at the DO IP) to the **new instance’s static IP** (Lightsail static IP or EC2 Elastic IP).
6. **Secrets / config:** Update Supabase (or wherever) with new **SONOS_PROXY_URL** (e.g. `http://NEW_IP:8055/sonos`). Update any other URLs or IPs that reference the old droplet.
7. **Test:** Run each worker, test Sonos proxy, camera proxy, Bug Scout (including Puppeteer), Feature Builder, pollers.
8. **Cut over:** When satisfied, stop workers on DO, leave AWS as primary. Optionally keep DO droplet for a few days as fallback.

**Estimated time:** Half a day to one day for someone familiar with the current setup, assuming no surprises with Tailscale or DNS.

**Gotchas:**

- **Tailscale:** New machine = new Tailscale node; subnet routes and firewall rules may need to be re-approved.
- **Puppeteer:** On minimal 2 GB instances, Chromium can OOM under load; 4 GB is safer.
- **IP/URL updates:** Any hardcoded droplet IP (e.g. in Supabase secrets, docs) must be updated to the new AWS IP.

---

## 5. When to choose which

- **Stay on DigitalOcean if:** You’re happy with cost and reliability; you don’t need AWS-specific services; you want to minimize change.
- **Move to AWS Lightsail if:** You want the same simple, fixed-price VM but inside the AWS ecosystem (e.g. future use of S3, Lambda, or other AWS services), or for org/billing reasons. **Same cost as DO** ($12 or $24/mo) for equivalent specs.
- **Use EC2 instead of Lightsail if:** You need more control (VPC, security groups, specific instance types) or plan to add other AWS resources (Lambda, SQS, etc.) that talk to this VM. **Higher minimum** (~$18–35/mo for 2–4 GB) and more setup.

---

## 6. Summary (3-column)

| Topic | DigitalOcean | AWS |
|-------|--------------|-----|
| **Minimum cost for our infra** | $12/mo (2 GB) or $24/mo (4 GB) | ~$12/mo (Lightsail 2 GB) or ~$24/mo (Lightsail 4 GB); EC2 ~$18–48/mo |
| **Easiest option** | Single droplet | Lightsail — same “one VM, fixed price” as DO |
| **Setup difficulty** | Simple | Lightsail: easy. EC2: moderate (VPC, security groups, EBS) |
| **Migration (DO → AWS)** | — | Low–moderate: same OS/services; copy configs, switch DNS/secrets; no app code changes for one VM |
| **Features for our stack** | Single-VM, predictable | Roughly equivalent; AWS adds Lambda, S3, RDS, etc. if you need them later |

---

*Doc generated for AlpacApps droplet migration planning. Pricing and product names are as of 2025; confirm on DO and AWS pricing pages before committing.*
