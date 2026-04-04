/**
 * Tests for resolveSystemPrompt() — base + custom prompt composition
 *
 * Verifies that the system prompt correctly composes BASE_SYSTEM_PROMPT
 * with the agent's custom instructions (systemPrompt field).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSystemPrompt,
  BASE_SYSTEM_PROMPT,
  type AgentConfig,
} from '../src/lib/storage/config';

function makeAgent(systemPrompt: string): AgentConfig {
  return {
    id: 'test-1',
    name: 'Test Agent',
    provider: 'openai',
    model: 'gpt-4',
    systemPrompt,
    temperature: 0.7,
    maxTokens: 2000,
  };
}

describe('resolveSystemPrompt', () => {
  it('should return BASE_SYSTEM_PROMPT when systemPrompt is empty', () => {
    const result = resolveSystemPrompt(makeAgent(''));
    expect(result).toBe(BASE_SYSTEM_PROMPT);
  });

  it('should return BASE_SYSTEM_PROMPT when systemPrompt is whitespace only', () => {
    const result = resolveSystemPrompt(makeAgent('   \n\t  '));
    expect(result).toBe(BASE_SYSTEM_PROMPT);
  });

  it('should append custom instructions after base prompt', () => {
    const custom = 'You are a helpful coding assistant. Always explain your reasoning.';
    const result = resolveSystemPrompt(makeAgent(custom));

    expect(result).toBe(`${BASE_SYSTEM_PROMPT}\n\n${custom}`);
    expect(result).toContain(BASE_SYSTEM_PROMPT);
    expect(result).toContain(custom);
  });

  it('should trim whitespace from custom instructions', () => {
    const result = resolveSystemPrompt(makeAgent('  custom instructions  '));
    expect(result).toBe(`${BASE_SYSTEM_PROMPT}\n\ncustom instructions`);
  });

  it('should always start with BASE_SYSTEM_PROMPT', () => {
    const result = resolveSystemPrompt(makeAgent('anything'));
    expect(result.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
  });

  it('BASE_SYSTEM_PROMPT should reference <page_context> and <site_tools>', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('<page_context>');
    expect(BASE_SYSTEM_PROMPT).toContain('<site_tools>');
  });

  it('BASE_SYSTEM_PROMPT should contain anti-refusal directive', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('Do not refuse tools listed in <site_tools>');
  });

  it('BASE_SYSTEM_PROMPT should contain delegation language', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('delegated');
    expect(BASE_SYSTEM_PROMPT).toContain('on their behalf');
  });
});
