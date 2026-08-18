import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromeSandboxArgs, findChrome } from './chrome-harness.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultWptRevision = 'c7c7a1b2641777d1f5f3934705ddde645eb82116';
const wptRevision = process.env.AGENTBOARD_WPT_REVISION || defaultWptRevision;
const wptRoot = path.resolve(
  process.env.AGENTBOARD_WPT_ROOT || path.join(repositoryRoot, 'local/wpt')
);
const resultsDirectory = path.resolve(
  process.env.AGENTBOARD_WPT_RESULTS || path.join(repositoryRoot, 'local/wpt-results')
);
const reportPath = path.join(resultsDirectory, 'webmcp-polyfill.json');
const injectedPolyfillPath = path.join(resultsDirectory, 'webmcp-polyfill-under-test.js');
const builtPolyfillPath = path.join(repositoryRoot, 'dist/content-scripts/webmcp-polyfill.js');
const wptRemote = 'https://github.com/web-platform-tests/wpt.git';
// The WPT CLI loads docs/commands.json at startup despite that directory otherwise looking optional.
const sparseCheckoutPaths = ['common', 'docs', 'resources', 'tools', 'webmcp'];

const defaultTests = [
  'webmcp/imperative/cancel-reentrancy-crash.https.html',
  'webmcp/imperative/duplicate_tool_registration.https.html',
  'webmcp/imperative/executeTool-abort.https.html',
  'webmcp/imperative/executeTool-error-window-onerror.https.html',
  'webmcp/imperative/executeTool-invalid-dictionary.https.html',
  'webmcp/imperative/executeTool-unregister-resolution-race.https.html',
  'webmcp/imperative/getTools-imperative-annotations.https.html',
  'webmcp/imperative/getTools-imperative-schema.https.html',
  'webmcp/imperative/getTools.https.html',
  'webmcp/imperative/model_context.https.html',
  'webmcp/imperative/object-arguments.https.html',
  'webmcp/imperative/register-tool-title.https.html',
  'webmcp/imperative/register_tool_invalid_json_schema.https.html',
  'webmcp/imperative/register_tool_name_validation.https.html',
  'webmcp/imperative/register_tool_no_schema.https.html',
  'webmcp/imperative/register_tool_signal.https.html',
  'webmcp/imperative/register_tool_toolchange.https.html',
  'webmcp/imperative/register_tool_with_empty_annotation.https.html',
  'webmcp/imperative/register_tool_with_schema.https.html',
];

