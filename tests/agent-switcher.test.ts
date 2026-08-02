import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/lib/storage/config';
import { AgentSwitcher } from '../src/sidebar/AgentSwitcher';

const agents: AgentConfig[] = [
  {
    id: 'gemini',
    name: 'Snappy Gemini',
    provider: 'google',
    apiProtocol: 'google-generative-ai',
    model: 'gemini-2.5-flash',
    temperature: 0.7,
  },
  {
    id: 'claude',
    name: 'Deep Claude',
    provider: 'anthropic',
    apiProtocol: 'anthropic-messages',
    model: 'claude-opus-4',
    temperature: 0.7,
  },
];

function renderSwitcher() {
  document.body.innerHTML = `
    <details id="agent-switcher">
      <summary class="agent-switcher-trigger">
        <span class="agent-dot"></span>
        <span class="agent-switcher-label"></span>
      </summary>
      <div class="agent-switcher-menu"></div>
    </details>
  `;
  const root = document.getElementById('agent-switcher') as HTMLDetailsElement;
  const trigger = root.querySelector('.agent-switcher-trigger') as HTMLElement;
  const menu = root.querySelector('.agent-switcher-menu') as HTMLDivElement;
  const onSelect = vi.fn<(agentId: string) => void>();
  return { root, switcher: new AgentSwitcher(root, onSelect), onSelect, trigger, menu };
}

describe('AgentSwitcher', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the selected agent and rich option rows', () => {
    const { switcher, trigger, menu } = renderSwitcher();

    switcher.setAgents(agents, 'claude');

    expect(trigger.textContent).toContain('Deep Claude');
    const optionDots = Array.from(menu.querySelectorAll<HTMLElement>('.agent-option-dot'));
    const selectedColor = optionDots[1].style.getPropertyValue('--agent-color');
    expect(optionDots[0].style.getPropertyValue('--agent-color')).not.toBe(selectedColor);
    expect(
      (trigger.querySelector('.agent-dot') as HTMLElement).style.getPropertyValue('--agent-color')
    ).toBe(selectedColor);
    expect(menu.querySelectorAll('.agent-switcher-option')).toHaveLength(2);
    expect(menu.textContent).toContain('gemini-2.5-flash');
    expect(menu.querySelector('[aria-current="true"]')?.textContent).toContain('Deep Claude');
  });

  it('uses the native disclosure and requests a changed selection', () => {
    const { root, switcher, onSelect, trigger, menu } = renderSwitcher();
    switcher.setAgents(agents, 'gemini');

    trigger.click();
    expect(root.open).toBe(true);

    const claude = menu.querySelector('[data-agent-id="claude"]') as HTMLButtonElement;
    claude.click();
    expect(onSelect).toHaveBeenCalledWith('claude');
    expect(root.open).toBe(false);
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    claude.click();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('navigates with arrows and closes on Escape or outside clicks', () => {
    const { root, switcher, trigger, menu } = renderSwitcher();
    switcher.setAgents(agents, 'gemini');
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>('.agent-switcher-option'));

    trigger.click();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(options[0]);
    options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(options[1]);
    options[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(options[0]);
    options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.open).toBe(false);
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    const outsideButton = document.body.appendChild(document.createElement('button'));
    outsideButton.focus();
    outsideButton.click();
    expect(root.open).toBe(false);
    expect(document.activeElement).toBe(outsideButton);
  });

  it('handles empty and untrusted agent labels', () => {
    const { root, switcher, trigger, menu } = renderSwitcher();
    switcher.setAgents([]);
    trigger.click();
    expect(root.open).toBe(false);
    expect(trigger.tabIndex).toBe(-1);
    expect(trigger.textContent).toContain('No agents configured');

    switcher.setAgents([{ ...agents[0], name: '<img src=x onerror=alert(1)>' }]);
    expect(menu.querySelector('img')).toBeNull();
    expect(trigger.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
