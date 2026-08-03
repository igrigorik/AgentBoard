import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactDiagnosticString } from '../src/lib/logger/redaction';

const relaySource = readFileSync(resolve('src/content-scripts/relay.js'), 'utf8').replace(
  "import { redactDiagnosticString } from '../lib/logger/redaction?relay-inline';\n\n",
  ''
);

type RelayBridge = {
  isShutdown: boolean;
  shutdown: () => void;
  onPageMessage: (event: { source: Window; data: unknown }) => void;
};
type RelayWindow = Window & typeof globalThis & { __webmcpRelayBridge?: RelayBridge };

function listenerEvent<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    listeners,
    addListener: vi.fn((listener: T) => listeners.add(listener)),
    removeListener: vi.fn((listener: T) => listeners.delete(listener)),
  };
}

function createHarness() {
  const dom = new JSDOM('<!doctype html>', {
    runScripts: 'outside-only',
    url: 'https://page.example.test/',
  });
  const window = dom.window as unknown as RelayWindow;
  const storageChanged = listenerEvent<(changes: unknown, area: string) => void>();
  const portMessages = listenerEvent<(message: unknown) => void>();
  const portDisconnects = listenerEvent<() => void>();
  const port = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: portMessages,
    onDisconnect: portDisconnects,
  };
  const sendMessage = vi.fn(
    (_request: unknown, callback: (response: { logLevel: string }) => void) => {
      callback({ logLevel: 'warn' });
    }
  );
  const chromeHarness = {
    runtime: {
      connect: vi.fn(() => port),
      sendMessage,
      lastError: null,
    },
    storage: { onChanged: storageChanged },
  };
  Object.defineProperty(window, 'chrome', { value: chromeHarness });

  return {
    dom,
    window,
    chromeHarness,
    port,
    portMessages,
    portDisconnects,
    storageChanged,
  };
}

function inject(window: RelayWindow): void {
  window.eval(`${redactDiagnosticString.toString()}\n${relaySource}`);
}

