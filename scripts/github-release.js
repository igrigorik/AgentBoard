#!/usr/bin/env node

/** Verify one reviewed artifact and create a draft GitHub release. */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_METADATA_FILE,
  draftReleaseArgs,
  repositoryName,
  validateReleaseChecksum,
  validateReleaseMetadata,
  validateRemoteReleaseIdentity,
} from './release-contract.js';
import { resolveLocalReleaseIdentity } from './release-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(command, args, encoding = 'utf8') {
  return execFileSync(command, args, {
    cwd: rootDir,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${label} is missing or invalid: ${path.relative(rootDir, file)}`);
  }
}

const pkg = readJson(path.join(rootDir, 'package.json'), 'package.json');
let identity;
try {
  identity = resolveLocalReleaseIdentity(rootDir, pkg.version);
} catch (error) {
  fail(error instanceof Error ? error.message : 'Release identity is invalid.');
}
const { version, tag, sourceCommit } = identity;
let repository;
try {
  repository = repositoryName(pkg.repository?.url);
} catch (error) {
  fail(error instanceof Error ? error.message : 'package.json repository is invalid.');
}
const repositoryRemote = `https://github.com/${repository}.git`;
const zipName = `agentboard-${version}.zip`;
const zipFile = path.join(rootDir, 'release', zipName);
const checksumFile = `${zipFile}.sha256`;

let remoteTags;
try {
  remoteTags = run('git', [
    'ls-remote',
    '--tags',
    repositoryRemote,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]).trim();
} catch {
  fail(`Could not read ${tag} from ${repositoryRemote}.`);
}
try {
  validateRemoteReleaseIdentity(remoteTags, identity);
} catch (error) {
  fail(error instanceof Error ? error.message : `Remote tag ${tag} is invalid.`);
}

if (!fs.existsSync(zipFile)) fail(`Release ZIP is missing: release/${zipName}`);
if (!fs.existsSync(checksumFile)) fail(`Checksum is missing: release/${zipName}.sha256`);
const checksumLine = fs.readFileSync(checksumFile, 'utf8');
let actualChecksum;
try {
  actualChecksum = validateReleaseChecksum(checksumLine, zipName, fs.readFileSync(zipFile));
} catch (error) {
  fail(error instanceof Error ? error.message : 'Release checksum is invalid.');
}

let metadata;
let manifest;
try {
  metadata = JSON.parse(run('unzip', ['-p', zipFile, RELEASE_METADATA_FILE], 'buffer'));
  manifest = JSON.parse(run('unzip', ['-p', zipFile, 'manifest.json'], 'buffer'));
} catch {
  fail('Release ZIP metadata or manifest is missing or invalid.');
}
try {
  validateReleaseMetadata(metadata, manifest, identity);
} catch (error) {
  fail(error instanceof Error ? error.message : 'Release ZIP identity is invalid.');
}

try {
  run('gh', ['auth', 'status', '--hostname', 'github.com']);
} catch {
  fail('GitHub CLI is missing or not authenticated for github.com.');
}

console.log(`Creating draft ${repository}@${tag} from ${sourceCommit}`);
console.log(`ZIP SHA-256: ${actualChecksum}`);
try {
  execFileSync('gh', draftReleaseArgs({ tag, zipFile, checksumFile, repository }), {
    cwd: rootDir,
    stdio: 'inherit',
  });
} catch {
  fail(`GitHub rejected draft release ${repository}@${tag}.`);
}

console.log(`✓ Draft release created for ${tag}`);
console.log(`  View: gh release view ${tag} --repo ${repository} --web`);
