import { performance } from 'node:perf_hooks';
import { parseHTML } from 'linkedom';
import { Readability } from '../../src/lib/webmcp/vendor/readability.js';

const adversarialTitle = `${'1'.repeat(100_000)}A\nA - A`;
const { document } = parseHTML(`
  <!doctype html>
  <html>
    <head><title>${adversarialTitle}</title></head>
    <body><article><p>${'Article content. '.repeat(100)}</p></article></body>
  </html>
`);
const started = performance.now();
const article = new Readability(document).parse();
if (!article) throw new Error('Readability did not extract the probe article');
process.stdout.write(JSON.stringify({ milliseconds: performance.now() - started }));
