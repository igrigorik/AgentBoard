/**
 * Projects the sidebar's rendered transcript into the message list sent to the model.
 *
 * The sidebar already records every tool call and its result on the assistant message
 * that issued it; this projection is the step that was dropping them. Without it a
 * continuation -- an auto-continue after a tool set change, a step-limit summary, or a
 * plain user follow-up -- reached the model with the assistant's prose and no evidence
 * that any tool ran. The visible symptom was a retry loop. The worse, quieter symptom was
 * `stepLimitContinuationMessage` asking the model to "summarize what you accomplished"
 * with the record of what it accomplished removed, which produces fabrication.
 */

import type {
  ChatMessage,
  MessagePart,
  PageContext,
  PortChatMessage,
  PortToolCallPart,
  PortToolResultPart,
  ToolCall,
} from '../types';

/**
 * There is deliberately no history-level size budget here. Tools bound their own output at
 * the source (read_page caps at 32k characters), and a single streamText run already sends
 * every one of its results uncapped, so a budget that applied only to earlier turns would
 * make identical content legal in one request and abridged in the next.
 *
 * Conversation growth is real but pre-existing and broader than tool results: messageHistory
 * is unbounded and only reset by "clear conversation", so plain text already grows without
 * limit. That wants one policy over the whole conversation, not a rule that quietly starves
 * the tool records this projection exists to preserve.
 */
export interface ModelHistoryOptions {
  /** Tool hints describe capabilities available now, not historical capability snapshots. */
  siteToolHints?: Array<{ name: string; description: string }>;
  /** URL of the page the sidebar is attached to, used to scope the hints to the live turn. */
  currentPageUrl?: string;
  buildPageContextXml: (
    ctx: PageContext,
    siteToolHints?: Array<{ name: string; description: string }>
  ) => string;
}

function hasContent(content: ChatMessage['content']): boolean {
  return typeof content === 'string' ? content.trim() !== '' : content.length > 0;
}

function withContextPrefix(
  content: ChatMessage['content'],
  prefix: string
): ChatMessage['content'] {
  if (typeof content === 'string') return prefix + content;

  const parts: MessagePart[] = [...content];
  const firstTextIndex = parts.findIndex((part) => part.type === 'text');
  const firstText = parts[firstTextIndex];
  if (firstTextIndex >= 0 && firstText.text) {
    parts[firstTextIndex] = { ...firstText, text: prefix + firstText.text };
  } else {
    parts.unshift({ type: 'text', text: prefix });
  }
  return parts;
}

function assistantText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/**
 * Tools the user opted into: built into AgentBoard, exposed by an MCP server they
 * configured, or written by them as a user script. A `webmcp` tool is different in kind --
 * an arbitrary web page offered it and nobody chose it -- so its output is attacker-
 * authored text. Unknown provenance fails closed into the same bucket.
 */
function isOptedInSource(source: ToolCall['source']): boolean {
  return source === 'agentboard' || source === 'mcp' || source === 'custom';
}

function toolResultOutput(call: ToolCall): PortToolResultPart['output'] {
  // A call that never settled still needs a result part: providers reject an assistant
  // tool call with no answering tool message, so an interrupted turn would otherwise make
  // the entire conversation unsendable.
  if (call.status === 'pending' || call.status === 'running') {
    return {
      type: 'error-text',
      value: 'This tool call did not finish because the turn was interrupted.',
    };
  }

  // Carrying a page-registered tool's output forward would carry an injection attempt with
  // it, into later turns on a different site with a different tool set. The call record is
  // AgentBoard's own and is kept, so the model still knows what ran and need not fabricate;
  // only the page's words are dropped.
  //
  // Whether the call failed rides on the output type rather than in prose, which keeps the
  // marker short enough to be obviously a marker. No suggestion to call again: the tool may
  // have side effects nobody here can see, and retryability is the agent's call to make.
  if (!isOptedInSource(call.source)) {
    return call.status === 'error'
      ? { type: 'error-text', value: '[output not retained]' }
      : { type: 'text', value: '[output not retained]' };
  }

  if (call.status === 'error') {
    return { type: 'error-text', value: call.error ?? 'Tool execution failed' };
  }
  return typeof call.output === 'string'
    ? { type: 'text', value: call.output }
    : { type: 'json', value: (call.output ?? null) as PortToolResultPart['output']['value'] };
}

/**
 * Note on fidelity: an assistant turn that interleaved text, a tool call, more text and a
 * second tool call collapses into one assistant message carrying all of the text followed
 * by both tool calls, answered by one tool message. That is a valid shape, and the step
 * boundaries are not load-bearing for anything observed. Image bytes are genuinely gone --
 * they live in the service worker's read_page media side channel and never crossed the
 * port -- so replay carries the textual result only.
 */
export function toModelMessages(
  history: readonly ChatMessage[],
  options: ModelHistoryOptions
): PortChatMessage[] {
  const relevant = history.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      (hasContent(message.content) || (message.toolCalls?.length ?? 0) > 0)
  );

  let latestUserIndex = -1;
  for (let index = relevant.length - 1; index >= 0; index--) {
    if (relevant[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }

  const messages: PortChatMessage[] = [];

  relevant.forEach((message, index) => {
    if (message.role === 'user') {
      const pageContext = message.metadata?.pageContext;
      if (!pageContext) {
        messages.push({ role: 'user', content: message.content });
        return;
      }
      const hints =
        index === latestUserIndex && pageContext.url === options.currentPageUrl
          ? options.siteToolHints
          : undefined;
      messages.push({
        role: 'user',
        content: withContextPrefix(
          message.content,
          options.buildPageContextXml(pageContext, hints)
        ),
      });
      return;
    }

    const calls = message.toolCalls ?? [];
    const text = assistantText(message.content);
    if (calls.length === 0) {
      messages.push({ role: 'assistant', content: message.content });
      return;
    }

    const content: Array<{ type: 'text'; text: string } | PortToolCallPart> = [];
    if (text.trim() !== '') content.push({ type: 'text', text });
    for (const call of calls) {
      content.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.toolName,
        input: call.input,
      });
    }
    messages.push({ role: 'assistant', content });

    messages.push({
      role: 'tool',
      content: calls.map<PortToolResultPart>((call) => ({
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.toolName,
        output: toolResultOutput(call),
      })),
    });
  });

  return messages;
}
