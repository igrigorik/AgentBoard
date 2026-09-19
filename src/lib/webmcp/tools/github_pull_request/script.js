'use webmcp-tool v1';

export const metadata = {
  name: 'github_pull_request',
  namespace: 'agentboard',
  version: '1.0.0',
  description:
    'Read structured context for the pull request in this tab: changed files, review threads with line anchors, and code changes paged by file. Use agentboard_read_page for the PR description and general conversation.',
  match: ['https://github.com/*/*/pull/*'],
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        items: { type: 'string', enum: ['files', 'threads', 'diff'] },
        description:
          'Sections to return besides the PR header. Default is all three. Omit diff for a cheap overview - omit threads when only the code matters.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Restrict the code changes to these paths or globs, for example src/**/*.ts or README.md. The files table is always complete regardless of this filter.',
      },
      unresolvedOnly: {
        type: 'boolean',
        description: 'Return only review threads that are still open. Default is false.',
      },
      maxLength: {
        type: 'integer',
        minimum: 1000,
        maximum: 200000,
        default: 32000,
        description:
          'Maximum characters of code-change text. Files are included whole, in table order, until the budget would be exceeded - the response reports where it stopped. Default is 32000.',
      },
      startAfter: {
        type: 'string',
        description:
          'Continue the code changes after this path in table order. Use the path from the previous response diffTruncated.after.',
      },
    },
    additionalProperties: false,
  },
};

// GitHub's "Files changed" app answers these routes as JSON only when both headers are present;
// without X-Requested-With it returns 406. These are GitHub-internal contracts, so every section
// below degrades independently instead of taking the tool down with it.
const JSON_HEADERS = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const SECTIONS = ['files', 'threads', 'diff'];
const DEFAULT_MAX_LENGTH = 32_000;
const MIN_MAX_LENGTH = 1_000;
const MAX_MAX_LENGTH = 200_000;
// The app itself batches diff entries a few files at a time; larger batches risk URL-length limits.
const DIFF_ENTRY_BATCH = 10;

export async function execute(args = {}, { signal } = {}) {
  signal?.throwIfAborted();
  const target = resolveTarget(window.location);
  if (!target) throw new Error('Not on a GitHub pull request page.');
  const options = normalizeOptions(args);

  const route = await fetchChangesRoute(target, signal);
  const result = { pr: buildHeader(target, route) };
  const unavailable = [];
  const wantFiles = options.include.has('files') || options.include.has('diff');

  let table = null;
  if (wantFiles) {
    try {
      table = buildFilesTable(route.diffSummaries);
      if (options.include.has('files')) result.files = table;
    } catch {
      if (options.include.has('files')) unavailable.push('files');
      if (options.include.has('diff')) unavailable.push('diff');
    }
  }

  if (options.include.has('threads')) {
    try {
      const anchors = threadAnchors(route.diffSummaries);
      const built = buildThreads(route.markers, anchors, options.unresolvedOnly, result.pr.url);
      result.threads = built.threads;
      if (built.truncated) result.threadsTruncated = true;
    } catch {
      unavailable.push('threads');
    }
  }

  if (options.include.has('diff') && table) {
    if (options.startAfter && !table.some((row) => row.path === options.startAfter)) {
      throw new Error(`startAfter path is not in this pull request: ${options.startAfter}`);
    }
    let included = new Set();
    try {
      const diff = await buildDiffPage(target, route.diffContents ?? [], table, options, signal);
      result.diff = diff.text;
      result.diffTruncated = diff.truncated;
      included = diff.included;
    } catch (error) {
      if (signal?.aborted) throw error;
      unavailable.push('diff');
    }
    for (const row of table) row.inDiff = included.has(row.path);
  }

  if (unavailable.length) result.unavailable = unavailable;
  return result;
}

/** Owner, repo, and number come only from the tab URL; nothing model-supplied names the target. */
function resolveTarget(location) {
  if (location.hostname !== 'github.com') return null;
  const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number), base: `/${owner}/${repo}/pull/${number}` };
}

