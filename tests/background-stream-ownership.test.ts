import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aiClient: {
    getAvailableAgents: vi.fn(),
    streamChat: vi.fn(),
    cancelStream: vi.fn(),
  },
  configStorage: {
    onChange: vi.fn(),
  },
  configChange: undefined as ((config: unknown) => void | Promise<void>) | undefined,
  configError: undefined as ((error: { code: string }) => void) | undefined,
  toolRegistry: {
    registerSystemTools: vi.fn(),
    loadRemoteTools: vi.fn(),
    revokeRemoteTools: vi.fn(),
  },
  memoryManager: {
    pruneBindings: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn(),
    revokeAll: vi.fn(),
  },
  tabManager: {
    setRelayLogLevel: vi.fn(),
    ensureContentScriptReady: vi.fn(),
    getAllRegistries: vi.fn(),
    getToolRegistry: vi.fn(),
    callTool: vi.fn(),
    requestToolsAndWait: vi.fn(),
    reinjectAllScripts: vi.fn(),
  },
  onConnect: undefined as ((port: chrome.runtime.Port) => void) | undefined,
  onMessage: undefined as
    | ((
        request: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void
      ) => boolean | undefined)
    | undefined,
}));

let resolveRemoteTools!: () => void;
const remoteToolsReady = new Promise<void>((resolve) => {
  resolveRemoteTools = resolve;
});

vi.mock('../src/lib/ai/client', () => ({
  AIClient: { getInstance: () => mocks.aiClient },
}));

vi.mock('../src/lib/memory/manager', () => {
  class MemoryMountError extends Error {}
  return {
    getMemoryManager: () => mocks.memoryManager,
    MemoryMountError,
  };
});

vi.mock('../src/lib/storage/config', () => {
  class ConfigValidationError extends Error {
    code = 'INVALID_CONFIG';
  }
  return {
    ConfigStorage: { getInstance: () => mocks.configStorage },
    ConfigValidationError,
    configValidationMessage: () => 'Invalid configuration',
  };
});

vi.mock('../src/lib/webmcp/lifecycle', () => ({
  getTabManager: () => mocks.tabManager,
}));

vi.mock('../src/lib/webmcp/tool-registry', () => ({
  getToolRegistry: () => mocks.toolRegistry,
}));

