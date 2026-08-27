import type { JSONValue } from 'ai';
import type { HtmlReadSuccess } from './html-protocol';
import type { PdfEncodedPageImage, PdfParserSuccess, PdfSuccess } from './pdf/protocol';
import type { ViewportCapture } from './viewport-capture';

/**
 * Identity-bound, model-only media for read_page results. Image bytes never
 * enter the public tool result, logs, or history; they reach the model only
 * through toModelOutput() on the exact result object produced by execute().
 */
type ReadPageMedia =
  | { kind: 'pdf'; images: readonly PdfEncodedPageImage[]; pageHeadingOffsets: readonly number[] }
  | { kind: 'viewport'; image: ViewportCapture };

const mediaByResult = new WeakMap<object, ReadPageMedia>();

function warningsLine(warnings?: readonly string[]): string {
  return warnings?.length ? `Warnings: ${warnings.join(', ')}` : 'Warnings: none';
}

/** Narrowing forces the double hop for object-typed values; keep it in one place. */
function jsonOutput(value: unknown) {
  return { type: 'json' as const, value: value as JSONValue };
}

function annotatePdfPages(
  markdownContent: string,
  media: Extract<ReadPageMedia, { kind: 'pdf' }>
): string {
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

function pdfModelText(result: PdfSuccess, media: Extract<ReadPageMedia, { kind: 'pdf' }>): string {
  const manifest = media.images
    .map((image) => `- Image ${image.imageIndex} = PDF page ${image.pageNumber}`)
    .join('\n');
  const continuation = result.pdf.nextPage
    ? `Continue with startPage ${result.pdf.nextPage}.`
    : 'This result reaches the end of the PDF.';
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
    warningsLine(result.warnings),
    textOnlyRetry,
    annotatePdfPages(result.markdownContent, media),
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}

function viewportModelText(result: HtmlReadSuccess): string {
  const viewport = result.viewport;
  // The snippets are page-controlled text, but so is the markdown body below;
  // with exactly one image there is no image-to-content association to spoof.
  const visibleSpan =
    viewport && (viewport.firstVisibleText || viewport.lastVisibleText)
      ? ` Visible text spans "${viewport.firstVisibleText}" through "${viewport.lastVisibleText}".`
      : '';
  const manifest = `- Image 1 = the user's current browser viewport (~${viewport?.scrollPercent ?? 0}% scrolled).${visibleSpan}`;
  const body =
    result.extractionMode === 'viewport-only'
      ? 'HTML extraction failed for this document; the viewport image is the only available content.'
      : result.markdownContent;
  return [
    'Viewport image manifest. The media part, when supported by the connection API, follows this text:',
    manifest,
    warningsLine(result.warnings),
    body,
  ].join('\n\n');
}

/**
 * Remove parser-only bytes while retaining their identity-bound model projection.
 * Registering only non-empty arrays is what lets readPageModelOutput treat a 'pdf'
 * entry as implying at least one image.
 */
export function publishPdfResult(result: PdfParserSuccess): PdfSuccess {
  const { pageImageData, pageHeadingOffsets, ...publicResult } = result;
  if (pageImageData.length > 0) {
    mediaByResult.set(publicResult, { kind: 'pdf', images: pageImageData, pageHeadingOffsets });
  }
  return publicResult;
}

/** Attach the byte-free viewport descriptor publicly and its bytes privately. */
export function publishHtmlResult(
  result: HtmlReadSuccess,
  capture: ViewportCapture
): HtmlReadSuccess {
  result.images = [
    {
      imageIndex: 1,
      kind: 'viewport',
      width: capture.width,
      height: capture.height,
      mediaType: capture.mediaType,
      detail: 'low',
    },
  ];
  mediaByResult.set(result, { kind: 'viewport', image: capture });
  return result;
}

/** Convert only identity-associated results to rich model content; all other values stay JSON. */
export function readPageModelOutput(output: unknown) {
  if (!output || typeof output !== 'object') return jsonOutput(output);
  const media = mediaByResult.get(output);
  if (!media) return jsonOutput(output);
  if (media.kind === 'viewport') {
    return {
      type: 'content' as const,
      value: [
        { type: 'text' as const, text: viewportModelText(output as HtmlReadSuccess) },
        { type: 'media' as const, data: media.image.data, mediaType: media.image.mediaType },
      ],
    };
  }
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: pdfModelText(output as PdfSuccess, media) },
      ...media.images.map(({ data, mediaType }) => ({
        type: 'media' as const,
        data,
        mediaType,
      })),
    ],
  };
}
