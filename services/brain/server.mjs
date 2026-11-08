import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { canManage, canRead, readScope } from './access.mjs';
import { createBrainStore } from './store.mjs';
import { diagnosticEvent, findSecrets } from './text.mjs';
import { createCurator, requiresHighRisk } from './curator.mjs';

const BODY_LIMIT = 256 * 1024;
const SEARCH_MAX_FACTS = 5;
const SEARCH_MAX_CHARS = 1500;
const MANAGER_MAX_FACTS = 200;
const OWNER = 'owner';
const FACT_TEXT_MAX = 2000;
const LOG_MAX_ROWS = 1000;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const USER_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;
const REQUEST_BODY = Symbol('brain-request-body');

const fail = (status, code) => Object.assign(new Error(code), { status, code });

const json = (response, status, body) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
};

async function readJson(request) {
  if (request[REQUEST_BODY]) return request[REQUEST_BODY].value;
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw fail(400, 'invalid_request');
  if (request.headers['content-encoding']) throw fail(400, 'invalid_request');
  if (Number(request.headers['content-length'] ?? 0) > BODY_LIMIT) throw fail(413, 'request_too_large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw fail(413, 'request_too_large');
    chunks.push(chunk);
  }
  try {
    const bytes = Buffer.concat(chunks);
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    request[REQUEST_BODY] = { value, hash: createHash('sha256').update(bytes).digest('hex') };
    return value;
  } catch {
    throw fail(400, 'invalid_request');
  }
}

const digest = (value) => createHash('sha256').update(value).digest();

/** Constant-time secret check: both sides are hashed to equal-length buffers first. */
const secretMatches = (expected, given) =>
  typeof given === 'string' && timingSafeEqual(digest(expected), digest(given));

const isId = (value) => Number.isInteger(value) && value > 0;
const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const intersectScopes = (left, right) => {
  if (left.all) return right;
  if (right.all) return left;
  const intersection = (a, b) => new Set([...a].filter((id) => b.has(id)));
  return { low: intersection(left.low, right.low), high: intersection(left.high, right.high) };
};

function identityOf(request) {
  const userId = request.headers['x-jr-user-id'];
  const role = request.headers['x-jr-role'];
  const title = request.headers['x-jr-title'] ?? '';
  if (typeof userId !== 'string' || !USER_ID.test(userId)) throw fail(400, 'invalid_identity');
  if (typeof role !== 'string' || !/^[a-z]{1,32}$/u.test(role)) throw fail(400, 'invalid_identity');
  return { userId, role, title: typeof title === 'string' ? title.slice(0, 200) : '' };
}

