// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://github.com/acme/widgets/pull/150/changes" }
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  execute,
  metadata,
  type GitHubPullRequestArguments,
  type GitHubPullRequestResult,
} from '../src/lib/webmcp/tools/github_pull_request/script.js';

/** Tests request known sections; assert them present so the typed result reads cleanly. */
const run = async (args?: GitHubPullRequestArguments) =>
  (await execute(args)) as Required<GitHubPullRequestResult>;
import { parseUserScript } from '../src/lib/webmcp/script-parser';

const BASE = '/acme/widgets/pull/150';

/** Fixtures mirror the shapes GitHub's "Files changed" app returned on 2026-09-16. */
function line(
  type: string,
  text: string,
  left: number,
  right: number,
  extra: Record<string, unknown> = {}
) {
  return {
    type,
    text,
    left,
    right,
    blobLineNumber: right,
    position: 0,
    displayNoNewLineWarning: false,
    html: text,
    problems: [],
    ...extra,
  };
}

function entry(path: string, diffLines: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    path,
    status: 'MODIFIED',
    isBinary: false,
    isSubmodule: false,
    isTooBig: false,
    diffLines,
    linesAdded: 1,
    linesDeleted: 1,
    truncatedReason: null,
    ...overrides,
  };
}

const ENTRIES: Record<string, unknown> = {
  'a.ts': entry('a.ts', [
    line('HUNK', '@@ -1,3 +1,3 @@', 0, 0),
    line('CONTEXT', ' const a = 1;', 1, 1),
    line('DELETION', '-const b = 2;', 2, 1),
    line('ADDITION', '+const b = 3;', 2, 2),
    line('CONTEXT', ' export { a, b };', 3, 3, { displayNoNewLineWarning: true }),
  ]),
  'dir/b.ts': entry(
    'dir/b.ts',
    [
      line('HUNK', '@@ -0,0 +1,2 @@', 0, 0),
      line('ADDITION', '+export const b = 1;', 0, 1),
      line('ADDITION', '+export const c = 2;', 0, 2),
    ],
    { status: 'ADDED', linesAdded: 2, linesDeleted: 0 }
  ),
  'big.rs': entry('big.rs', [], {
    status: 'ADDED',
    isTooBig: true,
    linesAdded: 2,
    linesDeleted: 0,
  }),
  'logo.png': entry('logo.png', [], {
    status: 'ADDED',
    isBinary: true,
    linesAdded: 0,
    linesDeleted: 0,
  }),
  'README.md': entry('README.md', [
    line('HUNK', '@@ -1 +1 @@', 0, 0),
    line('DELETION', '-Old', 1, 0),
    line('ADDITION', '+New', 1, 1),
  ]),
};

const BIG_LINES = [
  line('HUNK', '@@ -0,0 +1,2 @@', 0, 0),
  line('ADDITION', '+fn main() {}', 0, 1),
  line('ADDITION', '+fn other() {}', 0, 2),
];

