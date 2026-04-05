#!/usr/bin/env node
/**
 * Site Health Test Suite — AlpacApps
 *
 * Tests page loads, camera feeds, device inventory, and Supabase health.
 * Runs via Node.js with zero dependencies (uses native fetch).
 *
 * Usage:
 *   node devdocs/tests/site-health.js              # run all tests
 *   node devdocs/tests/site-health.js --pages      # page load tests only
 *   node devdocs/tests/site-health.js --devices    # device tests only
 *   node devdocs/tests/site-health.js --cameras    # camera tests only
 *   node devdocs/tests/site-health.js --json       # output JSON results
 *
 * Pipe to local LLM for natural-language summary:
 *   node devdocs/tests/site-health.js --json | ollama run qwen3.5:9b-q8_0 "Summarize these test results. Flag anything broken."
 */

const SITE_BASE = 'https://alpacaplayhouse.com';
const SUPABASE_URL = 'https://aphrrfprbixmhissnjfn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwaHJyZnByYml4bWhpc3NuamZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5MzA0MjUsImV4cCI6MjA4NTUwNjQyNX0.yYkdQIq97GQgxK7yT2OQEPi5Tt-a7gM45aF8xjSD6wk';

// ── Helpers ──────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const jsonMode = args.delete('--json');
const runAll = !args.has('--pages') && !args.has('--devices') && !args.has('--cameras');

const results = { passed: 0, failed: 0, warnings: 0, tests: [] };

