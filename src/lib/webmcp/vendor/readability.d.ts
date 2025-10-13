/**
 * Type declarations for Readability vendor code
 * Mozilla Readability v0.5.0 (Apache License 2.0)
 */

export interface ReadabilityOptions {
  debug?: boolean;
  maxElemsToParse?: number;
  nbTopCandidates?: number;
  charThreshold?: number;
  classesToPreserve?: string[];
  keepClasses?: boolean;
  serializer?: (el: Element) => string;
  disableJSONLD?: boolean;
  allowedVideoRegex?: RegExp;
}

export interface ReadabilityArticle {
  /** Article title */
  title: string;
  /** HTML string of the article content */
  content: string;
  /** Text content of the article */
  textContent: string;
  /** Length of the article in characters */
  length: number;
  /** Excerpt of the article */
  excerpt: string;
  /** Article byline (author) */
  byline: string | null;
  /** Text direction */
  dir: string | null;
  /** Language */
  lang: string | null;
  /** Site name */
  siteName: string | null;
  /** Published time */
  publishedTime: string | null;
}

export declare class Readability {
  constructor(doc: Document, options?: ReadabilityOptions);
  parse(): ReadabilityArticle | null;
}
