#!/usr/bin/env node

/**
 * Create GitHub release with built extension zip
 *
 * This script:
 * 1. Verifies release zip exists
 * 2. Checks for gh CLI installation
 * 3. Auto-generates release notes from git commits
 * 4. Creates draft GitHub release with zip attachment
 * 5. Prompts for manual review before publishing
 *
 * WHY: Automates GitHub release creation while maintaining manual control
 * TRADE-OFF: Requires gh CLI, but simplifies release process
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read release identity from package.json so notes, remote checks, and gh all
// target the same reviewed repository instead of relying on ambient CLI state.
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const zipFile = path.join(rootDir, `release/agentboard-${version}.zip`);
const repositoryUrl = pkg.repository?.url;
let repository;
try {
  const url = new URL(repositoryUrl);
  const pathParts = url.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    pathParts.length !== 2 ||
    !pathParts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error('unsupported repository URL');
  }
  repository = pathParts.join('/');
} catch {
  console.error('✗ package.json must declare a canonical HTTPS GitHub repository URL');
  process.exit(1);
}
const repositoryRemote = `https://github.com/${repository}.git`;

console.log(`Preparing GitHub release ${tag} for ${repository}...\n`);

// Verify release zip exists
if (!fs.existsSync(zipFile)) {
  console.error(`✗ Release zip not found: release/agentboard-${version}.zip`);
  console.error('  Run `pnpm run release` first to build the release package');
  process.exit(1);
}

const zipStats = fs.statSync(zipFile);
const zipSizeMB = (zipStats.size / 1024 / 1024).toFixed(2);
console.log(`✓ Found release zip: agentboard-${version}.zip (${zipSizeMB} MB)`);

// Check if gh CLI is installed
try {
  execSync('gh --version', { stdio: 'pipe' });
  console.log('✓ GitHub CLI found');
} catch (e) {
  console.error('\n✗ GitHub CLI not found');
  console.error('  Install: brew install gh (macOS)');
  console.error('  Or visit: https://cli.github.com/');
  process.exit(1);
}

// Check if authenticated with gh
try {
  execSync('gh auth status', { stdio: 'pipe' });
  console.log('✓ GitHub CLI authenticated\n');
} catch (e) {
  console.error('\n✗ Not authenticated with GitHub CLI');
  console.error('  Run: gh auth login');
  process.exit(1);
}

// Check if tag already exists locally
try {
  execSync(`git rev-parse ${tag}`, { stdio: 'pipe' });
  console.log(`✓ Git tag ${tag} exists locally`);
} catch (e) {
  console.error(`\n✗ Git tag ${tag} not found`);
  console.error(`  Create tag first: git tag ${tag}`);
  console.error(`  Or run: git tag ${tag} && git push origin ${tag}`);
  process.exit(1);
}

// Check if tag exists on remote
let tagOnRemote = false;
try {
  const remoteCheck = execSync(`git ls-remote --tags "${repositoryRemote}" "refs/tags/${tag}"`, {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  tagOnRemote = remoteCheck.length > 0;
  if (tagOnRemote) {
    console.log(`✓ Tag ${tag} pushed to remote\n`);
  } else {
    console.warn(`⚠ Tag ${tag} not pushed to remote yet`);
    console.warn(`  Push with: git push origin ${tag}\n`);
  }
} catch (e) {
  console.warn(`⚠ Could not check remote tags\n`);
}

// Auto-generate release notes from commits since last tag
let notes = '';
try {
  const lastTag = execSync('git describe --tags --abbrev=0 HEAD^', {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

  console.log(`Generating release notes from commits since ${lastTag}...\n`);

  const commits = execSync(`git log ${lastTag}..HEAD --pretty=format:"- %s (%h)"`, {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

  if (commits) {
    notes = `## What's Changed\n\n${commits}\n\n**Full Changelog**: https://github.com/${repository}/compare/${lastTag}...${tag}`;
  } else {
    notes = `Release ${version}\n\nSee commit history for changes.`;
  }
} catch (e) {
  // First release or can't find previous tag
  console.log('No previous tag found, this might be the first release\n');
  notes = `Initial release ${version}\n\nChrome extension providing AI-powered browser sidebar with WebMCP tools and MCP server integration.`;
}

console.log('Release notes preview:');
console.log('─'.repeat(60));
console.log(notes);
console.log('─'.repeat(60));
console.log('');

console.log('Creating draft release...\n');

// Write notes to temp file to avoid shell escaping issues with newlines
const notesFile = path.join(rootDir, 'release', '.release-notes.md');
fs.writeFileSync(notesFile, notes);

try {
  execSync(
    `gh release create "${tag}" "${zipFile}" --repo "${repository}" --title "AgentBoard ${tag}" --notes-file "${notesFile}" --draft`,
    {
      stdio: 'inherit',
      cwd: rootDir,
    }
  );

  // Clean up temp notes file
  fs.unlinkSync(notesFile);

  console.log('\n✓ Draft release created successfully!');
  console.log('\nNext steps:');
  console.log('  1. Review the draft release on GitHub');
  console.log('  2. Edit release notes if needed');
  console.log('  3. Publish the release when ready');
  console.log(`  4. ${tagOnRemote ? '' : 'Push tag: git push origin ' + tag}`);
  console.log(`\n  View draft: gh release view ${tag} --repo ${repository} --web`);
} catch (e) {
  // Clean up temp notes file on error
  if (fs.existsSync(notesFile)) {
    fs.unlinkSync(notesFile);
  }
  console.error('\n✗ Failed to create GitHub release');
  console.error(`  Check if release already exists: gh release list --repo ${repository}`);
  console.error(`  Or if tag exists: gh release view ${tag} --repo ${repository}`);
  process.exit(1);
}
