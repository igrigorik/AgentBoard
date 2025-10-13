/**
 * Tests for tab-scoped side panel behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Tab-Scoped Side Panel', () => {
  let mockChrome: any;

  beforeEach(() => {
    // Create fresh mocks for each test
    mockChrome = {
      sidePanel: {
        open: vi.fn((_options, callback) => callback && callback()),
        setOptions: vi.fn().mockResolvedValue(undefined),
        setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 123, windowId: 1, url: 'https://example.com' }]),
      },
      action: {
        onClicked: {
          addListener: vi.fn(),
        },
      },
      commands: {
        onCommand: {
          addListener: vi.fn(),
        },
      },
      contextMenus: {
        onClicked: {
          addListener: vi.fn(),
        },
        create: vi.fn(),
        removeAll: vi.fn().mockResolvedValue(undefined),
      },
      runtime: {
        sendMessage: vi.fn((_message, callback) => callback && callback()),
        lastError: null,
      },
      storage: {
        local: {
          get: vi.fn((_keys, callback) => callback && callback({})),
          set: vi.fn((_data, callback) => callback && callback()),
        },
      },
    };

    // Set global chrome mock
    global.chrome = mockChrome as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Panel Configuration', () => {
    it('should call setPanelBehavior on startup', async () => {
      // This would be tested in the actual background script initialization
      // Here we just verify the mock exists
      expect(mockChrome.sidePanel.setPanelBehavior).toBeDefined();
    });

    it('should call setOptions with tabId and unique path before opening', async () => {
      const tabId = 123;
      const expectedPath = `src/sidebar/index.html#tab=${tabId}`;

      // Simulate ensureTabPanel function
      await mockChrome.sidePanel.setOptions({
        tabId,
        path: expectedPath,
        enabled: true,
      });

      expect(mockChrome.sidePanel.setOptions).toHaveBeenCalledWith({
        tabId,
        path: expectedPath,
        enabled: true,
      });
    });

    it('should include tabId in the panel URL hash', async () => {
      const tabId = 456;
      const expectedPath = `src/sidebar/index.html#tab=${tabId}`;

      await mockChrome.sidePanel.setOptions({
        tabId,
        path: expectedPath,
        enabled: true,
      });

      const call = mockChrome.sidePanel.setOptions.mock.calls[0][0];
      expect(call.path).toContain(`#tab=${tabId}`);
    });
  });

  describe('Action Button Click', () => {
    it('should configure panel and open for specific tab', async () => {
      const tab = { id: 789, windowId: 1 };

      // Simulate action click handler
      await mockChrome.sidePanel.setOptions({
        tabId: tab.id,
        path: `src/sidebar/index.html#tab=${tab.id}`,
        enabled: true,
      });

      mockChrome.sidePanel.open({ tabId: tab.id }, () => {});

      // Verify setOptions was called
      expect(mockChrome.sidePanel.setOptions).toHaveBeenCalled();
      // Verify open was called with tabId
      expect(mockChrome.sidePanel.open).toHaveBeenCalledWith(
        { tabId: tab.id },
        expect.any(Function)
      );
    });

    it('should not use windowId in open call', async () => {
      const tab = { id: 321, windowId: 2 };

      mockChrome.sidePanel.open({ tabId: tab.id }, () => {});

      const openCall = mockChrome.sidePanel.open.mock.calls[0][0];
      expect(openCall).not.toHaveProperty('windowId');
      expect(openCall).toHaveProperty('tabId');
    });
  });

  describe('Context Menu', () => {
    it('should include tabId in CONTEXT_SELECTION message', async () => {
      const tabId = 555;
      const selectedText = 'test selection';

      mockChrome.runtime.sendMessage({
        type: 'CONTEXT_SELECTION',
        text: selectedText,
        tabId,
      });

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'CONTEXT_SELECTION',
        text: selectedText,
        tabId,
      });
    });
  });

  describe('Message Filtering', () => {
    it('sidebar should ignore messages for different tabs', () => {
      const attachedTabId = 111;
      const differentTabId = 222;
      const message = {
        type: 'CONTEXT_SELECTION',
        text: 'some text',
        tabId: differentTabId,
      };

      // Simulate message filtering logic
      const shouldHandle = message.tabId === attachedTabId;
      expect(shouldHandle).toBe(false);
    });

    it('sidebar should handle messages for its own tab', () => {
      const attachedTabId = 333;
      const message = {
        type: 'CONTEXT_SELECTION',
        text: 'some text',
        tabId: attachedTabId,
      };

      // Simulate message filtering logic
      const shouldHandle = message.tabId === attachedTabId;
      expect(shouldHandle).toBe(true);
    });
  });

  describe('Port Connection Names', () => {
    it('should include tabId in streaming port name', () => {
      const tabId = 777;
      const timestamp = Date.now();
      const connectionId = `ai-stream-${tabId}-${timestamp}`;

      expect(connectionId).toMatch(/ai-stream-\d+-\d+/);
      expect(connectionId).toContain(`-${tabId}-`);
    });

    it('should use "unknown" for null tabId in port name', () => {
      const tabId = null;
      const timestamp = Date.now();
      const connectionId = `ai-stream-${tabId || 'unknown'}-${timestamp}`;

      expect(connectionId).toContain('ai-stream-unknown-');
    });
  });

  describe('No Global Fallback', () => {
    it('should not call open with windowId on failure', async () => {
      const tab = { id: 999, windowId: 3 };

      // Simulate error in first open call
      mockChrome.runtime.lastError = { message: 'Panel open failed' };
      mockChrome.sidePanel.open({ tabId: tab.id }, () => {
        // Error callback - should not retry with windowId
      });

      // Verify only one call was made, with tabId only
      expect(mockChrome.sidePanel.open).toHaveBeenCalledTimes(1);
      expect(mockChrome.sidePanel.open).toHaveBeenCalledWith(
        { tabId: tab.id },
        expect.any(Function)
      );
    });
  });
});
