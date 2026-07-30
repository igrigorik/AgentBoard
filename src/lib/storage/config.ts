/**
 * Configuration storage abstraction
 * Agent-centric configuration for AI assistants
 */

import { isApiProtocol, type ApiProtocol } from '../ai/protocol';
import { migrateAgentToV2 } from './config-migration';
import { runStorageOperation } from './operation-queue';

export const CONFIG_SCHEMA_VERSION = 2 as const;

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
  provider: AIProvider; // Descriptive model metadata; apiProtocol alone selects transport.
  apiKey?: string; // Optional when using custom endpoint/proxy
  model: string;
  endpoint?: string; // Custom API base URL for provider
  apiProtocol: ApiProtocol;
  systemPrompt: string;
  temperature: number;
  maxSteps?: number; // Tool call steps per turn (1-50, default 10)
  isDefault?: boolean;
  reasoning?: ReasoningConfig;
}

export interface StorageConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  agents: AgentConfig[];
  defaultAgentId?: string;
  mcpConfig?: MCPConfig;
  userScripts?: UserScript[]; // WebMCP user-defined tool scripts
  builtinScripts?: BuiltinScript[]; // Built-in tool state (only stores user overrides)
  logLevel?: LogLevel;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPServerConfig {
  transport: 'http'; // Streamable HTTP is the only supported MCP transport.
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
  id: string; // Tool ID: 'agentboard_fetch_url', 'agentboard_youtube_transcript', etc.
  enabled: boolean; // User toggle to enable/disable
  // Future: per-tool configuration (timeouts, limits, etc.)
}

// Default agents to create on first install
export const DEFAULT_AGENTS: Omit<AgentConfig, 'id' | 'apiKey'>[] = [
  {
    name: 'OpenAI Assistant',
    description: 'General purpose assistant powered by OpenAI',
    provider: 'openai',
    apiProtocol: 'openai-responses',
    model: 'gpt-5',
    systemPrompt: '',
    temperature: 0.7,
    maxSteps: 10,
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
    apiProtocol: 'anthropic-messages',
    model: 'claude-opus-4-20250514',
    systemPrompt: '',
    temperature: 0.7,
    maxSteps: 10,
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
    apiProtocol: 'google-generative-ai',
    model: 'gemini-2.5-flash',
    systemPrompt: '',
    temperature: 0.8,
    maxSteps: 10,
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
  schemaVersion: CONFIG_SCHEMA_VERSION,
  agents: [],
  defaultAgentId: undefined,
  mcpConfig: undefined,
  logLevel: 'warn', // Default: balance between feedback and noise
};

export type ConfigValidationErrorCode =
  | 'INVALID_CONFIG'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_AGENT'
  | 'INVALID_REFERENCE'
  | 'INVALID_MCP_CONFIG'
  | 'INVALID_SCRIPT'
  | 'INVALID_LOG_LEVEL';

export class ConfigValidationError extends Error {
  constructor(public readonly code: ConfigValidationErrorCode) {
    super(code);
    this.name = 'ConfigValidationError';
  }
}

export function configValidationMessage(error: unknown): string {
  if (error instanceof ConfigValidationError && error.code === 'UNSUPPORTED_SCHEMA_VERSION') {
    return 'This configuration was created by an unsupported AgentBoard version. Update AgentBoard or restore a compatible backup.';
  }
  return 'AgentBoard configuration is invalid. Restore a compatible backup or reset the settings.';
}

const PROVIDERS: readonly AIProvider[] = ['openai', 'anthropic', 'google'];
const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];

function record(value: unknown, code: ConfigValidationErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigValidationError(code);
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, code: ConfigValidationErrorCode): unknown[] {
  if (!Array.isArray(value)) throw new ConfigValidationError(code);
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new ConfigValidationError(code);
    }
  }
  return value;
}

function requiredString(value: unknown, code: ConfigValidationErrorCode): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigValidationError(code);
  }
}

function requiredHttpUrl(value: unknown, code: ConfigValidationErrorCode): void {
  requiredString(value, code);
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new ConfigValidationError(code);
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new ConfigValidationError(code);
}

function optionalString(
  value: unknown,
  code: ConfigValidationErrorCode
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new ConfigValidationError(code);
}

function optionalBoolean(value: unknown, code: ConfigValidationErrorCode): void {
  if (value !== undefined && typeof value !== 'boolean') throw new ConfigValidationError(code);
}

function finiteNumber(value: unknown, code: ConfigValidationErrorCode): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ConfigValidationError(code);
}

