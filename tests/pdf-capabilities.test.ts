import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimPdfWorkerCapability,
  issuePdfWorkerCapability,
  releasePdfWorkerCapability,
} from '../src/lib/webmcp/tools/read_page/pdf/capabilities';

describe('PDF worker capabilities', () => {
  afterEach(() => vi.useRealTimers());

  it('binds a one-time claim to the issuing tab and exact current document', () => {
    const capability = issuePdfWorkerCapability(7, 'document-a');
    expect(capability).toBeTypeOf('string');
    expect(claimPdfWorkerCapability(capability!, 8, 'document-a')).toBe(false);
    expect(claimPdfWorkerCapability(capability!, 7, 'document-b')).toBe(false);
    expect(claimPdfWorkerCapability(capability!, 7, 'document-a')).toBe(true);
    expect(claimPdfWorkerCapability(capability!, 7, 'document-a')).toBe(false);
    releasePdfWorkerCapability(capability!);
  });

  it('permits only one active parser reservation per exact document', () => {
    const first = issuePdfWorkerCapability(7, 'document-b');
    expect(first).toBeTypeOf('string');
    expect(issuePdfWorkerCapability(7, 'document-b')).toBeNull();
    releasePdfWorkerCapability(first!);
    const replacement = issuePdfWorkerCapability(7, 'document-b');
    expect(replacement).toBeTypeOf('string');
    releasePdfWorkerCapability(replacement!);
  });

  it('expires unclaimed capabilities', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const expired = issuePdfWorkerCapability(7, 'document-c');
    vi.advanceTimersByTime(30_001);

    const replacement = issuePdfWorkerCapability(7, 'document-c');
    expect(replacement).toBeTypeOf('string');
    expect(claimPdfWorkerCapability(expired!, 7, 'document-c')).toBe(false);
    releasePdfWorkerCapability(replacement!);
  });

  it('retains claimed reservations past the startup TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const capability = issuePdfWorkerCapability(7, 'document-d');
    expect(claimPdfWorkerCapability(capability!, 7, 'document-d')).toBe(true);
    vi.advanceTimersByTime(30_001);

    expect(issuePdfWorkerCapability(7, 'document-d')).toBeNull();
    releasePdfWorkerCapability(capability!);
  });

  it('enforces the global parser reservation limit', () => {
    const capabilities = Array.from({ length: 4 }, (_, index) =>
      issuePdfWorkerCapability(20 + index, `document-${index}`)
    );
    expect(capabilities.every(Boolean)).toBe(true);
    expect(issuePdfWorkerCapability(99, 'document-overflow')).toBeNull();
    for (const capability of capabilities) releasePdfWorkerCapability(capability!);
  });

  it('rejects unissued capabilities', () => {
    expect(claimPdfWorkerCapability('page-chosen-token', 7, 'document-a')).toBe(false);
  });
});
