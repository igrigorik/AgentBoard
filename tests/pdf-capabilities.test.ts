import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExactDocumentRoute } from '../src/lib/webmcp/tools/read_page/route';
import {
  claimPdfWorkerCapability,
  issuePdfWorkerCapability,
  releasePdfWorkerCapability,
} from '../src/lib/webmcp/tools/read_page/pdf/capabilities';

function route(
  tabId: number,
  documentId: string,
  isCurrent: ExactDocumentRoute['isCurrent'] = vi.fn().mockResolvedValue(true)
): ExactDocumentRoute {
  return { tabId, documentId, isCurrent };
}

describe('PDF worker capabilities', () => {
  afterEach(() => vi.useRealTimers());

  it('binds a one-time claim to the issuing tab and exact route verifier', async () => {
    const isCurrent = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const capability = issuePdfWorkerCapability(route(7, 'document-a', isCurrent));
    expect(capability).toBeTypeOf('string');

    await expect(claimPdfWorkerCapability(capability!, 8)).resolves.toBe(false);
    expect(isCurrent).not.toHaveBeenCalled();
    await expect(claimPdfWorkerCapability(capability!, 7)).resolves.toBe(false);
    await expect(claimPdfWorkerCapability(capability!, 7)).resolves.toBe(true);
    await expect(claimPdfWorkerCapability(capability!, 7)).resolves.toBe(false);
    expect(isCurrent).toHaveBeenCalledTimes(2);
    releasePdfWorkerCapability(capability!);
  });

  it('allows only one winner when claims race across an asynchronous ownership check', async () => {
    let resolveCurrent!: (current: boolean) => void;
    const current = new Promise<boolean>((resolve) => {
      resolveCurrent = resolve;
    });
    const capability = issuePdfWorkerCapability(
      route(
        7,
        'document-race',
        vi.fn(() => current)
      )
    );

    const claims = [
      claimPdfWorkerCapability(capability!, 7),
      claimPdfWorkerCapability(capability!, 7),
    ];
    resolveCurrent(true);
    await expect(Promise.all(claims)).resolves.toEqual(expect.arrayContaining([true, false]));
    releasePdfWorkerCapability(capability!);
  });

  it('permits only one active parser reservation per exact document', () => {
    const first = issuePdfWorkerCapability(route(7, 'document-b'));
    expect(first).toBeTypeOf('string');
    expect(issuePdfWorkerCapability(route(7, 'document-b'))).toBeNull();
    releasePdfWorkerCapability(first!);
    const replacement = issuePdfWorkerCapability(route(7, 'document-b'));
    expect(replacement).toBeTypeOf('string');
    releasePdfWorkerCapability(replacement!);
  });

  it('expires unclaimed capabilities', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const expired = issuePdfWorkerCapability(route(7, 'document-c'));
    vi.advanceTimersByTime(30_001);

    const replacement = issuePdfWorkerCapability(route(7, 'document-c'));
    expect(replacement).toBeTypeOf('string');
    await expect(claimPdfWorkerCapability(expired!, 7)).resolves.toBe(false);
    releasePdfWorkerCapability(replacement!);
  });

  it('retains claimed reservations past the startup TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const capability = issuePdfWorkerCapability(route(7, 'document-d'));
    await expect(claimPdfWorkerCapability(capability!, 7)).resolves.toBe(true);
    vi.advanceTimersByTime(30_001);

    expect(issuePdfWorkerCapability(route(7, 'document-d'))).toBeNull();
    releasePdfWorkerCapability(capability!);
  });

  it('enforces the global parser reservation limit', () => {
    const capabilities = Array.from({ length: 4 }, (_, index) =>
      issuePdfWorkerCapability(route(20 + index, `document-${index}`))
    );
    expect(capabilities.every(Boolean)).toBe(true);
    expect(issuePdfWorkerCapability(route(99, 'document-overflow'))).toBeNull();
    for (const capability of capabilities) releasePdfWorkerCapability(capability!);
  });

  it('rejects unissued capabilities', async () => {
    await expect(claimPdfWorkerCapability('page-chosen-token', 7)).resolves.toBe(false);
  });
});
