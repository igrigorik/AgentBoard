/**
 * Tests for the WebMCP Page Bridge (MAIN world)
 *
 * Verifies the bridge aligns with W3C WebMCP spec PR #184, which moved
 * `modelContext` from `Navigator` to `Document` (Chrome 150+):
 *   - Tools registered on `document.modelContext` (native) are visible to the bridge
 *   - The bridge prefers `document.modelContext` over `navigator.modelContextTesting`
 *   - Fallback to `navigator.modelContextTesting` still works when
 *     `document.modelContext` is absent
 *   - `document.modelContext.getTools()` (Promise) and `modelContextTesting.listTools()`
 *     (sync) are both handled via Promise normalization
 *
 * Note on JSDOM: same-window `postMessage` produces a MessageEvent whose
 * `source` is `null` in JSDOM (in real browsers it is the originating window).
 * The bridge filters incoming messages with `event.source !== window`, so to
 * feed requests to the bridge we dispatch synthetic MessageEvents with
 * `source: window`. Outgoing bridge messages are captured by spying on
 * `window.postMessage` (the bridge's only outbound channel).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-ignore - jsdom types not installed
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const BRIDGE_CODE = fs.readFileSync(
  path.join(__dirname, '../src/content-scripts/page-bridge.js'),
  'utf8'
);

const JSONRPC = '2.0';

/** Inject the page-bridge IIFE into a JSDOM. */
function loadBridge(dom: JSDOM): void {
  const script = dom.window.document.createElement('script');
  script.textContent = BRIDGE_CODE;
  dom.window.document.body.appendChild(script);
}

interface Harness {
  dom: JSDOM;
  window: any;
  outbox: any[]; // messages posted by the bridge (source === 'webmcp-main')
  sendToBridge: (msg: any) => void; // deliver a request to the bridge
}

function harness(): Harness {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.com',
    runScripts: 'dangerously',
  });
  const window = dom.window as any;
  global.window = window as any;

  const outbox: any[] = [];
  // Spy on the bridge's only outbound channel
  window.postMessage = (data: any) => {
    outbox.push(data);
  };

  // Deliver an inbound request to the bridge with a correct `source` so the
  // bridge's `event.source === window` filter accepts it.
  const sendToBridge = (msg: any) => {
    const ev = new window.MessageEvent('message', { data: msg, source: window });
    window.dispatchEvent(ev);
  };

  return { dom, window, outbox, sendToBridge };
}

/** Wait a tick for async bridge init / microtasks to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Build a fake native document.modelContext (Chrome 150+ unified surface).
 * getTools() returns a Promise; ontoolchange is the change handler.
 */
function makeNativeDocumentModelContext(initialTools: any[] = []) {
  const store = new Map<string, any>();
  for (const t of initialTools) store.set(t.name, t);

  let ontoolchange: ((...args: any[]) => void) | null = null;

  const mc = {
    registerTool(tool: any) {
      store.set(tool.name, tool);
      if (ontoolchange) ontoolchange();
    },
    unregisterTool(name: string) {
      const existed = store.delete(name);
      if (existed && ontoolchange) ontoolchange();
      return existed;
    },
    getTools() {
      return Promise.resolve(
        Array.from(store.values()).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }))
      );
    },
    async executeTool(name: string, args: any) {
      const tool = store.get(name);
      if (!tool) throw new Error(`Tool '${name}' not found`);
      return tool.execute(args, {});
    },
    get ontoolchange() {
      return ontoolchange;
    },
    set ontoolchange(cb: ((...args: any[]) => void) | null) {
      ontoolchange = cb;
    },
  };

  return mc;
}

/**
 * Build a fake navigator.modelContextTesting (polyfill / old native agent-side).
 * listTools() is synchronous.
 */
