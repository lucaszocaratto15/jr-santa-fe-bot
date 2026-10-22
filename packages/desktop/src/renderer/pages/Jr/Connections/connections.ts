import type { IMcpServer, IMcpServerTransport } from '@/common/config/storage';
import { toBackendMcpPayload } from '@/renderer/hooks/mcp/catalog';

export const CHROME_MCP_VERSION = '1.12.0';
export const CHROME_MCP_NAME = 'chrome-jr';
export const GMAIL_MCP_URL = 'https://gmailmcp.googleapis.com/mcp/v1';
export const CHROME_MCP_DOCS = 'https://github.com/ChromeDevTools/chrome-devtools-mcp';
export const GMAIL_MCP_DOCS = 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server';

export type ConnectionDraft = {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  url: string;
};

export type ApprovedAppId = 'chrome' | 'gmail';

/** Keeps a persisted record available when a follow-up disable request fails. */
export class ConnectionSaveError extends Error {
  constructor(public readonly server: IMcpServer) {
    super('partialSaveError');
  }
}

export const EMPTY_CONNECTION: ConnectionDraft = { name: '', type: 'stdio', command: '', args: '[]', url: '' };

/** Creates the official Chrome preset with a persistent profile owned by this app. */
export const createChromeDraft = (cacheDir: string): ConnectionDraft => {
  if (!cacheDir.trim()) throw new Error('profileError');
  return {
    ...EMPTY_CONNECTION,
    name: CHROME_MCP_NAME,
    command: 'npx',
    args: JSON.stringify([
      '-y',
      `chrome-devtools-mcp@${CHROME_MCP_VERSION}`,
      `--user-data-dir=${cacheDir.replace(/[\\/]+$/, '')}/jr-chrome-profile`,
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-category-performance',
      '--no-category-network',
      '--no-category-emulation',
      '--no-category-memory',
    ]),
  };
};

export const createGmailDraft = (): ConnectionDraft => ({
  ...EMPTY_CONNECTION,
  name: 'gmail',
  type: 'http',
  url: GMAIL_MCP_URL,
});

export const draftFromServer = (server: IMcpServer): ConnectionDraft => ({
  name: server.name,
  type: server.transport.type === 'streamable_http' ? 'http' : server.transport.type,
  command: server.transport.type === 'stdio' ? server.transport.command : '',
  args: JSON.stringify(server.transport.type === 'stdio' ? server.transport.args || [] : []),
  url: server.transport.type === 'stdio' ? '' : server.transport.url,
});

export const isGmailServer = (server: Pick<IMcpServer, 'transport'>): boolean => {
  if (server.transport.type === 'stdio') return false;
  try {
    const url = new URL(server.transport.url);
    return url.origin === 'https://gmailmcp.googleapis.com' && url.pathname.replace(/\/$/, '') === '/mcp/v1';
  } catch {
    return false;
  }
};

/** Matches only the app-owned Chrome preset, never the backend's built-in server. */
export const isJrChromeServer = (server: IMcpServer): boolean => !server.builtin && server.name === CHROME_MCP_NAME;

/** Returns a translated label key without changing the backend's built-in name. */
export const builtinServerLabel = (server: IMcpServer): string | undefined => {
  if (!server.builtin) return undefined;
  switch (server.name) {
    case 'aionui-browser':
      return 'appBrowser';
    case 'aionui-image-generation':
      return 'imageCreation';
    case 'chrome-devtools':
      return 'integratedChrome';
    default:
      return undefined;
  }
};

/** Validates editable fields while preserving credentials already held by the transport. */
export const connectionPayload = (draft: ConnectionDraft, existing?: IMcpServer) => {
  const name = draft.name.trim();
  if (!name || name.length > 80) throw new Error('invalidName');
  let transport: IMcpServerTransport;
  if (draft.type === 'stdio') {
    if (!draft.command.trim()) throw new Error('invalidCommand');
    let args: unknown;
    try {
      args = JSON.parse(draft.args);
    } catch {
      throw new Error('invalidArguments');
    }
    if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) {
      throw new Error('invalidArguments');
    }
    transport = {
      type: 'stdio',
      command: draft.command.trim(),
      args,
      ...(existing?.transport.type === 'stdio' && existing.transport.env ? { env: existing.transport.env } : {}),
    };
  } else {
    let url: URL;
    try {
      url = new URL(draft.url.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalidUrl');
    } catch {
      throw new Error('invalidUrl');
    }
    let headers: Record<string, string> | undefined;
    if (existing && existing.transport.type !== 'stdio') {
      try {
        if (new URL(existing.transport.url).origin === url.origin) headers = existing.transport.headers;
      } catch {
        // An invalid previous address cannot establish a credential-sharing origin.
      }
    }
    transport = { type: draft.type, url: draft.url.trim(), ...(headers ? { headers } : {}) };
  }
  return toBackendMcpPayload({
    name,
    description: existing?.description,
    transport,
    original_json: JSON.stringify({ mcpServers: { [name]: transport } }, null, 2),
    builtin: false,
  });
};
