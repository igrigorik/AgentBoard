/**
 * EvalRunner orchestrates batch evaluation of an eval suite.
 * Runs each scenario sequentially: navigate → clear → prompt → extract → score → judge.
 */

import type { ChatMessage, ToolCall } from '../../types';
import type {
  EvalSuite,
  EvalScenario,
  EvalScenarioResult,
  EvalSuiteResult,
  EvalProgress,
  EvalPhase,
  JudgeScore,
} from './types';
import { scoreToolCalls, combinedScore } from './scoring';

const DEFAULT_TIMEOUT_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const SETTLE_MS = 200;

/**
 * Interface for sidebar internals to avoid circular deps.
 * The sidebar creates an adapter implementing this.
 */
export interface SidebarInterface {
  attachedTabId: number | null;
  currentAgentId: string | null;
  getMessageHistory(): ChatMessage[];
  clearConversation(): void;
  sendMessage(text: string): Promise<void>;
}

export class EvalRunner {
  private sidebar: SidebarInterface;
  private aborted = false;
  private onProgress: ((progress: EvalProgress) => void) | null = null;

  constructor(sidebar: SidebarInterface) {
    this.sidebar = sidebar;
  }

  /**
   * Set progress callback (called after each scenario completes).
   */
  setProgressCallback(cb: (progress: EvalProgress) => void): void {
    this.onProgress = cb;
  }

  /**
   * Abort the current eval run.
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Run all scenarios in the suite sequentially.
   */
  async run(suite: EvalSuite): Promise<EvalSuiteResult> {
    this.aborted = false;
    const startTime = Date.now();
    const scenarioResults: EvalScenarioResult[] = [];

    for (let i = 0; i < suite.scenarios.length; i++) {
      if (this.aborted) break;

      const scenario = suite.scenarios[i];
      this.emitProgress('loading', i, suite.scenarios.length, scenario.id, scenarioResults);

      const result = await this.runScenario(scenario, suite, i);
      scenarioResults.push(result);

      this.emitProgress('scoring', i + 1, suite.scenarios.length, scenario.id, scenarioResults);
    }

    const endTime = Date.now();
    this.emitProgress(
      'complete',
      suite.scenarios.length,
      suite.scenarios.length,
      '',
      scenarioResults
    );

    return this.buildSuiteResult(suite.name, startTime, endTime, scenarioResults);
  }

  private async runScenario(
    scenario: EvalScenario,
    suite: EvalSuite,
    index: number
  ): Promise<EvalScenarioResult> {
    const scenarioStart = Date.now();
    const timeoutMs = scenario.timeoutMs || DEFAULT_TIMEOUT_MS;

    try {
      return await this.withTimeout(
        this.executeScenario(scenario, suite, index),
        timeoutMs,
        `Scenario "${scenario.id}" timed out after ${timeoutMs}ms`
      );
    } catch (error) {
      return {
        scenarioId: scenario.id,
        prompt: scenario.prompt,
        status: 'error',
        durationMs: Date.now() - scenarioStart,
        toolCallScore: {
          score: 0,
          expectedCalled: [],
          expectedMissed: [],
          forbiddenCalled: [],
          unexpectedCalls: [],
        },
        judgeScore: null,
        combinedScore: 0,
        actualToolCalls: [],
        assistantResponse: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeScenario(
    scenario: EvalScenario,
    suite: EvalSuite,
    index: number
  ): Promise<EvalScenarioResult> {
    const scenarioStart = Date.now();

    // 1. Navigate if startPage is set
    if (scenario.startPage && this.sidebar.attachedTabId) {
      this.emitProgress('navigating', index, suite.scenarios.length, scenario.id, []);
      const baseUrl = suite.baseUrl || '';
      const fullUrl = scenario.startPage.startsWith('http')
        ? scenario.startPage
        : baseUrl + scenario.startPage;

      await this.navigateTab(this.sidebar.attachedTabId, fullUrl);
    }

    // 2. Clear conversation
    this.emitProgress('clearing', index, suite.scenarios.length, scenario.id, []);
    this.sidebar.clearConversation();
    await this.sleep(SETTLE_MS);

    // 3. Send prompt and wait for completion
    this.emitProgress('prompting', index, suite.scenarios.length, scenario.id, []);
    await this.sidebar.sendMessage(scenario.prompt);

    // 4. Extract results from message history
    const history = this.sidebar.getMessageHistory();
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    const assistantResponse =
      typeof lastAssistant?.content === 'string'
        ? lastAssistant.content
        : lastAssistant?.content
            ?.filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('') || '';

    // Collect all tool calls from assistant messages
    const allToolCalls: ToolCall[] = [];
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        allToolCalls.push(...msg.toolCalls);
      }
    }

    const actualToolCallNames = allToolCalls.map((tc) => tc.toolName);
    const actualToolCallDetails = allToolCalls.map((tc) => ({
      toolName: tc.toolName,
      input: tc.input,
      output: tc.output,
      status: tc.status,
    }));

    // 5. Score tool calls
    const toolScore = scoreToolCalls(
      actualToolCallNames,
      scenario.expectations.toolCalls,
      scenario.expectations.forbiddenToolCalls
    );

    // 6. Judge (if post-conditions defined)
    let judgeResult: JudgeScore | null = null;
    if (scenario.expectations.postConditions && this.sidebar.currentAgentId) {
      this.emitProgress('judging', index, suite.scenarios.length, scenario.id, []);
      judgeResult = await this.runJudge(
        scenario.prompt,
        assistantResponse,
        actualToolCallDetails,
        scenario.expectations.postConditions
      );
    }

    // 7. Compute combined score
    const combined = combinedScore(toolScore, judgeResult);
    const status = combined >= 0.5 ? 'pass' : 'fail';

    return {
      scenarioId: scenario.id,
      prompt: scenario.prompt,
      status,
      durationMs: Date.now() - scenarioStart,
      toolCallScore: toolScore,
      judgeScore: judgeResult,
      combinedScore: combined,
      actualToolCalls: actualToolCallDetails,
      assistantResponse,
    };
  }

  private async navigateTab(tabId: number, url: string): Promise<void> {
    await chrome.tabs.update(tabId, { url });

    // Wait for WEBMCP_TOOLS_CHANGED or fall back after webNavigation completes
    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(onMessage);
          resolve();
        }
      };