/** The tool owns its argument contract; AgentBoard forwards model arguments as written. */
function normalizeOptions(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Invalid arguments: expected an object.');
  }
  const { include, files, unresolvedOnly, maxLength, startAfter } = args;

  let sections = SECTIONS;
  if (include !== undefined) {
    if (!Array.isArray(include) || include.some((s) => !SECTIONS.includes(s))) {
      throw new Error(`Invalid arguments: include must be an array of ${SECTIONS.join(', ')}.`);
    }
    sections = include;
  }
  if (
    files !== undefined &&
    (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== 'string' || !f))
  ) {
    throw new Error('Invalid arguments: files must be a non-empty array of path or glob strings.');
  }
  if (unresolvedOnly !== undefined && typeof unresolvedOnly !== 'boolean') {
    throw new Error('Invalid arguments: unresolvedOnly must be a boolean.');
  }
  if (
    maxLength !== undefined &&
    (!Number.isInteger(maxLength) || maxLength < MIN_MAX_LENGTH || maxLength > MAX_MAX_LENGTH)
  ) {
    throw new Error(
      `Invalid arguments: maxLength must be an integer between ${MIN_MAX_LENGTH} and ${MAX_MAX_LENGTH}.`
    );
  }
  if (startAfter !== undefined && (typeof startAfter !== 'string' || !startAfter)) {
    throw new Error('Invalid arguments: startAfter must be a non-empty path.');
  }

  return {
    include: new Set(sections),
    fileMatchers: files ? files.map(globToRegExp) : null,
    unresolvedOnly: unresolvedOnly === true,
    maxLength: maxLength ?? DEFAULT_MAX_LENGTH,
    startAfter: startAfter ?? null,
  };
}

