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
  // Superscripts commonly sit just above an author-line baseline. A 40% tolerance keeps those
  // fragments attached without merging ordinary body lines, whose leading is normally larger.
  const tolerance = Math.max(1.5, typicalHeight * 0.4);
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

function weightedMedianLineHeight(lines: TextLine[]): number {
  const weighted = [...lines]
    .map((line) => ({ height: line.height, weight: Math.max(1, line.text.length) }))
    .sort((left, right) => left.height - right.height);
  const midpoint = weighted.reduce((sum, { weight }) => sum + weight, 0) / 2;
  let cumulative = 0;
  for (const { height, weight } of weighted) {
    cumulative += weight;
    if (cumulative >= midpoint) return height;
  }
  return weighted.at(-1)?.height ?? 1;
}

function inferredHeadingLevel(
  lines: TextLine[],
  index: number,
  typicalHeight: number
): number | null {
  const line = lines[index];
  const text = line.text.replace(/:$/u, '').trim();
  if (!text || text.length > 180) return null;

  const previous = lines[index - 1];
  const next = lines[index + 1];
  const gapBefore = previous ? previous.y - line.y : Number.POSITIVE_INFINITY;
  const gapAfter = next ? line.y - next.y : Number.POSITIVE_INFINITY;
  const isolated =
    gapBefore > Math.max(previous?.height ?? 0, line.height, typicalHeight) * 1.4 &&
    gapAfter > Math.max(next?.height ?? 0, line.height, typicalHeight) * 1.4;
  const relativeHeight = line.height / typicalHeight;
  const numbered = /^(\d+(?:\.\d+)*)\s+\p{L}/u.exec(text);
  if (numbered && isolated) {
    return Math.min(6, 2 + numbered[1].split('.').length);
  }
  if (/\p{L}/u.test(text) && text.length <= 120 && relativeHeight >= 1.12 && isolated) return 3;

  return null;
}

function formatLines(lines: TextLine[]): string {
  if (lines.length === 0) return '';
  // Dense body prose, rather than numerous tiny caption or code lines, establishes the baseline
  // used for conservative heading inference.
  const typicalHeight = weightedMedianLineHeight(lines);
  const output: string[] = [];
  let previousWasHeading = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingLevel = inferredHeadingLevel(lines, index, typicalHeight);
    const isHeading = headingLevel !== null;
    if (index > 0) {
      const previous = lines[index - 1];
      const gap = previous.y - line.y;
      if (
        isHeading ||
        previousWasHeading ||
        gap > Math.max(previous.height, line.height, typicalHeight) * 1.65
      ) {
        if (output.at(-1) !== '') output.push('');
      }
    }

    const text = line.text.replace(/^[•◦▪‣]\s*/u, '- ');
    output.push(isHeading ? `${'#'.repeat(headingLevel)} ${text}` : text);
    previousWasHeading = isHeading;
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
  if (rotation % 360 !== 0) {
    return {
      text: plainText(items),
      mode: 'plain',
      warnings: ['TEXT_ORIENTATION_UNCERTAIN'],
    };
  }

  // PDF.js emits empty separator items as layout hints. They carry no user-visible text and must
  // not influence either orientation or geometry confidence.
  const meaningfulItems = items.filter((item) => normalizedText(item.str));
  const horizontalItems = meaningfulItems.filter((item) => !hasUnsupportedOrientation(item));
  const separatedItems = meaningfulItems.filter(hasUnsupportedOrientation);
  if (horizontalItems.length < meaningfulItems.length * 0.8) {
    return {
      text: plainText(items),
      mode: 'plain',
      warnings: ['TEXT_ORIENTATION_UNCERTAIN'],
    };
  }

  const positioned = horizontalItems
    .map(positionItem)
    .filter((item): item is PositionedItem => item !== null);
  if (positioned.length === 0 || positioned.length < horizontalItems.length * 0.8) {
    return {
      text: plainText(items),
      mode: 'plain',
      warnings: positioned.length < horizontalItems.length ? ['TEXT_GEOMETRY_INCOMPLETE'] : [],
    };
  }

  const lines = groupLines(positioned, pageWidth);
  const columns = orderColumns(lines, pageWidth);
  const warnings = columns.uncertain ? ['COLUMN_LAYOUT_UNCERTAIN'] : [];
  let text = formatLines(columns.lines);
  const separatedText = plainText(separatedItems);
  if (separatedText) {
    text = `${text}\n\n### Rotated or vertical text (position uncertain)\n\n${separatedText}`;
    warnings.push('TEXT_ORIENTATION_SEPARATED');
  }
  return { text, mode: 'layout', warnings };
}
