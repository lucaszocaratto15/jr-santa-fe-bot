import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectStrataTurn, strataStopMessage } from '../../../../../services/control/strata/loopGuard.mjs';
import { startControl } from '../support.mjs';

const turn = (...parts) => [{ role: 'user', content: 'Relatório de combustível' }, ...parts.flat(2)];
const query = (id, args = { id: 'frota.consumo-combustivel' }, output = { result: { data: [] } }) => [
  {
    role: 'assistant',
    tool_calls: [
      { id, type: 'function', function: { name: 'strata_consultas_executar', arguments: JSON.stringify(args) } },
    ],
  },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(output) },
];

test('stops an exact repeated query even when argument keys change order', () => {
  const result = inspectStrataTurn(turn(query('a', { id: 'x', offset: 0 }), query('b', { offset: 0, id: 'x' })));
  assert.equal(result.reason, 'repeated_query');
});

test('different pages and a fresh user message do not reuse an earlier stop', () => {
  assert.equal(inspectStrataTurn(turn(query('a', { id: 'x', offset: 0 }), query('b', { id: 'x', offset: 20 }))), null);
  assert.equal(inspectStrataTurn([...turn(query('a'), query('b')), ...turn(query('c'))]), null);
});

test('throttling and revoked permission stop before terminal or browser fallback', () => {
  for (const error of ['strata_rate_limited', 'strata_reconnect_required', 'permission_denied']) {
    assert.equal(inspectStrataTurn(turn(query('a', {}, { ok: false, error }))).reason, error);
  }
});

test('two failed reads terminate but one corrected invalid request can proceed', () => {
  assert.equal(
    inspectStrataTurn(turn(query('a', { id: 'a' }, { error: 'invalid_payload' }), query('b', { id: 'b' }))),
    null
  );
  assert.equal(
    inspectStrataTurn(
      turn(
        query('a', { id: 'a' }, { error: 'strata_unavailable' }),
        query('b', { id: 'b' }, { error: 'strata_unavailable' })
      )
    ).reason,
    'repeated_failure'
  );
});

test('limits a read turn without blocking non-ERP tools or treating record text as an error', () => {
  assert.equal(
    inspectStrataTurn(turn(Array.from({ length: 12 }, (_, i) => query(String(i), { id: String(i) })))).reason,
    'read_budget'
  );
  assert.equal(inspectStrataTurn(turn(query('a', {}, { result: { error: 'strata_rate_limited' } }))), null);
  assert.equal(
    inspectStrataTurn(
      turn(
        { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'Read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'a', content: '{"error":"strata_rate_limited"}' }
      )
    ),
    null
  );
});

test('recognizes the legacy MCP wrapper and preserves an already confirmed complete summary', () => {
  const messages = turn(
    query(
      'a',
      {},
      { operation: 'frota.consumo-combustivel', summary: { complete: true, totalLiters: 12.3, records: 2 } }
    ),
    query('b', {}, { content: [{ type: 'text', text: '{"error":"strata_rate_limited"}' }] })
  );
  const stop = inspectStrataTurn(messages);
  assert.match(strataStopMessage(stop), /12,3 litros em 2 registros/);
  assert.match(strataStopMessage(stop), /Não concluí todas as etapas/);
});

test('preserves legacy MCP isError even when the inner text has no error code', () => {
  const failed = { isError: true, content: [{ type: 'text', text: '{"message":"unavailable"}' }] };
  assert.equal(
    inspectStrataTurn(turn(query('a', { id: 'a' }, failed), query('b', { id: 'b' }, failed))).reason,
    'repeated_failure'
  );
});

for (const stream of [false, true])
  test(`a stopped read returns a final answer without another model request (stream=${stream})`, async (t) => {
    const app = await startControl(t, { upstreamFetch: () => assert.fail('loop requested another paid model round') });
    const user = await app.login();
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      token: user.token,
      body: { stream, messages: turn(query('a'), query('b')) },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /"finish_reason":"stop"/);
    assert.doesNotMatch(text, /"tool_calls"/);
  });

test('routine M3.1 requests use low reasoning but preserve an explicit supported choice', async (t) => {
  const choices = [];
  const app = await startControl(t, {
    model: 'MiniMax-M3.1-Flash',
    upstreamFetch: async (_url, options) => {
      choices.push(JSON.parse(options.body).reasoning_effort);
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    },
  });
  const user = await app.login();
  for (const reasoning_effort of [undefined, 'none', 'high']) {
    await app.request('/v1/chat/completions', {
      method: 'POST',
      token: user.token,
      body: { messages: turn(), reasoning_effort },
    });
  }
  assert.deepEqual(choices, ['low', 'low', 'high']);
});
