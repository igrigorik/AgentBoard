import { execute } from './html-reader.js';

// A file-injected classic script must not import a shared chunk. Literal types keep this erased
// copy synchronized with the router/build protocol at compile time.
// The key's V1 suffix is a stable global namespace, deliberately independent of the payload
// version below; bumping the version replaces an older host in place rather than renaming it.
const HTML_READER_HOST_KEY: typeof import('./html-protocol').HTML_READER_HOST_KEY =
  '__agentboardReadPageHtmlV1';
const HTML_READER_HOST_VERSION: typeof import('./html-protocol').HTML_READER_HOST_VERSION = 2;

type HtmlReaderGlobal = typeof globalThis & {
  [HTML_READER_HOST_KEY]?: {
    version: typeof HTML_READER_HOST_VERSION;
    execute: typeof execute;
  };
};

// chrome.scripting files share the extension's ISOLATED world. The page cannot see or replace this
// host, while the extractor still reads the document's live DOM and browser-owned layout state.
const hostGlobal = globalThis as HtmlReaderGlobal;
if (hostGlobal[HTML_READER_HOST_KEY]?.version !== HTML_READER_HOST_VERSION) {
  Object.defineProperty(hostGlobal, HTML_READER_HOST_KEY, {
    configurable: true,
    value: Object.freeze({ version: HTML_READER_HOST_VERSION, execute }),
  });
}
