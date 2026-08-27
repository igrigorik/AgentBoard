import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import canonicalSource from '../src/lib/webmcp/vendor/readability.js?raw';
import htmlReaderSource from '../src/lib/webmcp/tools/read_page/html-reader.js?raw';

const COPYRIGHT_MARKER = '/*\n * Copyright (c) 2010 Arc90 Inc';
const CANONICAL_END_MARKER = '\n\n// Export for ES module usage';
const INLINE_END_MARKER = '\n// END VENDORED READABILITY';

function implementationBetween(source: string, endMarker: string): string {
  const start = source.indexOf(COPYRIGHT_MARKER);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Readability implementation markers are missing');
  return source.slice(start, end).trimEnd();
}

function replaceExactlyOnce(source: string, find: string, replacement: string): string {
  expect(source.split(find)).toHaveLength(2);
  return source.replace(find, replacement);
}

describe('Readability vendor integration', () => {
  it('keeps the inlined implementation synchronized except for Trusted Types sinks', () => {
    let canonical = implementationBetween(canonicalSource, CANONICAL_END_MARKER);
    let inline = implementationBetween(htmlReaderSource, INLINE_END_MARKER);

    canonical = replaceExactlyOnce(
      canonical,
      'if (typeof module === "object") {\n  /* global module */\n  module.exports = Readability;\n}',
      ''
    ).trimEnd();

    inline = replaceExactlyOnce(
      inline,
      'page.innerHTML = _safeHTML(pageCacheHtml);',
      'page.innerHTML = pageCacheHtml;'
    );
    inline = replaceExactlyOnce(
      inline,
      'tmp.innerHTML = _safeHTML(noscript.innerHTML);',
      'tmp.innerHTML = noscript.innerHTML;'
    );

    expect(inline).toBe(canonical);
    expect(canonical).not.toContain('eslint-disable-next-line');
  });

  it('records the 0.6.0 provenance in both controlled copies', () => {
    expect(canonicalSource).toContain('Mozilla Readability v0.6.0');
    expect(htmlReaderSource).toContain('Vendor Mozilla Readability v0.6.0');
    expect(canonicalSource).not.toContain('Mozilla Readability v0.5.0');
    expect(htmlReaderSource).not.toContain('Vendor Mozilla Readability v0.5.0');
  });

  it('bounds CVE-2025-2792 title parsing with a hard process deadline', () => {
    const probePath = resolve('tests/fixtures/readability-redos-probe.mjs');
    const probe = spawnSync(process.execPath, [probePath], {
      encoding: 'utf8',
      timeout: 2_000,
    });

    expect(probe.error, probe.error?.message).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toMatchObject({
      milliseconds: expect.any(Number),
    });
  });
});