function validateReasoning(value: unknown): void {
  if (value === undefined) return;
  const reasoning = record(value, 'INVALID_AGENT');
  if (typeof reasoning.enabled !== 'boolean') throw new ConfigValidationError('INVALID_AGENT');
  optionalBoolean(reasoning.autoExpand, 'INVALID_AGENT');
  if (reasoning.collapseDelay !== undefined) {
    finiteNumber(reasoning.collapseDelay, 'INVALID_AGENT');
    if (reasoning.collapseDelay < 0) throw new ConfigValidationError('INVALID_AGENT');
  }
  if (reasoning.openai !== undefined) {
    const openai = record(reasoning.openai, 'INVALID_AGENT');
    if (!['minimal', 'low', 'medium', 'high'].includes(openai.reasoningEffort as string)) {
      throw new ConfigValidationError('INVALID_AGENT');
    }
    if (
      openai.reasoningSummary !== undefined &&
      !['auto', 'detailed'].includes(openai.reasoningSummary as string)
    ) {
      throw new ConfigValidationError('INVALID_AGENT');
    }
  }
  if (reasoning.anthropic !== undefined) {
    const anthropic = record(reasoning.anthropic, 'INVALID_AGENT');
    if (anthropic.thinkingBudgetTokens !== undefined) {
      finiteNumber(anthropic.thinkingBudgetTokens, 'INVALID_AGENT');
      if (
        !Number.isInteger(anthropic.thinkingBudgetTokens) ||
        anthropic.thinkingBudgetTokens < 1000 ||
        anthropic.thinkingBudgetTokens > 20000
      ) {
        throw new ConfigValidationError('INVALID_AGENT');
      }
    }
  }
  if (reasoning.google !== undefined) {
    const google = record(reasoning.google, 'INVALID_AGENT');
    if (google.thinkingBudget !== undefined) {
      finiteNumber(google.thinkingBudget, 'INVALID_AGENT');
      if (
        !Number.isInteger(google.thinkingBudget) ||
        google.thinkingBudget < -1 ||
        google.thinkingBudget > 24576
      ) {
        throw new ConfigValidationError('INVALID_AGENT');
      }
    }
    optionalBoolean(google.includeThoughts, 'INVALID_AGENT');
  }
}

function validateAgent(value: unknown): asserts value is AgentConfig {
  const agent = record(value, 'INVALID_AGENT');
  for (const field of ['id', 'name', 'model'] as const)
    requiredString(agent[field], 'INVALID_AGENT');
  if (typeof agent.systemPrompt !== 'string') throw new ConfigValidationError('INVALID_AGENT');
  if (!PROVIDERS.includes(agent.provider as AIProvider) || !isApiProtocol(agent.apiProtocol)) {
    throw new ConfigValidationError('INVALID_AGENT');
  }
  // Provider remains descriptive model metadata. Proxies may legitimately expose a
  // model from one provider through another provider's wire protocol.
  if ('openaiCompatible' in agent) throw new ConfigValidationError('INVALID_AGENT');
  optionalString(agent.description, 'INVALID_AGENT');
  optionalString(agent.apiKey, 'INVALID_AGENT');
  optionalString(agent.endpoint, 'INVALID_AGENT');
  optionalBoolean(agent.isDefault, 'INVALID_AGENT');
  finiteNumber(agent.temperature, 'INVALID_AGENT');
  if (agent.temperature < 0 || agent.temperature > 2) {
    throw new ConfigValidationError('INVALID_AGENT');
  }
  if (agent.maxSteps !== undefined) {
    finiteNumber(agent.maxSteps, 'INVALID_AGENT');
    if (!Number.isInteger(agent.maxSteps) || agent.maxSteps < 1 || agent.maxSteps > 50)
      throw new ConfigValidationError('INVALID_AGENT');
  }
  validateReasoning(agent.reasoning);
}

export function validateStorageConfigV2(value: unknown): StorageConfig {
  const config = record(value, 'INVALID_CONFIG');
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION)
    throw new ConfigValidationError('UNSUPPORTED_SCHEMA_VERSION');
  const agents = denseArray(config.agents, 'INVALID_CONFIG');
  agents.forEach(validateAgent);
  const ids = (agents as AgentConfig[]).map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) throw new ConfigValidationError('INVALID_REFERENCE');
  optionalString(config.defaultAgentId, 'INVALID_REFERENCE');
  if (config.defaultAgentId !== undefined && !ids.includes(config.defaultAgentId))
    throw new ConfigValidationError('INVALID_REFERENCE');

  if (config.mcpConfig !== undefined) {
    const mcp = record(config.mcpConfig, 'INVALID_MCP_CONFIG');
    const servers = record(mcp.mcpServers, 'INVALID_MCP_CONFIG');
    for (const serverValue of Object.values(servers)) {
      const server = record(serverValue, 'INVALID_MCP_CONFIG');
      if (server.transport !== 'http') throw new ConfigValidationError('INVALID_MCP_CONFIG');
      requiredHttpUrl(server.url, 'INVALID_MCP_CONFIG');
      optionalString(server.authToken, 'INVALID_MCP_CONFIG');
    }
  }

  for (const [field, code] of [
    ['userScripts', 'INVALID_SCRIPT'],
    ['builtinScripts', 'INVALID_SCRIPT'],
  ] as const) {
    const scriptValues = config[field];
    if (scriptValues === undefined) continue;
    const scripts = denseArray(scriptValues, code);
    const scriptIds = new Set<string>();
    for (const scriptValue of scripts) {
      const script = record(scriptValue, code);
      requiredString(script.id, code);
      if (scriptIds.has(script.id)) throw new ConfigValidationError(code);
      scriptIds.add(script.id);
      if (typeof script.enabled !== 'boolean') throw new ConfigValidationError(code);
      if (field === 'userScripts' && typeof script.code !== 'string')
        throw new ConfigValidationError(code);
    }
  }
  if (config.logLevel !== undefined && !LOG_LEVELS.includes(config.logLevel as LogLevel))
    throw new ConfigValidationError('INVALID_LOG_LEVEL');
  return config as unknown as StorageConfig;
}

