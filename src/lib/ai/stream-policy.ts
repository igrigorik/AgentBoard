export const DEFAULT_MAX_STEPS = 10;
export const MAX_AUTO_CONTINUATIONS = 3;

export interface StreamStopDecision {
  shouldStop: boolean;
  stepsExhausted: boolean;
}

/** Keep the SDK stop condition and the completion metadata on one tested decision path. */
export function decideStreamStop(
  stepCount: number,
  maxSteps: number | undefined,
  toolsInvalidated: boolean
): StreamStopDecision {
  if (toolsInvalidated) return { shouldStop: true, stepsExhausted: false };
  if (stepCount >= (maxSteps ?? DEFAULT_MAX_STEPS)) {
    return { shouldStop: true, stepsExhausted: true };
  }
  return { shouldStop: false, stepsExhausted: false };
}

export type StreamContinuation = 'tools-changed' | 'steps-exhausted' | null;

export interface StreamContinuationState {
  toolsChanged: boolean;
  stepsExhausted: boolean;
  continuationCount: number;
  maxContinuations?: number;
}

/** Tool invalidation takes precedence because the next turn needs a fresh capability snapshot. */
export function selectStreamContinuation({
  toolsChanged,
  stepsExhausted,
  continuationCount,
  maxContinuations = MAX_AUTO_CONTINUATIONS,
}: StreamContinuationState): StreamContinuation {
  if (continuationCount >= maxContinuations) return null;
  if (toolsChanged) return 'tools-changed';
  if (stepsExhausted) return 'steps-exhausted';
  return null;
}

export function stepLimitContinuationMessage(maxSteps: number | undefined): string {
  const limit = maxSteps ?? DEFAULT_MAX_STEPS;
  return `[You have used all ${limit} tool steps allowed for this turn. Do NOT call any more tools. Instead, summarize what you accomplished and what remains to be done.]`;
}
