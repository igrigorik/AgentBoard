import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream, stepCountIs, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadPageTool, type ReadPageInput } from '../src/lib/webmcp/tools/read_page';
import type {
  PdfHostMessage,
  PdfParserResult,
  PdfSuccess,
} from '../src/lib/webmcp/tools/read_page/pdf/protocol';

const mocks = vi.hoisted(() => ({
  getOwnedDocument: vi.fn(),
  ownsDocument: vi.fn(),
  isBuiltinToolEnabled: vi.fn(),
}));

vi.mock('../src/lib/webmcp/lifecycle', () => ({
  getTabManager: () => ({
    getOwnedDocument: mocks.getOwnedDocument,
    ownsDocument: mocks.ownsDocument,
  }),
}));

vi.mock('../src/lib/storage/config', () => ({
  ConfigStorage: {
    getInstance: () => ({ isBuiltinToolEnabled: mocks.isBuiltinToolEnabled }),
  },
}));

vi.mock('../src/lib/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function toolCallOptions(abortSignal?: AbortSignal) {
  return { toolCallId: 'test-call', messages: [], abortSignal };
}

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener(listener: (message: PdfHostMessage) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

function fakePdfPort(result?: PdfParserResult): FakePort {
  const messageListeners: Array<(message: PdfHostMessage) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
    name: 'agentboard-pdf-reader:test',
    postMessage: vi.fn((message: { type?: string }) => {
      if (message.type === 'start' && result) {
        queueMicrotask(() => {
          for (const listener of messageListeners) listener({ type: 'result', result });
        });
      }
    }),
    disconnect: vi.fn(() => {
      for (const listener of disconnectListeners) listener();
    }),
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
  };
  setTimeout(() => {
    for (const listener of messageListeners) listener({ type: 'ready' });
  }, 0);
  return port;
}

const htmlResult = {
  success: true as const,
  extractionMode: 'article' as const,
  metadata: {
    title: 'Fixture',
    url: 'https://example.test/article',
    author: null,
    siteName: null,
    publishedTime: null,
    modifiedTime: null,
    language: 'en',
    direction: 'ltr',
    extractedAt: '2026-01-01T00:00:00.000Z',
  },
  markdownContent: '# Fixture',
  truncated: false,
  stats: { characterCount: 9, wordCount: 2, estimatedReadTime: 1 },
  viewport: { scrollPercent: 0, firstVisibleText: 'Fixture', lastVisibleText: 'Fixture' },
};

const pdfResult: PdfSuccess = {
  success: true,
  extractionMode: 'pdf',
  metadata: {
    title: 'Fixture',
    url: 'https://example.test/document.pdf',
    author: null,
    siteName: null,
    publishedTime: null,
    modifiedTime: null,
    language: 'und',
    direction: 'ltr',
    extractedAt: '2026-01-01T00:00:00.000Z',
  },
  markdownContent: '# PDF: Fixture',
  truncated: false,
  warnings: [],
  pdf: {
    pageCount: 1,
    startPage: 1,
    endPage: 1,
    nextPage: null,
    layoutMode: 'layout',
    pageImages: [],
  },
  stats: {
    characterCount: 14,
    wordCount: 3,
    estimatedReadTime: 1,
    extractedPageCount: 1,
  },
};

const pdfParserResult: PdfParserResult = {
  ...pdfResult,
  pageImageData: [],
  pageHeadingOffsets: [],
};

const encodedPageImage = 'BASE64_PRIVATE_PAGE_IMAGE';
const pdfMediaParserResult: PdfParserResult = {
  ...pdfResult,
  markdownContent: '# PDF: Fixture\n\n## Page 1\n\n[No extractable text]',
  warnings: ['NO_PAGE_TEXT:page-1'],
  pdf: {
    ...pdfResult.pdf,
    pageImages: [
      {
        imageIndex: 1,
        pageNumber: 1,
        width: 791,
        height: 1_024,
        mediaType: 'image/jpeg',
        detail: 'low',
      },
    ],
  },
  pageImageData: [
    {
      imageIndex: 1,
      pageNumber: 1,
      width: 791,
      height: 1_024,
      mediaType: 'image/jpeg',
      detail: 'low',
      data: encodedPageImage,
      byteLength: 123,
    },
  ],
  pageHeadingOffsets: ['# PDF: Fixture\n\n'.length],
};

