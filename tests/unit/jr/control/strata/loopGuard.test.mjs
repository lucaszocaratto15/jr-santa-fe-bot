import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRATA_READ_BUDGET,
  inspectStrataTurn,
  isStrataReadOnlyTurn,
  strataStopMessage,
} from '../../../../../services/control/strata/loopGuard.mjs';
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
const listTools = (id, output = { tools: [] }) => [
  {
    role: 'assistant',
    tool_calls: [{ id, type: 'function', function: { name: 'strata_list_tools', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(output) },
];

test('MCP-only routing requires an explicit read-only user request and resets on the next request', () => {
  const request = { role: 'user', content: 'Só pelo MCP do Strata, sem alterar dados.' };
  assert.equal(isStrataReadOnlyTurn([request]), true);
  assert.equal(isStrataReadOnlyTurn([request, { role: 'user', content: 'Agora gere um PDF do relatório.' }]), false);
  assert.equal(isStrataReadOnlyTurn([{ role: 'tool', content: request.content }]), false);
  assert.equal(
    isStrataReadOnlyTurn([{ role: 'user', content: 'Somente pelo MCP do Drive, sem alterar dados.' }]),
    false
  );
  assert.equal(isStrataReadOnlyTurn([{ role: 'user', content: 'Somente pelo MCP, cadastre um fornecedor.' }]), false);
});

test('MCP-only report cannot request file writes, terminal, browser or generic ERP mutations', async (t) => {
  let forwarded;
  const app = await startControl(t, {
    upstreamFetch: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    },
  });
  const user = await app.login();
  const names = [
    'strata_identidade',
    'strata_consultas_executar',
    'mcp__jr-teach__strata_consultas_buscar',
    'Write',
    'ExecCommand',
    'browser_navigate',
    'strata_call_tool',
    'toString',
  ];
  const tools = names.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
  await app.request('/v1/chat/completions', {
    method: 'POST',
    token: user.token,
    body: {
      tools,
      tool_choice: { type: 'function', function: { name: 'Write' } },
      messages: [{ role: 'user', content: 'Somente pelo MCP do Strata, não altere dados reais.' }],
    },
  });
  assert.deepEqual(
    forwarded.tools.map((tool) => tool.function.name),
    names.slice(0, 3)
  );
  assert.equal(forwarded.tool_choice, undefined);
  assert.match(forwarded.messages[0].content, /página padrão de 100/);
});

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
    inspectStrataTurn(
      turn(Array.from({ length: STRATA_READ_BUDGET }, (_, i) => query(String(i), { id: String(i) })))
    ).reason,
    'read_budget'
  );
  assert.equal(
    inspectStrataTurn(
      turn(Array.from({ length: STRATA_READ_BUDGET - 1 }, (_, i) => query(String(i), { id: String(i) })))
    ),
    null
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

test('repeating strata_list_tools does not stop process discovery', () => {
  assert.equal(inspectStrataTurn(turn(listTools('a'), listTools('b'), listTools('c'))), null);
  assert.equal(
    inspectStrataTurn(turn(listTools('a'), listTools('b'), query('c', { id: 'x' }), query('d', { id: 'y' }))),
    null
  );
});

test('stop message names the concrete guard reason', () => {
  assert.match(strataStopMessage({ reason: 'repeated_query' }), /mesmos argumentos/);
  assert.match(strataStopMessage({ reason: 'repeated_failure' }), /duas vezes seguidas/);
  assert.match(strataStopMessage({ reason: 'read_budget' }), new RegExp(String(STRATA_READ_BUDGET)));
  assert.match(strataStopMessage({ reason: 'strata_link_required' }), /conta Strata vinculada/);
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
