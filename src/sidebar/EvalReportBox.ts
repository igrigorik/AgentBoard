/**
 * EvalReportBox — UI component for displaying eval progress and results.
 * Rendered into the #messages container in the sidebar.
 */

import type { EvalProgress, EvalScenarioResult, EvalSuiteResult } from '../lib/eval/types';

export class EvalReportBox {
  private container: HTMLElement;
  private progressSection: HTMLElement;
  private progressBar: HTMLElement;
  private progressFill: HTMLElement;
  private progressLabel: HTMLElement;
  private scenarioList: HTMLElement;
  private summarySection: HTMLElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'eval-report-box';

    // Progress section
    this.progressSection = document.createElement('div');
    this.progressSection.className = 'eval-progress';

    this.progressLabel = document.createElement('div');
    this.progressLabel.className = 'eval-progress-label';
    this.progressLabel.textContent = 'Starting eval...';
    this.progressSection.appendChild(this.progressLabel);

    this.progressBar = document.createElement('div');
    this.progressBar.className = 'eval-progress-bar';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'eval-progress-fill';
    this.progressBar.appendChild(this.progressFill);
    this.progressSection.appendChild(this.progressBar);

    this.container.appendChild(this.progressSection);

    // Scenario list
    this.scenarioList = document.createElement('div');
    this.scenarioList.className = 'eval-scenario-list';
    this.container.appendChild(this.scenarioList);

