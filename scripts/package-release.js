#!/usr/bin/env node

/**
 * Package AgentBoard extension for Chrome Web Store release
 * 
 * This script:
 * 1. Reads version from package.json (single source of truth)
 * 2. Syncs version to dist/manifest.json
 * 3. Creates release/agentboard-{version}.zip
 * 4. Includes dist contents + LICENSE, README.md, PRIVACY.md
 * 5. Excludes source maps and duplicate assets
 * 
 * WHY: Ensures consistent versioning and clean release artifacts
 * TRADE-OFF: Extra build step, but prevents manual packaging errors
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Verify dist exists
const distDir = path.join(rootDir, 'dist');
if (!fs.existsSync(distDir)) {
  console.error('✗ dist/ directory not found. Run `npm run build:release` first.');
  process.exit(1);
}

// Read version from package.json (single source of truth)
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;

console.log(`Packaging AgentBoard v${version}...`);

// Verify manifest has correct version (should be injected by vite build)
const manifestPath = path.join(distDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('✗ dist/manifest.json not found. Build may have failed.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== version) {
  console.error(`✗ Version mismatch: manifest.json has ${manifest.version}, expected ${version}`);
  console.error('  This should not happen. Check vite.config.ts version injection.');
  process.exit(1);
}

// Create release directory
const releaseDir = path.join(rootDir, 'release');
if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

// Package the extension
const zipPath = path.join(releaseDir, `agentboard-${version}.zip`);
const output = fs.createWriteStream(zipPath);
const archive = archiver('zip', {
  zlib: { level: 9 } // Maximum compression
});

// Error handling
archive.on('error', (err) => {
  console.error('✗ Archiving failed:', err);
  process.exit(1);
});

archive.on('warning', (err) => {
  if (err.code === 'ENOENT') {
    console.warn('⚠ Warning:', err);
  } else {
    throw err;
  }
});

archive.pipe(output);

// Add dist files (excluding source maps and duplicate assets)
let filesAdded = 0;
let bytesAdded = 0;

archive.directory(distDir, false, (entry) => {
  // Exclude source maps (not needed for production, reduces size)
  if (entry.name.endsWith('.map')) {
    return false;
  }
  // Exclude duplicate public/ directory (crx plugin issue)
  // Icons are already in dist/icons/
  if (entry.name.startsWith('public/')) {
    return false;
  }
  // Exclude macOS cruft
  if (entry.name === '.DS_Store' || entry.name.includes('/.DS_Store')) {
    return false;
  }

  filesAdded++;
  bytesAdded += entry.stats?.size || 0;
  return entry;
});

// Add required root files for Chrome Web Store
const rootFiles = ['LICENSE', 'README.md', 'PRIVACY.md'];
for (const file of rootFiles) {
  const filePath = path.join(rootDir, file);
  if (fs.existsSync(filePath)) {
    archive.file(filePath, { name: file });
    filesAdded++;
    bytesAdded += fs.statSync(filePath).size;
  } else {
    console.warn(`⚠ ${file} not found, skipping`);
  }
}

archive.finalize();

output.on('close', () => {
  const totalBytes = archive.pointer();
  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);

  console.log(`✓ Release package created: agentboard-${version}.zip`);
  console.log(`  Files: ${filesAdded}`);
  console.log(`  Size: ${totalMB} MB`);
  console.log(`  Location: release/agentboard-${version}.zip`);

  // Chrome Web Store has a 128MB limit, warn if getting close
  if (totalBytes > 100 * 1024 * 1024) {
    console.warn(`⚠ Package size is large (${totalMB} MB). Chrome Web Store limit is 128 MB.`);
  }

  console.log('\nNext steps:');
  console.log('  1. Test the packaged extension locally');
  console.log('  2. Upload to Chrome Web Store Developer Dashboard');
  console.log('  3. Tag release: git tag v' + version);
});

