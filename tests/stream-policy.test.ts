import { describe, expect, it } from 'vitest';
import {
  decideStreamStop,
  MAX_AUTO_CONTINUATIONS,
  selectStreamContinuation,
  stepLimitContinuationMessage,
  toolsChangedContinuationMessage,
} from '../src/lib/ai/stream-policy';

describe('stream policy', () => {
  it('stops for invalidated tools or an exhausted configured step budget', () => {
    const cases = [
      [decideStreamStop(3, 10, false), { shouldStop: false, stepsExhausted: false }],
      [decideStreamStop(10, 10, false), { shouldStop: true, stepsExhausted: true }],
      [decideStreamStop(25, 25, false), { shouldStop: true, stepsExhausted: true }],
      [decideStreamStop(9, undefined, false), { shouldStop: false, stepsExhausted: false }],
      [decideStreamStop(10, undefined, false), { shouldStop: true, stepsExhausted: true }],
      [decideStreamStop(2, 10, true), { shouldStop: true, stepsExhausted: false }],
      [decideStreamStop(10, 10, true), { shouldStop: true, stepsExhausted: false }],
    ] as const;

    for (const [actual, expected] of cases) expect(actual).toEqual(expected);
  });

  it('selects at most one bounded continuation with tool changes taking precedence', () => {
    expect(
      selectStreamContinuation({
        toolsChanged: true,
        stepsExhausted: true,
        continuationCount: 0,
      })
    ).toBe('tools-changed');
    expect(
      selectStreamContinuation({
        toolsChanged: false,
        stepsExhausted: true,
        continuationCount: 0,
      })
    ).toBe('steps-exhausted');
    expect(
      selectStreamContinuation({
        toolsChanged: false,
        stepsExhausted: false,
        continuationCount: 0,
      })
    ).toBeNull();
    expect(
      selectStreamContinuation({
        toolsChanged: true,
        stepsExhausted: true,
        continuationCount: MAX_AUTO_CONTINUATIONS,
      })
    ).toBeNull();
  });

  it('builds fixed product-authored continuation notices without external data', () => {
    const toolsChanged = toolsChangedContinuationMessage();
    expect(toolsChanged).toContain('not authored by the user');
    expect(toolsChanged).toContain('available tools were refreshed');

    expect(stepLimitContinuationMessage(15)).toContain('all 15 tool steps');
    expect(stepLimitContinuationMessage(undefined)).toContain('all 10 tool steps');
    expect(stepLimitContinuationMessage(15)).toContain('Do NOT call any more tools');
    expect(stepLimitContinuationMessage(15)).toContain('not authored by the user');
  });
});
