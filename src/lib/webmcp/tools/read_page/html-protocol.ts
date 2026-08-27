import { PAGE_IMAGE_MEDIA_TYPE } from './image-budget';

export const HTML_READER_HOST_FILE = 'content-scripts/read-page-html-host.js';
export const HTML_READER_HOST_KEY = '__agentboardReadPageHtmlV1';
export const HTML_READER_HOST_VERSION = 2;
export const HTML_READER_DEADLINE_MS = 10_000;

/**
 * Where the user's viewport sits in the document, reported by the private host.
 * Text snippets are page-controlled hints for locating the viewport within
 * markdownContent; the screenshot itself is the authoritative visual record.
 */
export interface HtmlViewportContext {
  /** 0-100; 0 when the document does not scroll. */
  scrollPercent: number;
  firstVisibleText: string;
  lastVisibleText: string;
}

/** Byte-free public descriptor for the viewport capture; bytes stay model-only. */
export interface ViewportImageDescriptor {
  imageIndex: 1;
  kind: 'viewport';
  width: number;
  height: number;
  mediaType: typeof PAGE_IMAGE_MEDIA_TYPE;
  detail: 'low';
}

export interface HtmlReadSuccess {
  success: true;
  // 'viewport-only' is assembled by the service worker when extraction fails but a
  // capture exists; the private host itself only emits the first three modes.
  extractionMode: 'article' | 'rendered-text' | 'metadata' | 'viewport-only';
  metadata: {
    title: string;
    url: string;
    author: string | null;
    siteName: string | null;
    publishedTime: string | null;
    modifiedTime: string | null;
    language: string;
    direction: string;
    extractedAt: string;
  };
  markdownContent: string;
  truncated: boolean;
  stats: {
    characterCount: number;
    wordCount: number;
    estimatedReadTime: number;
  };
  viewport?: HtmlViewportContext;
  /** Added by the service worker; never produced by the private host. */
  images?: ViewportImageDescriptor[];
  /** Also service-worker owned: assignment replaces any host value so the private
   *  host cannot surface model-visible warnings it did not earn. */
  warnings?: string[];
}

export interface HtmlReadFailure {
  success: false;
  error: {
    code: 'PDF_READER_REQUIRED';
    message: string;
  };
}

export type HtmlReadResult = HtmlReadSuccess | HtmlReadFailure;
