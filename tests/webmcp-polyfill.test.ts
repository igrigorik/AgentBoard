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

  it('forwards native ModelContext events through the stable facade', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const facade = (dom.window.document as any).modelContext;
    const native = createNativeModelContext(dom);
    exposeNativeOnPrototype(dom, native);
    const listener = vi.fn();
    for (const type of ['toolchange', 'toolactivated', 'toolcancel']) {
      facade.addEventListener(type, listener);
    }

    await facade.getTools();
    native.dispatchEvent(new dom.window.Event('toolchange'));
    const nativeActivated = new dom.window.Event('toolactivated');
    Object.defineProperty(nativeActivated, 'toolName', { value: 'native_tool' });
    native.dispatchEvent(nativeActivated);
    const nativeCancelled = new dom.window.Event('toolcancel');
    Object.defineProperty(nativeCancelled, 'toolName', { value: 'native_tool' });
    native.dispatchEvent(nativeCancelled);

    const forwarded = listener.mock.calls.map(([event]) => event);
    expect(forwarded.map((event) => event.type)).toEqual([
      'toolchange',
      'toolactivated',
      'toolcancel',
    ]);
    expect(forwarded.every((event) => event.target === facade)).toBe(true);
    // Forwarded tool events are re-created as the page-visible interfaces, carrying the tool name.
    expect(forwarded[1]).toBeInstanceOf((dom.window as any).ToolActivatedEvent);
    expect(forwarded[2]).toBeInstanceOf((dom.window as any).ToolCancelEvent);
    expect(forwarded.slice(1).map((event) => event.toolName)).toEqual([
      'native_tool',
      'native_tool',
    ]);
  });

  it('exposes the ToolActivatedEvent and ToolCancelEvent interfaces', () => {
    const dom = createDom();
    loadPolyfill(dom);
    const { ToolActivatedEvent, ToolCancelEvent } = dom.window as any;

    for (const [ToolEvent, name] of [
      [ToolActivatedEvent, 'ToolActivatedEvent'],
      [ToolCancelEvent, 'ToolCancelEvent'],
    ]) {
      expect(Object.getOwnPropertyDescriptor(dom.window, name)).toMatchObject({
        value: ToolEvent,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      expect(ToolEvent.name).toBe(name);
      expect(Object.getPrototypeOf(ToolEvent.prototype)).toBe(dom.window.Event.prototype);

      const event = new ToolEvent('custom', { toolName: 'named', bubbles: true });
      expect(Object.prototype.toString.call(event)).toBe(`[object ${name}]`);
      expect(event.type).toBe('custom');
      expect(event.bubbles).toBe(true);
      expect(event.toolName).toBe('named');
      // `DOMString toolName = ""`: omitted defaults to the empty string, anything else stringifies.
      expect(new ToolEvent('custom').toolName).toBe('');
      expect(new ToolEvent('custom', {}).toolName).toBe('');
      expect(new ToolEvent('custom', { toolName: 7 }).toolName).toBe('7');
    }
  });

  it('implements ontoolchange, ontoolactivated and ontoolcancel handler attributes', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const seen: string[] = [];

    for (const type of ['toolchange', 'toolactivated', 'toolcancel']) {
      const attribute = `on${type}`;
      expect(modelContext[attribute]).toBeNull();
      expect(() => (modelContext[attribute] = 'nope')).toThrow(dom.window.TypeError);

      const replaced = vi.fn();
      modelContext[attribute] = replaced;
      const handler = (event: any) => seen.push(`${type}:${event.toolName ?? ''}`);
      modelContext[attribute] = handler;
      expect(modelContext[attribute]).toBe(handler);
      modelContext.dispatchEvent(new dom.window.Event(type));
      // Assigning a new handler detaches the previous one instead of stacking listeners.
      expect(replaced).not.toHaveBeenCalled();
    }
    expect(seen).toEqual(['toolchange:', 'toolactivated:', 'toolcancel:']);
    seen.length = 0;

    const execute = vi.fn(
      () => new Promise<never>(() => {}) // never settles so cancellation is observable
    );
    await registerTool(modelContext, { name: 'handled_tool', execute });
    const [descriptor] = await modelContext.getTools();
    const controller = new dom.window.AbortController();
    const execution = modelContext.executeTool(descriptor, {}, { signal: controller.signal });
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['toolchange:', 'toolactivated:handled_tool', 'toolcancel:handled_tool']);

    modelContext.ontoolcancel = null;
    expect(modelContext.ontoolcancel).toBeNull();
    modelContext.dispatchEvent(new dom.window.Event('toolcancel'));
    expect(seen).toHaveLength(3);
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

  it('exposes browser-owned ModelContext interface identity', () => {
    const dom = createDom();
    loadPolyfill(dom);
    const ModelContext = (dom.window as any).ModelContext;
    const modelContext = (dom.window.document as any).modelContext;

    expect(typeof ModelContext).toBe('function');
    expect(ModelContext).toHaveLength(0);
    expect(Object.getPrototypeOf(ModelContext.prototype)).toBe(dom.window.EventTarget.prototype);
    expect(Object.getPrototypeOf(modelContext)).toBe(ModelContext.prototype);
    expect(modelContext).toBeInstanceOf(ModelContext);
    expect(() => new ModelContext()).toThrow('Illegal constructor');
    expect(Object.getOwnPropertyDescriptor(dom.window, 'ModelContext')).toMatchObject({
      value: ModelContext,
      writable: true,
      enumerable: false,
      configurable: true,
    });
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
    const { tool: zTool } = await registerTool(modelContext, {
      name: 'z_tool',
      title: 'Zed',
      annotations: { readOnlyHint: true, untrustedContentHint: true, debugging: true },
    });
    await registerTool(modelContext, {
      name: 'a_tool',
      inputSchema: undefined,
    });
    // Registration serializes the schema; later mutation of the page's object is not observed.
    (zTool.inputSchema as Record<string, unknown>).type = 'mutated after registration';

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
      inputSchema: { type: 'object', properties: {} },
    });
    // ToolAnnotations is a dictionary: omitted members read back as false, never as missing.
    expect(first[1].annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
      consequentialHint: false,
      debugging: true,
    });
    expect(first[0]).not.toBe(second[0]);
    // Each descriptor carries its own object parsed from the serialized registration schema.
    expect(first[1].inputSchema).not.toBe(second[1].inputSchema);
    first[1].inputSchema.type = 'mutated by caller';
    expect((await modelContext.getTools())[1].inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('exposes every ToolAnnotations member once annotations are provided', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    await registerTool(modelContext, { name: 'bare_tool' });
    await registerTool(modelContext, { name: 'empty_tool', annotations: {} });

    const [bare, empty] = await modelContext.getTools();
    expect(bare).not.toHaveProperty('annotations');
    expect(empty.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
      consequentialHint: false,
      debugging: false,
    });
  });

  it('converts tool titles as USVString values', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    await registerTool(modelContext, {
      name: 'unicode_title',
      title: 'Title with \uD800 unpaired surrogate',
    });

    const [descriptor] = await modelContext.getTools();

    expect(descriptor.title).toBe('Title with \uFFFD unpaired surrogate');
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

  it('rejects invalid input schemas through the returned promise', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const circularSchema: any = { type: 'object' };
    circularSchema.self = circularSchema;
    const schemas = [{ toJSON: () => undefined }, circularSchema, BigInt(42)];

    for (const [index, inputSchema] of schemas.entries()) {
      let registration: Promise<unknown> | undefined;
      expect(() => {
        registration = modelContext.registerTool({
          name: `bad_schema_${index}`,
          description: 'Bad schema',
          inputSchema,
          execute: async () => 'ok',
        });
      }).not.toThrow();
      expect(registration).toBeInstanceOf(dom.window.Promise);
      await expect(registration).rejects.toBeInstanceOf(dom.window.TypeError);
    }

    const controller = new dom.window.AbortController();
    controller.abort('registration cancelled');
    await expect(
      modelContext.registerTool(
        {
          name: 'bad_schema_with_aborted_signal',
          description: 'Bad schema',
          inputSchema: circularSchema,
          execute: async () => 'ok',
        },
        { signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(dom.window.TypeError);
    expect(await modelContext.getTools()).toEqual([]);
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
    const execute = vi.fn(function (
      this: unknown,
      input: unknown,
      _options: { signal: AbortSignal }
    ) {
      receiver = this;
      return Promise.resolve({ echoed: input });
    });
    await modelContext.registerTool({
      name: 'execute_tool',
      description: 'Execute tool',
      execute,
    });
    const [descriptor] = await modelContext.getTools();
    const input = { value: 7 };

    const result = await modelContext.executeTool(descriptor, input);

    expect(execute).toHaveBeenCalledWith(
      { value: 7 },
      { signal: expect.any(dom.window.AbortSignal) }
    );
    // The tool receives a JSON round trip of the caller's object, never the object itself.
    expect(execute.mock.calls[0][0]).not.toBe(input);
    expect(execute.mock.calls[0][1].signal.aborted).toBe(false);
    expect(receiver).toBeUndefined();
    expect(result).toBe(JSON.stringify({ echoed: { value: 7 } }));
  });

  it('maps callback rejection to UnknownError without exposing its details', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const consoleError = vi.spyOn(dom.window.console, 'error').mockImplementation(() => {});
    const modelContext = (dom.window.document as any).modelContext;
    const callbackError = new Error('private callback failure');
    await modelContext.registerTool({
      name: 'throwing_tool',
      description: 'Rejects execution',
      execute: async () => {
        throw callbackError;
      },
    });
    const [descriptor] = await modelContext.getTools();

    await expect(modelContext.executeTool(descriptor, {})).rejects.toMatchObject({
      name: 'UnknownError',
      message: 'WebMCP tool execution failed',
    });
    expect(consoleError).toHaveBeenCalledWith('[AgentBoard] WebMCP tool callback failed');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(callbackError.message);
  });

  it('maps result serialization failure to UnknownError instead of stringifying the object', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const consoleError = vi.spyOn(dom.window.console, 'error').mockImplementation(() => {});
    const modelContext = (dom.window.document as any).modelContext;
    const circularResult: Record<string, unknown> = {};
    circularResult.self = circularResult;
    await modelContext.registerTool({
      name: 'unserializable_tool',
      description: 'Returns a circular result',
      execute: () => circularResult,
    });
    const [descriptor] = await modelContext.getTools();

    await expect(modelContext.executeTool(descriptor, {})).rejects.toMatchObject({
      name: 'UnknownError',
      message: 'WebMCP tool execution failed',
    });
    expect(consoleError).toHaveBeenCalledWith('[AgentBoard] WebMCP result serialization failed');
  });

  it('validates required descriptors and maps operational failures to UnknownError', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    await registerTool(modelContext);
    const [descriptor] = await modelContext.getTools();

    for (const member of ['name', 'description', 'window', 'origin']) {
      const missingDescriptor = { ...descriptor };
      delete missingDescriptor[member];
      await expect(modelContext.executeTool(missingDescriptor, {})).rejects.toBeInstanceOf(
        dom.window.TypeError
      );
      await expect(
        modelContext.executeTool({ ...descriptor, [member]: undefined }, {})
      ).rejects.toBeInstanceOf(dom.window.TypeError);
    }
    await expect(
      modelContext.executeTool({ ...descriptor, window: {} }, {})
    ).rejects.toBeInstanceOf(dom.window.TypeError);

    await expect(
      modelContext.executeTool({ ...descriptor, name: 'missing_tool' }, {})
    ).rejects.toMatchObject({ name: 'UnknownError' });
  });

  it('takes an input object and rejects what object conversion or JSON serialization rejects', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const { execute } = await registerTool(modelContext);
    const [descriptor] = await modelContext.getTools();

    // Arrays are objects; an omitted or undefined input is an empty object.
    await modelContext.executeTool(descriptor, [1, 2, 3]);
    await modelContext.executeTool(descriptor);
    await modelContext.executeTool(descriptor, undefined);
    await modelContext.executeTool(descriptor, undefined, {});
    expect(execute.mock.calls.map(([input]) => input)).toEqual([[1, 2, 3], {}, {}, {}]);
    execute.mockClear();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const input of [
      '{}',
      'hello',
      123,
      true,
      null,
      10n,
      Symbol('input'),
      () => ({}),
      { toJSON: () => undefined },
      { count: 10n },
      circular,
    ]) {
      await expect(modelContext.executeTool(descriptor, input)).rejects.toBeInstanceOf(
        dom.window.TypeError
      );
    }

    const serializationError = new Error('toJSON failure');
    await expect(
      modelContext.executeTool(descriptor, {
        toJSON() {
          throw serializationError;
        },
      })
    ).rejects.toBe(serializationError);

    // Serialization precedes the abort check, so invalid input wins over an aborted signal.
    const aborted = new dom.window.AbortController();
    aborted.abort();
    await expect(
      modelContext.executeTool(descriptor, circular, { signal: aborted.signal })
    ).rejects.toBeInstanceOf(dom.window.TypeError);

    // toJSON() can serialize an object to a primitive, which never reaches the tool.
    await expect(
      modelContext.executeTool(descriptor, { toJSON: () => 'primitive' })
    ).rejects.toMatchObject({ name: 'UnknownError' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates per-execution cancellation with Chromium event ordering', async () => {
    const dom = createDom();
    loadPolyfill(dom);
    const modelContext = (dom.window.document as any).modelContext;
    const events: string[] = [];
    let callbackSignal!: AbortSignal;
    let finishExecution!: (value: unknown) => void;
    const execute = vi.fn((_input, options) => {
      callbackSignal = options.signal;
      callbackSignal.addEventListener('abort', () => events.push('signal aborted'), {
        once: true,
      });
      events.push('tool started');
      return new Promise((resolve) => (finishExecution = resolve));
    });
    await modelContext.registerTool({
      name: 'slow_tool',
      description: 'Slow tool',
      execute,
    });
    const [descriptor] = await modelContext.getTools();

    const preAborted = new dom.window.AbortController();
    const preAbortedReason = { reason: 'already cancelled' };
    preAborted.abort(preAbortedReason);
    await expect(
      modelContext.executeTool(descriptor, {}, { signal: preAborted.signal })
    ).rejects.toBe(preAbortedReason);
    expect(execute).not.toHaveBeenCalled();

    // Chromium dispatches ToolActivatedEvent/ToolCancelEvent at the ModelContext, never at window.
    const windowListener = vi.fn();
    dom.window.addEventListener('toolactivated', windowListener);
    dom.window.addEventListener('toolcancel', windowListener);
    modelContext.addEventListener(
      'toolactivated',
      (event: any) => {
        expect(event).toBeInstanceOf((dom.window as any).ToolActivatedEvent);
        expect(event.target).toBe(modelContext);
        expect(event.toolName).toBe('slow_tool');
        events.push('toolactivated');
      },
      { once: true }
    );
    const cancelled = new Promise<void>((resolve) => {
      modelContext.addEventListener(
        'toolcancel',
        (event: any) => {
          expect(event).toBeInstanceOf((dom.window as any).ToolCancelEvent);
          expect(event.target).toBe(modelContext);
          expect(event.toolName).toBe('slow_tool');
          events.push('toolcancel');
          resolve();
        },
        { once: true }
      );
    });

    const controller = new dom.window.AbortController();
    const reason = { reason: 'cancelled' };
    const execution = modelContext.executeTool(descriptor, {}, { signal: controller.signal });
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toEqual(['tool started', 'toolactivated']);

    controller.abort(reason);
    const rejected = execution.catch((error: unknown) => {
      expect(error).toBe(reason);
      events.push('execution rejected');
    });
    await Promise.all([rejected, cancelled]);

    expect(callbackSignal.aborted).toBe(true);
    expect(callbackSignal.reason).toMatchObject({ name: 'AbortError' });
    expect(events).toEqual([
      'tool started',
      'toolactivated',
      'execution rejected',
      'signal aborted',
      'toolcancel',
    ]);
    expect(windowListener).not.toHaveBeenCalled();

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
