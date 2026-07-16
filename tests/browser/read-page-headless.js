import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const harnessPath = path.join(repositoryRoot, 'tests/browser/read-page.html');
const compiledToolPath = path.join(repositoryRoot, 'dist/tools/agentboard_read_page.js');
const resultPattern = /AGENTBOARD_BROWSER_RESULT:([A-Za-z0-9+/=]+):END/;
const maxOutputCharacters = 20 * 1024 * 1024;

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function readResults(chrome, profileDirectory) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const browser = spawn(
      chrome,
      [
        '--headless=new',
        '--allow-file-access-from-files',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-crash-reporter',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-hang-monitor',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain',
        '--virtual-time-budget=3000',
        '--dump-dom',
        `--user-data-dir=${profileDirectory}`,
        pathToFileURL(harnessPath).href,
      ],
      { detached, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let result = null;
    let failure = null;
    let settled = false;
    let forceTimer = null;
    let settlementTimer = null;

    function signalBrowser(signal) {
      try {
        if (detached && browser.pid) process.kill(-browser.pid, signal);
        else browser.kill(signal);
      } catch {
        // The process may have exited between the state check and the signal.
      }
    }

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      if (result) resolve(result);
      else reject(failure || new Error('Headless Chrome stopped without a test result.'));
    }

    function stopBrowser(signal = 'SIGTERM') {
      signalBrowser(signal);
      if (!forceTimer) {
        forceTimer = setTimeout(() => signalBrowser('SIGKILL'), 1000);
      }
      if (!settlementTimer) {
        // A failed OS-level kill must not leave CI waiting forever for `close`.
        settlementTimer = setTimeout(settle, 2500);
      }
    }

    function fail(error) {
      if (failure || result) return;
      failure = error instanceof Error ? error : new Error(String(error));
      stopBrowser('SIGKILL');
    }

    const deadlineTimer = setTimeout(() => {
      fail(
        new Error(`Headless Chrome did not produce a test result within 30 seconds.\n${stderr}`)
      );
    }, 30000);

    function inspectOutput() {
      if (result || failure) return;
      if (stdout.length > maxOutputCharacters) {
        fail(new Error('Headless Chrome output exceeded the 20 MB safety limit.'));
        return;
      }

      const marker = stdout.match(resultPattern);
      if (!marker) return;

      try {
        const payload = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8'));
        if (payload.error) throw new Error(payload.error);
        result = payload.results;
        stopBrowser();
      } catch (error) {
        fail(error);
      }
    }

    browser.stdout.setEncoding('utf8');
    browser.stderr.setEncoding('utf8');
    browser.stdout.on('data', (chunk) => {
      stdout += chunk;
      inspectOutput();
    });
    browser.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20000);
    });
    browser.on('error', fail);
    browser.on('close', (code, signal) => {
      if (!result && !failure) {
        failure = new Error(
          `Headless Chrome exited before producing a result (code ${code}, signal ${signal}).\n${stderr}\n${stdout}`
        );
      }
      settle();
    });
  });
}

const verifiers = {
  dashboard(result) {
    assert.equal(result.extractionMode, 'rendered-text');
    assert.match(result.markdownContent, /Affected pages\n12/);
    assert.match(result.markdownContent, /URL\tLast crawled/);
    for (const excluded of [
      'Overview Insights Performance',
      'Privacy Terms',
      'CSS_HIDDEN_SECRET',
      'SCRIPT_SECRET',
      'PRIVATE_INPUT_VALUE',
    ]) {
      assert.equal(result.markdownContent.includes(excluded), false, `leaked ${excluded}`);
    }
  },
  article(result) {
    assert.equal(result.extractionMode, 'article');
    assert.match(result.markdownContent, /Substantive article prose/);
    assert.equal(Object.hasOwn(result, 'alternateFormats'), false);
    assert.equal(Object.hasOwn(result.metadata, 'excerpt'), false);
  },
  hiddenText(result) {
    assert.equal(result.extractionMode, 'rendered-text');
    assert.match(result.markdownContent, /Visible article prose/);
    assert.equal(result.markdownContent.includes('CSS_HIDDEN_TEXT_SECRET'), false);
  },
  hiddenImage(result) {
    assert.equal(result.extractionMode, 'article');
    assert.match(result.markdownContent, /Visible article prose/);
    assert.equal(result.markdownContent.includes('CSS_HIDDEN_ALT_SECRET'), false);
  },
  hiddenByline(result) {
    assert.equal(result.extractionMode, 'article');
    assert.equal(result.metadata.author, null);
    assert.equal(result.markdownContent.includes('HIDDEN_BYLINE_SECRET'), false);
  },
  ambiguousModal(result) {
    assert.equal(result.extractionMode, 'metadata');
    assert.equal(result.markdownContent.includes('BACKGROUND_MODAL_SECRET'), false);
    assert.equal(result.markdownContent.includes('First foreground'), false);
    assert.equal(result.markdownContent.includes('Second foreground'), false);
  },
  modal(result) {
    assert.equal(result.extractionMode, 'rendered-text');
    assert.match(result.markdownContent, /Session expired/);
    assert.equal(result.markdownContent.includes('Long background article prose'), false);
  },
};

const chrome = findChrome();
if (!chrome) {
  throw new Error(
    'Chrome or Chromium is required for browser tests. Set CHROME_BIN to the executable path.'
  );
}
if (!existsSync(compiledToolPath)) {
  throw new Error('Compiled read_page tool is missing. Run pnpm run build before this test.');
}

const profileDirectory = mkdtempSync(path.join(tmpdir(), 'agentboard-headless-chrome-'));
try {
  const results = await readResults(chrome, profileDirectory);
  for (const [scenario, verify] of Object.entries(verifiers)) {
    assert.ok(results[scenario], `missing ${scenario} result`);
    verify(results[scenario]);
    console.log(`✓ read_page ${scenario}`);
  }
  console.log(`\n${Object.keys(verifiers).length} headless Chromium scenarios passed`);
} finally {
  rmSync(profileDirectory, { recursive: true, force: true });
}
