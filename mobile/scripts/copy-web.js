#!/usr/bin/env node

/**
 * copy-web.js
 * Copies web assets from the root project into mobile/www/ for Capacitor.
 * Also injects <script src="/capacitor.js"></script> into all HTML files.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const WWW = path.resolve(__dirname, '../www');

// Directories to copy (relative to project root)
const DIRS_TO_COPY = [
  'shared',
  'spaces',
  'login',
  'contact',
  'community',
  'events',
  'visiting',
  'visiting-1',
  'residents',
  'photos',
  'orientation',
  'worktrade',
  'overnight',
  'welcome',
  'sundays',
  'mistiq',
  'styles',
  'assets/branding',
  'mobile/app',  // New mobile-first SPA
];

// Individual files to copy (relative to project root)
const FILES_TO_COPY = [
  'index.html',
  '404.html',
  'app.js',
  'styles.css',
  'favicon.ico',
  'favicon.png',
  'favicon.svg',
  'apple-touch-icon.png',
];

// Directories and patterns to skip
const SKIP_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  'supabase',
  'bug-fixer',
  'bug-reporter-extension',
  'bug-reporter-firefox',
  'scripts',
  'docs',
  'migrations',
  'mobile',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'HOMEAUTOMATION.md',
  'HOMEAUTOMATION.local.md',
  'ARCHITECTURE.md',
  'API.md',
  'README.md',
  'SKILL.md',
  'INFRASTRUCTURE_GUIDE.md',
  'OpenClawSKILL.md',
  'context.json',
  'CNAME',
  '.nojekyll',
  '.gitignore',
  'supabase-migrations.sql',
];

/**
 * Recursively copy a directory
 */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  WARNING: Source not found: ${src}`);
    return;
  }

  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip patterns
    if (SKIP_PATTERNS.includes(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Inject Capacitor script tag into an HTML file.
 * Adds <script src="/capacitor.js"></script> before </head>.
 */
function injectCapacitorScript(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Skip if already injected
  if (content.includes('capacitor.js')) return;

  // Inject before </head>
  const capacitorScript = '    <script src="/capacitor.js"></script>\n';
  content = content.replace('</head>', capacitorScript + '  </head>');

  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Recursively find all HTML files in a directory
 */
function findHtmlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findHtmlFiles(fullPath));
    } else if (entry.name.endsWith('.html')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

console.log('🏗️  Copying web assets to mobile/www/...\n');

// Clean www/ directory
if (fs.existsSync(WWW)) {
  fs.rmSync(WWW, { recursive: true });
}
fs.mkdirSync(WWW, { recursive: true });

// Copy directories
for (const dir of DIRS_TO_COPY) {
  const src = path.join(ROOT, dir);
  const dest = path.join(WWW, dir);
  if (fs.existsSync(src)) {
    console.log(`  📁 ${dir}/`);
    copyDir(src, dest);
  } else {
    console.warn(`  ⚠️  Skipping ${dir}/ (not found)`);
  }
}

// Copy individual files
for (const file of FILES_TO_COPY) {
  const src = path.join(ROOT, file);
  const dest = path.join(WWW, file);
  if (fs.existsSync(src)) {
    console.log(`  📄 ${file}`);
    fs.copyFileSync(src, dest);
  } else {
    console.warn(`  ⚠️  Skipping ${file} (not found)`);
  }
}

// Inject Capacitor script into all HTML files
console.log('\n💉 Injecting Capacitor script into HTML files...\n');
const htmlFiles = findHtmlFiles(WWW);
let injectedCount = 0;
for (const htmlFile of htmlFiles) {
  const rel = path.relative(WWW, htmlFile);
  injectCapacitorScript(htmlFile);
  injectedCount++;
}
console.log(`  ✅ Processed ${injectedCount} HTML files`);

// Copy the mobile app's index.html as the root index.html
// This avoids meta-refresh redirect loops in Capacitor's WebView
console.log('\n📱 Setting mobile app as root entry point...');
const mobileAppIndex = path.join(WWW, 'mobile', 'app', 'index.html');
const rootIndex = path.join(WWW, 'index.html');
if (fs.existsSync(mobileAppIndex)) {
  let mobileHtml = fs.readFileSync(mobileAppIndex, 'utf8');
  // Fix relative paths: mobile.css → /mobile/app/mobile.css, mobile-app.js → /mobile/app/mobile-app.js
  mobileHtml = mobileHtml.replace('href="mobile.css"', 'href="/mobile/app/mobile.css"');
  mobileHtml = mobileHtml.replace('src="mobile-app.js"', 'src="/mobile/app/mobile-app.js"');
  fs.writeFileSync(rootIndex, mobileHtml, 'utf8');
  console.log('  ✅ Root index.html now serves mobile app directly');
} else {
  console.warn('  ⚠️  mobile/app/index.html not found');
}

// Fix login redirect: login page should redirect back to / (the mobile app) instead of /residents/
// Patch the login app.js to use /mobile/app/index.html for resident redirects
const loginAppJs = path.join(WWW, 'login', 'app.js');
if (fs.existsSync(loginAppJs)) {
  let loginJs = fs.readFileSync(loginAppJs, 'utf8');
  loginJs = loginJs.replace(
    "targetUrl = '/residents/cameras.html'",
    "targetUrl = '/mobile/app/index.html'"
  );
  fs.writeFileSync(loginAppJs, loginJs, 'utf8');
  console.log('  ✅ Login redirect patched for mobile app');
}

console.log(`\n✅ Done! ${DIRS_TO_COPY.length} directories + ${FILES_TO_COPY.length} files copied to mobile/www/\n`);
