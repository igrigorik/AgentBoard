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
  emitMessage(message: unknown): void;
  emitDisconnect(): void;
}

function createPort(name: string, autoComplete = true): MockPort {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const emitMessage = (message: unknown) => {
    for (const listener of messageListeners) listener(message);
  };
  const emitDisconnect = () => {
    for (const listener of disconnectListeners) listener();
  };

  return {
    name,
    postMessage: vi.fn(() => {
      if (autoComplete) {
        queueMicrotask(() => emitMessage({ type: 'STREAM_COMPLETE', fullResponse: '' }));
      }
    }),
    disconnect: vi.fn(() => queueMicrotask(emitDisconnect)),
    onMessage: {
      addListener: (listener) => messageListeners.push(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.push(listener),
    },
    emitMessage,
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

function configureChrome(ports: MockPort[], autoComplete: boolean): void {
  chrome.runtime.connect = vi.fn(({ name }) => {
    const port = createPort(name, autoComplete);
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

  it('preserves each user turn page context without retaining historical tool hints', async () => {
    const ports: MockPort[] = [];
    configureChrome(ports, true);
    let currentHints = [{ name: 'video_a_tool', description: 'Tool available on video A' }];
    chrome.runtime.sendMessage = vi.fn(async (message) => {
      if (message.type === 'GET_SITE_TOOL_HINTS') return { hints: currentHints };
      return { pong: true };
    });
    chrome.tabs.get = vi.fn().mockResolvedValue({
      id: 123,
      url: 'https://video.example/watch/a',
      title: 'Video A',
    });

    await import('../src/sidebar/index');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(configStorage.getDefaultAgent).toHaveBeenCalled());

    sendMessage('Question about the first video');
    await vi.waitFor(() => expect(ports[0]?.postMessage).toHaveBeenCalledOnce());
    const firstPayload = ports[0].postMessage.mock.calls[0][0];
    expect(firstPayload.messages[0].content).toContain('https://video.example/watch/a');
    expect(firstPayload.messages[0].content).toContain('<title>Video A</title>');
    expect(firstPayload.messages[0].content).toContain('video_a_tool');
    expect(firstPayload.messages[0].content).toContain(
      "active browser tab's existing signed-in session"
    );
    expect(firstPayload.messages[0].content).not.toContain('full session and credentials');
    await vi.waitFor(() => expect(ports[0].disconnect).toHaveBeenCalledOnce());

    currentHints = [{ name: 'video_b_tool', description: 'Tool available on video B' }];
    chrome.tabs.get = vi.fn().mockResolvedValue({
      id: 123,
      url: 'https://video.example/watch/b',
      title: 'Video B',
    });
    sendMessage('Question about the second video');
    await vi.waitFor(() => expect(ports[1]?.postMessage).toHaveBeenCalledOnce());

    const secondPayload = ports[1].postMessage.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessages = secondPayload.messages.filter(({ role }) => role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].content).toContain('https://video.example/watch/a');
    expect(userMessages[0].content).toContain('<title>Video A</title>');
    expect(userMessages[0].content).not.toContain('https://video.example/watch/b');
    expect(userMessages[0].content).not.toContain('<site_tools>');
    expect(userMessages[1].content).toContain('https://video.example/watch/b');
    expect(userMessages[1].content).toContain('<title>Video B</title>');
    expect(userMessages[1].content).toContain('video_b_tool');
    expect(userMessages[1].content).not.toContain('video_a_tool');
  });

  it('renders sidebar notices without sending them as assistant turns', async () => {
    const ports: MockPort[] = [];
    configureChrome(ports, true);

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
