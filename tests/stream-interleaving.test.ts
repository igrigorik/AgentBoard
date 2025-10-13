/**
 * Test file modeling the interleaved stream structure
 * Based on actual trace from reasoning-trace.md
 */

import { describe, it, expect, vi } from 'vitest';

// Mock stream events based on actual trace
const mockStreamEvents = [
  // 1. Native reasoning events
  { type: 'reasoning-start', id: '0' },
  { type: 'reasoning-delta', id: '0', text: 'The user wants me to:' },
  { type: 'reasoning-delta', id: '0', text: '\n1. Check the refund policy' },
  { type: 'reasoning-delta', id: '0', text: '\n2. Increment the count to 2' },
  { type: 'reasoning-end', id: '0' },

  // 2. Text Block #1
  { type: 'text-start', id: '1' },
  {
    type: 'text-delta',
    id: '1',
    text: "I'll check the refund policy details for you and update your cart",
  },
  { type: 'text-delta', id: '1', text: ' to 2 pairs of the SuperLight Wool Runners.' },
  { type: 'text-end', id: '1' },

  // 3. Tool calls
  { type: 'tool-call', toolCallId: 'tool1', toolName: 'search_shop_policies_and_faqs', input: {} },
  { type: 'tool-call', toolCallId: 'tool2', toolName: 'update_cart', input: {} },
  { type: 'tool-result', toolCallId: 'tool1', output: '[policy details]' },
  { type: 'tool-result', toolCallId: 'tool2', output: 'Invalid cart_id format' },
  { type: 'finish-step', finishReason: 'tool-calls' },

  // 4. New step starts
  { type: 'start-step' },

  // 5. Text Block #2
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', text: 'Let me get the current cart' },
  { type: 'text-delta', id: '0', text: ' to see the proper format and then update it:' },
  { type: 'text-end', id: '0' },

  // 6. Tool call
  { type: 'tool-call', toolCallId: 'tool3', toolName: 'get_cart', input: {} },
  { type: 'tool-result', toolCallId: 'tool3', output: 'Invalid cart_id format' },
  { type: 'finish-step', finishReason: 'tool-calls' },

  // 7. New step starts
  { type: 'start-step' },

  // 8. Text Block #3
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', text: 'Let me create a new cart with 2 pairs' },
  { type: 'text-end', id: '0' },

  // 9. Tool call
  { type: 'tool-call', toolCallId: 'tool4', toolName: 'update_cart', input: {} },
  { type: 'tool-result', toolCallId: 'tool4', output: 'Product variant not found' },

  // 10. Final finish
  { type: 'finish', finishReason: 'tool-calls' },
];

