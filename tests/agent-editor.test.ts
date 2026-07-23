import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/lib/storage/config';
import {
  agentToEditorState,
  defaultAgentEditorState,
  initializeAgentEditor,
  readAgentDraft,
  renderAgentEditor,
} from '../src/options/agent-editor';

const optionsHTML = readFileSync('src/options/index.html', 'utf8');

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    provider: 'openai',
    apiProtocol: 'openai-responses',
    model: 'opaque-model',
    apiKey: 'secret-key',
    systemPrompt: '',
    temperature: 0.7,
    ...overrides,
  };
}

function form(): HTMLFormElement {
  const value = document.getElementById('agent-form');
  if (!(value instanceof HTMLFormElement)) throw new Error('Agent form missing from fixture');
  return value;
}

beforeEach(() => {
  const parsed = new DOMParser().parseFromString(optionsHTML, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  initializeAgentEditor(form());
});

describe('agent editor state projection', () => {
  it('renders and reads every current agent field through one canonical form path', () => {
    const source = agent({
      name: 'Legacy proxy agent',
      description: 'Uses a compatibility endpoint',
      apiProtocol: 'openai-chat-completions',
      endpoint: 'https://proxy.example.test/v1',
      apiKey: undefined,
      systemPrompt: 'Be concise.',
      temperature: 0.2,
      maxSteps: 7,
      isDefault: true,
      reasoning: {
        enabled: true,
        openai: { reasoningEffort: 'high' },
        autoExpand: false,
      },
    });

    renderAgentEditor(form(), agentToEditorState(source));
    const draft = readAgentDraft(form());

    expect(draft).toEqual({
      name: 'Legacy proxy agent',
      description: 'Uses a compatibility endpoint',
      apiKey: undefined,
      model: 'opaque-model',
      endpoint: 'https://proxy.example.test/v1',
      apiProtocol: 'openai-chat-completions',
      systemPrompt: 'Be concise.',
      temperature: 0.2,
      maxSteps: 7,
      isDefault: true,
      reasoning: {
        enabled: true,
        autoExpand: false,
        openai: { reasoningEffort: 'high' },
      },
    });
    expect((document.getElementById('agent-api-key') as HTMLInputElement).required).toBe(false);
  });

  it('emits explicit undefined values so edits can clear optional persisted fields', () => {
    renderAgentEditor(
      form(),
      agentToEditorState(
        agent({
          description: 'Remove me',
          endpoint: 'https://proxy.example.test/v1',
          apiKey: 'remove-me',
        })
      )
    );
    (document.getElementById('agent-description') as HTMLInputElement).value = '';
    (document.getElementById('agent-endpoint') as HTMLInputElement).value = '';
    (document.getElementById('agent-api-key') as HTMLInputElement).value = '';

    const draft = readAgentDraft(form());

    expect(Object.hasOwn(draft, 'description')).toBe(true);
    expect(Object.hasOwn(draft, 'endpoint')).toBe(true);
    expect(Object.hasOwn(draft, 'apiKey')).toBe(true);
    expect(draft).toMatchObject({
      description: undefined,
      endpoint: undefined,
      apiKey: undefined,
    });
  });

  it('does not carry hidden legacy Chat state into a non-OpenAI agent', () => {
    renderAgentEditor(
      form(),
      agentToEditorState(agent({ apiProtocol: 'openai-chat-completions' }))
    );
    expect((document.getElementById('agent-openai-api-mode') as HTMLSelectElement).value).toBe(
      'openai-chat-completions'
    );

    renderAgentEditor(
      form(),
      agentToEditorState(
        agent({
          provider: 'anthropic',
          apiProtocol: 'anthropic-messages',
          model: 'claude-model',
        })
      )
    );

    expect(readAgentDraft(form()).apiProtocol).toBe('anthropic-messages');
    expect((document.getElementById('agent-openai-api-mode') as HTMLSelectElement).value).toBe(
      'openai-responses'
    );
    expect(document.getElementById('openai-api-mode-group')?.classList.contains('hidden')).toBe(
      true
    );

    const connectionApi = document.getElementById('agent-connection-api') as HTMLSelectElement;
    connectionApi.value = 'openai';
    connectionApi.dispatchEvent(new Event('change', { bubbles: true }));
    expect(readAgentDraft(form()).apiProtocol).toBe('openai-responses');
  });

  it('resets every provider-specific reasoning field between sequential edits', () => {
    renderAgentEditor(
      form(),
      agentToEditorState(
        agent({
          reasoning: {
            enabled: true,
            openai: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
            autoExpand: false,
          },
        })
      )
    );

    renderAgentEditor(
      form(),
      agentToEditorState(
        agent({
          provider: 'google',
          apiProtocol: 'google-generative-ai',
          reasoning: {
            enabled: true,
            google: { thinkingBudget: -1, includeThoughts: false },
          },
        })
      )
    );

    expect((document.getElementById('reasoning-effort') as HTMLSelectElement).value).toBe('medium');
    expect((document.getElementById('reasoning-summary') as HTMLSelectElement).value).toBe('auto');
    expect(readAgentDraft(form()).reasoning).toEqual({
      enabled: true,
      autoExpand: true,
      google: { thinkingBudget: -1, includeThoughts: false },
    });
  });

  it('restores complete create defaults after an edit with unsaved values', () => {
    renderAgentEditor(
      form(),
      agentToEditorState(agent({ apiProtocol: 'openai-chat-completions', maxSteps: 42 }))
    );
    (document.getElementById('agent-name') as HTMLInputElement).value = 'Unsaved';
    (document.getElementById('reasoning-enabled') as HTMLInputElement).checked = true;

    renderAgentEditor(form(), defaultAgentEditorState());

    expect((document.getElementById('agent-name') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('agent-openai-api-mode') as HTMLSelectElement).value).toBe(
      'openai-responses'
    );
    expect((document.getElementById('agent-max-steps') as HTMLInputElement).value).toBe('10');
    expect((document.getElementById('reasoning-enabled') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('agent-api-key') as HTMLInputElement).required).toBe(true);
  });

  it('updates credential requirements without selecting a different protocol', () => {
    renderAgentEditor(form(), defaultAgentEditorState());
    const endpoint = document.getElementById('agent-endpoint') as HTMLInputElement;
    const apiKey = document.getElementById('agent-api-key') as HTMLInputElement;

    endpoint.value = 'https://proxy.example.test/v1';
    endpoint.dispatchEvent(new Event('input', { bubbles: true }));

    expect(apiKey.required).toBe(false);
    expect(readAgentDraft(form()).apiProtocol).toBe('openai-responses');
  });
});
