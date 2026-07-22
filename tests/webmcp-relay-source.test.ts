import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const relaySource = readFileSync(resolve('src/content-scripts/relay.js'), 'utf8');

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

  return { dom, window, chromeHarness, port, portMessages, storageChanged };
}

function inject(window: RelayWindow): void {
  window.eval(relaySource);
}

describe('real WebMCP relay source', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    harness.window.__webmcpRelayBridge?.shutdown();
    harness.dom.window.close();
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
