import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_SCHEMA_VERSION,
  ConfigStorage,
  ConfigValidationError,
  DEFAULT_CONFIG,
  parseStorageConfig,
  type AgentConfig,
} from '../src/lib/storage/config';

type Stored = { config?: unknown };

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    provider: 'openai',
    apiProtocol: 'openai-responses',
    model: 'model',
    temperature: 0.7,
    ...overrides,
  };
}

function current(overrides: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 2, agents: [agent()], defaultAgentId: 'agent-1', ...overrides };
}

function sparseArray<T>(): T[] {
  return new Array<T>(1);
}

function useStorage(initial: Stored, readDelay = 0): Stored {
  const state = initial;
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => {
    const snapshot = structuredClone(state);
    if (readDelay > 0) await new Promise((resolve) => setTimeout(resolve, readDelay));
    return snapshot;
  });
  vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
    Object.assign(state, structuredClone(items));
  });
  return state;
}

function useStorageWithDeferredFirstRead(initial: Stored): {
  state: Stored;
  readStarted: Promise<void>;
  releaseRead: () => void;
} {
  const state = initial;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let deferRead = true;
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => {
    const snapshot = structuredClone(state);
    if (deferRead) {
      deferRead = false;
      markReadStarted();
      await readGate;
    }
    return snapshot;
  });
  vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
    Object.assign(state, structuredClone(items));
  });
  return { state, readStarted, releaseRead };
}