async function fetchJson(path, signal) {
  const response = await fetch(path, { credentials: 'same-origin', headers: JSON_HEADERS, signal });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${path}`);
  return response.json();
}

async function fetchChangesRoute(target, signal) {
  let payload;
  try {
    payload = await fetchJson(`${target.base}/changes`, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // A 406 means this account is not on the React "Files changed" experience and nothing
    // structured is reachable; other failures are transient. Either way, name the cause.
    throw new Error(
      `Structured pull request data is unavailable for this page or account (${error.message}); use agentboard_read_page instead.`
    );
  }
  const route = payload?.payload?.pullRequestsChangesRoute;
  if (!route || !route.pullRequest || !Array.isArray(route.diffSummaries)) {
    throw new Error(
      'Structured pull request data is unavailable for this page or account; use agentboard_read_page instead.'
    );
  }
  return route;
}

function buildHeader(target, route) {
  const pr = route.pullRequest;
  // GitHub has served the comparison under both keys on different pull requests.
  const comparison = route.comparison?.fullDiff ?? pr.comparison ?? {};
  const header = {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    url: `${window.location.origin}${target.base}`,
    title: pr.title ?? '',
    state: String(pr.state ?? 'unknown').toLowerCase(),
    author: pr.author?.login ?? null,
    baseBranch: pr.baseBranch ?? null,
    headBranch: pr.headBranch ?? null,
    baseSha: comparison.baseOid ?? null,
    headSha: comparison.headOid ?? null,
    commitsCount: pr.commitsCount ?? null,
    commentsCount: pr.issueCommentsCount ?? null,
  };
  if (pr.headRepositoryOwnerLogin && pr.headRepositoryOwnerLogin !== target.owner) {
    header.headRepository = `${pr.headRepositoryOwnerLogin}/${pr.headRepositoryName}`;
  }
  if (pr.mergedTime) {
    header.mergedAt = pr.mergedTime;
    header.mergedBy = pr.mergedBy ?? null;
  }
  // The document's embedded layout data carries timestamps this route omits. It describes the
  // PR the document was loaded for, which may differ from the URL after in-app navigation.
  const layout = embeddedLayoutPullRequest();
  if (layout && layout.number === target.number) {
    if (layout.createdTime) header.createdAt = layout.createdTime;
    if (layout.closedTime) header.closedAt = layout.closedTime;
  }
  return header;
}

function embeddedLayoutPullRequest() {
  try {
    const script = document.querySelector('script[data-target="react-app.embeddedData"]');
    return (
      JSON.parse(script?.textContent ?? 'null')?.payload?.pullRequestsLayoutRoute?.pullRequest ??
      null
    );
  } catch {
    return null;
  }
}

function buildFilesTable(summaries) {
  return summaries.map((summary) => {
    const row = {
      path: summary.path,
      status: String(summary.changeType ?? 'modified').toLowerCase(),
      additions: summary.linesAdded ?? 0,
      deletions: summary.linesDeleted ?? 0,
    };
    if (summary.isVendored) row.vendored = true;
    if (summary.isSymlink) row.symlink = true;
    return row;
  });
}

/**
 * markersMap keys are side+line on the current diff ("R349", "L12") and list the threads anchored
 * there. Threads left on superseded commits have no entry, which is how GitHub marks them outdated.
 */
function threadAnchors(summaries) {
  const anchors = new Map();
  for (const summary of summaries) {
    for (const [key, marker] of Object.entries(summary.markersMap ?? {})) {
      const position = parsePosition(key);
      if (!position) continue;
      for (const thread of marker.threads ?? []) {
        const anchor = { path: summary.path, side: position.side, line: position.line };
        const start = thread.start ? parsePosition(thread.start) : null;
        if (start && start.line !== position.line) anchor.startLine = start.line;
        anchors.set(String(thread.id), anchor);
      }
    }
  }
  return anchors;
}

function parsePosition(key) {
  const match = /^([LR])(\d+)$/.exec(String(key));
  if (!match) return null;
  return { side: match[1] === 'L' ? 'left' : 'right', line: Number(match[2]) };
}

function buildThreads(markers, anchors, unresolvedOnly, prUrl) {
  const source = markers?.threads ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Unexpected threads shape');
  }
  const threads = [];
  for (const thread of Object.values(source)) {
    // One malformed thread is skipped; only a malformed container fails the section.
    const comments = thread?.commentsData?.comments;
    if (!thread || !Array.isArray(comments)) continue;
    const resolved = thread.isResolved === true;
    if (unresolvedOnly && resolved) continue;
    const first = comments[0];
    const entry = {
      id: String(thread.id),
      resolved,
      anchor: anchors.get(String(thread.id)) ?? null,
      permalink:
        first?.url ?? (first?.databaseId ? `${prUrl}#discussion_r${first.databaseId}` : prUrl),
      comments: comments.map((comment) => ({
        author: comment.author?.login ?? null,
        at: comment.createdAt ?? null,
        body: comment.body ?? '',
      })),
    };
    if (resolved && thread.resolvedBy) entry.resolvedBy = thread.resolvedBy;
    if (thread.pullRequestReviewId) entry.reviewId = String(thread.pullRequestReviewId);
    if (thread.reviewCommentsLimitExceeded) entry.commentsTruncated = true;
    threads.push(entry);
  }
  // Timestamps carry the viewer's UTC offset, so compare instants rather than strings.
  const startedAt = (thread) => Date.parse(thread.comments[0]?.at) || 0;
  threads.sort((a, b) => startedAt(a) - startedAt(b));
  return { threads, truncated: markers?.threadsPageInfo?.hasNextPage === true };
}

/**
 * Page GitHub's diff lines on whole-file boundaries. A file is only fetched once the loop reaches
 * it and it can still fit: every changed line is at least two characters, so
 * 2 x (additions + deletions) is a request-free lower bound on its rendered size.
 */
