import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startControl } from '../support.mjs';
import { parseStrataConfiguration } from '../../../../../services/control/strata/config.mjs';
import { discover } from '../../../../../services/control/strata/protocol.mjs';
import { assertNoTokenPlaintext, CLIENT_ID, CLIENT_SECRET, ENCRYPTION_KEY, fixture } from './fixture.mjs';

function scopeDiscovery({ scopes, issuerScopes, resourceScopes = ['mcp:identidade'] }) {
  const config = { resourceUrl: 'https://erp.example/mcp', issuer: 'https://auth.example', scopes };
  return discover(config, async (url) =>
    Response.json(
      new URL(url).origin === 'https://erp.example'
        ? {
            resource: config.resourceUrl,
            authorization_servers: [config.issuer],
            scopes_supported: resourceScopes,
          }
        : {
            issuer: config.issuer,
            authorization_endpoint: `${config.issuer}/oauth/authorize`,
            token_endpoint: `${config.issuer}/oauth/token`,
            code_challenge_methods_supported: ['S256'],
            response_types_supported: ['code'],
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
            scopes_supported: issuerScopes,
          }
    )
  );
}

test('offline_access is accepted from the issuer without being an ERP resource scope', async () => {
  assert.deepEqual(
    await scopeDiscovery({
      scopes: ['mcp:identidade', 'offline_access'],
      issuerScopes: ['offline_access'],
    }),
    {
      authorizationEndpoint: 'https://auth.example/oauth/authorize',
      tokenEndpoint: 'https://auth.example/oauth/token',
    }
  );
});

test('offline_access requires an explicit issuer scopes array even if the resource advertises it', async () => {
  await Promise.all(
    [undefined, [], ['openid'], 'offline_access'].map((issuerScopes) =>
      assert.rejects(
        scopeDiscovery({
          scopes: ['mcp:identidade', 'offline_access'],
          resourceScopes: ['mcp:identidade', 'offline_access'],
          issuerScopes,
        }),
        { code: 'strata_invalid_metadata' }
      )
    )
  );
});

test('issuer-only scopes other than offline_access cannot bypass ERP resource scope validation', async () => {
  await assert.rejects(
    scopeDiscovery({
      scopes: ['mcp:identidade', 'email'],
      issuerScopes: ['email', 'offline_access'],
    }),
    { code: 'strata_invalid_metadata' }
  );
});

test('offline_access support does not grant an unadvertised MCP permission', async () => {
  await assert.rejects(
    scopeDiscovery({
      scopes: ['mcp:identidade', 'mcp:compras:alterar', 'offline_access'],
      issuerScopes: ['offline_access', 'mcp:compras:alterar'],
    }),
    { code: 'strata_invalid_metadata' }
  );
});

test('unconfigured Strata reports its status without exposing configuration or accepting anonymous connection', async (t) => {
  const app = await startControl(t);
  const owner = await app.login();
  const status = await app.request('/strata/status', { token: owner.token });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).configured, false);
  assert.equal((await app.request('/strata/connect', { method: 'POST', body: {} })).status, 401);
});

test('the public callback reports missing Strata configuration without requiring a JR session', async (t) => {
  const app = await startControl(t);
  const response = await app.request('/strata/callback');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'strata_unconfigured');
});

test('an anonymous callback without valid state rejects before contacting the OAuth provider', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(
    ['/strata/callback', '/strata/callback?code=untrusted-code'].map(async (path) => {
      const response = await f.app.request(path);
      return { status: response.status, code: (await response.json()).error.code };
    })
  );
  assert.deepEqual(
    responses,
    Array.from({ length: 2 }, () => ({ status: 400, code: 'strata_invalid_state' }))
  );
  assert.deepEqual(f.erp.seen, []);
  assert.equal(f.erp.state.exchangeCalls, 0);
});

test('the public callback exception does not open other Strata routes or callback methods', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(
    [
      ['/strata/status', 'GET'],
      ['/strata/connect', 'POST'],
      ['/strata/callback', 'POST'],
      ['/strata/callback/', 'GET'],
    ].map(async ([path, method]) => {
      const response = await f.app.request(path, { method });
      return { status: response.status, code: (await response.json()).error.code };
    })
  );
  assert.deepEqual(
    responses,
    Array.from({ length: 4 }, () => ({ status: 401, code: 'invalid_session' }))
  );
  assert.deepEqual(f.erp.seen, []);
});

