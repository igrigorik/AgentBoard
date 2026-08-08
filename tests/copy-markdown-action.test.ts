import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCopyMarkdownAction } from '../src/sidebar/CopyMarkdownAction';

const writeText = vi.fn<(text: string) => Promise<void>>();

describe('copy Markdown action', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('copies the source Markdown and reports success without a toast', async () => {
    const markdown = '# Result\n\n- first\n- second';
    const action = createCopyMarkdownAction(markdown);
    document.body.appendChild(action);

    const button = action.querySelector<HTMLButtonElement>('.response-copy-button');
    expect(button?.getAttribute('aria-label')).toBe('Copy response as Markdown');

    button?.focus();
    button?.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
    expect(document.activeElement).toBe(button);
    expect(button?.hasAttribute('aria-busy')).toBe(false);
    expect(button?.dataset.state).toBe('copied');
    expect(button?.getAttribute('aria-label')).toBe('Copied as Markdown');
    expect(action.querySelector('[role="status"]')?.textContent).toBe(
      'Copied response as Markdown.'
    );

    await vi.advanceTimersByTimeAsync(1800);
    expect(button?.dataset.state).toBe('idle');
    expect(button?.getAttribute('aria-label')).toBe('Copy response as Markdown');
    expect(action.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('keeps the action retryable when clipboard access fails', async () => {
    writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const action = createCopyMarkdownAction('**Important**');
    document.body.appendChild(action);

    const button = action.querySelector<HTMLButtonElement>('.response-copy-button');
    button?.click();

    await vi.waitFor(() => expect(button?.dataset.state).toBe('error'));
    expect(button?.hasAttribute('aria-busy')).toBe(false);
    expect(button?.getAttribute('aria-label')).toBe('Copy failed — try again');
    expect(action.querySelector('[role="status"]')?.textContent).toBe(
      'Could not copy response as Markdown. Try again.'
    );
  });
});
