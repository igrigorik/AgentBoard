const CAPABILITY_TTL_MS = 30_000;
const MAX_ACTIVE_PDF_CAPABILITIES = 4;

interface PdfWorkerCapability {
  token: string;
  tabId: number;
  documentId: string;
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

/** Reserve one parser job for an exact document. State loss on MV3 restart intentionally revokes it. */
export function issuePdfWorkerCapability(tabId: number, documentId: string): string | null {
  purgeExpired();
  const documentReserved = [...capabilities.values()].some(
    (capability) => capability.tabId === tabId && capability.documentId === documentId
  );
  if (capabilities.size >= MAX_ACTIVE_PDF_CAPABILITIES || documentReserved) return null;

  const token = globalThis.crypto.randomUUID();
  const capability: PdfWorkerCapability = {
    token,
    tabId,
    documentId,
    expiresAt: Date.now() + CAPABILITY_TTL_MS,
    claimed: false,
  };
  capabilities.set(token, capability);
  return token;
}

/** Consume the worker-host claim once while retaining the reservation until the caller releases it. */
export function claimPdfWorkerCapability(
  token: string,
  tabId: number,
  documentId: string
): boolean {
  purgeExpired();
  const capability = capabilities.get(token);
  if (
    !capability ||
    capability.claimed ||
    capability.tabId !== tabId ||
    capability.documentId !== documentId
  ) {
    return false;
  }
  capability.claimed = true;
  return true;
}

export function releasePdfWorkerCapability(token: string): void {
  const capability = capabilities.get(token);
  if (capability) removeCapability(capability);
}
