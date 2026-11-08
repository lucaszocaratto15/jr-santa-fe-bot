import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JR_STRATA_READ_TOOLS } from '@/common/config/constants';

describe('native Strata read tools', () => {
  const received: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let server: Server;
  let client: Client;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jr-read-tools-'));
    const script = join(directory, 'teach.cjs');
    await build({
      entryPoints: ['packages/desktop/src/process/resources/builtinMcp/teachServer.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: script,
      logLevel: 'silent',
    });
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        expect(request.headers['x-jr-teach-token']).toBe('read-tool-fixture');
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          name: string;
          arguments: Record<string, unknown>;
        };
        received.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }));
      })().catch(() => {
        response.writeHead(500);
        response.end('{}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    client = new Client({ name: 'read-tools-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: 'node',
        args: [script],
        env: { JR_TEACH_PORT: String(address.port), JR_TEACH_TOKEN: 'read-tool-fixture' },
        stderr: 'pipe',
      })
    );
  });
  afterAll(async () => {
    await client?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('exposes distinct read-only operations without requiring general tool discovery', async () => {
    const list = await client.listTools();
    expect(
      JR_STRATA_READ_TOOLS.every((name) =>
        list.tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint === true)
      )
    ).toBe(true);
  });

  it('requests compact group data and can continue an explicit page', async () => {
    await client.callTool({
      name: 'strata_consultas_executar',
      arguments: { id: 'frota.consumo-combustivel', parameters: { de: '2026-10', ate: '2026-10' }, offset: 40 },
    });
    expect(received.at(-1)).toEqual({
      name: 'erp.consultas.executar',
      arguments: {
        id: 'frota.consumo-combustivel',
        parameters: { de: '2026-10', ate: '2026-10' },
        format: 'table',
        page: { offset: 40, limit: 100 },
      },
    });
  });

  it('cannot turn a trusted read tool into a mutation or send invalid pagination', async () => {
    await client.callTool({
      name: 'strata_identidade',
      arguments: { name: 'compras.aprovacoes.decidir', arguments: { aprovar: true } },
    });
    expect(received.at(-1)).toEqual({ name: 'erp.quem_sou', arguments: {} });
    const count = received.length;
    const result = await client.callTool({ name: 'strata_consultas_executar', arguments: { id: 'x', offset: -1 } });
    expect(result.isError).toBe(true);
    expect(received).toHaveLength(count);
  });
});
