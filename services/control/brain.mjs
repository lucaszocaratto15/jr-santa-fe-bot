/**
 * Forwards `/api/brain/*` to the internal jr-brain service. The brain trusts the identity headers only
 * because the shared secret proves the caller is this control service, so every `x-jr-*` / `x-brain-*`
 * header is built here from the authenticated session and no client header (except content-type) is
 * ever forwarded. Request and response bodies are never logged on this path.
 */
import { httpError } from './validation.mjs';
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const BRAIN_BODY_LIMIT = 256 * 1024;
/** Forwarded requests: a hung brain answers 503 quickly instead of holding the employee's request. */
export const BRAIN_TIMEOUT_MS = 4_000;
/** Explicit draft extraction may wait for the configured curator model timeout. */
export const BRAIN_PROPOSAL_TIMEOUT_MS = 65_000;
/** Legacy timeout retained for compatibility; peer-based handbook access is disabled. */
export const BRAIN_PEERS_TIMEOUT_MS = 2_000;
const PREFIX = '/api/brain';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Characters allowed in a forwarded path; dot segments are rejected separately. */
const SAFE_PATH = /^(?:\/[A-Za-z0-9._~%:@-]+)*\/?$/u;
const SAFE_HEADER = /^[\x20-\x7e]*$/u;
const PRINCIPAL_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;

/** Request-bound identity proof, never a grant of JR areas or an ERP bearer token. */
export function brainPrincipalProof(secret, identity, principal, method, path, body, now = Date.now) {
  if (
    !principal ||
    principal.jrUserId !== identity.id ||
    !PRINCIPAL_ID.test(principal.erpUserId ?? '') ||
    !PRINCIPAL_ID.test(principal.organizationId ?? '')
  )
    throw httpError(403, 'authorization_failed');
  const issuedAt = now();
  const payload = Buffer.from(
    JSON.stringify({
      v: principal.knowledgePolicy?.group ? 3 : principal.knowledgePolicy ? 2 : 1,
      jrUserId: identity.id,
      erpUserId: principal.erpUserId,
      organizationId: principal.organizationId,
      ...(principal.knowledgePolicy ? { knowledgePolicy: principal.knowledgePolicy } : {}),
      method,
      path,
      bodyHash: createHash('sha256')
        .update(body === undefined ? '' : JSON.stringify(body))
        .digest('hex'),
      issuedAt,
      expiresAt: issuedAt + 30_000,
      nonce: randomUUID(),
    })
  ).toString('base64url');
  if (payload.length > 48_000) throw httpError(403, 'authorization_failed');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

const hasDotSegment = (path) =>
  path.split('/').some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\');
  });

/** Brain header values must be plain ASCII; accented titles are percent-encoded. */
const headerValue = (value) => (SAFE_HEADER.test(value) ? value : encodeURIComponent(value));

/**
 * Call the brain on behalf of `identity` ({ id, role, title }). `path` includes any query string and
 * starts with `/`. Returns `{ status, body }` with the brain's own status and parsed JSON (null when
 * empty). Unreachable, timed out or non-JSON replies become a 503 `brain_unavailable`. A brain 401
 * only means the shared secret is wrong (a deployment fault, not the employee's session), so it
 * becomes a 502 `brain_unavailable` and the desktop never reads it as an invalid session.
 */
export async function brainRequest(
  config,
  identity,
  method,
  path,
  body,
  brainFetch = fetch,
  timeoutMs = BRAIN_TIMEOUT_MS,
  principal
) {
  if (!config?.brain) throw httpError(404, 'not_found');
  if (identity?.id === 'curator') throw httpError(403, 'forbidden');
  const headers = {
    'x-brain-secret': config.brain.secret,
    'x-jr-user-id': headerValue(String(identity.id)),
    'x-jr-role': headerValue(String(identity.role)),
  };
  if (identity.title) headers['x-jr-title'] = headerValue(String(identity.title));
  if (principal)
    headers['x-brain-erp-context'] = brainPrincipalProof(config.brain.secret, identity, principal, method, path, body);
  if (body !== undefined) headers['content-type'] = 'application/json';
  let result;
  try {
    const reply = await brainFetch(`${config.brain.url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      principal?.knowledgePolicy &&
      reply.ok &&
      (reply.headers.get('x-brain-authorization') !== (principal.knowledgePolicy.group ? 'erp-v3' : 'erp-v2') ||
        (principal.knowledgePolicy.group &&
          reply.headers.get('x-brain-group') !== principal.knowledgePolicy.group.id) ||
        reply.headers.get('x-brain-organization') !== principal.organizationId)
    ) {
      await reply.body?.cancel();
      throw httpError(503, 'brain_unavailable');
    }
    const text = await reply.text();
    result = { status: reply.status, body: text ? JSON.parse(text) : null };
  } catch {
    throw httpError(503, 'brain_unavailable');
  }
  if (result.status === 401) throw httpError(502, 'brain_unavailable');
  return result;
}

/** Handle `/api/brain/*`; returns true when the request was answered. */
export async function handleBrain({
  request,
  response,
  session,
  config,
  readJson,
  json,
  reauth,
  brainFetch,
  resolvePrincipal,
}) {
  const url = request.url ?? '';
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (!config.brain) throw httpError(404, 'not_found');
  const rest = path.slice(PREFIX.length);
  const method = request.method ?? '';
  if (!METHODS.has(method)) throw httpError(405, 'method_not_allowed');
  if (!rest || !SAFE_PATH.test(rest) || hasDotSegment(rest)) throw httpError(404, 'not_found');
  if (session.user.id === 'curator') throw httpError(403, 'forbidden');
  const query = queryAt === -1 ? '' : url.slice(queryAt);
  let body;
  // The desktop client always sends a JSON content type, also on body-less GETs.
  if (method !== 'GET' && request.headers['content-type'] !== undefined) {
    body = await readJson(request, BRAIN_BODY_LIMIT);
    reauth(request);
  }
  const timeout = method === 'POST' && rest === '/proposals' ? BRAIN_PROPOSAL_TIMEOUT_MS : BRAIN_TIMEOUT_MS;
  let principal;
  if (resolvePrincipal && rest !== '/capture') {
    principal = await resolvePrincipal(session, method === 'POST' && ['/search', '/feedback'].includes(rest));
    reauth(request);
  }
  const result = await brainRequest(
    config,
    session.user,
    method,
    `${rest}${query}`,
    body,
    brainFetch,
    timeout,
    principal
  );
  reauth(request);
  await principal?.assertCurrent?.();
  if (result.body === null) {
    response.writeHead(result.status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end();
  } else json(response, result.status, result.body);
  return true;
}
