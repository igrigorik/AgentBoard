import { readFileSync } from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const bridgeSource = readFileSync(
  path.join(__dirname, '../src/content-scripts/page-bridge.js'),
  'utf8'
);
const polyfillSource = readFileSync(
  path.join(__dirname, '../src/content-scripts/webmcp-polyfill.js'),
  'utf8'
);

type NativeTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  window: Window;
  origin: string;
};

type BridgeMessage = Record<string, any>;

function createHarness({ loadPolyfill = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://example.com/path',
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
  });
  const outbox: BridgeMessage[] = [];
  Object.defineProperty(dom.window, 'postMessage', {
    configurable: true,
    value(data: unknown) {
      queueMicrotask(() => {
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', {
            data,
            origin: dom.window.location.origin,
            source: dom.window as any,
          })
        );
      });
    },
  });
  dom.window.addEventListener('message', (event) => {
    if (event.data?.source === 'webmcp-main') outbox.push(event.data);
  });
  if (loadPolyfill) dom.window.eval(polyfillSource);

  return {
    dom,
    window: dom.window as any,
    outbox,
    loadBridge() {
      dom.window.eval(bridgeSource);
    },
    send(message: Record<string, unknown>) {
      dom.window.postMessage(
        {
          source: 'webmcp-bridge',
          jsonrpc: '2.0',
          ...message,
        },
        '*'
      );
    },
  };
}

function nativeTool(window: Window, name: string, overrides: Partial<NativeTool> = {}): NativeTool {
  return {
    name,
    title: '',
    description: `${name} description`,
    inputSchema: JSON.stringify({ type: 'object', properties: {} }),
    window,
    origin: window.location.origin,
    ...overrides,
  };
}

function createNativeHarness(window: any, initialTools: NativeTool[] = []) {
  let tools = initialTools;
  const api = new window.EventTarget() as any;
  api.registerTool = vi.fn().mockResolvedValue(undefined);
  api.getTools = vi.fn(async () => tools);
  api.executeTool = vi.fn(async () => 'native-result');

  return {
    api,
    setTools(nextTools: NativeTool[]) {
      tools = nextTools;
    },
    emitChange() {
      api.dispatchEvent(new window.Event('toolchange'));
    },
  };
}

function installNative(
  harness: ReturnType<typeof createHarness>,
  native: ReturnType<typeof createNativeHarness>
) {
  Object.defineProperty(harness.window.document, 'modelContext', {
    value: native.api,
    configurable: true,
  });
}

async function flush(window: any) {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
}

function listMessages(harness: ReturnType<typeof createHarness>) {
  return harness.outbox.filter((message) => message.method === 'tools/listChanged');
}

function latestList(harness: ReturnType<typeof createHarness>) {
  return listMessages(harness).at(-1)!;
}

function response(harness: ReturnType<typeof createHarness>, id: string) {
  return harness.outbox.find((message) => message.id === id)!;
}