function changesPayload(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      pullRequestsChangesRoute: {
        pullRequest: {
          title: 'Capture WAL changes',
          state: 'MERGED',
          author: { login: 'xiaoli', isAgent: false },
          baseBranch: 'main',
          headBranch: 'feature/wal',
          headRepositoryOwnerLogin: 'acme',
          headRepositoryName: 'widgets',
          commitsCount: 1,
          issueCommentsCount: 23,
          mergedTime: '2026-09-16T12:40:25-07:00',
          mergedBy: 'xiaoli',
        },
        comparison: { fullDiff: { baseOid: 'b'.repeat(40), headOid: 'h'.repeat(40) } },
        diffSummaries: [
          {
            path: 'a.ts',
            changeType: 'MODIFIED',
            linesAdded: 1,
            linesDeleted: 1,
            isVendored: false,
            markersMap: { R2: { threads: [{ id: 1001 }], annotations: [], ctx: [1, 3] } },
          },
          {
            path: 'dir/b.ts',
            changeType: 'ADDED',
            linesAdded: 2,
            linesDeleted: 0,
            isVendored: false,
            markersMap: {},
          },
          {
            path: 'big.rs',
            changeType: 'ADDED',
            linesAdded: 2,
            linesDeleted: 0,
            isVendored: false,
            markersMap: {},
          },
          {
            path: 'logo.png',
            changeType: 'ADDED',
            linesAdded: 0,
            linesDeleted: 0,
            isVendored: false,
            markersMap: {},
          },
          {
            path: 'README.md',
            changeType: 'MODIFIED',
            linesAdded: 1,
            linesDeleted: 1,
            isVendored: true,
            markersMap: {
              L1: { threads: [{ id: 1003, start: 'L1' }], annotations: [], ctx: [1, 1] },
            },
          },
        ],
        diffContents: [ENTRIES['a.ts'], ENTRIES['dir/b.ts']],
        markers: {
          threads: {
            1001: {
              id: '1001',
              subjectType: 'LINE',
              isResolved: false,
              resolvedBy: null,
              pullRequestReviewId: 5181914191,
              reviewCommentsLimitExceeded: false,
              commentsData: {
                comments: [
                  {
                    author: { login: 'reviewer' },
                    createdAt: '2026-09-11T01:45:04-07:00',
                    body: '**[P1]** Use 3 here.',
                    databaseId: 3991990443,
                    url: `https://github.com${BASE}#discussion_r3991990443`,
                  },
                  {
                    author: { login: 'xiaoli' },
                    createdAt: '2026-09-11T11:00:00-07:00',
                    body: 'Done.',
                    databaseId: 3992168788,
                    url: `https://github.com${BASE}#discussion_r3992168788`,
                  },
                ],
              },
            },
            1002: {
              id: '1002',
              subjectType: 'LINE',
              isResolved: true,
              resolvedBy: 'xiaoli',
              pullRequestReviewId: 5181914191,
              reviewCommentsLimitExceeded: true,
              commentsData: {
                comments: [
                  {
                    author: { login: 'reviewer' },
                    createdAt: '2026-09-11T01:15:00-08:00',
                    body: 'Outdated remark.',
                    databaseId: 1,
                    url: `https://github.com${BASE}#discussion_r1`,
                  },
                ],
              },
            },
            1003: {
              id: '1003',
              subjectType: 'LINE',
              isResolved: true,
              resolvedBy: 'reviewer',
              pullRequestReviewId: 5181914192,
              reviewCommentsLimitExceeded: false,
              commentsData: {
                comments: [
                  {
                    author: { login: 'reviewer' },
                    createdAt: '2026-09-12T09:00:00-07:00',
                    body: 'Left side.',
                    databaseId: 2,
                    url: `https://github.com${BASE}#discussion_r2`,
                  },
                ],
              },
            },
          },
          threadsPageInfo: { hasNextPage: false, cursor: null },
          annotations: {},
        },
        ...overrides,
      },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let requests: Array<{ url: string; headers: Record<string, string> }>;

const generated = (path: string) =>
  entry(path, [line('HUNK', '@@ -0,0 +1 @@', 0, 0), line('ADDITION', `+// ${path}`, 0, 1)], {
    status: 'ADDED',
    linesAdded: 1,
    linesDeleted: 0,
  });
const resolveEntry = (path: string) =>
  ENTRIES[path] ?? (path.startsWith('gen/') ? generated(path) : undefined);

function installFetch(
  payload = changesPayload(),
  { changesStatus = 200, failEntriesIncluding = '' } = {}
) {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://github.com');
      requests.push({
        url: url.pathname + url.search,
        headers: Object.fromEntries(Object.entries(init.headers ?? {})),
      });
      if (url.pathname === `${BASE}/changes`)
        return changesStatus === 200 ? json(payload) : new Response('', { status: changesStatus });
      if (url.pathname === `${BASE}/page_data/diff_entries`) {
        const paths = decodeURIComponent(url.searchParams.get('paths') ?? '')
          .split(',')
          .map(decodeURIComponent);
        if (failEntriesIncluding && paths.includes(failEntriesIncluding)) {
          return new Response('', { status: 500 });
        }
        return json(paths.map(resolveEntry).filter(Boolean));
      }
      if (url.pathname === `${BASE}/page_data/diff_entry_lines`) {
        return url.searchParams.get('path') === 'big.rs'
          ? json({ diffEntryLines: BIG_LINES })
          : new Response('', { status: 404 });
      }
      return new Response('', { status: 404 });
    })
  );
}

const requestedPaths = () =>
  requests
    .filter((r) => r.url.includes('diff_entries'))
    .flatMap((r) =>
      decodeURIComponent(new URL(r.url, 'https://github.com').searchParams.get('paths') ?? '')
        .split(',')
        .map(decodeURIComponent)
    );

