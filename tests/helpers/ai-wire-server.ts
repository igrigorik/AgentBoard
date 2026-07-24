import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedWireRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  responseClosed: Promise<void>;
}

interface WireResponse {
  statusCode?: number;
  contentType?: string;
  chunks: string[];
  keepOpen?: boolean;
}

function responseClosed(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    res.once('close', resolve);
  });
}

/** Start a single-request localhost server that captures the SDK wire contract. */
export async function startAIWireServer(response: WireResponse): Promise<{
  baseURL: string;
  request: Promise<CapturedWireRequest>;
  getRequestCount: () => number;
  close: () => Promise<void>;
}> {
  let requestCount = 0;
  let resolveRequest!: (request: CapturedWireRequest) => void;
  let rejectRequest!: (error: Error) => void;
  const request = new Promise<CapturedWireRequest>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });

  const server = createServer((req, res) => {
    requestCount++;
    const bodyChunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('error', (error) => rejectRequest(error));
    req.on('end', () => {
      try {
        const rawBody = Buffer.concat(bodyChunks).toString('utf8');
        const closed = responseClosed(res);
        resolveRequest({
          method: req.method || '',
          url: req.url || '',
          headers: req.headers,
          body: rawBody ? JSON.parse(rawBody) : undefined,
          responseClosed: closed,
        });

        res.writeHead(response.statusCode ?? 200, {
          'content-type': response.contentType ?? 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for (const chunk of response.chunks) res.write(chunk);
        if (!response.keepOpen) res.end();
      } catch (error) {
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    request,
    getRequestCount: () => requestCount,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function sse(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export function eventSSE(event: string, data: unknown): string {
  return `event: ${event}\n${sse(data)}`;
}