test('OAuth account proof, not matching display names, determines the linked ERP ID', async (t) => {
  const f = await fixture(t);
  const status = await f.link(f.owner, { select: false });
  assert.equal(status.erpUser.id, 'erp-a');
  assert.equal(status.linked, true);
  assert.equal(status.organizationId, null);
});

test('authorization, code exchange and refresh bind the token to the configured MCP resource', async (t) => {
  const f = await fixture(t);
  const started = await f.connect();
  assert.equal(new URL(started.authorizationUrl).searchParams.get('resource'), `${f.erp.baseUrl}/mcp`);
  await f.link();
  f.advance(121_000);
  assert.equal((await f.app.request('/strata/status', { token: f.owner.token })).status, 200);
  assert.deepEqual(
    f.erp.seen
      .filter((request) => request.path === '/oauth/token')
      .map((request) => {
        const form = new URLSearchParams(request.raw);
        return [form.get('grant_type'), form.get('resource')];
      }),
    [
      ['authorization_code', `${f.erp.baseUrl}/mcp`],
      ['refresh_token', `${f.erp.baseUrl}/mcp`],
    ]
  );
});

test('organization selection only accepts memberships confirmed by ERP', async (t) => {
  const f = await fixture(t);
  await f.link();
  const response = await f.app.request('/strata/organization', {
    method: 'POST',
    token: f.owner.token,
    body: { organizationId: 'org-foreign' },
  });
  assert.equal(response.status, 403);
  const status = await (await f.app.request('/strata/status', { token: f.owner.token })).json();
  assert.equal(status.organizationId, 'org-a');
});

test('an authorization callback is tied to its original JR session, not another bearer supplied to the callback', async (t) => {
  const f = await fixture(t);
  const invitation = await f.app.invite(f.owner.token, 'Same fixture name');
  const other = await f.app.login(invitation.code, 'other');
  const started = await f.connect();
  const callback = await f.callbackFor(started);
  const completed = await f.app.request(callback, { token: other.token });
  assert.equal(completed.status, 200);
  assert.equal((await (await f.app.request('/strata/status', { token: other.token })).json()).linked, false);
  assert.equal((await (await f.app.request('/strata/status', { token: f.owner.token })).json()).erpUser.id, 'erp-a');
});

test('the authorization state is single-use and does not exchange a code twice', async (t) => {
  const f = await fixture(t);
  const callback = await f.callbackFor(await f.connect());
  assert.equal((await f.app.request(callback)).status, 200);
  assert.ok((await f.app.request(callback)).status >= 400);
  assert.equal(f.erp.state.exchangeCalls, 1);
});

test('expired authorization cannot create a linked account', async (t) => {
  const f = await fixture(t);
  const callback = await f.callbackFor(await f.connect());
  f.advance(11 * 60_000);
  assert.ok((await f.app.request(callback)).status >= 400);
  assert.equal((await (await f.app.request('/strata/status', { token: f.owner.token })).json()).linked, false);
  assert.equal(f.erp.state.exchangeCalls, 0);
});

test('logging out invalidates pending OAuth state before token exchange', async (t) => {
  const f = await fixture(t);
  const callback = await f.callbackFor(await f.connect());
  await f.app.request('/auth/logout', { method: 'POST', token: f.owner.token });
  assert.ok((await f.app.request(callback)).status >= 400);
  assert.equal(f.erp.state.exchangeCalls, 0);
});

test('disconnect cancels pending authorization instead of letting its callback restore the link', async (t) => {
  const f = await fixture(t);
  const callback = await f.callbackFor(await f.connect());
  assert.equal(
    (await f.app.request('/strata/disconnect', { method: 'POST', token: f.owner.token, body: {} })).status,
    200
  );
  assert.ok((await f.app.request(callback)).status >= 400);
  assert.equal((await (await f.app.request('/strata/status', { token: f.owner.token })).json()).linked, false);
});

test('a mismatch between linked ERP account and MCP identity refuses the connection', async (t) => {
  const f = await fixture(t);
  f.erp.state.mismatchIdentity = true;
  const callback = await f.callbackFor(await f.connect());
  assert.ok((await f.app.request(callback)).status >= 400);
  assert.equal((await (await f.app.request('/strata/status', { token: f.owner.token })).json()).linked, false);
});