describe('Stream Interleaving', () => {
  it('should handle interleaved reasoning, text blocks, and tool calls', () => {
    const callbacks = {
      onReasoningStart: vi.fn(),
      onReasoningChunk: vi.fn(),
      onReasoningEnd: vi.fn(),
      onTextBlockStart: vi.fn(), // NEW: Individual text block start
      onTextBlockChunk: vi.fn(), // NEW: Chunks for current text block
      onTextBlockEnd: vi.fn(), // NEW: Individual text block end
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onFinish: vi.fn(),
    };

    // Expected output structure
    const expectedFlow = [];

    // Process mock stream
    for (const event of mockStreamEvents) {
      switch (event.type) {
        case 'reasoning-start':
          callbacks.onReasoningStart();
          expectedFlow.push({ type: 'reasoning', action: 'start' });
          break;

        case 'reasoning-delta':
          callbacks.onReasoningChunk(event.text);
          break;

        case 'reasoning-end':
          callbacks.onReasoningEnd();
          expectedFlow.push({ type: 'reasoning', action: 'end' });
          break;

        case 'text-start':
          // Each text block should be a separate message
          callbacks.onTextBlockStart(event.id);
          expectedFlow.push({ type: 'text-block', id: event.id, action: 'start' });
          break;

        case 'text-delta':
          callbacks.onTextBlockChunk(event.id, event.text);
          break;

        case 'text-end':
          callbacks.onTextBlockEnd(event.id);
          expectedFlow.push({ type: 'text-block', id: event.id, action: 'end' });
          break;

        case 'tool-call':
          callbacks.onToolCall(event);
          expectedFlow.push({ type: 'tool-call', toolName: event.toolName });
          break;

        case 'tool-result':
          callbacks.onToolResult(event.toolCallId, event.output);
          expectedFlow.push({ type: 'tool-result', toolCallId: event.toolCallId });
          break;
      }
    }

    // Verify callbacks were called in the right order
    expect(callbacks.onReasoningStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onReasoningEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextBlockStart).toHaveBeenCalledTimes(3); // 3 text blocks
    expect(callbacks.onTextBlockEnd).toHaveBeenCalledTimes(3);
    expect(callbacks.onToolCall).toHaveBeenCalledTimes(4); // 4 tool calls
    expect(callbacks.onToolResult).toHaveBeenCalledTimes(4);

    // Verify the flow order
    expect(expectedFlow).toEqual([
      { type: 'reasoning', action: 'start' },
      { type: 'reasoning', action: 'end' },
      { type: 'text-block', id: '1', action: 'start' },
      { type: 'text-block', id: '1', action: 'end' },
      { type: 'tool-call', toolName: 'search_shop_policies_and_faqs' },
      { type: 'tool-call', toolName: 'update_cart' },
      { type: 'tool-result', toolCallId: 'tool1' },
      { type: 'tool-result', toolCallId: 'tool2' },
      { type: 'text-block', id: '0', action: 'start' },
      { type: 'text-block', id: '0', action: 'end' },
      { type: 'tool-call', toolName: 'get_cart' },
      { type: 'tool-result', toolCallId: 'tool3' },
      { type: 'text-block', id: '0', action: 'start' },
      { type: 'text-block', id: '0', action: 'end' },
      { type: 'tool-call', toolName: 'update_cart' },
      { type: 'tool-result', toolCallId: 'tool4' },
    ]);
  });

  it('should create separate UI nodes for each element', () => {
    // Mock UI node creation
    interface UINode {
      type: string;
      data: any;
      element: string;
    }
    const uiNodes: UINode[] = [];

    const createNode = (type: string, data: any): UINode => {
      const node = { type, data, element: `<div class="${type}">` };
      uiNodes.push(node);
      return node;
    };

    // Process stream and create UI nodes
    for (const event of mockStreamEvents) {
      switch (event.type) {
        case 'reasoning-start':
          createNode('reasoning-box', { streaming: true });
          break;

        case 'text-start':
          createNode('text-message', { id: event.id, streaming: true });
          break;

        case 'tool-call':
          createNode('tool-call-box', { toolName: event.toolName });
          break;
      }
    }

    // Verify we have the right number of UI nodes
    const reasoningBoxes = uiNodes.filter((n) => n.type === 'reasoning-box');
    const textMessages = uiNodes.filter((n) => n.type === 'text-message');
    const toolBoxes = uiNodes.filter((n) => n.type === 'tool-call-box');

    expect(reasoningBoxes).toHaveLength(1);
    expect(textMessages).toHaveLength(3); // 3 separate text blocks
    expect(toolBoxes).toHaveLength(4); // 4 tool calls

    // Verify order: reasoning -> text -> tools -> text -> tool -> text -> tool
    expect(uiNodes[0].type).toBe('reasoning-box');
    expect(uiNodes[1].type).toBe('text-message');
    expect(uiNodes[2].type).toBe('tool-call-box');
    expect(uiNodes[3].type).toBe('tool-call-box');
    expect(uiNodes[4].type).toBe('text-message');
    expect(uiNodes[5].type).toBe('tool-call-box');
    expect(uiNodes[6].type).toBe('text-message');
    expect(uiNodes[7].type).toBe('tool-call-box');
  });
});
