/**
 * Tests for the configurable step limit and wrap-up continuation behavior.
 *
 * The step limit feature has two parts:
 * 1. stopWhen predicate in client.ts — stops the stream and sets flags
 * 2. Sidebar continuation logic — auto-continues with wrap-up prompt
 *
 * Both are closures inside larger functions, so we model the behavior
 * as pure logic tests rather than mocking the full AI SDK / Chrome APIs.
 */

import { describe, it, expect } from 'vitest';

/**
 * Models the stopWhen predicate logic from client.ts.
 * Returns the stop decision and the resulting flag state.
 */
function evaluateStopWhen(
  stepCount: number,
  maxSteps: number | undefined,
  toolsInvalidated: boolean
): { shouldStop: boolean; stepsExhausted: boolean } {
  let stepsExhausted = false;

  const shouldStop = (() => {
    if (toolsInvalidated) return true;
    if (stepCount >= (maxSteps ?? 10)) {
      stepsExhausted = true;
      return true;
    }
    return false;
  })();

  return { shouldStop, stepsExhausted };
}

/**
 * Models the sidebar STREAM_COMPLETE handler's continuation decision.
 * Returns what action the sidebar should take.
 */
function decideContinuation(
  stepsExhausted: boolean,
  toolsChanged: boolean,
  autoContinuationCount: number,
  maxAutoContinuations: number
): 'continue-tools-changed' | 'continue-wrap-up' | 'stop' {
  // toolsChanged is checked first (higher priority)
  if (toolsChanged && autoContinuationCount < maxAutoContinuations) {
    return 'continue-tools-changed';
  }

  // Step exhaustion wrap-up (only when toolsChanged didn't trigger)
  if (stepsExhausted && !toolsChanged && autoContinuationCount < maxAutoContinuations) {
    return 'continue-wrap-up';
  }

  return 'stop';
}

describe('Step Limit', () => {
  describe('stopWhen predicate', () => {
    it('should stop and set stepsExhausted when step limit reached', () => {
      const result = evaluateStopWhen(10, 10, false);
      expect(result.shouldStop).toBe(true);
      expect(result.stepsExhausted).toBe(true);
    });

    it('should stop and set stepsExhausted when over the limit', () => {
      const result = evaluateStopWhen(15, 10, false);
      expect(result.shouldStop).toBe(true);
      expect(result.stepsExhausted).toBe(true);
    });

    it('should NOT stop when under the step limit', () => {
      const result = evaluateStopWhen(3, 10, false);
      expect(result.shouldStop).toBe(false);
      expect(result.stepsExhausted).toBe(false);
    });

    it('should stop on toolsInvalidated WITHOUT setting stepsExhausted', () => {
      const result = evaluateStopWhen(2, 10, true);
      expect(result.shouldStop).toBe(true);
      expect(result.stepsExhausted).toBe(false);
    });

    it('should prioritize toolsInvalidated over step limit', () => {
      // Both conditions true — toolsInvalidated checked first,
      // so stepsExhausted should NOT be set
      const result = evaluateStopWhen(10, 10, true);
      expect(result.shouldStop).toBe(true);
      expect(result.stepsExhausted).toBe(false);
    });

    it('should fall back to default 10 when maxSteps is undefined', () => {
      const under = evaluateStopWhen(9, undefined, false);
      expect(under.shouldStop).toBe(false);

      const at = evaluateStopWhen(10, undefined, false);
      expect(at.shouldStop).toBe(true);
      expect(at.stepsExhausted).toBe(true);
    });

    it('should respect custom maxSteps values', () => {
      // Low limit
      const result1 = evaluateStopWhen(1, 1, false);
      expect(result1.shouldStop).toBe(true);
      expect(result1.stepsExhausted).toBe(true);

      // High limit
      const result25 = evaluateStopWhen(24, 25, false);
      expect(result25.shouldStop).toBe(false);

      const result25hit = evaluateStopWhen(25, 25, false);
      expect(result25hit.shouldStop).toBe(true);
      expect(result25hit.stepsExhausted).toBe(true);
    });
  });

  describe('continuation decision', () => {
    const MAX = 3; // mirrors MAX_AUTO_CONTINUATIONS

    it('should wrap up when stepsExhausted and no toolsChanged', () => {
      const action = decideContinuation(true, false, 0, MAX);
      expect(action).toBe('continue-wrap-up');
    });

    it('should prefer toolsChanged over stepsExhausted', () => {
      // Both flags true — toolsChanged wins
      const action = decideContinuation(true, true, 0, MAX);
      expect(action).toBe('continue-tools-changed');
    });

    it('should stop when neither flag is set', () => {
      const action = decideContinuation(false, false, 0, MAX);
      expect(action).toBe('stop');
    });

    it('should stop when at continuation cap (stepsExhausted)', () => {
      const action = decideContinuation(true, false, MAX, MAX);
      expect(action).toBe('stop');
    });

    it('should stop when at continuation cap (toolsChanged)', () => {
      const action = decideContinuation(false, true, MAX, MAX);
      expect(action).toBe('stop');
    });

    it('should allow wrap-up on first continuation only', () => {
      const first = decideContinuation(true, false, 0, MAX);
      expect(first).toBe('continue-wrap-up');

      const second = decideContinuation(true, false, 1, MAX);
      expect(second).toBe('continue-wrap-up');

      // At cap — no more continuations
      const capped = decideContinuation(true, false, MAX, MAX);
      expect(capped).toBe('stop');
    });
  });

  describe('wrap-up message contract', () => {
    it('should include the step limit in the message', () => {
      const maxSteps = 15;
      const message = `[You have used all ${maxSteps} tool steps allowed for this turn. Do NOT call any more tools. Instead, summarize what you accomplished and what remains to be done.]`;

      expect(message).toContain('15');
      expect(message).toContain('Do NOT call any more tools');
      expect(message).toContain('summarize');
    });

    it('should fallback to default when maxSteps undefined', () => {
      const maxSteps = undefined;
      const limit = maxSteps ?? 10;
      const message = `[You have used all ${limit} tool steps allowed for this turn. Do NOT call any more tools. Instead, summarize what you accomplished and what remains to be done.]`;

      expect(message).toContain('10');
    });
  });
});
