#!/usr/bin/env node

/**
 * Stamp one clean tagged build before browser tests, then package only those
 * unchanged bytes. The embedded inventory is a provenance receipt, not a
 * signature or reproducible-build claim.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import {
  RELEASE_METADATA_FILE,
  RELEASE_SOURCE_FILES,
  releaseMetadataBytes,
} from './release-contract.js';
import { resolveLocalReleaseIdentity } from './release-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const releaseDir = path.join(rootDir, 'release');
const stampOnly = process.argv[2] === '--stamp';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (process.argv.length > (stampOnly ? 3 : 2)) fail('Usage: package-release.js [--stamp]');

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${label} is missing or invalid: ${path.relative(rootDir, file)}`);
  }
}

function excluded(relativePath) {
  const segments = relativePath.split('/');
  return (
    relativePath === RELEASE_METADATA_FILE ||
    segments[0] === 'public' ||
    segments.includes('.DS_Store') ||
    relativePath.endsWith('.map')
  );
}

function snapshotDist() {
  if (!fs.existsSync(distDir)) fail('dist/ is missing. Run the release build first.');
  const files = [];

  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`Release build contains a symbolic link: ${relativePath}`);
      if (!relativePath || relativePath.includes('\\') || /[\x00-\x1f\x7f]/.test(relativePath)) {
        fail(`Release build contains an unsafe path: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (!excluded(relativePath)) visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) fail(`Release build contains a special file: ${relativePath}`);
      if (!excluded(relativePath))
        files.push({ path: relativePath, bytes: fs.readFileSync(absolutePath) });
    }
  }

  visit(distDir);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

function taggedFile(sourceCommit, file) {
  try {
    return execFileSync('git', ['show', `${sourceCommit}:${file}`], { cwd: rootDir });
  } catch {
    fail(`Required release file is missing from ${sourceCommit}: ${file}`);
  }
}

const pkg = readJson(path.join(rootDir, 'package.json'), 'package.json');
let identity;
try {
  identity = resolveLocalReleaseIdentity(rootDir, pkg.version);
} catch (error) {
  fail(error instanceof Error ? error.message : 'Release identity is invalid.');
}

const files = snapshotDist();
const manifestFile = files.find((file) => file.path === 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(manifestFile?.bytes.toString('utf8') ?? '');
} catch {
  fail('release manifest is missing or invalid: dist/manifest.json');
}
if (manifest.version !== identity.version) {
  fail(
    `Version mismatch: dist/manifest.json has ${manifest.version}, expected ${identity.version}.`
  );
}

const expectedMetadata = releaseMetadataBytes(identity, files);
const metadataPath = path.join(distDir, RELEASE_METADATA_FILE);
if (stampOnly) {
  fs.writeFileSync(metadataPath, expectedMetadata);
  console.log(`✓ Stamped ${files.length} release payload files for ${identity.tag}`);
  process.exit(0);
}

let stampedMetadata;
try {
  stampedMetadata = fs.readFileSync(metadataPath);
} catch {
  fail('Release metadata is missing. Run package-release.js --stamp before browser tests.');
}
if (!stampedMetadata.equals(expectedMetadata)) {
  fail('Release payload changed after it was stamped. Rebuild and rerun browser tests.');
}

const entries = new Map(files.map((file) => [file.path, file.bytes]));
entries.set(RELEASE_METADATA_FILE, stampedMetadata);
for (const file of RELEASE_SOURCE_FILES) {
  if (entries.has(file)) fail(`Duplicate release entry: ${file}`);
  entries.set(file, taggedFile(identity.sourceCommit, file));
}

fs.mkdirSync(releaseDir, { recursive: true });
const zipName = `agentboard-${identity.version}.zip`;
const zipPath = path.join(releaseDir, zipName);
const checksumPath = `${zipPath}.sha256`;
fs.rmSync(zipPath, { force: true });
fs.rmSync(checksumPath, { force: true });

const output = fs.createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });
const completed = new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.on('warning', reject);
});
archive.pipe(output);
for (const [name, bytes] of entries) archive.append(bytes, { name });

try {
  await Promise.all([archive.finalize(), completed]);
} catch (error) {
  output.destroy();
  fs.rmSync(zipPath, { force: true });
  fail(`Archiving failed: ${error instanceof Error ? error.message : 'unknown error'}`);
}

const zipBytes = fs.readFileSync(zipPath);
const checksum = createHash('sha256').update(zipBytes).digest('hex');
try {
  fs.writeFileSync(checksumPath, `${checksum}  ${zipName}\n`, { flag: 'wx' });
} catch (error) {
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(checksumPath, { force: true });
  fail(`Checksum creation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
}

console.log(`✓ Release package: release/${zipName}`);
console.log(`✓ SHA-256: ${checksum}`);
console.log(`  Source: ${identity.sourceCommit} (${identity.tag})`);
console.log(`  Files: ${entries.size}`);
console.log(`  ZIP size: ${(zipBytes.byteLength / 1024 / 1024).toFixed(2)} MB`);
if (zipBytes.byteLength > 100 * 1024 * 1024) {
  console.warn('⚠ Package is approaching the Chrome Web Store 128 MB limit.');
}
console.log(`\nVerify: (cd release && shasum -a 256 -c ${zipName}.sha256)`);
console.log('Push the exact commit and tag only after explicit approval.');
