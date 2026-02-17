/**
 * Pure scoring functions for eval scenarios.
 * No side effects — suitable for unit testing.
 */

import type { ToolCallScore, JudgeScore } from './types';

/**
 * Score tool call accuracy against expectations.
 *
 * Score = (expected tools called / total expected) minus 0.5 penalty if any forbidden tool called.
 * Empty expectations = 1.0 (vacuously true).
 */
export function scoreToolCalls(
  actualCalls: string[],
  expectedToolCalls?: string[],
  forbiddenToolCalls?: string[]
): ToolCallScore {
  const actualSet = new Set(actualCalls);

  const expectedCalled: string[] = [];
  const expectedMissed: string[] = [];

  if (expectedToolCalls && expectedToolCalls.length > 0) {
    for (const expected of expectedToolCalls) {
      if (actualSet.has(expected)) {
        expectedCalled.push(expected);
      } else {
        expectedMissed.push(expected);
      }
    }
  }

  const forbiddenCalled: string[] = [];
  if (forbiddenToolCalls) {
    for (const forbidden of forbiddenToolCalls) {
      if (actualSet.has(forbidden)) {
        forbiddenCalled.push(forbidden);
      }
    }
  }

  // Unexpected = actual calls not in expected (informational, no penalty)
  const expectedSet = new Set(expectedToolCalls || []);
  const unexpectedCalls = actualCalls.filter((c) => !expectedSet.has(c));

  // Calculate score
  let score: number;
  if (!expectedToolCalls || expectedToolCalls.length === 0) {
    // No expectations → vacuously true
    score = 1.0;
  } else {
    score = expectedCalled.length / expectedToolCalls.length;
  }

  // Apply forbidden penalty
  if (forbiddenCalled.length > 0) {
    score = Math.max(0, score - 0.5);
  }

  return {
    score: Math.round(score * 1000) / 1000,
    expectedCalled,
    expectedMissed,
    forbiddenCalled,
    unexpectedCalls,
  };
}

/**
 * Combine tool call score and judge score into a single number.
 *
 * Both present: 40% tool calls + 60% judge.
 * Only one present: 100% of that score.
 */
export function combinedScore(toolCallScore: ToolCallScore, judgeScore: JudgeScore | null): number {
  if (judgeScore !== null) {
    const combined = 0.4 * toolCallScore.score + 0.6 * judgeScore.score;
    return Math.round(combined * 1000) / 1000;
  }
  return toolCallScore.score;
}
