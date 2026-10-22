import type { IMcpServer } from '@/common/config/storage';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/common/adapter/ipcBridge', () => ({ mcpService: {} }));

import {
  CHROME_MCP_VERSION,
  EMPTY_CONNECTION,
  GMAIL_MCP_URL,
  connectionPayload,
  createChromeDraft,
  createGmailDraft,
  draftFromServer,
  isGmailServer,
} from '@/renderer/pages/Jr/Connections/connections';

const server: IMcpServer = {
  id: 'mcp-1',
  name: 'Local',
  enabled: false,
  created_at: 1,
  updated_at: 1,
  original_json: '{}',
  transport: { type: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'private' } },
};

describe('connection configuration', () => {
  it.each(['', 'x'.repeat(81)])('rejects an invalid name before creating a server', (name) => {
    expect(() => connectionPayload({ ...EMPTY_CONNECTION, name, command: 'node' })).toThrow('invalidName');
  });

  it.each(['{}', '[1]', '["ok", null]', 'not-json'])(
    'rejects arguments that cannot be passed as strings: %s',
    (args) => {
      expect(() => connectionPayload({ ...EMPTY_CONNECTION, name: 'Local', command: 'node', args })).toThrow(
        'invalidArguments'
      );
    }
  );

  it('requires a local executable', () => {
    expect(() => connectionPayload({ ...EMPTY_CONNECTION, name: 'Local', command: ' ' })).toThrow('invalidCommand');
  });

  it('keeps argument boundaries and stored environment variables when editing', () => {
    const payload = connectionPayload(
      { ...draftFromServer(server), args: '["path with spaces.js", "--name=a b"]' },
      server
    );
    expect(payload.transport).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['path with spaces.js', '--name=a b'],
      env: { MODE: 'private' },
    });
    expect(JSON.parse(payload.original_json).mcpServers.Local).toEqual(payload.transport);
  });

  it.each(['file:///tmp/mcp', 'https://person:password@example.test/mcp', 'wrong-url'])(
    'rejects an unsafe or invalid remote URL: %s',
    (url) => {
      expect(() => connectionPayload({ ...createGmailDraft(), url })).toThrow('invalidUrl');
    }
  );

  it('normalizes a Streamable HTTP server and preserves its existing headers', () => {
    const remote: IMcpServer = {
      ...server,
      transport: { type: 'streamable_http', url: 'https://example.test/mcp', headers: { 'X-Mode': 'private' } },
    };
    const payload = connectionPayload({ ...draftFromServer(remote), name: ' Remote ' }, remote);
    expect(payload.name).toBe('Remote');
    expect(payload.transport).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { 'X-Mode': 'private' },
    });
  });

  it.each(['https://other.test/mcp', 'http://example.test/mcp', 'https://example.test:8443/mcp'])(
    'removes stored headers when the remote origin changes to %s',
    (url) => {
      const remote: IMcpServer = {
        ...server,
        transport: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'test-placeholder' } },
      };
      const payload = connectionPayload({ ...draftFromServer(remote), url }, remote);
      expect(payload.transport).not.toHaveProperty('headers');
      expect(payload.original_json).not.toContain('test-placeholder');
    }
  );

  it('does not carry local environment variables into a remote transport', () => {
    const payload = connectionPayload(createGmailDraft(), server);
    expect(payload.transport).toEqual({ type: 'http', url: GMAIL_MCP_URL });
  });
});

describe('official connection presets', () => {
  it('requires an app cache path instead of borrowing the personal Chrome profile', () => {
    expect(() => createChromeDraft('')).toThrow('profileError');
  });

  it('pins Chrome MCP and disables usage statistics and unused diagnostics', () => {
    const draft = createChromeDraft('/app/cache/');
    const args = JSON.parse(draft.args) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        `chrome-devtools-mcp@${CHROME_MCP_VERSION}`,
        '--user-data-dir=/app/cache/jr-chrome-profile',
        '--no-usage-statistics',
        '--no-performance-crux',
        '--no-category-performance',
        '--no-category-network',
        '--no-category-emulation',
        '--no-category-memory',
      ])
    );
    expect(args).not.toEqual(expect.arrayContaining(['--auto-connect', '--headless']));
  });

  it('prepares the official Gmail endpoint without inserting credentials or authentication status', () => {
    const payload = connectionPayload(createGmailDraft());
    expect(payload.transport).toEqual({ type: 'http', url: GMAIL_MCP_URL });
    expect(isGmailServer(payload)).toBe(true);
    expect(isGmailServer({ transport: { type: 'http', url: `${GMAIL_MCP_URL}.example.test` } })).toBe(false);
  });
});
