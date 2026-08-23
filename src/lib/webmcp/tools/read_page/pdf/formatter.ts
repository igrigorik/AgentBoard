export interface PdfTextItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

export interface FormattedPdfPage {
  text: string;
  mode: 'plain' | 'layout';
  warnings: string[];
}

export interface PdfPageFormatOptions {
  rotation?: number;
}

interface PositionedItem {
  dir: string;
  x: number;
  y: number;
  xEnd: number;
  fontHeight: number;
  text: string;
}

interface TextLine {
  x: number;
  xEnd: number;
  y: number;
  height: number;
  text: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function normalizedText(value: string): string {
  return value.replace(/[\t\f\v ]+/g, ' ').trim();
}

function positionItem(item: PdfTextItem): PositionedItem | null {
  const text = normalizedText(item.str);
  const transform = item.transform;
  if (!text || transform.length < 6) return null;

  const x = Number(transform[4]);
  const y = Number(transform[5]);
  const width = Math.abs(Number(item.width));
  const fontHeight = Math.max(
    Math.abs(Number(item.height)),
    Math.abs(Number(transform[0])),
    Math.abs(Number(transform[3]))
  );
  if (![x, y, width, fontHeight].every(Number.isFinite) || fontHeight === 0) return null;

  return { dir: item.dir, x, y, xEnd: x + width, fontHeight, text };
}

function joinLine(items: PositionedItem[]): TextLine {
  const rtl = items.filter(({ dir }) => dir === 'rtl').length > items.length / 2;
  const ordered = [...items].sort((left, right) => (rtl ? right.x - left.x : left.x - right.x));
  const typicalHeight = median(ordered.map(({ fontHeight }) => fontHeight)) || 1;
  let text = '';
  let previous: PositionedItem | undefined;

  for (const item of ordered) {
    if (previous && !/\s$/u.test(text) && !/^\s/u.test(item.text)) {
      const gap = rtl ? previous.x - item.xEnd : item.x - previous.xEnd;
      if (gap > typicalHeight * 0.15) text += ' ';
    }
    text += item.text;
    previous = item;
  }

  return {
    x: Math.min(...ordered.map(({ x }) => x)),
    xEnd: Math.max(...ordered.map(({ xEnd }) => xEnd)),
    y: median(ordered.map(({ y }) => y)),
    height: Math.max(...ordered.map(({ fontHeight }) => fontHeight), 1),
    text: text.trim(),
  };
}

function groupLines(items: PositionedItem[], pageWidth: number): TextLine[] {
  const typicalHeight = median(items.map(({ fontHeight }) => fontHeight)) || 1;
  const tolerance = Math.max(1.5, typicalHeight * 0.35);
  const groups: Array<{ y: number; items: PositionedItem[] }> = [];

  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    const current = groups.at(-1);
    if (current && Math.abs(current.y - item.y) <= tolerance) {
      // Keep the first baseline as the anchor. Updating it from attacker-sized groups creates
      // quadratic work and can also drift enough to merge distinct nearby lines transitively.
      current.items.push(item);
    } else {
      groups.push({ y: item.y, items: [item] });
    }
  }

