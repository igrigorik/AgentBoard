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
  ConfigStorage: {
    getInstance: () => configStorage,
  },
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
}

function createPort(name: string): MockPort {
  const messageListeners: Array<(message: unknown) => void> = [];

  return {
    name,
    postMessage: vi.fn(() => {
      queueMicrotask(() => {
        for (const listener of messageListeners) {
          listener({ type: 'STREAM_COMPLETE', fullResponse: '' });
        }
      });
    }),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (listener) => messageListeners.push(listener),
    },
    onDisconnect: {
      addListener: vi.fn(),
    },
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

describe('sidebar model history', () => {
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

  it('renders sidebar notices without sending them as assistant turns', async () => {
    const ports: MockPort[] = [];
    chrome.runtime.connect = vi.fn(({ name }) => {
      const port = createPort(name);
      ports.push(port);
      return port as unknown as chrome.runtime.Port;
    });
    chrome.runtime.sendMessage = vi.fn(async (message) => {
      if (message.type === 'GET_SITE_TOOL_HINTS') return { hints: [] };
      return { pong: true };
    });
    chrome.tabs.get = vi.fn().mockResolvedValue({
      id: 123,
      url: 'https://example.com/current',
      title: 'Current page',
    });

    await import('../src/sidebar/index');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const messages = document.getElementById('messages') as HTMLDivElement;
    await vi.waitFor(() => {
      expect(messages.textContent).toContain("Hello! I'm your AI assistant.");
    });

    sendMessage('First request');
    await vi.waitFor(() => {
      expect(ports).toHaveLength(1);
      expect(ports[0].postMessage).toHaveBeenCalledOnce();
    });

    const firstPayload = ports[0].postMessage.mock.calls[0][0];
    expect(firstPayload.type).toBe('STREAM_CHAT');
    expect(firstPayload.messages).toHaveLength(1);
    expect(firstPayload.messages[0]).toMatchObject({ role: 'user' });
    expect(firstPayload.messages[0].content).toContain('First request');
    expect(JSON.stringify(firstPayload.messages)).not.toContain("Hello! I'm your AI assistant.");
    await vi.waitFor(() => expect(ports[0].disconnect).toHaveBeenCalledOnce());

    window.dispatchEvent(new Event('clear-conversation'));
    expect(messages.textContent).toContain('Conversation cleared. How can I help you?');

    sendMessage('After clear');
    await vi.waitFor(() => {
      expect(ports).toHaveLength(2);
      expect(ports[1].postMessage).toHaveBeenCalledOnce();
    });

    const secondPayload = ports[1].postMessage.mock.calls[0][0];
    expect(secondPayload.type).toBe('STREAM_CHAT');
    expect(secondPayload.messages).toHaveLength(1);
    expect(secondPayload.messages[0]).toMatchObject({ role: 'user' });
    expect(secondPayload.messages[0].content).toContain('After clear');
    expect(JSON.stringify(secondPayload.messages)).not.toContain(
      'Conversation cleared. How can I help you?'
    );
  });
});
