/**
 * Tests for tab-scoped tool registry behavior
 *
 * Regression test for bug where tools from ALL tabs were displayed
 * in the sidebar regardless of URL match patterns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryManager } from '../src/lib/webmcp/tool-registry';

// Mock the dependencies
vi.mock('../src/lib/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/lib/mcp/manager', () => ({
  getRemoteMCPManager: vi.fn(() => ({
    loadConfig: vi.fn(),
    getAvailableTools: vi.fn(() => []),
    getServerStatuses: vi.fn(() => []),
  })),
}));

vi.mock('../src/lib/storage/config', () => ({
  ConfigStorage: {
    getInstance: vi.fn(() => ({
      get: vi.fn().mockResolvedValue({}),
      isBuiltinToolEnabled: vi.fn().mockResolvedValue(true),
    })),
  },
}));

describe('ToolRegistryManager Tab Scoping', () => {
  let registry: ToolRegistryManager;

  beforeEach(() => {
    registry = new ToolRegistryManager();
  });

  describe('getToolsForTab', () => {
    it('should only return tools from the specified tab', () => {
      // Simulate tools registered from two different tabs
      const mockTool1 = { execute: vi.fn() };
      const mockTool2 = { execute: vi.fn() };

      registry.addTool('google_docs_document_context', {
        tool: mockTool1,
        source: 'site',
        origin: 'tab-100', // Tab 100 is on Google Docs
      });

      registry.addTool('slack_conversation_context', {
        tool: mockTool2,
        source: 'site',
        origin: 'tab-200', // Tab 200 is on Slack
      });

      // Get tools for tab 100 (Google Docs)
      const tab100Tools = registry.getToolsForTab(100);
      expect(Object.keys(tab100Tools)).toContain('google_docs_document_context');
      expect(Object.keys(tab100Tools)).not.toContain('slack_conversation_context');

      // Get tools for tab 200 (Slack)
      const tab200Tools = registry.getToolsForTab(200);
      expect(Object.keys(tab200Tools)).toContain('slack_conversation_context');
      expect(Object.keys(tab200Tools)).not.toContain('google_docs_document_context');
    });

    it('should return empty object for tab with no tools', () => {
      registry.addTool('some_tool', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });

      const tab999Tools = registry.getToolsForTab(999);
      expect(Object.keys(tab999Tools)).toHaveLength(0);
    });

    it('should include system tools for all tabs', () => {
      const systemTool = { execute: vi.fn() };
      const siteTool = { execute: vi.fn() };

      registry.addTool('agentboard_fetch_url', {
        tool: systemTool,
        source: 'system',
        origin: 'system',
      });

      registry.addTool('google_docs_document_context', {
        tool: siteTool,
        source: 'site',
        origin: 'tab-100',
      });

      // System tool should appear for any tab
      const tab100Tools = registry.getToolsForTab(100);
      expect(Object.keys(tab100Tools)).toContain('agentboard_fetch_url');
      expect(Object.keys(tab100Tools)).toContain('google_docs_document_context');

      const tab200Tools = registry.getToolsForTab(200);
      expect(Object.keys(tab200Tools)).toContain('agentboard_fetch_url');
      expect(Object.keys(tab200Tools)).not.toContain('google_docs_document_context');
    });

    it('should include tab-bound factory tools for any tab', () => {
      const mockFactory = vi.fn((tabId: number) => ({ execute: vi.fn(), _tabId: tabId }));

      // Access private tabBoundFactories to register a factory
      (registry as any).tabBoundFactories.set('agentboard_navigate', mockFactory);

      const tab100Tools = registry.getToolsForTab(100);
      expect(Object.keys(tab100Tools)).toContain('agentboard_navigate');
      expect(mockFactory).toHaveBeenCalledWith(100);

      const tab200Tools = registry.getToolsForTab(200);
      expect(Object.keys(tab200Tools)).toContain('agentboard_navigate');
      expect(mockFactory).toHaveBeenCalledWith(200);
    });

    it('should NOT include tab-bound factory tools in getAllTools', () => {
      const mockFactory = vi.fn(() => ({ execute: vi.fn() }));

      (registry as any).tabBoundFactories.set('agentboard_navigate', mockFactory);

      const allTools = registry.getAllTools();
      expect(Object.keys(allTools)).not.toContain('agentboard_navigate');
      expect(mockFactory).not.toHaveBeenCalled();
    });

    it('should include remote MCP tools for all tabs', () => {
      const remoteTool = { execute: vi.fn() };
      const siteTool = { execute: vi.fn() };

      registry.addTool('mcp_server_tool', {
        tool: remoteTool,
        source: 'remote',
        origin: 'my-mcp-server',
      });

      registry.addTool('vault_project_context', {
        tool: siteTool,
        source: 'site',
        origin: 'tab-300',
      });

      // Remote tool should appear for any tab
      const tab300Tools = registry.getToolsForTab(300);
      expect(Object.keys(tab300Tools)).toContain('mcp_server_tool');
      expect(Object.keys(tab300Tools)).toContain('vault_project_context');

      const tab400Tools = registry.getToolsForTab(400);
      expect(Object.keys(tab400Tools)).toContain('mcp_server_tool');
      expect(Object.keys(tab400Tools)).not.toContain('vault_project_context');
    });
  });

  describe('getAllTools vs getToolsForTab', () => {
    it('getAllTools should return tools from all tabs', () => {
      registry.addTool('tool_tab_1', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-1',
      });

      registry.addTool('tool_tab_2', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-2',
      });

      registry.addTool('tool_tab_3', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-3',
      });

      const allTools = registry.getAllTools();
      expect(Object.keys(allTools)).toHaveLength(3);
      expect(Object.keys(allTools)).toContain('tool_tab_1');
      expect(Object.keys(allTools)).toContain('tool_tab_2');
      expect(Object.keys(allTools)).toContain('tool_tab_3');
    });

    it('getToolsForTab should NOT leak tools from other tabs', () => {
      // This is the regression test for the bug
      registry.addTool('google_docs_tool', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100', // Google Docs tab
      });

      registry.addTool('slack_tool', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-200', // Slack tab
      });

      registry.addTool('vault_tool', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-300', // Vault tab
      });

      // When on Vault (tab 300), should NOT see Google Docs or Slack tools
      const vaultTools = registry.getToolsForTab(300);
      expect(Object.keys(vaultTools)).toEqual(['vault_tool']);

      // Verify the bug scenario: user on vault.shopify.io should not see
      // google_docs_document_context or slack_conversation_context
      expect(Object.keys(vaultTools)).not.toContain('google_docs_tool');
      expect(Object.keys(vaultTools)).not.toContain('slack_tool');
    });
  });

  describe('updateWebMCPTools', () => {
    it('should replace tools for a tab when updated', () => {
      // We need to mock the tool bridge for this
      vi.doMock('../src/lib/webmcp/tool-bridge', () => ({
        convertWebMCPToAISDKTool: vi.fn((tool) => ({
          ...tool,
          execute: vi.fn(),
        })),
      }));

      // Initial tools for tab 100
      registry.addTool('old_tool', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });

      // Simulate removeToolsByOrigin (called by updateWebMCPTools)
      registry.removeToolsByOrigin('tab-100');

      // Add new tool
      registry.addTool('new_tool', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });

      const tools = registry.getToolsForTab(100);
      expect(Object.keys(tools)).toContain('new_tool');
      expect(Object.keys(tools)).not.toContain('old_tool');
    });
  });

  describe('removeToolsByOrigin', () => {
    it('should remove all tools from a specific tab', () => {
      registry.addTool('tool1', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });

      registry.addTool('tool2', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });

      registry.addTool('tool3', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-200',
      });

      registry.removeToolsByOrigin('tab-100');

      const allTools = registry.getAllTools();
      expect(Object.keys(allTools)).toEqual(['tool3']);
    });

    it('should not affect tools from other origins', () => {
      registry.addTool('site_tool', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });

      registry.addTool('system_tool', {
        tool: { execute: vi.fn() },
        source: 'system',
        origin: 'system',
      });

      registry.addTool('remote_tool', {
        tool: { execute: vi.fn() },
        source: 'remote',
        origin: 'mcp-server',
      });

      registry.removeToolsByOrigin('tab-100');

      const allTools = registry.getAllTools();
      expect(Object.keys(allTools)).toContain('system_tool');
      expect(Object.keys(allTools)).toContain('remote_tool');
      expect(Object.keys(allTools)).not.toContain('site_tool');
    });
  });

  describe('onTabToolsChanged subscription', () => {
    it('should fire callback when tools are removed for a tab', () => {
      const callback = vi.fn();
      registry.onTabToolsChanged(100, callback);

      registry.addTool('tool1', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });

      // removeToolsByOrigin should fire the tab change callback
      registry.removeToolsByOrigin('tab-100');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should fire callback when updateWebMCPTools replaces tools', () => {
      const callback = vi.fn();
      registry.onTabToolsChanged(100, callback);

      // updateWebMCPTools calls removeToolsByOrigin(silent) + addTool + notifyTabChange
      registry.updateWebMCPTools(
        100,
        [{ name: 'new_tool', description: 'A new tool' }],
        'https://example.com'
      );

      // Fired exactly once: removeToolsByOrigin is silent, only the final notify fires
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should not fire callback for different tab', () => {
      const callback100 = vi.fn();
      const callback200 = vi.fn();
      registry.onTabToolsChanged(100, callback100);
      registry.onTabToolsChanged(200, callback200);

      registry.addTool('tool1', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });
      registry.removeToolsByOrigin('tab-100');

      expect(callback100).toHaveBeenCalled();
      expect(callback200).not.toHaveBeenCalled();
    });

    it('should unsubscribe cleanly', () => {
      const callback = vi.fn();
      const unsub = registry.onTabToolsChanged(100, callback);

      unsub();

      registry.addTool('tool1', {
        tool: { execute: vi.fn() },
        source: 'site',
        origin: 'tab-100',
      });
      registry.removeToolsByOrigin('tab-100');

      expect(callback).not.toHaveBeenCalled();
    });

    it('should not fire for non-tab origins', () => {
      const callback = vi.fn();
      registry.onTabToolsChanged(100, callback);

      registry.addTool('mcp_tool', {
        tool: { execute: vi.fn() },
        source: 'remote',
        origin: 'mcp-server',
      });
      registry.removeToolsByOrigin('mcp-server');

      expect(callback).not.toHaveBeenCalled();
    });
  });
});
