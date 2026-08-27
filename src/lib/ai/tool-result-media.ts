import type {
  LanguageModelV2,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2ToolResultOutput,
} from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';

const TOOL_RESULT_MEDIA_OMITTED =
  'Tool-result media was omitted because this connection API accepts text-only tool results.';

/**
 * Downgrade only mixed tool outputs that actually contain media. Text and JSON outputs retain
 * their original representation, while encoded media is removed before a text-only provider
 * adapter can stringify it into model-visible prompt text.
 */
export function omitToolResultMedia(
  output: LanguageModelV2ToolResultOutput
): LanguageModelV2ToolResultOutput {
  if (output.type !== 'content' || !output.value.some((part) => part.type === 'media')) {
    return output;
  }

  const text = output.value.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  const omission = `[${TOOL_RESULT_MEDIA_OMITTED}]`;
  return {
    type: 'text',
    value: text ? `${text}\n\n${omission}` : omission,
  };
}

function omitMessageToolResultMedia(message: LanguageModelV2Message): LanguageModelV2Message {
  if (message.role !== 'assistant' && message.role !== 'tool') return message;

  let changed = false;
  if (message.role === 'tool') {
    const content = message.content.map((part) => {
      const output = omitToolResultMedia(part.output);
      if (output === part.output) return part;
      changed = true;
      return { ...part, output };
    });
    return changed ? { ...message, content } : message;
  }

  const content = message.content.map((part) => {
    if (part.type !== 'tool-result') return part;
    const output = omitToolResultMedia(part.output);
    if (output === part.output) return part;
    changed = true;
    return { ...part, output };
  });
  return changed ? { ...message, content } : message;
}

export function omitToolResultMediaFromPrompt(
  prompt: LanguageModelV2Prompt
): LanguageModelV2Prompt {
  let changed = false;
  const transformed = prompt.map((message) => {
    const next = omitMessageToolResultMedia(message);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? transformed : prompt;
}

const textOnlyToolResultMiddleware: LanguageModelMiddleware = {
  middlewareVersion: 'v2',
  transformParams: async ({ params }) => ({
    ...params,
    prompt: omitToolResultMediaFromPrompt(params.prompt),
  }),
};

/** Apply the connection API's text-only tool-result constraint at the provider boundary. */
export function withTextOnlyToolResults(model: LanguageModelV2): LanguageModelV2 {
  return wrapLanguageModel({ model, middleware: textOnlyToolResultMiddleware });
}
