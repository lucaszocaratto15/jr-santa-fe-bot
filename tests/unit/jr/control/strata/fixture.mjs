import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startControl } from '../support.mjs';

export const CLIENT_ID = 'jr-strata-client-fixture';
export const CLIENT_SECRET = 'strata-client-fixture-not-real-secret';
export const ENCRYPTION_KEY = Buffer.alloc(32, 29).toString('base64');
export const REDIRECT = 'http://127.0.0.1:19876/strata/callback';
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const asJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

/** Local OAuth/MCP provider: authorization proves the chosen fixture account, never request names. */
export async function startErp(t) {
  const accounts = new Map([
    ['erp-a', { id: 'erp-a', name: 'Same fixture name', organizations: ['org-a', 'org-b'] }],
    ['erp-b', { id: 'erp-b', name: 'Same fixture name', organizations: ['org-b'] }],
  ]);
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const seen = [];
  const tokens = [];
  const state = {
    loginId: 'erp-a',
    permissions: true,
    knowledgeGroup: null,
    unavailable: false,
    rateLimited: false,
    useSse: false,
    mismatchIdentity: false,
    refreshCalls: 0,
    exchangeCalls: 0,
    refreshDelay: 0,
    tokenLifetime: 120,
    tokenSubjectOverride: null,
    mutationsExecuted: 0,
    reflectToken: false,
    invalidTokens: false,
    oversizeToolResult: false,
    invalidMetadataEndpoint: false,
    tokenRedirect: false,
    knowledgeCalls: 0,
    knowledgePolicyOverride: null,
    knowledgeDenied: false,
  };
  let baseUrl = '';
  let identityGate = null;
  let toolGate = null;
  let refreshGate = null;
  const hold = (kind) => {
    let release;
    let enter;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = { wait, release, enter };
    if (kind === 'identity') identityGate = gate;
    else if (kind === 'tool') toolGate = gate;
    else refreshGate = gate;
    t.after(release);
    return { entered, release };
  };
  const issueTokens = (account) => {
    const accessToken = `fixture-access-${randomUUID()}`;
    const refreshToken = `fixture-refresh-${randomUUID()}`;
    access.set(accessToken, account);
    refresh.set(refreshToken, account);
    tokens.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: state.tokenLifetime,
      token_type: 'Bearer',
      scope: 'mcp:identidade mcp:obras mcp:conhecimento',
    };
  };
  const rpc = (response, id, result) => {
    const body = { jsonrpc: '2.0', id, result };
    if (state.useSse) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    } else asJson(response, 200, body);
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', baseUrl);
      const raw = await bodyOf(request);
      seen.push({ path: url.pathname, headers: request.headers, raw });
      if (state.unavailable && !url.pathname.startsWith('/oauth/authorize'))
        return asJson(response, 503, { error: 'fixture_unavailable' });
      if (state.rateLimited && url.pathname.startsWith('/mcp')) return asJson(response, 429, { error: 'rate_limited' });
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
        return asJson(response, 200, {
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ['mcp:identidade', 'mcp:obras', 'mcp:conhecimento'],
          bearer_methods_supported: ['header'],
        });
      if (
        url.pathname === '/.well-known/oauth-authorization-server' ||
        url.pathname === '/.well-known/openid-configuration'
      )
        return asJson(response, 200, {
          issuer: baseUrl,
          authorization_endpoint: state.invalidMetadataEndpoint
            ? 'http://127.0.0.1:1/untrusted-authorize'
            : `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          jwks_uri: `${baseUrl}/oauth/jwks`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          scopes_supported: ['mcp:identidade', 'mcp:obras', 'mcp:conhecimento'],
        });
      if (url.pathname === '/oauth/authorize') {
        assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
        assert.equal(url.searchParams.get('resource'), `${baseUrl}/mcp`);
        assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
        const code = `fixture-code-${randomUUID()}`;
        codes.set(code, { challenge: url.searchParams.get('code_challenge'), account: accounts.get(state.loginId) });
        const callback = new URL(REDIRECT);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state'));
        response.writeHead(302, { location: callback.toString() });
        response.end();
        return;
      }
      if (url.pathname === '/oauth/token') {
        assert.equal(
          request.headers.authorization,
          `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
        );
        if (state.tokenRedirect) {
          response.writeHead(302, { location: `${baseUrl}/redirect-target` });
          response.end();
          return;
        }
        const form = new URLSearchParams(raw);
        assert.equal(form.get('resource'), `${baseUrl}/mcp`);
        let account;
        if (form.get('grant_type') === 'authorization_code') {
          state.exchangeCalls += 1;
          const grant = codes.get(form.get('code'));
          codes.delete(form.get('code'));
          if (!grant) return asJson(response, 400, { error: 'invalid_grant' });
          assert.equal(form.get('redirect_uri'), REDIRECT);
          assert.equal(
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url'),
            grant.challenge
          );
          account = grant.account;
        } else if (form.get('grant_type') === 'refresh_token') {
          state.refreshCalls += 1;
          const gate = refreshGate;
          refreshGate = null;
          if (gate) {
            gate.enter();
            await gate.wait;
          }
          const token = form.get('refresh_token');
          account = refresh.get(token);
          refresh.delete(token);
          if (!account) return asJson(response, 400, { error: 'invalid_grant' });
          if (state.refreshDelay) await new Promise((resolve) => setTimeout(resolve, state.refreshDelay));
        } else return asJson(response, 400, { error: 'unsupported_grant_type' });
        return asJson(response, 200, issueTokens(account));
      }
      const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1];
      const account = access.get(bearer);
      if (!account || state.invalidTokens) return asJson(response, 401, { error: 'invalid_token' });
      if (url.pathname === '/mcp/vinculo') {
        const gate = identityGate;
        identityGate = null;
        if (gate) {
          gate.enter();
          await gate.wait;
        }
        return asJson(response, 200, {
          status: 'vinculado',
          app_user_id: state.tokenSubjectOverride ?? account.id,
          display_name: account.name,
          empresas: account.organizations.map((id) => ({ organization_id: id, name: `Organization ${id}` })),
        });
      }
      if (url.pathname !== '/mcp') return asJson(response, 404, { error: 'not_found' });
      assert.equal(request.headers['x-erp-user-id'], account.id);
      assert.match(request.headers.accept ?? '', /application\/json/);
      const message = JSON.parse(raw);
      if (message.method === 'initialize')
        return rpc(response, message.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-erp', version: '1' },
        });
      if (message.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === 'tools/list')
        return rpc(response, message.id, {
          tools: [
            ...['erp.consultas.buscar', 'erp.consultas.descrever', 'erp.consultas.executar'].map((name) => ({
              name,
              description: 'Read catalog fixture',
              inputSchema: { type: 'object', properties: {} },
            })),
            {
              name: 'erp.quem_sou',
              description: 'Fixture identity',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'obras.listar',
              description: 'Fixture allowed projects',
              inputSchema: {
                type: 'object',
                properties: { organization_id: { type: 'string' } },
                required: ['organization_id'],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'conhecimento.autorizacao',
              description: 'Fixture current knowledge authorization',
              inputSchema: {
                type: 'object',
                properties: { organization_id: { type: 'string' } },
                required: ['organization_id'],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'compras.criar',
              description: 'Fixture controlled action',
              inputSchema: {
                type: 'object',
                properties: { organization_id: { type: 'string' }, confirmation_id: { type: 'string' } },
                required: ['organization_id'],
              },
              annotations: { readOnlyHint: false },
            },
          ],
        });
      if (message.method !== 'tools/call') return asJson(response, 400, { error: 'bad_rpc_method' });
      if (message.params.name.startsWith('erp.consultas.')) {
        assert.equal(Object.hasOwn(message.params.arguments, 'organization_id'), false);
        return rpc(response, message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ organizations: account.organizations, parameters: message.params.arguments }),
            },
          ],
        });
      }
      if (message.params?.name === 'conhecimento.autorizacao') {
        state.knowledgeCalls += 1;
        const organizationId = message.params.arguments?.organization_id;
        if (state.knowledgeDenied || !account.organizations.includes(organizationId))
          return rpc(response, message.id, { isError: true, content: [{ type: 'text', text: 'forbidden' }] });
        const allowed = state.permissions;
        const policy = state.knowledgePolicyOverride ?? {
          policy_version: 1,
          user_id: account.id,
          organization_id: organizationId,
          ...(state.knowledgeGroup ? { group: state.knowledgeGroup } : {}),
          capabilities: {
            read: allowed,
            publish: allowed,
            revise: allowed,
            withdraw: allowed,
            approveOfficial: allowed,
          },
          audiences: [
            {
              key: 'empresa',
              label: `Organization ${organizationId}`,
              read: allowed,
              publish: allowed,
              review: allowed,
            },
            { key: 'modulo:engenharia', label: 'Engineering', read: allowed, publish: allowed, review: allowed },
          ],
        };
        return rpc(response, message.id, { content: [{ type: 'text', text: JSON.stringify(policy) }] });
      }
      if (message.params?.name === 'erp.quem_sou')
        return rpc(response, message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                user: { id: state.mismatchIdentity ? 'erp-other' : account.id, name: account.name },
                memberships: account.organizations.map((id) => ({
                  organization_id: id,
                  name: `Organization ${id}`,
                  modules: state.permissions ? { engenharia: ['visualizar'] } : {},
                })),
              }),
            },
          ],
        });
      if (message.params?.name === 'obras.listar') {
        const args = message.params.arguments;
        if (!state.permissions || !record(args) || !account.organizations.includes(args.organization_id))
          return rpc(response, message.id, { isError: true, content: [{ type: 'text', text: 'forbidden' }] });
        const gate = toolGate;
        toolGate = null;
        if (gate) {
          gate.enter();
          await gate.wait;
        }
        const text = state.oversizeToolResult
          ? 'x'.repeat(1024 * 1024 + 1)
          : state.reflectToken
            ? `Upstream reflected ${bearer}`
            : 'Allowed fixture project';
        const structuredContent = state.reflectToken
          ? {
              [bearer]: 'reflected as key',
              encoded: Buffer.from(bearer).toString('base64'),
              escaped: encodeURIComponent(bearer),
            }
          : { organization_id: args.organization_id, projects: ['fixture-project'] };
        return rpc(response, message.id, { content: [{ type: 'text', text }], structuredContent });
      }
      if (message.params?.name === 'compras.criar') {
        const args = message.params.arguments;
        if (
          !state.permissions ||
          !record(args) ||
          !account.organizations.includes(args.organization_id) ||
          args.confirmation_id
        )
          return rpc(response, message.id, { isError: true, content: [{ type: 'text', text: 'consent_required' }] });
        return rpc(response, message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'aguardando_consentimento',
                confirmation_id: 'fixture-confirmation',
                consent_url: `${baseUrl}/mcp/consent/fixture-confirmation`,
              }),
            },
          ],
        });
      }
      return rpc(response, message.id, { isError: true, content: [{ type: 'text', text: 'unknown_tool' }] });
    })().catch(() => asJson(response, 500, { error: 'fixture_failure' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })
  );
  return {
    baseUrl,
    accounts,
    state,
    seen,
    tokens,
    holdIdentity: () => hold('identity'),
    holdTool: () => hold('tool'),
    holdRefresh: () => hold('refresh'),
    authorize: async (url) => {
      const response = await fetch(url, { redirect: 'manual' });
      assert.equal(response.status, 302);
      return new URL(response.headers.get('location'));
    },
  };
}