/** Create the internal brain service; the caller owns listening and shutdown. */
export function createBrainServer({
  databasePath,
  secret,
  curator: curatorOption,
  now = Date.now,
  companyId,
  dailyCuratorCalls,
  resolveAuthorization = null,
  erpAuthorization = false,
  log = () => {},
} = {}) {
  if (typeof secret !== 'string' || secret.length < 1) throw new Error('invalid_configuration');
  const initialStore = createBrainStore(databasePath, {
    now,
    ...(companyId ? { companyId } : {}),
    ...(Number.isInteger(dailyCuratorCalls) && dailyCuratorCalls >= 0 ? { dailyCuratorCalls } : {}),
  });
  initialStore.log.prune(90);
  const requestState = new AsyncLocalStorage();
  const tenants = new Map();
  const store = new Proxy(initialStore, {
    get: (_target, key) => (requestState.getStore()?.store ?? initialStore)[key],
  });
  // A function builds the curator from the store this server owns.
  const buildCurator = (tenantStore) =>
    (typeof curatorOption === 'function' ? curatorOption(tenantStore) : curatorOption) ??
    createCurator({ store: tenantStore, now, log });
  const initialCurator = buildCurator(initialStore);
  tenants.set(initialStore.companyId, { store: initialStore, curator: initialCurator });
  const curator = new Proxy(initialCurator, {
    get: (_target, key) => (requestState.getStore()?.curator ?? initialCurator)[key],
  });
  const tenantFor = (organizationId) => {
    let tenant = tenants.get(organizationId);
    if (!tenant) {
      // shortcut: at most 100 open tenant stores; add idle eviction when a deployment needs more.
      if (tenants.size >= 100) throw fail(503, 'tenant_capacity');
      const tenantStore = createBrainStore(databasePath, {
        now,
        companyId: organizationId,
        ...(Number.isInteger(dailyCuratorCalls) && dailyCuratorCalls >= 0 ? { dailyCuratorCalls } : {}),
      });
      tenantStore.log.prune(90);
      tenant = { store: tenantStore, curator: buildCurator(tenantStore) };
      tenants.set(organizationId, tenant);
    }
    return tenant;
  };
  const emit = (event, details) => {
    const value = diagnosticEvent(event, details, now);
    store.diagnostics.add(value);
    log(JSON.stringify(value));
  };
  const generalId = () => store.areas.list().find((area) => area.isGeneral).id;

  const context = (identity, request) => {
    const live = requestState.getStore()?.authorization;
    if (live) {
      const readable = live.scope.low;
      const managed =
        live.capabilities.revise || live.capabilities.withdraw || live.capabilities.approveOfficial
          ? readable
          : new Set();
      return {
        identity,
        request,
        erp: true,
        authorization: live,
        authorizationPromise: Promise.resolve(live),
        memberships: [],
        scope: live.scope,
        managed: () => ({ low: managed, high: managed, verified: true }),
        can: (areaId) => managed.has(areaId),
        logHigh(facts) {
          for (const fact of facts.filter((item) => item.risk === 'high'))
            tenantFor(fact.companyId).store.log.add({ userId: identity.userId, action: 'read_high', factId: fact.id });
        },
      };
    }
    const memberships = store.members.of(identity.userId);
    return {
      identity,
      request,
      memberships,
      scope: readScope(identity, memberships, generalId(), store.areas.fallbackId()),
      managed: () =>
        identity.userId === OWNER
          ? { all: true }
          : (() => {
              const ids = new Set(
                memberships
                  .filter(
                    (m) => m.level === 'gestor' && m.areaId !== store.areas.fallbackId() && m.areaId !== generalId()
                  )
                  .map((m) => m.areaId)
              );
              return { low: ids, high: ids };
            })(),
      // Geral is managed by the owner only, whatever a stale membership says.
      can: (areaId) =>
        (identity.userId === OWNER || areaId !== generalId()) && canManage(identity, memberships, areaId),
      logHigh(facts) {
        if (identity.userId === OWNER) return;
        for (const id of new Set(facts.filter((fact) => fact.risk === 'high').map((fact) => fact.id)))
          store.log.add({ userId: identity.userId, action: 'read_high', factId: id });
      },
    };
  };

  const requireOwner = (identity) => {
    if (identity.userId !== OWNER) throw fail(403, 'forbidden');
  };
  const intParam = (value) => (/^[0-9]{1,12}$/u.test(value) ? Number(value) : null);

  /** Only a server-installed ERP adapter can establish identity, tenant and effective permissions. */
  const authorize = async (ctx, correlationId = randomUUID()) => {
    if (ctx.erp) {
      if (!ctx.authorization.capabilities.read) throw fail(403, 'forbidden');
      return ctx.authorization;
    }
    let authorization;
    let failureCode = 'authorization_failed';
    if (ctx.request.method !== 'GET' && ctx.request.headers['content-type'] !== undefined) await readJson(ctx.request);
    try {
      ctx.authorizationPromise ??= Promise.resolve().then(() =>
        resolveAuthorization?.(ctx.identity, {
          method: ctx.request.method,
          path: ctx.request.url,
          bodyHash: ctx.request[REQUEST_BODY]?.hash ?? createHash('sha256').update('').digest('hex'),
          proof: ctx.request.headers['x-brain-erp-context'],
        })
      );
      authorization = await ctx.authorizationPromise;
    } catch (error) {
      if (error?.code === 'erp_knowledge_policy_required') failureCode = error.code;
    }
    const ids = (value) => (value instanceof Set ? [...value] : Array.isArray(value) ? value : null);
    const validIds = (value) => {
      const values = ids(value);
      return values && values.length <= 200 && values.every(isId) ? new Set(values) : null;
    };
    const low = validIds(authorization?.scope?.low);
    const high = validIds(authorization?.scope?.high);
    const publish = validIds(authorization?.publishAreaIds);
    const review = validIds(authorization?.reviewAreaIds);
    if (
      !authorization ||
      authorization.jrUserId !== ctx.identity.userId ||
      typeof authorization.erpUserId !== 'string' ||
      !USER_ID.test(authorization.erpUserId) ||
      authorization.organizationId !== store.companyId ||
      (!authorization.scope?.all && (!low || !high)) ||
      !publish ||
      !review
    ) {
      emit('authorization_failed', { correlationId });
      throw fail(403, failureCode);
    }
    const scope = intersectScopes(ctx.scope, authorization.scope.all ? { all: true } : { low, high });
    return { scope, publish, review, erpUserId: authorization.erpUserId };
  };

  const audiences = (ctx) => {
    if (ctx.erp) return ctx.authorization.audiences;
    const own = new Set(ctx.memberships.map((membership) => membership.areaId));
    return store.areas
      .list()
      .filter((area) => area.id !== store.areas.fallbackId() && (ctx.identity.userId === OWNER || own.has(area.id)))
      .map(({ id, name }) => ({ id, name }));
  };
  const inFlightProposals = new Map();
  const boundSubject = (ctx) => (ctx.erp ? ctx.authorization.erpUserId : undefined);
  const canRevise = (ctx, access, fact) =>
    ctx.erp
      ? access.capabilities.revise && access.scope.low.has(fact.areaId) && fact.authorErpUserId === access.erpUserId
      : ctx.can(fact.areaId) && access.review.has(fact.areaId);
  const sourceAccess = async (ctx, proposal, authorization) => {
    if (proposal.supersedesId === null) return null;
    const access = authorization ?? (await authorize(ctx, proposal.id));
    const source = store.facts.get(proposal.supersedesId, access.scope);
    if (!source || !canRevise(ctx, access, source)) throw fail(404, 'proposal_not_found');
    return source;
  };
  const ownProposals = async (response, ctx) => {
    const proposals = store.notes.listOwn(ctx.identity.userId, boundSubject(ctx));
    let authorization;
    if (proposals.some((proposal) => proposal.supersedesId !== null)) {
      try {
        authorization = await authorize(ctx);
      } catch {
        /* own original excerpts remain private */
      }
    }
    const visible = [];
    for (const proposal of proposals) {
      if (proposal.supersedesId !== null) {
        if (!authorization) continue;
        try {
          await sourceAccess(ctx, proposal, authorization);
        } catch {
          continue;
        }
      }
      visible.push(proposal);
    }
    return json(response, 200, { proposals: visible });
  };

  const createProposal = async (request, response, ctx) => {
    const body = await readJson(request);
    if (body.authorized !== true || !REQUEST_ID.test(body.requestId ?? '')) throw fail(400, 'explicit_source_required');
    if (body.factId !== undefined) {
      if (!isId(body.factId)) throw fail(400, 'invalid_request');
      const authorization = await authorize(ctx, body.requestId);
      const fact = store.facts.get(body.factId, authorization.scope);
      if (!fact || !canRevise(ctx, authorization, fact)) throw fail(404, 'fact_not_found');
      if (fact.status !== 'active' || fact.supersededBy !== null) throw fail(409, 'version_conflict');
      const hash = createHash('sha256')
        .update(JSON.stringify([fact.id, fact.version]))
        .digest('hex');
      const previous = store.notes.byRequest(ctx.identity.userId, body.requestId, hash, boundSubject(ctx));
      const proposal =
        previous ??
        store.notes.create(
          ctx.identity.userId,
          body.requestId,
          hash,
          {
            text: fact.text,
            sourceQuote: fact.sourceQuote ?? fact.text,
            sourceKind: fact.sourceKind,
            areaId: fact.areaId,
            risk: fact.risk,
            kind: fact.noteType,
            noteId: fact.noteId,
            noteVersion: fact.version + 1,
            supersedesId: fact.id,
            validFrom: fact.validFrom,
            validUntil: fact.validUntil,
          },
          fact.sourceQuote ?? fact.text,
          boundSubject(ctx)
        );
      return json(response, previous ? 200 : 201, { proposal, audiences: audiences(ctx), state: 'proposal_created' });
    }
    if (
      !Array.isArray(body.messages) ||
      body.messages.length < 1 ||
      body.messages.length > 10 ||
      body.messages.some(
        (message) => !message || !['user', 'assistant'].includes(message.role) || !isText(message.text, 8000)
      )
    )
      throw fail(400, 'explicit_source_required');
    const source = body.messages.map((message) => message.text).join('\n');
    if (source.length > 20000 || findSecrets(source).length) throw fail(400, 'source_rejected');
    const requestHash = createHash('sha256').update(JSON.stringify(body.messages)).digest('hex');
    if (ctx.erp && (!ctx.authorization.capabilities.publish || !ctx.authorization.publish.size))
      throw fail(403, 'forbidden');
    const previous = store.notes.byRequest(ctx.identity.userId, body.requestId, requestHash, boundSubject(ctx));
    if (previous) return json(response, 200, { proposal: previous, audiences: audiences(ctx), state: previous.status });
    const key = `${store.companyId}:${ctx.identity.userId}:${boundSubject(ctx) ?? ''}:${body.requestId}`;
    const pending = inFlightProposals.get(key);
    if (pending && pending.hash !== requestHash) throw fail(409, 'idempotency_conflict');
    const run =
      pending?.run ??
      (async () => {
        emit('capture_queued', { correlationId: body.requestId, itemCount: body.messages.length });
        emit('capture_sent', { correlationId: body.requestId, itemCount: body.messages.length });
        if (typeof curator.propose !== 'function') {
          emit('curator_disabled', { correlationId: body.requestId });
          throw fail(503, 'curator_disabled');
        }
        const candidate = await curator.propose(ctx.identity, {
          requestId: body.requestId,
          bot: 'bot',
          messages: body.messages,
          ...(ctx.erp ? { scope: ctx.authorization.scope } : {}),
        });
        if (ctx.erp && !ctx.authorization.publish.has(candidate.areaId)) {
          const target = ctx.authorization.audiences.find((audience) => ctx.authorization.publish.has(audience.id));
          if (!target) throw fail(403, 'forbidden');
          candidate.areaId = target.id;
        }
        const proposal = store.notes.create(
          ctx.identity.userId,
          body.requestId,
          requestHash,
          candidate,
          source,
          boundSubject(ctx)
        );
        emit('proposal_created', {
          correlationId: body.requestId,
          proposalId: proposal.id,
          version: proposal.version,
          itemCount: 1,
        });
        return proposal;
      })();
    if (!pending) inFlightProposals.set(key, { hash: requestHash, run });
    try {
      json(response, 201, { proposal: await run, audiences: audiences(ctx), state: 'proposal_created' });
    } catch (error) {
      emit('proposal_failed', { correlationId: body.requestId });
      throw error;
    } finally {
      if (inFlightProposals.get(key)?.run === run) inFlightProposals.delete(key);
    }
  };

  const reviseProposal = async (request, response, ctx, id) => {
    const body = await readJson(request);
    const current = store.notes.get(id, ctx.identity.userId, boundSubject(ctx));
    if (!current) throw fail(404, 'proposal_not_found');
    const sourceFact = await sourceAccess(ctx, current);
    if (
      sourceFact &&
      (body.areaId !== sourceFact.areaId ||
        (sourceFact.noteType === 'official_procedure' && body.kind !== 'official_procedure'))
    )
      throw fail(403, 'source_audience_locked');
    if (
      !isId(body.version) ||
      !isText(body.text, FACT_TEXT_MAX) ||
      !isText(body.sourceQuote, 2000) ||
      !audiences(ctx).some((area) => area.id === body.areaId) ||
      !['shared_note', 'official_procedure'].includes(body.kind) ||
      findSecrets(`${body.text}\n${body.sourceQuote}`).length
    )
      throw fail(400, 'invalid_proposal');
    const risk =
      current.risk === 'high' || requiresHighRisk(store, body.text, ctx.erp ? ctx.authorization.scope : undefined)
        ? 'high'
        : 'low';
    if (body.areaId === generalId() && risk === 'high') throw fail(400, 'high_in_general');
    const validFrom = body.validFrom === undefined ? current.validFrom : body.validFrom;
    const validUntil = body.validUntil === undefined ? current.validUntil : body.validUntil;
    if (
      !Number.isFinite(validFrom) ||
      (validUntil !== null && (!Number.isFinite(validUntil) || validUntil <= validFrom))
    )
      throw fail(400, 'invalid_validity');
    const proposal = store.notes.revise(
      id,
      ctx.identity.userId,
      body.version,
      {
        ...body,
        risk,
        validFrom,
        validUntil,
      },
      boundSubject(ctx)
    );
    json(response, 200, { proposal, audiences: audiences(ctx) });
  };

  const consentProposal = async (request, response, ctx, id) => {
    const body = await readJson(request);
    if (
      !isId(body.version) ||
      !/^[a-f0-9]{64}$/u.test(body.hash ?? '') ||
      !['share', 'discard'].includes(body.decision)
    )
      throw fail(400, 'invalid_request');
    const current = store.notes.get(id, ctx.identity.userId, boundSubject(ctx));
    if (!current) throw fail(404, 'proposal_not_found');
    let authorization;
    if (body.decision === 'share') {
      authorization = await authorize(ctx, id);
      await sourceAccess(ctx, current, authorization);
      const allowed =
        ctx.erp && current.supersedesId !== null
          ? authorization.scope.low.has(current.areaId)
          : authorization.publish.has(current.areaId);
      if (!allowed || !audiences(ctx).some((area) => area.id === current.areaId)) throw fail(403, 'forbidden');
    }
    if (body.decision === 'discard') {
      await sourceAccess(ctx, current);
      if (ctx.erp) authorization = ctx.authorization;
    }
    const result = store.notes.consent(
      id,
      ctx.identity.userId,
      body.version,
      body.hash,
      body.decision,
      authorization?.erpUserId
    );
    emit(body.decision === 'share' ? 'consent_granted' : 'consent_denied', {
      correlationId: id,
      proposalId: id,
      version: current.version,
    });
    if (result.proposal.status === 'active')
      emit('note_activated', { correlationId: id, noteId: id, version: current.version });
    json(response, 200, result);
  };

  // ---- end-user routes ----

  const capture = async () => {
    // 503 preserves older clients' queued items; 409 would trigger their permanent-failure deletion.
    throw fail(503, 'consent_required');
  };

  const search = async (request, response, ctx) => {
    const searchId = randomUUID();
    const started = now();
    const authorization = await authorize(ctx, searchId);
    const body = await readJson(request);
    if (!isText(body.query, 1000)) throw fail(400, 'invalid_request');
    const limit =
      Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, SEARCH_MAX_FACTS) : SEARCH_MAX_FACTS;
    const maxChars =
      Number.isInteger(body.maxChars) && body.maxChars > 0
        ? Math.min(body.maxChars, SEARCH_MAX_CHARS)
        : SEARCH_MAX_CHARS;
    let found;
    try {
      found = store.facts.search(authorization.scope, body.query, { limit, maxChars });
    } catch {
      emit('search_failed', { searchId, durationMs: now() - started });
      throw fail(503, 'search_failed');
    }
    emit(found.length ? 'search_executed' : 'search_empty', {
      searchId,
      itemCount: found.length,
      durationMs: now() - started,
    });
    // Reads of high-risk facts are audited for non-owners (who and which fact; never the query).
    ctx.logHigh(found);
    json(response, 200, {
      ...(authorization.scope.group
        ? {
            searchScope: {
              type: 'group',
              groupId: authorization.scope.group.id,
              companyCount: authorization.scope.group.organizations.length,
            },
          }
        : {}),
      facts: found.map((fact) => ({
        id: fact.id,
        text: fact.text,
        area: authorization.scope.group
          ? [fact.area, authorization.scope.group.organizations.find((item) => item.id === fact.companyId)?.name]
              .filter(Boolean)
              .join(' · ')
          : fact.area,
        organizationId: authorization.scope.group ? fact.companyId : undefined,
        risk: fact.risk,
        date: fact.date,
        confidence: fact.confidence,
        erpRef: fact.erpRef,
        noteType: fact.noteType,
        sourceQuote: fact.sourceQuote,
        version: fact.version,
      })),
    });
  };

  const feedback = async (request, response, ctx) => {
    const authorization = await authorize(ctx);
    const body = await readJson(request);
    if (!isId(body.factId)) throw fail(400, 'invalid_request');
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 1000))
      throw fail(400, 'invalid_request');
    // Unreadable facts answer exactly like missing ones.
    const fact = store.facts.get(body.factId, authorization.scope, { acrossGroup: true });
    if (!fact || fact.status !== 'active' || fact.suspended || fact.supersededBy !== null)
      throw fail(404, 'fact_not_found');
    const authoritative = ctx.erp
      ? authorization.capabilities.withdraw && fact.authorErpUserId === authorization.erpUserId
      : ctx.can(fact.areaId) && authorization.review.has(fact.areaId);
    const weight = Math.min(10, Math.max(0, authoritative ? 10 : 3));
    const sourceStore = ctx.erp ? tenantFor(fact.companyId).store : store;
    sourceStore.feedback.vote(fact.id, ctx.identity.userId, weight, 'errado');
    if (authoritative) {
      sourceStore.facts.update(fact.id, { suspended: true, status: 'suspended' }, ctx.identity.userId);
      sourceStore.log.add({ userId: ctx.identity.userId, action: 'suspend', factId: fact.id });
    }
    json(response, 200, { recorded: true, suspended: authoritative });
  };

  const me = (response, ctx) => {
    if (ctx.erp)
      return json(response, 200, {
        areas: ctx.authorization.audiences.map((audience) => ({
          id: audience.id,
          name: audience.name,
          level: ctx.can(audience.id) ? 'gestor' : 'colaborador',
          primary: audience.key === 'empresa',
        })),
        isDirector: false,
        manages: [...ctx.managed().low],
        permissionsSource: 'erp',
        capabilities: ctx.authorization.capabilities,
      });
    const names = new Map(store.areas.list().map((area) => [area.id, area.name]));
    const isDirector = ctx.identity.userId === OWNER;
    json(response, 200, {
      areas: ctx.memberships.map((m) => ({
        id: m.areaId,
        name: names.get(m.areaId) ?? null,
        level: m.level,
        primary: m.primary,
      })),
      isDirector,
      manages: isDirector
        ? [...names.keys()]
        : // Same set as managed(): Geral and the fallback area are never managed by a non-owner.
          [...ctx.managed().low],
    });
  };

  const peers = (response, ctx) => {
    if (ctx.erp) throw fail(403, 'erp_source_authorization_required');
    const byUser = new Map();
    // Geral and the fallback area never make anyone a peer (same exclusion as managed()).
    const skip = new Set([generalId(), store.areas.fallbackId()]);
    for (const mine of ctx.memberships) {
      if (skip.has(mine.areaId)) continue;
      for (const other of store.members.ofArea(mine.areaId)) {
        if (other.userId === ctx.identity.userId) continue;
        const entry = byUser.get(other.userId) ?? [];
        entry.push({ areaId: mine.areaId, level: mine.level });
        byUser.set(other.userId, entry);
      }
    }
    json(response, 200, { peers: [...byUser].map(([userId, areas]) => ({ userId, areas })) });
  };

  const consent = async (request, response, ctx) => {
    if (request.method === 'POST') {
      const body = await readJson(request);
      if (!isText(body.termVersion, 32)) throw fail(400, 'invalid_request');
      store.consent.record(ctx.identity.userId, body.termVersion);
    }
    const latest = store.consent.latest(ctx.identity.userId);
    json(response, 200, { version: latest?.version ?? null, at: latest?.at ?? null });
  };

  // ---- manager routes ----

  /** Gestores see the quote but not who said it nor which conversation; only the owner sees both. */
  const forManager = (ctx, fact) => {
    if (ctx.erp) {
      const { authorUserId: _jrAuthor, authorErpUserId: _erpAuthor, conversationRef: _conversation, ...visible } = fact;
      const mine = fact.authorErpUserId === ctx.authorization.erpUserId;
      return {
        ...visible,
        canRevise: mine && ctx.authorization.capabilities.revise,
        canWithdraw: mine && ctx.authorization.capabilities.withdraw,
        canReactivate:
          mine &&
          ctx.authorization.capabilities.revise &&
          (fact.noteType !== 'official_procedure' || ctx.authorization.capabilities.approveOfficial),
      };
    }
    if (ctx.identity.userId === OWNER) return fact;
    const { authorUserId: _author, authorErpUserId: _erpAuthor, conversationRef: _conversation, ...rest } = fact;
    return rest;
  };

  const listFacts = (url, response, ctx) => {
    const managed = ctx.managed();
    if (!managed.all && managed.low.size === 0) throw fail(403, 'forbidden');
    const params = url.searchParams;
    const filters = { limit: MANAGER_MAX_FACTS };
    if (params.has('areaId')) {
      const areaId = intParam(params.get('areaId'));
      if (areaId === null) throw fail(400, 'invalid_request');
      if (!ctx.can(areaId)) throw fail(403, 'forbidden');
      filters.areaId = areaId;
    }
    if (params.has('risk')) {
      if (!['low', 'high'].includes(params.get('risk'))) throw fail(400, 'invalid_request');
      filters.risk = params.get('risk');
    }
    if (params.has('kind')) filters.kind = params.get('kind');
    if (params.has('suspended')) filters.suspended = params.get('suspended') === 'true';
    if (params.get('q')) filters.q = params.get('q').slice(0, 200);
    const facts = store.facts.listForManager(managed, filters);
    ctx.logHigh(facts);
    json(response, 200, { facts: facts.map((fact) => forManager(ctx, fact)) });
  };

  const patchFact = async (request, response, ctx, id) => {
    const body = await readJson(request);
    const current = store.facts.get(id, ctx.authorization.scope);
    // Facts outside the caller's managed areas look nonexistent.
    if (!current || !ctx.can(current.areaId)) throw fail(404, 'fact_not_found');
    const allowed = new Set(['text', 'areaId', 'risk', 'active', 'suspended', 'general']);
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key) || value === null) throw fail(400, 'invalid_request');
    }
    if (['text', 'areaId', 'risk', 'general'].some((key) => body[key] !== undefined))
      throw fail(409, 'consent_required');
    if (
      !['active', 'suspended'].includes(current.status) ||
      (current.noteType === 'official_procedure' && !current.approvedBy)
    )
      throw fail(409, 'review_required');
    const patch = {};
    for (const key of ['active', 'suspended']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') throw fail(400, 'invalid_request');
    }
    if (body.suspended === true || body.active === false) {
      if (
        ctx.erp &&
        (!ctx.authorization.capabilities.withdraw || current.authorErpUserId !== ctx.authorization.erpUserId)
      )
        throw fail(403, 'forbidden');
      patch.status = 'suspended';
      patch.active = false;
      patch.suspended = true;
    } else if (body.active === true || body.suspended === false) {
      if (
        ctx.erp &&
        (!canRevise(ctx, ctx.authorization, current) ||
          (current.noteType === 'official_procedure' && !ctx.authorization.capabilities.approveOfficial))
      )
        throw fail(403, 'forbidden');
      patch.status = 'active';
      patch.active = true;
      patch.suspended = false;
    }
    const updated = store.facts.update(id, patch, ctx.identity.userId);
    store.log.add({ userId: ctx.identity.userId, action: 'update_fact', factId: id });
    ctx.logHigh([updated]);
    json(response, 200, { fact: forManager(ctx, updated) });
  };

  const factHistory = (response, ctx, id) => {
    const current = store.facts.get(id, ctx.authorization.scope);
    if (!current || !ctx.can(current.areaId)) throw fail(404, 'fact_not_found');
    const history = store.facts.history(id, ctx.managed());
    ctx.logHigh(history);
    json(response, 200, { history: history.map((fact) => forManager(ctx, fact)) });
  };

  const areasRoute = async (request, response, ctx, id) => {
    requireOwner(ctx.identity);
    if (request.method === 'GET' && id === null) {
      const areas = store.areas.list().map((area) => ({ ...area, members: store.members.ofArea(area.id) }));
      return json(response, 200, { areas });
    }
    if (request.method === 'POST' && id === null) {
      const body = await readJson(request);
      return json(response, 201, { area: store.areas.create(body.name) });
    }
    if (id === null) throw fail(404, 'not_found');
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      return json(response, 200, { area: store.areas.rename(id, body.name) });
    }
    if (request.method === 'DELETE') {
      store.areas.remove(id);
      return json(response, 200, { removed: true });
    }
    throw fail(404, 'not_found');
  };

  const putMember = async (request, response, ctx, userId) => {
    requireOwner(ctx.identity);
    const body = await readJson(request);
    if (!USER_ID.test(userId) || !Array.isArray(body.memberships) || body.memberships.length > 100)
      throw fail(400, 'invalid_request');
    const memberships = body.memberships.map((m) => {
      if (!m || !isId(m.areaId) || typeof m.level !== 'string') throw fail(400, 'invalid_request');
      return { areaId: m.areaId, level: m.level, primary: m.primary === true };
    });
    store.members.set(userId, memberships);
    store.log.add({ userId: ctx.identity.userId, action: 'set_members' });
    json(response, 200, { memberships: store.members.of(userId) });
  };

  const manage = async (request, response, ctx, url, path) => {
    const method = request.method;
    if (ctx.erp && /^\/manage\/(?:areas|members|authors|log|diagnostics)(?:\/|$)/u.test(path))
      throw fail(403, 'erp_managed_permissions');
    if (method === 'GET' && path === '/manage/diagnostics') {
      requireOwner(ctx.identity);
      return json(response, 200, { events: store.diagnostics.list() });
    }
    const authorization = await authorize(ctx);
    const baseContext = ctx;
    ctx = ctx.erp
      ? { ...baseContext, authorization }
      : {
          ...baseContext,
          authorization,
          managed: () => intersectScopes(baseContext.managed(), authorization.scope),
          can: (areaId) => baseContext.can(areaId) && authorization.review.has(areaId),
        };
    if (method === 'GET' && path === '/manage/proposals') {
      if (ctx.erp && !authorization.capabilities.approveOfficial) throw fail(403, 'forbidden');
      const allowed = new Set([...authorization.review].filter((areaId) => ctx.can(areaId)));
      const managed = ctx.managed();
      const scope = {
        low: new Set([...allowed].filter((id) => managed.all || managed.low.has(id))),
        high: new Set([...allowed].filter((id) => managed.all || managed.high.has(id))),
        ...(ctx.erp ? { verified: true } : {}),
      };
      return json(response, 200, { proposals: store.notes.pending(scope) });
    }
    const proposal = /^\/manage\/proposals\/([A-Za-z0-9_-]{1,100})\/review$/u.exec(path);
    if (method === 'POST' && proposal) {
      if (ctx.erp && !authorization.capabilities.approveOfficial) throw fail(403, 'forbidden');
      const body = await readJson(request);
      if (!isId(body.version) || !['approve', 'reject'].includes(body.decision)) throw fail(400, 'invalid_request');
      const result = store.notes.review(
        proposal[1],
        body.version,
        ctx.identity.userId,
        body.decision,
        (areaId, risk) =>
          ctx.can(areaId) && authorization.review.has(areaId) && canRead(authorization.scope, { areaId, risk }),
        authorization.erpUserId,
        ctx.erp === true
      );
      emit(body.decision === 'approve' ? 'review_approved' : 'review_rejected', {
        proposalId: proposal[1],
        version: body.version,
      });
      if (body.decision === 'approve') emit('note_activated', { noteId: proposal[1], version: body.version });
      return json(response, 200, result);
    }
    if (method === 'GET' && path === '/manage/facts') return listFacts(url, response, ctx);
    const fact = /^\/manage\/facts\/([0-9]{1,12})(\/history)?$/u.exec(path);
    if (fact) {
      const id = Number(fact[1]);
      if (method === 'PATCH' && !fact[2]) return patchFact(request, response, ctx, id);
      if (method === 'GET' && fact[2]) return factHistory(response, ctx, id);
    }
    const area = /^\/manage\/areas(?:\/([0-9]{1,12}))?$/u.exec(path);
    if (area) return areasRoute(request, response, ctx, area[1] === undefined ? null : Number(area[1]));
    const decode = (value) => {
      try {
        const decoded = decodeURIComponent(value);
        if (!USER_ID.test(decoded)) throw new Error();
        return decoded;
      } catch {
        throw fail(400, 'invalid_request');
      }
    };
    const member = /^\/manage\/members\/([^/]{1,128})$/u.exec(path);
    if (member && method === 'PUT') return putMember(request, response, ctx, decode(member[1]));
    const author = /^\/manage\/authors\/([^/]{1,128})\/facts$/u.exec(path);
    if (author && method === 'DELETE') {
      requireOwner(ctx.identity);
      const userId = decode(author[1]);
      const deleted = store.facts.deleteByAuthor(userId);
      store.log.add({ userId: ctx.identity.userId, action: 'delete_author_facts' });
      return json(response, 200, { deleted });
    }
    if (method === 'GET' && path === '/manage/log') {
      requireOwner(ctx.identity);
      const since = Number(url.searchParams.get('since') ?? 0);
      return json(response, 200, {
        log: store.log.list({ since: Number.isFinite(since) ? since : 0, limit: LOG_MAX_ROWS }),
      });
    }
    throw fail(404, 'not_found');
  };

  const dispatch = async (request, response, identity) => {
    const url = new URL(request.url ?? '/', 'http://brain.internal');
    const path = url.pathname;
    const method = request.method;
    const ctx = context(identity, request);
    if (ctx.erp && !['/me', '/capture', '/consent'].includes(path) && !ctx.authorization.capabilities.read)
      throw fail(403, 'forbidden');
    if (method === 'POST' && path === '/capture') return capture(request, response, ctx);
    if (method === 'POST' && path === '/proposals') return createProposal(request, response, ctx);
    if (method === 'GET' && path === '/proposals') return ownProposals(response, ctx);
    const proposal = /^\/proposals\/([A-Za-z0-9_-]{1,100})(\/consent)?$/u.exec(path);
    if (proposal && method === 'PATCH' && !proposal[2]) return reviseProposal(request, response, ctx, proposal[1]);
    if (proposal && method === 'POST' && proposal[2]) return consentProposal(request, response, ctx, proposal[1]);
    if (method === 'POST' && path === '/search') return search(request, response, ctx);
    if (method === 'POST' && path === '/feedback') return feedback(request, response, ctx);
    if (method === 'GET' && path === '/me') return me(response, ctx);
    if (method === 'GET' && path === '/peers') return peers(response, ctx);
    if (path === '/consent' && (method === 'GET' || method === 'POST')) return consent(request, response, ctx);
    if (path.startsWith('/manage/')) return manage(request, response, ctx, url, path);
    throw fail(404, 'not_found');
  };
  let closing;
  const server = createServer(
    { maxHeaderSize: 65_536, requestTimeout: 30_000, headersTimeout: 15_000 },
    (request, response) => {
      void (async () => {
        if (closing) throw fail(503, 'service_unavailable');
        if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok' });
        if (!secretMatches(secret, request.headers['x-brain-secret'])) throw fail(401, 'unauthorized');
        const identity = identityOf(request);
        // The inert legacy capture route never reads company content or adopts an ERP tenant.
        const path = new URL(request.url ?? '/', 'http://brain.internal').pathname;
        if (!erpAuthorization || path === '/capture') return dispatch(request, response, identity);
        if (request.method !== 'GET' && request.headers['content-type'] !== undefined) await readJson(request);
        let principal;
        try {
          principal = await resolveAuthorization?.(identity, {
            method: request.method,
            path: request.url,
            bodyHash: request[REQUEST_BODY]?.hash ?? createHash('sha256').update('').digest('hex'),
            proof: request.headers['x-brain-erp-context'],
          });
        } catch (error) {
          emit('authorization_failed', { correlationId: randomUUID() });
          throw fail(403, error?.code === 'erp_knowledge_policy_required' ? error.code : 'authorization_failed');
        }
        if (
          !principal?.knowledgePolicy ||
          principal.jrUserId !== identity.userId ||
          !USER_ID.test(principal.erpUserId ?? '') ||
          !USER_ID.test(principal.organizationId ?? '')
        )
          throw fail(403, 'authorization_failed');
        response.setHeader('x-brain-authorization', principal.knowledgePolicy.group ? 'erp-v3' : 'erp-v2');
        if (principal.knowledgePolicy.group) response.setHeader('x-brain-group', principal.knowledgePolicy.group.id);
        response.setHeader('x-brain-organization', principal.organizationId);
        const tenant = tenantFor(principal.organizationId);
        const policy = principal.knowledgePolicy;
        const labels = tenant.store.areas.syncErpAudiences(policy.audiences);
        const byKey = new Map(labels.map((area) => [area.erpAudienceKey, area]));
        const allowed = (right) =>
          new Set(policy.audiences.filter((audience) => audience[right]).map((audience) => byKey.get(audience.key).id));
        const low = allowed('read');
        const authorization = {
          erpUserId: principal.erpUserId,
          scope: {
            low,
            high: low,
            verified: true,
            ...(policy.group
              ? {
                  group: policy.group,
                  audienceKeys: new Set(
                    policy.audiences.filter((audience) => audience.read).map((audience) => audience.key)
                  ),
                }
              : {}),
          },
          publish: allowed('publish'),
          review: allowed('review'),
          capabilities: policy.capabilities,
          audiences: policy.audiences
            .filter((audience) => audience.read)
            .map((audience) => ({
              id: byKey.get(audience.key).id,
              name: audience.label,
              key: audience.key,
            })),
        };
        return requestState.run({ ...tenant, authorization }, () => dispatch(request, response, identity));
      })().catch((error) => {
        if (response.headersSent || response.destroyed) return response.destroy();
        const known = typeof error?.status === 'number' && typeof error?.code === 'string';
        json(response, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error' } });
      });
    }
  );
  server.keepAliveTimeout = 5_000;
  return {
    server,
    store,
    pruneLogs: (days = 90) => {
      for (const tenant of tenants.values()) tenant.store.log.prune(days);
    },
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      }),
    close() {
      closing ??= (async () => {
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
        }
        for (const tenant of tenants.values()) {
          await tenant.curator.drain();
          tenant.store.close();
        }
      })();
      return closing;
    },
  };
}
