import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configStorage } = vi.hoisted(() => {
  const agent = {
    id: 'agent-1',
    name: 'Test Agent',
    provider: 'openai',
    model: 'test-model',
    apiKey: 'test-key',
    temperature: 0.7,
  };
  return {
    configStorage: {
      getAgents: vi.fn().mockResolvedValue([agent]),
      getDefaultAgent: vi.fn().mockResolvedValue(agent),
      getAgent: vi.fn().mockResolvedValue(agent),
    },
  };
});

vi.mock('../src/lib/storage/config', () => ({
  ConfigStorage: { getInstance: () => configStorage },
}));

vi.mock('../src/lib/commands', () => {
  class CommandRegistry {
    registerBuiltins() {}
    async loadUserCommands() {}
  }
  class CommandProcessor {
    async process() {
      return null;
    }
  }
  return {
    CommandRegistry,
    CommandProcessor,
    createBuiltinCommands: () => [],
  };
});

vi.mock('../src/sidebar/StreamingMarkdownRenderer', () => ({
  StreamingMarkdownRenderer: {
    renderComplete: (element: HTMLElement, content: string) => {
      element.textContent = content;
    },
  },
}));

interface MockPort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
  emitMessage(message: unknown): void;
  emitDisconnect(): void;
}

function createPort(name: string): MockPort {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const emitDisconnect = () => {
    for (const listener of disconnectListeners) listener();
  };
  return {
    name,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => queueMicrotask(emitDisconnect)),
    onMessage: {
      addListener: (listener) => messageListeners.push(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.push(listener),
    },
    emitMessage(message) {
      for (const listener of messageListeners) listener(message);
    },
    emitDisconnect,
  };
}

function sendMessage(text: string): void {
  const input = document.getElementById('message-input') as HTMLTextAreaElement;
  const sendButton = document.getElementById('send-button') as HTMLButtonElement;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(sendButton.disabled).toBe(false);
  sendButton.click();
}

function failureCount(): number {
  return (document.getElementById('messages')?.textContent?.match(/Failed to send message/g) || [])
    .length;
}

function isStopMode(): boolean {
  return (document.getElementById('send-button') as HTMLButtonElement).classList.contains(
    'stop-mode'
  );
}

describe('sidebar stream lifecycle ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.resetModules();
    window.location.hash = '#tab=123';
    document.body.innerHTML = `
      <main id="app">
        <select id="agent-select"></select>
        <button id="settings-button"></button>
        <div id="messages"></div>
        <textarea id="message-input"></textarea>
        <button id="attach-button"></button>
        <div id="attachment-indicator"></div>
        <button id="send-button"></button>
      </main>
    `;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    window.location.hash = '';
  });

  it('settles cancellation and disconnect without stale sessions clearing replacements', async () => {
    const ports: MockPort[] = [];
    let blockNextHints = false;
    let resolveBlockedHints: ((value: { hints: never[] }) => void) | undefined;
    chrome.runtime.connect = vi.fn(({ name }) => {
      const port = createPort(name);
      ports.push(port);
      return port as unknown as chrome.runtime.Port;
    });
    chrome.runtime.sendMessage = vi.fn(async (message) => {
      if (message.type === 'GET_SITE_TOOL_HINTS') {
        if (blockNextHints) {
          blockNextHints = false;
          return new Promise<{ hints: never[] }>((resolve) => {
            resolveBlockedHints = resolve;
          });
        }
        return { hints: [] };
      }
      return { pong: true };
    });
    chrome.tabs.get = vi.fn().mockResolvedValue({
      id: 123,
      url: 'https://example.com/current',
      title: 'Current page',
    });

    await import('../src/sidebar/index');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(configStorage.getDefaultAgent).toHaveBeenCalled());

    blockNextHints = true;
    sendMessage('Cancel during page-context preparation');
    await vi.waitFor(() => expect(resolveBlockedHints).toBeTypeOf('function'));
    expect(ports).toHaveLength(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(isStopMode()).toBe(false));
    resolveBlockedHints?.({ hints: [] });
    await Promise.resolve();
    expect(ports).toHaveLength(0);
    expect(failureCount()).toBe(0);

    sendMessage('Cancel this request');
    await vi.waitFor(() => expect(ports[0]?.postMessage).toHaveBeenCalledOnce());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(ports[0].disconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(isStopMode()).toBe(false));
    expect(failureCount()).toBe(0);

    sendMessage('Lose this connection');
    await vi.waitFor(() => expect(ports[1]?.postMessage).toHaveBeenCalledOnce());
    ports[1].emitDisconnect();
    await vi.waitFor(() => expect(failureCount()).toBe(1));
    expect(isStopMode()).toBe(false);

    sendMessage('Continue after tools change');
    await vi.waitFor(() => expect(ports[2]?.postMessage).toHaveBeenCalledOnce());
    chrome.tabs.get = vi.fn().mockResolvedValue({
      id: 123,
      url: 'https://example.com/after-navigation',
      title: 'Page after navigation',
    });
    ports[2].emitMessage({
      type: 'STREAM_COMPLETE',
      fullResponse: 'first step',
      toolsChanged: true,
    });
    await vi.waitFor(() => {
      expect(ports).toHaveLength(4);
      expect(ports[3].postMessage).toHaveBeenCalledOnce();
    });
    const continuationPayload = ports[3].postMessage.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const originalTurn = continuationPayload.messages.find(
      ({ role, content }) => role === 'user' && content.includes('Continue after tools change')
    );
    const continuationTurn = continuationPayload.messages.at(-1);
    expect(originalTurn?.content).toContain('https://example.com/current');
    expect(originalTurn?.content).not.toContain('https://example.com/after-navigation');
    expect(continuationTurn?.content).toContain('https://example.com/after-navigation');
    expect(continuationTurn?.content).toContain('<title>Page after navigation</title>');

    ports[2].emitDisconnect();
    ports[3].emitMessage({ type: 'STREAM_COMPLETE', fullResponse: 'finished' });
    await vi.waitFor(() => expect(ports[3].disconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(isStopMode()).toBe(false));
    expect(failureCount()).toBe(1);
  });
});
