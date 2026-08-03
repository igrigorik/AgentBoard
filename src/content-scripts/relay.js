// Keep a private module identity so Rollup inlines this dependency: Chrome injects
// the built relay as a classic script, which cannot retain an ESM import.
import { redactDiagnosticString } from '../lib/logger/redaction?relay-inline';

/**
 * WebMCP Content Script Relay (Isolated World)
 * Relays messages between page MAIN world and extension background
 * Executes in ISOLATED world for security
 */
(function () {
  'use strict';

  // Duplicate injections in one document must be side-effect free. A shut-down
  // relay is replaceable after an extension reload or context invalidation.
  const existingRelay = window.__webmcpRelayBridge;
  if (existingRelay && !existingRelay.isShutdown) return;

  /**
   * Inline logger that respects user's log level configuration.
   *
   * The stateful application logger does not belong in this isolated content
   * script; only its pure redaction helper is shared. DEBUG and TRACE retain local
   * context, while lower levels continue to emit fixed messages.
   */
  const logger = (() => {
    const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
    let currentLevel = levels.warn; // Default: warn
    let levelGeneration = 0;

    const applyLevel = (level) => {
      const nextLevel = levels[level];
      currentLevel = nextLevel === undefined ? levels.warn : nextLevel;
    };
    const setLevel = (level) => {
      levelGeneration++;
      applyLevel(level);
    };
    const refreshLevel = () => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
      const generation = ++levelGeneration;
      chrome.runtime.sendMessage({ type: 'GET_LOG_LEVEL' }, (response) => {
        if (chrome.runtime.lastError || generation !== levelGeneration) return;
        applyLevel(response?.logLevel);
      });
    };
    const sanitizeValue = (value) => {
      if (typeof value === 'string') return redactDiagnosticString(value);
      if (!value || typeof value !== 'object') return value;
      if (typeof value.message !== 'string') return '[Object]';
      return {
        ...(typeof value.name === 'string' && { name: redactDiagnosticString(value.name) }),
        message: redactDiagnosticString(value.message),
        ...(typeof value.stack === 'string' && { stack: redactDiagnosticString(value.stack) }),
      };
    };
    const contextual = (context, fallback) =>
      currentLevel >= levels.debug && context.length > 0
        ? ['[AgentBoard]', ...context.map((value) => sanitizeValue(value))]
        : [fallback];

    return {
      refresh: refreshLevel,
      setLevel,
      log: (...context) =>
        currentLevel >= levels.info &&
        console.log(...contextual(context, '[AgentBoard] Relay event')),
      warn: (...context) =>
        currentLevel >= levels.warn &&
        console.warn(...contextual(context, '[AgentBoard] Relay warning')),
      error: (...context) =>
        currentLevel >= levels.error &&
        console.error(...contextual(context, '[AgentBoard] Relay failure')),
    };
  })();

  const JSONRPC = '2.0';

  /**
   * WebMCP Relay Bridge - manages persistent connection to background
   */
  class WebMCPRelayBridge {
    constructor() {
      this.port = null;
      this.pendingMessages = [];
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.maxReconnectDelay = 30000; // 30 seconds max
      this.initialDelay = 100; // Start with 100ms
      this.isShutdown = false; // Track if we've permanently shut down
      this.onPageMessage = this.onPageMessage.bind(this);

      // Install the listener first so synchronous connection failure can dispose it.
      this.setupMessageRelay();
      this.connect();
    }

    /**
     * Permanently shut down this relay instance
     */
    shutdown() {
      if (this.isShutdown) return;
      this.isShutdown = true;
      window.removeEventListener('message', this.onPageMessage);
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
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
        logger.refresh();
        // Connect with a named port for identification
        this.port = chrome.runtime.connect({ name: 'webmcp-content-script' });

        this.reconnectAttempt = 0;
        logger.log('[WebMCP Relay] Connected to background');

        // Handle messages from background (to be forwarded to MAIN world)
        this.port.onMessage.addListener((msg) => {
          if (msg?.type === 'RELAY_LOG_LEVEL') {
            logger.setLevel(msg.logLevel);
            return;
          }
          if (msg?.type === 'webmcp' && msg?.payload) {
            // Forward to MAIN world via postMessage
            window.postMessage(
              {
                source: 'webmcp-bridge',
                jsonrpc: JSONRPC,
                ...msg.payload,
              },
              '*'
            );

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
      // Don't reconnect if we've been shut down or a retry is already scheduled.
      if (this.isShutdown || this.reconnectTimer !== null) return;

      this.reconnectAttempt++;

      // Calculate delay with exponential backoff
      const delay = Math.min(
        this.initialDelay * Math.pow(2, this.reconnectAttempt - 1),
        this.maxReconnectDelay
      );

      logger.log(`[WebMCP Relay] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
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

    onPageMessage(event) {
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
        timestamp: Date.now(),
      };

      this.sendToBackground(msg);

      logger.log(
        '[WebMCP Relay] Forwarded to background:',
        payload.method || `response ${payload.id || '(no id)'}`
      );
    }

    /**
     * Setup relay between MAIN world and background
     */
    setupMessageRelay() {
      window.addEventListener('message', this.onPageMessage);
      logger.log('[WebMCP Relay] Message relay initialized');
    }
  }

  // Create singleton instance
  window.__webmcpRelayBridge = new WebMCPRelayBridge();

  logger.log('[WebMCP Relay] Content script relay ready');
})();
