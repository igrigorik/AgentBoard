import { describe, expect, it } from 'vitest';
import { parseHttpContentType } from '../src/lib/webmcp/tools/read_page/pdf/content-type';

describe('PDF response Content-Type parsing', () => {
  it.each([
    ['application/pdf', 'application/pdf'],
    [' Application/PDF ', 'application/pdf'],
    ['application/pdf; charset=binary', 'application/pdf'],
    ['application/pdf; profile="archive;v=1"', 'application/pdf'],
    ['application/octet-stream; name="report\\"final.pdf"', 'application/octet-stream'],
  ])('accepts a complete syntactically valid field', (value, expected) => {
    expect(parseHttpContentType(value)).toBe(expected);
  });

  it.each([
    null,
    '',
    'application/pdf;',
    'application/pdf; garbage',
    'application/pdf; charset=',
    'application/pdf; charset =binary',
    'application/pdf; charset= binary',
    'application/pdf; charset = binary',
    'application/pdf; =binary',
    'application/pdf; profile="unterminated',
    'application/pdf trailing',
    'application /pdf',
    'application/pdf\r\nX-Evil: yes',
  ])('rejects missing or malformed fields', (value) => {
    expect(parseHttpContentType(value)).toBeNull();
  });
});
