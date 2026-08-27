import type { ExactDocumentRoute } from '../route';

const CAPABILITY_TTL_MS = 30_000;
const MAX_ACTIVE_PDF_CAPABILITIES = 4;

interface PdfWorkerCapability {
  token: string;
  route: ExactDocumentRoute;
  expiresAt: number;
  claimed: boolean;
}

const capabilities = new Map<string, PdfWorkerCapability>();

function removeCapability(capability: PdfWorkerCapability): void {
  capabilities.delete(capability.token);
}

function purgeExpired(now = Date.now()): void {
  for (const capability of capabilities.values()) {
    // The TTL limits theft/replay before startup. Once claimed, the reservation represents active
    // work and remains counted until its owning reader releases it on settlement or cancellation.
    if (!capability.claimed && capability.expiresAt <= now) removeCapability(capability);
  }
}

/** Reserve one parser job with the exact route verifier that authorized it. */
export function issuePdfWorkerCapability(route: ExactDocumentRoute): string | null {
  purgeExpired();
  const documentReserved = [...capabilities.values()].some(
    ({ route: reserved }) =>
      reserved.tabId === route.tabId && reserved.documentId === route.documentId
  );
  if (capabilities.size >= MAX_ACTIVE_PDF_CAPABILITIES || documentReserved) return null;

  const token = globalThis.crypto.randomUUID();
  capabilities.set(token, {
    token,
    route,
    expiresAt: Date.now() + CAPABILITY_TTL_MS,
    claimed: false,
  });
  return token;
}

/** Verify and consume a capability once; async ownership checks are re-fenced before mutation. */
export async function claimPdfWorkerCapability(token: string, tabId: number): Promise<boolean> {
  purgeExpired();
  const capability = capabilities.get(token);
  if (!capability || capability.claimed || capability.route.tabId !== tabId) return false;

  try {
    if (!(await capability.route.isCurrent())) return false;
  } catch {
    return false;
  }

  purgeExpired();
  const current = capabilities.get(token);
  if (current !== capability || capability.claimed || capability.route.tabId !== tabId)
    return false;
  capability.claimed = true;
  return true;
}

export function releasePdfWorkerCapability(token: string): void {
  const capability = capabilities.get(token);
  if (capability) removeCapability(capability);
}
