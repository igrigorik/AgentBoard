import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateDuplicateName, showModalStatus } from '../src/options/card-component';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('generateDuplicateName', () => {
  it('appends (1) for first duplicate', () => {
    expect(generateDuplicateName('My Agent', ['My Agent'])).toBe('My Agent (1)');
  });

  it('increments counter for existing duplicates', () => {
    const existing = ['My Agent', 'My Agent (1)', 'My Agent (2)'];
    expect(generateDuplicateName('My Agent', existing)).toBe('My Agent (3)');
  });

  it('handles duplicating an already numbered agent', () => {
    const existing = ['My Agent', 'My Agent (1)'];
    expect(generateDuplicateName('My Agent (1)', existing)).toBe('My Agent (2)');
  });

  it('finds gaps in numbering', () => {
    const existing = ['My Agent', 'My Agent (2)', 'My Agent (3)'];
    expect(generateDuplicateName('My Agent', existing)).toBe('My Agent (1)');
  });

  it('handles empty existing names', () => {
    expect(generateDuplicateName('My Agent', [])).toBe('My Agent (1)');
  });

  it('handles names with special characters', () => {
    const existing = ['Code-Assistant_v2'];
    expect(generateDuplicateName('Code-Assistant_v2', existing)).toBe('Code-Assistant_v2 (1)');
  });
});

describe('showModalStatus', () => {
  it('keeps a pending status visible until a result replaces it', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="agent-modal-status" class="modal-status hidden"></div>';

    showModalStatus('agent-modal', 'Testing...', 'info');
    vi.advanceTimersByTime(10_000);

    expect(document.getElementById('agent-modal-status')?.classList.contains('hidden')).toBe(false);
  });

  it('starts the hide timer from the latest result', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="agent-modal-status" class="modal-status hidden"></div>';

    showModalStatus('agent-modal', 'First failure', 'error');
    vi.advanceTimersByTime(2_000);
    showModalStatus('agent-modal', 'Success', 'success');
    vi.advanceTimersByTime(2_999);
    expect(document.getElementById('agent-modal-status')?.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.getElementById('agent-modal-status')?.classList.contains('hidden')).toBe(true);
  });
});
