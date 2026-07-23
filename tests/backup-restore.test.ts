import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreparedBackup,
  BACKUP_VERSION,
  gatherBackupData,
  initializeBackupRestore,
  prepareBackupImport,
} from '../src/options/backup-restore';
import { ConfigStorage, type AgentConfig, type StorageConfig } from '../src/lib/storage/config';
import { CommandRegistry } from '../src/lib/commands/registry';
import type { CommandStorage } from '../src/types';

function legacyAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Agent',
    provider: 'openai',
    model: 'opaque-model',
    openaiCompatible: true,
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 1000,
    ...overrides,
  };
}

function currentAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    provider: 'openai',
    apiProtocol: 'openai-responses',
    model: 'opaque-model',
    systemPrompt: '',
    temperature: 0.7,
    ...overrides,
  };
}

const commands: CommandStorage = {
  userCommands: [
    {
      name: 'review-code',
      instructions: 'Review $ARGUMENTS',
      isBuiltin: false,
      createdAt: 1,
    },
  ],
};

function backup(version: '1.0' | '2.0', config: unknown, commandData: unknown = commands) {
  return {
    version,
    extensionVersion: '0.7.3',
    timestamp: 1,
    exportedBy: 'AgentBoard',
    config,
    commands: commandData,
  };
}