vi.mock('../src/lib/logger', () => ({
  default: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface MockPort {
  port: chrome.runtime.Port;
  postMessage: ReturnType<typeof vi.fn>;
  backgroundDisconnect: ReturnType<typeof vi.fn>;
  send(message: unknown): Promise<void>;
  disconnect(): void;
}

function createPort(name: string): MockPort {
  let messageListener: ((message: unknown) => Promise<void>) | undefined;
  let disconnectListener: (() => void) | undefined;
  const postMessage = vi.fn();
  const backgroundDisconnect = vi.fn();
  const port = {
    name,
    postMessage,
    disconnect: backgroundDisconnect,
    onMessage: {
      addListener: vi.fn((listener) => {
        messageListener = listener;
      }),
    },
    onDisconnect: {
      addListener: vi.fn((listener) => {
        disconnectListener = listener;
      }),
    },
  } as unknown as chrome.runtime.Port;

  return {
    port,
    postMessage,
    backgroundDisconnect,
    async send(message: unknown) {
      if (!messageListener) throw new Error('Message listener not installed');
      await messageListener(message);
    },
    disconnect() {
      if (!disconnectListener) throw new Error('Disconnect listener not installed');
      disconnectListener();
    },
  };
}

beforeAll(async () => {
  mocks.aiClient.getAvailableAgents.mockResolvedValue([]);
  mocks.configStorage.onChange.mockImplementation((onChange, onError) => {
    mocks.configChange = onChange;
    mocks.configError = onError;
  });
  mocks.toolRegistry.registerSystemTools.mockResolvedValue(undefined);
  mocks.toolRegistry.loadRemoteTools.mockReturnValue(remoteToolsReady);
  mocks.tabManager.getAllRegistries.mockReturnValue(new Map());

  Object.assign(chrome.runtime, {
    onInstalled: { addListener: vi.fn() },
    onConnect: {
      addListener: vi.fn((listener: (port: chrome.runtime.Port) => void) => {
        mocks.onConnect = listener;
      }),
    },
    onMessage: {
      addListener: vi.fn((listener) => {
        mocks.onMessage = listener;
      }),
    },
  });
  Object.assign(chrome.tabs, {
    get: vi.fn(),
    onCreated: { addListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
  });
  Object.assign(chrome.commands, {
    getAll: vi.fn((callback: (commands: chrome.commands.Command[]) => void) => callback([])),
  });
  Object.assign(chrome.sidePanel, {
    setPanelBehavior: vi.fn().mockResolvedValue(undefined),
  });
  Object.assign(chrome.storage, {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  });
  chrome.contextMenus = {
    removeAll: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    onClicked: { addListener: vi.fn() },
  } as unknown as typeof chrome.contextMenus;

  await import('../src/background/index');
  expect(mocks.onConnect).toBeTypeOf('function');
  expect(mocks.onMessage).toBeTypeOf('function');
});

describe('background response privacy', () => {
  const optionsSender = (): chrome.runtime.MessageSender => ({
    id: chrome.runtime.id,
    url: chrome.runtime.getURL('src/options/index.html'),
  });

  it('revokes runtime authority when changed configuration is invalid', () => {
    mocks.configError?.({ code: 'FUTURE_SCHEMA' });

    expect(mocks.toolRegistry.revokeRemoteTools).toHaveBeenCalledTimes(1);
    expect(mocks.memoryManager.revokeAll).toHaveBeenCalledTimes(1);
  });

  it('prunes bindings that no longer belong to a configured agent', async () => {
    const onChange = mocks.configChange as
      | ((config: {
          agents: Array<{ id: string; name: string; provider: string }>;
          logLevel: string;
          builtinScripts?: unknown[];
        }) => void | Promise<void>)
      | undefined;

    onChange?.({
      agents: [{ id: 'remaining-agent', name: 'Remaining', provider: 'openai' }],
      logLevel: 'warn',
    });

    await vi.waitFor(() =>
      expect(mocks.memoryManager.pruneBindings).toHaveBeenCalledWith(new Set(['remaining-agent']))
    );
  });

  it('revokes memory authority when configuration reconciliation fails', async () => {
    mocks.memoryManager.revokeAll.mockClear();
    mocks.memoryManager.pruneBindings.mockRejectedValueOnce(new Error('private binding failure'));

    await mocks.configChange?.({ agents: [], logLevel: 'warn' });

    expect(mocks.memoryManager.revokeAll).toHaveBeenCalledTimes(1);
  });

  it('revokes worker-held memory authority after an Options binding change', () => {
    const sendResponse = vi.fn();

    const keepChannelOpen = mocks.onMessage!(
      { type: 'MEMORY_BINDING_CHANGED', agentId: 'agent-1' },
      optionsSender(),
      sendResponse
    );

    expect(keepChannelOpen).toBe(false);
    expect(mocks.memoryManager.revoke).toHaveBeenCalledWith('agent-1');
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('revokes and removes every local binding before acknowledging a settings import', async () => {
    mocks.memoryManager.revokeAll.mockClear();
    mocks.memoryManager.pruneBindings.mockClear();
    const sendResponse = vi.fn();

    const keepChannelOpen = mocks.onMessage!(
      { type: 'MEMORY_BINDINGS_RESET' },
      optionsSender(),
      sendResponse
    );

    expect(keepChannelOpen).toBe(true);
    expect(mocks.memoryManager.revokeAll).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ success: true }));
    expect(mocks.memoryManager.pruneBindings).toHaveBeenCalledWith(new Set());
    expect(mocks.memoryManager.revokeAll).toHaveBeenCalledTimes(2);
    expect(mocks.memoryManager.revokeAll.mock.invocationCallOrder[1]).toBeLessThan(
      sendResponse.mock.invocationCallOrder[0]
    );
  });

  it('revokes again when an import binding reset fails partway through', async () => {
    mocks.memoryManager.revokeAll.mockClear();
    mocks.memoryManager.pruneBindings.mockRejectedValueOnce(new Error('private binding failure'));
    const sendResponse = vi.fn();

    mocks.onMessage!({ type: 'MEMORY_BINDINGS_RESET' }, optionsSender(), sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ success: false }));
    expect(mocks.memoryManager.revokeAll).toHaveBeenCalledTimes(2);
    expect(mocks.memoryManager.revokeAll.mock.invocationCallOrder[1]).toBeLessThan(
      sendResponse.mock.invocationCallOrder[0]
    );
  });

  it('rejects memory lifecycle mutations from non-Options senders', () => {
    mocks.memoryManager.revoke.mockClear();
    mocks.memoryManager.pruneBindings.mockClear();
    const sendResponse = vi.fn();
    const sender = {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('src/content-scripts/relay.js'),
      tab: { id: 1 },
    } as chrome.runtime.MessageSender;

    expect(
      mocks.onMessage!({ type: 'MEMORY_BINDING_CHANGED', agentId: 'agent-1' }, sender, sendResponse)
    ).toBe(false);
    expect(mocks.onMessage!({ type: 'MEMORY_BINDINGS_RESET' }, sender, sendResponse)).toBe(false);

    expect(mocks.memoryManager.revoke).not.toHaveBeenCalled();
    expect(mocks.memoryManager.pruneBindings).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenNthCalledWith(1, { success: false });
    expect(sendResponse).toHaveBeenNthCalledWith(2, { success: false });
  });

  it('replaces WebMCP refresh failures with a fixed response', async () => {
    const rawError = 'confidential reinjection failure';
    mocks.tabManager.reinjectAllScripts.mockRejectedValueOnce(new Error(rawError));
    const sendResponse = vi.fn();

    const keepChannelOpen = mocks.onMessage!(
      { type: 'WEBMCP_SCRIPTS_UPDATED' },
      {} as chrome.runtime.MessageSender,
      sendResponse
    );

    expect(keepChannelOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'WebMCP script refresh failed',
    });
  });
});