async function buildDiffPage(target, diffContents, table, options, signal) {
  let candidates = options.startAfter
    ? table.slice(table.findIndex((row) => row.path === options.startAfter) + 1)
    : table;
  if (options.fileMatchers) {
    candidates = candidates.filter((row) => options.fileMatchers.some((m) => m.test(row.path)));
  }

  const entries = new Map(diffContents.map((entry) => [entry.path, entry]));
  const included = new Set();
  const chunks = [];
  let used = 0;
  let clippedFile = null;
  let index = 0;

  for (; index < candidates.length; index++) {
    signal?.throwIfAborted();
    const row = candidates[index];
    if (used > 0 && used + 2 * (row.additions + row.deletions) > options.maxLength) break;

    if (!entries.has(row.path)) {
      const missing = candidates
        .slice(index, index + DIFF_ENTRY_BATCH)
        .map((candidate) => candidate.path)
        .filter((path) => !entries.has(path));
      try {
        for (const entry of await fetchDiffEntries(target, missing, signal)) {
          entries.set(entry.path, entry);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // Record the miss so the batch is not retried per file; each renders as a visible gap.
        for (const path of missing) if (!entries.has(path)) entries.set(path, undefined);
      }
    }
    let entry = entries.get(row.path);
    if (entry?.isTooBig && !entry.isBinary && !entry.diffLines?.length) {
      try {
        entry = { ...entry, diffLines: await fetchDiffEntryLines(target, row.path, signal) };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Leave it collapsed; the rendered file note says how to request it alone.
      }
    }

    let text = renderFileChanges(row, entry);
    if (used > 0 && used + text.length > options.maxLength) break;
    if (text.length > options.maxLength) {
      // Larger than the whole budget on its own: return what fits and say so.
      text = clipToBudget(text, options.maxLength);
      clippedFile = row.path;
    }
    chunks.push(text);
    used += text.length;
    included.add(row.path);
    if (clippedFile) {
      index++;
      break;
    }
  }

  const remaining = candidates.length - index;
  let truncated = null;
  if (remaining > 0 || clippedFile) {
    truncated = { after: [...included].at(-1) ?? null, remainingFiles: remaining };
    if (clippedFile) truncated.clippedFile = clippedFile;
  }
  return { text: chunks.join(''), truncated, included };
}

/** Cut on a line boundary and keep the marker inside the budget so maxLength means what it says. */
function clipToBudget(text, maxLength) {
  const marker = `\n... [truncated: this file exceeds maxLength ${maxLength}]\n`;
  const budget = Math.max(0, maxLength - marker.length);
  const cut = text.lastIndexOf('\n', budget);
  return text.slice(0, cut > 0 ? cut : budget) + marker;
}

async function fetchDiffEntries(target, paths, signal) {
  const query = encodeURIComponent(paths.map(encodeURIComponent).join(','));
  const entries = await fetchJson(`${target.base}/page_data/diff_entries?paths=${query}`, signal);
  if (!Array.isArray(entries)) throw new Error('Unexpected diff_entries response');
  return entries;
}

async function fetchDiffEntryLines(target, path, signal) {
  const payload = await fetchJson(
    `${target.base}/page_data/diff_entry_lines?path=${encodeURIComponent(path)}`,
    signal
  );
  const lines = payload?.diffEntryLines;
  if (!Array.isArray(lines)) throw new Error('Unexpected diff_entry_lines response');
  return lines;
}

/** Render GitHub's lines with explicit, non-patch file context and non-text states. */
function renderFileChanges(row, entry) {
  const lines = [`File: ${row.path} (${row.status})`];

  if (!entry) {
    lines.push('(changes unavailable for this file)');
  } else if (entry.isBinary) {
    lines.push('(binary file changed)');
  } else if (entry.isSubmodule) {
    lines.push(`(submodule updated to ${entry.newCommitOid ?? 'an unknown commit'})`);
  } else if (!entry.diffLines?.length) {
    lines.push(
      entry.isTooBig
        ? '(changes too large to load; request this file alone with a larger maxLength)'
        : '(no textual changes)'
    );
  } else {
    for (const line of entry.diffLines) {
      lines.push(line.text ?? '');
      if (line.displayNoNewLineWarning) lines.push('\\ No newline at end of file');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Minimal glob: ** crosses directories, * and ? stay within one segment; anything else is literal. */
function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" also matches zero directories so "src/**/*.ts" covers "src/a.ts".
        const slash = pattern[i + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}