function freshDefaultConfig(): StorageConfig {
  return globalThis.structuredClone(DEFAULT_CONFIG);
}

function canonicalAgent(agent: AgentConfig): AgentConfig {
  const canonical = { ...agent } as AgentConfig & { maxTokens?: unknown };
  delete canonical.maxTokens;
  if (canonical.endpoint?.trim() === '') delete canonical.endpoint;
  return canonical;
}

function canonicalConfig(config: StorageConfig): StorageConfig {
  const cloned = globalThis.structuredClone(config);
  return validateStorageConfigV2({
    ...freshDefaultConfig(),
    ...cloned,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    // Retired v2 fields remain accepted at storage/import boundaries, then are
    // removed from runtime state and future exports without forcing a rewrite.
    agents: cloned.agents.map(canonicalAgent),
  });
}

/** Parse either persisted schema v1 or current schema v2 without mutating the input. */
export function parseStorageConfig(value: unknown): { config: StorageConfig; migrated: boolean } {
  const source = record(value, 'INVALID_CONFIG');
  if ('schemaVersion' in source && source.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigValidationError('UNSUPPORTED_SCHEMA_VERSION');
  }
  if (source.schemaVersion === CONFIG_SCHEMA_VERSION) {
    return { config: canonicalConfig(validateStorageConfigV2(source)), migrated: false };
  }
  const sourceAgents = denseArray(source.agents, 'INVALID_CONFIG');
  let agents: Record<string, unknown>[];
  try {
    agents = sourceAgents.map(migrateAgentToV2);
  } catch {
    throw new ConfigValidationError('INVALID_AGENT');
  }
  const migrated = validateStorageConfigV2({
    ...source,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    agents,
  });
  return { config: canonicalConfig(migrated), migrated: true };
}

export class ConfigStorage {
  private static instance: ConfigStorage;
  private changeOperations: Promise<void> = Promise.resolve();

  static getInstance(): ConfigStorage {
    if (!ConfigStorage.instance) {
      ConfigStorage.instance = new ConfigStorage();
    }
    return ConfigStorage.instance;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    return runStorageOperation(operation);
  }

  private async loadValue(value: unknown): Promise<StorageConfig> {
    if (value === undefined) return freshDefaultConfig();
    const parsed = parseStorageConfig(value);
    if (parsed.migrated) await chrome.storage.local.set({ config: parsed.config });
    return parsed.config;
  }

  private async load(): Promise<StorageConfig> {
    const result = await chrome.storage.local.get(['config']);
    return this.loadValue(result.config);
  }

  private update<T>(mutator: (config: StorageConfig) => T): Promise<T> {
    return this.serialize(async () => {
      const config = globalThis.structuredClone(await this.load());
      const result = mutator(config);
      const validated = canonicalConfig(config);
      await chrome.storage.local.set({ config: validated });
      return result;
    });
  }

  async get(): Promise<StorageConfig> {
    return this.serialize(() => this.load());
  }

  /** Read config and companion keys from one coherent queued storage snapshot. */
  async getSnapshot(keys: string[]): Promise<{
    config: StorageConfig;
    values: Record<string, unknown>;
  }> {
    return this.serialize(async () => {
      const result = await chrome.storage.local.get(['config', ...keys]);
      const config = await this.loadValue(result.config);
      const values: Record<string, unknown> = {};
      for (const key of keys) values[key] = globalThis.structuredClone(result[key]);
      return { config, values };
    });
  }

  async set(config: Partial<StorageConfig>): Promise<void> {
    if (
      Object.prototype.hasOwnProperty.call(config, 'schemaVersion') &&
      config.schemaVersion !== CONFIG_SCHEMA_VERSION
    ) {
      throw new ConfigValidationError('UNSUPPORTED_SCHEMA_VERSION');
    }
    const patch = globalThis.structuredClone(config);
    await this.update((current) => {
      Object.assign(current, patch, { schemaVersion: CONFIG_SCHEMA_VERSION });
    });
  }

