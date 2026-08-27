import { describe, expect, it } from 'vitest';
import { formatPdfPage, type PdfTextItem } from '../src/lib/webmcp/tools/read_page/pdf/formatter';

function item(
  str: string,
  x: number,
  y: number,
  width = str.length * 5,
  fontHeight = 10
): PdfTextItem {
  return {
    str,
    dir: 'ltr',
    transform: [fontHeight, 0, 0, fontHeight, x, y],
    width,
    height: fontHeight,
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

  it('preserves evidence-backed headings and list markers as Markdown', () => {
    const result = formatPdfPage(
      [
        item('Paper title', 40, 740, 120, 16),
        item('Summary text.', 40, 700),
        item('1 Introduction', 40, 640, 100, 12),
        item('• First contribution', 40, 620),
        item('1.1 Prior work', 40, 580),
        item('Prior-work body.', 40, 560),
      ],
      612
    );

    expect(result.text).toBe(
      '### Paper title\n\nSummary text.\n\n### 1 Introduction\n\n- First contribution\n\n#### 1.1 Prior work\n\nPrior-work body.'
    );
    expect(result.mode).toBe('layout');
  });

  it('does not count empty PDF.js separator items as missing text geometry', () => {
    const separators = Array.from({ length: 8 }, (_, index) => item(' ', 40, 680 - index * 10));
    const result = formatPdfPage([item('Visible text', 40, 700), ...separators], 612);

    expect(result).toEqual({ text: 'Visible text', mode: 'layout', warnings: [] });
  });

  it('does not promote ordinary prose or page numbers when small captions skew line counts', () => {
    const result = formatPdfPage(
      [
        item('A full body line establishes the document prose size.', 40, 700, 300, 10),
        item('automation). By treating these protocols as ordinary text', 40, 688, 300, 12),
        item('Another full body line continues the paragraph.', 40, 676, 280, 10),
        item('tiny caption one', 40, 640, 80, 6),
        item('tiny caption two', 40, 632, 80, 6),
        item('6', 300, 40, 5, 12),
      ],
      612
    );

    expect(result.text).not.toContain('### automation');
    expect(result.text).not.toContain('### 6');
  });

  it('keeps sparse rotated marginalia without degrading the main page to plain text', () => {
    const horizontal = Array.from({ length: 8 }, (_, index) =>
      item(`line ${index + 1}`, 40, 700 - index * 12)
    );
    const marginalia = {
      ...item('arXiv identifier', 20, 300),
      transform: [0, 10, -10, 0, 20, 300],
    };

    const result = formatPdfPage([...horizontal, marginalia], 612);

    expect(result.mode).toBe('layout');
    expect(result.text).toContain('line 1');
    expect(result.text).toContain(
      '### Rotated or vertical text (position uncertain)\n\narXiv identifier'
    );
    expect(result.warnings).toEqual(['TEXT_ORIENTATION_SEPARATED']);
  });

  it('falls back when rotated or vertical text is more than a sparse minority', () => {
    const horizontal = Array.from({ length: 7 }, (_, index) =>
      item(`line ${index + 1}`, 40, 700 - index * 12)
    );
    const rotated = Array.from({ length: 3 }, (_, index) => ({
      ...item(`vertical ${index + 1}`, 20, 300 - index * 12),
      transform: [0, 10, -10, 0, 20, 300 - index * 12],
    }));

    expect(formatPdfPage([...horizontal, ...rotated], 612).mode).toBe('plain');
    const separators = Array.from({ length: 20 }, (_, index) => item(' ', 40, 200 - index * 5));
    expect(formatPdfPage([...horizontal, ...rotated, ...separators], 612).mode).toBe('plain');
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
