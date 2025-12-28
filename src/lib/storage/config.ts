/**
 * Configuration storage abstraction
 * Agent-centric configuration for AI assistants
 */

export type AIProvider = 'openai' | 'anthropic' | 'google';

export interface ReasoningConfig {
  enabled: boolean;
  openai?: {
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
    reasoningSummary?: 'auto' | 'detailed';
  };
  anthropic?: {
    thinkingBudgetTokens?: number; // 1000-20000 for Claude 4 models
  };
  google?: {
    thinkingBudget?: number; // 0-24576 for Flash, dynamic (-1) for Pro
    includeThoughts?: boolean; // Whether to include thought summaries
  };
  autoExpand?: boolean; // Auto-expand reasoning when it starts streaming
  collapseDelay?: number; // Ms to wait before auto-collapsing (default: 3000)
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  provider: AIProvider;
  apiKey?: string; // Optional when using custom endpoint/proxy
  model: string;
  endpoint?: string; // Custom API base URL for provider
  openaiCompatible?: boolean; // When using endpoint: true = OpenAI format, false = native format
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  isDefault?: boolean;
  reasoning?: ReasoningConfig;
}

export interface StorageConfig {
  agents: AgentConfig[];
  defaultAgentId?: string;
  mcpConfig?: MCPConfig;
  userScripts?: UserScript[]; // WebMCP user-defined tool scripts
  builtinScripts?: BuiltinScript[]; // Built-in tool state (only stores user overrides)
  logLevel?: string; // Global log level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPServerConfig {
  transport: 'http' | 'sse';
  url: string;
  authToken?: string;
}

// WebMCP User Script configuration
export interface UserScript {
  id: string; // Generated UUID
  code: string; // Full script including pragma and exports
  enabled: boolean; // User toggle to enable/disable
  // All metadata (name, description, version, match, exclude, etc.)
  // is parsed from exported metadata at runtime
}

export interface UserScriptMetadata {
  name: string; // Required: unique identifier (snake_case)
  namespace: string; // Required: vendor/author namespace (snake_case)
  version: string; // Required: semver string
  description?: string; // Optional: shown in UI/LLM
  match: string | string[]; // Required: URL patterns
  exclude?: string | string[]; // Optional: exclude patterns
  inputSchema?: Record<string, unknown>; // Optional: JSON Schema for tool args
}

// Built-in tool state configuration
// Stores user preferences for pre-compiled system and WebMCP tools
export interface BuiltinScript {
  id: string; // Tool ID: 'agentboard_fetch_url', 'agentboard_dom_query', etc.
  enabled: boolean; // User toggle to enable/disable
  // Future: per-tool configuration (timeouts, limits, etc.)
}

/**
 * Base system prompt for browser copilot functionality.
 * Provides tool selection guidance and grounds model in page context.
 */
const BASE_SYSTEM_PROMPT = `You are a browser copilot with visual and tool access to the current tab.

Each message includes <page_context> with the current URL and title.

TOOL SELECTION:
Tools are filtered by URL and ordered by relevance (most specific first).
Tool names reflect their target site - match against <page_context> URL.
Prefer site-specific tools over generic ones (agentboard_*).

Ground responses in acquired context. Never hallucinate page content.`;

// Default agents to create on first install
export const DEFAULT_AGENTS: Omit<AgentConfig, 'id' | 'apiKey'>[] = [
  {
    name: 'OpenAI Assistant',
    description: 'General purpose assistant powered by OpenAI',
    provider: 'openai',
    model: 'gpt-5',
    systemPrompt: BASE_SYSTEM_PROMPT,
    temperature: 0.7,
    maxTokens: 4000,
    isDefault: true,
    reasoning: {
      enabled: true,
      openai: {
        reasoningEffort: 'medium',
      },
    },
  },
  {
    name: 'Claude Assistant',
    description: 'Thoughtful assistant powered by Anthropic',
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    systemPrompt: BASE_SYSTEM_PROMPT,
    temperature: 0.7,
    maxTokens: 4096,
    reasoning: {
      enabled: true,
      anthropic: {
        thinkingBudgetTokens: 12000,
      },
    },
  },
  {
    name: 'Gemini Assistant',
    description: 'Creative assistant powered by Google',
    provider: 'google',
    model: 'gemini-2.5-flash',
    systemPrompt: BASE_SYSTEM_PROMPT,
    temperature: 0.8,
    maxTokens: 2048,
    reasoning: {
      enabled: true,
      google: {
        thinkingBudget: 8192,
        includeThoughts: true,
      },
    },
  },
];

// Single source of truth for default configuration
export const DEFAULT_CONFIG: StorageConfig = {
  agents: [],
  defaultAgentId: undefined,
  mcpConfig: undefined,
  logLevel: 'warn', // Default: balance between feedback and noise
};

export class ConfigStorage {
  private static instance: ConfigStorage;

  static getInstance(): ConfigStorage {
    if (!ConfigStorage.instance) {
      ConfigStorage.instance = new ConfigStorage();
    }
    return ConfigStorage.instance;
  }

  async get(): Promise<StorageConfig> {
    const result = await chrome.storage.local.get(['config']);
    if (!result.config || !result.config.agents) {
      return DEFAULT_CONFIG;
    }

    return {
      ...DEFAULT_CONFIG,
      ...result.config,
    };
  }

  async set(config: Partial<StorageConfig>): Promise<void> {
    const current = await this.get();
    const updated = { ...current, ...config };
    await chrome.storage.local.set({ config: updated });
  }

  async reset(): Promise<void> {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }

  // Agent management methods
  async getAgents(): Promise<AgentConfig[]> {
    const config = await this.get();
    return config.agents || [];
  }

