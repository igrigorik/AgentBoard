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

  it('does not turn model-authored Markdown into local or privileged URL access', () => {
    const container = render(`
[web](https://example.test/path)
[mail](mailto:test@example.test)
[local](file:///private/secret.txt)
[extension](chrome-extension://example/private.html)
![web image](https://images.example.test/image.png)
![local image](file:///private/secret.png)
![data image](data:image/png;base64,AAAA)
`);
    const links = [...container.querySelectorAll('a')];
    const images = [...container.querySelectorAll('img')];

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.test/path',
      'mailto:test@example.test',
      null,
      null,
    ]);
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'https://images.example.test/image.png',
      null,
      null,
    ]);
    expect(images[0].referrerPolicy).toBe('no-referrer');
  });
});
