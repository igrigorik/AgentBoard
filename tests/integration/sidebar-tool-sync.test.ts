/**
 * Integration tests for sidebar tool synchronization
 * Tests that sidebar receives and processes tool updates correctly
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryManager } from '../../src/lib/webmcp/tool-registry';

describe('Sidebar Tool Synchronization Integration', () => {
  let mockChrome: any;
  let registry: ToolRegistryManager;
  let messageListeners: Array<(msg: any, sender: any, sendResponse: any) => void>;

  beforeEach(() => {
    messageListeners = [];

    mockChrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ received: true }),
        onMessage: {
          addListener: vi.fn((listener) => {
            messageListeners.push(listener);
          }),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
      },
    };

    (globalThis as any).chrome = mockChrome;

    vi.clearAllMocks();
    registry = new ToolRegistryManager();
  });

  it('should broadcast tool update when new tools are registered', async () => {
    // Simulate tool registration
    const newTool = {
      tool: {
        name: 'fetch_data',
        description: 'Fetches data from API',
        execute: vi.fn(),
      },
      source: 'site' as const,
      origin: 'tab-123',
    };

    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });

    registry.addTool('fetch_data', newTool);

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'TOOLS_UPDATED',
        timestamp: expect.any(Number),
      });
    });
  });

  it('should handle sidebar requesting tools after update notification', async () => {
    // Setup: Add some tools to registry
    registry.addTool('tool1', {
      tool: { name: 'tool1', description: 'Tool 1' },
      source: 'site' as const,
      origin: 'tab-100',
    });
    registry.addTool('tool2', {
      tool: { name: 'tool2', description: 'Tool 2' },
      source: 'system' as const,
      origin: 'system',
    });

    // When sidebar sends WEBMCP_GET_TOOLS, we should return all tools
    const allTools = registry.getAllTools();
    expect(Object.keys(allTools)).toContain('tool1');
    expect(Object.keys(allTools)).toContain('tool2');
  });

  it('should broadcast when tools change during page navigation', async () => {
    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });

    // Initial page load - tools registered (2 tools = 2 broadcasts)
    registry.updateWebMCPTools(
      123,
      [
        { name: 'page_tool_1', description: 'Page Tool 1' },
        { name: 'page_tool_2', description: 'Page Tool 2' },
      ],
      'https://example.com'
    );

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    });

    vi.clearAllMocks();

    // Page navigation - new tools registered
    // removeToolsByOrigin (1 broadcast) + addTool x2 (2 broadcasts) = 3 total
    registry.updateWebMCPTools(
      123,
      [
        { name: 'page_tool_1', description: 'Page Tool 1' },
        { name: 'page_tool_3', description: 'Page Tool 3' },
      ],
      'https://example.com/new-page'
    );

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
    });
  });

  it('should maintain correct tool scoping for tabs', () => {
    // Add tools for different tabs
    registry.addTool('tab1_tool', {
      tool: { name: 'tab1_tool', description: 'Tab 1 Tool' },
      source: 'site' as const,
      origin: 'tab-100',
    });

    registry.addTool('tab2_tool', {
      tool: { name: 'tab2_tool', description: 'Tab 2 Tool' },
      source: 'site' as const,
      origin: 'tab-200',
    });

    registry.addTool('global_tool', {
      tool: { name: 'global_tool', description: 'Global Tool' },
      source: 'system' as const,
      origin: 'system',
    });

    // Tab 100 should see its own tool + global tools
    const tab100Tools = registry.getToolsForTab(100);
    expect(Object.keys(tab100Tools)).toContain('tab1_tool');
    expect(Object.keys(tab100Tools)).toContain('global_tool');
    expect(Object.keys(tab100Tools)).not.toContain('tab2_tool');

    // Tab 200 should see its own tool + global tools
    const tab200Tools = registry.getToolsForTab(200);
    expect(Object.keys(tab200Tools)).toContain('tab2_tool');
    expect(Object.keys(tab200Tools)).toContain('global_tool');
    expect(Object.keys(tab200Tools)).not.toContain('tab1_tool');
  });

  it('should handle rapid successive tool updates', async () => {
    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });

    // Simulate rapid tool additions
    for (let i = 0; i < 5; i++) {
      registry.addTool(`rapid_tool_${i}`, {
        tool: { name: `rapid_tool_${i}`, description: `Rapid Tool ${i}` },
        source: 'site' as const,
        origin: 'tab-123',
      });
    }

    // Should broadcast for each addition
    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(5);
    });

    // All should be TOOLS_UPDATED messages
    const calls = mockChrome.runtime.sendMessage.mock.calls;
    calls.forEach((call: any) => {
      expect(call[0]).toMatchObject({
        type: 'TOOLS_UPDATED',
        timestamp: expect.any(Number),
      });
    });
  });

  it('should handle sidebar opening before tools are registered', async () => {
    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });

    // Sidebar opens (empty registry)
    const initialTools = registry.getAllTools();
    expect(Object.keys(initialTools)).toHaveLength(0);

    // Later, tools are registered
    registry.addTool('late_tool', {
      tool: { name: 'late_tool', description: 'Late Tool' },
      source: 'site' as const,
      origin: 'tab-123',
    });

    // Broadcast should be sent
    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'TOOLS_UPDATED',
        timestamp: expect.any(Number),
      });
    });

    // Now tools should be available
    const updatedTools = registry.getAllTools();
    expect(Object.keys(updatedTools)).toContain('late_tool');
  });

  it('should handle sidebar opening after tools are already registered', () => {
    // Tools registered before sidebar opens
    registry.addTool('early_tool_1', {
      tool: { name: 'early_tool_1', description: 'Early Tool 1' },
      source: 'site' as const,
      origin: 'tab-123',
    });
    registry.addTool('early_tool_2', {
      tool: { name: 'early_tool_2', description: 'Early Tool 2' },
      source: 'system' as const,
      origin: 'system',
    });

    vi.clearAllMocks();

    // Sidebar opens and requests tools (initial fetch)
    const tools = registry.getToolsForTab(123);

    // Should get all relevant tools immediately
    expect(Object.keys(tools)).toContain('early_tool_1');
    expect(Object.keys(tools)).toContain('early_tool_2');
    expect(Object.keys(tools)).toHaveLength(2);
  });

  it('should handle remote MCP tools being added', async () => {
    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });

    // Simulate remote MCP tool registration
    registry.addTool('mcp_weather', {
      tool: {
        name: 'mcp_weather',
        description: 'Get weather data',
        execute: vi.fn(),
      },
      source: 'remote' as const,
      origin: 'weather-server',
    });

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'TOOLS_UPDATED',
        timestamp: expect.any(Number),
      });
    });

    // Remote tools should be available to all tabs
    const tab1Tools = registry.getToolsForTab(1);
    const tab2Tools = registry.getToolsForTab(2);

    expect(Object.keys(tab1Tools)).toContain('mcp_weather');
    expect(Object.keys(tab2Tools)).toContain('mcp_weather');
  });

  it('should handle tool cleanup when tab closes', async () => {
    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });

    // Add tools for a tab (2 tools = 2 broadcasts)
    registry.updateWebMCPTools(
      999,
      [
        { name: 'tab_tool_1', description: 'Tab Tool 1' },
        { name: 'tab_tool_2', description: 'Tab Tool 2' },
      ],
      'https://example.com'
    );

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    });

    vi.clearAllMocks();

    // Tab closes - remove tools (1 broadcast for removal)
    registry.removeToolsByOrigin('tab-999');

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    // Tools should be removed
    const remainingTools = registry.getToolsForTab(999);
    expect(Object.keys(remainingTools)).toHaveLength(0);
  });

  it('should handle concurrent updates from multiple tabs', async () => {
    mockChrome.runtime.sendMessage.mockResolvedValue({ received: true });

    // Simulate tools being registered from multiple tabs simultaneously
    const registrations = [
      () =>
        registry.updateWebMCPTools(
          100,
          [{ name: 'tab100_tool', description: 'Tab 100 Tool' }],
          'https://tab100.com'
        ),
      () =>
        registry.updateWebMCPTools(
          200,
          [{ name: 'tab200_tool', description: 'Tab 200 Tool' }],
          'https://tab200.com'
        ),
      () =>
        registry.updateWebMCPTools(
          300,
          [{ name: 'tab300_tool', description: 'Tab 300 Tool' }],
          'https://tab300.com'
        ),
    ];

    // Execute all registrations
    registrations.forEach((fn) => fn());

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
    });

    // Each tab should have its own tools + any global tools
    const tab100Tools = registry.getToolsForTab(100);
    const tab200Tools = registry.getToolsForTab(200);
    const tab300Tools = registry.getToolsForTab(300);

    expect(Object.keys(tab100Tools)).toContain('tab100_tool');
    expect(Object.keys(tab100Tools)).not.toContain('tab200_tool');

    expect(Object.keys(tab200Tools)).toContain('tab200_tool');
    expect(Object.keys(tab200Tools)).not.toContain('tab300_tool');

    expect(Object.keys(tab300Tools)).toContain('tab300_tool');
    expect(Object.keys(tab300Tools)).not.toContain('tab100_tool');
  });
});
