/**
 * Type definitions for the eval system.
 * Eval suites test whether tool definitions lead to correct agent behavior.
 */

// --- Suite & Scenario Definitions ---

export interface EvalSuite {
  name: string;
  description?: string;
  baseUrl?: string;
  scenarios: EvalScenario[];
}

export interface EvalScenario {
  id: string;
  prompt: string;
  startPage?: string;
  expectations: EvalExpectations;
  tags?: string[];
  timeoutMs?: number;
}

export interface EvalExpectations {
  toolCalls?: string[];
  forbiddenToolCalls?: string[];
  postConditions?: string;
}

export interface StoredEvalSuite extends EvalSuite {
  id: string;
  fileName?: string;
  importedAt: number;
}

// --- Scoring ---

export interface ToolCallScore {
  score: number;
  expectedCalled: string[];
  expectedMissed: string[];
  forbiddenCalled: string[];
  unexpectedCalls: string[];
}

export interface JudgeScore {
  score: number;
  verdict: string;
  reasoning: string;
}

// --- Results ---

export interface EvalScenarioResult {
  scenarioId: string;
  prompt: string;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  toolCallScore: ToolCallScore;
  judgeScore: JudgeScore | null;
  combinedScore: number;
  actualToolCalls: Array<{ toolName: string; input: unknown; output: unknown; status: string }>;
  assistantResponse: string;
  error?: string;
}

export interface EvalSuiteResult {
  suiteName: string;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  scenarios: EvalScenarioResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    avgToolCallScore: number;
    avgJudgeScore: number;
    avgCombinedScore: number;
  };
}

// --- Progress Tracking ---

export type EvalPhase =
  | 'loading'
  | 'navigating'
  | 'clearing'
  | 'prompting'
  | 'judging'
  | 'scoring'
  | 'complete'
  | 'error';

export interface EvalProgress {
  phase: EvalPhase;
  currentScenarioIndex: number;
  totalScenarios: number;
  currentScenarioId: string;
  scenarioResults: EvalScenarioResult[];
}
