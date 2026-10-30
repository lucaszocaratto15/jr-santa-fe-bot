import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { canManage, readScope } from './access.mjs';
import { createBrainStore } from './store.mjs';
import { findSecrets } from './text.mjs';

const BODY_LIMIT = 256 * 1024;
const SEARCH_MAX_FACTS = 5;
const SEARCH_MAX_CHARS = 1500;
const MANAGER_MAX_FACTS = 200;
const OWNER = 'owner';
const FACT_TEXT_MAX = 2000;
const LOG_MAX_ROWS = 1000;
const USER_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;

const noopCurator = { enqueue() {}, drain: async () => {} };

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
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
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
  curator = noopCurator,
  now = Date.now,
  companyId,
  dailyCuratorCalls,
} = {}) {
  if (typeof secret !== 'string' || secret.length < 1) throw new Error('invalid_configuration');
  const store = createBrainStore(databasePath, {
    now,
    ...(companyId ? { companyId } : {}),
    ...(Number.isInteger(dailyCuratorCalls) && dailyCuratorCalls >= 0 ? { dailyCuratorCalls } : {}),
  });
  store.log.prune(90);
  const generalId = () => store.areas.list().find((area) => area.isGeneral).id;

  const context = (identity) => {
    const memberships = store.members.of(identity.userId);
    return {
      identity,
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

  // ---- end-user routes ----

  const capture = async (request, response, ctx) => {
    const body = await readJson(request);
    const { conversationRef, bot, messages } = body;
    if (!isText(conversationRef, 200) || !isText(bot, 100) || !Array.isArray(messages) || messages.length > 400)
      throw fail(400, 'invalid_request');
    const clean = [];
    for (const message of messages) {
      if (!message || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.text !== 'string')
        throw fail(400, 'invalid_request');
      clean.push({ role: message.role, text: message.text });
    }
    // Raw text goes to the curator in memory only; it is never written here.
    try {
      // Capture is best effort: a curator failure (sync or async) drops the batch silently.
      Promise.resolve(curator.enqueue(ctx.identity, { conversationRef, bot, messages: clean })).catch(() => {});
    } catch {
      // dropped
    }
    json(response, 202, { accepted: true });
  };

  const search = async (request, response, ctx) => {
    const body = await readJson(request);
    if (!isText(body.query, 1000)) throw fail(400, 'invalid_request');
    const limit =
      Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, SEARCH_MAX_FACTS) : SEARCH_MAX_FACTS;
    const maxChars =
      Number.isInteger(body.maxChars) && body.maxChars > 0
        ? Math.min(body.maxChars, SEARCH_MAX_CHARS)
        : SEARCH_MAX_CHARS;
    const found = store.facts.search(ctx.scope, body.query, { limit, maxChars });
    // Reads of high-risk facts are audited for non-owners (who and which fact; never the query).
    ctx.logHigh(found);
    json(response, 200, {
      facts: found.map((fact) => ({
        id: fact.id,
        text: fact.text,
        area: fact.area,
        risk: fact.risk,
        date: fact.date,
        confidence: fact.confidence,
        erpRef: fact.erpRef,
      })),
    });
  };

  const feedback = async (request, response, ctx) => {
    const body = await readJson(request);
    if (!isId(body.factId)) throw fail(400, 'invalid_request');
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 1000))
      throw fail(400, 'invalid_request');
    // Unreadable facts answer exactly like missing ones.
    const fact = store.facts.get(body.factId, ctx.scope);
    if (!fact) throw fail(404, 'fact_not_found');
    const authoritative = ctx.can(fact.areaId);
    const weight = Math.min(10, Math.max(0, authoritative ? 10 : 3));
    store.feedback.vote(fact.id, ctx.identity.userId, weight, 'errado');
    if (authoritative) {
      store.facts.update(fact.id, { suspended: true }, ctx.identity.userId);
      store.log.add({ userId: ctx.identity.userId, action: 'suspend', factId: fact.id });
    }
    json(response, 200, { recorded: true, suspended: authoritative });
  };

  const me = (response, ctx) => {
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
        : ctx.memberships.filter((m) => m.level === 'gestor').map((m) => m.areaId),
    });
  };

  const peers = (response, ctx) => {
    const byUser = new Map();
    for (const mine of ctx.memberships) {
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
    json(response, 200, { facts });
  };

  const patchFact = async (request, response, ctx, id) => {
    const body = await readJson(request);
    const current = store.facts.get(id);
    // Facts outside the caller's managed areas look nonexistent.
    if (!current || !ctx.can(current.areaId)) throw fail(404, 'fact_not_found');
    const allowed = ['text', 'areaId', 'risk', 'active', 'suspended', 'general'];
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.includes(key) || value === null) throw fail(400, 'invalid_request');
    }
    const patch = {};
    if (body.text !== undefined) {
      if (!isText(body.text, FACT_TEXT_MAX)) throw fail(400, 'invalid_request');
      if (findSecrets(body.text).length > 0) throw fail(400, 'secret');
      patch.text = body.text;
    }
    for (const key of ['active', 'suspended']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') throw fail(400, 'invalid_request');
      patch[key] = body[key];
    }
    if (body.risk !== undefined) {
      if (!['low', 'high'].includes(body.risk)) throw fail(400, 'invalid_request');
      patch.risk = body.risk;
    }
    if (body.areaId !== undefined) {
      if (!isId(body.areaId)) throw fail(400, 'invalid_request');
      patch.areaId = body.areaId;
    }
    let promoting = false;
    if (body.general !== undefined) {
      if (body.general !== true) throw fail(400, 'invalid_request');
      if (patch.areaId !== undefined && patch.areaId !== generalId()) throw fail(400, 'invalid_request');
      patch.areaId = generalId();
      promoting = patch.areaId !== current.areaId;
    }
    if (promoting && (current.risk !== 'low' || patch.risk === 'high')) throw fail(400, 'promote_requires_low');

    const movesArea = patch.areaId !== undefined && patch.areaId !== current.areaId;
    const changesRisk = patch.risk !== undefined && patch.risk !== current.risk;
    if (movesArea || changesRisk) {
      // Source access was checked above. Sharing a low fact to Geral is the one move where
      // the target is open to any manager of the source area; every other target needs management.
      if (movesArea && !promoting && !ctx.can(patch.areaId)) throw fail(403, 'forbidden');
      if (store.facts.history(id).length > 1) throw fail(409, 'in_supersession_chain');
    }
    const updated = store.facts.update(id, patch, ctx.identity.userId);
    store.log.add({ userId: ctx.identity.userId, action: 'update_fact', factId: id });
    ctx.logHigh([updated]);
    json(response, 200, { fact: updated });
  };

  const factHistory = (response, ctx, id) => {
    const current = store.facts.get(id);
    if (!current || !ctx.can(current.areaId)) throw fail(404, 'fact_not_found');
    const history = store.facts.history(id, ctx.managed());
    ctx.logHigh(history);
    json(response, 200, { history });
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

  let closing;
  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 15_000 },
    (request, response) => {
      void (async () => {
        if (closing) throw fail(503, 'service_unavailable');
        const url = new URL(request.url ?? '/', 'http://brain.internal');
        const path = url.pathname;
        const method = request.method;
        if (method === 'GET' && path === '/health') return json(response, 200, { status: 'ok' });
        if (!secretMatches(secret, request.headers['x-brain-secret'])) throw fail(401, 'unauthorized');
        const ctx = context(identityOf(request));
        if (method === 'POST' && path === '/capture') return capture(request, response, ctx);
        if (method === 'POST' && path === '/search') return search(request, response, ctx);
        if (method === 'POST' && path === '/feedback') return feedback(request, response, ctx);
        if (method === 'GET' && path === '/me') return me(response, ctx);
        if (method === 'GET' && path === '/peers') return peers(response, ctx);
        if (path === '/consent' && (method === 'GET' || method === 'POST')) return consent(request, response, ctx);
        if (path.startsWith('/manage/')) return manage(request, response, ctx, url, path);
        throw fail(404, 'not_found');
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
        await curator.drain();
        store.close();
      })();
      return closing;
    },
  };
}
