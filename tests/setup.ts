import { vi, beforeAll, afterAll, afterEach } from 'vitest';

// Mock Chrome API for testing
// This provides a minimal mock implementation - expand as needed
global.chrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(),
    },
    getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
    openOptionsPage: vi.fn(),
    lastError: null,
  },
  storage: {
    local: {
      get: vi.fn((_keys, callback) => {
        // Support both callback and promise style
        const result = {};
        if (callback) {
          callback(result);
        }
        return Promise.resolve(result);
      }),
      set: vi.fn((_items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: vi.fn((_keys, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      clear: vi.fn((callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    sync: {
      get: vi.fn((_keys, callback) => {
        const result = {};
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: vi.fn((_items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: vi.fn((_keys, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      clear: vi.fn((callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    sendMessage: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  sidePanel: {
    open: vi.fn(),
    setOptions: vi.fn(),
    setPanelBehavior: vi.fn(),
  },
  action: {
    onClicked: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  commands: {
    onCommand: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
} as any;

// Setup console mocking for cleaner test output
beforeAll(() => {
  // Silence console during tests unless explicitly testing console output
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

// Reset mocks between tests
afterEach(() => {
  vi.clearAllMocks();
});
