import { existsSync } from 'node:fs';
import path from 'node:path';

const defaultTimeoutMs = 20_000;

export function chromeSandboxArgs() {
  // Keep local runs sandboxed; isolated CI must opt out explicitly when its
  // downloaded Chrome has no usable SUID or user-namespace sandbox.
  return process.env.AGENTBOARD_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
}

export function findChrome({ forExtension = false } = {}) {
  const chrome = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  ];
  const chromium = [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  // Branded Chrome 137+ disables --load-extension, while the read-page suite
  // should continue honoring its broader CHROME_BIN contract.
  const candidates = forExtension
    ? [process.env.CHROME_FOR_TESTING_BIN, process.env.CHROME_BIN, ...chromium, ...chrome]
    : [process.env.CHROME_BIN, ...chrome, ...chromium];
  return candidates.filter(Boolean).find((candidate) => existsSync(candidate));
}

export class CdpPipe {
  constructor(process) {
    this.process = process;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closedError = null;

    process.stdio[3].on('error', (error) => this.close(error));
    process.stdio[4].on('error', (error) => this.close(error));
    process.stdio[4].on('data', (chunk) => this.receive(chunk));
    process.on('error', (error) => this.close(error));
    process.on('close', (code, signal) =>
      this.close(new Error(`Chromium exited (code ${code}, signal ${signal})`))
    );
  }

  close(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const separator = this.buffer.indexOf(0);
      if (separator === -1) return;
      const payload = this.buffer.subarray(0, separator).toString('utf8');
      this.buffer = this.buffer.subarray(separator + 1);
      if (!payload) continue;

      const message = JSON.parse(payload);
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${pending.method} failed`));
      else pending.resolve(message.result ?? {});
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closedError) return Promise.reject(this.closedError);

    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId && { sessionId }) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.process.stdio[3].write(`${JSON.stringify(message)}\0`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}

export async function waitFor(check, label, deadline = defaultTimeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ' after a transient failure' : ''}`);
}
