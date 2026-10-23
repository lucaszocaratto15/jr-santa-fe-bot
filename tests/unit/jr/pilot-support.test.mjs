import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadProvider,
  verifyArtifact,
  startRelay,
  parseProviderConfig,
  probeHealth,
} from '../../../scripts/jr/pilot-support.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const key = 'test-only-not-a-real-credential';
const providerConfig = (baseURL = 'https://jrsantafe.stratacerta.com.br/mmx/v1', apiKey = key) => ({
  provider: { 'jr-minimax': { options: { baseURL, apiKey }, models: { 'MiniMax-M3.1-Flash': {} } } },
});

test('malformed configuration never exposes any part of its content', () => {
  let failure;
  try {
    parseProviderConfig('{"apiKey":TEST_SECRET_VALUE}');
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.message, 'JR provider configuration is not valid JSON');
  assert.equal(String(failure).includes('TEST_'), false);
});

test('a health endpoint accepting connections without responding times out', { timeout: 1500 }, async (t) => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(() => probeHealth(`http://127.0.0.1:${server.address().port}`, 50), /timeout|aborted/i);
});

test('loads only the explicitly configured JR MiniMax provider', () => {
  const result = loadProvider(providerConfig());
  assert.equal(result.model, 'MiniMax-M3.1-Flash');
  assert.equal(result.key, key);
  assert.equal(result.baseURL, 'https://jrsantafe.stratacerta.com.br/mmx/v1');
});

test('missing or unresolved credentials fail without including credential content', () => {
  assert.throws(() => loadProvider(providerConfig(undefined, '')), /credential/i);
  assert.throws(() => loadProvider(providerConfig(undefined, '{env:MINIMAX_API_KEY}')), /credential/i);
  assert.throws(() => loadProvider({}), /provider/i);
});

test('rejects credential forwarding to another host or URL carrying hidden destinations', () => {
  for (const address of [
    'http://jrsantafe.stratacerta.com.br/mmx/v1',
    'https://example.com/mmx/v1',
    'https://user:pass@jrsantafe.stratacerta.com.br/mmx/v1',
    'https://jrsantafe.stratacerta.com.br/mmx/v1?target=other',
  ]) {
    assert.throws(() => loadProvider(providerConfig(address)), /gateway/i);
  }
});

test('requires an actual artifact with the expected marker and computed sum', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'jr-artifact-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await assert.rejects(() => verifyArtifact(workspace, 'nonce', 450), /artifact/i);
  await writeFile(join(workspace, 'resultado.json'), JSON.stringify({ marker: 'wrong', total: 450 }));
  await assert.rejects(() => verifyArtifact(workspace, 'nonce', 450), /marker/i);
  await writeFile(join(workspace, 'resultado.json'), JSON.stringify({ marker: 'nonce', total: 449 }));
  await assert.rejects(() => verifyArtifact(workspace, 'nonce', 450), /total/i);
  await writeFile(join(workspace, 'resultado.json'), JSON.stringify({ marker: 'nonce', total: 450 }));
  assert.equal((await verifyArtifact(workspace, 'nonce', 450)).total, 450);
});

test('rejects a symlink artifact even when it contains the right result', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'jr-link-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'elsewhere.json'), JSON.stringify({ marker: 'nonce', total: 450 }));
  await symlink(join(workspace, 'elsewhere.json'), join(workspace, 'resultado.json'));
  await assert.rejects(() => verifyArtifact(workspace, 'nonce', 450), /regular|symlink/i);
});

test('loopback relay refuses unauthenticated requests before contacting the model', async (t) => {
  const relay = await startRelay(loadProvider(providerConfig()));
  t.after(() => relay.close());
  const response = await fetch(relay.url + '/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
  assert.equal(relay.metrics.requests, 0);
});

test('loopback relay exposes only model operations and does not echo its token', async (t) => {
  const relay = await startRelay(loadProvider(providerConfig()));
  t.after(() => relay.close());
  const response = await fetch(relay.url + '/untrusted', { headers: { Authorization: 'Bearer ' + relay.token } });
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes(relay.token), false);
});

test('a non-streaming model response records first text and usage', async (t) => {
  const relay = await startRelay(loadProvider(providerConfig()), {
    upstreamFetch: async () =>
      new Response(
        JSON.stringify({
          model: 'MiniMax-M3.1-Flash',
          choices: [{ message: { content: 'Olá' } }],
          usage: { total_tokens: 10 },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      ),
  });
  t.after(() => relay.close());
  const response = await fetch(relay.url + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + relay.token },
    body: JSON.stringify({ model: 'MiniMax-M3.1-Flash' }),
  });
  await response.json();
  assert.equal(typeof relay.metrics.calls[0].firstTextMs, 'number');
  assert.equal(relay.metrics.calls[0].usage.total_tokens, 10);
});

test('desktop usage endpoint requires its token and returns only reported counters', async (t) => {
  const relay = await startRelay(loadProvider(providerConfig()), {
    upstreamFetch: async () =>
      Response.json({
        model: 'MiniMax-M3.1-Flash',
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 80 } },
      }),
  });
  t.after(() => relay.close());
  assert.equal((await fetch(relay.url + '/jr/usage')).status, 401);
  const headers = { Authorization: 'Bearer ' + relay.token };
  assert.equal((await (await fetch(relay.url + '/jr/usage', { headers })).json()).usage, null);
  await (
    await fetch(relay.url + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'MiniMax-M3.1-Flash' }),
    })
  ).json();
  const status = await (await fetch(relay.url + '/jr/usage', { headers })).json();
  assert.equal(status.usage.promptTokens, 100);
  assert.equal(status.usage.completionTokens, 9);
  assert.equal(status.usage.cachedPromptTokens, 80);
  assert.equal(status.usage.modelRequests, 1);
  assert.equal(JSON.stringify(status).includes(relay.token), false);
  assert.equal(JSON.stringify(status).includes(key), false);
});

test('relay supplies Portuguese policy without changing commands or prior system rules', async (t) => {
  let forwarded;
  const relay = await startRelay(loadProvider(providerConfig()), {
    upstreamFetch: async (_url, options) => {
      forwarded = JSON.parse(options.body.toString());
      return Response.json({ choices: [{ message: { content: 'Pronto.' } }] });
    },
  });
  t.after(() => relay.close());
  const messages = [
    { role: 'system', content: 'Keep approval requirements.' },
    { role: 'user', content: 'Execute: node my-script.mjs --title="Hello"' },
  ];
  const result = await fetch(relay.url + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + relay.token },
    body: JSON.stringify({ model: 'MiniMax-M3.1-Flash', messages }),
  });
  assert.equal(result.status, 200);
  await result.text();
  assert.match(forwarded.messages[0].content, /português do Brasil/);
  assert.match(forwarded.messages[0].content, /Keep approval requirements\./);
  assert.deepEqual(forwarded.messages[1], messages[1]);
});