  const splitThreshold = Math.max(typicalHeight * 4, pageWidth * 0.08);
  return groups
    .flatMap(({ items: lineItems }) => {
      const ordered = [...lineItems].sort((left, right) => left.x - right.x);
      const segments: PositionedItem[][] = [];
      for (const item of ordered) {
        const segment = segments.at(-1);
        const previous = segment?.at(-1);
        if (!segment || !previous || item.x - previous.xEnd > splitThreshold) {
          segments.push([item]);
        } else {
          segment.push(item);
        }
      }
      return segments.map(joinLine);
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

function formatLines(lines: TextLine[]): string {
  if (lines.length === 0) return '';
  const typicalHeight = median(lines.map(({ height }) => height)) || 1;
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > 0) {
      const previous = lines[index - 1];
      const gap = previous.y - line.y;
      if (gap > Math.max(previous.height, line.height, typicalHeight) * 1.65) output.push('');
    }
    output.push(line.text);
  }

  return output.join('\n').trim();
}

function orderColumns(
  lines: TextLine[],
  pageWidth: number
): { lines: TextLine[]; detected: boolean; uncertain: boolean } {
  if (lines.length < 8 || !Number.isFinite(pageWidth) || pageWidth <= 0) {
    return { lines, detected: false, uncertain: false };
  }

  const left = lines.filter(({ xEnd }) => xEnd < pageWidth * 0.56);
  const right = lines.filter(({ x }) => x > pageWidth * 0.44);
  if (left.length < 3 || right.length < 3) {
    return { lines, detected: false, uncertain: false };
  }

  const leftEdge = Math.max(...left.map(({ xEnd }) => xEnd));
  const rightEdge = Math.min(...right.map(({ x }) => x));
  if (rightEdge - leftEdge < pageWidth * 0.025) {
    return { lines, detected: false, uncertain: true };
  }

  const columnTop = Math.min(
    Math.max(...left.map(({ y }) => y)),
    Math.max(...right.map(({ y }) => y))
  );
  const columnBottom = Math.max(
    Math.min(...left.map(({ y }) => y)),
    Math.min(...right.map(({ y }) => y))
  );
  if (columnTop <= columnBottom) return { lines, detected: false, uncertain: true };

  const inColumnRange = (line: TextLine) => line.y <= columnTop && line.y >= columnBottom;
  const crossing = lines.filter(
    (line) => inColumnRange(line) && line.x < leftEdge && line.xEnd > rightEdge
  );
  if (crossing.length > 0) return { lines, detected: false, uncertain: true };

  const before = lines.filter(({ y }) => y > columnTop);
  const after = lines.filter(({ y }) => y < columnBottom);
  const leftColumn = left.filter(inColumnRange);
  const rightColumn = right.filter(inColumnRange);
  const claimed = new Set([...before, ...after, ...leftColumn, ...rightColumn]);
  if (claimed.size !== lines.length) return { lines, detected: false, uncertain: true };

  return {
    lines: [...before, ...leftColumn, ...rightColumn, ...after],
    detected: true,
    uncertain: false,
  };
}

function plainText(items: PdfTextItem[]): string {
  const chunks: string[] = [];
  let endsInWhitespace = true;
  for (const item of items) {
    const value = normalizedText(item.str);
    if (value) {
      if (!endsInWhitespace) chunks.push(' ');
      chunks.push(value);
      endsInWhitespace = /\s$/u.test(value);
    }
    if (item.hasEOL && chunks.length > 0 && !endsInWhitespace) {
      chunks.push('\n');
      endsInWhitespace = true;
    }
  }
  return chunks.join('').trim();
}

function hasUnsupportedOrientation(item: PdfTextItem): boolean {
  if (item.dir === 'ttb') return true;
  if (item.transform.length < 4) return false;
  const horizontalScale = Math.max(Math.abs(item.transform[0]), Math.abs(item.transform[3]), 1);
  return (
    Math.abs(item.transform[1]) > horizontalScale * 0.1 ||
    Math.abs(item.transform[2]) > horizontalScale * 0.1
  );
}

/**
 * Reconstruct only evidence supported by PDF text geometry. The formatter intentionally preserves
 * line boundaries and declines column reordering when a spanning line makes the reading order
 * ambiguous; downstream callers surface that ambiguity instead of fabricating document structure.
 */
export function formatPdfPage(
  items: PdfTextItem[],
  pageWidth: number,
  { rotation = 0 }: PdfPageFormatOptions = {}
): FormattedPdfPage {
  if (rotation % 360 !== 0 || items.some(hasUnsupportedOrientation)) {
    return {
      text: plainText(items),
      mode: 'plain',
      warnings: ['TEXT_ORIENTATION_UNCERTAIN'],
    };
  }
  const positioned = items
    .map(positionItem)
    .filter((item): item is PositionedItem => item !== null);
  if (positioned.length === 0 || positioned.length < items.length * 0.8) {
    return {
      text: plainText(items),
      mode: 'plain',
      warnings: positioned.length < items.length ? ['TEXT_GEOMETRY_INCOMPLETE'] : [],
    };
  }

  const lines = groupLines(positioned, pageWidth);
  const columns = orderColumns(lines, pageWidth);
  return {
    text: formatLines(columns.lines),
    mode: 'layout',
    warnings: columns.uncertain ? ['COLUMN_LAYOUT_UNCERTAIN'] : [],
  };
}
