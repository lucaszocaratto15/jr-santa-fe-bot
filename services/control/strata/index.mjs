import { createHash, randomBytes } from 'node:crypto';
import { httpError } from '../validation.mjs';
import { parseStrataConfiguration } from './config.mjs';
import { createStrataStore } from './store.mjs';
import { discover, mcpClient, parseJson, request, toolJson } from './protocol.mjs';
import { knowledgePolicy } from './knowledge.mjs';

const FLOW_MS = 10 * 60_000;
const ID = /^[A-Za-z0-9._:@-]{1,128}$/u;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const tokenText = (value) =>
  typeof value === 'string' && value.length >= 1 && value.length <= 16_384 && /^[\x21-\x7e]+$/u.test(value);
const emptyStatus = (configured) => ({
  configured,
  linked: false,
  erpUser: null,
  organizations: [],
  organizationId: null,
  linkedAt: null,
});

/** OAuth and MCP use the same server-held, employee-bound grant. No provider token crosses this API. */
export function createStrataService({ databasePath, strata: input, now = Date.now, strataFetch = fetch } = {}) {
  const config = parseStrataConfiguration(input);
  const store = config ? createStrataStore(databasePath, config, now) : null;
  const pending = new Map();
  const refreshes = new Map();
  let metadataPromise = null;
  const configured = () => {
    if (!config) throw httpError(503, 'strata_unconfigured');
    return config;
  };
  const metadata = async () => {
    configured();
    metadataPromise ??= discover(config, strataFetch).catch((error) => {
      metadataPromise = null;
      throw error;
    });
    return metadataPromise;
  };
  const assertSession = (session, assertCurrent) => {
    if (!session?.user?.id || !session.sessionHash || typeof assertCurrent !== 'function')
      throw httpError(403, 'strata_invalid_session');
    const current = assertCurrent();
    if (current?.user?.id !== session.user.id || current?.sessionHash !== session.sessionHash)
      throw httpError(403, 'strata_invalid_session');
  };
  const assertLink = (session, revision, assertCurrent, contextRevision) => {
    assertSession(session, assertCurrent);
    if (!store.current(session.user.id, revision, contextRevision)) throw httpError(409, 'strata_link_changed');
  };
  const basic = () => `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  const grantFrom = (value, previous = null) => {
    if (
      !record(value) ||
      !tokenText(value.access_token) ||
      String(value.token_type).toLowerCase() !== 'bearer' ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      value.expires_in > 31_536_000 ||
      (value.refresh_token !== undefined && !tokenText(value.refresh_token))
    )
      throw httpError(503, 'strata_invalid_token_response');
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: now() + value.expires_in * 1000,
    };
  };
  const exchange = async (params, previous) => {
    const endpoints = await metadata();
    return grantFrom(
      parseJson(
        (
          await request(config, strataFetch, endpoints.tokenEndpoint, {
            method: 'POST',
            headers: {
              Authorization: basic(),
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: new URLSearchParams({ ...params, resource: config.resourceUrl }).toString(),
          })
        ).text
      ),
      previous
    );
  };
  const refresh = async (session, link, assertCurrent) => {
    if (!link.grant.refreshToken) throw httpError(403, 'strata_reconnect_required');
    let running = refreshes.get(session.user.id);
    if (!running) {
      running = (async () => {
        const grant = await exchange(
          { grant_type: 'refresh_token', refresh_token: link.grant.refreshToken },
          link.grant
        );
        assertLink(session, link.revision, assertCurrent);
        store.refresh(session.user.id, link.revision, grant);
        return grant;
      })().finally(() => {
        if (refreshes.get(session.user.id) === running) refreshes.delete(session.user.id);
      });
      refreshes.set(session.user.id, running);
    }
    const grant = await running;
    assertLink(session, link.revision, assertCurrent);
    return grant;
  };
  const sanitize = (value, grant) => {
    const secrets = [
      config.clientSecret,
      grant.accessToken,
      grant.refreshToken,
      Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64'),
    ]
      .filter(Boolean)
      .flatMap((secret) => [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])
      .toSorted((left, right) => right.length - left.length);
    const scrub = (text) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
    return JSON.parse(
      JSON.stringify(value, (_key, item) =>
        typeof item === 'string'
          ? scrub(item)
          : record(item)
            ? Object.fromEntries(Object.entries(item).map(([key, child]) => [scrub(key), child]))
            : item
      )
    );
  };
  const verifyGrant = async (grant) => {
    const url = new URL(config.resourceUrl);
    url.pathname = `${url.pathname}/vinculo`;
    const identity = parseJson(
      (
        await request(config, strataFetch, url, {
          headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json' },
        })
      ).text
    );
    if (
      !record(identity) ||
      identity.status !== 'vinculado' ||
      !ID.test(identity.app_user_id ?? '') ||
      typeof identity.display_name !== 'string' ||
      identity.display_name.length > 200 ||
      !Array.isArray(identity.empresas)
    )
      throw httpError(503, 'strata_invalid_identity');
    const client = await mcpClient(config, strataFetch, grant.accessToken, identity.app_user_id);
    const principal = toolJson(await client.rpc('tools/call', { name: 'erp.quem_sou', arguments: {} }));
    if (
      !record(principal) ||
      !record(principal.user) ||
      principal.user.id !== identity.app_user_id ||
      !Array.isArray(principal.memberships) ||
      principal.memberships.length > 20
    )
      throw httpError(403, 'strata_identity_mismatch');
    const organizations = identity.empresas.map((item) => {
      if (
        !record(item) ||
        !ID.test(item.organization_id ?? '') ||
        typeof item.name !== 'string' ||
        item.name.length > 200
      )
        throw httpError(503, 'strata_invalid_identity');
      return { id: item.organization_id, name: item.name };
    });
    const memberships = principal.memberships.map((item) => {
      if (
        !record(item) ||
        !organizations.some((org) => org.id === item.organization_id) ||
        !record(item.modules) ||
        Object.keys(item.modules).length > 200
      )
        throw httpError(503, 'strata_invalid_identity');
      for (const [id, actions] of Object.entries(item.modules))
        if (
          !ID.test(id) ||
          !Array.isArray(actions) ||
          actions.length > 100 ||
          actions.some((action) => typeof action !== 'string' || !ID.test(action))
        )
          throw httpError(503, 'strata_invalid_identity');
      return {
        organization_id: item.organization_id,
        name: item.name ?? organizations.find((org) => org.id === item.organization_id).name,
        modules: item.modules,
      };
    });
    return {
      client,
      user: { id: identity.app_user_id, name: identity.display_name },
      organizations: organizations.filter((org) =>
        memberships.some((membership) => membership.organization_id === org.id)
      ),
      memberships,
    };
  };
  const verified = async (session, assertCurrent, requireOrganization = true) => {
    configured();
    assertSession(session, assertCurrent);
    const link = store.get(session.user.id);
    if (!link?.grant || !link.erp_user_id) throw httpError(403, 'strata_link_required');
    let grant = link.grant;
    if (grant.expiresAt <= now() + 30_000) grant = await refresh(session, link, assertCurrent);
    let identity;
    try {
      identity = await verifyGrant(grant);
    } catch (error) {
      if (error?.code !== 'strata_reconnect_required') throw error;
      grant = await refresh(session, { ...link, grant }, assertCurrent);
      identity = await verifyGrant(grant);
    }
    assertLink(session, link.revision, assertCurrent, link.context_revision);
    if (identity.user.id !== link.erp_user_id) throw httpError(403, 'strata_identity_mismatch');
    const membership = identity.memberships.find((item) => item.organization_id === link.organization_id);
    if (requireOrganization && !membership) throw httpError(403, 'strata_organization_required');
    return {
      ...identity,
      grant,
      link,
      principal: {
        jrUserId: session.user.id,
        erpUserId: identity.user.id,
        organizationId: membership?.organization_id ?? null,
        user: identity.user,
        memberships: identity.memberships,
        modules: membership?.modules ?? {},
      },
    };
  };
  const status = (value) =>
    sanitize(
      {
        configured: true,
        linked: true,
        erpUser: value.user,
        organizations: value.organizations,
        organizationId: value.principal.organizationId,
        linkedAt: new Date(value.link.linked_at).toISOString(),
      },
      value.grant
    );
  const clearPending = (userId) => {
    for (const [key, value] of pending)
      if (value.session.user.id === userId || value.expiresAt <= now()) pending.delete(key);
  };
  return {
    configured: Boolean(config),
    async connect(session, assertCurrent) {
      configured();
      assertSession(session, assertCurrent);
      const endpoints = await metadata();
      assertSession(session, assertCurrent);
      clearPending(session.user.id);
      if (pending.size >= 1000) throw httpError(429, 'strata_rate_limited');
      const revision = store.begin(session.user.id);
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const expiresAt = now() + FLOW_MS;
      pending.set(digest(state), {
        session,
        assertCurrent,
        verifier,
        revision,
        contextRevision: store.get(session.user.id).context_revision,
        expiresAt,
      });
      const url = new URL(endpoints.authorizationEndpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        resource: config.resourceUrl,
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(' '),
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return { authorizationUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
    },
    async callback(params) {
      configured();
      const state = params.get('state');
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(state))
        throw httpError(400, 'strata_invalid_state');
      const key = digest(state);
      const flow = pending.get(key);
      pending.delete(key);
      if (!flow || flow.expiresAt <= now()) throw httpError(400, 'strata_invalid_state');
      assertLink(flow.session, flow.revision, flow.assertCurrent, flow.contextRevision);
      if (params.has('error')) throw httpError(400, 'strata_authorization_denied');
      const code = params.get('code');
      if (!tokenText(code)) throw httpError(400, 'strata_invalid_code');
      const grant = await exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        code_verifier: flow.verifier,
      });
      const identity = await verifyGrant(grant);
      assertLink(flow.session, flow.revision, flow.assertCurrent, flow.contextRevision);
      store.install(
        flow.session.user.id,
        flow.revision,
        { ...identity.user, organizationId: identity.organizations.length === 1 ? identity.organizations[0].id : null },
        grant
      );
      return { linked: true };
    },
    async status(session, assertCurrent) {
      if (!config) return emptyStatus(false);
      if (!store.get(session.user.id)?.grant) return emptyStatus(true);
      return status(await verified(session, assertCurrent, false));
    },
    async organization(session, organizationId, assertCurrent) {
      const value = await verified(session, assertCurrent, false);
      if (
        !ID.test(organizationId ?? '') ||
        !value.memberships.some((membership) => membership.organization_id === organizationId)
      )
        throw httpError(403, 'strata_forbidden');
      assertLink(session, value.link.revision, assertCurrent, value.link.context_revision);
      store.organization(session.user.id, value.link.revision, organizationId);
      return { ...status(value), organizationId };
    },
    disconnect(session, assertCurrent) {
      configured();
      assertSession(session, assertCurrent);
      clearPending(session.user.id);
      store.disconnect(session.user.id);
      return { disconnected: true };
    },
    async resolvePrincipal(session, assertCurrent) {
      return (await verified(session, assertCurrent)).principal;
    },
    async resolveKnowledgePrincipal(session, assertCurrent, groupSearch = false) {
      const resolve = async () => {
        const current = await verified(session, assertCurrent, !groupSearch);
        if (!current.principal.organizationId)
          current.principal.organizationId = current.memberships[0]?.organization_id;
        return current;
      };
      const value = await resolve();
      const readPolicy = async (current) =>
        knowledgePolicy(
          sanitize(
            toolJson(
              await current.client.rpc('tools/call', {
                name: 'conhecimento.autorizacao',
                arguments: { organization_id: current.principal.organizationId },
              })
            ),
            current.grant
          ),
          current.principal
        );
      const policy = await readPolicy(value);
      if (!value.link.organization_id && !policy.group) throw httpError(403, 'strata_organization_required');
      assertLink(session, value.link.revision, assertCurrent, value.link.context_revision);
      return {
        ...value.principal,
        knowledgePolicy: policy,
        async assertCurrent() {
          assertLink(session, value.link.revision, assertCurrent, value.link.context_revision);
          const current = await resolve();
          const latest = await readPolicy(current);
          assertLink(session, value.link.revision, assertCurrent, value.link.context_revision);
          if (JSON.stringify(latest) !== JSON.stringify(policy))
            throw httpError(403, 'strata_knowledge_policy_changed');
        },
      };
    },
    async tools(session, assertCurrent) {
      const value = await verified(session, assertCurrent, false);
      const result = await value.client.rpc('tools/list', {});
      assertLink(session, value.link.revision, assertCurrent, value.link.context_revision);
      if (
        !Array.isArray(result.tools) ||
        result.tools.length > 200 ||
        result.tools.some(
          (tool) =>
            !record(tool) ||
            typeof tool.name !== 'string' ||
            !/^[A-Za-z0-9_.-]{1,128}$/u.test(tool.name) ||
            !record(tool.inputSchema)
        )
      )
        throw httpError(503, 'strata_invalid_response');
      return sanitize({ tools: result.tools }, value.grant);
    },
    async call(session, name, args, assertCurrent) {
      if (
        typeof name !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,128}$/u.test(name) ||
        !record(args) ||
        Buffer.byteLength(JSON.stringify(args)) > 64 * 1024
      )
        throw httpError(400, 'strata_invalid_request');
      const groupQuery = [
        'erp.quem_sou',
        'erp.consultas.buscar',
        'erp.consultas.descrever',
        'erp.consultas.executar',
      ].includes(name);
      const value = await verified(session, assertCurrent, !groupQuery);
      const listed = await value.client.rpc('tools/list', {});
      if (!Array.isArray(listed.tools) || !listed.tools.some((tool) => tool.name === name))
        throw httpError(403, 'strata_forbidden');
      const organizationId = args.organization_id === undefined ? value.principal.organizationId : args.organization_id;
      if (groupQuery && Object.hasOwn(args, 'organization_id')) throw httpError(400, 'strata_invalid_request');
      if (!groupQuery && !value.memberships.some((membership) => membership.organization_id === organizationId))
        throw httpError(403, 'strata_forbidden');
      assertLink(session, value.link.revision, assertCurrent, value.link.context_revision);
      const result = await value.client.rpc('tools/call', {
        name,
        arguments: name === 'erp.quem_sou' ? {} : groupQuery ? args : { ...args, organization_id: organizationId },
      });
      assertLink(session, value.link.revision, assertCurrent, value.link.context_revision);
      if (!Array.isArray(result.content)) throw httpError(503, 'strata_invalid_response');
      return sanitize(result, value.grant);
    },
    close() {
      pending.clear();
      store?.close();
    },
  };
}