export async function fixture(t, options = {}) {
  const erp = await startErp(t);
  let clock = Date.UTC(2026, 10, 6, 12);
  const app = await startControl(t, {
    now: () => clock,
    strata: {
      resourceUrl: `${erp.baseUrl}/mcp`,
      issuer: erp.baseUrl,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT,
      encryptionKey: ENCRYPTION_KEY,
      scopes: 'mcp:identidade mcp:obras mcp:conhecimento',
      allowInsecureTest: true,
    },
    ...options,
  });
  const owner = await app.login();
  const connect = async (login = owner) => {
    const response = await app.request('/strata/connect', { method: 'POST', token: login.token, body: {} });
    assert.equal(response.status, 200);
    return response.json();
  };
  const callbackFor = async (started) => {
    const callback = await erp.authorize(started.authorizationUrl);
    return `${callback.pathname}${callback.search}`;
  };
  const link = async (login = owner, { select = true } = {}) => {
    const started = await connect(login);
    const callback = await callbackFor(started);
    const response = await app.request(callback);
    assert.equal(response.status, 200, await response.text());
    const status = await (await app.request('/strata/status', { token: login.token })).json();
    if (select && status.organizations?.length > 1) {
      const selected = await app.request('/strata/organization', {
        method: 'POST',
        token: login.token,
        body: { organizationId: status.organizations[0].id },
      });
      assert.equal(selected.status, 200);
      return (await app.request('/strata/status', { token: login.token })).json();
    }
    return status;
  };
  return {
    app,
    erp,
    owner,
    connect,
    callbackFor,
    link,
    advance: (ms) => {
      clock += ms;
    },
  };
}

export async function assertNoTokenPlaintext(directory, tokens) {
  const files = await readdir(directory, { recursive: true });
  const contents = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, content: await readFile(join(directory, file)) };
      } catch {
        return null;
      }
    })
  );
  for (const item of contents) {
    if (!item) continue;
    for (const token of tokens)
      assert.equal(item.content.includes(Buffer.from(token)), false, `credential persisted in ${item.file}`);
  }
}
