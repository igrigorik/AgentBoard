import { describe, expect, it } from 'vitest';
import type { PdfTextItem } from '../src/lib/webmcp/tools/read_page/pdf/formatter';
import {
  PDF_MAX_TEXT_CHARACTERS_PER_CALL,
  PDF_MAX_TEXT_CHARACTERS_PER_PAGE,
  PDF_MAX_TEXT_ITEMS_PER_CALL,
  PDF_MAX_TEXT_ITEMS_PER_PAGE,
} from '../src/lib/webmcp/tools/read_page/pdf/protocol';
import { collectTextItems } from '../src/lib/webmcp/tools/read_page/pdf/text-collector';

const textItem: PdfTextItem = {
  str: 'text',
  dir: 'ltr',
  transform: [1, 0, 0, 1, 0, 0],
  width: 10,
  height: 10,
  hasEOL: false,
};

function streamPage(chunks: unknown[][]) {
  return {
    streamTextContent() {
      return new ReadableStream<{ items: unknown[] }>({
        start(controller) {
          for (const items of chunks) controller.enqueue({ items });
          controller.close();
        },
      });
    },
  };
}

describe('PDF text stream collection', () => {
  it('collects valid text items incrementally', async () => {
    await expect(collectTextItems(streamPage([[textItem]]), () => false, 0, 0)).resolves.toEqual({
      success: true,
      items: [textItem],
      itemCount: 1,
      characterCount: 4,
    });
  });

  it('distinguishes a page item overflow from a remaining call-budget overflow', async () => {
    const pageOverflow = await collectTextItems(
      streamPage([Array(PDF_MAX_TEXT_ITEMS_PER_PAGE + 1).fill(textItem)]),
      () => false,
      0,
      0
    );
    expect(pageOverflow).toMatchObject({ success: false, scope: 'page' });

    const callOverflow = await collectTextItems(
      streamPage([[textItem]]),
      () => false,
      PDF_MAX_TEXT_ITEMS_PER_CALL,
      0
    );
    expect(callOverflow).toMatchObject({ success: false, scope: 'call' });
  });

  it('distinguishes a page character overflow from a remaining call-budget overflow', async () => {
    const pageOverflowItem = {
      ...textItem,
      str: 'x'.repeat(PDF_MAX_TEXT_CHARACTERS_PER_PAGE + 1),
    };
    const pageOverflow = await collectTextItems(
      streamPage([[pageOverflowItem]]),
      () => false,
      0,
      0
    );
    expect(pageOverflow).toMatchObject({ success: false, scope: 'page' });

    const callOverflow = await collectTextItems(
      streamPage([[textItem]]),
      () => false,
      0,
      PDF_MAX_TEXT_CHARACTERS_PER_CALL
    );
    expect(callOverflow).toMatchObject({ success: false, scope: 'call' });
  });

  it('checks cancellation before consuming another stream chunk', async () => {
    const result = await collectTextItems(streamPage([[textItem]]), () => true, 0, 0);
    expect(result).toMatchObject({
      success: false,
      scope: 'cancel',
      failure: { error: { code: 'CANCELLED' } },
    });
  });
});