function makeModelContextTesting(initialTools: any[] = []) {
  const tools = [...initialTools];
  let ontoolchange: ((...args: any[]) => void) | null = null;
  const callbacks: Array<(...args: any[]) => void> = [];

  const mct = {
    listTools() {
      return tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
    },
    async executeTool(name: string, args: string) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Tool '${name}' not found`);
      return tool.execute(typeof args === 'string' ? JSON.parse(args) : args, {});
    },
    registerToolsChangedCallback(cb: (...args: any[]) => void) {
      callbacks.push(cb);
    },
    get ontoolchange() {
      return ontoolchange;
    },
    set ontoolchange(cb: ((...args: any[]) => void) | null) {
      ontoolchange = cb;
    },
  };
  return mct;
}

describe('WebMCP Page Bridge - document.modelContext (spec PR #184)', () => {
  let h: Harness;
  let nativeMC: any;

  beforeEach(() => {
    h = harness();
  });

  it('sees tools registered on document.modelContext (native) via getTools()', async () => {
    nativeMC = makeNativeDocumentModelContext([
      {
        name: 'site_tool',
        description: 'A tool registered by the page',
        inputSchema: { type: 'object', properties: {} },
        execute: vi.fn(),
      },
    ]);
    Object.defineProperty(h.window.document, 'modelContext', {
      value: nativeMC,
      configurable: true,
      enumerable: true,
    });

    loadBridge(h.dom);
    await flush();

    const snapshot = h.outbox.find((m) => m.method === 'tools/listChanged' && m.params?.initial);
    expect(snapshot).toBeDefined();
    expect(snapshot.params.tools).toHaveLength(1);
    expect(snapshot.params.tools[0].name).toBe('site_tool');
  });

  it('prefers document.modelContext over navigator.modelContextTesting', async () => {
    nativeMC = makeNativeDocumentModelContext([
      { name: 'native_tool', description: 'n', inputSchema: {}, execute: vi.fn() },
    ]);
    Object.defineProperty(h.window.document, 'modelContext', {
      value: nativeMC,
      configurable: true,
      enumerable: true,
    });

    // Also provide the deprecated agent-side surface with a DIFFERENT tool
    const mct = makeModelContextTesting([
      { name: 'polyfill_tool', description: 'p', inputSchema: {}, execute: vi.fn() },
    ]);
    Object.defineProperty(h.window.navigator, 'modelContextTesting', {
      value: mct,
      configurable: true,
      enumerable: true,
    });
    const listToolsSpy = vi.spyOn(mct, 'listTools');

    loadBridge(h.dom);
    await flush();

    expect(listToolsSpy).not.toHaveBeenCalled();
    const snapshot = h.outbox.find((m) => m.params?.initial);
    expect(snapshot).toBeDefined();
    expect(snapshot.params.tools.map((t: any) => t.name)).toEqual(['native_tool']);
  });

  it('forwards tool changes via document.modelContext.ontoolchange', async () => {
    nativeMC = makeNativeDocumentModelContext([]);
    Object.defineProperty(h.window.document, 'modelContext', {
      value: nativeMC,
      configurable: true,
      enumerable: true,
    });

    loadBridge(h.dom);
    await flush();

    // No tools at init => no initial snapshot
    expect(h.outbox.find((m) => m.params?.initial)).toBeUndefined();

    // A site registers a tool later; native fires ontoolchange
    nativeMC.registerTool({
      name: 'late_tool',
      description: 'Registered after bridge init',
      inputSchema: { type: 'object', properties: {} },
      execute: vi.fn(),
    });
    await flush();

    const changeMsg = h.outbox.find((m) => m.method === 'tools/listChanged' && !m.params?.initial);
    expect(changeMsg).toBeDefined();
    expect(changeMsg.params.tools.map((t: any) => t.name)).toEqual(['late_tool']);
  });

  it('routes tools/call to document.modelContext.executeTool with args as an object', async () => {
    const execSpy = vi.fn(async (args: any) => ({ echoed: args }));
    nativeMC = makeNativeDocumentModelContext([
      { name: 'echo', description: 'echo', inputSchema: {}, execute: execSpy },
    ]);
    Object.defineProperty(h.window.document, 'modelContext', {
      value: nativeMC,
      configurable: true,
      enumerable: true,
    });

    loadBridge(h.dom);
    await flush();

    h.sendToBridge({
      source: 'webmcp-bridge',
      jsonrpc: JSONRPC,
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'echo', arguments: { x: 1 } },
    });
    await flush();

    expect(execSpy).toHaveBeenCalledTimes(1);
    // Native executeTool receives args as an object, NOT a JSON string
    expect(execSpy.mock.calls[0][0]).toEqual({ x: 1 });

    const response = h.outbox.find((m) => m.id === 'call-1' && m.result !== undefined);
    expect(response).toBeDefined();
    expect(response.result).toEqual({ echoed: { x: 1 } });
  });

  it('responds to tools/list requests via document.modelContext.getTools()', async () => {
    nativeMC = makeNativeDocumentModelContext([
      { name: 't1', description: 't1', inputSchema: {}, execute: vi.fn() },
    ]);
    Object.defineProperty(h.window.document, 'modelContext', {
      value: nativeMC,
      configurable: true,
      enumerable: true,
    });

    loadBridge(h.dom);
    await flush();

    h.sendToBridge({
      source: 'webmcp-bridge',
      jsonrpc: JSONRPC,
      id: 'list-1',
      method: 'tools/list',
      params: {},
    });
    await flush();

    const requested = h.outbox.find((m) => m.params?.requested === true);
    expect(requested).toBeDefined();
    expect(requested.params.tools.map((t: any) => t.name)).toEqual(['t1']);
  });
});

describe('WebMCP Page Bridge - fallback to navigator.modelContextTesting', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('falls back to navigator.modelContextTesting when document.modelContext is absent', async () => {
    const mct = makeModelContextTesting([
      { name: 'fallback_tool', description: 'fb', inputSchema: {}, execute: vi.fn() },
    ]);
    Object.defineProperty(h.window.navigator, 'modelContextTesting', {
      value: mct,
      configurable: true,
      enumerable: true,
    });

    loadBridge(h.dom);
    await flush();

    const snapshot = h.outbox.find((m) => m.params?.initial);
    expect(snapshot).toBeDefined();
    expect(snapshot.params.tools.map((t: any) => t.name)).toEqual(['fallback_tool']);
  });

  it('passes args as a JSON string to modelContextTesting.executeTool (legacy contract)', async () => {
    const execSpy = vi.fn(async (args: any) => ({ got: args }));
    const mct = makeModelContextTesting([
      { name: 'echo', description: 'echo', inputSchema: {}, execute: execSpy },
    ]);
    Object.defineProperty(h.window.navigator, 'modelContextTesting', {
      value: mct,
      configurable: true,
      enumerable: true,
    });
    // Spy on the agent-side executeTool to inspect the raw arg contract
    const executeToolSpy = vi.spyOn(mct, 'executeTool');

    loadBridge(h.dom);
    await flush();

    h.sendToBridge({
      source: 'webmcp-bridge',
      jsonrpc: JSONRPC,
      id: 'call-2',
      method: 'tools/call',
      params: { name: 'echo', arguments: { x: 2 } },
    });
    await flush();

    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    // modelContextTesting.executeTool receives args as a JSON STRING
    expect(typeof executeToolSpy.mock.calls[0][1]).toBe('string');
    expect(JSON.parse(executeToolSpy.mock.calls[0][1])).toEqual({ x: 2 });

    const response = h.outbox.find((m) => m.id === 'call-2' && m.result !== undefined);
    expect(response).toBeDefined();
    expect(response.result).toEqual({ got: { x: 2 } });
  });

  it('forwards changes when modelContextTesting.ontoolchange fires with tools present', async () => {
    const tools: any[] = [];
    const mct = {
      listTools: () =>
        tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      async executeTool() {
        return {};
      },
      registerToolsChangedCallback() {},
      ontoolchange: null as ((...args: any[]) => void) | null,
    };
    Object.defineProperty(h.window.navigator, 'modelContextTesting', {
      value: mct,
      configurable: true,
      enumerable: true,
    });

    loadBridge(h.dom);
    await flush();

    // Empty at init => no initial snapshot
    expect(h.outbox.find((m) => m.params?.initial)).toBeUndefined();

    // A tool appears, then the polyfill fires ontoolchange
    tools.push({ name: 'chg_tool', description: 'c', inputSchema: {}, execute: vi.fn() });
    mct.ontoolchange!();
    await flush();

    const changeMsg = h.outbox.find((m) => m.method === 'tools/listChanged' && !m.params?.initial);
    expect(changeMsg).toBeDefined();
    expect(changeMsg.params.tools.map((t: any) => t.name)).toEqual(['chg_tool']);
  });
});

describe('WebMCP Page Bridge - no API present', () => {
  it('logs a warning and posts nothing when no WebMCP surface exists', async () => {
    const h = harness();
    const warnSpy = vi.spyOn(h.window.console, 'warn').mockImplementation(() => {});

    loadBridge(h.dom);
    await flush();

    expect(h.outbox).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});
