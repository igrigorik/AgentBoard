/** Type mirror for the injected JavaScript module; keep synchronized with script.js. */
export type PullRequestSection = 'files' | 'threads' | 'diff';

export interface GitHubPullRequestArguments {
  include?: PullRequestSection[];
  files?: string[];
  unresolvedOnly?: boolean;
  maxLength?: number;
  startAfter?: string;
}

export interface PullRequestHeader {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
  author: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  baseSha: string | null;
  headSha: string | null;
  commitsCount: number | null;
  commentsCount: number | null;
  headRepository?: string;
  mergedAt?: string;
  mergedBy?: string | null;
  createdAt?: string;
  closedAt?: string;
}

export interface PullRequestFile {
  path: string;
  /** Lower-cased GitHub change type. A renamed file carries no previous path; the summary omits it. */
  status: string;
  additions: number;
  deletions: number;
  vendored?: true;
  symlink?: true;
  /** Present when the diff section was requested: whether this response includes the file's changes. */
  inDiff?: boolean;
}

export interface ThreadAnchor {
  path: string;
  side: 'left' | 'right';
  line: number;
  startLine?: number;
}

export interface ReviewThread {
  id: string;
  resolved: boolean;
  resolvedBy?: string;
  reviewId?: string;
  /** Null when the thread is outdated (anchored to a superseded commit). */
  anchor: ThreadAnchor | null;
  permalink: string;
  comments: Array<{ author: string | null; at: string | null; body: string }>;
  commentsTruncated?: true;
}

export interface DiffTruncation {
  after: string | null;
  remainingFiles: number;
  clippedFile?: string;
}

export interface GitHubPullRequestResult {
  pr: PullRequestHeader;
  files?: PullRequestFile[];
  threads?: ReviewThread[];
  threadsTruncated?: true;
  /** Review text grouped by file from GitHub-provided diff lines; not a canonical Git patch. */
  diff?: string;
  diffTruncated?: DiffTruncation | null;
  unavailable?: PullRequestSection[];
}

export interface GitHubPullRequestExecutionOptions {
  signal?: AbortSignal;
}

export const metadata: {
  name: 'github_pull_request';
  namespace: 'agentboard';
  version: string;
  description: string;
  match: string[];
  inputSchema: Record<string, unknown>;
};

export function execute(
  args?: GitHubPullRequestArguments,
  options?: GitHubPullRequestExecutionOptions
): Promise<GitHubPullRequestResult>;
