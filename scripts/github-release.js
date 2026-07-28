#!/usr/bin/env node

/** Verify one reviewed artifact and create a draft GitHub release. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_METADATA_FILE, resolveLocalReleaseIdentity } from './release-identity.js';

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

function repositoryName(repositoryUrl) {
  try {
    const url = new URL(repositoryUrl);
    const parts = url.pathname
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      parts.length !== 2 ||
      !parts.every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part))
    ) {
      throw new Error('unsupported repository URL');
    }
    return parts.join('/');
  } catch {
    fail('package.json must declare a canonical HTTPS GitHub repository URL');
  }
}

const pkg = readJson(path.join(rootDir, 'package.json'), 'package.json');
let identity;
try {
  identity = resolveLocalReleaseIdentity(rootDir, pkg.version);
} catch (error) {
  fail(error instanceof Error ? error.message : 'Release identity is invalid.');
}
const { version, tag, sourceCommit, tagObject } = identity;
const repository = repositoryName(pkg.repository?.url);
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
const remoteRefs = new Map(
  remoteTags
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 2).reverse())
);
const remoteTagObject = remoteRefs.get(`refs/tags/${tag}`);
const remoteTagCommit = remoteRefs.get(`refs/tags/${tag}^{}`);
if (!remoteTagObject || !remoteTagCommit) fail(`Annotated remote tag ${tag} is missing.`);
if (remoteTagObject !== tagObject || remoteTagCommit !== sourceCommit) {
  fail(`Remote tag ${tag} does not match the reviewed local tag and HEAD.`);
}

if (!fs.existsSync(zipFile)) fail(`Release ZIP is missing: release/${zipName}`);
if (!fs.existsSync(checksumFile)) fail(`Checksum is missing: release/${zipName}.sha256`);
const checksumLine = fs.readFileSync(checksumFile, 'utf8').trim();
const checksumMatch = /^([a-f0-9]{64})  (\S+)$/.exec(checksumLine);
if (!checksumMatch || checksumMatch[2] !== zipName) fail('Checksum sidecar has invalid content.');
const actualChecksum = createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
if (checksumMatch[1] !== actualChecksum) fail('Release ZIP does not match its SHA-256 sidecar.');

let metadata;
let manifest;
try {
  metadata = JSON.parse(run('unzip', ['-p', zipFile, RELEASE_METADATA_FILE], 'buffer'));
  manifest = JSON.parse(run('unzip', ['-p', zipFile, 'manifest.json'], 'buffer'));
} catch {
  fail('Release ZIP metadata or manifest is missing or invalid.');
}
if (
  metadata.formatVersion !== 1 ||
  metadata.version !== version ||
  metadata.tag !== tag ||
  metadata.sourceCommit !== sourceCommit ||
  !Array.isArray(metadata.files)
) {
  fail('Release ZIP metadata does not match clean tagged HEAD.');
}
if (manifest.version !== version) fail(`Release ZIP manifest version does not match ${version}.`);

try {
  run('gh', ['auth', 'status', '--hostname', 'github.com']);
} catch {
  fail('GitHub CLI is missing or not authenticated for github.com.');
}

console.log(`Creating draft ${repository}@${tag} from ${sourceCommit}`);
console.log(`ZIP SHA-256: ${actualChecksum}`);
try {
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      zipFile,
      checksumFile,
      '--repo',
      repository,
      '--title',
      `AgentBoard ${tag}`,
      '--draft',
      '--verify-tag',
      '--generate-notes',
    ],
    { cwd: rootDir, stdio: 'inherit' }
  );
} catch {
  fail(`GitHub rejected draft release ${repository}@${tag}.`);
}

console.log(`✓ Draft release created for ${tag}`);
console.log(`  View: gh release view ${tag} --repo ${repository} --web`);