describe('agentboard_github_pull_request built-in', () => {
  beforeEach(() => installFetch());
  afterEach(() => vi.unstubAllGlobals());

  it('parses as a built-in with the model-facing identity intact', () => {
    const code = readFileSync(
      path.resolve('src/lib/webmcp/tools/github_pull_request/script.js'),
      'utf8'
    );
    const parsed = parseUserScript(code, false);
    expect(parsed.metadata).toMatchObject({
      name: 'github_pull_request',
      namespace: 'agentboard',
      version: metadata.version,
      match: ['https://github.com/*/*/pull/*'],
    });
    expect(parsed.metadata.description).toBe(metadata.description);
    // The compiler evaluates the metadata literal and the Options parser regex-extracts it; a
    // description free of quote characters survives both.
    expect(metadata.description).not.toMatch(/["'`]/);
  });

  it('returns the header, files table, anchored threads, and GitHub diff lines by default', async () => {
    const result = await run({});

    expect(result.pr).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      number: 150,
      url: `https://github.com${BASE}`,
      title: 'Capture WAL changes',
      state: 'merged',
      author: 'xiaoli',
      baseBranch: 'main',
      headBranch: 'feature/wal',
      baseSha: 'b'.repeat(40),
      headSha: 'h'.repeat(40),
      commitsCount: 1,
      commentsCount: 23,
      mergedAt: '2026-09-16T12:40:25-07:00',
      mergedBy: 'xiaoli',
    });
    expect(result.pr).not.toHaveProperty('headRepository');
    expect(result.unavailable).toBeUndefined();

    expect(result.files).toEqual([
      { path: 'a.ts', status: 'modified', additions: 1, deletions: 1, inDiff: true },
      { path: 'dir/b.ts', status: 'added', additions: 2, deletions: 0, inDiff: true },
      { path: 'big.rs', status: 'added', additions: 2, deletions: 0, inDiff: true },
      { path: 'logo.png', status: 'added', additions: 0, deletions: 0, inDiff: true },
      {
        path: 'README.md',
        status: 'modified',
        additions: 1,
        deletions: 1,
        vendored: true,
        inDiff: true,
      },
    ]);

    // Threads sort by first-comment instant (01:45-07:00 precedes 01:15-08:00, though not as
    // strings); anchors come from markersMap, and outdated threads have none.
    expect(result.threads.map((t) => t.id)).toEqual(['1001', '1002', '1003']);
    expect(result.threads[0]).toEqual({
      id: '1001',
      resolved: false,
      anchor: { path: 'a.ts', side: 'right', line: 2 },
      permalink: `https://github.com${BASE}#discussion_r3991990443`,
      reviewId: '5181914191',
      comments: [
        { author: 'reviewer', at: '2026-09-11T01:45:04-07:00', body: '**[P1]** Use 3 here.' },
        { author: 'xiaoli', at: '2026-09-11T11:00:00-07:00', body: 'Done.' },
      ],
    });
    expect(result.threads[1]).toMatchObject({
      id: '1002',
      resolved: true,
      resolvedBy: 'xiaoli',
      anchor: null,
      commentsTruncated: true,
    });
    expect(result.threads[2].anchor).toEqual({ path: 'README.md', side: 'left', line: 1 });
    expect(result.threadsTruncated).toBeUndefined();

    expect(result.diff).toBe(
      [
        'File: a.ts (modified)',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        ' export { a, b };',
        '\\ No newline at end of file',
        'File: dir/b.ts (added)',
        '@@ -0,0 +1,2 @@',
        '+export const b = 1;',
        '+export const c = 2;',
        'File: big.rs (added)',
        '@@ -0,0 +1,2 @@',
        '+fn main() {}',
        '+fn other() {}',
        'File: logo.png (added)',
        '(binary file changed)',
        'File: README.md (modified)',
        '@@ -1 +1 @@',
        '-Old',
        '+New',
        '',
      ].join('\n')
    );
    expect(result.diffTruncated).toBeNull();

    // Inlined entries are reused; only the missing ones are requested, and the collapsed one expanded.
    expect(requestedPaths()).toEqual(['big.rs', 'logo.png', 'README.md']);
    expect(requests.filter((r) => r.url.includes('diff_entry_lines')).map((r) => r.url)).toEqual([
      `${BASE}/page_data/diff_entry_lines?path=big.rs`,
    ]);
    for (const request of requests) {
      expect(request.headers).toMatchObject({
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      });
    }
  });

  it('pages the diff on whole-file boundaries and expands collapsed files only when reached', async () => {
    // ~600 chars per inlined file: the first fits a 1000-char budget, the second does not.
    const padded = changesPayload();
    const route = padded.payload.pullRequestsChangesRoute as { diffContents: unknown[] };
    const wide = (path: string, status: string) =>
      entry(
        path,
        [
          line('HUNK', '@@ -0,0 +1,12 @@', 0, 0),
          ...Array.from({ length: 12 }, (_, i) =>
            line('ADDITION', `+${'x'.repeat(42)}${i}`, 0, i + 1)
          ),
        ],
        { status }
      );
    route.diffContents = [wide('a.ts', 'MODIFIED'), wide('dir/b.ts', 'ADDED')];
    installFetch(padded);

    const first = await run({ include: ['files', 'diff'], maxLength: 1000 });
    expect(first.files.map((f) => [f.path, f.inDiff])).toEqual([
      ['a.ts', true],
      ['dir/b.ts', false],
      ['big.rs', false],
      ['logo.png', false],
      ['README.md', false],
    ]);
    expect(first.diff.length).toBeLessThanOrEqual(1000);
    expect(first.diffTruncated).toEqual({ after: 'a.ts', remainingFiles: 4 });
    expect(first).not.toHaveProperty('threads');
    // Nothing past the budget was reached, so nothing was requested for it.
    expect(requestedPaths()).toEqual([]);
    expect(requests.some((r) => r.url.includes('diff_entry_lines'))).toBe(false);

    const second = await run({
      include: ['files', 'diff'],
      maxLength: 1000,
      startAfter: 'a.ts',
    });
    expect(second.files.map((f) => [f.path, f.inDiff])).toEqual([
      ['a.ts', false],
      ['dir/b.ts', true],
      ['big.rs', true],
      ['logo.png', true],
      ['README.md', true],
    ]);
    expect(second.diffTruncated).toBeNull();
    expect(second.diff.startsWith('File: dir/b.ts (added)')).toBe(true);
    expect(requests.filter((r) => r.url.includes('diff_entry_lines'))).toHaveLength(1);
  });

  it('returns a single oversized file truncated rather than nothing', async () => {
    const result = await run({ include: ['diff'], files: ['a.ts'], maxLength: 1000 });
    expect(result.diff.startsWith('File: a.ts (modified)')).toBe(true);
    expect(result.diffTruncated).toBeNull();

    const huge = changesPayload();
    const route = huge.payload.pullRequestsChangesRoute as { diffContents: unknown[] };
    route.diffContents = [
      entry(
        'a.ts',
        Array.from({ length: 200 }, (_, i) => line('ADDITION', `+${'x'.repeat(40)}${i}`, 0, i))
      ),
    ];
    installFetch(huge);
    const clipped = await run({ include: ['diff'], files: ['a.ts'], maxLength: 1000 });
    expect(clipped.diff.length).toBeLessThanOrEqual(1000);
    expect(clipped.diff).toMatch(/\d\n\.\.\. \[truncated: this file exceeds maxLength 1000\]\n$/);
    expect(clipped.diffTruncated).toEqual({
      after: 'a.ts',
      remainingFiles: 0,
      clippedFile: 'a.ts',
    });
  });

  it('filters the diff by glob without shrinking the table', async () => {
    const result = await run({ files: ['dir/**', '*.md'] });
    expect(result.files.map((f) => [f.path, f.inDiff])).toEqual([
      ['a.ts', false],
      ['dir/b.ts', true],
      ['big.rs', false],
      ['logo.png', false],
      ['README.md', true],
    ]);
    expect(result.diff).toContain('File: dir/b.ts (added)');
    expect(result.diff).toContain('File: README.md (modified)');
    expect(result.diff).not.toContain('File: a.ts (modified)');
    expect(requestedPaths()).toEqual(['README.md']);
  });

  it('returns only open threads with unresolvedOnly and only threads when asked', async () => {
    const result = await run({ include: ['threads'], unresolvedOnly: true });
    expect(result.threads.map((t) => t.id)).toEqual(['1001']);
    expect(result).not.toHaveProperty('files');
    expect(result).not.toHaveProperty('diff');
    expect(requests.map((r) => r.url)).toEqual([`${BASE}/changes`]);
  });

  it('degrades a section instead of failing when its source changes shape', async () => {
    installFetch(changesPayload({ markers: { threads: 'unexpected' } }));
    const result = await run({ include: ['threads', 'files'] });
    expect(result.unavailable).toEqual(['threads']);
    expect(result.files).toHaveLength(5);
    expect(result.pr.title).toBe('Capture WAL changes');
  });

  it('leaves a collapsed file collapsed when its expansion fails', async () => {
    const payload = changesPayload();
    (payload.payload.pullRequestsChangesRoute.diffSummaries as Array<{ path: string }>)[2].path =
      'other-big.rs';
    ENTRIES['other-big.rs'] = entry('other-big.rs', [], { status: 'ADDED', isTooBig: true });
    installFetch(payload);
    try {
      const result = await run({ include: ['diff'], files: ['other-big.rs'] });
      expect(result.diff).toBe(
        [
          'File: other-big.rs (added)',
          '(changes too large to load; request this file alone with a larger maxLength)',
          '',
        ].join('\n')
      );
      expect(result.unavailable).toBeUndefined();
    } finally {
      delete ENTRIES['other-big.rs'];
    }
  });

  it('never fetches or expands a file whose floor size cannot fit the remaining budget', async () => {
    const payload = changesPayload();
    (payload.payload.pullRequestsChangesRoute.diffSummaries as unknown[]).push({
      path: 'huge.rs',
      changeType: 'ADDED',
      linesAdded: 5000,
      linesDeleted: 0,
      isVendored: false,
      markersMap: {},
    });
    ENTRIES['huge.rs'] = entry('huge.rs', [], {
      status: 'ADDED',
      isTooBig: true,
      linesAdded: 5000,
    });
    installFetch(payload);
    try {
      const result = await run({
        include: ['files', 'diff'],
        files: ['a.ts', 'huge.rs'],
        maxLength: 2000,
      });
      expect(result.files.filter((f) => f.inDiff).map((f) => f.path)).toEqual(['a.ts']);
      expect(result.diffTruncated).toEqual({ after: 'a.ts', remainingFiles: 1 });
      // 2 x 5000 lines cannot fit in 2000 chars, so neither the entry nor its expansion was requested.
      expect(requestedPaths()).not.toContain('huge.rs');
      expect(requests.some((r) => r.url.includes('diff_entry_lines'))).toBe(false);
    } finally {
      delete ENTRIES['huge.rs'];
    }
  });

  function generatedPayload(count: number) {
    const payload = changesPayload();
    const route = payload.payload.pullRequestsChangesRoute as {
      diffSummaries: unknown[];
      diffContents: unknown[];
    };
    route.diffSummaries = Array.from({ length: count }, (_, i) => ({
      path: `gen/f${String(i).padStart(2, '0')}.ts`,
      changeType: 'ADDED',
      linesAdded: 1,
      linesDeleted: 0,
      isVendored: false,
      markersMap: {},
    }));
    route.diffContents = [];
    return payload;
  }

  it('fetches diff entries in batches as the loop reaches them', async () => {
    installFetch(generatedPayload(12));
    const result = await run({ include: ['diff'] });
    const batchSizes = requests
      .filter((r) => r.url.includes('diff_entries'))
      .map(
        (r) =>
          decodeURIComponent(
            new URL(r.url, 'https://github.com').searchParams.get('paths') ?? ''
          ).split(',').length
      );
    expect(batchSizes).toEqual([10, 2]);
    expect((result.diff.match(/^File: /gm) ?? []).length).toBe(12);
    expect(result.diffTruncated).toBeNull();
  });

  it('renders a per-file gap when one batch fails instead of losing the whole diff', async () => {
    installFetch(generatedPayload(12), { failEntriesIncluding: 'gen/f10.ts' });
    const result = await run({ include: ['files', 'diff'] });
    expect(result.unavailable).toBeUndefined();
    expect((result.diff.match(/^\+\/\/ gen\//gm) ?? []).length).toBe(10);
    expect(result.diff).toContain(
      'File: gen/f10.ts (added)\n(changes unavailable for this file)\n'
    );
    expect(result.diff).toContain(
      'File: gen/f11.ts (added)\n(changes unavailable for this file)\n'
    );
    expect(result.files.every((f) => f.inDiff)).toBe(true);
    // The failed batch is recorded, not retried once per file.
    expect(requests.filter((r) => r.url.includes('diff_entries'))).toHaveLength(2);
  });

  it('skips a malformed thread without dropping the section', async () => {
    const payload = changesPayload();
    const markers = payload.payload.pullRequestsChangesRoute.markers as {
      threads: Record<string, unknown>;
    };
    markers.threads['1004'] = { id: '1004', isResolved: false };
    installFetch(payload);
    const result = await run({ include: ['threads'] });
    expect(result.unavailable).toBeUndefined();
    expect(result.threads.map((t) => t.id)).toEqual(['1001', '1002', '1003']);
  });

  it('renders deleted files, submodules, and files without textual changes', async () => {
    const payload = changesPayload();
    (payload.payload.pullRequestsChangesRoute.diffSummaries as unknown[]).push(
      {
        path: 'gone.ts',
        changeType: 'DELETED',
        linesAdded: 0,
        linesDeleted: 1,
        isVendored: false,
        markersMap: {},
      },
      {
        path: 'vendor/lib',
        changeType: 'MODIFIED',
        linesAdded: 1,
        linesDeleted: 1,
        isVendored: false,
        markersMap: {},
      },
      {
        path: 'empty.txt',
        changeType: 'MODIFIED',
        linesAdded: 0,
        linesDeleted: 0,
        isVendored: false,
        markersMap: {},
      }
    );
    ENTRIES['gone.ts'] = entry(
      'gone.ts',
      [line('HUNK', '@@ -1 +0,0 @@', 0, 0), line('DELETION', '-gone', 1, 0)],
      {
        status: 'DELETED',
        linesAdded: 0,
        linesDeleted: 1,
      }
    );
    ENTRIES['vendor/lib'] = entry('vendor/lib', [], {
      isSubmodule: true,
      newCommitOid: 'c'.repeat(40),
    });
    ENTRIES['empty.txt'] = entry('empty.txt', []);
    installFetch(payload);
    try {
      const result = await run({
        include: ['diff'],
        files: ['gone.ts', 'vendor/lib', 'empty.txt'],
      });
      expect(result.diff).toBe(
        [
          'File: gone.ts (deleted)',
          '@@ -1 +0,0 @@',
          '-gone',
          'File: vendor/lib (modified)',
          `(submodule updated to ${'c'.repeat(40)})`,
          'File: empty.txt (modified)',
          '(no textual changes)',
          '',
        ].join('\n')
      );
    } finally {
      delete ENTRIES['gone.ts'];
      delete ENTRIES['vendor/lib'];
      delete ENTRIES['empty.txt'];
    }
  });

  it('takes created and closed times from embedded layout data only when it describes this PR', async () => {
    const script = document.createElement('script');
    script.type = 'application/json';
    script.setAttribute('data-target', 'react-app.embeddedData');
    document.head.append(script);
    try {
      const layout = (number: number) =>
        JSON.stringify({
          payload: {
            pullRequestsLayoutRoute: {
              pullRequest: {
                number,
                createdTime: '2026-09-11T10:36:25-07:00',
                closedTime: '2026-09-16T13:45:36-07:00',
              },
            },
          },
        });
      script.textContent = layout(150);
      expect((await run({ include: [] })).pr).toMatchObject({
        createdAt: '2026-09-11T10:36:25-07:00',
        closedAt: '2026-09-16T13:45:36-07:00',
      });
      script.textContent = layout(151);
      const other = (await run({ include: [] })).pr;
      expect(other).not.toHaveProperty('createdAt');
      expect(other).not.toHaveProperty('closedAt');
    } finally {
      script.remove();
    }
  });

  it('rejects an already-aborted signal before any request', async () => {
    await expect(execute({}, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('points the model at read_page when structured data is not served', async () => {
    installFetch(changesPayload(), { changesStatus: 406 });
    await expect(execute({})).rejects.toThrow(
      /GitHub returned 406 .*use agentboard_read_page instead/
    );
  });

  it.each([
    [{ include: ['diff', 'commits'] }, 'include must be an array'],
    [{ files: [''] }, 'files must be a non-empty array'],
    [{ files: [] }, 'files must be a non-empty array'],
    [{ unresolvedOnly: 'yes' }, 'unresolvedOnly must be a boolean'],
    [{ maxLength: 10 }, 'maxLength must be an integer between'],
    [{ maxLength: 5000.5 }, 'maxLength must be an integer between'],
    [{ startAfter: '' }, 'startAfter must be a non-empty path'],
    [null, 'expected an object'],
  ])('rejects invalid arguments %j before any request', async (args, message) => {
    await expect(execute(args as never)).rejects.toThrow(message);
    expect(requests).toHaveLength(0);
  });

  it('rejects an unknown startAfter path instead of degrading the diff', async () => {
    await expect(execute({ include: ['diff'], startAfter: 'nope.ts' })).rejects.toThrow(
      'startAfter path is not in this pull request: nope.ts'
    );
  });
});
