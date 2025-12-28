import { describe, it, expect } from 'vitest';
import { calculateSpecificityScore, registerToolPatterns } from '../src/lib/webmcp/tool-patterns';

describe('tool-patterns', () => {
  describe('calculateSpecificityScore', () => {
    describe('source-based scoring', () => {
      it('returns 10 for remote MCP tools', () => {
        expect(calculateSpecificityScore('any_tool', 'remote')).toBe(10);
      });

      it('returns 20 for system tools', () => {
        expect(calculateSpecificityScore('fetch_url', 'system')).toBe(20);
      });
    });

    describe('site-provided tools (not in registry)', () => {
      it('returns 100 for tools not in pattern registry', () => {
        // This tool is not registered, so it's treated as site-provided
        expect(calculateSpecificityScore('slack_context', 'site')).toBe(100);
        expect(calculateSpecificityScore('google_docs_tool', 'site')).toBe(100);
      });
    });

    describe('injected tools (in COMPILED_TOOLS registry)', () => {
      it('scores agentboard_youtube_transcript high (~65) due to specific pattern', () => {
        // Pattern: *://www.youtube.com/watch* has 26 literal chars
        const score = calculateSpecificityScore('agentboard_youtube_transcript', 'site');
        expect(score).toBeGreaterThan(60);
        expect(score).toBeLessThan(70);
      });

      it('scores agentboard_page_info low (30) due to <all_urls> pattern', () => {
        // Pattern: <all_urls> has 0 literal chars
        const score = calculateSpecificityScore('agentboard_page_info', 'site');
        expect(score).toBe(30);
      });

      it('scores agentboard_dom_readability low (30) due to <all_urls> pattern', () => {
        const score = calculateSpecificityScore('agentboard_dom_readability', 'site');
        expect(score).toBe(30);
      });

      it('scores agentboard_dom_query low (30) due to <all_urls> pattern', () => {
        const score = calculateSpecificityScore('agentboard_dom_query', 'site');
        expect(score).toBe(30);
      });
    });

    describe('user script patterns (registered at runtime)', () => {
      it('scores user scripts based on their registered patterns', () => {
        // Register a user script with a specific pattern
        registerToolPatterns('my_youtube_helper', ['*://youtube.com/*']);

        const score = calculateSpecificityScore('my_youtube_helper', 'site');
        // Pattern has ~15 literal chars, should score ~50
        expect(score).toBeGreaterThan(45);
        expect(score).toBeLessThan(55);
      });

      it('scores user scripts with <all_urls> as 30', () => {
        registerToolPatterns('my_generic_tool', ['<all_urls>']);

        const score = calculateSpecificityScore('my_generic_tool', 'site');
        expect(score).toBe(30);
      });
    });

    describe('relative ordering', () => {
      it('orders tools correctly: site-provided > specific injected > generic injected > system > remote', () => {
        // Register user scripts with different specificity levels
        registerToolPatterns('user_medium', ['*://*.example.com/*']); // ~15 literal chars

        const siteProvided = calculateSpecificityScore('unknown_site_tool', 'site');
        const youtubeTranscript = calculateSpecificityScore(
          'agentboard_youtube_transcript',
          'site'
        );
        const userMedium = calculateSpecificityScore('user_medium', 'site');
        const genericInjected = calculateSpecificityScore('agentboard_page_info', 'site');
        const system = calculateSpecificityScore('fetch_url', 'system');
        const remote = calculateSpecificityScore('mcp_tool', 'remote');

        // Site-provided (100) > youtube_transcript (~65) > user_medium (~50) > generic (30) > system (20) > remote (10)
        expect(siteProvided).toBe(100);
        expect(youtubeTranscript).toBeGreaterThan(userMedium);
        expect(userMedium).toBeGreaterThan(genericInjected);
        expect(genericInjected).toBeGreaterThan(system);
        expect(system).toBeGreaterThan(remote);
      });

      it('sorts tools in correct order when collected', () => {
        // Simulate what getToolsForTab does
        const tools = [
          { name: 'remote_tool', source: 'remote' as const },
          { name: 'fetch_url', source: 'system' as const },
          { name: 'agentboard_page_info', source: 'site' as const },
          { name: 'agentboard_youtube_transcript', source: 'site' as const },
          { name: 'site_tool', source: 'site' as const }, // Not in registry = site-provided
        ];

        const scored = tools.map((t) => ({
          name: t.name,
          score: calculateSpecificityScore(t.name, t.source),
        }));

        scored.sort((a, b) => b.score - a.score);

        const names = scored.map((t) => t.name);
        expect(names[0]).toBe('site_tool'); // 100
        expect(names[1]).toBe('agentboard_youtube_transcript'); // ~65
        expect(names[2]).toBe('agentboard_page_info'); // 30
        expect(names[3]).toBe('fetch_url'); // 20
        expect(names[4]).toBe('remote_tool'); // 10
      });
    });
  });
});