test('access and refresh tokens stay out of public responses and persisted plaintext', async (t) => {
  const f = await fixture(t);
  const status = await f.link();
  const serialized = JSON.stringify(status);
  for (const token of f.erp.tokens) assert.equal(serialized.includes(token), false);
  await assertNoTokenPlaintext(f.app.directory, f.erp.tokens);
});

test('an unavailable identity service does not return a stale permitted account as current', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.state.unavailable = true;
  const status = await f.app.request('/strata/status', { token: f.owner.token });
  const body = await status.text();
  assert.ok(status.status >= 400);
  assert.equal(body.includes('Same fixture name'), false);
  assert.equal(body.includes('erp-a'), false);
});

test('a second JR employee cannot take over an ERP identity already linked to another JR employee', async (t) => {
  const f = await fixture(t);
  await f.link();
  const invitation = await f.app.invite(f.owner.token);
  const other = await f.app.login(invitation.code, 'other');
  const callback = await f.callbackFor(await f.connect(other));
  assert.equal((await f.app.request(callback)).status, 409);
  assert.equal((await (await f.app.request('/strata/status', { token: other.token })).json()).linked, false);
  assert.equal((await (await f.app.request('/strata/status', { token: f.owner.token })).json()).erpUser.id, 'erp-a');
});

test('discovery refuses an authorization endpoint outside the configured issuer origin', async (t) => {
  const f = await fixture(t);
  f.erp.state.invalidMetadataEndpoint = true;
  const response = await f.app.request('/strata/connect', { method: 'POST', token: f.owner.token, body: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('untrusted-authorize'), false);
});

test('token exchange does not follow provider redirects with client credentials', async (t) => {
  const f = await fixture(t);
  const callback = await f.callbackFor(await f.connect());
  f.erp.state.tokenRedirect = true;
  assert.equal((await f.app.request(callback)).status, 503);
  assert.equal(
    f.erp.seen.some((entry) => entry.path === '/redirect-target'),
    false
  );
});

test('credential ciphertext cannot be transplanted to another JR account', async (t) => {
  const f = await fixture(t);
  await f.link();
  const invitation = await f.app.invite(f.owner.token);
  const other = await f.app.login(invitation.code, 'other');
  f.erp.state.loginId = 'erp-b';
  await f.link(other);
  const db = new DatabaseSync(join(f.app.directory, 'control.sqlite'));
  try {
    const grant = db.prepare('SELECT encrypted_grant FROM strata_links WHERE user_id = ?').get(f.owner.user.id);
    db.prepare('UPDATE strata_links SET encrypted_grant = ? WHERE user_id = ?').run(
      grant.encrypted_grant,
      other.user.id
    );
  } finally {
    db.close();
  }
  const response = await f.app.request('/strata/status', { token: other.token });
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes('fixture-access-'), false);
});

test('configuration rejects unsafe URLs and malformed keys without reflecting credentials', () => {
  const valid = {
    resourceUrl: 'https://erp.example/mcp',
    issuer: 'https://auth.example',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: 'https://jr.example/bot/strata/callback',
    encryptionKey: ENCRYPTION_KEY,
  };
  for (const patch of [
    { resourceUrl: 'http://erp.example/mcp' },
    { issuer: 'https://user:password@auth.example' },
    { redirectUri: 'https://jr.example/bot/strata/callback?target=elsewhere' },
    { encryptionKey: Buffer.alloc(31).toString('base64') },
    { clientSecret: `${CLIENT_SECRET}\n` },
  ])
    assert.throws(
      () => parseStrataConfiguration({ ...valid, ...patch }),
      (error) => error.code === 'strata_invalid_configuration' && !error.message.includes(CLIENT_SECRET)
    );
});

test('switching organization invalidates pending OAuth callbacks bound to the old organization context', async (t) => {
  const f = await fixture(t);
  await f.link();
  const callback = await f.callbackFor(await f.connect());
  assert.equal(
    (
      await f.app.request('/strata/organization', {
        method: 'POST',
        token: f.owner.token,
        body: { organizationId: 'org-b' },
      })
    ).status,
    200
  );
  assert.ok((await f.app.request(callback)).status >= 400);
  assert.equal(f.erp.state.exchangeCalls, 1);
});
