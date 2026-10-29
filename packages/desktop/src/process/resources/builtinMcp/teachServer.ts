/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in `jr-teach` MCP server (stdio). Each tool forwards its arguments to the
 * token-protected localhost control server in the Electron main process and returns the
 * JSON response as text. stdout is the protocol channel: diagnostics go to stderr only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_TEACH_MCP_NAME } from '@/common/config/constants';

const TOKEN_HEADER = 'x-jr-teach-token';
const DEFAULT_TIMEOUT_MS = 30_000;
const SECURE_INPUT_TIMEOUT_MS = 65_000;

const port = process.env.JR_TEACH_PORT;
const token = process.env.JR_TEACH_TOKEN;

if (!port || !token) {
  process.stderr.write('[builtin-mcp-teach] JR_TEACH_PORT or JR_TEACH_TOKEN is missing — refusing to start.\n');
  process.exit(1);
}

const callControl = async (tool: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token as string },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { content: [{ type: 'text' as const, text }], isError: !res.ok };
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'error';
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: `control channel unavailable (${reason})` }),
        },
      ],
      isError: true,
    };
  }
};

async function main() {
  const server = new McpServer({ name: BUILTIN_TEACH_MCP_NAME, version: '1.0.0' });

  server.tool(
    'vault_list',
    'Lista os itens do cofre do funcionário: nome, origens (sites) permitidas e se há usuário/senha guardados. Nunca devolve os valores.',
    {},
    async () => callControl('vault_list', {})
  );

  server.tool(
    'vault_fill',
    'Preenche no navegador do app o usuário ou a senha de um item do cofre. Clique no campo antes de chamar. O preenchimento só funciona se o site atual for uma origem do item; a senha só é preenchida em campo de senha. O valor nunca é devolvido.',
    {
      item: z.string().describe('Nome do item do cofre (como listado por vault_list).'),
      field: z.enum(['username', 'password']).describe('Qual campo preencher: usuário ou senha.'),
    },
    async (args) => callControl('vault_fill', args)
  );

  server.tool(
    'secure_input',
    'Pede ao funcionário um dado sensível (código OTP, senha ou texto) por um campo seguro na interface do app e preenche no campo focado do navegador. Clique no campo antes de chamar. O valor nunca é devolvido. Aguarda até 50 s; se ainda estiver aguardando, use secure_input_status com o id retornado.',
    {
      kind: z.enum(['otp', 'password', 'text']).describe('Tipo do dado pedido.'),
      label: z.string().describe('Texto mostrado ao funcionário explicando o que digitar.'),
    },
    async (args) => callControl('secure_input', args, SECURE_INPUT_TIMEOUT_MS)
  );

  server.tool(
    'secure_input_status',
    'Consulta o andamento de um pedido de secure_input que ficou aguardando. O valor nunca é devolvido; retorna apenas enviado, cancelado ou aguardando.',
    { id: z.string().describe('Id retornado por secure_input quando o resultado foi "aguardando".') },
    async (args) => callControl('secure_input_status', args, SECURE_INPUT_TIMEOUT_MS)
  );

  server.tool(
    'teach_submit_draft',
    'Envia o rascunho (markdown) da skill aprendida para o cartão de revisão exibido ao funcionário. Nunca inclua senhas, códigos ou valores secretos no texto.',
    { markdown: z.string().describe('Conteúdo markdown do rascunho da tarefa ensinada.') },
    async (args) => callControl('teach_submit_draft', args)
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`[builtin-mcp-teach] Fatal error: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
});
