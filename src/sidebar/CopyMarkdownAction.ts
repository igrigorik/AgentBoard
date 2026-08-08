import log from '../lib/logger';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FEEDBACK_DURATION_MS = 1800;

type CopyState = 'idle' | 'copied' | 'error';

const STATE_LABELS: Record<CopyState, string> = {
  idle: 'Copy response as Markdown',
  copied: 'Copied as Markdown',
  error: 'Copy failed — try again',
};

function createPath(pathData: string): SVGPathElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  return path;
}

function createIcon(state: CopyState): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');

  if (state === 'copied') {
    icon.appendChild(createPath('M5 12.5 9.5 17 19 7.5'));
    return icon;
  }

  if (state === 'error') {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '8.5');
    icon.append(circle, createPath('M12 7.5v5.75'), createPath('M12 16.5h.01'));
    return icon;
  }

  const back = document.createElementNS(SVG_NS, 'rect');
  back.setAttribute('x', '4.5');
  back.setAttribute('y', '4.5');
  back.setAttribute('width', '11');
  back.setAttribute('height', '11');
  back.setAttribute('rx', '2');

  const front = document.createElementNS(SVG_NS, 'rect');
  front.setAttribute('x', '8.5');
  front.setAttribute('y', '8.5');
  front.setAttribute('width', '11');
  front.setAttribute('height', '11');
  front.setAttribute('rx', '2');

  icon.append(back, front);
  return icon;
}

function setButtonState(button: HTMLButtonElement, state: CopyState): void {
  const label = STATE_LABELS[state];
  button.dataset.state = state;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.replaceChildren(createIcon(state));
}

/**
 * Create the compact action shown after a completed assistant turn.
 * The click closure captures source Markdown so copying never depends on rendered DOM.
 */
export function createCopyMarkdownAction(markdown: string): HTMLDivElement {
  const actions = document.createElement('div');
  actions.className = 'response-actions';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'response-copy-button';
  setButtonState(button, 'idle');

  const status = document.createElement('span');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');

  let resetTimer: number | undefined;
  let isCopying = false;
  button.addEventListener('click', async () => {
    if (isCopying) return;
    isCopying = true;
    button.setAttribute('aria-busy', 'true');
    if (resetTimer !== undefined) window.clearTimeout(resetTimer);

    try {
      if (!globalThis.navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await globalThis.navigator.clipboard.writeText(markdown);
      setButtonState(button, 'copied');
      status.textContent = 'Copied response as Markdown.';
    } catch {
      setButtonState(button, 'error');
      status.textContent = 'Could not copy response as Markdown. Try again.';
      log.error('[Sidebar] Failed to copy response as Markdown');
    } finally {
      isCopying = false;
      button.removeAttribute('aria-busy');
      resetTimer = window.setTimeout(() => {
        setButtonState(button, 'idle');
        status.textContent = '';
        resetTimer = undefined;
      }, FEEDBACK_DURATION_MS);
    }
  });

  actions.append(button, status);
  return actions;
}
