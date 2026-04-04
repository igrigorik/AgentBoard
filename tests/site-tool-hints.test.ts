/**
 * Tests for getSiteToolHints() — domain-specific tool steering
 *
 * Verifies that <site_tools> hints correctly filter by tab scope and
 * specificity score, excluding generic <all_urls> tools while including
 * domain-specific and page-provided tools.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryManager } from '../src/lib/webmcp/tool-registry';

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

describe('getSiteToolHints', () => {
  let registry: ToolRegistryManager;

  beforeEach(() => {
    registry = new ToolRegistryManager();
  });

  it('should return empty array for tab with no tools', () => {
    const hints = registry.getSiteToolHints(999);
    expect(hints).toEqual([]);
  });

  it('should exclude generic <all_urls> tools (score 30)', () => {
    // agentboard_read_page is in COMPILED_TOOLS with <all_urls> pattern → score 30
    registry.addTool('agentboard_read_page', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      description: 'Read the current page as clean markdown.',
    });

    const hints = registry.getSiteToolHints(100);
    expect(hints).toEqual([]);
  });

  it('should include domain-specific injected tools (score > 30)', () => {
    // agentboard_youtube_transcript has specific URL pattern → score ~65
    registry.addTool('agentboard_youtube_transcript', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      description: "Get the current YouTube video's transcript.",
    });

    const hints = registry.getSiteToolHints(100);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toEqual({
      name: 'agentboard_youtube_transcript',
      description: "Get the current YouTube video's transcript.",
    });
  });

  it('should include page-provided tools (score 100)', () => {
    // Tools not in COMPILED_TOOLS pattern registry → site-provided → score 100
    registry.addTool('slack_conversation_context', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-200',
      description: 'Fetch Slack conversation from the current channel.',
    });

    const hints = registry.getSiteToolHints(200);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toEqual({
      name: 'slack_conversation_context',
      description: 'Fetch Slack conversation from the current channel.',
    });
  });

  it('should not return tools from other tabs', () => {
    registry.addTool('slack_conversation_context', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-200',
      description: 'Slack tool',
    });

    const hints = registry.getSiteToolHints(100);
    expect(hints).toEqual([]);
  });

  it('should not return system or remote tools', () => {
    registry.addTool('agentboard_fetch_url', {
      tool: { execute: vi.fn() },
      source: 'system',
      origin: 'system',
      description: 'Fetch content from external URLs.',
    });

    registry.addTool('mcp_server_tool', {
      tool: { execute: vi.fn() },
      source: 'remote',
      origin: 'mcp-server',
      description: 'Remote MCP tool.',
    });

    const hints = registry.getSiteToolHints(100);
    expect(hints).toEqual([]);
  });

  it('should sort by specificity score descending', () => {
    // Page-provided tool (score 100) — not in pattern registry
    registry.addTool('custom_slack_tool', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      description: 'Custom Slack tool',
    });

    // Domain-specific injected tool (score ~65)
    registry.addTool('agentboard_youtube_transcript', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      description: 'YouTube transcript',
    });

    const hints = registry.getSiteToolHints(100);
    expect(hints).toHaveLength(2);
    // Page-provided (100) should come before injected (~65)
    expect(hints[0].name).toBe('custom_slack_tool');
    expect(hints[1].name).toBe('agentboard_youtube_transcript');
  });

  it('should fall back to tool name when description is missing', () => {
    registry.addTool('some_page_tool', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      // no description
    });

    const hints = registry.getSiteToolHints(100);
    expect(hints).toHaveLength(1);
    expect(hints[0].description).toBe('some_page_tool');
  });

  it('should handle mixed tools: generic filtered, specific included', () => {
    // Generic tool (score 30) — should be filtered
    registry.addTool('agentboard_read_page', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      description: 'Read page',
    });

    // Domain-specific tool (score ~65) — should be included
    registry.addTool('agentboard_youtube_transcript', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      description: 'YouTube transcript',
    });

    // Page-provided tool (score 100) — should be included
    registry.addTool('site_custom_tool', {
      tool: { execute: vi.fn() },
      source: 'site',
      origin: 'tab-100',
      description: 'Custom tool from page',
    });

    const hints = registry.getSiteToolHints(100);
    expect(hints).toHaveLength(2);
    expect(hints.map((h) => h.name)).toContain('agentboard_youtube_transcript');
    expect(hints.map((h) => h.name)).toContain('site_custom_tool');
    expect(hints.map((h) => h.name)).not.toContain('agentboard_read_page');
  });
});