function run(command, args, { cwd = repositoryRoot, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return capture ? result.stdout.trim() : '';

  const detail = capture ? `\n${result.stderr || result.stdout}`.trimEnd() : '';
  throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}${detail}`);
}

function git(args, options) {
  return run('git', ['-C', wptRoot, ...args], options);
}

function ensureWptCheckout() {
  if (!/^[0-9a-f]{40}$/.test(wptRevision)) {
    throw new Error('AGENTBOARD_WPT_REVISION must be a full 40-character commit SHA');
  }

  if (!existsSync(path.join(wptRoot, '.git'))) {
    if (existsSync(wptRoot)) {
      throw new Error(`${wptRoot} exists but is not a Git checkout`);
    }

    mkdirSync(path.dirname(wptRoot), { recursive: true });
    run('git', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--depth=1',
      '--sparse',
      wptRemote,
      wptRoot,
    ]);
    git(['sparse-checkout', 'set', ...sparseCheckoutPaths]);
  }

  const dirtyFiles = git(['status', '--porcelain', '--untracked-files=no'], { capture: true });
  if (dirtyFiles) {
    throw new Error(`Refusing to change the modified WPT checkout at ${wptRoot}:\n${dirtyFiles}`);
  }

  const hasRevision = spawnSync(
    'git',
    ['-C', wptRoot, 'cat-file', '-e', `${wptRevision}^{commit}`],
    {
      stdio: 'ignore',
    }
  );
  if (hasRevision.status !== 0) {
    git(['fetch', '--filter=blob:none', '--depth=1', 'origin', wptRevision]);
  }

  if (git(['rev-parse', 'HEAD'], { capture: true }) !== wptRevision) {
    git(['checkout', '--detach', wptRevision]);
  }

  git(['sparse-checkout', 'set', ...sparseCheckoutPaths]);
}

function writeInjectedPolyfill() {
  if (!existsSync(builtPolyfillPath)) {
    throw new Error('Built WebMCP polyfill is missing. Run pnpm run build first.');
  }

  mkdirSync(resultsDirectory, { recursive: true });
  const polyfill = readFileSync(builtPolyfillPath, 'utf8');
  // The browser flag selects the backend; this guard prevents a changed or ignored flag from
  // silently turning native behavior into apparent polyfill conformance.
  const backendGuard = `
;(() => {
  if (!globalThis.isSecureContext) return;

  const hasOwnFacade = Object.prototype.hasOwnProperty.call(document, 'modelContext');
  const hasNativeAccessor = Object.prototype.hasOwnProperty.call(Document.prototype, 'modelContext');
  if (hasOwnFacade && !hasNativeAccessor) return;

  const message = 'AgentBoard WPT harness did not select the forced-local WebMCP backend';
  console.error(message);
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    get() {
      throw new Error(message);
    },
  });
})();
`;
  writeFileSync(injectedPolyfillPath, `${polyfill}\n${backendGuard}`);
}

function inferChromeChannel(chrome) {
  if (process.env.AGENTBOARD_WPT_CHANNEL) return process.env.AGENTBOARD_WPT_CHANNEL;
  if (/canary/i.test(chrome)) return 'canary';
  if (/chrome dev/i.test(chrome)) return 'dev';
  return 'stable';
}

function summarizeReport() {
  if (!existsSync(reportPath)) return;
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const tests = report.results || [];
  const subtests = tests.flatMap((test) => test.subtests || []);
  const countStatuses = (results) =>
    results.reduce((counts, result) => {
      counts[result.status] = (counts[result.status] || 0) + 1;
      return counts;
    }, {});
  const outcome = (result) =>
    result.expected && result.expected !== result.status
      ? `${result.status} expected ${result.expected}`
      : result.status;
  const conciseMessage = (message) => {
    if (!message) return null;
    const normalized = message.replace(/\s+/g, ' ').trim();
    return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
  };

  console.log(`\nWebMCP WPT report: ${reportPath}`);
  console.log(
    `Browser ${report.run_info?.browser_version || 'unknown'}, WPT ${report.run_info?.revision || wptRevision}`
  );
  console.log(
    `${tests.length} files ${JSON.stringify(countStatuses(tests))}; ` +
      `${subtests.length} subtests ${JSON.stringify(countStatuses(subtests))}`
  );
  console.log('\nActual results:');
  for (const test of tests) {
    console.log(`[${outcome(test)}] ${test.test}`);
    const testMessage = conciseMessage(test.message);
    if (testMessage) console.log(`  ${testMessage}`);
    for (const subtest of test.subtests || []) {
      console.log(`  [${outcome(subtest)}] ${subtest.name}`);
      const subtestMessage = conciseMessage(subtest.message);
      if (subtestMessage) console.log(`    ${subtestMessage}`);
    }
  }
}

function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome or Chromium is required for WebMCP WPT integration tests');

  ensureWptCheckout();
  writeInjectedPolyfill();
  rmSync(reportPath, { force: true });

  const requestedTests = process.argv.slice(2);
  const tests = requestedTests[0] === '--' ? requestedTests.slice(1) : requestedTests;
  const selectedTests = tests.length > 0 ? tests : defaultTests;
  const binaryArgs = ['--disable-blink-features=WebMCP', ...chromeSandboxArgs()].map(
    (argument) => `--binary-arg=${argument}`
  );
  const args = [
    'run',
    'chrome',
    '--yes',
    `--channel=${inferChromeChannel(chrome)}`,
    `--binary=${chrome}`,
    '--headless',
    '--processes=1',
    '--no-pause-after-test',
    '--no-enable-experimental',
    '--no-enable-webtransport-h3',
    '--no-manifest-download',
    `--inject-script=${injectedPolyfillPath}`,
    `--log-wptreport=${reportPath}`,
    ...binaryArgs,
    ...selectedTests,
  ];

  console.log(`Running ${selectedTests.length} canonical WebMCP WPT files in forced-local mode`);
  console.log(`Chrome: ${chrome}`);
  console.log(`WPT: ${wptRoot} @ ${wptRevision}`);

  const result = spawnSync(path.join(wptRoot, 'wpt'), args, {
    cwd: wptRoot,
    stdio: 'inherit',
  });
  summarizeReport();

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`WPT runner exited from signal ${result.signal}`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
