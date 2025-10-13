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

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const zipFile = path.join(rootDir, `release/agentboard-${version}.zip`);

console.log(`Preparing GitHub release ${tag}...\n`);

// Verify release zip exists
if (!fs.existsSync(zipFile)) {
  console.error(`✗ Release zip not found: release/agentboard-${version}.zip`);
  console.error('  Run `npm run release` first to build the release package');
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
  execSync(`git ls-remote --tags origin ${tag}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
  const remoteCheck = execSync(`git ls-remote --tags origin ${tag}`, { encoding: 'utf8' }).trim();
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
    stdio: 'pipe'
  }).trim();

  console.log(`Generating release notes from commits since ${lastTag}...\n`);

  const commits = execSync(`git log ${lastTag}..HEAD --pretty=format:"- %s (%h)"`, {
    encoding: 'utf8',
    stdio: 'pipe'
  }).trim();

  if (commits) {
    notes = `## What's Changed\n\n${commits}\n\n**Full Changelog**: https://github.com/OWNER/REPO/compare/${lastTag}...${tag}`;
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

// Prepare gh release command
// Create as draft so you can review before publishing
const cmd = [
  'gh', 'release', 'create', tag,
  zipFile,
  '--title', `AgentBoard ${tag}`,
  '--notes', notes,
  '--draft'
].map(arg => {
  // Quote arguments with spaces or special chars
  if (arg.includes(' ') || arg.includes('\n')) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
});

console.log('Creating draft release...\n');

try {
  // Use spawn-style execution to handle complex args
  execSync(`gh release create "${tag}" "${zipFile}" --title "AgentBoard ${tag}" --notes "${notes.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" --draft`, {
    stdio: 'inherit',
    cwd: rootDir
  });

  console.log('\n✓ Draft release created successfully!');
  console.log('\nNext steps:');
  console.log('  1. Review the draft release on GitHub');
  console.log('  2. Edit release notes if needed');
  console.log('  3. Publish the release when ready');
  console.log(`  4. ${tagOnRemote ? '' : 'Push tag: git push origin ' + tag}`);
  console.log('\n  View draft: gh release view ' + tag + ' --web');

} catch (e) {
  console.error('\n✗ Failed to create GitHub release');
  console.error('  Check if release already exists: gh release list');
  console.error('  Or if tag exists: gh release view ' + tag);
  process.exit(1);
}