function installRelayPdf(result: PdfParserResult) {
  const port = fakePdfPort(result);
  const executeScript = vi.fn(async (details: { func?: unknown }) => [
    {
      documentId: 'doc-1',
      frameId: 0,
      result: details.func ? 'application/pdf' : undefined,
    },
  ]);
  const connect = vi.fn(() => port);
  vi.stubGlobal('chrome', { scripting: { executeScript }, tabs: { connect } });
  return { port, executeScript, connect };
}

describe('read-page document router', () => {
  beforeEach(() => {
    mocks.getOwnedDocument.mockReturnValue({ documentId: 'doc-1' });
    mocks.ownsDocument.mockReturnValue(true);
    mocks.isBuiltinToolEnabled.mockResolvedValue(true);
  });

  it('routes HTML through the private exact-document host without PDF-only arguments', async () => {
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) {
        return [{ documentId: 'doc-1', frameId: 0, result: htmlResult }];
      }
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);
    const input: ReadPageInput = {
      maxLength: 4_000,
      startPage: 3,
      maxPages: 2,
      includePageImages: false,
    };
    const executionOptions = toolCallOptions(new AbortController().signal);

    await expect(tool.execute?.(input, executionOptions)).resolves.toEqual(htmlResult);
    expect(executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['doc-1'] },
        world: 'ISOLATED',
        files: ['content-scripts/read-page-html-host.js'],
      })
    );
    expect(executeScript).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['doc-1'] },
        world: 'ISOLATED',
        args: ['__agentboardReadPageHtmlV1', 2, { maxLength: 4_000 }],
      })
    );
  });

  it.each([undefined, 'application/pdf; definitely-not-a-parameter'])(
    'fails closed when document-type probing returns an invalid browser-owned value',
    async (contentType) => {
      vi.stubGlobal('chrome', {
        scripting: {
          executeScript: vi.fn(async () => [
            { documentId: 'doc-1', frameId: 0, result: contentType },
          ]),
        },
        tabs: { connect: vi.fn() },
      });

      await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
        success: false,
        error: { code: 'PARSE_FAILED', message: 'The document type could not be determined.' },
      });
    }
  );

  it('rejects a malformed result from the private HTML host', async () => {
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) return [{ documentId: 'doc-1', frameId: 0, result: { success: true } }];
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });

    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).rejects.toThrow(
      'HTML reader returned an invalid result'
    );
  });

  it('rejects an HTML result that crosses its settlement deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) {
        now.mockReturnValue(10_000);
        return [{ documentId: 'doc-1', frameId: 0, result: htmlResult }];
      }
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });

    try {
      await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
        success: false,
        error: { code: 'TIMEOUT', message: 'HTML extraction exceeded its time limit.' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('fences caller cancellation without pretending to stop a running browser script', async () => {
    let releaseExtraction!: (results: chrome.scripting.InjectionResult<unknown>[]) => void;
    const extraction = new Promise<chrome.scripting.InjectionResult<unknown>[]>((resolve) => {
      releaseExtraction = resolve;
    });
    const executeScript = vi.fn((details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return Promise.resolve([{ documentId: 'doc-1', frameId: 0 }]);
      if (details.args) return extraction;
      return Promise.resolve([{ documentId: 'doc-1', frameId: 0, result: 'text/html' }]);
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    let settled = false;
    const execute = createReadPageTool(7).execute;
    if (!execute) throw new Error('read_page execute function is unavailable');
    const result = Promise.resolve(execute({}, toolCallOptions(controller.signal))).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(3));
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseExtraction([{ documentId: 'doc-1', frameId: 0, result: htmlResult }]);
    await expect(result).rejects.toBe(reason);
  });

  it('reports a neutral route failure for tabs that never had a readable document', async () => {
    mocks.getOwnedDocument.mockReturnValue(null);
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'chrome://settings/' }),
        connect: vi.fn(),
      },
    });

    // A PDF-branded code here would steer the model toward a nonexistent PDF remedy.
    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
      success: false,
      error: { code: 'ROUTE_UNAVAILABLE', message: 'The document route is unavailable.' },
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('returns an actionable local-file permission failure without attempting injection', async () => {
    mocks.getOwnedDocument.mockReturnValue(null);
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      extension: { isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(false) },
      scripting: { executeScript },
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'file:///private/example.pdf' }),
        connect: vi.fn(),
      },
    });

    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
      success: false,
      error: {
        code: 'PDF_READER_REQUIRED',
        message: 'Enable “Allow access to file URLs” for AgentBoard, then reload this local PDF.',
      },
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('resolves an allowed local PDF without a generic WebMCP relay route', async () => {
    mocks.getOwnedDocument.mockReturnValue(null);
    const port = fakePdfPort({
      ...pdfParserResult,
      metadata: { ...pdfParserResult.metadata, title: 'Local PDF', url: '' },
    });
    const executeScript = vi.fn(async (details: { func?: unknown; files?: string[] }) => {
      if (details.func) {
        return [
          {
            documentId: 'local-doc',
            frameId: 0,
            result: { isLocal: true, contentType: 'application/pdf' },
          },
        ];
      }
      return [{ documentId: 'local-doc', frameId: 0 }];
    });
    const getFrame = vi.fn().mockResolvedValue({ documentId: 'local-doc' });
    vi.stubGlobal('chrome', {
      extension: { isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(true) },
      scripting: { executeScript },
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'file:///private/example.pdf' }),
        connect: vi.fn(() => port),
      },
      webNavigation: { getFrame },
    });

    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toMatchObject({
      success: true,
      extractionMode: 'pdf',
      metadata: { title: 'Local PDF', url: '' },
    });
    expect(executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: { tabId: 7, frameIds: [0] },
        world: 'ISOLATED',
      })
    );
    expect(executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['local-doc'] },
        files: ['content-scripts/pdf-document-host.js'],
      })
    );
    expect(getFrame).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
  });

  it('does not settle a local PDF after cancellation during final route verification', async () => {
    mocks.getOwnedDocument.mockReturnValue(null);
    const port = fakePdfPort(pdfParserResult);
    const executeScript = vi.fn(async (details: { func?: unknown }) => {
      if (details.func) {
        return [
          {
            documentId: 'local-doc',
            frameId: 0,
            result: { isLocal: true, contentType: 'application/pdf' },
          },
        ];
      }
      return [{ documentId: 'local-doc', frameId: 0 }];
    });
    let resolveFrame!: (frame: { documentId: string }) => void;
    const getFrame = vi.fn(
      () =>
        new Promise<{ documentId: string }>((resolve) => {
          resolveFrame = resolve;
        })
    );
    vi.stubGlobal('chrome', {
      extension: { isAllowedFileSchemeAccess: vi.fn().mockResolvedValue(true) },
      scripting: { executeScript },
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'file:///private/example.pdf' }),
        connect: vi.fn(() => port),
      },
      webNavigation: { getFrame },
    });
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    const execution = createReadPageTool(7).execute?.({}, toolCallOptions(controller.signal));

    await vi.waitFor(() => expect(getFrame).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(execution).rejects.toBe(reason);
    resolveFrame({ documentId: 'local-doc' });
  });

  it('runs the exact-document PDF host and never calls the HTML delegate', async () => {
    const { port, executeScript, connect } = installRelayPdf(pdfParserResult);
    const tool = createReadPageTool(7);

    await expect(
      tool.execute?.(
        { maxLength: 32_000.75, startPage: 2, maxPages: 50, includePageImages: false },
        toolCallOptions()
      )
    ).resolves.toEqual(pdfResult);
    expect(executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ target: { tabId: 7, documentIds: ['doc-1'] } })
    );
    expect(executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['doc-1'] },
        files: ['content-scripts/pdf-document-host.js'],
      })
    );
    expect(connect).toHaveBeenCalledWith(7, expect.objectContaining({ documentId: 'doc-1' }));
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'start',
      capability: expect.any(String),
      options: { maxLength: 32_000, startPage: 2, maxPages: 50, includePageImages: false },
    });
  });

  it('applies the PDF defaults', async () => {
    const tool = createReadPageTool(7);
    const { port } = installRelayPdf(pdfParserResult);

    await expect(tool.execute?.({}, toolCallOptions())).resolves.toEqual(pdfResult);
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'start',
      capability: expect.any(String),
      options: { maxLength: 32_000, startPage: 1, maxPages: 25, includePageImages: true },
    });
  });

  it('keeps encoded PDF media private while exposing repeatable model-only attachments', async () => {
    installRelayPdf(pdfMediaParserResult);
    const tool = createReadPageTool(7);
    if (!tool.execute || !tool.toModelOutput) throw new Error('read_page media hooks unavailable');

    const output = await tool.execute({}, toolCallOptions());
    if (output && typeof output === 'object' && Symbol.asyncIterator in output) {
      throw new Error('read_page unexpectedly returned a stream');
    }
    expect(JSON.stringify(output)).not.toContain(encodedPageImage);
    expect(output).not.toHaveProperty('pageImageData');
    expect(output).not.toHaveProperty('pageHeadingOffsets');
    expect(output).toMatchObject({
      pdf: {
        pageImages: [
          {
            imageIndex: 1,
            pageNumber: 1,
            width: 791,
            height: 1_024,
            mediaType: 'image/jpeg',
            detail: 'low',
          },
        ],
      },
    });

    const firstModelOutput = tool.toModelOutput(output);
    expect(firstModelOutput).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: expect.stringMatching(
            /Image 1 = PDF page 1[\s\S]*## PDF page 1 — Image 1[\s\S]*No extractable text/
          ),
        },
        { type: 'media', data: encodedPageImage, mediaType: 'image/jpeg' },
      ],
    });
    expect(tool.toModelOutput(output)).toEqual(firstModelOutput);
  });

  it('uses trusted heading offsets instead of rewriting PDF-controlled heading text', async () => {
    const header = '# PDF: Fixture';
    const firstPage = '## Page 1\n\nBody reference:\n## Page 2\nnot a boundary';
    const secondPage = '## Page 2\n\nActual second page';
    const firstOffset = header.length + 2;
    const secondOffset = firstOffset + firstPage.length + 2;
    const descriptors = [1, 2].map((pageNumber) => ({
      imageIndex: pageNumber,
      pageNumber,
      width: 791,
      height: 1_024,
      mediaType: 'image/jpeg' as const,
      detail: 'low' as const,
    }));
    const parserResult: PdfParserResult = {
      ...pdfResult,
      markdownContent: `${header}\n\n${firstPage}\n\n${secondPage}`,
      pdf: {
        ...pdfResult.pdf,
        pageCount: 2,
        endPage: 2,
        pageImages: descriptors,
      },
      stats: { ...pdfResult.stats, extractedPageCount: 2 },
      pageImageData: descriptors.map((descriptor) => ({
        ...descriptor,
        data: `IMAGE_${descriptor.imageIndex}`,
        byteLength: 100,
      })),
      pageHeadingOffsets: [firstOffset, secondOffset],
    };
    installRelayPdf(parserResult);
    const tool = createReadPageTool(7);
    if (!tool.execute || !tool.toModelOutput) throw new Error('read_page media hooks unavailable');
    const output = await tool.execute({}, toolCallOptions());
    if (output && typeof output === 'object' && Symbol.asyncIterator in output) {
      throw new Error('read_page unexpectedly returned a stream');
    }

    const modelOutput = tool.toModelOutput(output);
    expect(modelOutput.type).toBe('content');
    if (modelOutput.type !== 'content') throw new Error('expected rich model output');
    expect(modelOutput.value).toHaveLength(3);
    const text = modelOutput.value[0];
    if (text.type !== 'text') throw new Error('expected manifest text first');
    expect(text.text).toContain('## Page 2\nnot a boundary');
    expect(text.text.match(/## PDF page 2 — Image 2/gu)).toHaveLength(1);
    expect(modelOutput.value.slice(1)).toEqual([
      { type: 'media', data: 'IMAGE_1', mediaType: 'image/jpeg' },
      { type: 'media', data: 'IMAGE_2', mediaType: 'image/jpeg' },
    ]);
  });

  it('preserves private media identity through real AI SDK tool execution', async () => {
    installRelayPdf(pdfMediaParserResult);
    const prompts: unknown[] = [];
    let invocation = 0;
    const model = {
      specificationVersion: 'v2' as const,
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: async (options: LanguageModelV2CallOptions) => {
        prompts.push(options.prompt);
        invocation += 1;
        const chunks: LanguageModelV2StreamPart[] =
          invocation === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'read-call',
                  toolName: 'read_page',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text' },
                { type: 'text-delta', id: 'text', delta: 'Done.' },
                { type: 'text-end', id: 'text' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ];
        return {
          stream: simulateReadableStream({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    };
    const stream = streamText({
      model,
      messages: [{ role: 'user', content: 'Read the PDF' }],
      tools: { read_page: createReadPageTool(7) },
      stopWhen: stepCountIs(2),
    });
    const parts = [];
    for await (const part of stream.fullStream) parts.push(part);

    const rawResult = parts.find((part) => part.type === 'tool-result');
    expect(JSON.stringify(rawResult)).not.toContain(encodedPageImage);
    expect(prompts).toHaveLength(2);
    const continuationPrompt = JSON.stringify(prompts[1]);
    expect(continuationPrompt).toContain(encodedPageImage);
    expect(continuationPrompt).toContain('Image 1 = PDF page 1');
  });

  it.each([null, { maxPages: 51 }])(
    'rejects malformed direct input before browser work',
    async (input) => {
      const executeScript = vi.fn();
      vi.stubGlobal('chrome', {
        scripting: { executeScript },
        tabs: { connect: vi.fn() },
      });
      const tool = createReadPageTool(7);

      await expect(tool.execute?.(input as never, toolCallOptions())).rejects.toThrow(
        'WebMCP tool arguments are invalid'
      );
      expect(executeScript).not.toHaveBeenCalled();
    }
  );

  it('fails closed when the HTML host settles after its document route is replaced', async () => {
    mocks.ownsDocument.mockReturnValue(false);
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) {
        return [{ documentId: 'doc-1', frameId: 0, result: htmlResult }];
      }
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions())).resolves.toMatchObject({
      success: false,
      error: { code: 'NAVIGATED' },
    });
  });

  it('times out while document-type detection is still pending', async () => {
    vi.useFakeTimers();
    const executeScript = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    try {
      const result = tool.execute?.({}, toolCallOptions());
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(result).resolves.toEqual({
        success: false,
        error: { code: 'TIMEOUT', message: 'Document type detection exceeded its time limit.' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out while the exact-document host is still being injected', async () => {
    vi.useFakeTimers();
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ documentId: 'doc-1', frameId: 0, result: 'application/pdf' }])
      .mockReturnValueOnce(new Promise(() => undefined));
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    try {
      const result = tool.execute?.({}, toolCallOptions());
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toEqual({
        success: false,
        error: { code: 'TIMEOUT', message: 'PDF extraction exceeded its time limit.' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports packaged PDF host injection failure without inventing navigation', async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ documentId: 'doc-1', frameId: 0, result: 'application/pdf' }])
      .mockRejectedValueOnce(new Error('packaged host unavailable'));
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });

    await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toEqual({
      success: false,
      error: { code: 'PDF_READER_REQUIRED', message: 'The local PDF reader is unavailable.' },
    });
  });

  it('reports a current-document PDF Port loss without inventing navigation', async () => {
    const port = fakePdfPort();
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async (details: { func?: unknown }) => [
          {
            documentId: 'doc-1',
            frameId: 0,
            result: details.func ? 'application/pdf' : undefined,
          },
        ]),
      },
      tabs: { connect: vi.fn(() => port) },
    });
    const execution = createReadPageTool(7).execute?.({}, toolCallOptions());
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start' }))
    );
    port.disconnect();

    await expect(execution).resolves.toEqual({
      success: false,
      error: { code: 'PDF_READER_REQUIRED', message: 'The local PDF reader is unavailable.' },
    });
  });

  it('fails closed when the captured document no longer owns settlement', async () => {
    const port = fakePdfPort(pdfParserResult);
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async (details: { func?: unknown }) => [
          {
            documentId: 'doc-1',
            frameId: 0,
            result: details.func ? 'application/pdf' : undefined,
          },
        ]),
      },
      tabs: { connect: vi.fn(() => port) },
    });
    mocks.ownsDocument.mockReturnValue(false);
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions())).resolves.toMatchObject({
      success: false,
      error: { code: 'NAVIGATED' },
    });
  });

  it('cancels and disconnects document-owned work when the caller aborts', async () => {
    const port = fakePdfPort();
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async (details: { func?: unknown }) => [
          {
            documentId: 'doc-1',
            frameId: 0,
            result: details.func ? 'application/pdf' : undefined,
          },
        ]),
      },
      tabs: { connect: vi.fn(() => port) },
    });
    const controller = new AbortController();
    const tool = createReadPageTool(7);
    const execution = tool.execute?.({}, toolCallOptions(controller.signal));
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start' }))
    );

    controller.abort(new Error('caller cancelled'));

    await expect(execution).rejects.toThrow('caller cancelled');
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('does no document work after the built-in is disabled', async () => {
    mocks.isBuiltinToolEnabled.mockResolvedValue(false);
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions())).rejects.toThrow('Tool disabled');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('does no browser work for an already-aborted call', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn() },
    });
    const tool = createReadPageTool(7);

    await expect(tool.execute?.({}, toolCallOptions(controller.signal))).rejects.toThrow(
      'caller cancelled'
    );
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe('read-page viewport capture', () => {
  const encodedViewportBytes = 'VIEWPORT_JPEG_BYTES';

  beforeEach(() => {
    mocks.getOwnedDocument.mockReturnValue({ documentId: 'doc-1' });
    mocks.ownsDocument.mockReturnValue(true);
    mocks.isBuiltinToolEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubViewportEnvironment() {
    const bytes = new TextEncoder().encode(encodedViewportBytes);
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      // jsdom's Blob lacks arrayBuffer(); fake the exact encode contract the code consumes.
      convertToBlob = vi.fn(
        async () =>
          ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) }) as Blob
      );
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1_600, height: 900, close: vi.fn() }))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => ({}) as Blob }))
    );
    return btoa(encodedViewportBytes);
  }

  function htmlExecuteScript(result: unknown) {
    return vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) return [{ documentId: 'doc-1', frameId: 0, result }];
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
  }

  function stubChromeWithCapture(
    executeScript: ReturnType<typeof vi.fn>,
    tab: Record<string, unknown> = { active: true, windowId: 5 }
  ) {
    const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,AAAA');
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { connect: vi.fn(), get: vi.fn().mockResolvedValue(tab), captureVisibleTab },
    });
    return { captureVisibleTab };
  }

  const viewportDescriptor = {
    imageIndex: 1,
    kind: 'viewport',
    width: 1_024,
    height: 576,
    mediaType: 'image/jpeg',
    detail: 'low',
  };

  it('attaches a byte-free viewport descriptor with identity-bound model media', async () => {
    const expectedData = stubViewportEnvironment();
    stubChromeWithCapture(htmlExecuteScript(structuredClone(htmlResult)));
    const tool = createReadPageTool(7);
    if (!tool.execute || !tool.toModelOutput) throw new Error('read_page media hooks unavailable');

    const output = await tool.execute({}, toolCallOptions());
    if (output && typeof output === 'object' && Symbol.asyncIterator in output) {
      throw new Error('read_page unexpectedly returned a stream');
    }
    expect(JSON.stringify(output)).not.toContain(expectedData);
    expect(output).toMatchObject({
      extractionMode: 'article',
      markdownContent: '# Fixture',
      images: [viewportDescriptor],
    });
    expect(output).not.toHaveProperty('warnings');

    expect(tool.toModelOutput(output)).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: expect.stringMatching(
            /Image 1 = the user's current browser viewport \(~0% scrolled\)[\s\S]*Visible text spans "Fixture" through "Fixture"[\s\S]*# Fixture/
          ),
        },
        { type: 'media', data: expectedData, mediaType: 'image/jpeg' },
      ],
    });
    // Identity-bound: replayed or cloned results carry no private bytes.
    expect(tool.toModelOutput(structuredClone(output))).toEqual({
      type: 'json',
      value: structuredClone(output),
    });
  });

  it('downgrades to a warning without an image when the bound tab is inactive', async () => {
    stubViewportEnvironment();
    const { captureVisibleTab } = stubChromeWithCapture(
      htmlExecuteScript(structuredClone(htmlResult)),
      { active: false, windowId: 5 }
    );
    const tool = createReadPageTool(7);
    if (!tool.execute || !tool.toModelOutput) throw new Error('read_page media hooks unavailable');

    const output = await tool.execute({}, toolCallOptions());
    if (output && typeof output === 'object' && Symbol.asyncIterator in output) {
      throw new Error('read_page unexpectedly returned a stream');
    }
    expect(output).toMatchObject({
      extractionMode: 'article',
      warnings: ['VIEWPORT_UNAVAILABLE:inactive-tab'],
    });
    expect(output).not.toHaveProperty('images');
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(tool.toModelOutput(output)).toMatchObject({ type: 'json' });
  });

  it('returns viewport-only success when extraction fails but the capture succeeded', async () => {
    stubViewportEnvironment();
    stubChromeWithCapture(htmlExecuteScript({ success: true }), {
      active: true,
      windowId: 5,
      title: 'Fallback Tab',
      url: 'https://example.test/spa',
    });
    const tool = createReadPageTool(7);
    if (!tool.execute || !tool.toModelOutput) throw new Error('read_page media hooks unavailable');

    const output = await tool.execute({}, toolCallOptions());
    if (output && typeof output === 'object' && Symbol.asyncIterator in output) {
      throw new Error('read_page unexpectedly returned a stream');
    }
    expect(output).toMatchObject({
      success: true,
      extractionMode: 'viewport-only',
      metadata: { title: 'Fallback Tab', url: 'https://example.test/spa' },
      markdownContent: '',
      warnings: ['HTML_EXTRACTION_FAILED'],
      images: [viewportDescriptor],
    });
    expect(tool.toModelOutput(output)).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: expect.stringMatching(/viewport image is the only available content/),
        },
        { type: 'media', data: btoa(encodedViewportBytes), mediaType: 'image/jpeg' },
      ],
    });
  });

  it('marks extraction deadline failures as timeouts in viewport-only results', async () => {
    stubViewportEnvironment();
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const executeScript = vi.fn(async (details: { args?: unknown[]; files?: string[] }) => {
      if (details.files) return [{ documentId: 'doc-1', frameId: 0 }];
      if (details.args) {
        now.mockReturnValue(10_000);
        return [{ documentId: 'doc-1', frameId: 0, result: structuredClone(htmlResult) }];
      }
      return [{ documentId: 'doc-1', frameId: 0, result: 'text/html' }];
    });
    stubChromeWithCapture(executeScript);

    try {
      await expect(createReadPageTool(7).execute?.({}, toolCallOptions())).resolves.toMatchObject({
        success: true,
        extractionMode: 'viewport-only',
        warnings: ['HTML_EXTRACTION_TIMEOUT'],
        images: [viewportDescriptor],
      });
    } finally {
      now.mockRestore();
    }
  });

  it('drops warnings supplied by the private host rather than forwarding them', async () => {
    stubViewportEnvironment();
    // The host is validated by shape, not sanitized, so the service worker must own
    // this field outright; a forwarded value would read as trusted extension output.
    stubChromeWithCapture(
      htmlExecuteScript({ ...structuredClone(htmlResult), warnings: ['HOST_SUPPLIED_WARNING'] })
    );

    const output = await createReadPageTool(7).execute?.(
      { includePageImages: false },
      toolCallOptions()
    );
    expect(output).not.toHaveProperty('warnings');
  });

  it('skips capture work entirely when includePageImages is false', async () => {
    stubViewportEnvironment();
    const { captureVisibleTab } = stubChromeWithCapture(
      htmlExecuteScript(structuredClone(htmlResult))
    );
    const tool = createReadPageTool(7);

    const output = await tool.execute?.({ includePageImages: false }, toolCallOptions());
    expect(output).toEqual(htmlResult);
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });
});
