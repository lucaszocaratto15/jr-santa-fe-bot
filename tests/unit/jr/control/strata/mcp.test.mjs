import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixture.mjs';

const call = (f, input = { name: 'obras.listar', arguments: {} }, token = f.owner.token) =>
  f.app.request('/strata/mcp/call', { method: 'POST', token, body: input });

test('reuses initialization while checking current identity and permissions on every query', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.seen.length = 0;
  await Promise.all([call(f), call(f), call(f)]);
  assert.equal(
    f.erp.seen.filter((entry) => entry.path === '/mcp' && JSON.parse(entry.raw).method === 'initialize').length,
    0
  );
  assert.equal(f.erp.seen.filter((entry) => entry.path === '/mcp/vinculo').length, 3);
  f.erp.state.permissions = false;
  assert.equal((await (await call(f)).json()).isError, true);
});

test('reports ERP throttling as throttling without retrying or returning old results', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.state.rateLimited = true;
  f.erp.seen.length = 0;
  const response = await call(f);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: { code: 'strata_rate_limited' } });
  assert.equal(f.erp.seen.length, 1);
});

for (const select of [false, true])
  test(`group catalog spans all companies with stored selection ${select}`, async (t) => {
    const f = await fixture(t);
    await f.link(f.owner, { select });
    const tools = await f.app.request('/strata/mcp/tools', { token: f.owner.token });
    assert.equal(tools.status, 200);
    assert.ok((await tools.json()).tools.some((tool) => tool.name === 'erp.consultas.executar'));
    assert.equal((await call(f, { name: 'erp.quem_sou', arguments: {} })).status, 200);
    const response = await call(f, {
      name: 'erp.consultas.executar',
      arguments: { id: 'frota.consumo-combustivel', parameters: { de: '2026-01', ate: '2026-01' } },
    });
    assert.equal(response.status, 200);
    const result = JSON.parse((await response.json()).content[0].text);
    assert.deepEqual(result.organizations, ['org-a', 'org-b']);
    assert.equal(Object.hasOwn(result.parameters, 'organization_id'), false);
  });

test('group catalog refuses a caller-supplied organization override', async (t) => {
  const f = await fixture(t);
  await f.link();
  const response = await call(f, { name: 'erp.consultas.buscar', arguments: { organization_id: 'org-foreign' } });
  assert.equal(response.status, 400);
});

test('MCP calls require a linked individual account and never use another employees link', async (t) => {
  const f = await fixture(t);
  await f.link();
  const invitation = await f.app.invite(f.owner.token);
  const other = await f.app.login(invitation.code, 'other');
  assert.ok((await call(f, undefined, other.token)).status >= 400);
  assert.equal((await call(f)).status, 200);
});

test('each call uses the linked ERP identity and selected organization, not client headers', async (t) => {
  const f = await fixture(t);
  await f.link();
  const response = await fetch(`${f.app.baseUrl}/strata/mcp/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${f.owner.token}`, 'Content-Type': 'application/json', 'X-Erp-User-Id': 'erp-b' },
    body: JSON.stringify({ name: 'obras.listar', arguments: {} }),
  });
  assert.equal(response.status, 200);
  const delegated = f.erp.seen.findLast(
    (entry) => entry.path === '/mcp' && JSON.parse(entry.raw).params?.name === 'obras.listar'
  );
  assert.equal(delegated.headers['x-erp-user-id'], 'erp-a');
  assert.equal(JSON.parse(delegated.raw).params.arguments.organization_id, 'org-a');
});

test('any ERP-authorized company can be queried without changing the selected company', async (t) => {
  const f = await fixture(t);
  await f.link();
  const response = await call(f, { name: 'obras.listar', arguments: { organization_id: 'org-b' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).structuredContent.organization_id, 'org-b');
  assert.equal(
    (await (await f.app.request('/strata/status', { token: f.owner.token })).json()).organizationId,
    'org-a'
  );
});

test('a company removed from the ERP scope cannot use an earlier authorization', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.accounts.get('erp-a').organizations = ['org-a'];
  const response = await call(f, { name: 'obras.listar', arguments: { organization_id: 'org-b' } });
  assert.equal(response.status, 403);
});

test('an unauthorized organization argument cannot override the verified ERP scope', async (t) => {
  const f = await fixture(t);
  await f.link();
  const response = await call(f, { name: 'obras.listar', arguments: { organization_id: 'org-foreign' } });
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes('Allowed fixture project'), false);
});