describe('backup schema boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys, callback) => {
      callback?.({});
      return Promise.resolve({});
    });
    vi.mocked(chrome.storage.local.set).mockImplementation((_items, callback) => {
      callback?.();
      return Promise.resolve();
    });
    vi.mocked(chrome.storage.local.clear).mockImplementation((callback) => {
      callback?.();
      return Promise.resolve();
    });
  });

  it('wires recovery controls without reading configuration', async () => {
    document.body.innerHTML = `
      <button id="export-settings">Export</button>
      <button id="import-settings">Import</button>
      <input id="import-file-input" type="file">
      <div id="status-message"></div>
    `;
    const fileInput = document.getElementById('import-file-input') as HTMLInputElement;
    const openPicker = vi.spyOn(fileInput, 'click').mockImplementation(() => undefined);

    await initializeBackupRestore();
    document.getElementById('import-settings')?.click();

    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('migrates a complete v1 backup in memory', () => {
    const prepared = prepareBackupImport(
      backup('1.0', { agents: [legacyAgent()], defaultAgentId: 'agent-1' })
    );

    expect(prepared.config).toMatchObject({
      schemaVersion: 2,
      defaultAgentId: 'agent-1',
      agents: [expect.objectContaining({ apiProtocol: 'openai-responses' })],
    });
    expect(prepared.config.agents[0]).not.toHaveProperty('openaiCompatible');
    expect(prepared.config.agents[0]).not.toHaveProperty('maxTokens');
    expect(prepared.commands).toEqual(commands);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
  });

  it('accepts schema v2 config wrapped by a rolled-back v1 exporter', () => {
    const source = backup('1.0', {
      schemaVersion: 2,
      agents: [currentAgent({ apiProtocol: 'openai-chat-completions' })],
    });

    const prepared = prepareBackupImport(source);

    expect(prepared.config).toMatchObject({
      schemaVersion: 2,
      agents: [expect.objectContaining({ apiProtocol: 'openai-chat-completions' })],
    });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
  });

  it('accepts a v2 backup without legacy inference or mutable input aliases', () => {
    const source = backup('2.0', {
      schemaVersion: 2,
      agents: [currentAgent({ apiProtocol: 'openai-chat-completions' })],
    });
    const prepared = prepareBackupImport(source);

    (source.config as { agents: AgentConfig[] }).agents[0].name = 'Mutated';

    expect(prepared.config.agents[0]).toMatchObject({
      name: 'Agent',
      apiProtocol: 'openai-chat-completions',
    });
  });

  it('accepts retired maxTokens in a v2 backup and strips it before import', async () => {
    const prepared = prepareBackupImport(
      backup('2.0', {
        schemaVersion: 2,
        agents: [{ ...currentAgent(), maxTokens: 1000 }],
      })
    );

    expect(prepared.config.agents[0]).not.toHaveProperty('maxTokens');

    await applyPreparedBackup(prepared);

    const written = vi.mocked(chrome.storage.local.set).mock.calls[0][0] as {
      config: StorageConfig;
    };
    expect(written.config.agents[0]).not.toHaveProperty('maxTokens');
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
  });

  it.each([
    backup('2.0', { agents: [legacyAgent()] }),
    { ...backup('2.0', { schemaVersion: 2, agents: [] }), version: '3.0' },
    backup('1.0', { agents: [legacyAgent(), null] }),
    backup('2.0', {
      schemaVersion: 2,
      agents: [{ ...currentAgent(), apiProtocol: 'unknown' }],
    }),
    backup('2.0', { schemaVersion: 2, agents: [] }, { userCommands: [null] }),
    ...['sse', 'ftp', 'malformed'].map((kind) =>
      backup('2.0', {
        schemaVersion: 2,
        agents: [],
        mcpConfig: {
          mcpServers: {
            invalid: {
              transport: kind === 'sse' ? 'sse' : 'http',
              url:
                kind === 'ftp'
                  ? 'ftp://mcp.example.test'
                  : kind === 'malformed'
                    ? 'not a URL'
                    : 'https://mcp.example.test',
            },
          },
        },
      })
    ),
    backup(
      '2.0',
      { schemaVersion: 2, agents: [] },
      {
        userCommands: [
          { name: 'settings', instructions: 'override', isBuiltin: false, createdAt: 1 },
        ],
      }
    ),
  ])('rejects malformed/future input before any storage mutation', (value) => {
    expect(() => prepareBackupImport(value)).toThrow();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
  });

  it('commits validated config and commands in one non-destructive write', async () => {
    const prepared = prepareBackupImport(
      backup('2.0', { schemaVersion: 2, agents: [currentAgent()] })
    );

    await applyPreparedBackup(prepared);

    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      config: prepared.config,
      slashCommands: commands,
    });
  });

  it('serializes the combined import against stale config mutations', async () => {
    const initialConfig: StorageConfig = {
      schemaVersion: 2,
      agents: [currentAgent({ name: 'Before import' })],
      logLevel: 'warn',
    };
    const state: Record<string, unknown> = {
      config: initialConfig,
      slashCommands: { userCommands: [] },
    };
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    vi.mocked(chrome.storage.local.get).mockImplementation(async (keys) => {
      const result = structuredClone(state);
      const requested = keys as unknown;
      if (Array.isArray(requested) && requested.includes('config')) {
        markReadStarted();
        await readGate;
      }
      return result;
    });
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
      Object.assign(state, structuredClone(items));
    });

    const storage = new ConfigStorage();
    const staleMutation = storage.set({ logLevel: 'debug' });
    await readStarted;
    const prepared = prepareBackupImport(
      backup('2.0', {
        schemaVersion: 2,
        agents: [currentAgent({ name: 'Imported' })],
        logLevel: 'error',
      })
    );
    const importing = applyPreparedBackup(prepared);
    await Promise.resolve();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();

    releaseRead();
    await Promise.all([staleMutation, importing]);

    expect(state.config).toEqual(prepared.config);
    expect(state.slashCommands).toEqual(commands);
  });

  it('merges a post-import command save from fresh storage instead of stale registry state', async () => {
    const state: Record<string, unknown> = {
      config: { schemaVersion: 2, agents: [currentAgent()] },
      slashCommands: {
        userCommands: [
          { name: 'old-command', instructions: 'Old', isBuiltin: false, createdAt: 1 },
        ],
      },
    };
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    let blockNextCommandRead = true;
    vi.mocked(chrome.storage.local.get).mockImplementation(async (keys) => {
      const requested = keys as unknown;
      const result =
        requested === 'slashCommands'
          ? { slashCommands: structuredClone(state.slashCommands) }
          : structuredClone(state);
      if (requested === 'slashCommands' && blockNextCommandRead) {
        blockNextCommandRead = false;
        markLoadStarted();
        await loadGate;
      }
      return result;
    });
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
      Object.assign(state, structuredClone(items));
    });

    const registry = new CommandRegistry();
    const loading = registry.loadUserCommands();
    await loadStarted;
    const prepared = prepareBackupImport(
      backup('2.0', { schemaVersion: 2, agents: [currentAgent()] })
    );
    const importing = applyPreparedBackup(prepared);
    releaseLoad();
    await Promise.all([loading, importing]);

    await registry.saveUserCommand({
      name: 'after-import',
      instructions: 'New',
      isBuiltin: false,
      createdAt: 2,
    });

    expect(
      (state.slashCommands as CommandStorage).userCommands.map(({ name }) => name).sort()
    ).toEqual(['after-import', 'review-code']);
  });

  it('revalidates prepared data before the write boundary', async () => {
    const prepared = prepareBackupImport(
      backup('2.0', { schemaVersion: 2, agents: [currentAgent()] })
    );
    prepared.config.agents[0].apiProtocol = 'unknown' as never;

    await expect(applyPreparedBackup(prepared)).rejects.toThrow('Failed to save restored settings');

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
  });

  it('does not clear, stage, or retry after the combined write fails', async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('quota secret'));
    const prepared = prepareBackupImport(
      backup('2.0', { schemaVersion: 2, agents: [currentAgent()] })
    );

    await expect(applyPreparedBackup(prepared)).rejects.toThrow('Failed to save restored settings');

    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('exports only a canonical current v2 envelope', async () => {
    const config = {
      schemaVersion: 2,
      agents: [{ ...currentAgent(), maxTokens: 1000 }],
      logLevel: 'warn',
    } as unknown as StorageConfig;
    vi.mocked(chrome.storage.local.get).mockImplementation((keys, callback) => {
      const requested = keys as unknown;
      const result =
        Array.isArray(requested) && requested.includes('config')
          ? { config, slashCommands: commands }
          : {};
      callback?.(result);
      return Promise.resolve(result);
    });
    chrome.runtime.getManifest = vi.fn(() => ({ version: '0.7.3' })) as never;

    const exported = await gatherBackupData();

    expect(exported.version).toBe(BACKUP_VERSION);
    expect(exported.config).toEqual({
      schemaVersion: 2,
      agents: [currentAgent()],
      logLevel: 'warn',
    });
    expect(exported.commands).toEqual(commands);
    expect(exported.config.agents[0]).not.toHaveProperty('openaiCompatible');
    expect(exported.config.agents[0]).not.toHaveProperty('maxTokens');
    expect(chrome.storage.local.get).toHaveBeenCalledWith(['config', 'slashCommands']);
  });
});
