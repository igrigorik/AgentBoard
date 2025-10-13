/**
 * Test for agent-centric storage configuration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigStorage, type AgentConfig } from '../src/lib/storage/config';

describe('ConfigStorage', () => {
  let configStorage: ConfigStorage;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Get instance
    configStorage = ConfigStorage.getInstance();
  });

  it('should return default config when storage is empty', async () => {
    // Mock empty storage
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys, callback) => {
      if (callback) callback({});
      return Promise.resolve({});
    });

    const config = await configStorage.get();

    expect(config.agents).toEqual([]);
    expect(config.defaultAgentId).toBeUndefined();
    expect(config.mcpConfig).toBeUndefined();
  });

  it('should return agents from storage', async () => {
    const testAgent: AgentConfig = {
      id: 'test-1',
      name: 'Test Agent',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4',
      systemPrompt: 'Test prompt',
      temperature: 0.7,
      maxTokens: 2000,
    };

    // Mock config with agents
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys, callback) => {
      const result = {
        config: {
          agents: [testAgent],
          defaultAgentId: 'test-1',
        },
      };
      if (callback) callback(result);
      return Promise.resolve(result);
    });

    const config = await configStorage.get();

    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]).toEqual(testAgent);
    expect(config.defaultAgentId).toBe('test-1');
  });

  it('should add new agent', async () => {
    // Mock empty storage initially
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys, callback) => {
      if (callback) callback({});
      return Promise.resolve({});
    });

    const agentData = {
      name: 'Test Agent',
      provider: 'openai' as const,
      apiKey: 'sk-test',
      model: 'gpt-4',
      systemPrompt: 'Test prompt',
      temperature: 0.7,
      maxTokens: 2000,
    };

    const agentId = await configStorage.addAgent(agentData);

    expect(agentId).toBeDefined();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agents: expect.arrayContaining([
          expect.objectContaining({
            id: agentId,
            name: 'Test Agent',
            provider: 'openai',
          }),
        ]),
        defaultAgentId: agentId, // First agent becomes default
      }),
    });
  });

  it('should get agent by ID', async () => {
    const testAgent: AgentConfig = {
      id: 'test-1',
      name: 'Test Agent',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4',
      systemPrompt: 'Test prompt',
      temperature: 0.7,
      maxTokens: 2000,
    };

    // Mock config with agents
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys, callback) => {
      const result = {
        config: {
          agents: [testAgent],
        },
      };
      if (callback) callback(result);
      return Promise.resolve(result);
    });

    const agent = await configStorage.getAgent('test-1');

    expect(agent).toEqual(testAgent);
  });

  it('should return null for non-existent agent', async () => {
    // Mock empty storage
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys, callback) => {
      if (callback) callback({});
      return Promise.resolve({});
    });

    const agent = await configStorage.getAgent('non-existent');

    expect(agent).toBeNull();
  });

  it('should reset to default config', async () => {
    await configStorage.reset();

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agents: [],
        defaultAgentId: undefined,
        mcpConfig: undefined,
      }),
    });
  });

  it('should be a singleton', () => {
    const instance1 = ConfigStorage.getInstance();
    const instance2 = ConfigStorage.getInstance();

    expect(instance1).toBe(instance2);
  });
});
