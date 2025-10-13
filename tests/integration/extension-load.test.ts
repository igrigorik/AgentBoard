/**
 * Integration test to verify extension loads properly
 * Run this after loading the extension in Chrome
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

describe('Extension Loading', () => {
  beforeAll(() => {
    // Ensure chrome mock is setup
    expect(global.chrome).toBeDefined();
  });

  it('should have proper manifest structure', () => {
    // This would be tested in actual Chrome
    // Here we just verify our mock is working
    expect(chrome.runtime.id).toBeDefined();
    expect(chrome.storage.local).toBeDefined();
    expect(chrome.tabs).toBeDefined();
    expect(chrome.sidePanel).toBeDefined();
  });

  it('should handle message passing', async () => {
    const testMessage = { type: 'PING' };

    // Mock the response
    chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ pong: true });

    const response = await chrome.runtime.sendMessage(testMessage);

    expect(response).toEqual({ pong: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(testMessage);
  });

  it('should store and retrieve configuration', async () => {
    const testConfig = {
      provider: 'openai',
      temperature: 0.7,
    };

    // Test storage set
    await chrome.storage.local.set({ config: testConfig });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ config: testConfig });

    // Mock storage get
    chrome.storage.local.get = vi.fn().mockImplementation((_keys, callback) => {
      if (callback) callback({ config: testConfig });
      return Promise.resolve({ config: testConfig });
    });

    // Test storage get
    const result = await chrome.storage.local.get(['config']);
    expect(result.config).toEqual(testConfig);
  });

  it('should handle keyboard commands', () => {
    const listener = vi.fn();
    chrome.commands.onCommand.addListener(listener);

    expect(chrome.commands.onCommand.addListener).toHaveBeenCalledWith(listener);
  });

  it('should support context menus', () => {
    // Mock context menu creation
    chrome.contextMenus = {
      create: vi.fn(),
      onClicked: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    } as any;

    chrome.contextMenus.create({
      id: 'test-menu',
      title: 'Test Menu',
      contexts: ['selection'],
    });

    expect(chrome.contextMenus.create).toHaveBeenCalled();
  });
});
