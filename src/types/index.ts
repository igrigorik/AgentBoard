/**
 * Shared TypeScript type definitions
 */

import type { AgentConfig } from '../lib/storage/config';

// Individual message type interfaces
interface GetConfigMessage {
  type: 'GET_CONFIG';
}

interface SaveConfigMessage {
  type: 'SAVE_CONFIG';
  config: {
    agents?: AgentConfig[];
    providers?: ProviderConfig[];
  };
}

interface TestConnectionMessage {
  type: 'TEST_CONNECTION';
  agentId: string;
}

interface TestNewConnectionMessage {
  type: 'TEST_NEW_CONNECTION';
  agentId: string;
  provider: AIProvider;
  apiKey: string;
  model: string;
  endpoint?: string;
}

interface PingMessage {
  type: 'PING';
}

interface StreamChatMessage {
  type: 'STREAM_CHAT';
  message: string;
  agentId: string;
  conversationId?: string;
}

interface CancelStreamMessage {
  type: 'CANCEL_STREAM';
  connectionId: string;
}

interface ContextSelectionMessage {
  type: 'CONTEXT_SELECTION';
  text: string;
  tabId?: number; // Tab ID to filter messages
}

// Streaming response messages (sent from background to sidebar)
interface StreamChunkMessage {
  type: 'STREAM_CHUNK';
  chunk: string;
  connectionId?: string;
}

interface StreamCompleteMessage {
  type: 'STREAM_COMPLETE';
  fullResponse: string;
  connectionId?: string;
}

interface StreamErrorMessage {
  type: 'STREAM_ERROR';
  error: string;
  connectionId?: string;
}

interface StreamToolCallMessage {
  type: 'STREAM_TOOL_CALL';
  toolCall: ToolCall;
  messageId: string;
  connectionId?: string;
}

interface StreamToolResultMessage {
  type: 'STREAM_TOOL_RESULT';
  toolCallId: string;
  output: unknown;
  status: 'success' | 'error';
  error?: string;
  messageId: string;
  connectionId?: string;
}

interface ExecuteToolMessage {
  type: 'EXECUTE_TOOL';
  payload: ToolExecutionRequest;
}

interface ToolResultMessage {
  type: 'TOOL_RESULT';
  payload: ToolExecutionResult;
}

// WebMCP messages
export interface WebMCPCallToolMessage {
  type: 'WEBMCP_CALL_TOOL';
  tabId?: number;
  toolName: string;
  args?: unknown;
}

export interface WebMCPGetToolsMessage {
  type: 'WEBMCP_GET_TOOLS';
  tabId?: number;
}

export interface WebMCPToolsChangedMessage {
  type: 'WEBMCP_TOOLS_CHANGED';
  tabId: number;
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
  }>;
}

export interface WebMCPScriptsUpdatedMessage {
  type: 'WEBMCP_SCRIPTS_UPDATED';
}

// Union type for all possible extension messages
export type ExtensionMessage =
  | GetConfigMessage
  | SaveConfigMessage
  | TestConnectionMessage
  | TestNewConnectionMessage
  | PingMessage
  | StreamChatMessage
  | CancelStreamMessage
  | ContextSelectionMessage
  | StreamChunkMessage
  | StreamCompleteMessage
  | StreamErrorMessage
  | StreamToolCallMessage
  | StreamToolResultMessage
  | ExecuteToolMessage
  | ToolResultMessage
  | WebMCPCallToolMessage
  | WebMCPGetToolsMessage
  | WebMCPToolsChangedMessage
  | WebMCPScriptsUpdatedMessage;

// Response wrapper for message handlers
export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

// Tool call tracking
export interface ToolCall {
  id: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: 'pending' | 'running' | 'success' | 'error';
  error?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
}

// Chat message types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[]; // Array of tool calls associated with this message
  metadata?: {
    provider?: string;
    model?: string;
    toolName?: string;
    toolResult?: unknown;
    agentId?: string;
    agentName?: string;
  };
}

// Provider types
export type AIProvider = 'openai' | 'anthropic' | 'google';

export interface ProviderConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  endpoint?: string;
}

// Tool types (for MCP integration)
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown; // JSON schema can be any structure
  serverId?: string;
}

export interface ToolExecutionRequest {
  toolName: string;
  input: unknown; // Tool input can be any JSON-serializable value
  messageId: string;
}

export interface ToolExecutionResult {
  toolName: string;
  output: unknown; // Tool output can be any JSON-serializable value
  error?: string;
  duration?: number;
}

// Port message types (for chrome.runtime.connect communication)
// These are different from runtime messages and have different structures
interface PortStreamChatMessage {
  type: 'STREAM_CHAT';
  agentId: string;
  tabId?: number; // The tab this sidebar is associated with (for tool scoping)
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

// Union type for all port messages
export type PortMessage = PortStreamChatMessage;

// Browser API tool types (Phase 4)
export interface BrowserTool {
  name: string;
  description: string;
  permissions: string[];
  execute: (input: unknown) => Promise<unknown>;
}

// JSON-RPC types for WebMCP communication
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface WebMCPMessage {
  type: 'webmcp';
  payload: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
}

export interface ToolsListChangedParams {
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
  }>;
  origin: string;
  timestamp?: number;
}

// Error types
export class ExtensionError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ExtensionError';
  }
}

// Slash command types
export interface SlashCommand {
  name: string; // e.g., "pr-reviewer"
  instructions: string; // Template with $ARGUMENTS placeholder
  isBuiltin: boolean; // true for system commands
  createdAt: number; // timestamp
}

export interface CommandStorage {
  userCommands: SlashCommand[];
}

export type CommandType = 'text' | 'action';

export interface ProcessedCommand {
  type: CommandType;
  content?: string; // For text commands - the expanded template
  action?: () => void; // For action commands - the function to execute
}

// Utility types
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
