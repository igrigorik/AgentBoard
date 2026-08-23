import { describe, expect, it } from 'vitest';
import { formatPdfPage, type PdfTextItem } from '../src/lib/webmcp/tools/read_page/pdf/formatter';

function item(str: string, x: number, y: number, width = str.length * 5): PdfTextItem {
  return {
    str,
    dir: 'ltr',
    transform: [10, 0, 0, 10, x, y],
    width,
    height: 10,
    hasEOL: false,
  };
}

describe('PDF text formatter', () => {
  it('groups positioned items into stable visual lines', () => {
    const result = formatPdfPage(
      [item('world', 90, 700), item('Hello', 40, 700), item('Second line', 40, 680)],
      612
    );

    expect(result).toEqual({
      text: 'Hello world\n\nSecond line',
      mode: 'layout',
      warnings: [],
    });
  });

  it('reads unambiguous two-column pages down the left column before the right', () => {
    const result = formatPdfPage(
      [
        item('L1', 40, 700, 100),
        item('L2', 40, 680, 100),
        item('L3', 40, 660, 100),
        item('L4', 40, 640, 100),
        item('R1', 340, 700, 100),
        item('R2', 340, 680, 100),
        item('R3', 340, 660, 100),
        item('R4', 340, 640, 100),
      ],
      612
    );

    expect(result.text.split(/\n+/u)).toEqual(['L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3', 'R4']);
    expect(result.warnings).toEqual([]);
  });

  it('does not reorder columns around a spanning line', () => {
    const result = formatPdfPage(
      [
        item('L1', 40, 700, 100),
        item('L2', 40, 680, 100),
        item('L3', 40, 660, 100),
        item('L4', 40, 640, 100),
        item('R1', 340, 700, 100),
        item('R2', 340, 680, 100),
        item('R3', 340, 660, 100),
        item('R4', 340, 640, 100),
        item('Spanning heading', 30, 670, 540),
      ],
      612
    );

    expect(result.warnings).toEqual(['COLUMN_LAYOUT_UNCERTAIN']);
    expect(result.text).toContain('Spanning heading');
  });

  it('falls back to plain order for rotated or vertical text and preserves authored line ends', () => {
    const first = { ...item('first', 40, 700), hasEOL: true };
    const second = { ...item('second', 40, 680), dir: 'ttb' };

    expect(formatPdfPage([first, second], 612)).toEqual({
      text: 'first\nsecond',
      mode: 'plain',
      warnings: ['TEXT_ORIENTATION_UNCERTAIN'],
    });
    expect(formatPdfPage([item('rotated', 40, 700)], 612, { rotation: 90 })).toEqual({
      text: 'rotated',
      mode: 'plain',
      warnings: ['TEXT_ORIENTATION_UNCERTAIN'],
    });
  });

  it('keeps cap-sized same-baseline grouping bounded', () => {
    const items = Array.from({ length: 50_000 }, () => item('x', 40, 700));
    const result = formatPdfPage(items, 612);

    expect(result.mode).toBe('layout');
    expect(result.text).toHaveLength(50_000);
  });

  it('falls back to plain item order when geometry is incomplete', () => {
    const invalid = { ...item('fallback', 0, 0), transform: [] };
    expect(formatPdfPage([invalid], 612)).toEqual({
      text: 'fallback',
      mode: 'plain',
      warnings: ['TEXT_GEOMETRY_INCOMPLETE'],
    });
  });
});
