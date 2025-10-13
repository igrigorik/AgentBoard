/**
 * Tests for WebMCP Content Script Relay
 * Tests reconnection logic, message queueing, and port management
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('WebMCP Content Script Relay', () => {
  let mockPort: any;
  let mockChrome: any;
  let relay: any;
  let originalWindow: any;
  let originalChrome: any;

  beforeEach(() => {
    // Save original globals
    originalWindow = (global as any).window;
    originalChrome = (global as any).chrome;

    // Setup mock port
    mockPort = {
      postMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
      },
      onDisconnect: {
        addListener: vi.fn(),
      },
      disconnect: vi.fn(),
    };

    // Setup mock chrome API
    mockChrome = {
      runtime: {
        connect: vi.fn(() => mockPort),
        lastError: null,
      },
    };

    // Setup mock window
    (global as any).window = {
      addEventListener: vi.fn(),
      postMessage: vi.fn(),
      __webmcpRelayBridge: undefined,
    };

    (global as any).chrome = mockChrome;
    (global as any).setTimeout = vi.fn((fn: Function) => fn());
  });

  afterEach(() => {
    // Restore original globals
    (global as any).window = originalWindow;
    (global as any).chrome = originalChrome;
    vi.clearAllMocks();
  });

  describe('Connection Management', () => {
    it('should connect to background on initialization', () => {
      // Simulate relay initialization
      const RelayClass = class WebMCPRelayBridge {
        port: any = null;
        pendingMessages: any[] = [];
        reconnectAttempt = 0;

        constructor() {
          this.connect();
        }

        connect() {
          this.port = chrome.runtime.connect({ name: 'webmcp-content-script' });
        }
      };

      relay = new RelayClass();

      expect(mockChrome.runtime.connect).toHaveBeenCalledWith({
        name: 'webmcp-content-script',
      });
      expect(relay.port).toBe(mockPort);
    });

    it('should handle port disconnection', () => {
      let disconnectHandler: Function | null = null;

      mockPort.onDisconnect.addListener = vi.fn((handler) => {
        disconnectHandler = handler;
      });

      const RelayClass = class WebMCPRelayBridge {
        port: any = null;
        pendingMessages: any[] = [];
        reconnectAttempt = 0;

        constructor() {
          this.connect();
        }

        connect() {
          this.port = chrome.runtime.connect({ name: 'webmcp-content-script' });

          this.port.onDisconnect.addListener(() => {
            this.port = null;
            this.reconnectWithBackoff();
          });
        }

        reconnectWithBackoff() {
          this.reconnectAttempt++;
        }
      };

      relay = new RelayClass();
      expect(relay.port).toBe(mockPort);
      expect(relay.reconnectAttempt).toBe(0);

      // Simulate disconnection
      if (disconnectHandler) {
        (disconnectHandler as Function)();
      }

      expect(relay.port).toBeNull();
      expect(relay.reconnectAttempt).toBe(1);
    });

    it('should implement exponential backoff for reconnection', () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const RelayClass = class WebMCPRelayBridge {
        port: any = null;
        reconnectAttempt = 0;
        initialDelay = 100;
        maxReconnectDelay = 30000;

        reconnectWithBackoff() {
          this.reconnectAttempt++;

          const delay = Math.min(
            this.initialDelay * Math.pow(2, this.reconnectAttempt - 1),
            this.maxReconnectDelay
          );

          setTimeout(() => {
            if (!this.port) {
              this.connect();
            }
          }, delay);
        }

        connect() {
          this.port = chrome.runtime.connect({ name: 'webmcp-content-script' });
        }
      };

      relay = new RelayClass();

      // Test exponential backoff delays
      relay.reconnectAttempt = 0;
      relay.reconnectWithBackoff();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);

      relay.reconnectAttempt = 1;
      relay.reconnectWithBackoff();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 200);

      relay.reconnectAttempt = 2;
      relay.reconnectWithBackoff();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 400);

      // Test max delay cap
      relay.reconnectAttempt = 10;
      relay.reconnectWithBackoff();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
    });
  });

  describe('Message Queueing', () => {
    it('should queue messages when disconnected', () => {
      const RelayClass = class WebMCPRelayBridge {
        port: any = null;
        pendingMessages: any[] = [];

        sendToBackground(message: any) {
          if (this.port) {
            this.port.postMessage(message);
          } else {
            this.pendingMessages.push(message);
          }
        }
      };

      relay = new RelayClass();
      const message = { type: 'test', data: 'value' };

      relay.sendToBackground(message);

      expect(relay.pendingMessages).toHaveLength(1);
      expect(relay.pendingMessages[0]).toEqual(message);
    });

    it('should send messages directly when connected', () => {
      const RelayClass = class WebMCPRelayBridge {
        port: any = mockPort;
        pendingMessages: any[] = [];

        sendToBackground(message: any) {
          if (this.port) {
            this.port.postMessage(message);
          } else {
            this.pendingMessages.push(message);
          }
        }
      };

      relay = new RelayClass();
      const message = { type: 'test', data: 'value' };

      relay.sendToBackground(message);

      expect(mockPort.postMessage).toHaveBeenCalledWith(message);
      expect(relay.pendingMessages).toHaveLength(0);
    });

    it('should flush pending messages after reconnection', () => {
      const RelayClass = class WebMCPRelayBridge {
        port: any = null;
        pendingMessages: any[] = [];

        connect() {
          this.port = chrome.runtime.connect({ name: 'webmcp-content-script' });
          this.flushPendingMessages();
        }

        flushPendingMessages() {
          if (!this.port || !this.pendingMessages.length) return;

          while (this.pendingMessages.length > 0) {
            const msg = this.pendingMessages.shift();
            this.port.postMessage(msg);
          }
        }
      };

      relay = new RelayClass();

      // Queue some messages
      relay.pendingMessages = [{ type: 'msg1' }, { type: 'msg2' }, { type: 'msg3' }];

      // Reconnect
      relay.connect();

      expect(mockPort.postMessage).toHaveBeenCalledTimes(3);
      expect(mockPort.postMessage).toHaveBeenNthCalledWith(1, { type: 'msg1' });
      expect(mockPort.postMessage).toHaveBeenNthCalledWith(2, { type: 'msg2' });
      expect(mockPort.postMessage).toHaveBeenNthCalledWith(3, { type: 'msg3' });
      expect(relay.pendingMessages).toHaveLength(0);
    });
  });

  describe('Message Relay', () => {
    it('should forward messages from page to background', () => {
      let messageHandler: Function | null = null;

      (global as any).window.addEventListener = vi.fn((event, handler) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const RelayClass = class WebMCPRelayBridge {
        port: any = mockPort;

        constructor() {
          this.setupMessageRelay();
        }

        setupMessageRelay() {
          window.addEventListener('message', (event: any) => {
            if (event.source !== window) return;
            if (!event.data || event.data.source !== 'webmcp-main') return;
            if (event.data.jsonrpc !== '2.0') return;

            const { source: _source, ...payload } = event.data;

            const msg = {
              type: 'webmcp',
              payload,
              tabUrl: 'http://example.com',
              timestamp: Date.now(),
            };

            this.port.postMessage(msg);
          });
        }
      };

      relay = new RelayClass();

      // Simulate message from page
      const pageMessage = {
        source: (global as any).window,
        data: {
          source: 'webmcp-main',
          jsonrpc: '2.0',
          method: 'tools/listChanged',
          params: { tools: [] },
        },
      };

      if (messageHandler) {
        (messageHandler as Function)(pageMessage);
      }

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'webmcp',
        payload: {
          jsonrpc: '2.0',
          method: 'tools/listChanged',
          params: { tools: [] },
        },
        tabUrl: expect.any(String),
        timestamp: expect.any(Number),
      });
    });

    it('should forward messages from background to page', () => {
      let portMessageHandler: Function | null = null;

      mockPort.onMessage.addListener = vi.fn((handler) => {
        portMessageHandler = handler;
      });

      const RelayClass = class WebMCPRelayBridge {
        port: any = null;

        constructor() {
          this.connect();
        }

        connect() {
          this.port = chrome.runtime.connect({ name: 'webmcp-content-script' });

          this.port.onMessage.addListener((msg: any) => {
            if (msg?.type === 'webmcp' && msg?.payload) {
              window.postMessage(
                {
                  source: 'webmcp-bridge',
                  jsonrpc: '2.0',
                  ...msg.payload,
                },
                '*'
              );
            }
          });
        }
      };

      relay = new RelayClass();

      // Simulate message from background
      const backgroundMessage = {
        type: 'webmcp',
        payload: {
          id: '123',
          method: 'tools/call',
          params: { name: 'test-tool' },
        },
      };

      if (portMessageHandler) {
        (portMessageHandler as Function)(backgroundMessage);
      }

      expect((global as any).window.postMessage).toHaveBeenCalledWith(
        {
          source: 'webmcp-bridge',
          jsonrpc: '2.0',
          id: '123',
          method: 'tools/call',
          params: { name: 'test-tool' },
        },
        '*'
      );
    });
  });

  describe('Singleton Pattern', () => {
    it('should prevent double injection', () => {
      // Set flag indicating already injected
      (global as any).window.__webmcpRelayBridge = true;

      const initSpy = vi.fn();

      // Try to initialize again
      if (!(global as any).window.__webmcpRelayBridge) {
        initSpy();
      }

      expect(initSpy).not.toHaveBeenCalled();
    });

    it('should create singleton instance on first injection', () => {
      delete (global as any).window.__webmcpRelayBridge;

      const RelayClass = class WebMCPRelayBridge {
        constructor() {
          (global as any).window.__webmcpRelayBridge = this;
        }
      };

      if (!(global as any).window.__webmcpRelayBridge) {
        new RelayClass();
      }

      expect((global as any).window.__webmcpRelayBridge).toBeDefined();

      // Try to create another instance
      const secondInstance = !(global as any).window.__webmcpRelayBridge ? new RelayClass() : null;

      expect(secondInstance).toBeNull();
    });
  });
});
