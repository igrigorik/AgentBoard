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

export type PdfFailureCode =
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
  };
  stats: {
    characterCount: number;
    wordCount: number;
    estimatedReadTime: number;
    extractedPageCount: number;
  };
}

export type PdfReadResult = PdfSuccess | PdfFailure;

export interface PdfHostResultMessage {
  type: 'result';
  result: PdfReadResult;
}

export interface PdfHostReadyMessage {
  type: 'ready';
}

export type PdfHostMessage = PdfHostReadyMessage | PdfHostResultMessage;

export interface PdfParserRequest {
  type: 'parse';
  bytes: ArrayBuffer;
  options: PdfReadOptions;
  source: {
    title: string;
    url: string;
  };
}

export interface PdfParserCancel {
  type: 'cancel';
}

export type PdfParserMessage = PdfParserRequest | PdfParserCancel;
