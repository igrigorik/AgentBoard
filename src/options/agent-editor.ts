import { providerForApiProtocol, type ApiProtocol } from '../lib/ai/protocol';
import type { AgentConfig, ReasoningConfig } from '../lib/storage/config';
import {
  protocolForConnectionApi,
  type ConnectionApi,
  type OpenAIApiProtocol,
} from './agent-protocol';

export type AgentDraft = Omit<AgentConfig, 'id' | 'provider'>;

export interface AgentEditorState {
  name: string;
  description: string;
  apiProtocol: ApiProtocol;
  /** Hidden OpenAI state is explicit so a non-OpenAI agent never inherits a prior edit. */
  openAIProtocol: OpenAIApiProtocol;
  model: string;
  endpoint: string;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  maxSteps: number;
  isDefault: boolean;
  reasoning: {
    enabled: boolean;
    openAIEffort: 'minimal' | 'low' | 'medium' | 'high';
    openAISummary: 'auto' | 'detailed';
    anthropicBudget: number;
    googleBudget: number;
    googleIncludeThoughts: boolean;
    autoExpand: boolean;
  };
}

const DEFAULT_EDITOR_STATE: AgentEditorState = {
  name: '',
  description: '',
  apiProtocol: 'openai-responses',
  openAIProtocol: 'openai-responses',
  model: '',
  endpoint: '',
  apiKey: '',
  systemPrompt: '',
  temperature: 0.7,
  maxSteps: 10,
  isDefault: false,
  reasoning: {
    enabled: false,
    openAIEffort: 'medium',
    openAISummary: 'auto',
    anthropicBudget: 12000,
    googleBudget: 8192,
    googleIncludeThoughts: true,
    autoExpand: true,
  },
};

export function defaultAgentEditorState(): AgentEditorState {
  return globalThis.structuredClone(DEFAULT_EDITOR_STATE);
}

/** Convert a persisted agent into a complete editor state with no inherited DOM values. */
export function agentToEditorState(agent: AgentConfig): AgentEditorState {
  const state = defaultAgentEditorState();
  state.name = agent.name;
  state.description = agent.description ?? '';
  state.apiProtocol = agent.apiProtocol;
  state.openAIProtocol =
    agent.apiProtocol === 'openai-responses' || agent.apiProtocol === 'openai-chat-completions'
      ? agent.apiProtocol
      : 'openai-responses';
  state.model = agent.model;
  state.endpoint = agent.endpoint ?? '';
  state.apiKey = agent.apiKey ?? '';
  state.systemPrompt = agent.systemPrompt;
  state.temperature = agent.temperature;
  state.maxSteps = agent.maxSteps ?? 10;
  state.isDefault = agent.isDefault ?? false;
  state.reasoning = {
    enabled: agent.reasoning?.enabled ?? false,
    openAIEffort: agent.reasoning?.openai?.reasoningEffort ?? 'medium',
    openAISummary: agent.reasoning?.openai?.reasoningSummary ?? 'auto',
    anthropicBudget: agent.reasoning?.anthropic?.thinkingBudgetTokens ?? 12000,
    googleBudget: agent.reasoning?.google?.thinkingBudget ?? 8192,
    googleIncludeThoughts: agent.reasoning?.google?.includeThoughts ?? true,
    autoExpand: agent.reasoning?.autoExpand ?? true,
  };
  return state;
}

function requiredControl<T extends HTMLElement>(form: HTMLFormElement, id: string): T {
  const control = form.querySelector<T>(`#${id}`);
  if (!control) throw new Error(`Agent editor control not found: ${id}`);
  return control;
}

function setValue(form: HTMLFormElement, id: string, value: string): void {
  requiredControl<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(form, id).value =
    value;
}

function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

function selectedApiProtocol(data: FormData): ApiProtocol {
  const connectionApi = formString(data, 'connectionApi') as ConnectionApi;
  switch (connectionApi) {
    case 'anthropic':
    case 'google':
      return protocolForConnectionApi(connectionApi);
    case 'openai': {
      const mode = formString(data, 'openAIProtocol');
      if (mode !== 'openai-responses' && mode !== 'openai-chat-completions') {
        throw new Error('Invalid OpenAI API mode');
      }
      return protocolForConnectionApi('openai', mode);
    }
    default:
      throw new Error('Invalid Connection API selection');
  }
}

function collectReasoning(data: FormData, apiProtocol: ApiProtocol): ReasoningConfig | undefined {
  if (!data.has('reasoningEnabled')) return undefined;

  const reasoning: ReasoningConfig = {
    enabled: true,
    autoExpand: data.has('reasoningAutoExpand'),
  };

  switch (providerForApiProtocol(apiProtocol)) {
    case 'openai':
      reasoning.openai = {
        reasoningEffort: formString(data, 'reasoningEffort') as
          | 'minimal'
          | 'low'
          | 'medium'
          | 'high',
        ...(apiProtocol === 'openai-responses' && {
          reasoningSummary: formString(data, 'reasoningSummary') as 'auto' | 'detailed',
        }),
      };
      break;
    case 'anthropic':
      reasoning.anthropic = {
        thinkingBudgetTokens: Number.parseInt(formString(data, 'anthropicThinkingBudget'), 10),
      };
      break;
    case 'google':
      reasoning.google = {
        thinkingBudget: Number.parseInt(formString(data, 'googleThinkingBudget'), 10),
        includeThoughts: data.has('googleIncludeThoughts'),
      };
      break;
  }

  return reasoning;
}