describe('WebMCP page bridge catalog and execution', () => {
  it('publishes and executes tools from the local document.modelContext polyfill', async () => {
    const harness = createHarness();
    const execute = vi.fn(async (input) => ({ echoed: input }));
    await harness.window.document.modelContext.registerTool({
      name: 'local_tool',
      description: 'Local tool',
      inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
      execute,
    });
    harness.loadBridge();
    await flush(harness.window);

    expect(latestList(harness)).toMatchObject({
      method: 'tools/listChanged',
      params: {
        tools: [
          {
            name: 'local_tool',
            description: 'Local tool',
            inputSchema: JSON.stringify({
              type: 'object',
              properties: { value: { type: 'number' } },
            }),
          },
        ],
      },
    });
    expect(() => structuredClone(latestList(harness))).not.toThrow();

    harness.send({
      id: 'local-call',
      method: 'tools/call',
      params: { name: 'local_tool', arguments: { value: 7 } },
    });
    await flush(harness.window);

    expect(execute).toHaveBeenCalledWith({ value: 7 });
    expect(response(harness, 'local-call').result).toBe(JSON.stringify({ echoed: { value: 7 } }));
  });

  it('keeps native Window descriptors in-page and invokes the exact descriptor with JSON', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const descriptor = nativeTool(harness.window, 'native_tool', {
      annotations: { readOnlyHint: true },
    });
    const native = createNativeHarness(harness.window, [descriptor]);
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    const published = latestList(harness).params.tools[0];
    expect(published).toEqual({
      name: 'native_tool',
      description: 'native_tool description',
      inputSchema: descriptor.inputSchema,
      annotations: { readOnlyHint: true },
    });
    expect(published).not.toHaveProperty('window');
    expect(() => structuredClone(latestList(harness))).not.toThrow();

    harness.send({
      id: 'native-call',
      method: 'tools/call',
      params: { name: 'native_tool', arguments: { answer: 42 } },
    });
    await flush(harness.window);

    expect(native.api.executeTool.mock.calls[0][0]).toBe(descriptor);
    expect(native.api.executeTool.mock.calls[0][1]).toBe(JSON.stringify({ answer: 42 }));
    expect(native.api.executeTool.mock.calls[0][2].signal).toBeInstanceOf(
      harness.window.AbortSignal
    );
    expect(response(harness, 'native-call').result).toBe('native-result');
  });

  it('forwards cancellation to an in-flight ModelContext execution', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const native = createNativeHarness(harness.window, [
      nativeTool(harness.window, 'cancellable_tool'),
    ]);
    let executionSignal!: AbortSignal;
    native.api.executeTool.mockImplementation(
      (_tool: NativeTool, _args: string, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          executionSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    harness.send({
      id: 'cancel-call',
      method: 'tools/call',
      params: { name: 'cancellable_tool', arguments: {} },
    });
    await flush(harness.window);
    harness.send({ method: 'tools/cancel', params: { id: 'cancel-call' } });
    await flush(harness.window);

    expect(executionSignal.aborted).toBe(true);
    expect(response(harness, 'cancel-call')).toMatchObject({
      error: { message: 'Tool call cancelled', data: { name: 'AbortError' } },
    });
  });

  it('refreshes the catalog on toolchange', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const native = createNativeHarness(harness.window, [nativeTool(harness.window, 'first_tool')]);
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    native.setTools([nativeTool(harness.window, 'second_tool')]);
    native.emitChange();
    await flush(harness.window);

    expect(latestList(harness).params.tools.map((tool: any) => tool.name)).toEqual(['second_tool']);
  });

  it('uses a fresh descriptor for every call', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const first = nativeTool(harness.window, 'replaceable');
    const native = createNativeHarness(harness.window, [first]);
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    const replacement = nativeTool(harness.window, 'replaceable');
    native.setTools([replacement]);
    harness.send({
      id: 'fresh-call',
      method: 'tools/call',
      params: { name: 'replaceable', arguments: {} },
    });
    await flush(harness.window);

    expect(native.api.executeTool.mock.calls[0][0]).toBe(replacement);
    expect(native.api.executeTool.mock.calls[0][0]).not.toBe(first);
  });

  it('filters descriptors owned by other windows', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const iframe = harness.window.document.createElement('iframe');
    harness.window.document.body.appendChild(iframe);
    const native = createNativeHarness(harness.window, [
      nativeTool(iframe.contentWindow!, 'iframe_tool'),
      nativeTool(harness.window, 'main_tool'),
    ]);
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    expect(latestList(harness).params.tools.map((tool: any) => tool.name)).toEqual(['main_tool']);
  });

  it('omits malformed and non-serializable descriptors', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const circularSchema: any = { type: 'object' };
    circularSchema.self = circularSchema;
    const native = createNativeHarness(harness.window, [
      nativeTool(harness.window, 'valid_tool'),
      nativeTool(harness.window, 'bad_schema', { inputSchema: circularSchema }),
      { name: '', description: 'Missing name', window: harness.window } as any,
    ]);
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    expect(latestList(harness).params.tools.map((tool: any) => tool.name)).toEqual(['valid_tool']);
  });

  it('omits duplicate names and refuses ambiguous execution', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const native = createNativeHarness(harness.window, [
      nativeTool(harness.window, 'duplicate'),
      nativeTool(harness.window, 'duplicate'),
    ]);
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    expect(latestList(harness).params.tools).toEqual([]);
    harness.send({
      id: 'ambiguous-call',
      method: 'tools/call',
      params: { name: 'duplicate', arguments: {} },
    });
    await flush(harness.window);

    expect(response(harness, 'ambiguous-call').error.message).toContain('ambiguous');
    expect(native.api.executeTool).not.toHaveBeenCalled();
  });

  it('fails calls closed when discovery fails', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const native = createNativeHarness(harness.window, [
      nativeTool(harness.window, 'dangerous_tool'),
    ]);
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);
    native.api.getTools.mockRejectedValueOnce(new Error('discovery unavailable'));

    harness.send({
      id: 'failed-discovery-call',
      method: 'tools/call',
      params: { name: 'dangerous_tool', arguments: { destructive: true } },
    });
    await flush(harness.window);

    expect(response(harness, 'failed-discovery-call').error.message).toContain(
      'discovery unavailable'
    );
    expect(native.api.executeTool).not.toHaveBeenCalled();
  });
});

