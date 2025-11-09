/**
 * Provider inference and utility functions
 *
 * Simple prefix-based provider detection without hardcoded model lists
 */

import type { AIProvider } from '../../types';

/**
 * Infer the AI provider from a model name using simple prefix checks
 *
 * @param model - The model name
 * @returns The inferred provider, defaults to 'openai' for unknown models
 */
export function inferProviderFromModel(model: string): AIProvider {
  const modelLower = model.toLowerCase();

  // Simple prefix checks - no hardcoded model versions
  if (modelLower.startsWith('claude')) {
    return 'anthropic';
  }

  if (
    modelLower.startsWith('gpt') ||
    modelLower.startsWith('o1') ||
    modelLower.startsWith('o3') ||
    modelLower.startsWith('dall-e') ||
    modelLower.startsWith('chatgpt')
  ) {
    return 'openai';
  }

  if (
    modelLower.startsWith('gemini') ||
    modelLower.startsWith('bison') ||
    modelLower.startsWith('palm')
  ) {
    return 'google';
  }

  // Default to OpenAI - most custom/open models use OpenAI-compatible APIs
  return 'openai';
}

/**
 * Get provider display name
 * @param provider - The provider ID
 * @returns Display name
 */
export function getProviderDisplay(provider: AIProvider): { name: string; icon: string } {
  switch (provider) {
    case 'anthropic':
      return { name: 'Anthropic', icon: '' };
    case 'openai':
      return { name: 'OpenAI', icon: '' };
    case 'google':
      return { name: 'Google', icon: '' };
    default:
      return { name: provider, icon: '' };
  }
}

/**
 * Check if an endpoint URL looks like an OpenAI-compatible format
 * Simple heuristics for smart defaults
 *
 * @param endpoint - The endpoint URL
 * @returns true if likely OpenAI-compatible
 */
export function isLikelyOpenAICompatible(endpoint: string): boolean {
  if (!endpoint) return false;

  const endpointLower = endpoint.toLowerCase();

  // Common OpenAI-compatible patterns
  if (endpointLower.includes('/v1')) return true;

  // Native provider endpoints (NOT OpenAI-compatible)
  if (endpointLower.includes('/vendors/')) return false;
  if (endpointLower.includes('anthropic.com')) return false;
  if (endpointLower.includes('googleapis.com')) return false;

  // Default to true - most proxies are OpenAI-compatible
  return true;
}
