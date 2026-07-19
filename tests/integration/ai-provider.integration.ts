// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createAIIntegrationSchedule,
  formatAIIntegrationPreflight,
  formatAIIntegrationSummary,
  runAIIntegrationTarget,
  shouldRunAIIntegration,
  type AIIntegrationResult,
} from './ai-provider-runner';

const schedule = createAIIntegrationSchedule();
const runEnabled = shouldRunAIIntegration();
const results: AIIntegrationResult[] = [];

function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

describe.sequential('AI provider integration', () => {
  if (!runEnabled) {
    it('prints the zero-network request schedule', () => {
      process.stdout.write(`${formatAIIntegrationPreflight(schedule)}\n`);
      expect(schedule.length).toBeGreaterThan(0);
    });
    return;
  }

  it('runs the confirmed target schedule sequentially', async () => {
    for (const target of schedule) {
      const result = await runAIIntegrationTarget(target);
      results.push(result);
      expect(result).toEqual({
        targetId: target.id,
        apiProtocol: target.apiProtocol,
        success: true,
        evidence: 'tool-call',
      });
    }
  });
});

afterAll(() => {
  if (!runEnabled) return;
  process.stdout.write(
    `${formatAIIntegrationSummary({
      commit: currentCommit(),
      timestamp: new Date().toISOString(),
      results,
    })}\n`
  );
});
