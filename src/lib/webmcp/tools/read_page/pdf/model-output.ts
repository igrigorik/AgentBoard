import type { JSONValue } from 'ai';
import type { PdfEncodedPageImage, PdfParserSuccess, PdfSuccess } from './protocol';

interface PdfModelMedia {
  images: readonly PdfEncodedPageImage[];
  pageHeadingOffsets: readonly number[];
}

const pdfModelMediaByResult = new WeakMap<object, PdfModelMedia>();

function annotatePdfPages(markdownContent: string, media: PdfModelMedia): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const [index, image] of media.images.entries()) {
    const headingOffset = media.pageHeadingOffsets[index];
    const heading = `## Page ${image.pageNumber}`;
    if (
      !Number.isInteger(headingOffset) ||
      headingOffset < cursor ||
      !markdownContent.startsWith(heading, headingOffset)
    ) {
      return markdownContent;
    }
    chunks.push(
      markdownContent.slice(cursor, headingOffset),
      `## PDF page ${image.pageNumber} — Image ${image.imageIndex}`
    );
    cursor = headingOffset + heading.length;
  }
  chunks.push(markdownContent.slice(cursor));
  return chunks.join('');
}

function modelText(result: PdfSuccess, media: PdfModelMedia): string {
  const manifest = media.images
    .map((image) => `- Image ${image.imageIndex} = PDF page ${image.pageNumber}`)
    .join('\n');
  const continuation = result.pdf.nextPage
    ? `Continue with startPage ${result.pdf.nextPage}.`
    : 'This result reaches the end of the PDF.';
  const warnings = result.warnings.length
    ? `Warnings: ${result.warnings.join(', ')}`
    : 'Warnings: none';
  const textOnlyRetry = result.warnings.some(
    (warning) =>
      warning.startsWith('PAGE_IMAGE_FAILED:') || warning.startsWith('PAGE_IMAGE_LIMIT_REACHED:')
  )
    ? 'The continuation page was not admitted with its image. Retry that startPage with includePageImages set to false if text-only extraction is acceptable.'
    : null;
  return [
    'PDF page-image manifest. Media parts, when supported by the connection API, follow this text in the exact order below:',
    manifest,
    continuation,
    warnings,
    textOnlyRetry,
    annotatePdfPages(result.markdownContent, media),
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}

/** Remove parser-only bytes while retaining their identity-bound model projection. */
export function publishPdfResult(result: PdfParserSuccess): PdfSuccess {
  const { pageImageData, pageHeadingOffsets, ...publicResult } = result;
  if (pageImageData.length > 0) {
    pdfModelMediaByResult.set(publicResult, {
      images: pageImageData,
      pageHeadingOffsets,
    });
  }
  return publicResult;
}

/** Convert only identity-associated PDF results to rich model content; all other values stay JSON. */
export function readPageModelOutput(output: unknown) {
  if (!output || typeof output !== 'object') {
    return { type: 'json' as const, value: output as JSONValue };
  }
  const media = pdfModelMediaByResult.get(output);
  if (!media?.images.length) {
    return { type: 'json' as const, value: output as unknown as JSONValue };
  }
  const result = output as PdfSuccess;
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: modelText(result, media) },
      ...media.images.map(({ data, mediaType }) => ({
        type: 'media' as const,
        data,
        mediaType,
      })),
    ],
  };
}
