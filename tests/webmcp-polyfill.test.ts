import { readFileSync } from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const polyfillSource = readFileSync(
  path.join(__dirname, '../src/content-scripts/webmcp-polyfill.js'),
  'utf8'
);

function createDom() {
  return new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://example.com/path',
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
  });
}

function loadPolyfill(dom: JSDOM) {
  dom.window.eval(polyfillSource);
}

function createNativeModelContext(dom: JSDOM, tools: any[] = []) {
  const api = new dom.window.EventTarget() as any;
  api.registerTool = vi.fn(function (this: any) {
    if (this !== api) throw new TypeError('Illegal invocation');
    return Promise.resolve(undefined);
  });
  api.getTools = vi.fn(function (this: any) {
    if (this !== api) throw new TypeError('Illegal invocation');
    return Promise.resolve(tools);
  });
  api.executeTool = vi.fn(function (this: any, _tool: any, args: string) {
    if (this !== api) throw new TypeError('Illegal invocation');
    return Promise.resolve(args);
  });
  return api;
}

function exposeNativeOnPrototype(dom: JSDOM, native: any) {
  Object.defineProperty(Object.getPrototypeOf(dom.window.document), 'modelContext', {
    get: () => native,
    configurable: true,
  });
}

async function registerTool(
  modelContext: any,
  overrides: Record<string, unknown> = {},
  options?: any
) {
  const execute = vi.fn(async (input) => input);
  const tool = {
    name: 'example_tool',
    description: 'Example tool',
    inputSchema: { type: 'object', properties: {} },
    execute,
    ...overrides,
  };
  await modelContext.registerTool(tool, options);
  return { tool, execute };
}

describe('WebMCP bootstrap backend selection', () => {
  it('leaves a complete native implementation untouched', async () => {
    const dom = createDom();
    const native = createNativeModelContext(dom);
    exposeNativeOnPrototype(dom, native);

    loadPolyfill(dom);

    expect((dom.window.document as any).modelContext).toBe(native);
    expect(Object.prototype.hasOwnProperty.call(dom.window.document, 'modelContext')).toBe(false);
    await (dom.window.document as any).modelContext.getTools();
    expect(native.getTools).toHaveBeenCalledOnce();
  });

  it('creates the Trusted Types policy even when native WebMCP exists', () => {
    const dom = createDom();
    const native = createNativeModelContext(dom);
    exposeNativeOnPrototype(dom, native);
    const policy = { createScriptURL: vi.fn() };
    const createPolicy = vi.fn(() => policy);
    Object.defineProperty(dom.window, 'trustedTypes', { value: { createPolicy } });

    loadPolyfill(dom);

    expect(createPolicy).toHaveBeenCalledWith(
      'agentboard-user-scripts',
      expect.objectContaining({ createScriptURL: expect.any(Function) })
    );
    expect((dom.window as any).__agentboardTTPolicy).toBe(policy);
  });

  it('adopts native when it appears before the facade is first used', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const facade = (dom.window.document as any).modelContext;
    const native = createNativeModelContext(dom);
    exposeNativeOnPrototype(dom, native);

    const tool = {
      name: 'native_tool',
      description: 'Native tool',
      execute: async () => 'ok',
    };
    await facade.registerTool(tool);

    expect((dom.window.document as any).modelContext).toBe(facade);
    expect(facade).not.toBe(native);
    expect(native.registerTool).toHaveBeenCalledWith(tool);
  });

  it('forwards native toolchange events through the stable facade', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const facade = (dom.window.document as any).modelContext;
    const native = createNativeModelContext(dom);
    exposeNativeOnPrototype(dom, native);
    const listener = vi.fn();
    facade.addEventListener('toolchange', listener);

    await facade.getTools();
    native.dispatchEvent(new dom.window.Event('toolchange'));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].target).toBe(facade);
  });

  it('latches the local backend when first use occurs before native exposure', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const facade = (dom.window.document as any).modelContext;
    await registerTool(facade);

    const native = createNativeModelContext(dom);
    exposeNativeOnPrototype(dom, native);
    const tools = await facade.getTools();

    expect(tools.map((tool: any) => tool.name)).toEqual(['example_tool']);
    expect(native.getTools).not.toHaveBeenCalled();
    expect((dom.window.document as any).modelContext).toBe(facade);
  });

  it('makes repeated injection idempotent', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const facade = (dom.window.document as any).modelContext;
    await registerTool(facade);

    loadPolyfill(dom);

    expect((dom.window.document as any).modelContext).toBe(facade);
    expect((await facade.getTools()).map((tool: any) => tool.name)).toEqual(['example_tool']);
  });

  it('does not expose legacy AgentBoard or Navigator APIs', () => {
    const dom = createDom();
    loadPolyfill(dom);

    expect((dom.window as any).agent).toBeUndefined();
    expect((dom.window as any).__agentboardWebMCP).toBeUndefined();
    expect((dom.window.navigator as any).modelContext).toBeUndefined();
    expect((dom.window.navigator as any).modelContextTesting).toBeUndefined();
  });

  it('does not crash on an existing ModelContext-shaped object with throwing getters', () => {
    const dom = createDom();
    const hostileContext = {};
    Object.defineProperty(hostileContext, 'registerTool', {
      get() {
        throw new Error('hostile registerTool getter');
      },
    });
    Object.defineProperty(dom.window.document, 'modelContext', {
      configurable: true,
      value: hostileContext,
    });

    expect(() => loadPolyfill(dom)).not.toThrow();
    expect((dom.window.document as any).modelContext).toBe(hostileContext);
  });

  it('rejects detached facade method calls', () => {
    const dom = createDom();
    loadPolyfill(dom);
    const { getTools } = (dom.window.document as any).modelContext;

    expect(() => getTools()).toThrow('Illegal invocation');
  });
});

