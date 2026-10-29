/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tokensMatch } from '@/process/resources/builtinMcp/cdpTargetProtocol';

export const TEACH_TOKEN_HEADER = 'x-jr-teach-token';
const MAX_BODY_BYTES = 256 * 1024;

export const TEACH_TOOL_NAMES = [
  'vault_list',
  'vault_fill',
  'secure_input',
  'secure_input_status',
  'teach_submit_draft',
] as const;

export type TeachToolName = (typeof TEACH_TOOL_NAMES)[number];
export type TeachHandlers = Record<TeachToolName, (body: unknown) => Promise<unknown>>;

export type TeachControlServer = {
  host: string;
  port: number;
  token: string;
  close(): Promise<void>;
};

const isTeachTool = (name: string): name is TeachToolName => (TEACH_TOOL_NAMES as readonly string[]).includes(name);

const sendJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

/** Reads the body, resolving null as soon as it exceeds the size limit. */
const readBody = (req: http.IncomingMessage): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/**
 * Localhost-only, token-protected HTTP channel the `jr-teach` MCP server uses to reach
 * the Electron main process. Handler results and errors never echo request contents.
 */
export async function createTeachControlServer(handlers: TeachHandlers): Promise<TeachControlServer> {
  const token = randomBytes(32).toString('hex');

  const server = http.createServer((req, res) => {
    void (async () => {
      const provided = req.headers[TEACH_TOKEN_HEADER];
      if (typeof provided !== 'string' || !tokensMatch(provided, token)) {
        req.resume();
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      const tool = (req.url ?? '').split('?')[0].replace(/^\//, '');
      if (req.method !== 'POST' || !isTeachTool(tool)) {
        req.resume();
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const raw = await readBody(req);
      let body: unknown;
      try {
        if (raw === null) throw new Error('too large');
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        res.once('finish', () => req.destroy());
        sendJson(res, 400, { ok: false, error: 'bad request' });
        return;
      }
      try {
        sendJson(res, 200, await handlers[tool](body));
      } catch {
        sendJson(res, 500, { ok: false, error: 'internal error' });
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    });
  });

  // secure_input waits up to 50 s for the employee.
  server.requestTimeout = 70_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return {
    host: (server.address() as AddressInfo).address,
    port: (server.address() as AddressInfo).port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