function record(category, name, status, detail = '') {
  results.tests.push({ category, name, status, detail });
  if (status === 'PASS') results.passed++;
  else if (status === 'FAIL') results.failed++;
  else if (status === 'WARN') results.warnings++;
  if (!jsonMode) {
    const icon = status === 'PASS' ? '\x1b[32m✓\x1b[0m' : status === 'FAIL' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m!\x1b[0m';
    console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function fetchOk(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, statusText: e.message };
  }
}

async function supabaseQuery(table, select = '*', filters = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${filters}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status} ${res.statusText}`);
  return res.json();
}

// ── A. Page Load Tests ──────────────────────────────────────
const PAGES = [
  // Public
  '/',
  '/login/',
  '/contact/',
  '/visiting/',
  '/waiver/',
  '/pay/',
  '/spaces/',
  '/spaces/apply/',
  '/events/',
  '/docs/getting-started.html',
  '/docs/alpacappsinfra.html',
  // Resident portal
  '/residents/',
  '/residents/devices.html',
  '/residents/cameras.html',
  '/residents/lighting.html',
  '/residents/sonos.html',
  '/residents/climate.html',
  '/residents/cars.html',
  '/residents/appliances.html',
  '/residents/sensors.html',
  '/residents/media.html',
  '/residents/profile.html',
  // Admin
  '/spaces/admin/',
  '/spaces/admin/spaces.html',
  '/spaces/admin/users.html',
  '/spaces/admin/rentals.html',
  '/spaces/admin/accounting.html',
  '/spaces/admin/passwords.html',
  '/spaces/admin/media.html',
  '/spaces/admin/inventory.html',
  '/spaces/admin/devcontrol/',
  '/spaces/admin/settings.html',
  // Infra
  '/infra/',
  '/infra/setup-guide.html',
  // Dev docs
  '/spaces/admin/devcontrol/devdocs/',
  // Kiosk
  '/kiosks/hall/',
];

async function testPages() {
  if (!jsonMode) console.log('\n\x1b[1m📄 Page Load Tests\x1b[0m');

  const batchSize = 10;
  for (let i = 0; i < PAGES.length; i += batchSize) {
    const batch = PAGES.slice(i, i + batchSize);
    await Promise.all(batch.map(async (path) => {
      const url = `${SITE_BASE}${path}`;
      const res = await fetchOk(url);
      if (res.ok) {
        const text = await res.text?.() || '';
        const hasTitle = /<title>[^<]+<\/title>/.test(text);
        const hasVersion = /data-site-version/.test(text);
        if (!hasTitle) {
          record('pages', path, 'WARN', 'missing <title>');
        } else if (!hasVersion) {
          record('pages', path, 'WARN', 'missing version tag');
        } else {
          record('pages', path, 'PASS');
        }
      } else {
        record('pages', path, 'FAIL', `HTTP ${res.status || 'timeout'}`);
      }
    }));
  }
}

// ── B. Camera Feed Tests ────────────────────────────────────
async function testCameras() {
  if (!jsonMode) console.log('\n\x1b[1m📹 Camera Feed Tests\x1b[0m');

  try {
    const cameras = await supabaseQuery('camera_streams', '*', '&is_active=eq.true&order=camera_name,quality');

    if (!cameras.length) {
      record('cameras', 'Active cameras exist', 'FAIL', 'no active cameras found');
      return;
    }
    record('cameras', `Active cameras found`, 'PASS', `${cameras.length} streams`);

    // Group by camera name
    const byName = {};
    for (const c of cameras) {
      if (!byName[c.camera_name]) byName[c.camera_name] = [];
      byName[c.camera_name].push(c);
    }

    for (const [name, streams] of Object.entries(byName)) {
      // Check quality tiers
      const qualities = streams.map(s => s.quality);
      const hasAll3 = ['low', 'medium', 'high'].every(q => qualities.includes(q));
      if (hasAll3) {
        record('cameras', `${name}: 3 quality tiers`, 'PASS');
      } else {
        record('cameras', `${name}: quality tiers`, 'WARN', `only: ${qualities.join(', ')}`);
      }

      // Check for stream URL
      const hasUrl = streams.some(s => s.proxy_base_url || s.protect_share_url);
      record('cameras', `${name}: has stream URL`, hasUrl ? 'PASS' : 'FAIL');
    }
  } catch (e) {
    record('cameras', 'Camera query', 'FAIL', e.message);
  }
}

// ── C. Device Inventory Tests ───────────────────────────────
const DEVICE_TABLES = [
  { table: 'govee_devices', label: 'Govee Lights', filter: '&is_active=eq.true&is_group=eq.true', stateCol: null },
  { table: 'nest_devices', label: 'Thermostats', filter: '&is_active=eq.true', stateCol: 'last_state' },
  { table: 'vehicles', label: 'Vehicles', filter: '&is_active=eq.true', stateCol: 'last_state' },
  { table: 'lg_appliances', label: 'LG Appliances', filter: '&is_active=eq.true', stateCol: 'last_state' },
  { table: 'anova_ovens', label: 'Anova Ovens', filter: '&is_active=eq.true', stateCol: 'last_state' },
  { table: 'printer_devices', label: '3D Printers', filter: '&is_active=eq.true', stateCol: null },
];

async function testDevices() {
  if (!jsonMode) console.log('\n\x1b[1m🔌 Device Inventory Tests\x1b[0m');

  for (const { table, label, filter, stateCol } of DEVICE_TABLES) {
    try {
      const data = await supabaseQuery(table, '*', filter);
      if (data.length === 0) {
        record('devices', `${label}: active devices`, 'WARN', 'none found');
        continue;
      }
      record('devices', `${label}: active devices`, 'PASS', `${data.length} found`);

      // Check for stale state (> 24h since last sync)
      if (stateCol) {
        const withState = data.filter(d => d[stateCol] != null);
        const stateRatio = `${withState.length}/${data.length}`;
        if (withState.length === data.length) {
          record('devices', `${label}: all have state`, 'PASS', stateRatio);
        } else {
          record('devices', `${label}: missing state`, 'WARN', `${stateRatio} have state`);
        }
      }

      if (data[0]?.last_synced_at) {
        const freshThreshold = Date.now() - 24 * 60 * 60 * 1000;
        const stale = data.filter(d => d.last_synced_at && new Date(d.last_synced_at).getTime() < freshThreshold);
        if (stale.length) {
          record('devices', `${label}: stale devices`, 'WARN', `${stale.length} not synced in 24h`);
        } else {
          record('devices', `${label}: freshness`, 'PASS', 'all synced within 24h');
        }
      }
    } catch (e) {
      record('devices', `${label}`, 'FAIL', e.message);
    }
  }
}

// ── D. Supabase Health ──────────────────────────────────────
async function testSupabase() {
  if (!jsonMode) console.log('\n\x1b[1m🏥 Supabase Health\x1b[0m');

  // Ping
  const start = Date.now();
  const res = await fetchOk(`${SUPABASE_URL}/rest/v1/`, 5000);
  const latency = Date.now() - start;
  const reachable = res.ok || res.status === 200 || (res.status >= 200 && res.status < 500);
  record('supabase', 'API reachable', reachable ? 'PASS' : 'FAIL', `${latency}ms`);

  // Auth with anon key
  try {
    const data = await supabaseQuery('spaces', 'id', '&limit=1');
    record('supabase', 'Anon key auth', 'PASS');
  } catch (e) {
    record('supabase', 'Anon key auth', 'FAIL', e.message);
  }

  // Round-trip query
  try {
    const qStart = Date.now();
    await supabaseQuery('property_config', 'id', '&id=eq.1');
    const qTime = Date.now() - qStart;
    record('supabase', 'Query round-trip', qTime < 2000 ? 'PASS' : 'WARN', `${qTime}ms`);
  } catch (e) {
    record('supabase', 'Query round-trip', 'FAIL', e.message);
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  if (!jsonMode) console.log('\x1b[1m\n🏥 AlpacApps Site Health Check\x1b[0m');
  if (!jsonMode) console.log(`   Target: ${SITE_BASE}`);
  if (!jsonMode) console.log(`   Time:   ${new Date().toLocaleString()}\n`);

  if (runAll || args.has('--pages')) await testPages();
  if (runAll || args.has('--cameras')) await testCameras();
  if (runAll || args.has('--devices')) await testDevices();
  if (runAll) await testSupabase();

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\n\x1b[1m── Summary ──\x1b[0m`);
    console.log(`  \x1b[32m${results.passed} passed\x1b[0m  \x1b[31m${results.failed} failed\x1b[0m  \x1b[33m${results.warnings} warnings\x1b[0m`);
    console.log(`  Total: ${results.tests.length} tests\n`);

    if (results.failed > 0) {
      console.log('\x1b[31mFailed tests:\x1b[0m');
      results.tests.filter(t => t.status === 'FAIL').forEach(t => {
        console.log(`  ✗ [${t.category}] ${t.name} — ${t.detail}`);
      });
      console.log('');
    }

    process.exit(results.failed > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(2);
});
