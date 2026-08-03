/** Basic credential-pattern filtering for local DEBUG and TRACE output. */
export function redactDiagnosticString(value: string): string {
  const redacted = '[REDACTED]';
  return value
    .replace(
      /(\bauthorization\b["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${redacted}`
    )
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, `$1 ${redacted}`)
    .replace(
      /(\b(?:api[_-]?key|x[-_]api[_-]?key|x[-_]goog[_-]?api[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|password|secret|cookie|credential)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${redacted}`
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, redacted)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, redacted);
}
