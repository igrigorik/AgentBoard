import { describe, expect, it } from 'vitest';
import { ToolCallBox } from '../src/sidebar/ToolCallBox';
import type { ToolCallSource } from '../src/types';

function toolCall(source?: ToolCallSource) {
  return {
    id: 'call-1',
    toolName: 'agentboard_read_page',
    ...(source && { source }),
    input: 'input',
    status: 'success' as const,
    startTime: 1,
    endTime: 22,
    duration: 21,
  };
}

describe('ToolCallBox source badge', () => {
  it.each([
    ['agentboard', 'AgentBoard'],
    ['webmcp', 'WebMCP'],
    ['custom', 'Custom'],
    ['mcp', 'MCP'],
  ] as const)(
    'renders the %s source without changing the compact header order',
    (source, label) => {
      const element = new ToolCallBox(toolCall(source)).getElement();
      const header = element.querySelector('.tool-call-header');
      const badge = element.querySelector('.tool-source-badge');

      expect(element.dataset.toolSource).toBe(source);
      expect(badge?.textContent).toBe(label);
      expect(badge?.classList.contains(`tool-source-${source}`)).toBe(true);
      expect(Array.from(header?.children ?? []).map(({ className }) => className)).toEqual([
        'status-icon status-success',
        'tool-name',
        `tool-source-badge tool-source-${source}`,
        'duration-badge',
        'chevron',
      ]);
    }
  );

  it('preserves the existing header when source is unknown', () => {
    const element = new ToolCallBox(toolCall()).getElement();

    expect(element.dataset.toolSource).toBeUndefined();
    expect(element.querySelector('.tool-source-badge')).toBeNull();
  });

  it('keeps a later duration between the source badge and chevron', () => {
    const box = new ToolCallBox({
      id: 'call-2',
      toolName: 'page_search',
      source: 'webmcp',
      input: 'input',
      status: 'running',
      startTime: Date.now() - 25,
    });

    box.updateResult('done', 'success');

    const header = box.getElement().querySelector('.tool-call-header');
    expect(Array.from(header?.children ?? []).map(({ className }) => className)).toEqual([
      'status-icon status-success',
      'tool-name',
      'tool-source-badge tool-source-webmcp',
      'duration-badge',
      'chevron',
    ]);
  });

  it('renders detailed validation feedback for a failed tool call', () => {
    const box = new ToolCallBox({
      id: 'call-3',
      toolName: 'update_cart',
      input: { cart: { lineitems: {} } },
      status: 'running',
      startTime: Date.now(),
    });
    const feedback =
      'Tool arguments do not match the declared schema:\n' +
      '- #/cart [required]: Instance does not have required property "line_items".';

    box.updateResult(null, 'error', feedback);

    const error = box.getElement().querySelector('.tool-section-error .tool-section-content');
    expect(error?.textContent).toBe(feedback);
  });
});
