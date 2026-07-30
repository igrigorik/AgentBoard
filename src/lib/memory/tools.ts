import { tool } from 'ai';
import { z } from 'zod';
import { MAX_LIST_PATTERN_LENGTH, MemoryFileError, type MemoryFilesystem } from './filesystem';
import { MemoryMountError } from './manager';
import { MEMORY_TOOL_NAMES } from './tool-names';

const relativePath = z
  .string()
  .max(512)
  .describe('Root-relative path inside the selected mounted memory workspace');

async function runAuthorized<T>(
  authoritySignal: AbortSignal,
  requestSignal: AbortSignal | undefined,
  operation: (isAuthorized: () => boolean) => Promise<T>
): Promise<T> {
  const isAuthorized = () => !authoritySignal.aborted && !requestSignal?.aborted;
  if (!isAuthorized()) throw new MemoryMountError('ROOT_UNAVAILABLE');
  const result = await operation(isAuthorized);
  if (!isAuthorized()) throw new MemoryMountError('ROOT_UNAVAILABLE');
  return result;
}

/** The closures, not model arguments, choose the agent and mounted root. */
export function createMemoryTools(
  filesystem: MemoryFilesystem,
  authoritySignal: AbortSignal
): Record<string, unknown> {
  // A digest is only mutation authority after this request's tool closure observed it.
  // Consume receipts once so snapshot hashes and earlier requests cannot authorize writes.
  const readRevisions = new Map<string, string>();
  const consumeReadRevision = (path: string, expectedRevision: string): void => {
    const readRevision = readRevisions.get(path);
    readRevisions.delete(path);
    if (readRevision === undefined) throw new MemoryFileError('REVISION_REQUIRED');
    if (readRevision !== expectedRevision) throw new MemoryFileError('REVISION_CONFLICT');
  };

  return {
    [MEMORY_TOOL_NAMES.list]: tool({
      description:
        'List one directory in the selected mounted memory workspace. Returns at most 200 matching immediate entries and reports when matching results were truncated. Use root-relative paths; omit path for the root. The optional pattern is a case-sensitive basename glob with only * and ?; it does not recurse.',
      inputSchema: z.object({
        path: relativePath.optional().describe('Directory to list (default: the mounted root)'),
        pattern: z
          .string()
          .min(1)
          .max(MAX_LIST_PATTERN_LENGTH)
          .optional()
          .describe('Optional case-sensitive basename glob using * and ?'),
      }),
      execute: ({ path, pattern }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, () => filesystem.listFiles(path, pattern)),
    }),
    [MEMORY_TOOL_NAMES.read]: tool({
      description:
        'Read one UTF-8 text file from the selected mounted memory workspace. The result includes a revision that authorizes one subsequent mutation of this exact path in the current request.',
      inputSchema: z.object({ path: relativePath }),
      execute: ({ path }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, async () => {
          const snapshot = await filesystem.readFile(path);
          readRevisions.set(path, snapshot.revision);
          return snapshot;
        }),
    }),
    [MEMORY_TOOL_NAMES.write]: tool({
      description:
        'Create or replace MEMORY.md or a file under memory/ in the selected mounted memory workspace. Replacing an existing file requires a fresh agentboard_read_file call for the exact path in this request and its returned revision. Keep MEMORY.md compact; put selected chronology, supporting detail, and provenance in memory/, using memory/YYYY-MM-DD.md for dated journals.',
      inputSchema: z.object({
        path: relativePath,
        content: z.string().describe('Complete UTF-8 file content to write'),
        expectedRevision: z
          .string()
          .optional()
          .describe('Fresh revision for an existing file; omit only when creating a new file'),
      }),
      execute: ({ path, content, expectedRevision }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, (isAuthorized) => {
          if (expectedRevision === undefined) readRevisions.delete(path);
          else consumeReadRevision(path, expectedRevision);
          return filesystem.writeFile(path, content, expectedRevision, isAuthorized);
        }),
    }),
    [MEMORY_TOOL_NAMES.delete]: tool({
      description:
        'Permanently delete one file under memory/ from the selected mounted memory workspace. Deletion requires a fresh agentboard_read_file call for the exact path in this request and its returned revision. MEMORY.md and directories cannot be deleted.',
      inputSchema: z.object({
        path: relativePath,
        expectedRevision: z.string().describe('Fresh revision returned for this exact path'),
      }),
      execute: ({ path, expectedRevision }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, (isAuthorized) => {
          consumeReadRevision(path, expectedRevision);
          return filesystem.deleteFile(path, expectedRevision, isAuthorized);
        }),
    }),
  };
}
