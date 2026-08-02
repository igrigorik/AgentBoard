import type { AgentConfig } from '../lib/storage/config';

type SwitcherAgent = Pick<AgentConfig, 'id' | 'name' | 'model'>;

function modelColor(model: string): string {
  let hash = 0;
  for (const character of model) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 52%)`;
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Agent switcher is missing ${selector}`);
  return element;
}

export class AgentSwitcher {
  private readonly trigger: HTMLElement;
  private readonly label: HTMLSpanElement;
  private readonly agentDot: HTMLSpanElement;
  private readonly menu: HTMLDivElement;
  private agents: SwitcherAgent[] = [];
  private selectedAgentId?: string;

  constructor(
    private readonly root: HTMLDetailsElement,
    private readonly onSelect: (agentId: string) => void
  ) {
    this.trigger = requiredElement(root, '.agent-switcher-trigger');
    this.label = requiredElement(root, '.agent-switcher-label');
    this.agentDot = requiredElement(root, '.agent-dot');
    this.menu = requiredElement(root, '.agent-switcher-menu');

    this.trigger.addEventListener('click', (event) => {
      if (this.agents.length === 0) event.preventDefault();
    });
    this.root.addEventListener('keydown', (event) => this.handleKeydown(event));
    document.addEventListener('click', (event) => {
      if (event.target instanceof Node && !this.root.contains(event.target)) {
        this.close(this.root.contains(document.activeElement));
      }
    });
  }

  setAgents(agents: SwitcherAgent[], selectedAgentId?: string): void {
    this.agents = agents;
    this.selectedAgentId = agents.find(({ id }) => id === selectedAgentId)?.id ?? agents[0]?.id;
    this.root.open = false;
    this.trigger.tabIndex = agents.length === 0 ? -1 : 0;
    this.trigger.setAttribute('aria-disabled', String(agents.length === 0));
    this.render();
  }

  private render(): void {
    this.menu.replaceChildren();

    for (const agent of this.agents) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'agent-switcher-option';
      option.dataset.agentId = agent.id;
      option.title = `${agent.name} — ${agent.model}`;

      const dot = document.createElement('span');
      dot.className = 'agent-option-dot';
      dot.style.setProperty('--agent-color', modelColor(agent.model));
      dot.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('span');
      copy.className = 'agent-option-copy';
      const name = document.createElement('span');
      name.className = 'agent-option-name';
      name.textContent = agent.name;
      const model = document.createElement('span');
      model.className = 'agent-option-model';
      model.textContent = agent.model;
      copy.append(name, model);

      const check = document.createElement('span');
      check.className = 'agent-option-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');

      option.append(dot, copy, check);
      option.addEventListener('click', () => this.select(agent.id));
      this.menu.appendChild(option);
    }

    this.syncSelection();
  }

  private syncSelection(): void {
    const selected = this.agents.find(({ id }) => id === this.selectedAgentId);
    this.label.textContent = selected?.name ?? 'No agents configured';
    this.trigger.title = selected?.name ?? '';
    if (selected) {
      this.agentDot.style.setProperty('--agent-color', modelColor(selected.model));
    } else {
      this.agentDot.style.removeProperty('--agent-color');
    }

    for (const option of this.menu.querySelectorAll<HTMLButtonElement>('.agent-switcher-option')) {
      if (option.dataset.agentId === selected?.id) option.setAttribute('aria-current', 'true');
      else option.removeAttribute('aria-current');
    }
  }

  private select(agentId: string): void {
    const changed = this.selectedAgentId !== agentId;
    this.close(true);
    if (!changed) return;
    this.selectedAgentId = agentId;
    this.syncSelection();
    this.onSelect(agentId);
  }

  private close(focusTrigger = false): void {
    this.root.open = false;
    if (focusTrigger) this.trigger.focus();
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.root.open) {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    const options = Array.from(
      this.menu.querySelectorAll<HTMLButtonElement>('.agent-switcher-option')
    );
    if (options.length === 0) return;

    event.preventDefault();
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const selectedIndex = options.findIndex((option) => option.hasAttribute('aria-current'));
    let nextIndex = Math.max(selectedIndex, 0);
    if (currentIndex >= 0) {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      nextIndex = (currentIndex + direction + options.length) % options.length;
    } else if (event.key === 'ArrowUp' && !this.root.open) {
      nextIndex = options.length - 1;
    }

    this.root.open = true;
    options[nextIndex].focus();
  }
}