    // Summary section (hidden until complete)
    this.summarySection = document.createElement('div');
    this.summarySection.className = 'eval-summary hidden';
    this.container.appendChild(this.summarySection);
  }

  getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Update the progress display.
   */
  updateProgress(progress: EvalProgress): void {
    const { phase, currentScenarioIndex, totalScenarios, currentScenarioId, scenarioResults } =
      progress;

    // Update progress bar
    const pct = totalScenarios > 0 ? (currentScenarioIndex / totalScenarios) * 100 : 0;
    this.progressFill.style.width = `${pct}%`;

    // Update label
    if (phase === 'complete') {
      this.progressLabel.textContent = `${totalScenarios}/${totalScenarios} — Complete`;
    } else {
      this.progressLabel.textContent = `${currentScenarioIndex}/${totalScenarios} — ${phase} ${currentScenarioId}`;
    }

    // Append newly completed scenarios
    const existingCount = this.scenarioList.children.length;
    for (let i = existingCount; i < scenarioResults.length; i++) {
      this.scenarioList.appendChild(this.createScenarioRow(scenarioResults[i]));
    }
  }

  /**
   * Show final summary.
   */
  showSummary(result: EvalSuiteResult): void {
    this.progressFill.style.width = '100%';
    this.progressLabel.textContent = `${result.summary.total}/${result.summary.total} — Complete`;

    const { summary } = result;

    this.summarySection.classList.remove('hidden');
    this.summarySection.innerHTML = `
      <div class="eval-summary-title">Summary — ${result.suiteName}</div>
      <div class="eval-summary-grid">
        <div class="eval-summary-stat">
          <span class="eval-stat-value">${summary.total}</span>
          <span class="eval-stat-label">Total</span>
        </div>
        <div class="eval-summary-stat eval-stat-pass">
          <span class="eval-stat-value">${summary.passed}</span>
          <span class="eval-stat-label">Passed</span>
        </div>
        <div class="eval-summary-stat eval-stat-fail">
          <span class="eval-stat-value">${summary.failed}</span>
          <span class="eval-stat-label">Failed</span>
        </div>
        <div class="eval-summary-stat eval-stat-error">
          <span class="eval-stat-value">${summary.errored}</span>
          <span class="eval-stat-label">Errors</span>
        </div>
      </div>
      <div class="eval-summary-scores">
        <div>Avg Tool Score: <strong>${(summary.avgToolCallScore * 100).toFixed(0)}%</strong></div>
        <div>Avg Judge Score: <strong>${(summary.avgJudgeScore * 100).toFixed(0)}%</strong></div>
        <div>Avg Combined: <strong>${(summary.avgCombinedScore * 100).toFixed(0)}%</strong></div>
        <div>Duration: <strong>${(result.totalDurationMs / 1000).toFixed(1)}s</strong></div>
      </div>
    `;
  }

  /**
   * Show an error that prevented the eval from running.
   */
  showError(message: string): void {
    this.progressLabel.textContent = 'Error';
    this.progressFill.style.width = '0%';

    const errorEl = document.createElement('div');
    errorEl.className = 'eval-error';
    errorEl.textContent = message;
    this.container.appendChild(errorEl);
  }

  private createScenarioRow(result: EvalScenarioResult): HTMLElement {
    const row = document.createElement('div');
    row.className = `eval-scenario-row eval-scenario-${result.status}`;

    // Header (always visible)
    const header = document.createElement('div');
    header.className = 'eval-scenario-header';
    header.style.cursor = 'pointer';

    const badge = document.createElement('span');
    badge.className = `eval-status-badge eval-badge-${result.status}`;
    badge.textContent = result.status.toUpperCase();
    header.appendChild(badge);

    // ID + prompt stacked vertically
    const idBlock = document.createElement('div');
    idBlock.className = 'eval-scenario-id-block';

    const id = document.createElement('div');
    id.className = 'eval-scenario-id';
    id.textContent = result.scenarioId;
    idBlock.appendChild(id);

    const prompt = document.createElement('div');
    prompt.className = 'eval-scenario-prompt';
    prompt.textContent = result.prompt;
    idBlock.appendChild(prompt);

    header.appendChild(idBlock);

    const score = document.createElement('span');
    score.className = 'eval-scenario-score';
    score.textContent = `${(result.combinedScore * 100).toFixed(0)}%`;
    header.appendChild(score);

    const duration = document.createElement('span');
    duration.className = 'eval-scenario-duration';
    duration.textContent = `${(result.durationMs / 1000).toFixed(1)}s`;
    header.appendChild(duration);

    const chevron = document.createElement('span');
    chevron.className = 'eval-chevron';
    chevron.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    header.appendChild(chevron);

    row.appendChild(header);

    // Details (collapsible)
    const details = document.createElement('div');
    details.className = 'eval-scenario-details';

    // Tool calls
    if (result.actualToolCalls.length > 0) {
      const toolCallsHtml = result.actualToolCalls
        .map((tc) => `<code>${escapeHtml(tc.toolName)}</code> (${tc.status})`)
        .join(', ');
      details.innerHTML += `<div class="eval-detail-row"><strong>Tool Calls:</strong> ${toolCallsHtml}</div>`;
    } else {
      details.innerHTML += `<div class="eval-detail-row"><strong>Tool Calls:</strong> <em>none</em></div>`;
    }

    // Tool score details
    const ts = result.toolCallScore;
    if (ts.expectedMissed.length > 0) {
      details.innerHTML += `<div class="eval-detail-row eval-detail-warn"><strong>Missing:</strong> ${ts.expectedMissed.map((t) => `<code>${escapeHtml(t)}</code>`).join(', ')}</div>`;
    }
    if (ts.forbiddenCalled.length > 0) {
      details.innerHTML += `<div class="eval-detail-row eval-detail-error"><strong>Forbidden:</strong> ${ts.forbiddenCalled.map((t) => `<code>${escapeHtml(t)}</code>`).join(', ')}</div>`;
    }

    // Judge verdict
    if (result.judgeScore) {
      const js = result.judgeScore;
      details.innerHTML += `<div class="eval-detail-row"><strong>Judge:</strong> ${escapeHtml(js.verdict)} (${(js.score * 100).toFixed(0)}%) — ${escapeHtml(js.reasoning)}</div>`;
    }

    // Error
    if (result.error) {
      details.innerHTML += `<div class="eval-detail-row eval-detail-error"><strong>Error:</strong> ${escapeHtml(result.error)}</div>`;
    }

    row.appendChild(details);

    // Toggle expand/collapse
    let expanded = false;
    header.addEventListener('click', () => {
      expanded = !expanded;
      row.classList.toggle('expanded', expanded);
    });

    return row;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
