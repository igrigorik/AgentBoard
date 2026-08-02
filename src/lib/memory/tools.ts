import { tool } from 'ai';
import { z } from 'zod';
import { MAX_LIST_PATTERN_LENGTH, MemoryFileError, type MemoryFilesystem } from './filesystem';
import { MemoryMountError } from './manager';
import { MEMORY_TOOL_NAMES } from './tool-names';

const relativePath = z.string().max(512);
const directoryPath = relativePath.describe(
  'Root-relative directory such as memory. Omit for the mounted root; . also means root. One trailing slash is accepted and normalized.'
);
const filePath = relativePath.describe(
  'Exact root-relative file path without a leading or trailing slash or empty, dot, or parent segments.'
);

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
  const consumeReadRevision = (path: string): string => {
    const readRevision = readRevisions.get(path);
    readRevisions.delete(path);
    if (readRevision === undefined) throw new MemoryFileError('REVISION_REQUIRED');
    return readRevision;
  };

  return {
    [MEMORY_TOOL_NAMES.list]: tool({
      description:
        'List one directory in the selected Local Workspace. Returns at most 200 matching immediate entries and reports when matching results were truncated. Use memory to list the memory directory and omit path for the mounted root. The optional pattern is a case-sensitive basename glob with only * and ?; it does not recurse.',
      inputSchema: z.object({
        path: directoryPath.optional(),
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
        'Read one UTF-8 text file from the selected Local Workspace using its exact root-relative path, such as MEMORY.md, memory/topic.md, or memory/YYYY-MM-DD.md. AgentBoard retains a single-use revision receipt that authorizes one subsequent mutation of this exact path in the current request.',
      inputSchema: z.object({ path: filePath }),
      execute: ({ path }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, async () => {
          const snapshot = await filesystem.readFile(path);
          readRevisions.set(path, snapshot.revision);
          return snapshot;
        }),
    }),
    [MEMORY_TOOL_NAMES.write]: tool({
      description:
        'Create or replace MEMORY.md or a journal file under the memory directory in the selected Local Workspace. Replacing an existing file requires a fresh agentboard_read_file call for the exact path in this request; AgentBoard applies its retained revision automatically. Keep MEMORY.md as the compact core of stable facts worth having available in every conversation plus useful journal pointers. Use journal files for deeper context, supporting detail, reasoning, chronology, and provenance; journals may be topical or dated.',
      inputSchema: z.object({
        path: filePath,
        content: z.string().describe('Complete UTF-8 file content to write'),
      }),
      execute: ({ path, content }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, (isAuthorized) => {
          const expectedRevision = readRevisions.has(path) ? consumeReadRevision(path) : undefined;
          return filesystem.writeFile(path, content, expectedRevision, isAuthorized);
        }),
    }),
    [MEMORY_TOOL_NAMES.delete]: tool({
      description:
        'Permanently delete one journal file under the memory directory from the selected Local Workspace. Deletion requires a fresh agentboard_read_file call for the exact path in this request; AgentBoard applies its retained revision automatically. MEMORY.md and directories cannot be deleted.',
      inputSchema: z.object({ path: filePath }),
      execute: ({ path }, { abortSignal }) =>
        runAuthorized(authoritySignal, abortSignal, (isAuthorized) =>
          filesystem.deleteFile(path, consumeReadRevision(path), isAuthorized)
        ),
    }),
  };
}
