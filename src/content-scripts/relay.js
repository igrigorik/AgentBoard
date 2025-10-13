/**
 * WebMCP Content Script Relay (Isolated World)
 * Relays messages between page MAIN world and extension background
 * Executes in ISOLATED world for security
 */
(function () {
  'use strict';

  /**
   * Inline logger that respects user's log level configuration
   *
   * Strategy: Content scripts run in isolated context and can't import ES modules,
   * so we inline a lightweight logger that reads from chrome.storage directly.
   * This is the only content script that needs config-aware logging (MAIN world
   * scripts use raw console.log for dev debugging).
   *
   * Trade-off: ~25 lines of inlined code vs. complex build-time injection or
   * message-passing overhead. Chose inline for simplicity and self-containment.
   */
  const logger = (() => {
    const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
    let currentLevel = levels.warn; // Default: warn

    // Read user's log level from storage
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      chrome.storage.local.get(['config'], (result) => {
        if (result.config?.logLevel && levels[result.config.logLevel] !== undefined) {
          currentLevel = levels[result.config.logLevel];
        }
      });

      // Listen for real-time changes from Options UI
      if (chrome.storage?.onChanged?.addListener) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.config?.newValue?.logLevel) {
            const newLevel = levels[changes.config.newValue.logLevel];
            if (newLevel !== undefined) {
              currentLevel = newLevel;
            }
          }
        });
      }
    }

    return {
      log: (...args) => currentLevel >= levels.info && console.log(...args),
      warn: (...args) => currentLevel >= levels.warn && console.warn(...args),
      error: (...args) => currentLevel >= levels.error && console.error(...args),
    };
  })();

  // Guard against double injection - but allow replacing dead relays
  if (window.__webmcpRelayBridge) {
    // Check if the existing relay is shut down (extension was reloaded)
    if (window.__webmcpRelayBridge.isShutdown) {
      logger.log('[WebMCP Relay] Replacing shut down relay instance');
      // Continue to create new instance
    } else {
      // Existing relay is still active, don't create duplicate
      return;
    }
  }

  const JSONRPC = '2.0';

  /**
   * WebMCP Relay Bridge - manages persistent connection to background
   */
  class WebMCPRelayBridge {
    constructor() {
      this.port = null;
      this.pendingMessages = [];
      this.reconnectAttempt = 0;
      this.maxReconnectDelay = 30000; // 30 seconds max
      this.initialDelay = 100; // Start with 100ms
      this.isShutdown = false; // Track if we've permanently shut down

      this.connect();
      this.setupMessageRelay();
    }

    /**
     * Permanently shut down this relay instance
     */
    shutdown() {
      this.isShutdown = true;
      if (this.port) {
        try {
          this.port.disconnect();
        } catch {
          // Already disconnected
        }
        this.port = null;
      }
      this.pendingMessages = [];
      logger.warn('[WebMCP Relay] Shut down - extension context invalidated');
    }

    /**
     * Connect to background service worker via persistent port
     */
    connect() {
      // Don't try to connect if we've been shut down
      if (this.isShutdown) return;

      try {
        // Connect with a named port for identification
        this.port = chrome.runtime.connect({ name: 'webmcp-content-script' });

        this.reconnectAttempt = 0;
        logger.log('[WebMCP Relay] Connected to background');

        // Handle messages from background (to be forwarded to MAIN world)
        this.port.onMessage.addListener((msg) => {
          if (msg?.type === 'webmcp' && msg?.payload) {
            // Forward to MAIN world via postMessage
            window.postMessage({
              source: 'webmcp-bridge',
              jsonrpc: JSONRPC,
              ...msg.payload
            }, '*');

            logger.log('[WebMCP Relay] Forwarded to MAIN:', msg.payload.method || 'response');
          }
        });

        // Handle port disconnection (navigation, SW restart, etc)
        this.port.onDisconnect.addListener(() => {
          const error = chrome.runtime.lastError;
          logger.warn('[WebMCP Relay] Port disconnected:', error?.message || 'No error');

          this.port = null;

          // Check for permanent errors
          if (error?.message?.includes('Extension context invalidated')) {
            this.shutdown();
            return;
          }

          // Otherwise, attempt reconnect
          if (!this.isShutdown) {
            this.reconnectWithBackoff();
          }
        });

        // Flush any pending messages
        this.flushPendingMessages();

      } catch (err) {
        logger.error('[WebMCP Relay] Connection failed:', err);

        // Don't reconnect if extension context is invalidated (extension was reloaded)
        if (err?.message?.includes('Extension context invalidated')) {
          this.shutdown();
          return;
        }

        // Otherwise, attempt reconnect
        if (!this.isShutdown) {
          this.reconnectWithBackoff();
        }
      }
    }

    /**
     * Reconnect with exponential backoff
     */
    reconnectWithBackoff() {
      // Don't reconnect if we've been shut down
      if (this.isShutdown) return;

      this.reconnectAttempt++;

      // Calculate delay with exponential backoff
      const delay = Math.min(
        this.initialDelay * Math.pow(2, this.reconnectAttempt - 1),
        this.maxReconnectDelay
      );

      logger.log(`[WebMCP Relay] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

      setTimeout(() => {
        if (this.isShutdown || this.port) return; // Don't reconnect if shut down or already connected
        this.connect();
      }, delay);
    }

    /**
     * Flush pending messages after connection is established
     */
    flushPendingMessages() {
      if (!this.port || !this.pendingMessages.length) return;

      logger.log(`[WebMCP Relay] Flushing ${this.pendingMessages.length} pending messages`);

      while (this.pendingMessages.length > 0) {
        const msg = this.pendingMessages.shift();
        try {
          this.port.postMessage(msg);
        } catch (err) {
          logger.error('[WebMCP Relay] Failed to flush message:', err);
          // Put it back if send failed
          this.pendingMessages.unshift(msg);
          break;
        }
      }
    }

    /**
     * Send message to background, queue if disconnected
     */
    sendToBackground(message) {
      // Don't send if we've been shut down
      if (this.isShutdown) {
        logger.warn('[WebMCP Relay] Cannot send - relay is shut down');
        return;
      }

      if (this.port) {
        try {
          this.port.postMessage(message);
        } catch (err) {
          logger.error('[WebMCP Relay] Failed to send message:', err);

          // Check if extension context was invalidated
          if (err?.message?.includes('Extension context invalidated')) {
            this.shutdown();
            return;
          }

          // Queue for retry
          this.pendingMessages.push(message);
          // Try to reconnect
          if (!this.port && !this.isShutdown) {
            this.connect();
          }
        }
      } else {
        // Queue while disconnected
        this.pendingMessages.push(message);
        logger.log('[WebMCP Relay] Queued message while disconnected');

        // Try to reconnect if not already trying
        if (this.reconnectAttempt === 0 && !this.isShutdown) {
          this.connect();
        }
      }
    }

    /**
     * Setup relay between MAIN world and background
     */
    setupMessageRelay() {
      // Listen to messages from MAIN world
      window.addEventListener('message', (event) => {
        // Only accept messages from same window
        if (event.source !== window) return;

        // Check for our protocol from page bridge
        if (!event.data || event.data.source !== 'webmcp-main') return;
        if (event.data.jsonrpc !== JSONRPC) return;

        // Remove the source field before forwarding
        const { source: _source, ...payload } = event.data;

        // Wrap in our protocol and send to background
        const msg = {
          type: 'webmcp',
          payload: payload,
          tabUrl: window.location.href,
          timestamp: Date.now()
        };

        this.sendToBackground(msg);

        logger.log('[WebMCP Relay] Forwarded to background:',
          payload.method || `response ${payload.id || '(no id)'}`);
      });

      logger.log('[WebMCP Relay] Message relay initialized');
    }
  }

  // Create singleton instance
  window.__webmcpRelayBridge = new WebMCPRelayBridge();

  logger.log('[WebMCP Relay] Content script relay ready');
})();