describe('schema-v2 parser', () => {
  it('fully migrates every v1 agent while dropping unknown fields', () => {
    const legacy = {
      agents: [
        {
          ...agent(),
          apiProtocol: undefined,
          openaiCompatible: true,
          systemPrompt: 'retired custom instructions',
        },
        { ...agent({ id: 'agent-2', provider: 'anthropic' }), apiProtocol: undefined },
      ],
      defaultAgentId: 'agent-2',
      harmless: { retained: true },
    };
    const parsed = parseStorageConfig(legacy);
    expect(parsed.migrated).toBe(true);
    expect(parsed.config.schemaVersion).toBe(2);
    expect(parsed.config.agents.map((a) => a.apiProtocol)).toEqual([
      'openai-responses',
      'anthropic-messages',
    ]);
    expect(parsed.config.agents[0]).not.toHaveProperty('openaiCompatible');
    expect(parsed.config.agents[0]).not.toHaveProperty('systemPrompt');
    expect(parsed.config).not.toHaveProperty('harmless');
  });

  it.each([
    ['openai', 'openai-responses', undefined],
    ['anthropic', 'anthropic-messages', undefined],
    ['google', 'google-generative-ai', undefined],
    ['openai', 'openai-responses', ''],
    ['anthropic', 'anthropic-messages', ''],
    ['google', 'google-generative-ai', ''],
    ['openai', 'openai-responses', '   '],
    ['anthropic', 'anthropic-messages', '   '],
    ['google', 'google-generative-ai', '   '],
  ] as const)(
    'keeps direct %s agents on %s with endpoint %j',
    (provider, expectedProtocol, endpoint) => {
      const legacy = {
        agents: [
          {
            ...agent({ provider }),
            endpoint,
            apiProtocol: undefined,
            openaiCompatible: true,
          },
        ],
        defaultAgentId: 'agent-1',
      };

      const parsed = parseStorageConfig(legacy);

      expect(parsed.migrated).toBe(true);
      expect(parsed.config.agents[0].apiProtocol).toBe(expectedProtocol);
      expect(parsed.config.agents[0]).not.toHaveProperty('openaiCompatible');
      expect(parsed.config.agents[0]).not.toHaveProperty('endpoint');
    }
  );

  it('projects every recognized field and drops unknown keys at every config level', () => {
    const parsed = parseStorageConfig({
      schemaVersion: 2,
      agents: [
        {
          ...agent(),
          description: 'Connection metadata',
          apiKey: '',
          endpoint: 'https://proxy.example.test/v1',
          maxSteps: 7,
          isDefault: false,
          reasoning: {
            enabled: true,
            autoExpand: false,
            collapseDelay: 0,
            openai: {
              reasoningEffort: 'high',
              reasoningSummary: 'detailed',
              ignoredOpenAI: true,
            },
            anthropic: { thinkingBudgetTokens: 1000, ignoredAnthropic: true },
            google: { thinkingBudget: -1, includeThoughts: false, ignoredGoogle: true },
            ignoredReasoning: true,
          },
          systemPrompt: 'retired custom instructions',
          ignoredAgent: true,
        },
      ],
      defaultAgentId: 'agent-1',
      mcpConfig: {
        mcpServers: {
          primary: {
            transport: 'http',
            url: 'https://mcp.example.test',
            authToken: '',
            ignoredServer: true,
          },
        },
        ignoredMcp: true,
      },
      userScripts: [{ id: 'user-script', code: '', enabled: false, ignoredScript: true }],
      builtinScripts: [{ id: 'builtin-script', enabled: false, ignoredBuiltin: true }],
      logLevel: 'silent',
      ignoredConfig: true,
    });

    expect(parsed.migrated).toBe(false);
    expect(parsed.config).toEqual({
      schemaVersion: 2,
      agents: [
        {
          id: 'agent-1',
          name: 'Agent',
          description: 'Connection metadata',
          provider: 'openai',
          apiKey: '',
          model: 'model',
          endpoint: 'https://proxy.example.test/v1',
          apiProtocol: 'openai-responses',
          temperature: 0.7,
          maxSteps: 7,
          isDefault: false,
          reasoning: {
            enabled: true,
            autoExpand: false,
            collapseDelay: 0,
            openai: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
            anthropic: { thinkingBudgetTokens: 1000 },
            google: { thinkingBudget: -1, includeThoughts: false },
          },
        },
      ],
      defaultAgentId: 'agent-1',
      mcpConfig: {
        mcpServers: {
          primary: {
            transport: 'http',
            url: 'https://mcp.example.test',
            authToken: '',
          },
        },
      },
      userScripts: [{ id: 'user-script', code: '', enabled: false }],
      builtinScripts: [{ id: 'builtin-script', enabled: false }],
      logLevel: 'silent',
    });
  });

  it('canonicalizes a blank current-v2 endpoint as absent', () => {
    const parsed = parseStorageConfig(current({ agents: [{ ...agent(), endpoint: '   ' }] }));

    expect(parsed.migrated).toBe(false);
    expect(parsed.config.agents[0]).not.toHaveProperty('endpoint');
  });

  it('validates complete v2 and never infers its protocol', () => {
    expect(parseStorageConfig(current()).migrated).toBe(false);
    expect(() =>
      parseStorageConfig(current({ agents: [{ ...agent(), apiProtocol: undefined }] }))
    ).toThrowError(ConfigValidationError);
    expect(() =>
      parseStorageConfig(current({ agents: [{ ...agent(), openaiCompatible: false }] }))
    ).toThrowError(ConfigValidationError);
  });

  it.each(['id', 'name', 'model'] as const)('rejects whitespace-only agent %s', (field) => {
    expect(() =>
      parseStorageConfig(current({ agents: [{ ...agent(), [field]: ' \t\n ' }] }))
    ).toThrowError(ConfigValidationError);
  });

  it('rejects whitespace-only script identifiers and MCP URLs', () => {
    const invalidValues = [
      current({ userScripts: [{ id: '  ', code: '', enabled: true }] }),
      current({ builtinScripts: [{ id: '\t', enabled: true }] }),
      current({
        mcpConfig: { mcpServers: { invalid: { transport: 'http', url: ' \n ' } } },
      }),
    ];

    for (const value of invalidValues) {
      expect(() => parseStorageConfig(value)).toThrowError(ConfigValidationError);
    }
  });

  it('rejects sparse arrays at current, legacy, and script storage boundaries', () => {
    const invalidValues = [
      current({ agents: sparseArray<AgentConfig>() }),
      { agents: sparseArray<AgentConfig>() },
      current({ userScripts: sparseArray() }),
      current({ builtinScripts: sparseArray() }),
    ];

    for (const value of invalidValues) {
      expect(() => parseStorageConfig(value)).toThrowError(ConfigValidationError);
    }
  });

  it.each([
    { schemaVersion: 3, agents: [] },
    { schemaVersion: '2', agents: [] },
    current({ agents: [{ ...agent(), maxSteps: 0 }] }),
    current({ agents: [{ ...agent(), temperature: -0.1 }] }),
    current({ agents: [{ ...agent(), temperature: 2.1 }] }),
    current({ agents: [agent(), agent()] }),
    current({ defaultAgentId: 'missing' }),
    current({ mcpConfig: { mcpServers: { a: { transport: 'stdio', url: 'secret' } } } }),
    current({
      mcpConfig: { mcpServers: { a: { transport: 'sse', url: 'https://mcp.example.test' } } },
    }),
    current({
      mcpConfig: { mcpServers: { a: { transport: 'http', url: 'ftp://mcp.example.test' } } },
    }),
    current({
      mcpConfig: { mcpServers: { a: { transport: 'http', url: 'httpx://mcp.example.test' } } },
    }),
    current({ mcpConfig: { mcpServers: { a: { transport: 'http', url: 'not a URL' } } } }),
    current({ userScripts: [{ id: 'x', code: 4, enabled: true }] }),
    current({ builtinScripts: [{ id: 'x', enabled: 'yes' }] }),
    current({ logLevel: 'verbose' }),
  ])('rejects malformed/future config without exposing values', (value) => {
    expect(() => parseStorageConfig(value)).toThrowError(/^[A-Z_]+$/);
  });

  it('accepts HTTP and HTTPS MCP endpoints', () => {
    expect(() =>
      parseStorageConfig(
        current({
          mcpConfig: {
            mcpServers: {
              local: { transport: 'http', url: 'http://localhost:3000/mcp' },
              remote: { transport: 'http', url: 'https://mcp.example.test' },
            },
          },
        })
      )
    ).not.toThrow();
  });

  it('isolates validated output from the untrusted input object', () => {
    const input = current({
      agents: [
        agent({
          reasoning: { enabled: true, openai: { reasoningEffort: 'medium' } },
        }),
      ],
    }) as { agents: AgentConfig[] };
    const parsed = parseStorageConfig(input);

    input.agents[0].reasoning!.openai!.reasoningEffort = 'high';

    expect(parsed.config.agents[0].reasoning?.openai?.reasoningEffort).toBe('medium');
  });

  it('allows descriptive provider metadata to differ from proxy wire protocol', () => {
    const parsed = parseStorageConfig(
      current({
        agents: [agent({ provider: 'anthropic', apiProtocol: 'openai-responses' })],
      })
    );
    expect(parsed.config.agents[0]).toMatchObject({
      provider: 'anthropic',
      apiProtocol: 'openai-responses',
    });
  });
});