describe('WebMCP page bridge lifecycle', () => {
  it('does not let an older async publication overwrite newer state', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const oldTool = nativeTool(harness.window, 'old_tool');
    const newTool = nativeTool(harness.window, 'new_tool');
    const native = createNativeHarness(harness.window);
    let resolveFirst!: (tools: NativeTool[]) => void;
    let resolveSecond!: (tools: NativeTool[]) => void;
    native.api.getTools
      .mockImplementationOnce(
        () => new Promise<NativeTool[]>((resolve) => (resolveFirst = resolve))
      )
      .mockImplementationOnce(
        () => new Promise<NativeTool[]>((resolve) => (resolveSecond = resolve))
      )
      .mockResolvedValue([newTool]);
    installNative(harness, native);
    harness.loadBridge();

    native.emitChange();
    await Promise.resolve();
    await Promise.resolve();
    expect(native.api.getTools).toHaveBeenCalledTimes(2);

    resolveSecond([newTool]);
    await flush(harness.window);
    resolveFirst([oldTool]);
    await flush(harness.window);

    expect(listMessages(harness)).toHaveLength(1);
    expect(latestList(harness).params.tools.map((tool: any) => tool.name)).toEqual(['new_tool']);
  });

  it('recovers when the newest refresh fails instead of publishing an older snapshot', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const oldTool = nativeTool(harness.window, 'old_tool');
    const recoveredTool = nativeTool(harness.window, 'recovered_tool');
    const native = createNativeHarness(harness.window);
    let resolveFirst!: (tools: NativeTool[]) => void;
    native.api.getTools
      .mockImplementationOnce(
        () => new Promise<NativeTool[]>((resolve) => (resolveFirst = resolve))
      )
      .mockRejectedValueOnce(new Error('transient discovery failure'))
      .mockResolvedValue([recoveredTool]);
    installNative(harness, native);
    harness.loadBridge();

    native.emitChange();
    await flush(harness.window);
    await flush(harness.window);
    expect(native.api.getTools).toHaveBeenCalledTimes(3);
    expect(latestList(harness).params.tools.map((tool: any) => tool.name)).toEqual([
      'recovered_tool',
    ]);

    resolveFirst([oldTool]);
    await flush(harness.window);
    expect(latestList(harness).params.tools.map((tool: any) => tool.name)).toEqual([
      'recovered_tool',
    ]);
  });

  it('publishes an unavailable empty catalog when native discovery remains rejected', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const native = createNativeHarness(harness.window);
    native.api.getTools.mockRejectedValue(new Error('native policy denied discovery'));
    installNative(harness, native);
    harness.loadBridge();

    await flush(harness.window);
    await flush(harness.window);

    expect(latestList(harness)).toMatchObject({
      method: 'tools/listChanged',
      params: { tools: [], unavailable: true },
    });
    expect(native.api.getTools).toHaveBeenCalledTimes(2);
  });

  it('publishes an empty startup snapshot without protocol-only state', async () => {
    const harness = createHarness();
    harness.loadBridge();
    await flush(harness.window);

    expect(latestList(harness)).toMatchObject({
      method: 'tools/listChanged',
      params: { tools: [] },
    });
    expect(latestList(harness).params).not.toHaveProperty('initial');
  });

  it('marks explicit list requests without duplicating routes', async () => {
    const harness = createHarness();
    await harness.window.document.modelContext.registerTool({
      name: 'listed_tool',
      description: 'Listed tool',
      execute: async () => 'ok',
    });
    harness.loadBridge();
    await flush(harness.window);
    harness.send({ id: 'list-request', method: 'tools/list', params: {} });
    await flush(harness.window);

    expect(latestList(harness).params).toMatchObject({
      requested: true,
      tools: [{ name: 'listed_tool', description: 'Listed tool' }],
    });
  });

  it('settles in-flight calls when bridge replacement disposes their owner', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const native = createNativeHarness(harness.window, [nativeTool(harness.window, 'slow_tool')]);
    native.api.executeTool.mockImplementation(
      (_tool: NativeTool, _args: string, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    installNative(harness, native);
    harness.loadBridge();
    await flush(harness.window);

    harness.send({
      id: 'disposed-call',
      method: 'tools/call',
      params: { name: 'slow_tool', arguments: {} },
    });
    await flush(harness.window);
    harness.loadBridge();
    await flush(harness.window);

    expect(response(harness, 'disposed-call')).toMatchObject({
      error: { message: 'Document bridge disposed', data: { name: 'AbortError' } },
    });
  });

  it('replaces a prior bridge without retaining duplicate message handlers', async () => {
    const harness = createHarness();
    const execute = vi.fn(async () => 'ok');
    await harness.window.document.modelContext.registerTool({
      name: 'single_call',
      description: 'Must execute once',
      execute,
    });
    harness.loadBridge();
    await flush(harness.window);
    harness.loadBridge();
    await flush(harness.window);
    harness.outbox.length = 0;

    harness.send({
      id: 'single-call',
      method: 'tools/call',
      params: { name: 'single_call', arguments: {} },
    });
    await flush(harness.window);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.outbox.filter((message) => message.id === 'single-call')).toHaveLength(1);
  });

  it('publishes an unavailable catalog when reading document.modelContext throws', async () => {
    const harness = createHarness({ loadPolyfill: false });
    Object.defineProperty(harness.window.document, 'modelContext', {
      configurable: true,
      get() {
        throw new Error('blocked modelContext getter');
      },
    });

    expect(() => harness.loadBridge()).not.toThrow();
    await flush(harness.window);

    expect(latestList(harness).params).toMatchObject({
      tools: [],
      unavailable: true,
    });
  });

  it('publishes an unavailable catalog for ModelContext objects with throwing method getters', async () => {
    const harness = createHarness({ loadPolyfill: false });
    const hostileContext = {};
    Object.defineProperty(hostileContext, 'getTools', {
      get() {
        throw new Error('blocked getTools getter');
      },
    });
    Object.defineProperty(harness.window.document, 'modelContext', {
      configurable: true,
      value: hostileContext,
    });

    expect(() => harness.loadBridge()).not.toThrow();
    await flush(harness.window);

    expect(latestList(harness).params).toMatchObject({
      tools: [],
      unavailable: true,
    });
  });

  it('publishes an empty catalog when document.modelContext is unavailable', async () => {
    const harness = createHarness({ loadPolyfill: false });
    harness.loadBridge();
    await flush(harness.window);

    expect(latestList(harness).params).toMatchObject({ tools: [], unavailable: true });
  });
});
