import type { LanguageModelV2Prompt, LanguageModelV2ToolResultOutput } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import {
  omitToolResultMedia,
  omitToolResultMediaFromPrompt,
} from '../src/lib/ai/tool-result-media';

const encodedSentinel = 'BASE64_PAGE_IMAGE_SENTINEL';

function mixedOutput(): LanguageModelV2ToolResultOutput {
  return {
    type: 'content',
    value: [
      { type: 'text', text: 'Image 1 = PDF page 7' },
      { type: 'media', mediaType: 'image/jpeg', data: encodedSentinel },
      { type: 'text', text: 'Continue with page 8.' },
    ],
  };
}

describe('text-only tool-result media boundary', () => {
  it('retains ordered text while removing typed media and its encoded payload', () => {
    const output = mixedOutput();
    const transformed = omitToolResultMedia(output);

    expect(transformed).toEqual({
      type: 'text',
      value:
        'Image 1 = PDF page 7\nContinue with page 8.\n\n[Tool-result media was omitted because this connection API accepts text-only tool results.]',
    });
    expect(JSON.stringify(transformed)).not.toContain(encodedSentinel);
    expect(output).toEqual(mixedOutput());

    const jsonOutput = { type: 'json' as const, value: { answer: 42 } };
    expect(omitToolResultMedia(jsonOutput)).toBe(jsonOutput);
  });

  it('downgrades tool results in both tool and assistant messages without mutating input', () => {
    const plainPrompt: LanguageModelV2Prompt = [{ role: 'system', content: 'system' }];
    expect(omitToolResultMediaFromPrompt(plainPrompt)).toBe(plainPrompt);

    const toolOutput = mixedOutput();
    const assistantOutput = mixedOutput();
    const prompt: LanguageModelV2Prompt = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'assistant-call',
            toolName: 'reader',
            output: assistantOutput,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-call',
            toolName: 'reader',
            output: toolOutput,
          },
        ],
      },
    ];

    const transformed = omitToolResultMediaFromPrompt(prompt);

    expect(transformed).not.toBe(prompt);
    expect(JSON.stringify(transformed)).not.toContain(encodedSentinel);
    expect(JSON.stringify(prompt)).toContain(encodedSentinel);
    expect(transformed[0]).not.toBe(prompt[0]);
    expect(transformed[1]).not.toBe(prompt[1]);
  });

  it('returns an explicit omission marker for media-only outputs', () => {
    expect(
      omitToolResultMedia({
        type: 'content',
        value: [{ type: 'media', mediaType: 'image/jpeg', data: encodedSentinel }],
      })
    ).toEqual({
      type: 'text',
      value:
        '[Tool-result media was omitted because this connection API accepts text-only tool results.]',
    });
  });
});