describe('background stream ownership', () => {
  it('settles a disconnected request while remote tool initialization is pending', async () => {
    const sessionPort = createPort('ai-stream-0-initializing');
    mocks.onConnect!(sessionPort.port);

    try {
      const request = sessionPort.send({
        type: 'STREAM_CHAT',
        agentId: 'agent',
        tabId: 1,
        messages: [],
      });
      sessionPort.disconnect();
      await request;

      expect(mocks.aiClient.streamChat).not.toHaveBeenCalled();
      expect(mocks.aiClient.cancelStream).toHaveBeenCalledTimes(1);
    } finally {
      resolveRemoteTools();
      await remoteToolsReady;
    }
  });

  it('rejects a duplicate port without disturbing the current owner', async () => {
    let callbacks: Record<string, (...args: any[]) => void> | undefined;
    let resolveStream!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    mocks.aiClient.streamChat.mockImplementationOnce((_agent, _messages, _tab, handlers) => {
      callbacks = handlers;
      return pending;
    });

    const ownerPort = createPort('ai-stream-42-duplicate');
    mocks.onConnect!(ownerPort.port);
    const ownerRequest = ownerPort.send({
      type: 'STREAM_CHAT',
      agentId: 'agent',
      tabId: 42,
      messages: [],
    });
    await vi.waitFor(() => expect(mocks.aiClient.streamChat).toHaveBeenCalledTimes(1));
    const ownerStreamId = mocks.aiClient.streamChat.mock.calls[0][4];

    const duplicatePort = createPort('ai-stream-42-duplicate');
    mocks.onConnect!(duplicatePort.port);
    expect(duplicatePort.backgroundDisconnect).toHaveBeenCalledTimes(1);
    expect(mocks.aiClient.cancelStream).not.toHaveBeenCalled();
    await expect(
      duplicatePort.send({ type: 'STREAM_CHAT', agentId: 'agent', tabId: 42, messages: [] })
    ).rejects.toThrow('Message listener not installed');

    callbacks?.onTextBlockChunk?.('active-block', 'current output');
    expect(ownerPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'STREAM_TEXT_BLOCK_CHUNK',
        blockId: 'active-block',
        chunk: 'current output',
      })
    );
    expect(duplicatePort.postMessage).not.toHaveBeenCalled();

    ownerPort.disconnect();
    expect(mocks.aiClient.cancelStream).toHaveBeenCalledWith(ownerStreamId);
    resolveStream();
    await ownerRequest;
  });

  it('settles a connected stream when a valid request on another port supersedes it', async () => {
    let firstCallbacks: Record<string, (...args: any[]) => void> | undefined;
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPending = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.aiClient.streamChat
      .mockImplementationOnce((_agent, _messages, _tab, callbacks) => {
        firstCallbacks = callbacks;
        return firstPending;
      })
      .mockImplementationOnce(() => secondPending);

    const firstPort = createPort('ai-stream-1-first');
    mocks.onConnect!(firstPort.port);
    const firstRequest = firstPort.send({
      type: 'STREAM_CHAT',
      agentId: 'agent',
      tabId: 1,
      messages: [],
    });
    await vi.waitFor(() => expect(mocks.aiClient.streamChat).toHaveBeenCalledTimes(1));

    const secondPort = createPort('ai-stream-2-second');
    mocks.onConnect!(secondPort.port);
    const secondRequest = secondPort.send({
      type: 'STREAM_CHAT',
      agentId: 'agent',
      tabId: 2,
      messages: [],
    });
    await vi.waitFor(() => expect(mocks.aiClient.streamChat).toHaveBeenCalledTimes(2));

    firstCallbacks?.onAbort?.();
    expect(firstPort.postMessage).toHaveBeenCalledWith({
      type: 'STREAM_ERROR',
      error: 'AI request was replaced by a newer request.',
    });
    expect(secondPort.postMessage).not.toHaveBeenCalled();

    firstPort.disconnect();
    secondPort.disconnect();
    resolveFirst();
    resolveSecond();
    await Promise.all([firstRequest, secondRequest]);
  });

  it('forwards hidden conversation memory through the owning stream', async () => {
    const memoryContext = { snapshot: 'PRIVATE_MEMORY_SENTINEL' };
    mocks.aiClient.streamChat.mockImplementationOnce(
      async (_agent, _messages, _tab, callbacks, _streamId, suppliedMemoryContext) => {
        expect(suppliedMemoryContext).toEqual(memoryContext);
        callbacks.onMemoryContext(memoryContext);
        callbacks.onFinish('complete');
      }
    );
    const port = createPort('ai-stream-memory-context');
    mocks.onConnect!(port.port);

    await port.send({
      type: 'STREAM_CHAT',
      agentId: 'agent',
      tabId: 1,
      memoryContext,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'STREAM_MEMORY_CONTEXT',
      memoryContext,
    });
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STREAM_COMPLETE', fullResponse: 'complete' })
    );
    expect(port.backgroundDisconnect).not.toHaveBeenCalled();
  });

  it('reports remote tool revocation without closing the sidebar port', async () => {
    let callbacks: Record<string, (...args: any[]) => void> | undefined;
    let resolveStream!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    mocks.aiClient.streamChat.mockImplementationOnce((_agent, _messages, _tab, handlers) => {
      callbacks = handlers;
      return pending;
    });

    const port = createPort('ai-stream-remote-revocation');
    mocks.onConnect!(port.port);
    const request = port.send({
      type: 'STREAM_CHAT',
      agentId: 'agent',
      tabId: 1,
      messages: [],
    });
    await vi.waitFor(() => expect(mocks.aiClient.streamChat).toHaveBeenCalledTimes(1));

    callbacks?.onAbort?.('remote-tools-changed');

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'STREAM_ERROR',
      error: 'Remote tools changed. Send the request again.',
    });
    expect(port.backgroundDisconnect).not.toHaveBeenCalled();
    port.disconnect();
    resolveStream();
    await request;
  });

  it('ignores an overlapping request on the same one-request port', async () => {
    let callbacks: Record<string, (...args: any[]) => void> | undefined;
    let resolveStream!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    mocks.aiClient.streamChat.mockImplementationOnce((_agent, _messages, _tab, handlers) => {
      callbacks = handlers;
      return pending;
    });

    const sessionPort = createPort('ai-stream-7-session');
    mocks.onConnect!(sessionPort.port);
    const activeRequest = sessionPort.send({
      type: 'STREAM_CHAT',
      agentId: 'valid-agent',
      tabId: 7,
      messages: [],
    });
    await vi.waitFor(() => expect(mocks.aiClient.streamChat).toHaveBeenCalledTimes(1));
    const activeStreamId = mocks.aiClient.streamChat.mock.calls[0][4];

    await sessionPort.send({
      type: 'STREAM_CHAT',
      agentId: 'missing-agent',
      tabId: 7,
      messages: [],
    });
    expect(mocks.aiClient.streamChat).toHaveBeenCalledTimes(1);

    callbacks?.onTextBlockChunk?.('active-block', 'still active');
    expect(sessionPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'STREAM_TEXT_BLOCK_CHUNK',
        blockId: 'active-block',
        chunk: 'still active',
      })
    );

    sessionPort.disconnect();
    expect(mocks.aiClient.cancelStream).toHaveBeenCalledWith(activeStreamId);
    resolveStream();
    await activeRequest;
  });

  it('never reuses a handled port for a later sequential request', async () => {
    mocks.aiClient.streamChat.mockImplementationOnce(async (_agent, _messages, _tab, callbacks) => {
      callbacks.onFinish('complete');
    });
    const sessionPort = createPort('ai-stream-8-single-use');
    mocks.onConnect!(sessionPort.port);

    await sessionPort.send({
      type: 'STREAM_CHAT',
      agentId: 'first-agent',
      tabId: 8,
      messages: [],
    });
    expect(sessionPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STREAM_COMPLETE', fullResponse: 'complete' })
    );

    await sessionPort.send({
      type: 'STREAM_CHAT',
      agentId: 'second-agent',
      tabId: 8,
      messages: [],
    });
    expect(mocks.aiClient.streamChat).toHaveBeenCalledTimes(1);

    sessionPort.disconnect();
    expect(mocks.aiClient.cancelStream).not.toHaveBeenCalled();
  });
});
