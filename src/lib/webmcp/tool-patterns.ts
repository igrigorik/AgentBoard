/**
 * Tool Pattern Registry for Specificity Scoring
 *
 * Maintains a global registry of tool patterns to distinguish injected tools
 * from site-provided tools. Injected tools (in registry) are scored by pattern
 * specificity; site-provided tools (not in registry) get max score.
 *
 * Design: Absence from registry = site-provided = highest relevance signal.
 */

import { COMPILED_TOOLS } from './tools/registry';
import type { ToolSourceType } from './tool-registry';

// Global registry: tool name → match patterns (for INJECTED tools only)
const toolPatterns = new Map<string, string[]>();

// Initialize from COMPILED_TOOLS at module load
for (const tool of COMPILED_TOOLS) {
  toolPatterns.set(tool.id, tool.match);
}

/**
 * Register patterns for a user script.
 * Call when loading user scripts so they get scored properly
 * instead of defaulting to site-provided (100).
 */
export function registerToolPatterns(toolName: string, patterns: string[]): void {
  toolPatterns.set(toolName, patterns);
}

/**
 * Calculate specificity score for any tool.
 *
 * Scoring tiers:
 * - Site-provided (not in registry): 100 (max - site knows best)
 * - Injected with specific pattern: 30-70 (based on literal char count)
 * - System tools: 20
 * - Remote MCP: 10
 */
export function calculateSpecificityScore(toolName: string, source: ToolSourceType): number {
  if (source === 'remote') return 10;
  if (source === 'system') return 20;

  const patterns = toolPatterns.get(toolName);
  if (!patterns) {
    // Not in our registry = site-provided = max score
    return 100;
  }

  // Injected tool: score by literal char count, scaled to 30-70
  const maxLiteralCount = Math.max(
    ...patterns.map((p) => (p === '<all_urls>' ? 0 : p.replace(/\*/g, '').length))
  );
  return 30 + Math.min(40, Math.round((maxLiteralCount * 40) / 30));
}
