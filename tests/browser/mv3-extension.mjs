import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpPipe, chromeSandboxArgs, findChrome, waitFor } from './chrome-harness.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const extensionPath = path.join(repositoryRoot, 'dist');
const profileDirectory = mkdtempSync(path.join(tmpdir(), 'agentboard-mv3-chrome-'));
const webMCPFixturePath = '/webmcp-execution';
const webMCPNavigationDestinationPath = '/webmcp-navigation-destination';
const webMCPToolName = 'agentboard_browser_e2e';
const webMCPNavigationToolName = 'agentboard_browser_navigation_e2e';
const webMCPInput = 'bridge-proof';
const webMCPResult = `main-world-closure:${webMCPInput}`;
const webMCPNavigationResult = 'navigation-scheduled';
const pdfFixturePath = '/authenticated-read-page.pdf';
const slowPdfFixturePath = '/slow-read-page.pdf';
const redirectPdfFixturePath = '/redirect-read-page.pdf';
const redirectTargetPath = '/redirect-side-effect';
const multipagePdfFixturePath = '/multipage-read-page.pdf';

function createPdfFixture(
  pageTexts = [['AgentBoard PDF fixture', 'Exact document worker extraction']]
) {
  const fontObject = 3 + pageTexts.length * 2;
  const pageObjects = pageTexts.map((_, index) => 3 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjects.map((object) => `${object} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  ];
  pageTexts.forEach((lines, index) => {
    const pageObject = 3 + index * 2;
    const contentObject = pageObject + 1;
    const stream = [
      'BT',
      '/F1 18 Tf',
      '72 720 Td',
      ...lines.flatMap((line, lineIndex) => [
        ...(lineIndex > 0 ? ['0 -28 Td'] : []),
        `(${line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj`,
      ]),
      'ET',
    ].join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    );
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function webMCPFixtureHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="icon" href="data:,">
  <title>AgentBoard WebMCP execution proof</title>
  <script>
    (() => {
      const closureMarker = 'main-world-closure';
      const state = {
        registration: 'pending',
        executionCount: 0,
        navigationExecutionCount: 0,
        collidingReadExecutionCount: 0,
        lastInput: null,
      };
      globalThis.__agentboardWebMCPProof = state;

      if (!document.modelContext || typeof document.modelContext.registerTool !== 'function') {
        state.registration = 'missing-model-context';
        return;
      }

      try {
        const registrations = [
          document.modelContext.registerTool({
            name: ${JSON.stringify(webMCPToolName)},
            description: 'Synthetic tool registered by the browser-test page',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
            execute(input) {
              state.executionCount += 1;
              state.lastInput = input;
              return closureMarker + ':' + input.value;
            },
          }),
          document.modelContext.registerTool({
            name: ${JSON.stringify(webMCPNavigationToolName)},
            description: 'Synthetic tool that returns while scheduling a full navigation',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            execute() {
              state.navigationExecutionCount += 1;
              setTimeout(() => location.assign(${JSON.stringify(webMCPNavigationDestinationPath)}), 0);
              return ${JSON.stringify(webMCPNavigationResult)};
            },
          }),
          document.modelContext.registerTool({
            name: 'agentboard_read_page',
            description: 'Page-owned collision that must not become the system reader',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            execute() {
              state.collidingReadExecutionCount += 1;
              return { success: false, collision: true };
            },
          }),
        ];
        Promise.all(registrations).then(
          () => { state.registration = 'ready'; },
          () => { state.registration = 'failed'; }
        );
      } catch {
        state.registration = 'failed';
      }
    })();
  </script>
</head>
<body>WebMCP execution proof</body>
</html>`;
}

function webMCPNavigationDestinationHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="icon" href="data:,">
  <title>AgentBoard WebMCP navigation destination</title>
</head>
<body>WebMCP navigation completed</body>
</html>`;
}

async function startWireServer() {
  const requests = [];
  const pdfRequests = [];
  const slowPdfRequests = [];
  const redirectPdfRequests = [];
  const redirectTargetRequests = [];
  const pdfFixture = createPdfFixture();
  const multipagePdfFixture = createPdfFixture([
    Array.from({ length: 24 }, (_, index) => `${index + 1} ${'A'.repeat(36)}`),
    ['Second page'],
    ['Third page'],
  ]);
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && requestUrl.pathname === webMCPFixturePath) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(webMCPFixtureHtml());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === webMCPNavigationDestinationPath) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(webMCPNavigationDestinationHtml());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === pdfFixturePath) {
      const cookie = request.headers.cookie || '';
      pdfRequests.push({ cookie });
      if (pdfRequests.length > 1 && !cookie.includes('agentboard_pdf_session=allowed')) {
        response.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        response.end('session required');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': pdfFixture.length,
        'cache-control': 'no-store',
        'set-cookie': 'agentboard_pdf_session=allowed; Path=/; SameSite=Lax',
      });
      response.end(pdfFixture);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === redirectPdfFixturePath) {
      const cookie = request.headers.cookie || '';
      redirectPdfRequests.push({ cookie });
      if (!cookie.includes('agentboard_redirect_pdf_session=allowed')) {
        response.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': pdfFixture.length,
          'cache-control': 'no-store',
          'set-cookie': 'agentboard_redirect_pdf_session=allowed; Path=/; SameSite=Lax',
        });
        response.end(pdfFixture);
        return;
      }
      response.writeHead(302, { location: redirectTargetPath, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === redirectTargetPath) {
      redirectTargetRequests.push({ cookie: request.headers.cookie || '' });
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(pdfFixture);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === multipagePdfFixturePath) {
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': multipagePdfFixture.length,
        'cache-control': 'no-store',
      });
      response.end(multipagePdfFixture);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === slowPdfFixturePath) {
      const cookie = request.headers.cookie || '';
      const record = { cookie, aborted: false };
      slowPdfRequests.push(record);
      if (!cookie.includes('agentboard_slow_pdf_session=allowed')) {
        response.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': pdfFixture.length,
          'cache-control': 'no-store',
          'set-cookie': 'agentboard_slow_pdf_session=allowed; Path=/; SameSite=Lax',
        });
        response.end(pdfFixture);
        return;
      }

      response.writeHead(200, {
        'content-type': 'application/pdf',
        'cache-control': 'no-store',
      });
      response.write(pdfFixture.subarray(0, 16));
      const timer = setTimeout(() => response.end(pdfFixture.subarray(16)), 10_000);
      response.on('close', () => {
        clearTimeout(timer);
        record.aborted = !response.writableEnded;
      });
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.end(
        `data: ${JSON.stringify({
          id: 'chat_1',
          created: 0,
          model: 'opaque-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'OK' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`
      );
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    endpoint: `http://localhost:${address.port}/v1`,
    webMCPFixtureUrl: `http://localhost:${address.port}${webMCPFixturePath}`,
    webMCPNavigationDestinationUrl: `http://localhost:${address.port}${webMCPNavigationDestinationPath}`,
    pdfFixtureUrl: `http://localhost:${address.port}${pdfFixturePath}`,
    slowPdfFixtureUrl: `http://localhost:${address.port}${slowPdfFixturePath}`,
    redirectPdfFixtureUrl: `http://localhost:${address.port}${redirectPdfFixturePath}`,
    multipagePdfFixtureUrl: `http://localhost:${address.port}${multipagePdfFixturePath}`,
    requests,
    pdfRequests,
    slowPdfRequests,
    redirectPdfRequests,
    redirectTargetRequests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const chrome = findChrome({ forExtension: true });
  if (!chrome) throw new Error('Chrome or Chromium is required for MV3 browser tests');
  const requiredBuiltFiles = [
    'manifest.json',
    'content-scripts/webmcp-polyfill.js',
    'content-scripts/relay.js',
    'content-scripts/page-bridge.js',
    'content-scripts/read-page-html-host.js',
    'content-scripts/pdf-document-host.js',
    'src/lib/webmcp/tools/read_page/pdf/worker-host.html',
  ];
  if (requiredBuiltFiles.some((file) => !existsSync(path.join(extensionPath, file)))) {
    throw new Error(
      'Built extension or WebMCP bridge assets are missing. Run pnpm run build first.'
    );
  }
  assert.equal(
    existsSync(path.join(extensionPath, 'tools/agentboard_read_page.js')),
    false,
    'read_page must not ship as a page-owned public WebMCP asset'
  );

  const wire = await startWireServer();
  const detached = process.platform !== 'win32';
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      ...chromeSandboxArgs(),
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
      '--password-store=basic',
      '--use-mock-keychain',
      '--remote-debugging-pipe',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ],
    { detached, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
  );
  const browserClosed = new Promise((resolve) => browser.once('close', resolve));
  let stderr = '';
  browser.stderr.setEncoding('utf8');
  browser.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20_000);
  });
  const cdp = new CdpPipe(browser);

  const stopBrowser = () => {
    try {
      if (detached && browser.pid) process.kill(-browser.pid, 'SIGTERM');
      else browser.kill('SIGTERM');
    } catch {
      // Chromium may already have exited.
    }
  };

  try {
    let worker;
    try {
      worker = await waitFor(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find(
          ({ type, url }) =>
            type === 'service_worker' &&
            url.startsWith('chrome-extension://') &&
            new URL(url).pathname === '/service-worker-loader.js'
        );
      }, 'extension service worker');
    } catch {
      throw new Error(
        'AgentBoard service worker did not load. Use Chromium or Chrome for Testing (set CHROME_FOR_TESTING_BIN); branded Chrome 137+ disables --load-extension.'
      );
    }
    const extensionId = new URL(worker.url).host;

    const optionsUrl = `chrome-extension://${extensionId}/src/options/index.html`;
    const { targetId: optionsTargetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: optionsTargetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: optionsUrl }, sessionId);

    const evaluate = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (result.exceptionDetails) {
        const detail =
          result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'unknown';
        throw new Error(`Extension page evaluation failed: ${detail}`);
      }
      return result.result?.value;
    };
    const reloadOptions = async () => {
      await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      await waitFor(
        () =>
          evaluate(
            `document.readyState === 'complete' && !!document.querySelector('#agents-list')`
          ),
        'options page reload'
      );
    };
    const getConfig = () =>
      evaluate(`chrome.storage.local.get('config').then(({ config }) => config)`);
    const configEvents = () => evaluate(`globalThis.__configEvents ?? []`);
    const observeConfig = () =>
      evaluate(`(() => {
        globalThis.__configEvents = [];
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.config) {
            const value = changes.config.newValue;
            globalThis.__configEvents.push({
              schemaVersion: value?.schemaVersion,
              hasLegacy: !!value?.agents?.some((agent) => 'openaiCompatible' in agent),
            });
          }
        });
        return true;
      })()`);

    await waitFor(
      () =>
        evaluate(
          `location.protocol === 'chrome-extension:' && document.readyState === 'complete' && !!document.querySelector('#agents-list')`
        ),
      'options page'
    );
    await observeConfig();

    const legacyConfig = {
      agents: [
        {
          id: 'legacy-chat',
          name: 'Legacy Chat',
          description: 'Before migration',
          provider: 'anthropic',
          model: 'opaque-model',
          endpoint: wire.endpoint,
          openaiCompatible: true,
          systemPrompt: 'retired custom instructions',
          temperature: 0.7,
          maxTokens: 1000,
          maxSteps: 10,
          isDefault: true,
          reasoning: {
            enabled: true,
            openai: {
              reasoningEffort: 'medium',
              reasoningSummary: 'detailed',
              ignoredProviderField: true,
            },
            ignoredReasoningField: true,
          },
          ignoredAgentField: true,
        },
        {
          id: 'native-anthropic',
          name: 'Native Anthropic',
          provider: 'anthropic',
          apiKey: 'test-key',
          model: 'native-model',
          temperature: 0.7,
          maxSteps: 10,
          isDefault: false,
        },
      ],
      defaultAgentId: 'legacy-chat',
      logLevel: 'warn',
      ignoredConfigField: true,
    };
    await evaluate(`chrome.storage.local.set({ config: ${JSON.stringify(legacyConfig)} })`);
    const migrated = await waitFor(async () => {
      const config = await getConfig();
      return config?.schemaVersion === 2 ? config : false;
    }, 'schema-v2 migration');
    const migrationEvents = await configEvents();
    assert.equal(migrationEvents.length, 2, 'expected one seed write and one migration write');
    assert.deepEqual(
      migrationEvents.map(({ schemaVersion }) => schemaVersion),
      [undefined, 2]
    );
    assert.equal(migrated.agents[0].apiProtocol, 'openai-chat-completions');
    assert.equal(Object.hasOwn(migrated.agents[0], 'openaiCompatible'), false);
    assert.equal(Object.hasOwn(migrated.agents[0], 'systemPrompt'), false);
    assert.equal(Object.hasOwn(migrated.agents[0], 'maxTokens'), false);
    assert.equal(Object.hasOwn(migrated.agents[0], 'ignoredAgentField'), false);
    assert.equal(Object.hasOwn(migrated.agents[0].reasoning, 'ignoredReasoningField'), false);
    assert.equal(Object.hasOwn(migrated.agents[0].reasoning.openai, 'ignoredProviderField'), false);
    assert.equal(Object.hasOwn(migrated, 'ignoredConfigField'), false);
    console.log('✓ migrated one schema-v1 config write to canonical schema v2');

    await reloadOptions();
    await waitFor(
      () => evaluate(`!!document.querySelector('[data-card-id="legacy-chat"]')`),
      'migrated agent card'
    );
    const cardBadge = await evaluate(
      `document.querySelector('[data-card-id="legacy-chat"] .provider-badge')?.textContent`
    );
    assert.match(cardBadge, /Legacy Chat/i);

    await evaluate(`document.querySelector('[data-card-id="legacy-chat"]')?.click()`);
    await waitFor(
      () => evaluate(`!document.querySelector('#agent-modal')?.classList.contains('hidden')`),
      'agent editor'
    );
    assert.equal(
      await evaluate(`document.querySelector('#agent-modal') instanceof HTMLDialogElement`),
      true
    );
    assert.equal(await evaluate(`document.querySelector('#agent-modal')?.open`), true);
    assert.equal(
      await evaluate(`document.querySelector('#agent-connection-api')?.value`),
      'openai'
    );
    assert.equal(
      await evaluate(`document.querySelector('#agent-openai-api-mode')?.value`),
      'openai-chat-completions'
    );
    assert.equal(
      await evaluate(
        `document.querySelector('#reasoning-summary-group')?.classList.contains('hidden')`
      ),
      true
    );
    assert.match(
      await evaluate(`document.querySelector('#agent-connection-api + .field-hint')?.textContent`),
      /not the model vendor/i
    );
    assert.equal(
      await evaluate(
        `document.querySelector('#agent-connection-api')?.getAttribute('aria-describedby')`
      ),
      'agent-connection-api-hint'
    );
    assert.equal(await evaluate(`document.querySelector('#agent-api-key')?.required`), false);
    assert.equal(await evaluate(`document.querySelector('#agent-max-tokens')`), null);
    assert.equal(await evaluate(`document.querySelector('#agent-system-prompt')`), null);
    assert.equal(
      await evaluate(
        `document.querySelector('#agent-openai-api-mode')?.getAttribute('aria-describedby')`
      ),
      'agent-openai-api-mode-hint'
    );
    assert.equal(
      await evaluate(`document.querySelector('#agent-model')?.getAttribute('aria-describedby')`),
      'agent-model-hint'
    );
    assert.equal(
      await evaluate(`document.querySelector('#agent-api-key')?.getAttribute('aria-describedby')`),
      'agent-api-key-hint'
    );
    assert.match(
      await evaluate(`document.querySelector('.api-key-hint')?.textContent`),
      /only if this endpoint accepts requests without an API key/i
    );
    console.log('✓ rendered migrated legacy Chat as an explicit Connection API choice');

    await evaluate(`document.querySelector('#modal-close')?.click()`);
    await evaluate(`document.querySelector('[data-card-id="native-anthropic"]')?.click()`);
    await waitFor(
      () => evaluate(`document.querySelector('#agent-connection-api')?.value === 'anthropic'`),
      'native Anthropic editor'
    );
    assert.equal(
      await evaluate(`document.querySelector('#agent-openai-api-mode')?.value`),
      'openai-responses'
    );
    await evaluate(`(() => {
      const api = document.querySelector('#agent-connection-api');
      api.value = 'openai';
      api.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    assert.equal(
      await evaluate(`document.querySelector('#agent-openai-api-mode')?.value`),
      'openai-responses'
    );
    await evaluate(`document.querySelector('#modal-close')?.click()`);
    await evaluate(`document.querySelector('[data-card-id="legacy-chat"]')?.click()`);
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('#agent-openai-api-mode')?.value === 'openai-chat-completions'`
        ),
      'legacy Chat editor reopened'
    );
    console.log('✓ reset hidden protocol state between sequential native dialog edits');

    await observeConfig();
    await evaluate(`(() => {
      const description = document.querySelector('#agent-description');
      description.value = '';
      description.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.modal-test-btn')?.click();
    })()`);
    await waitFor(() => wire.requests.length === 1, 'localhost Chat request');
    assert.equal(wire.requests[0].url, '/v1/chat/completions');
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('#agent-modal-status')?.classList.contains('success') && document.querySelector('#agent-modal-status')?.textContent.includes('Legacy Chat')`
        ),
      'Connection Test result'
    );
    await evaluate(`document.querySelector('.modal-save-btn')?.click()`);
    const saved = await waitFor(async () => {
      const config = await getConfig();
      return config?.agents?.[0] && !Object.hasOwn(config.agents[0], 'description')
        ? config
        : false;
    }, 'saved v2 agent with cleared optional field');
    assert.equal(saved.agents[0].apiProtocol, 'openai-chat-completions');
    assert.equal(saved.agents[0].provider, 'anthropic');
    assert.equal(Object.hasOwn(saved.agents[0], 'openaiCompatible'), false);
    assert.equal(Object.hasOwn(saved.agents[0].reasoning.openai, 'reasoningSummary'), false);
    assert.equal((await configEvents()).length, 1, 'save should issue one config write');
    console.log(
      '✓ tested, cleared, and saved an optional field through the production options flow'
    );

    const configWritesBeforeRestart = (await configEvents()).length;
    const { success: workerClosed } = await cdp.send('Target.closeTarget', {
      targetId: worker.targetId,
    });
    assert.equal(workerClosed, true);
    const ping = await evaluate(`chrome.runtime.sendMessage({ type: 'PING' })`);
    assert.equal(ping.pong, true);
    await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.some(
        ({ targetId, type, url }) =>
          targetId !== worker.targetId &&
          type === 'service_worker' &&
          url.startsWith(`chrome-extension://${extensionId}/`)
      );
    }, 'restarted service worker');
    assert.equal((await configEvents()).length, configWritesBeforeRestart);
    assert.deepEqual(await getConfig(), saved);
    console.log('✓ restarted the MV3 worker without another migration write');

    // This page supplies only a normal MAIN-world tool registration. Discovery and
    // execution must cross the built extension's webNavigation injection, isolated
    // relay, MAIN-world bridge, service worker, and public runtime message boundary.
    const providerRequestsBeforeWebMCP = wire.requests.length;
    const { targetId: fixtureTargetId } = await cdp.send('Target.createTarget', {
      url: wire.webMCPFixtureUrl,
    });
    const { sessionId: fixtureSessionId } = await cdp.send('Target.attachToTarget', {
      targetId: fixtureTargetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, fixtureSessionId);
    await cdp.send('Page.enable', {}, fixtureSessionId);
    const evaluateFixture = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        fixtureSessionId
      );
      if (result.exceptionDetails) throw new Error('WebMCP fixture evaluation failed');
      return result.result?.value;
    };

    try {
      await waitFor(
        () =>
          evaluateFixture(
            `document.readyState === 'complete' && globalThis.__agentboardWebMCPProof?.registration === 'ready' && globalThis.__webmcpPageBridge?.version === 3`
          ),
        'built WebMCP page bridge'
      );
      const fixtureTabId = await waitFor(
        () =>
          evaluate(
            `chrome.tabs.query({ url: ${JSON.stringify(wire.webMCPFixtureUrl)} }).then(([tab]) => tab?.id || false)`
          ),
        'WebMCP fixture tab ID'
      );
      assert.equal(
        await evaluate(
          `chrome.scripting.executeScript({ target: { tabId: ${fixtureTabId} }, files: ['content-scripts/relay.js'] }).then(() => true, () => false)`
        ),
        true,
        'the built classic relay must remain safe to inject twice in one document'
      );
      const pageTools = await waitFor(
        () =>
          evaluate(
            `chrome.runtime.sendMessage({ type: 'WEBMCP_GET_TOOLS', tabId: ${fixtureTabId} }).then((response) => response?.success && [${JSON.stringify(webMCPToolName)}, ${JSON.stringify(webMCPNavigationToolName)}].every((name) => response.data.some((tool) => tool.name === name)) ? response.data : false)`
          ),
        'page tool discovery through the built extension'
      );
      const pageTool = pageTools.find(({ name }) => name === webMCPToolName);
      const navigationTool = pageTools.find(({ name }) => name === webMCPNavigationToolName);
      assert.equal(pageTool.description, 'Synthetic tool registered by the browser-test page');
      assert.equal(pageTool.inputSchema?.properties?.value?.type, 'string');
      assert.equal(
        navigationTool.description,
        'Synthetic tool that returns while scheduling a full navigation'
      );

      const callResponse = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${fixtureTabId}, toolName: ${JSON.stringify(webMCPToolName)}, args: { value: ${JSON.stringify(webMCPInput)} } })`
      );
      assert.deepEqual(callResponse, { success: true, result: webMCPResult });
      assert.equal(
        wire.requests.length,
        providerRequestsBeforeWebMCP,
        'the synthetic WebMCP proof must not contact the provider endpoint'
      );
      assert.deepEqual(
        await evaluateFixture(`({
          ...globalThis.__agentboardWebMCPProof,
          bridgeVersion: globalThis.__webmcpPageBridge?.version,
          modelContextTag: Object.prototype.toString.call(document.modelContext),
        })`),
        {
          registration: 'ready',
          executionCount: 1,
          navigationExecutionCount: 0,
          collidingReadExecutionCount: 0,
          lastInput: { value: webMCPInput },
          bridgeVersion: 3,
          modelContextTag: '[object ModelContext]',
        }
      );
      console.log('✓ executed a MAIN-world page tool through the built MV3 relay and bridge');

      assert.equal(
        pageTools.filter(({ name }) => name === 'agentboard_read_page').length,
        1,
        'the public catalog must contain only the system-owned reader'
      );
      assert.equal(
        await evaluateFixture(`(() => {
          Object.defineProperty(globalThis, 'DOMParser', {
            configurable: true,
            value: class PoisonedDOMParser {
              constructor() { throw new Error('MAIN_WORLD_DOMPARSER_USED'); }
            },
          });
          Object.defineProperty(HTMLElement.prototype, 'innerText', {
            configurable: true,
            get() { throw new Error('MAIN_WORLD_INNERTEXT_USED'); },
          });
          Object.defineProperty(document, 'modelContext', {
            configurable: true,
            get() { throw new Error('MAIN_WORLD_MODELCONTEXT_USED'); },
          });
          return globalThis.__agentboardReadPageHtmlV1 === undefined;
        })()`),
        true,
        'the private reader host must not be visible in MAIN world'
      );

      const htmlReadResponse = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${fixtureTabId}, toolName: 'agentboard_read_page', args: { maxLength: 4000, startPage: 123, maxPages: 10 } })`
      );
      assert.equal(htmlReadResponse.success, true, JSON.stringify(htmlReadResponse));
      assert.equal(htmlReadResponse.result.success, true, JSON.stringify(htmlReadResponse));
      assert.equal(htmlReadResponse.result.metadata.url, wire.webMCPFixtureUrl);
      assert.ok(
        ['article', 'rendered-text', 'metadata'].includes(htmlReadResponse.result.extractionMode)
      );
      assert.match(htmlReadResponse.result.markdownContent, /WebMCP execution proof/);
      const repeatedHtmlReadResponse = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${fixtureTabId}, toolName: 'agentboard_read_page', args: { maxLength: 4000 } })`
      );
      assert.equal(
        repeatedHtmlReadResponse.success,
        true,
        JSON.stringify(repeatedHtmlReadResponse)
      );
      assert.equal(
        repeatedHtmlReadResponse.result.metadata.url,
        wire.webMCPFixtureUrl,
        'the idempotent private HTML host must support repeated file injection'
      );
      assert.equal(
        await evaluateFixture(
          `globalThis.__agentboardWebMCPProof.collidingReadExecutionCount === 0 && globalThis.__agentboardReadPageHtmlV1 === undefined`
        ),
        true,
        'the page collision and MAIN world must not observe private reader execution'
      );
      console.log(
        '✓ routed the private ISOLATED-world system reader across page collisions and MAIN monkey patches'
      );

      const navigationResponse = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${fixtureTabId}, toolName: ${JSON.stringify(webMCPNavigationToolName)}, args: {} })`
      );
      assert.deepEqual(navigationResponse, {
        success: true,
        result: webMCPNavigationResult,
      });
      await waitFor(
        () =>
          evaluateFixture(
            `location.href === ${JSON.stringify(wire.webMCPNavigationDestinationUrl)} && document.readyState === 'complete' && globalThis.__webmcpPageBridge?.version === 3`
          ),
        'WebMCP navigation destination'
      );
      await waitFor(
        () =>
          evaluate(
            `chrome.runtime.sendMessage({ type: 'WEBMCP_GET_TOOLS', tabId: ${fixtureTabId} }).then((response) => response?.success && !response.data.some(({ name }) => [${JSON.stringify(webMCPToolName)}, ${JSON.stringify(webMCPNavigationToolName)}].includes(name)) ? response.data : false)`
          ),
        'replacement document catalog'
      );
      assert.equal(
        wire.requests.length,
        providerRequestsBeforeWebMCP,
        'navigation-triggering WebMCP execution must not contact the provider endpoint'
      );
      console.log('✓ settled a WebMCP result before its full-navigation teardown');
    } finally {
      await cdp.send('Target.closeTarget', { targetId: fixtureTargetId });
    }

    const { targetId: pdfTargetId } = await cdp.send('Target.createTarget', {
      url: wire.pdfFixtureUrl,
    });
    try {
      const pdfTabId = await waitFor(
        () =>
          evaluate(
            `chrome.tabs.query({ url: ${JSON.stringify(wire.pdfFixtureUrl)} }).then(([tab]) => tab?.id || false)`
          ),
        'PDF fixture tab ID'
      );
      const pdfFrame = await waitFor(
        () =>
          evaluate(
            `chrome.webNavigation.getFrame({ tabId: ${pdfTabId}, frameId: 0 }).then((frame) => frame?.documentId ? ({ documentId: frame.documentId, url: frame.url }) : false)`
          ),
        'PDF top document'
      );
      assert.equal(pdfFrame.url, wire.pdfFixtureUrl);
      await waitFor(
        () =>
          evaluate(
            `chrome.scripting.executeScript({ target: { tabId: ${pdfTabId}, documentIds: [${JSON.stringify(pdfFrame.documentId)}] }, world: 'ISOLATED', func: () => document.contentType }).then(([result]) => result?.documentId === ${JSON.stringify(pdfFrame.documentId)} && result?.result === 'application/pdf', () => false)`
          ),
        'PDF content type probe'
      );
      await waitFor(
        () =>
          evaluate(
            `chrome.runtime.sendMessage({ type: 'WEBMCP_GET_TOOLS', tabId: ${pdfTabId} }).then((response) => response?.success && response.data.some(({ name }) => name === 'agentboard_read_page'))`
          ),
        'read-page capability in PDF tab'
      );

      const pdfCall = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${pdfTabId}, toolName: 'agentboard_read_page', args: { startPage: 1, maxPages: 5, maxLength: 32000 } })`
      );
      assert.equal(pdfCall.success, true, JSON.stringify(pdfCall));
      const pdfResult = pdfCall.result;
      assert.equal(pdfResult.success, true, JSON.stringify(pdfResult));
      assert.equal(pdfResult.extractionMode, 'pdf');
      assert.equal(pdfResult.pdf.pageCount, 1);
      assert.equal(pdfResult.pdf.startPage, 1);
      assert.equal(pdfResult.pdf.endPage, 1);
      assert.match(pdfResult.markdownContent, /AgentBoard PDF fixture/);
      assert.match(pdfResult.markdownContent, /Exact document worker extraction/);
      assert.equal(wire.pdfRequests[0]?.cookie || '', '');
      assert.ok(
        wire.pdfRequests
          .slice(1)
          .some(({ cookie }) => cookie.includes('agentboard_pdf_session=allowed')),
        'the exact-document refetch must carry the PDF page session cookie'
      );
      console.log('✓ extracted an authenticated native-viewer PDF through a real local worker');
    } finally {
      await cdp.send('Target.closeTarget', { targetId: pdfTargetId });
    }

    const { targetId: multipagePdfTargetId } = await cdp.send('Target.createTarget', {
      url: wire.multipagePdfFixtureUrl,
    });
    try {
      const multipagePdfTabId = await waitFor(
        () =>
          evaluate(
            `chrome.tabs.query({ url: ${JSON.stringify(wire.multipagePdfFixtureUrl)} }).then(([tab]) => tab?.id || false)`
          ),
        'multipage PDF fixture tab ID'
      );
      await waitFor(
        () =>
          evaluate(
            `chrome.runtime.sendMessage({ type: 'WEBMCP_GET_TOOLS', tabId: ${multipagePdfTabId} }).then((response) => response?.success && response.data.some(({ name }) => name === 'agentboard_read_page'))`
          ),
        'read-page capability in multipage PDF tab'
      );
      const paginatedPdfCall = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${multipagePdfTabId}, toolName: 'agentboard_read_page', args: { maxPages: 2 } })`
      );
      assert.equal(paginatedPdfCall.success, true, JSON.stringify(paginatedPdfCall));
      assert.equal(paginatedPdfCall.result.success, true, JSON.stringify(paginatedPdfCall));
      assert.equal(paginatedPdfCall.result.pdf.endPage, 2);
      assert.equal(paginatedPdfCall.result.pdf.nextPage, 3);
      assert.equal(paginatedPdfCall.result.stats.extractedPageCount, 2);

      const oversizedFirstPageCall = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${multipagePdfTabId}, toolName: 'agentboard_read_page', args: { maxLength: 1000, maxPages: 1 } })`
      );
      assert.equal(oversizedFirstPageCall.success, true, JSON.stringify(oversizedFirstPageCall));
      assert.equal(
        oversizedFirstPageCall.result.success,
        false,
        JSON.stringify(oversizedFirstPageCall)
      );
      assert.equal(oversizedFirstPageCall.result.error.code, 'TOO_LARGE');
      console.log('✓ preserved complete PDF pages and honest continuation under output bounds');
    } finally {
      await cdp.send('Target.closeTarget', { targetId: multipagePdfTargetId });
    }

    const { targetId: hostileHostTargetId } = await cdp.send('Target.createTarget', {
      url: wire.webMCPNavigationDestinationUrl,
    });
    const { sessionId: hostileHostSessionId } = await cdp.send('Target.attachToTarget', {
      targetId: hostileHostTargetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, hostileHostSessionId);
    await cdp.send('Page.enable', {}, hostileHostSessionId);
    try {
      const hostileHostResult = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(async () => {
            const token = 'page-chosen-token';
            const iframe = document.createElement('iframe');
            iframe.src = 'chrome-extension://${extensionId}/src/lib/webmcp/tools/read_page/pdf/worker-host.html#' + token;
            document.body.append(iframe);
            return new Promise((resolve) => {
              let loaded = false;
              let result = null;
              const timer = setTimeout(() => resolve({ loaded, result }), 750);
              iframe.addEventListener('load', () => {
                loaded = true;
                const channel = new MessageChannel();
                channel.port1.onmessage = ({ data }) => {
                  result = data;
                  clearTimeout(timer);
                  resolve({ loaded, result });
                };
                iframe.contentWindow.postMessage({ token }, 'chrome-extension://${extensionId}', [channel.port2]);
                const bytes = new TextEncoder().encode('%PDF-1.4').buffer;
                channel.port1.postMessage({
                  type: 'parse',
                  bytes,
                  options: { maxLength: 32000, startPage: 1, maxPages: 5 },
                  source: { title: 'hostile', url: location.href },
                }, [bytes]);
              }, { once: true });
            });
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        hostileHostSessionId
      );
      assert.equal(hostileHostResult.exceptionDetails, undefined);
      assert.deepEqual(hostileHostResult.result?.value, { loaded: true, result: null });
      console.log('✓ rejected page-chosen PDF worker-host capabilities');
    } finally {
      await cdp.send('Target.closeTarget', { targetId: hostileHostTargetId });
    }

    const { targetId: redirectPdfTargetId } = await cdp.send('Target.createTarget', {
      url: wire.redirectPdfFixtureUrl,
    });
    try {
      const redirectPdfTabId = await waitFor(
        () =>
          evaluate(
            `chrome.tabs.query({ url: ${JSON.stringify(wire.redirectPdfFixtureUrl)} }).then(([tab]) => tab?.id || false)`
          ),
        'redirect PDF fixture tab ID'
      );
      await waitFor(
        () =>
          evaluate(
            `chrome.runtime.sendMessage({ type: 'WEBMCP_GET_TOOLS', tabId: ${redirectPdfTabId} }).then((response) => response?.success && response.data.some(({ name }) => name === 'agentboard_read_page'))`
          ),
        'read-page capability in redirect PDF tab'
      );
      const redirectPdfCall = await evaluate(
        `chrome.runtime.sendMessage({ type: 'WEBMCP_CALL_TOOL', tabId: ${redirectPdfTabId}, toolName: 'agentboard_read_page', args: {} })`
      );
      assert.equal(redirectPdfCall.success, true, JSON.stringify(redirectPdfCall));
      assert.equal(redirectPdfCall.result.success, false);
      assert.equal(redirectPdfCall.result.error.code, 'REFETCH_FAILED');
      assert.ok(wire.redirectPdfRequests.length >= 2);
      assert.equal(
        wire.redirectTargetRequests.length,
        0,
        'credentialed PDF reacquisition must not follow redirects'
      );
      console.log('✓ rejected PDF refetch redirects before issuing the target request');
    } finally {
      await cdp.send('Target.closeTarget', { targetId: redirectPdfTargetId });
    }

    const { targetId: slowPdfTargetId } = await cdp.send('Target.createTarget', {
      url: wire.slowPdfFixtureUrl,
    });
    try {
      const slowPdfTabId = await waitFor(
        () =>
          evaluate(
            `chrome.tabs.query({ url: ${JSON.stringify(wire.slowPdfFixtureUrl)} }).then(([tab]) => tab?.id || false)`
          ),
        'slow PDF fixture tab ID'
      );
      await waitFor(
        () =>
          evaluate(
            `chrome.runtime.sendMessage({ type: 'WEBMCP_GET_TOOLS', tabId: ${slowPdfTabId} }).then((response) => response?.success && response.data.some(({ name }) => name === 'agentboard_read_page'))`
          ),
        'read-page capability in slow PDF tab'
      );
      await evaluate(`(() => {
        globalThis.__agentboardSlowPdfCall = chrome.runtime.sendMessage({
          type: 'WEBMCP_CALL_TOOL',
          tabId: ${slowPdfTabId},
          toolName: 'agentboard_read_page',
          args: { maxLength: 32000 },
        });
        return true;
      })()`);
      await waitFor(() => wire.slowPdfRequests.length >= 2, 'document-owned PDF refetch to start');
      await evaluate(
        `chrome.tabs.update(${slowPdfTabId}, { url: ${JSON.stringify(wire.webMCPNavigationDestinationUrl)} })`
      );
      const cancelledPdfCall = await evaluate('globalThis.__agentboardSlowPdfCall');
      assert.equal(cancelledPdfCall.success, true, JSON.stringify(cancelledPdfCall));
      assert.equal(cancelledPdfCall.result.success, false);
      assert.equal(cancelledPdfCall.result.error.code, 'NAVIGATED');
      await waitFor(
        () => wire.slowPdfRequests.slice(1).some(({ aborted }) => aborted),
        'navigation to abort the document-owned PDF refetch'
      );
      await evaluate('delete globalThis.__agentboardSlowPdfCall');
      console.log('✓ aborted PDF fetch and settlement when its exact document navigated');
    } finally {
      await cdp.send('Target.closeTarget', { targetId: slowPdfTargetId });
    }

    // Hold the production storage lock in this options page, then trigger a real
    // ConfigStorage mutation from a second extension page. The write must remain
    // pending until the first context releases the origin-scoped Web Lock.
    const { targetId: secondOptionsTargetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId: secondSessionId } = await cdp.send('Target.attachToTarget', {
      targetId: secondOptionsTargetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, secondSessionId);
    await cdp.send('Page.enable', {}, secondSessionId);
    await cdp.send('Page.navigate', { url: optionsUrl }, secondSessionId);
    const evaluateSecond = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        secondSessionId
      );
      if (result.exceptionDetails) throw new Error('Second extension page evaluation failed');
      return result.result?.value;
    };
    await waitFor(
      () =>
        evaluateSecond(
          `location.protocol === 'chrome-extension:' && document.readyState === 'complete' && !!document.querySelector('#log-level')`
        ),
      'second options page'
    );
    await waitFor(
      () =>
        evaluate(
          `navigator.locks.query().then(({ held, pending }) => ![...held, ...pending].some(({ name }) => name === 'agentboard-storage-operation'))`
        ),
      'idle cross-context storage lock'
    );
    await evaluate(`(() => {
      globalThis.__storageLockAcquired = false;
      globalThis.__storageLockGate = new Promise((resolve) => {
        globalThis.__releaseStorageLock = resolve;
      });
      void navigator.locks.request('agentboard-storage-operation', async () => {
        globalThis.__storageLockAcquired = true;
        await globalThis.__storageLockGate;
      });
      return true;
    })()`);
    await waitFor(() => evaluate(`globalThis.__storageLockAcquired === true`), 'held storage lock');
    await evaluateSecond(`(() => {
      const select = document.querySelector('#log-level');
      select.value = 'debug';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(
      () =>
        evaluate(
          `navigator.locks.query().then(({ pending }) => pending.some(({ name }) => name === 'agentboard-storage-operation'))`
        ),
      'cross-context config mutation'
    );
    assert.equal((await getConfig()).logLevel, saved.logLevel);
    await evaluate(`globalThis.__releaseStorageLock(); true`);
    await waitFor(async () => (await getConfig()).logLevel === 'debug', 'released config mutation');
    await cdp.send('Target.closeTarget', { targetId: secondOptionsTargetId });
    console.log('✓ serialized config mutation across two extension page contexts');

    const requestCountBeforeInvalidConfig = wire.requests.length;
    const futureSentinel = 'FUTURE_CONFIG_SECRET_SENTINEL';
    await evaluate(
      `chrome.storage.local.set({ config: ${JSON.stringify({
        schemaVersion: 3,
        agents: [{ ...saved.agents[0], apiKey: futureSentinel }],
      })} })`
    );
    const futureResponse = await evaluate(
      `chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', agentId: 'legacy-chat' })`
    );
    assert.equal(futureResponse.success, false);
    assert.match(futureResponse.message, /unsupported AgentBoard version/i);
    assert.equal(futureResponse.message.includes(futureSentinel), false);
    assert.equal(wire.requests.length, requestCountBeforeInvalidConfig);
    assert.equal((await getConfig()).schemaVersion, 3);

    await reloadOptions();
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('#status-message')?.textContent.includes('unsupported AgentBoard version')`
        ),
      'future-schema UI error'
    );
    assert.equal(
      await evaluate(`document.body.textContent.includes(${JSON.stringify(futureSentinel)})`),
      false
    );

    const recoveryBackup = {
      version: '2.0',
      extensionVersion: '0.7.3',
      timestamp: Date.now(),
      exportedBy: 'AgentBoard',
      config: saved,
      commands: { userCommands: [] },
    };
    assert.equal(
      await evaluate(`(() => {
        const button = document.querySelector('#import-settings');
        const input = document.querySelector('#import-file-input');
        if (!(button instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) {
          return false;
        }
        globalThis.__recoveryPickerOpened = false;
        input.click = () => { globalThis.__recoveryPickerOpened = true; };
        button.click();
        if (!globalThis.__recoveryPickerOpened) return false;

        const transfer = new DataTransfer();
        transfer.items.add(new File(
          [${JSON.stringify(JSON.stringify(recoveryBackup))}],
          'agentboard-recovery.json',
          { type: 'application/json' }
        ));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`),
      true
    );
    await waitFor(async () => (await getConfig()).schemaVersion === 2, 'backup recovery write');
    await waitFor(
      () =>
        evaluate(
          `document.readyState === 'complete' && !!document.querySelector('#agents-list .card') && !document.querySelector('#status-message')?.textContent.includes('unsupported AgentBoard version')`
        ),
      'post-recovery options reload'
    );
    assert.equal(wire.requests.length, requestCountBeforeInvalidConfig);
    console.log('✓ recovered future config through the still-operable backup import');

    const malformedSentinel = 'MALFORMED_CONFIG_SECRET_SENTINEL';
    const malformedConfig = {
      ...saved,
      agents: [
        {
          ...saved.agents[0],
          apiProtocol: 'unknown-protocol',
          apiKey: malformedSentinel,
        },
      ],
    };
    await evaluate(`chrome.storage.local.set({ config: ${JSON.stringify(malformedConfig)} })`);
    const malformedResponse = await evaluate(
      `chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', agentId: 'legacy-chat' })`
    );
    assert.equal(malformedResponse.success, false);
    assert.match(malformedResponse.message, /configuration is invalid/i);
    assert.equal(malformedResponse.message.includes(malformedSentinel), false);
    assert.equal(wire.requests.length, requestCountBeforeInvalidConfig);
    assert.equal((await getConfig()).agents[0].apiProtocol, 'unknown-protocol');
    console.log('✓ failed closed for future and malformed config with zero provider requests');
  } catch (error) {
    if (browser.exitCode !== null) {
      throw new Error(`Chromium exited during MV3 config test. ${stderr.slice(-4000)}`);
    }
    throw error;
  } finally {
    stopBrowser();
    const forceTimer = setTimeout(() => {
      try {
        if (detached && browser.pid) process.kill(-browser.pid, 'SIGKILL');
        else browser.kill('SIGKILL');
      } catch {
        // Chromium may have exited between the timeout and signal.
      }
    }, 1_000);
    await browserClosed;
    clearTimeout(forceTimer);
    await wire.close();
  }
}

try {
  await main();
  console.log('\n16 built-MV3 Chromium scenarios passed');
} finally {
  rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
