import type { PdfTextItem } from './formatter';
import {
  PDF_MAX_TEXT_CHARACTERS_PER_CALL,
  PDF_MAX_TEXT_CHARACTERS_PER_PAGE,
  PDF_MAX_TEXT_ITEMS_PER_CALL,
  PDF_MAX_TEXT_ITEMS_PER_PAGE,
  type PdfFailure,
} from './protocol';

interface PdfTextStreamPage {
  streamTextContent(options: {
    includeMarkedContent: false;
  }): ReadableStream<{ items?: unknown[] }>;
}

export type TextCollectionResult =
  | {
      success: true;
      items: PdfTextItem[];
      itemCount: number;
      characterCount: number;
    }
  | {
      success: false;
      scope: 'cancel' | 'page' | 'call';
      failure: PdfFailure;
    };

function failure(code: PdfFailure['error']['code'], message: string): PdfFailure {
  return { success: false, error: { code, message } };
}

function isTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PdfTextItem>;
  return (
    typeof item.str === 'string' &&
    typeof item.dir === 'string' &&
    Array.isArray(item.transform) &&
    typeof item.width === 'number' &&
    typeof item.height === 'number' &&
    typeof item.hasEOL === 'boolean'
  );
}

/** Consume PDF.js text streams without first materializing attacker-controlled page contents. */
export async function collectTextItems(
  page: PdfTextStreamPage,
  isCancelled: () => boolean,
  priorItems: number,
  priorCharacters: number
): Promise<TextCollectionResult> {
  const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
  const items: PdfTextItem[] = [];
  let itemCount = 0;
  let characterCount = 0;

  try {
    for (;;) {
      if (isCancelled()) {
        await reader.cancel();
        return {
          success: false,
          scope: 'cancel',
          failure: failure('CANCELLED', 'PDF extraction was cancelled.'),
        };
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunkItems = Array.isArray(value?.items) ? value.items : [];
      itemCount += chunkItems.length;
      if (itemCount > PDF_MAX_TEXT_ITEMS_PER_PAGE) {
        await reader.cancel();
        return {
          success: false,
          scope: 'page',
          failure: failure('TOO_LARGE', 'A PDF page exceeds the text-item limit.'),
        };
      }
      if (priorItems + itemCount > PDF_MAX_TEXT_ITEMS_PER_CALL) {
        await reader.cancel();
        return {
          success: false,
          scope: 'call',
          failure: failure('TOO_LARGE', 'The requested PDF pages exceed the text-item limit.'),
        };
      }

      for (const item of chunkItems) {
        if (!isTextItem(item)) continue;
        characterCount += item.str.length;
        if (characterCount > PDF_MAX_TEXT_CHARACTERS_PER_PAGE) {
          await reader.cancel();
          return {
            success: false,
            scope: 'page',
            failure: failure('TOO_LARGE', 'A PDF page exceeds the text-character limit.'),
          };
        }
        if (priorCharacters + characterCount > PDF_MAX_TEXT_CHARACTERS_PER_CALL) {
          await reader.cancel();
          return {
            success: false,
            scope: 'call',
            failure: failure(
              'TOO_LARGE',
              'The requested PDF pages exceed the text-character limit.'
            ),
          };
        }
        items.push(item);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { success: true, items, itemCount, characterCount };
}
