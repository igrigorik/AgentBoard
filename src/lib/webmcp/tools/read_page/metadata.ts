import {
  PDF_DEFAULT_MAX_LENGTH,
  PDF_DEFAULT_MAX_PAGES,
  PDF_HARD_MAX_LENGTH,
  PDF_HARD_MAX_PAGES,
  PDF_MIN_MAX_LENGTH,
} from './pdf/protocol';

export const READ_PAGE_TOOL_NAME = 'agentboard_read_page';
export const READ_PAGE_VERSION = '7.1.0';
export const READ_PAGE_DESCRIPTION =
  'Read the current HTML/PDF document, including allowed local PDFs, as bounded Markdown with document metadata and PDF page images by default.';

export const READ_PAGE_PARAMETER_DESCRIPTIONS = {
  maxLength: 'Maximum characters in markdownContent',
  startPage: 'First PDF page to read; ignored for HTML pages',
  maxPages: 'Maximum PDF pages to read; ignored for HTML pages',
  includePageImages:
    'Include reduced-resolution full-page images for PDFs. Omit this field to keep the true default. Set false only when the user explicitly requests text-only extraction or when retrying a prior page-image failure; summaries should retain images because figures and layout may contain evidence absent from extracted text. Ignored for HTML pages',
} as const;

export const READ_PAGE_METADATA = {
  description: READ_PAGE_DESCRIPTION,
  version: READ_PAGE_VERSION,
  inputSchema: {
    type: 'object',
    properties: {
      maxLength: {
        type: 'number',
        description: READ_PAGE_PARAMETER_DESCRIPTIONS.maxLength,
        minimum: PDF_MIN_MAX_LENGTH,
        maximum: PDF_HARD_MAX_LENGTH,
        default: PDF_DEFAULT_MAX_LENGTH,
      },
      startPage: {
        type: 'integer',
        description: READ_PAGE_PARAMETER_DESCRIPTIONS.startPage,
        minimum: 1,
        default: 1,
      },
      maxPages: {
        type: 'integer',
        description: READ_PAGE_PARAMETER_DESCRIPTIONS.maxPages,
        minimum: 1,
        maximum: PDF_HARD_MAX_PAGES,
        default: PDF_DEFAULT_MAX_PAGES,
      },
      includePageImages: {
        type: 'boolean',
        description: READ_PAGE_PARAMETER_DESCRIPTIONS.includePageImages,
        default: true,
      },
    },
    additionalProperties: false,
  },
} as const;
