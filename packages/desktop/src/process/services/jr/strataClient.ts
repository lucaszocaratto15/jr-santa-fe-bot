import type { JrStrataStatus, JrStrataTool, JrStrataToolCall } from '@/common/config/clientSettings';

type Call = (path: string, init?: RequestInit) => Promise<unknown>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (): never => {
  throw new Error('JR_STRATA_INVALID_RESPONSE');
};
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Native-only client: OAuth URLs and tokens never enter renderer or model state. */
export function createStrataClient(call: Call) {
  return {
    async status(): Promise<JrStrataStatus> {
      const value = await call('/strata/status');
      if (
        !record(value) ||
        typeof value.configured !== 'boolean' ||
        typeof value.linked !== 'boolean' ||
        !Array.isArray(value.organizations) ||
        value.organizations.length > 20
      )
        return invalid();
      const organizations = value.organizations.map((item) => {
        if (!record(item) || !text(item.id, 128) || !text(item.name)) return invalid();
        return { id: item.id, name: item.name };
      });
      let erpUser: JrStrataStatus['erpUser'] = null;
      if (value.erpUser !== null) {
        if (!record(value.erpUser) || !text(value.erpUser.id, 128) || !text(value.erpUser.name)) return invalid();
        erpUser = { id: value.erpUser.id, name: value.erpUser.name };
      }
      if (
        value.linked !== Boolean(erpUser) ||
        (value.organizationId !== null &&
          (!text(value.organizationId, 128) || !organizations.some((item) => item.id === value.organizationId)))
      )
        return invalid();
      if (value.linkedAt !== null && (!text(value.linkedAt, 64) || !Number.isFinite(Date.parse(value.linkedAt))))
        return invalid();
      return {
        configured: value.configured,
        linked: value.linked,
        erpUser,
        organizations,
        organizationId: value.organizationId as string | null,
        linkedAt: value.linkedAt as string | null,
      };
    },
    async connect(): Promise<{ authorizationUrl: string; expiresAt: string }> {
      const value = await call('/strata/connect', json({}));
      if (
        !record(value) ||
        !text(value.authorizationUrl, 4096) ||
        !text(value.expiresAt, 64) ||
        !Number.isFinite(Date.parse(value.expiresAt))
      )
        return invalid();
      let url: URL;
      try {
        url = new URL(value.authorizationUrl);
      } catch {
        return invalid();
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) return invalid();
      return { authorizationUrl: url.href, expiresAt: value.expiresAt };
    },
    async disconnect(): Promise<void> {
      const value = await call('/strata/disconnect', json({}));
      if (!record(value) || value.disconnected !== true) return invalid();
    },
    async organization(organizationId: string): Promise<void> {
      if (!text(organizationId, 128)) throw new Error('JR_STRATA_INVALID_REQUEST');
      const result = await call('/strata/organization', json({ organizationId }));
      if (!record(result) || result.organizationId !== organizationId) return invalid();
    },
    async tools(): Promise<JrStrataTool[]> {
      const value = await call('/strata/mcp/tools');
      if (!record(value) || !Array.isArray(value.tools) || value.tools.length > 200) return invalid();
      return value.tools.map((item) => {
        if (
          !record(item) ||
          !text(item.name, 100) ||
          !/^[A-Za-z0-9_.-]+$/.test(item.name) ||
          !record(item.inputSchema) ||
          (item.description !== undefined && !text(item.description, 4000))
        )
          return invalid();
        return Object.assign(
          { name: item.name, inputSchema: item.inputSchema },
          typeof item.description === 'string' ? { description: item.description } : {}
        );
      });
    },
    async callTool(input: JrStrataToolCall): Promise<Record<string, unknown>> {
      if (
        !input ||
        !text(input.name, 100) ||
        !/^[A-Za-z0-9_.-]+$/.test(input.name) ||
        !record(input.arguments) ||
        Buffer.byteLength(JSON.stringify(input.arguments)) > 48_000
      )
        throw new Error('JR_STRATA_INVALID_REQUEST');
      const value = await call('/strata/mcp/call', json(input));
      if (
        !record(value) ||
        !Array.isArray(value.content) ||
        (value.isError !== undefined && typeof value.isError !== 'boolean')
      )
        return invalid();
      // Only MCP result fields cross into the agent, never transport headers or server credentials.
      return {
        content: value.content,
        ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }),
        ...(value.isError === undefined ? {} : { isError: value.isError }),
      };
    },
  };
}
