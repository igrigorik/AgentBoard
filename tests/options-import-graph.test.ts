/**
 * Guards the Options page bundle boundary.
 *
 * builtin-tools.ts must import tool *metadata leaves*, never implementations:
 * fetch-url.ts drags `ai` + linkedom/Readability, and navigate drags the
 * WebMCP lifecycle graph. When that regresses, Rollup colors the whole
 * service-worker runtime into a shared chunk that the Options page eagerly
 * parses on every open. This walker asserts the eager (static) import graph
 * of the Options entry never reaches those modules. Dynamic imports are
 * intentionally ignored: they are lazy and not part of the eager cost.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../src');
const OPTIONS_ENTRY = path.resolve(SRC_ROOT, 'options/index.ts');

const FORBIDDEN_PACKAGES = ['ai', '@ai-sdk/provider', '@ai-sdk/provider-utils', 'linkedom'];
const FORBIDDEN_MODULES = [
  /tools\/fetch\/(fetch-url|content-extractor)/,
  /tools\/fetch\/index/,
  /tools\/navigate\/index/,
  /webmcp\/lifecycle/,
  /webmcp\/system-tools/,
  /vendor\/readability/,
];

/** Static import/export-from specifiers only; excludes dynamic import() and pure type imports. */
function staticSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    // import X from '...' | import { a, b } from '...' | import * as ns from '...' | import '...'
    /\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    // export { a } from '...' | export * from '...'
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$\s,]*\})\s+from\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const statement = match[0];
      if (/^\s*(?:import|export)\s+type\b/.test(statement)) continue; // erased at compile time
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const aliased = specifier.startsWith('@lib/')
    ? path.resolve(SRC_ROOT, 'lib', specifier.slice(5))
    : specifier.startsWith('@/')
      ? path.resolve(SRC_ROOT, specifier.slice(2))
      : specifier.startsWith('.')
        ? path.resolve(path.dirname(fromFile), specifier)
        : null;
  if (!aliased) return null; // bare package specifier
  for (const candidate of [
    aliased,
    `${aliased}.ts`,
    `${aliased}.js`,
    path.join(aliased, 'index.ts'),
    path.join(aliased, 'index.js'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

describe('options page import graph', () => {
  it('never eagerly reaches tool implementations or their heavy dependencies', () => {
    const visited = new Set<string>();
    const packages = new Set<string>();
    const queue = [OPTIONS_ENTRY];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file) || !/\.(ts|js)$/.test(file)) continue;
      visited.add(file);

      for (const specifier of staticSpecifiers(fs.readFileSync(file, 'utf8'))) {
        const resolved = resolveRelative(file, specifier);
        if (resolved) queue.push(resolved);
        else if (!specifier.startsWith('.')) packages.add(specifier);
      }
    }

    // Sanity: an empty or tiny walk means the walker broke, not that the graph is clean.
    expect(visited.size).toBeGreaterThan(15);
    expect(visited.has(path.resolve(SRC_ROOT, 'lib/webmcp/builtin-tools.ts'))).toBe(true);

    const forbiddenPackageHits = [...packages].filter((specifier) =>
      FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
    );
    expect(forbiddenPackageHits).toEqual([]);

    const forbiddenModuleHits = [...visited].filter((file) =>
      FORBIDDEN_MODULES.some((pattern) => pattern.test(file))
    );
    expect(forbiddenModuleHits).toEqual([]);
  });
});
