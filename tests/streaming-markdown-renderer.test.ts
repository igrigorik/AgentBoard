import { describe, expect, it } from 'vitest';
import { StreamingMarkdownRenderer } from '../src/sidebar/StreamingMarkdownRenderer';

function render(markdown: string): HTMLDivElement {
  const container = document.createElement('div');
  StreamingMarkdownRenderer.renderComplete(container, markdown);
  return container;
}

describe('StreamingMarkdownRenderer', () => {
  it('keeps multiline list contents inside their list items', () => {
    const container = render('- **First item**\nFirst detail\n- **Second item**\nSecond detail');

    const list = container.querySelector('ul');
    const items = list?.querySelectorAll(':scope > li');

    expect(container.querySelectorAll(':scope > li')).toHaveLength(0);
    expect(items).toHaveLength(2);
    expect(items?.[0].innerHTML).toBe('<strong>First item</strong><br>First detail');
    expect(items?.[1].innerHTML).toBe('<strong>Second item</strong><br>Second detail');
  });

  it('keeps list contents nested across horizontal rules', () => {
    const container = render('- Before\n  ---\n  After');

    expect(container.querySelectorAll(':scope > li')).toHaveLength(0);
    expect(container.querySelector('ul > li')?.innerHTML).toBe('Before<hr><br>After');
  });
});
