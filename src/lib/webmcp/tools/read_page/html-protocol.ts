export const HTML_READER_HOST_FILE = 'content-scripts/read-page-html-host.js';
export const HTML_READER_HOST_KEY = '__agentboardReadPageHtmlV1';
export const HTML_READER_HOST_VERSION = 1;
export const HTML_READER_DEADLINE_MS = 10_000;

export interface HtmlReadSuccess {
  success: true;
  extractionMode: 'article' | 'rendered-text' | 'metadata';
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
}

export interface HtmlReadFailure {
  success: false;
  error: {
    code: 'PDF_READER_REQUIRED';
    message: string;
  };
}

export type HtmlReadResult = HtmlReadSuccess | HtmlReadFailure;