  async getAgent(id: string): Promise<AgentConfig | null> {
    const agents = await this.getAgents();
    return agents.find((agent) => agent.id === id) || null;
  }

  async getDefaultAgent(): Promise<AgentConfig | null> {
    const config = await this.get();
    if (config.defaultAgentId) {
      return this.getAgent(config.defaultAgentId);
    }

    // Fall back to first agent with isDefault flag
    const agents = await this.getAgents();
    return agents.find((agent) => agent.isDefault) || agents[0] || null;
  }

  async addAgent(agent: Omit<AgentConfig, 'id'>): Promise<string> {
    const agents = await this.getAgents();
    const id = globalThis.crypto.randomUUID();
    const newAgent: AgentConfig = { ...agent, id };

    // If this is the first agent or marked as default, make it the default
    let defaultAgentId: string | undefined;
    if (agents.length === 0 || agent.isDefault) {
      defaultAgentId = id;
    }

    await this.set({
      agents: [...agents, newAgent],
      ...(defaultAgentId ? { defaultAgentId } : {}),
    });

    return id;
  }

  async updateAgent(id: string, updates: Partial<Omit<AgentConfig, 'id'>>): Promise<void> {
    const agents = await this.getAgents();
    const index = agents.findIndex((agent) => agent.id === id);

    if (index === -1) {
      throw new Error(`Agent ${id} not found`);
    }

    agents[index] = { ...agents[index], ...updates };

    // Handle default agent updates
    let defaultAgentId: string | undefined;
    if (updates.isDefault) {
      // Clear other default flags
      agents.forEach((agent) => {
        if (agent.id !== id) {
          agent.isDefault = false;
        }
      });
      defaultAgentId = id;
    }

    await this.set({
      agents,
      ...(defaultAgentId ? { defaultAgentId } : {}),
    });
  }

  async deleteAgent(id: string): Promise<void> {
    const agents = await this.getAgents();
    const filteredAgents = agents.filter((agent) => agent.id !== id);

    if (filteredAgents.length === agents.length) {
      throw new Error(`Agent ${id} not found`);
    }

    const config = await this.get();
    let defaultAgentId = config.defaultAgentId;

    // If we deleted the default agent, pick a new one
    if (defaultAgentId === id) {
      const newDefault = filteredAgents.find((agent) => agent.isDefault) || filteredAgents[0];
      defaultAgentId = newDefault?.id;
    }

    await this.set({
      agents: filteredAgents,
      defaultAgentId,
    });
  }

  async setDefaultAgent(id: string): Promise<void> {
    const agents = await this.getAgents();
    const agent = agents.find((a) => a.id === id);

    if (!agent) {
      throw new Error(`Agent ${id} not found`);
    }

    // Update isDefault flags
    agents.forEach((a) => {
      a.isDefault = a.id === id;
    });

    await this.set({
      agents,
      defaultAgentId: id,
    });
  }

  // Listen for config changes
  onChange(callback: (config: StorageConfig) => void): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.config) {
        callback(changes.config.newValue);
      }
    });
  }

  // User Script management methods
  async getUserScripts(): Promise<UserScript[]> {
    const config = await this.get();
    return config.userScripts || [];
  }

  async getUserScript(id: string): Promise<UserScript | null> {
    const scripts = await this.getUserScripts();
    return scripts.find((script) => script.id === id) || null;
  }

  async addUserScript(code: string, enabled = true): Promise<string> {
    const scripts = await this.getUserScripts();
    const id = globalThis.crypto.randomUUID();
    const newScript: UserScript = { id, code, enabled };

    await this.set({
      userScripts: [...scripts, newScript],
    });

    return id;
  }

  async updateUserScript(id: string, updates: Partial<Omit<UserScript, 'id'>>): Promise<void> {
    const scripts = await this.getUserScripts();
    const index = scripts.findIndex((script) => script.id === id);

    if (index === -1) {
      throw new Error(`User script ${id} not found`);
    }

    scripts[index] = { ...scripts[index], ...updates };

    await this.set({ userScripts: scripts });
  }

  async deleteUserScript(id: string): Promise<void> {
    const scripts = await this.getUserScripts();
    const filteredScripts = scripts.filter((script) => script.id !== id);

    if (filteredScripts.length === scripts.length) {
      throw new Error(`User script ${id} not found`);
    }

    await this.set({ userScripts: filteredScripts });
  }

  async toggleUserScript(id: string, enabled: boolean): Promise<void> {
    await this.updateUserScript(id, { enabled });
  }

  // Built-in Script management methods
  async getBuiltinScripts(): Promise<BuiltinScript[]> {
    const config = await this.get();
    return config.builtinScripts || [];
  }

  async getBuiltinScript(id: string): Promise<BuiltinScript | null> {
    const scripts = await this.getBuiltinScripts();
    return scripts.find((script) => script.id === id) || null;
  }

  /**
   * Check if a built-in tool is enabled
   * Default: true (enabled) if no entry exists
   */
  async isBuiltinToolEnabled(id: string): Promise<boolean> {
    const script = await this.getBuiltinScript(id);
    return script?.enabled ?? true; // Default: enabled
  }

  /**
   * Toggle a built-in tool on/off
   * Creates entry if it doesn't exist (sparse storage)
   */
  async toggleBuiltinScript(id: string, enabled: boolean): Promise<void> {
    const scripts = await this.getBuiltinScripts();
    const existingIndex = scripts.findIndex((s) => s.id === id);

    if (existingIndex >= 0) {
      scripts[existingIndex].enabled = enabled;
    } else {
      // Create new entry for user override
      scripts.push({ id, enabled });
    }

    await this.set({ builtinScripts: scripts });
  }
}
