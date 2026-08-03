import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CdpPipe, chromeSandboxArgs, findChrome, waitFor } from './chrome-harness.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const harnessPath = path.join(repositoryRoot, 'tests/browser/read-page.html');
const compiledToolPath = path.join(repositoryRoot, 'dist/tools/agentboard_read_page.js');
const resultPattern = /AGENTBOARD_BROWSER_RESULT:([A-Za-z0-9+/=]+):END/;
const maxOutputCharacters = 20 * 1024 * 1024;

async function startHarnessServer() {
  const routes = new Map([
    [
      '/tests/browser/read-page.html',
      { body: readFileSync(harnessPath), contentType: 'text/html; charset=utf-8' },
    ],
    [
      '/dist/tools/agentboard_read_page.js',
      { body: readFileSync(compiledToolPath), contentType: 'text/javascript; charset=utf-8' },
    ],
  ]);
  const server = http.createServer((request, response) => {
    const route = routes.get(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    if (request.method !== 'GET' || !route) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': route.contentType,
      'cache-control': 'no-store',
    });
    response.end(route.body);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/tests/browser/read-page.html`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

async function readResults(chrome, profileDirectory, harnessUrl) {
  // Chrome for Testing 151 stopped terminating reliably with --dump-dom, so the
  // harness now uses the same bounded CDP pipe as the MV3 browser gates.
  const detached = process.platform !== 'win32';
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      ...chromeSandboxArgs(),
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
      '--remote-debugging-pipe',
      '--use-mock-keychain',
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ],
    { detached, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
  );
  const closed = new Promise((resolve) => browser.once('close', resolve));
  const cdp = new CdpPipe(browser);
  let stderr = '';
  browser.stderr.setEncoding('utf8');
  browser.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20_000);
  });

  const signalBrowser = (signal) => {
    try {
      if (detached && browser.pid) process.kill(-browser.pid, signal);
      else browser.kill(signal);
    } catch {
      // Chromium may already have exited.
    }
  };
  const stopBrowser = async () => {
    signalBrowser('SIGTERM');
    const forceTimer = setTimeout(() => signalBrowser('SIGKILL'), 1_000);
    let settlementTimer;
    await Promise.race([
      closed,
      new Promise((resolve) => {
        settlementTimer = setTimeout(resolve, 2_500);
      }),
    ]);
    clearTimeout(forceTimer);
    clearTimeout(settlementTimer);
  };

  const collectResults = async () => {
    const target = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find(({ type }) => type === 'page');
    }, 'headless page target');
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: harnessUrl }, sessionId);

    const output = await waitFor(
      async () => {
        const evaluation = await cdp.send(
          'Runtime.evaluate',
          {
            expression: `document.querySelector('#agentboard-browser-result')?.textContent || ''`,
            returnByValue: true,
          },
          sessionId
        );
        const value = evaluation.result?.value;
        return typeof value === 'string' && resultPattern.test(value) ? value : false;
      },
      'read_page browser result',
      30_000
    );
    if (output.length > maxOutputCharacters) {
      throw new Error('Headless Chrome output exceeded the 20 MB safety limit.');
    }

    const marker = output.match(resultPattern);
    if (!marker) throw new Error('Headless Chrome returned an invalid test result.');
    const payload = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8'));
    if (payload.error) throw new Error(payload.error);
    return payload.results;
  };

  let deadlineTimer;
  try {
    return await Promise.race([
      collectResults(),
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(
          () =>
            reject(new Error('Headless Chrome did not produce a test result within 30 seconds.')),
          30_000
        );
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${stderr}`);
  } finally {
    clearTimeout(deadlineTimer);
    await stopBrowser();
  }
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
let harnessServer;
try {
  harnessServer = await startHarnessServer();
  const results = await readResults(chrome, profileDirectory, harnessServer.url);
  for (const [scenario, verify] of Object.entries(verifiers)) {
    assert.ok(results[scenario], `missing ${scenario} result`);
    verify(results[scenario]);
    console.log(`✓ read_page ${scenario}`);
  }
  console.log(`\n${Object.keys(verifiers).length} headless Chromium scenarios passed`);
} finally {
  await harnessServer?.close();
  rmSync(profileDirectory, { recursive: true, force: true });
}