describe('WebMCP local backend contract', () => {
  it('is available to parser scripts and registers synchronously before parsing continues', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><head><script>
        window.parserSawModelContext = typeof document.modelContext?.registerTool === 'function';
        document.modelContext.registerTool({
          name: 'parser_tool',
          description: 'Parser tool',
          execute: async () => 'ok'
        });
      </script></head><body></body></html>`,
      {
        url: 'https://example.com',
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
        beforeParse(window) {
          window.eval(polyfillSource);
        },
      }
    );

    expect((dom.window as any).parserSawModelContext).toBe(true);
    const tools = await (dom.window.document as any).modelContext.getTools();
    expect(tools.map((tool: any) => tool.name)).toEqual(['parser_tool']);
  });

  it('fires toolchange before resolving registration', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const order: string[] = [];
    modelContext.addEventListener('toolchange', () => order.push('toolchange'));

    const registration = modelContext
      .registerTool({
        name: 'ordered_tool',
        description: 'Ordered tool',
        execute: async () => 'ok',
      })
      .then(() => order.push('resolved'));
    expect(registration).toBeInstanceOf(dom.window.Promise);
    await registration;

    expect(order).toEqual(['toolchange', 'resolved']);
  });

  it('returns sorted, fresh Chromium-shaped descriptors', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    await registerTool(modelContext, {
      name: 'z_tool',
      title: 'Zed',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    });
    await registerTool(modelContext, {
      name: 'a_tool',
      inputSchema: undefined,
    });

    const first = await modelContext.getTools();
    const second = await modelContext.getTools();

    expect(first.map((tool: any) => tool.name)).toEqual(['a_tool', 'z_tool']);
    expect(first[0]).toMatchObject({
      name: 'a_tool',
      title: '',
      description: 'Example tool',
      origin: 'https://example.com',
      window: dom.window,
    });
    expect(first[0]).not.toHaveProperty('inputSchema');
    expect(first[1]).toMatchObject({
      title: 'Zed',
      inputSchema: JSON.stringify({ type: 'object', properties: {} }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    });
    expect(first[0]).not.toBe(second[0]);
  });

  it('rejects duplicates and invalid registration metadata', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    await registerTool(modelContext);

    await expect(registerTool(modelContext)).rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(registerTool(modelContext, { name: 'not valid' })).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    await expect(registerTool(modelContext, { name: 'x'.repeat(129) })).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    await expect(
      registerTool(modelContext, { name: 'empty_description', description: '' })
    ).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    expect(() =>
      modelContext.registerTool({ name: 'missing_execute', description: 'Missing execute' })
    ).toThrow("Required member 'execute'");
  });

  it('rejects an unserializable input schema synchronously', () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const schema: any = { type: 'object' };
    schema.self = schema;

    expect(() =>
      modelContext.registerTool({
        name: 'bad_schema',
        description: 'Bad schema',
        inputSchema: schema,
        execute: async () => 'ok',
      })
    ).toThrow();
  });

  it('uses AbortSignal to remove the exact registration', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const controller = new dom.window.AbortController();
    const listener = vi.fn();
    modelContext.addEventListener('toolchange', listener);
    await registerTool(modelContext, {}, { signal: controller.signal });

    controller.abort('removed');
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    expect(await modelContext.getTools()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects pre-aborted registration with the exact reason', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const controller = new dom.window.AbortController();
    const reason = { reason: 'stop' };
    controller.abort(reason);

    await expect(registerTool(modelContext, {}, { signal: controller.signal })).rejects.toBe(
      reason
    );
    expect(await modelContext.getTools()).toEqual([]);
  });

  it('executes a discovered tool and serializes object results like Chromium', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    let receiver: unknown = 'not-called';
    const execute = vi.fn(function (this: unknown, input: unknown) {
      receiver = this;
      return Promise.resolve({ echoed: input });
    });
    await modelContext.registerTool({
      name: 'execute_tool',
      description: 'Execute tool',
      execute,
    });
    const [descriptor] = await modelContext.getTools();

    const result = await modelContext.executeTool(descriptor, JSON.stringify({ value: 7 }));

    expect(execute).toHaveBeenCalledWith({ value: 7 });
    expect(receiver).toBeUndefined();
    expect(result).toBe(JSON.stringify({ echoed: { value: 7 } }));
  });

  it('rejects instead of hanging when result serialization throws', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const serializationError = new Error('cannot serialize result');
    await modelContext.registerTool({
      name: 'unserializable_tool',
      description: 'Returns a hostile result',
      execute: () => ({
        toJSON() {
          throw serializationError;
        },
        toString() {
          throw serializationError;
        },
      }),
    });
    const [descriptor] = await modelContext.getTools();

    await expect(modelContext.executeTool(descriptor, '{}')).rejects.toBe(serializationError);
  });

  it('rejects malformed arguments and descriptors from another document', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    await registerTool(modelContext);
    const [descriptor] = await modelContext.getTools();

    await expect(modelContext.executeTool(descriptor, 'not-json')).rejects.toThrow(
      'Failed to parse input arguments'
    );
    await expect(
      modelContext.executeTool({ ...descriptor, window: {} }, '{}')
    ).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('supports pre-aborted and in-flight execution cancellation', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    let finishExecution!: (value: unknown) => void;
    const execute = vi.fn(() => new Promise((resolve) => (finishExecution = resolve)));
    await modelContext.registerTool({
      name: 'slow_tool',
      description: 'Slow tool',
      execute,
    });
    const [descriptor] = await modelContext.getTools();

    const preAborted = new dom.window.AbortController();
    preAborted.abort('ignored-by-chromium-contract');
    await expect(
      modelContext.executeTool(descriptor, '{}', { signal: preAborted.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    const immediateController = new dom.window.AbortController();
    const immediateReason = { reason: 'cancel-before-callback' };
    const skippedExecution = modelContext.executeTool(descriptor, '{}', {
      signal: immediateController.signal,
    });
    immediateController.abort(immediateReason);
    await expect(skippedExecution).rejects.toBe(immediateReason);
    expect(execute).not.toHaveBeenCalled();

    const controller = new dom.window.AbortController();
    const reason = { reason: 'cancelled' };
    const execution = modelContext.executeTool(descriptor, '{}', { signal: controller.signal });
    await Promise.resolve();
    controller.abort(reason);
    await expect(execution).rejects.toBe(reason);
    expect(execute).toHaveBeenCalledOnce();

    let serializationAttempted = false;
    finishExecution({
      toJSON() {
        serializationAttempted = true;
        return 'too late';
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(serializationAttempted).toBe(false);
  });
});
