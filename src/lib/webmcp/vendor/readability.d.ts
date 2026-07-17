/**
 * Type declarations for Readability vendor code
 * Mozilla Readability v0.6.0 (Apache License 2.0)
 */

export interface ReadabilityOptions {
  debug?: boolean;
  maxElemsToParse?: number;
  nbTopCandidates?: number;
  charThreshold?: number;
  classesToPreserve?: string[];
  keepClasses?: boolean;
  serializer?: (node: Node) => string;
  disableJSONLD?: boolean;
  allowedVideoRegex?: RegExp;
  linkDensityModifier?: number;
}

export interface ReadabilityArticle {
  /** Article title */
  title: string | null | undefined;
  /** HTML string of the article content */
  content: string | null | undefined;
  /** Text content of the article */
  textContent: string | null | undefined;
  /** Length of the article in characters */
  length: number | null | undefined;
  /** Excerpt of the article */
  excerpt: string | null | undefined;
  /** Article byline (author) */
  byline: string | null | undefined;
  /** Text direction */
  dir: string | null | undefined;
  /** Language */
  lang: string | null | undefined;
  /** Site name */
  siteName: string | null | undefined;
  /** Published time */
  publishedTime: string | null | undefined;
}

export declare class Readability {
  constructor(doc: Document, options?: ReadabilityOptions);
  parse(): ReadabilityArticle | null;
}
