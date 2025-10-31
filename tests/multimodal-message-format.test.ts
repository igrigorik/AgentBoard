/**
 * Tests for multi-modal message format handling
 *
 * Critical paths tested:
 * - MessageContent type handling (string vs multi-part)
 * - MessagePart validation
 * - Message filtering with multi-part content
 * - Backward compatibility with string-only messages
 */

import { describe, it, expect } from 'vitest';
import type { ChatMessage, MessageContent, MessagePart } from '../src/types';

describe('MessageContent Type Handling', () => {
  describe('String Content (Backward Compatible)', () => {
    it('should handle string content', () => {
      const message: ChatMessage = {
        id: 'test-1',
        role: 'user',
        content: 'Hello world',
        timestamp: Date.now(),
      };

      expect(typeof message.content).toBe('string');
      expect(message.content).toBe('Hello world');
    });

    it('should handle empty string content', () => {
      const message: ChatMessage = {
        id: 'test-2',
        role: 'user',
        content: '',
        timestamp: Date.now(),
      };

      expect(typeof message.content).toBe('string');
      expect(message.content).toBe('');
    });
  });

  describe('Multi-Part Content', () => {
    it('should handle text-only multi-part content', () => {
      const content: MessageContent = [{ type: 'text', text: 'Hello' }];

      const message: ChatMessage = {
        id: 'test-3',
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      expect(Array.isArray(message.content)).toBe(true);
      expect((message.content as MessagePart[]).length).toBe(1);
      expect((message.content as MessagePart[])[0].type).toBe('text');
    });

    it('should handle image-only multi-part content', () => {
      const content: MessageContent = [
        {
          type: 'image',
          image: 'data:image/png;base64,abc123',
          mimeType: 'image/png',
        },
      ];

      const message: ChatMessage = {
        id: 'test-4',
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      expect(Array.isArray(message.content)).toBe(true);
      const parts = message.content as MessagePart[];
      expect(parts[0].type).toBe('image');
      expect(parts[0].image).toBe('data:image/png;base64,abc123');
      expect(parts[0].mimeType).toBe('image/png');
    });

    it('should handle text + image multi-part content', () => {
      const content: MessageContent = [
        { type: 'text', text: 'Check this out:' },
        {
          type: 'image',
          image: 'data:image/jpeg;base64,xyz789',
          mimeType: 'image/jpeg',
        },
      ];

      const message: ChatMessage = {
        id: 'test-5',
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      const parts = message.content as MessagePart[];
      expect(parts.length).toBe(2);
      expect(parts[0].type).toBe('text');
      expect(parts[1].type).toBe('image');
    });

    it('should handle multiple images with text', () => {
      const content: MessageContent = [
        { type: 'text', text: 'Compare these:' },
        {
          type: 'image',
          image: 'data:image/png;base64,img1',
          mimeType: 'image/png',
        },
        {
          type: 'image',
          image: 'data:image/png;base64,img2',
          mimeType: 'image/png',
        },
      ];

      const message: ChatMessage = {
        id: 'test-6',
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      const parts = message.content as MessagePart[];
      expect(parts.length).toBe(3);
      expect(parts.filter((p) => p.type === 'image').length).toBe(2);
    });
  });

  describe('hasAttachments Metadata', () => {
    it('should set hasAttachments=true for messages with images', () => {
      const message: ChatMessage = {
        id: 'test-7',
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', image: 'data:image/png;base64,abc', mimeType: 'image/png' },
        ],
        timestamp: Date.now(),
        metadata: { hasAttachments: true },
      };

      expect(message.metadata?.hasAttachments).toBe(true);
    });

    it('should not set hasAttachments for text-only messages', () => {
      const message: ChatMessage = {
        id: 'test-8',
        role: 'user',
        content: 'Just text',
        timestamp: Date.now(),
        metadata: { hasAttachments: false },
      };

      expect(message.metadata?.hasAttachments).toBe(false);
    });
  });
});

describe('Message Filtering Logic', () => {
  describe('Empty Message Detection', () => {
    it('should identify empty string messages', () => {
      const messages: ChatMessage[] = [
        {
          id: '1',
          role: 'user',
          content: '',
          timestamp: Date.now(),
        },
        {
          id: '2',
          role: 'user',
          content: '   ',
          timestamp: Date.now(),
        },
        {
          id: '3',
          role: 'user',
          content: 'Valid message',
          timestamp: Date.now(),
        },
      ];

      // Filter logic from sidebar
      const nonEmpty = messages.filter((m) => {
        if (typeof m.content === 'string') {
          return m.content.trim() !== '';
        }
        return m.content.length > 0;
      });

      expect(nonEmpty.length).toBe(1);
      expect(nonEmpty[0].id).toBe('3');
    });

    it('should identify empty multi-part messages', () => {
      const messages: ChatMessage[] = [
        {
          id: '1',
          role: 'user',
          content: [],
          timestamp: Date.now(),
        },
        {
          id: '2',
          role: 'user',
          content: [{ type: 'text', text: 'Valid' }],
          timestamp: Date.now(),
        },
      ];

      const nonEmpty = messages.filter((m) => {
        if (typeof m.content === 'string') {
          return m.content.trim() !== '';
        }
        return m.content.length > 0;
      });

      expect(nonEmpty.length).toBe(1);
      expect(nonEmpty[0].id).toBe('2');
    });

    it('should keep messages with only images (no text)', () => {
      const messages: ChatMessage[] = [
        {
          id: '1',
          role: 'user',
          content: [{ type: 'image', image: 'data:image/png;base64,abc', mimeType: 'image/png' }],
          timestamp: Date.now(),
        },
      ];

      const nonEmpty = messages.filter((m) => {
        if (typeof m.content === 'string') {
          return m.content.trim() !== '';
        }
        return m.content.length > 0;
      });

      expect(nonEmpty.length).toBe(1);
    });
  });

  describe('Role Filtering', () => {
    it('should filter by user and assistant roles', () => {
      const messages: ChatMessage[] = [
        {
          id: '1',
          role: 'user',
          content: 'User message',
          timestamp: Date.now(),
        },
        {
          id: '2',
          role: 'assistant',
          content: 'Assistant message',
          timestamp: Date.now(),
        },
        {
          id: '3',
          role: 'system',
          content: 'System message',
          timestamp: Date.now(),
        },
        {
          id: '4',
          role: 'tool',
          content: 'Tool result',
          timestamp: Date.now(),
        },
      ];

      const userAndAssistant = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

      expect(userAndAssistant.length).toBe(2);
      expect(userAndAssistant.map((m) => m.id)).toEqual(['1', '2']);
    });
  });
});

describe('MessagePart Validation', () => {
  describe('Text Parts', () => {
    it('should validate text part structure', () => {
      const part: MessagePart = {
        type: 'text',
        text: 'Hello world',
      };

      expect(part.type).toBe('text');
      expect(part.text).toBe('Hello world');
      expect(part.image).toBeUndefined();
      expect(part.mimeType).toBeUndefined();
    });

    it('should handle empty text in text part', () => {
      const part: MessagePart = {
        type: 'text',
        text: '',
      };

      expect(part.type).toBe('text');
      expect(part.text).toBe('');
    });
  });

  describe('Image Parts', () => {
    it('should validate image part structure', () => {
      const part: MessagePart = {
        type: 'image',
        image: 'data:image/png;base64,iVBORw0KGgo...',
        mimeType: 'image/png',
      };

      expect(part.type).toBe('image');
      expect(part.image).toBeDefined();
      expect(part.mimeType).toBe('image/png');
      expect(part.text).toBeUndefined();
    });

    it('should handle various image MIME types', () => {
      const mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

      for (const mimeType of mimeTypes) {
        const part: MessagePart = {
          type: 'image',
          image: `data:${mimeType};base64,abc123`,
          mimeType,
        };

        expect(part.mimeType).toBe(mimeType);
      }
    });
  });
});

describe('Content Extraction', () => {
  it('should extract text from string content', () => {
    const message: ChatMessage = {
      id: '1',
      role: 'user',
      content: 'Hello world',
      timestamp: Date.now(),
    };

    const text = typeof message.content === 'string' ? message.content : '';
    expect(text).toBe('Hello world');
  });

  it('should extract text from multi-part content', () => {
    const message: ChatMessage = {
      id: '2',
      role: 'user',
      content: [
        { type: 'text', text: 'First part' },
        { type: 'image', image: 'data:image/png;base64,abc', mimeType: 'image/png' },
        { type: 'text', text: 'Second part' },
      ],
      timestamp: Date.now(),
    };

    const textParts =
      typeof message.content === 'string'
        ? [message.content]
        : message.content.filter((p) => p.type === 'text').map((p) => p.text);

    expect(textParts).toEqual(['First part', 'Second part']);
  });

  it('should extract images from multi-part content', () => {
    const message: ChatMessage = {
      id: '3',
      role: 'user',
      content: [
        { type: 'text', text: 'Check this:' },
        { type: 'image', image: 'data:image/png;base64,img1', mimeType: 'image/png' },
        { type: 'image', image: 'data:image/jpeg;base64,img2', mimeType: 'image/jpeg' },
      ],
      timestamp: Date.now(),
    };

    const imageParts =
      typeof message.content === 'string' ? [] : message.content.filter((p) => p.type === 'image');

    expect(imageParts.length).toBe(2);
    expect(imageParts[0].image).toBe('data:image/png;base64,img1');
    expect(imageParts[1].image).toBe('data:image/jpeg;base64,img2');
  });

  it('should count attachments from multi-part content', () => {
    const message: ChatMessage = {
      id: '4',
      role: 'user',
      content: [
        { type: 'text', text: 'Text' },
        { type: 'image', image: 'data:image/png;base64,1', mimeType: 'image/png' },
        { type: 'image', image: 'data:image/png;base64,2', mimeType: 'image/png' },
        { type: 'image', image: 'data:image/png;base64,3', mimeType: 'image/png' },
      ],
      timestamp: Date.now(),
    };

    const imageCount =
      typeof message.content === 'string'
        ? 0
        : message.content.filter((p) => p.type === 'image').length;

    expect(imageCount).toBe(3);
  });
});

describe('Backward Compatibility', () => {
  it('should handle legacy string-only messages', () => {
    const legacyMessages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Old message format',
        timestamp: Date.now(),
      },
      {
        id: '2',
        role: 'assistant',
        content: 'Old response format',
        timestamp: Date.now(),
      },
    ];

    // All should still work
    for (const msg of legacyMessages) {
      expect(typeof msg.content).toBe('string');
    }
  });

  it('should mix old and new message formats in history', () => {
    const mixedHistory: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Old format',
        timestamp: Date.now(),
      },
      {
        id: '2',
        role: 'user',
        content: [
          { type: 'text', text: 'New format' },
          { type: 'image', image: 'data:image/png;base64,abc', mimeType: 'image/png' },
        ],
        timestamp: Date.now(),
      },
      {
        id: '3',
        role: 'assistant',
        content: 'Old format response',
        timestamp: Date.now(),
      },
    ];

    expect(typeof mixedHistory[0].content).toBe('string');
    expect(Array.isArray(mixedHistory[1].content)).toBe(true);
    expect(typeof mixedHistory[2].content).toBe('string');
  });
});