      // Listen for tools changed signal (ideal)
      const onMessage = (msg: { type: string; tabId?: number }) => {
        if (msg.type === 'WEBMCP_TOOLS_CHANGED' && msg.tabId === tabId) {
          done();
        }
      };
      chrome.runtime.onMessage.addListener(onMessage);

      // Fallback: wait for tab to finish loading + 3s settle
      chrome.tabs.onUpdated.addListener(function onUpdated(
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo
      ) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          setTimeout(done, 3000);
        }
      });

      // Hard timeout
      setTimeout(done, NAVIGATION_TIMEOUT_MS);
    });
  }

  private async runJudge(
    prompt: string,
    assistantResponse: string,
    toolCalls: Array<{ toolName: string; input: unknown; output: unknown; status: string }>,
    postConditions: string
  ): Promise<JudgeScore> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'EVAL_JUDGE',
        agentId: this.sidebar.currentAgentId,
        prompt,
        assistantResponse,
        toolCalls,
        postConditions,
      });

      if (response?.success) {
        return {
          score: typeof response.score === 'number' ? response.score : 0,
          verdict: response.verdict || 'fail',
          reasoning: response.reasoning || '',
        };
      }

      return { score: 0, verdict: 'fail', reasoning: 'Judge call failed' };
    } catch (error) {
      return {
        score: 0,
        verdict: 'fail',
        reasoning: `Judge error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private buildSuiteResult(
    suiteName: string,
    startTime: number,
    endTime: number,
    scenarios: EvalScenarioResult[]
  ): EvalSuiteResult {
    const passed = scenarios.filter((s) => s.status === 'pass').length;
    const failed = scenarios.filter((s) => s.status === 'fail').length;
    const errored = scenarios.filter((s) => s.status === 'error').length;

    const toolScores = scenarios.map((s) => s.toolCallScore.score);
    const judgeScores = scenarios
      .filter((s): s is EvalScenarioResult & { judgeScore: JudgeScore } => s.judgeScore !== null)
      .map((s) => s.judgeScore.score);
    const combinedScores = scenarios.map((s) => s.combinedScore);

    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      suiteName,
      startTime,
      endTime,
      totalDurationMs: endTime - startTime,
      scenarios,
      summary: {
        total: scenarios.length,
        passed,
        failed,
        errored,
        avgToolCallScore: Math.round(avg(toolScores) * 1000) / 1000,
        avgJudgeScore: Math.round(avg(judgeScores) * 1000) / 1000,
        avgCombinedScore: Math.round(avg(combinedScores) * 1000) / 1000,
      },
    };
  }

  private emitProgress(
    phase: EvalPhase,
    currentIndex: number,
    total: number,
    scenarioId: string,
    results: EvalScenarioResult[]
  ): void {
    this.onProgress?.({
      phase,
      currentScenarioIndex: currentIndex,
      totalScenarios: total,
      currentScenarioId: scenarioId,
      scenarioResults: [...results],
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
  }
}
