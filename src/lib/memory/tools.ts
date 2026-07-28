import { tool } from 'ai';
import { z } from 'zod';
import { MAX_LIST_PATTERN_LENGTH, type MemoryFilesystem } from './filesystem';
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
        'Read one UTF-8 text file from the selected mounted memory workspace. The result includes a revision required to replace or delete an existing file.',
      inputSchema: z.object({ path: relativePath }),
      execute: ({ path }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, () => filesystem.readFile(path)),
    }),
    [MEMORY_TOOL_NAMES.write]: tool({
      description:
        'Create or replace MEMORY.md or a file under memory/ in the selected mounted memory workspace. Replacing an existing file requires the exact revision returned by agentboard_read_file. Keep MEMORY.md compact; put selected chronology, supporting detail, and provenance in memory/, using memory/YYYY-MM-DD.md for dated journals.',
      inputSchema: z.object({
        path: relativePath,
        content: z.string().describe('Complete UTF-8 file content to write'),
        expectedRevision: z
          .string()
          .optional()
          .describe('Required when replacing an existing file; omit only for a new file'),
      }),
      execute: ({ path, content, expectedRevision }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, (isAuthorized) =>
          filesystem.writeFile(path, content, expectedRevision, isAuthorized)
        ),
    }),
    [MEMORY_TOOL_NAMES.delete]: tool({
      description:
        'Permanently delete one file under memory/ from the selected mounted memory workspace. Deletion requires the exact revision returned by agentboard_read_file. MEMORY.md and directories cannot be deleted.',
      inputSchema: z.object({
        path: relativePath,
        expectedRevision: z.string().describe('Exact revision returned by agentboard_read_file'),
      }),
      execute: ({ path, expectedRevision }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, (isAuthorized) =>
          filesystem.deleteFile(path, expectedRevision, isAuthorized)
        ),
    }),
  };
}