test('listing a tool catalog is not permission to execute it', async (t) => {
  const f = await fixture(t);
  await f.link();
  const before = await (await f.app.request('/strata/mcp/tools', { token: f.owner.token })).json();
  assert.equal(
    before.tools.some((tool) => tool.name === 'obras.listar'),
    true
  );
  f.erp.state.permissions = false;
  const after = await (await f.app.request('/strata/mcp/tools', { token: f.owner.token })).json();
  assert.equal(
    after.tools.some((tool) => tool.name === 'obras.listar'),
    true
  );
  const result = await (await call(f)).json();
  assert.equal(result.isError, true);
});

test('revoked ERP tool access fails closed on a later call', async (t) => {
  const f = await fixture(t);
  await f.link();
  assert.equal((await call(f)).status, 200);
  f.erp.state.permissions = false;
  const response = await call(f);
  assert.ok(response.status >= 400 || (await response.clone().json()).isError === true);
  assert.equal((await response.text()).includes('Allowed fixture project'), false);
});

test('an unavailable ERP cannot return cached business content', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.state.unavailable = true;
  const response = await call(f);
  assert.ok(response.status >= 400);
  assert.equal((await response.text()).includes('Allowed fixture project'), false);
});

test('a disconnected account cannot invoke MCP even if its old access token is still valid upstream', async (t) => {
  const f = await fixture(t);
  await f.link();
  await f.app.request('/strata/disconnect', { method: 'POST', token: f.owner.token, body: {} });
  assert.ok((await call(f)).status >= 400);
});

test('bounded JSON and SSE MCP replies have the same permitted result', async (t) => {
  const f = await fixture(t);
  await f.link();
  const first = await (await call(f)).json();
  f.erp.state.useSse = true;
  const second = await (await call(f)).json();
  assert.deepEqual(second, first);
});

test('concurrent calls refresh an expired delegated token only once', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.state.refreshDelay = 50;
  f.advance(121_000);
  const replies = await Promise.all([call(f), call(f), call(f)]);
  assert.deepEqual(
    replies.map((response) => response.status),
    [200, 200, 200]
  );
  assert.equal(f.erp.state.refreshCalls, 1);
});

test('a mutation returns the ERP human-consent challenge without executing or following it', async (t) => {
  const f = await fixture(t);
  await f.link();
  const response = await call(f, { name: 'compras.criar', arguments: {} });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /aguardando_consentimento/);
  assert.equal(
    f.erp.seen.some((entry) => entry.path.startsWith('/mcp/consent/')),
    false
  );
  assert.equal(f.erp.state.mutationsExecuted, 0);
});

test('provider credentials reflected in tool content are redacted before returning to the agent', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.state.reflectToken = true;
  const response = await call(f);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(
    f.erp.tokens.some((token) => body.includes(token)),
    false
  );
  assert.equal(
    f.erp.tokens.some((token) => body.includes(Buffer.from(token).toString('base64'))),
    false
  );
});

test('disconnect during refresh cannot restore an old grant or release a business result', async (t) => {
  const f = await fixture(t);
  await f.link();
  const gate = f.erp.holdRefresh();
  f.advance(121_000);
  const pending = call(f);
  await gate.entered;
  assert.equal(f.erp.state.refreshCalls, 1);
  await f.app.request('/strata/disconnect', { method: 'POST', token: f.owner.token, body: {} });
  gate.release();
  const result = await pending;
  assert.ok(result.status >= 400);
  assert.equal((await (await f.app.request('/strata/status', { token: f.owner.token })).json()).linked, false);
});

test('an ERP authentication error does not revoke the separate JR session', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.state.invalidTokens = true;
  const response = await call(f);
  assert.equal(response.status, 403);
  assert.equal((await f.app.request('/auth/session', { token: f.owner.token })).status, 200);
});

test('oversized SSE tool content is rejected without returning the oversized payload', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.erp.state.useSse = true;
  f.erp.state.oversizeToolResult = true;
  const response = await call(f);
  assert.equal(response.status, 503);
  assert.ok((await response.text()).length < 1000);
});

test(
  'an organization switch blocks a tool result that started under the old organization',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t);
    await f.link();
    const gate = f.erp.holdTool();
    const pending = call(f);
    await gate.entered;
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
    gate.release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.text()).includes('Allowed fixture project'), false);
  }
);

test('an organization switch does not release a stale status response', { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  await f.link();
  const gate = f.erp.holdIdentity();
  const pending = f.app.request('/strata/status', { token: f.owner.token });
  await gate.entered;
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
  gate.release();
  assert.equal((await pending).status, 409);
});
