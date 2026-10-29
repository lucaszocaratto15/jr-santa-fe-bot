import { createServer } from 'node:http';
import { handleHandbook } from './handbook.mjs';
import { createModelProxy } from './proxy.mjs';
import { createStore } from './store.mjs';
import { httpError, isHttpError, textField, validateConfiguration } from './validation.mjs';

const json = (response, status, body) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
};

async function readJson(request, limit) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw httpError(400, 'invalid_request');
  if (request.headers['content-encoding']) throw httpError(400, 'invalid_request');
  if (Number(request.headers['content-length'] ?? 0) > limit) throw httpError(413, 'request_too_large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw httpError(413, 'request_too_large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(400, 'invalid_request');
  }
}

/** Create the local-only control service; the caller owns listening and shutdown. */
export function createControlServer(options = {}) {
  const config = validateConfiguration(options);
  const now = config.now ?? Date.now;
  const store = createStore({ ...config, now });
  const proxy = createModelProxy({ ...config, store, now });
  const loginAttempts = new Map();
  const rateLimitLogin = (address) => {
    const timestamp = now();
    for (const [key, entry] of loginAttempts) {
      if (entry.expiresAt <= timestamp) loginAttempts.delete(key);
    }
    if (!loginAttempts.has(address) && loginAttempts.size >= 10_000) throw httpError(429, 'rate_limited');
    const entry = loginAttempts.get(address) ?? { count: 0, expiresAt: timestamp + 60_000 };
    entry.count += 1;
    loginAttempts.set(address, entry);
    if (entry.count > 60) throw httpError(429, 'rate_limited');
  };
  const authenticate = (request) => {
    const match = /^Bearer ([a-zA-Z0-9_-]{43})$/u.exec(request.headers.authorization ?? '');
    const session = match ? store.session(match[1]) : null;
    if (!session) throw httpError(401, 'invalid_session');
    if (session.denied === 'employee_blocked') throw httpError(403, 'employee_blocked');
    if (session.denied === 'outside_access_hours') throw httpError(403, 'outside_access_hours');
    return session;
  };
  let closing;
  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 15_000 },
    (request, response) => {
      void (async () => {
        if (closing) throw httpError(503, 'service_unavailable');
        const path = request.url?.split('?')[0];
        if (request.method === 'GET' && path === '/health') return json(response, 200, { status: 'ok' });
        if (request.method === 'POST' && path === '/auth/login') {
          rateLimitLogin(request.socket.remoteAddress ?? 'unknown');
          const body = await readJson(request, 16_384);
          const login = {
            code: textField(body.code, 1, 256),
            deviceId: textField(body.deviceId, 8, 128),
            deviceName: textField(body.deviceName, 1, 120),
            ...(body.employeeId === undefined ? {} : { employeeId: textField(body.employeeId, 1, 128) }),
          };
          return json(response, 200, store.login(login));
        }
        const session = authenticate(request);
        if (request.method === 'GET' && path === '/auth/session') return json(response, 200, { user: session.user });
        if (request.method === 'POST' && path === '/auth/logout') {
          store.logout(session.sessionHash);
          proxy.revokeSession(session.sessionHash);
          return json(response, 200, { loggedOut: true });
        }
        if (
          await handleHandbook({
            request,
            response,
            path,
            session,
            store: store.handbook,
            readJson,
            json,
            httpError,
            reauth: authenticate,
          })
        )
          return;
        if (path?.startsWith('/admin/')) {
          if (session.user.role !== 'admin') throw httpError(403, 'forbidden');
          if (request.method === 'GET' && path === '/admin/employees')
            return json(response, 200, { employees: store.employees() });
          if (request.method === 'POST' && path === '/admin/invites') {
            const body = await readJson(request, 16_384);
            authenticate(request);
            return json(response, 201, store.invite(textField(body.name, 1, 120), body));
          }
          const employee = /^\/admin\/employees\/([a-zA-Z0-9-]{1,64})\/(revoke|invite|block|policy|title)$/u.exec(path);
          if (request.method === 'POST' && employee) {
            if (employee[2] === 'invite') return json(response, 201, store.renewInvite(employee[1]));
            if (employee[2] === 'revoke') {
              store.revoke(employee[1]);
              proxy.revokeUser(employee[1]);
              return json(response, 200, { revoked: true });
            }
            const body = await readJson(request, 16_384);
            authenticate(request);
            if (employee[2] === 'title') return json(response, 200, store.setTitle(employee[1], body.title));
            if (employee[2] === 'block') {
              const result = store.setBlocked(employee[1], body.blocked);
              if (result.blocked) proxy.revokeUser(employee[1]);
              return json(response, 200, result);
            }
            const result = store.updatePolicy(employee[1], body);
            proxy.revokeUser(employee[1]);
            return json(response, 200, result);
          }
        }
        if (request.method === 'GET' && path === '/usage')
          return json(response, 200, {
            model: config.model,
            usage: store.usage(session.user.id),
            ...(proxy.usingFallback() ? { fallback: true } : {}),
          });
        if (request.method === 'GET' && path === '/v1/models')
          return json(response, 200, { object: 'list', data: [{ id: config.model, object: 'model', owned_by: 'jr' }] });
        if (request.method === 'POST' && path === '/v1/chat/completions') {
          await proxy.handle(request, response, session, async () => {
            const body = await readJson(request, 16 * 1024 * 1024);
            authenticate(request);
            return body;
          });
          return;
        }
        throw httpError(404, 'not_found');
      })().catch((error) => {
        if (response.headersSent || response.destroyed) return response.destroy();
        const known = isHttpError(error);
        json(response, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error' } });
      });
    }
  );
  server.keepAliveTimeout = 5_000;
  return {
    server,
    close() {
      closing ??= (async () => {
        const stopping = proxy.close();
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
        }
        await stopping;
        store.close();
      })();
      return closing;
    },
  };
}