describe('ConfigStorage', () => {
  let storage: ConfigStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = ConfigStorage.getInstance();
  });

  it('returns a fresh default without writing for missing storage', async () => {
    useStorage({});
    const first = await storage.get();
    first.logLevel = 'debug';
    expect(await storage.get()).toEqual(DEFAULT_CONFIG);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('drops unknown fields from current v2 reads without rewriting storage', async () => {
    useStorage({
      config: current({ agents: [{ ...agent(), ignoredAgent: true }] }),
    });

    const config = await storage.get();

    expect(config.schemaVersion).toBe(2);
    expect(config.agents[0]).not.toHaveProperty('ignoredAgent');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('drops unknown fields before an explicit config mutation is persisted', async () => {
    const state = useStorage({ config: current() });

    await storage.set({
      agents: [{ ...agent(), ignoredAgent: true }],
    } as never);

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect((state.config as { agents: unknown[] }).agents[0]).not.toHaveProperty('ignoredAgent');
  });

  it('migrates v1 exactly once and a second read does not write', async () => {
    useStorage({ config: { agents: [{ ...agent(), apiProtocol: undefined }] } });
    const migrated = await storage.get();
    expect(migrated.agents[0].apiProtocol).toBe('openai-responses');
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    await storage.get();
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent reads into one migration write', async () => {
    useStorage({ config: { agents: [{ ...agent(), apiProtocol: undefined }] } });
    const [a, b] = await Promise.all([storage.get(), storage.get()]);
    expect(a).toEqual(b);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it.each([{ config: { schemaVersion: 9, agents: [] } }, { config: { agents: 'bad' } }])(
    'does not write rejected stored config',
    async (stored) => {
      useStorage(stored);
      await expect(storage.get()).rejects.toThrow(ConfigValidationError);
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    }
  );

  it('set merges v2 but rejects an explicit non-v2 schema before writing', async () => {
    const state = useStorage({ config: current() });

    await expect(storage.set({ schemaVersion: 1 as 2 })).rejects.toThrow(ConfigValidationError);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();

    await storage.set({ logLevel: 'debug' });
    expect(state.config).toMatchObject({ schemaVersion: 2, logLevel: 'debug' });
  });

  it('CRUD writes schema and explicit protocol, and reset writes a fresh default', async () => {
    const state = useStorage({});
    const { id: _id, ...newAgent } = agent();
    const id = await storage.addAgent(newAgent);
    expect(await storage.getAgent(id)).toMatchObject({
      id,
      apiProtocol: 'openai-responses',
    });
    expect(await storage.getAgent('missing')).toBeNull();
    expect(state.config).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      agents: [expect.objectContaining({ apiProtocol: 'openai-responses' })],
    });
    await storage.reset();
    expect(state.config).toEqual(DEFAULT_CONFIG);
  });

  it('serializes complete concurrent agent mutations without losing an update', async () => {
    const state = useStorage({});
    const { id: _id, ...newAgent } = agent();

    await Promise.all([
      storage.addAgent({ ...newAgent, name: 'First' }),
      storage.addAgent({ ...newAgent, name: 'Second' }),
    ]);

    expect((state.config as { agents: AgentConfig[] }).agents.map(({ name }) => name)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('updates, selects, and deletes agents without changing their protocol', async () => {
    useStorage({
      config: current({ agents: [agent({ apiKey: 'secret-key' })] }),
    });
    await storage.updateAgent('agent-1', {
      endpoint: 'https://gateway.example.test',
      apiKey: undefined,
      maxSteps: 12,
    });
    const updated = await storage.getAgent('agent-1');
    expect(updated).toMatchObject({
      apiProtocol: 'openai-responses',
      endpoint: 'https://gateway.example.test',
      maxSteps: 12,
    });
    expect(updated?.apiKey).toBeUndefined();

    const { id: _id, ...second } = agent({ id: 'unused', name: 'Second' });
    const secondId = await storage.addAgent(second);
    await storage.setDefaultAgent(secondId);
    expect((await storage.getDefaultAgent())?.id).toBe(secondId);

    await storage.deleteAgent(secondId);
    expect((await storage.getDefaultAgent())?.id).toBe('agent-1');
  });

  it('serializes concurrent mutations across instances so one write cannot erase another', async () => {
    useStorage({ config: current({ agents: [], defaultAgentId: undefined }) }, 5);
    const otherStorage = new ConfigStorage();
    const { id: _firstId, ...first } = agent({ id: 'unused-1', name: 'First' });
    const { id: _secondId, ...second } = agent({ id: 'unused-2', name: 'Second' });

    const [firstId, secondId] = await Promise.all([
      storage.addAgent(first),
      otherStorage.addAgent(second),
    ]);

    const config = await storage.get();
    expect(config.agents.map(({ id }) => id).sort()).toEqual([firstId, secondId].sort());
  });

  it('is a singleton', () => {
    expect(ConfigStorage.getInstance()).toBe(storage);
  });

  it('onChange serializes callbacks and fails closed for malformed/future values', async () => {
    const addListener = vi.fn();
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });
    let listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | undefined;
    addListener.mockImplementation((fn) => {
      listener = fn;
    });
    const callback = vi.fn();
    const onError = vi.fn();
    storage.onChange(callback, onError);
    listener?.({ config: { newValue: { schemaVersion: 3, agents: [] } } }, 'local');
    expect(callback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(ConfigValidationError));
    listener?.({ config: { newValue: current() } }, 'local');
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  });

  it('onChange drops an older queued snapshot after malformed config revokes authority', async () => {
    const addListener = vi.fn();
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });
    let listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | undefined;
    addListener.mockImplementation((fn) => {
      listener = fn;
    });
    const callback = vi.fn();
    const onError = vi.fn();
    storage.onChange(callback, onError);

    listener?.({ config: { newValue: current() } }, 'local');
    listener?.({ config: { newValue: { schemaVersion: 3, agents: [] } } }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();

    listener?.(
      { config: { newValue: current({ agents: [agent({ name: 'Recovered' })] }) } },
      'local'
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ agents: [expect.objectContaining({ name: 'Recovered' })] })
    );
  });

  it('onChange persists v1 before delivering the resulting v2 snapshot', async () => {
    const state = useStorage({
      config: { agents: [{ ...agent(), apiProtocol: undefined, openaiCompatible: true }] },
    });
    const addListener = vi.fn();
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });
    let listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | undefined;
    addListener.mockImplementation((fn) => {
      listener = fn;
    });
    const callback = vi.fn();
    storage.onChange(callback);

    listener?.({ config: { newValue: state.config } }, 'local');
    await vi.waitFor(() => expect(chrome.storage.local.set).toHaveBeenCalledTimes(1));
    expect(callback).not.toHaveBeenCalled();

    listener?.({ config: { newValue: state.config } }, 'local');
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        agents: [expect.objectContaining({ apiProtocol: 'openai-responses' })],
      })
    );
  });

  it('onChange does not let a delayed v1 migration overwrite a newer valid config', async () => {
    const legacy = {
      agents: [{ ...agent({ name: 'Legacy' }), apiProtocol: undefined }],
      defaultAgentId: 'agent-1',
    };
    const { state, readStarted, releaseRead } = useStorageWithDeferredFirstRead({
      config: legacy,
    });
    const addListener = vi.fn();
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });
    let listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | undefined;
    addListener.mockImplementation((fn) => {
      listener = fn;
    });
    const callback = vi.fn();
    storage.onChange(callback);

    listener?.({ config: { newValue: legacy } }, 'local');
    await readStarted;
    const newer = current({ agents: [agent({ name: 'Newer' })] });
    state.config = newer;
    listener?.({ config: { newValue: newer } }, 'local');
    releaseRead();
    await storage.get();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    expect(callback.mock.calls.map(([config]) => config.agents[0].name)).toEqual(['Newer']);
    expect(state.config).toEqual(newer);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('onChange does not let a delayed v1 migration recover a newer invalid config', async () => {
    const legacy = {
      agents: [{ ...agent({ name: 'Legacy' }), apiProtocol: undefined }],
      defaultAgentId: 'agent-1',
    };
    const { state, readStarted, releaseRead } = useStorageWithDeferredFirstRead({
      config: legacy,
    });
    const addListener = vi.fn();
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });
    let listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | undefined;
    addListener.mockImplementation((fn) => {
      listener = fn;
    });
    const callback = vi.fn();
    const onError = vi.fn();
    storage.onChange(callback, onError);

    listener?.({ config: { newValue: legacy } }, 'local');
    await readStarted;
    const future = { schemaVersion: 3, agents: [] };
    state.config = future;
    listener?.({ config: { newValue: future } }, 'local');
    releaseRead();
    await expect(storage.get()).rejects.toThrow('UNSUPPORTED_SCHEMA_VERSION');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(state.config).toEqual(future);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('onChange continues after a consumer error handler throws', async () => {
    const addListener = vi.fn();
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });
    let listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | undefined;
    addListener.mockImplementation((fn) => {
      listener = fn;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const callback = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('callback secret'))
      .mockResolvedValue();
    storage.onChange(callback, () => {
      throw new Error('handler secret');
    });

    listener?.({ config: { newValue: current() } }, 'local');
    listener?.({ config: { newValue: current() } }, 'local');

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(consoleError).toHaveBeenCalledWith('[ConfigStorage] Config change error handler failed');
    consoleError.mockRestore();
  });

  it('onChange reports rejected async callbacks instead of leaking rejections', async () => {
    const addListener = vi.fn();
    Object.defineProperty(chrome.storage, 'onChanged', {
      configurable: true,
      value: { addListener },
    });
    let listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | undefined;
    addListener.mockImplementation((fn) => {
      listener = fn;
    });
    const onError = vi.fn();
    storage.onChange(async () => Promise.reject(new Error('callback secret')), onError);

    listener?.({ config: { newValue: current() } }, 'local');

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(ConfigValidationError)));
    expect((onError.mock.calls[0][0] as ConfigValidationError).message).toBe('INVALID_CONFIG');
  });
});