  async reset(): Promise<void> {
    await this.serialize(() => chrome.storage.local.set({ config: freshDefaultConfig() }));
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
      return config.agents.find((agent) => agent.id === config.defaultAgentId) || null;
    }

    return config.agents.find((agent) => agent.isDefault) || config.agents[0] || null;
  }

  async addAgent(agent: Omit<AgentConfig, 'id'>): Promise<string> {
    const id = globalThis.crypto.randomUUID();
    await this.update((config) => {
      const newAgent: AgentConfig = { ...agent, id };
      config.agents.push(newAgent);
      if (config.agents.length === 1 || agent.isDefault) {
        config.defaultAgentId = id;
      }
    });
    return id;
  }

  async updateAgent(id: string, updates: Partial<Omit<AgentConfig, 'id'>>): Promise<void> {
    await this.update((config) => {
      const index = config.agents.findIndex((agent) => agent.id === id);
      if (index === -1) throw new Error(`Agent ${id} not found`);

      config.agents[index] = { ...config.agents[index], ...updates };
      if (updates.isDefault) {
        config.agents.forEach((agent) => {
          agent.isDefault = agent.id === id;
        });
        config.defaultAgentId = id;
      }
    });
  }

  async deleteAgent(id: string): Promise<void> {
    await this.update((config) => {
      const index = config.agents.findIndex((agent) => agent.id === id);
      if (index === -1) throw new Error(`Agent ${id} not found`);
      config.agents.splice(index, 1);

      if (config.defaultAgentId === id) {
        const newDefault = config.agents.find((agent) => agent.isDefault) || config.agents[0];
        config.defaultAgentId = newDefault?.id;
      }
    });
  }

  async setDefaultAgent(id: string): Promise<void> {
    await this.update((config) => {
      if (!config.agents.some((agent) => agent.id === id)) {
        throw new Error(`Agent ${id} not found`);
      }
      config.agents.forEach((agent) => {
        agent.isDefault = agent.id === id;
      });
      config.defaultAgentId = id;
    });
  }

  // Listen for config changes
  onChange(
    callback: (config: StorageConfig) => void | Promise<void>,
    onError?: (error: ConfigValidationError) => void
  ): void {
    const reportError = (error: unknown) => {
      const sanitized =
        error instanceof ConfigValidationError
          ? error
          : new ConfigValidationError('INVALID_CONFIG');
      if (!onError) {
        console.error(`[ConfigStorage] Config change rejected: ${sanitized.code}`);
        return;
      }
      try {
        onError(sanitized);
      } catch {
        console.error('[ConfigStorage] Config change error handler failed');
      }
    };
    const notify = (config: StorageConfig) => {
      const operation = this.changeOperations.then(() =>
        callback(globalThis.structuredClone(config))
      );
      this.changeOperations = operation.then(
        () => undefined,
        (error) => reportError(error)
      );
    };

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.config) return;
      if (changes.config.newValue === undefined) {
        notify(freshDefaultConfig());
        return;
      }

      try {
        const parsed = parseStorageConfig(changes.config.newValue);
        if (parsed.migrated) {
          // Do not expose migrated state until the complete v2 value is durable. The
          // resulting v2 storage event invokes the callback after the write succeeds.
          void this.get().catch(reportError);
          return;
        }
        notify(parsed.config);
      } catch (error) {
        reportError(error);
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
    const id = globalThis.crypto.randomUUID();
    await this.update((config) => {
      config.userScripts ??= [];
      config.userScripts.push({ id, code, enabled });
    });
    return id;
  }

  async updateUserScript(id: string, updates: Partial<Omit<UserScript, 'id'>>): Promise<void> {
    await this.update((config) => {
      const scripts = config.userScripts ?? [];
      const index = scripts.findIndex((script) => script.id === id);
      if (index === -1) throw new Error(`User script ${id} not found`);
      scripts[index] = { ...scripts[index], ...updates };
      config.userScripts = scripts;
    });
  }

  async deleteUserScript(id: string): Promise<void> {
    await this.update((config) => {
      const scripts = config.userScripts ?? [];
      const index = scripts.findIndex((script) => script.id === id);
      if (index === -1) throw new Error(`User script ${id} not found`);
      scripts.splice(index, 1);
      config.userScripts = scripts;
    });
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
    await this.update((config) => {
      config.builtinScripts ??= [];
      const existing = config.builtinScripts.find((script) => script.id === id);
      if (existing) {
        existing.enabled = enabled;
      } else {
        config.builtinScripts.push({ id, enabled });
      }
    });
  }
}