/** Save and Test Connection both consume this one canonical form interpretation. */
export function readAgentDraft(form: HTMLFormElement): AgentDraft {
  const data = new FormData(form);
  const apiProtocol = selectedApiProtocol(data);
  const description = formString(data, 'description').trim();
  const apiKey = formString(data, 'apiKey').trim();
  const endpoint = formString(data, 'endpoint').trim();

  return {
    name: formString(data, 'name').trim(),
    // updateAgent() shallow-merges drafts, so explicit undefined is required to
    // clear values that existed in the persisted agent.
    description: description || undefined,
    apiKey: apiKey || undefined,
    model: formString(data, 'model').trim(),
    endpoint: endpoint || undefined,
    apiProtocol,
    systemPrompt: formString(data, 'systemPrompt'),
    temperature: Number.parseFloat(formString(data, 'temperature')),
    maxSteps: Number.parseInt(formString(data, 'maxSteps'), 10),
    isDefault: data.has('isDefault'),
    reasoning: collectReasoning(data, apiProtocol),
  };
}

function updateApiKeyRequirement(form: HTMLFormElement): void {
  const endpoint = requiredControl<HTMLInputElement>(form, 'agent-endpoint').value.trim();
  const apiKey = requiredControl<HTMLInputElement>(form, 'agent-api-key');
  const requiredMarker = requiredControl<HTMLElement>(form, 'agent-api-key-required');
  const hint = requiredControl<HTMLElement>(form, 'agent-api-key-hint');

  apiKey.required = !endpoint;
  requiredMarker.classList.toggle('hidden', Boolean(endpoint));
  hint.textContent = endpoint
    ? 'Optional only if this endpoint accepts requests without an API key.'
    : 'Required for direct provider connections.';
  hint.className = 'api-key-hint';
}

function updateDerivedVisibility(form: HTMLFormElement): void {
  const data = new FormData(form);
  const apiProtocol = selectedApiProtocol(data);
  const connectionApi = providerForApiProtocol(apiProtocol);
  const reasoningEnabled = data.has('reasoningEnabled');

  requiredControl<HTMLElement>(form, 'openai-api-mode-group').classList.toggle(
    'hidden',
    connectionApi !== 'openai'
  );
  requiredControl<HTMLElement>(form, 'reasoning-settings').classList.toggle(
    'hidden',
    !reasoningEnabled
  );

  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    requiredControl<HTMLElement>(form, `reasoning-${provider}`).classList.toggle(
      'hidden',
      provider !== connectionApi
    );
  }
  requiredControl<HTMLElement>(form, 'reasoning-summary-group').classList.toggle(
    'hidden',
    apiProtocol !== 'openai-responses'
  );
}

export function refreshAgentEditor(form: HTMLFormElement): void {
  updateApiKeyRequirement(form);
  updateDerivedVisibility(form);
}

/** Render every persisted and hidden field before exposing the editor. */
export function renderAgentEditor(form: HTMLFormElement, state: AgentEditorState): void {
  form.reset();
  setValue(form, 'agent-name', state.name);
  setValue(form, 'agent-description', state.description);
  setValue(form, 'agent-connection-api', providerForApiProtocol(state.apiProtocol));
  setValue(form, 'agent-openai-api-mode', state.openAIProtocol);
  setValue(form, 'agent-model', state.model);
  setValue(form, 'agent-endpoint', state.endpoint);
  setValue(form, 'agent-api-key', state.apiKey);
  setValue(form, 'agent-system-prompt', state.systemPrompt);
  setValue(form, 'agent-temperature', state.temperature.toString());
  setValue(form, 'agent-max-steps', state.maxSteps.toString());
  requiredControl<HTMLInputElement>(form, 'agent-is-default').checked = state.isDefault;

  requiredControl<HTMLInputElement>(form, 'reasoning-enabled').checked = state.reasoning.enabled;
  setValue(form, 'reasoning-effort', state.reasoning.openAIEffort);
  setValue(form, 'reasoning-summary', state.reasoning.openAISummary);
  setValue(form, 'thinking-budget', state.reasoning.anthropicBudget.toString());
  setValue(form, 'thinking-budget-google', state.reasoning.googleBudget.toString());
  requiredControl<HTMLInputElement>(form, 'include-thoughts').checked =
    state.reasoning.googleIncludeThoughts;
  requiredControl<HTMLInputElement>(form, 'reasoning-auto-expand').checked =
    state.reasoning.autoExpand;

  refreshAgentEditor(form);
}

export function initializeAgentEditor(form: HTMLFormElement): void {
  requiredControl<HTMLInputElement>(form, 'agent-endpoint').addEventListener('input', () =>
    updateApiKeyRequirement(form)
  );
  requiredControl<HTMLSelectElement>(form, 'agent-connection-api').addEventListener('change', () =>
    updateDerivedVisibility(form)
  );
  requiredControl<HTMLSelectElement>(form, 'agent-openai-api-mode').addEventListener('change', () =>
    updateDerivedVisibility(form)
  );
  requiredControl<HTMLInputElement>(form, 'reasoning-enabled').addEventListener('change', () =>
    updateDerivedVisibility(form)
  );
}

export function setAgentEditorBusy(form: HTMLFormElement, busy: boolean): void {
  form
    .querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >('input, select, textarea')
    .forEach((control) => {
      control.disabled = busy;
    });
  form.ownerDocument
    .querySelectorAll<HTMLButtonElement>('#agent-modal .modal-footer button')
    .forEach((button) => {
      button.disabled = busy;
    });
}