describe('real WebMCP relay source', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    harness.window.__webmcpRelayBridge?.shutdown();
    harness.dom.window.close();
    vi.useRealTimers();
  });

  it('makes duplicate injection side-effect free and requests only log level', () => {
    const addWindowListener = vi.spyOn(harness.window, 'addEventListener');

    inject(harness.window);
    const firstBridge = harness.window.__webmcpRelayBridge;
    inject(harness.window);

    expect(harness.window.__webmcpRelayBridge).toBe(firstBridge);
    expect(harness.chromeHarness.runtime.connect).toHaveBeenCalledTimes(1);
    expect(harness.chromeHarness.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.chromeHarness.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'GET_LOG_LEVEL' },
      expect.any(Function)
    );
    expect(harness.storageChanged.addListener).not.toHaveBeenCalled();
    expect(addWindowListener).toHaveBeenCalledTimes(1);
  });

  it('queues page messages across a disconnect and flushes them after reconnecting', () => {
    let reconnect: (() => void) | undefined;
    const setTimeout = vi
      .spyOn(harness.window as unknown as Window, 'setTimeout')
      .mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') reconnect = () => handler();
        return 1;
      });
    inject(harness.window);
    const bridge = harness.window.__webmcpRelayBridge!;
    const [disconnect] = harness.portDisconnects.listeners;
    disconnect();

    bridge.onPageMessage({
      source: harness.window,
      data: {
        source: 'webmcp-main',
        jsonrpc: '2.0',
        method: 'tools/listChanged',
        params: { tools: [] },
      },
    });
    expect(harness.port.postMessage).not.toHaveBeenCalled();

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 100);
    reconnect?.();

    expect(harness.chromeHarness.runtime.connect).toHaveBeenCalledTimes(2);
    expect(harness.port.postMessage).toHaveBeenCalledWith({
      type: 'webmcp',
      payload: {
        jsonrpc: '2.0',
        method: 'tools/listChanged',
        params: { tools: [] },
      },
      tabUrl: 'https://page.example.test/',
      timestamp: expect.any(Number),
    });
  });

  it('updates logging only through an explicit level-only port message', () => {
    const consoleLog = vi.spyOn(harness.window.console, 'log').mockImplementation(() => {});
    inject(harness.window);
    const portMessage = [...harness.portMessages.listeners][0];

    portMessage({ type: 'RELAY_LOG_LEVEL', logLevel: 'info' });
    harness.window.__webmcpRelayBridge!.onPageMessage({
      source: harness.window,
      data: {
        source: 'webmcp-main',
        jsonrpc: '2.0',
        method: 'secret page method',
      },
    });

    expect(consoleLog).toHaveBeenCalledWith('[AgentBoard] Relay event');
    expect(consoleLog.mock.calls.flat().map(String).join('\n')).not.toContain('secret page method');
  });

  it('does not let a stale level read overwrite a newer pushed level', () => {
    let finishRefresh!: (response: { logLevel: string }) => void;
    harness.chromeHarness.runtime.sendMessage.mockImplementation((_request, callback) => {
      finishRefresh = callback;
    });
    const consoleLog = vi.spyOn(harness.window.console, 'log').mockImplementation(() => {});
    inject(harness.window);
    const portMessage = [...harness.portMessages.listeners][0];

    portMessage({ type: 'RELAY_LOG_LEVEL', logLevel: 'info' });
    finishRefresh({ logLevel: 'debug' });
    harness.window.__webmcpRelayBridge!.onPageMessage({
      source: harness.window,
      data: {
        source: 'webmcp-main',
        jsonrpc: '2.0',
        method: 'private page method',
      },
    });

    expect(consoleLog).toHaveBeenCalledWith('[AgentBoard] Relay event');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('private page method');
  });

  it('retains sanitized relay context at debug level', () => {
    const consoleLog = vi.spyOn(harness.window.console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(harness.window.console, 'error').mockImplementation(() => {});
    inject(harness.window);
    const portMessage = [...harness.portMessages.listeners][0];
    portMessage({ type: 'RELAY_LOG_LEVEL', logLevel: 'debug' });
    consoleLog.mockClear();
    consoleError.mockClear();

    harness.window.__webmcpRelayBridge!.onPageMessage({
      source: harness.window,
      data: {
        source: 'webmcp-main',
        jsonrpc: '2.0',
        method: 'tools/listChanged',
      },
    });

    expect(consoleLog).toHaveBeenCalledWith(
      '[AgentBoard]',
      '[WebMCP Relay] Forwarded to background:',
      'tools/listChanged'
    );

    const pageCredential = 'page-object-credential';
    harness.window.__webmcpRelayBridge!.onPageMessage({
      source: harness.window,
      data: {
        source: 'webmcp-main',
        jsonrpc: '2.0',
        method: { apiKey: pageCredential },
      },
    });
    expect(JSON.stringify(consoleLog.mock.calls)).toContain('[Object]');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(pageCredential);

    const credential = 'sk-relay-credential-123456';
    const plainSecret = 'plain-relay-secret';
    harness.port.postMessage.mockImplementationOnce(() => {
      throw new Error(`{"client_secret":"${plainSecret}"} Basic ${credential}`);
    });
    harness.window.__webmcpRelayBridge!.onPageMessage({
      source: harness.window,
      data: {
        source: 'webmcp-main',
        jsonrpc: '2.0',
        method: 'tools/call',
      },
    });

    const renderedError = JSON.stringify(consoleError.mock.calls);
    expect(renderedError).toContain('[WebMCP Relay] Failed to send message:');
    expect(renderedError).toContain('[REDACTED]');
    expect(renderedError).not.toContain(credential);
    expect(renderedError).not.toContain(plainSecret);
  });

  it('disposes its document listener before replacing a shut-down relay', () => {
    const addWindowListener = vi.spyOn(harness.window, 'addEventListener');
    const removeWindowListener = vi.spyOn(harness.window, 'removeEventListener');

    inject(harness.window);
    const firstBridge = harness.window.__webmcpRelayBridge!;
    firstBridge.shutdown();

    expect(firstBridge.isShutdown).toBe(true);
    expect(removeWindowListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(harness.storageChanged.removeListener).not.toHaveBeenCalled();
    expect(harness.port.disconnect).toHaveBeenCalledTimes(1);

    inject(harness.window);

    expect(harness.window.__webmcpRelayBridge).not.toBe(firstBridge);
    expect(harness.chromeHarness.runtime.connect).toHaveBeenCalledTimes(2);
    expect(harness.chromeHarness.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.storageChanged.addListener).not.toHaveBeenCalled();
    expect(addWindowListener).toHaveBeenCalledTimes(2);
  });

  it('cleans up listeners after synchronous context invalidation', () => {
    const removeWindowListener = vi.spyOn(harness.window, 'removeEventListener');
    harness.chromeHarness.runtime.connect.mockImplementation(() => {
      throw new Error('Extension context invalidated');
    });

    inject(harness.window);

    expect(harness.window.__webmcpRelayBridge?.isShutdown).toBe(true);
    expect(removeWindowListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(harness.storageChanged.removeListener).not.toHaveBeenCalled();
  });
});
