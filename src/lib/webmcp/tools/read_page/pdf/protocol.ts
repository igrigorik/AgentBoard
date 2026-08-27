export const PDF_DOCUMENT_HOST_FILE = 'content-scripts/pdf-document-host.js';
export const PDF_HOST_PORT_PREFIX = 'agentboard-pdf-reader:';
export const PDF_MAX_BYTES = 32 * 1024 * 1024;
export const PDF_DEFAULT_MAX_PAGES = 25;
export const PDF_HARD_MAX_PAGES = 50;
export const PDF_DEFAULT_MAX_LENGTH = 32_000;
export const PDF_MIN_MAX_LENGTH = 1_000;
export const PDF_HARD_MAX_LENGTH = 100_000;
export const PDF_MAX_TEXT_ITEMS_PER_PAGE = 50_000;
export const PDF_MAX_TEXT_ITEMS_PER_CALL = 100_000;
export const PDF_MAX_TEXT_CHARACTERS_PER_PAGE = 250_000;
export const PDF_MAX_TEXT_CHARACTERS_PER_CALL = 500_000;
export const PDF_PAGE_IMAGE_MAX_EDGE = 1_024;
export const PDF_PAGE_IMAGE_MAX_PIXELS = 1_000_000;
export const PDF_PAGE_IMAGE_MAX_SOURCE_PIXELS = 16_000_000;
export const PDF_PAGE_IMAGE_JPEG_QUALITY = 0.7;
export const PDF_PAGE_IMAGE_MAX_BYTES_PER_CALL = 6 * 1024 * 1024;
export const PDF_PAGE_IMAGE_MEDIA_TYPE = 'image/jpeg';

export type PdfFailureCode =
  | 'ROUTE_UNAVAILABLE'
  | 'PDF_READER_REQUIRED'
  | 'REFETCH_FAILED'
  | 'AUTH_REQUIRED'
  | 'NAVIGATED'
  | 'TOO_LARGE'
  | 'PASSWORD_REQUIRED'
  | 'COPY_NOT_PERMITTED'
  | 'NO_EXTRACTABLE_TEXT'
  | 'PARSE_FAILED'
  | 'UNSUPPORTED_ENCODING'
  | 'TIMEOUT'
  | 'CANCELLED';

export interface PdfReadOptions {
  maxLength: number;
  startPage: number;
  maxPages: number;
  includePageImages: boolean;
}

export interface PdfHostStartMessage {
  type: 'start';
  capability: string;
  options: PdfReadOptions;
}

export interface PdfHostCancelMessage {
  type: 'cancel';
}

export type PdfHostControlMessage = PdfHostStartMessage | PdfHostCancelMessage;

export interface PdfFailure {
  success: false;
  error: {
    code: PdfFailureCode;
    message: string;
  };
}

export interface PdfPublicMetadata {
  title: string;
  url: string;
  author: string | null;
  siteName: null;
  publishedTime: string | null;
  modifiedTime: string | null;
  language: string;
  direction: 'ltr' | 'rtl';
  extractedAt: string;
}

export interface PdfPageImageDescriptor {
  /** One-based attachment order within this tool result. */
  imageIndex: number;
  /** One-based physical PDF page number; this remains stable across paginated calls. */
  pageNumber: number;
  width: number;
  height: number;
  mediaType: typeof PDF_PAGE_IMAGE_MEDIA_TYPE;
  detail: 'low';
}

export interface PdfEncodedPageImage extends PdfPageImageDescriptor {
  /** Model-only base64 JPEG payload. This field must be removed before public settlement. */
  data: string;
  byteLength: number;
}

export interface PdfSuccess {
  success: true;
  extractionMode: 'pdf';
  metadata: PdfPublicMetadata;
  markdownContent: string;
  truncated: boolean;
  warnings: string[];
  pdf: {
    pageCount: number;
    startPage: number;
    endPage: number;
    nextPage: number | null;
    layoutMode: 'plain' | 'layout';
    pageImages: PdfPageImageDescriptor[];
  };
  stats: {
    characterCount: number;
    wordCount: number;
    estimatedReadTime: number;
    extractedPageCount: number;
  };
}

export interface PdfParserSuccess extends PdfSuccess {
  /** Private parser transport payload removed by the public read-page adapter. */
  pageImageData: PdfEncodedPageImage[];
  /** Trusted offsets of generated page headings within markdownContent, in page-image order. */
  pageHeadingOffsets: number[];
}

export type PdfParserResult = PdfParserSuccess | PdfFailure;

export interface PdfHostResultMessage {
  type: 'result';
  result: PdfParserResult;
}

export interface PdfHostReadyMessage {
  type: 'ready';
}

export type PdfHostMessage = PdfHostReadyMessage | PdfHostResultMessage;

interface PdfParserRequestBase {
  type: 'parse';
  options: PdfReadOptions;
  source: {
    title: string;
    url: string;
  };
}

/** HTTP bytes arrive from the exact document; local bytes are acquired inside the claimed host. */
export type PdfParserRequest = PdfParserRequestBase &
  ({ bytes: ArrayBuffer; localFileUrl?: never } | { bytes?: never; localFileUrl: string });

export interface PdfParserReady {
  type: 'ready';
}

export interface PdfParserCancel {
  type: 'cancel';
}

export type PdfParserMessage = PdfParserRequest | PdfParserCancel;
