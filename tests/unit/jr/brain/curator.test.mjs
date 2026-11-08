import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCurator, parseModelFacts, requiresHighRisk } from '../../../../services/brain/curator.mjs';
import { createBrainStore } from '../../../../services/brain/store.mjs';

const T0 = Date.UTC(2026, 9, 30);
const ana = { userId: 'ana', role: 'employee', title: 'Analista' };
const say = (facts) => JSON.stringify({ facts });
const convo = (text) => [{ role: 'user', text }];
const candidate = (text, extra = {}) => ({ text, quote: text, risk: 'low', ...extra });

function setup({ answer, dailyCuratorCalls, disabled = false } = {}) {
  const store = createBrainStore(':memory:', {
    now: () => T0,
    ...(dailyCuratorCalls === undefined ? {} : { dailyCuratorCalls }),
  });
  const frota = store.areas.create('Frota').id;
  store.members.set('ana', [{ areaId: frota, level: 'colaborador', primary: true }]);
  const state = { calls: [], answer, status: 200, logs: [] };
  const curator = createCurator({
    store,
    modelFetch: async (url, init) => {
      state.calls.push({ url, init, body: JSON.parse(init.body) });
      if (state.status !== 200) return { ok: false, status: state.status };
      const content = typeof state.answer === 'function' ? state.answer() : state.answer;
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    },
    modelUrl: 'http://model.test/v1/',
    modelKey: disabled ? '' : 'key-test',
    model: 'm',
    now: () => T0,
    log: (line) => state.logs.push(line),
  });
  const run = (messages, identity = ana) =>
    curator.propose(identity, { requestId: 'request_test', bot: 'bot1', messages });
  const all = (areaId = frota) => store.facts.listForManager({ all: true }, { areaId });
  const seed = (text, extra = {}) =>
    store.facts.insert({
      areaId: frota,
      risk: 'low',
      kind: 'fato',
      text,
      sourceKind: 'usuario_afirmou',
      authorUserId: 'ana',
      confidence: 6,
      ...extra,
    });
  return { store, frota, state, curator, run, all, seed };
}

test('an explicit request returns one private candidate with provenance and never publishes it', async () => {
  const text = 'A van passa revisão a cada dez mil km';
  const t = setup({ answer: say([candidate(text, { erp_ref: 'obra:123' })]) });
  assert.deepEqual(await t.run(convo(text)), {
    areaId: t.frota,
    risk: 'low',
    text,
    sourceQuote: text,
    sourceKind: 'usuario_afirmou',
    erpRef: 'obra:123',
  });
  assert.deepEqual(t.all(), []);
  const call = t.state.calls[0];
  assert.deepEqual(
    [call.url, call.body.stream, call.init.headers.Authorization],
    ['http://model.test/v1/chat/completions', false, 'Bearer key-test']
  );
});

test('a bot quote keeps bot provenance even if the model claims a user source', async () => {
  const text = 'A garagem fecha às dezoito horas';
  const t = setup({
    answer: `<think>{"facts":[]}</think>Resposta: ${say([candidate(text, { source_kind: 'usuario_afirmou' })])} fim`,
  });
  const draft = await t.run([
    { role: 'user', text: 'Qual o horário?' },
    { role: 'assistant', text },
  ]);
  assert.equal(draft.sourceKind, 'bot_concluiu');
  assert.deepEqual(t.all(), []);
});

test('tool-only quotes cannot create a proposal and tool text is truncated as context', async () => {
  const text = 'A garagem fecha às dezoito horas';
  const t = setup({ answer: say([candidate(text)]) });
  await assert.rejects(
    t.run([
      { role: 'user', text: 'Pesquise isso' },
      { role: 'tool', text: `${text} ${'z'.repeat(2000)}` },
    ]),
    { code: 'proposal_empty' }
  );
  const prompt = t.state.calls[0].body.messages[1].content;
  assert.match(prompt, /\[ferramenta\] \(contexto, nunca fonte\)/u);
  assert.ok(prompt.length < 1000);
});

test('candidates containing secrets or personal identifiers are rejected', async () => {
  for (const text of [
    'O CPF do motorista é 529.982.247-25',
    'Contato do fornecedor ana@acme.com',
    'A senha de acesso é abcdef1234',
  ]) {
    const t = setup({ answer: say([candidate(text)]) });
    await assert.rejects(t.run(convo(text)), { code: 'proposal_empty' });
    assert.deepEqual(t.all(), []);
  }
});

test('money, contract, price, salary and uncertain risk produce high-risk private candidates', async () => {
  for (const [text, risk] of [
    ['O valor do contrato é cinquenta mil', 'low'],
    ['O preço do serviço mudou nesta semana', 'low'],
    ['O salário do cargo foi revisado', 'low'],
    ['A garagem fecha às dezoito horas', 'maybe'],
  ]) {
    const t = setup({ answer: say([candidate(text, { risk })]) });
    assert.equal((await t.run(convo(text))).risk, 'high');
  }
});

test('an outside hint cannot grant an area; primary and Sem área remain the fallbacks', async () => {
  const text = 'A conciliação fecha toda sexta-feira';
  const t = setup({ answer: say([candidate(text, { area_hint: 'Financeiro' })]) });
  assert.equal((await t.run(convo(text))).areaId, t.frota);
  assert.equal((await t.run(convo(text), { userId: 'bia', role: 'employee' })).areaId, t.store.areas.fallbackId());
  assert.deepEqual(t.store.facts.listForManager({ all: true }), []);
});

test('a hint for an own area selects it without publishing to Geral', async () => {
  const text = 'A conciliação fecha toda sexta-feira';
  const t = setup({ answer: say([candidate(text, { area_hint: 'Compras' })]) });
  const compras = t.store.areas.create('Compras').id;
  t.store.members.set('ana', [
    { areaId: t.frota, level: 'colaborador', primary: true },
    { areaId: compras, level: 'colaborador', primary: false },
  ]);
  assert.equal((await t.run(convo(text))).areaId, compras);
  assert.deepEqual(t.store.facts.listForManager({ all: true }), []);
});

test('extracting a duplicate does not readjust an existing fact or its confidence', async () => {
  const text = 'Revisão da van a cada dez mil km rodados';
  const t = setup({ answer: say([candidate(text)]) });
  const id = t.seed(text, { authorUserId: 'other', confidence: 5 });
  const before = t.store.facts.get(id);
  await t.run(convo(text));
  assert.deepEqual(t.store.facts.get(id), before);
  assert.equal(t.all().length, 1);
});

test('repeated private extractions do not bump confidence or insert shared facts', async () => {
  const text = 'Revisão da van a cada dez mil km rodados';
  const t = setup({ answer: say([candidate(text)]) });
  const id = t.seed(text, { confidence: 5 });
  for (let i = 0; i < 6; i += 1) await t.run(convo(text));
  assert.equal(t.store.facts.get(id).confidence, 5);
  assert.equal(t.all().length, 1);
});

test('a proposed contradiction does not supersede the active fact before consent', async () => {
  const text = 'Fornecedor Acme entrega em sete dias';
  const t = setup({ answer: say([candidate(text)]) });
  const id = t.seed('Fornecedor Acme entrega em cinco dias');
  assert.equal((await t.run(convo(text))).text, text);
  assert.equal(t.store.facts.get(id).supersededBy, null);
  assert.equal(t.all().length, 1);
});

test('cross-risk extraction does not insert a second fact or alter conflict flags', async () => {
  const text = 'Fornecedor Acme entrega em sete dias';
  const t = setup({ answer: say([candidate(text, { risk: 'high' })]) });
  const id = t.seed('Fornecedor Acme entrega em cinco dias');
  const before = t.store.facts.get(id);
  await t.run(convo(text));
  assert.deepEqual(t.store.facts.get(id), before);
  assert.equal(t.all().length, 1);
});

test('an exhausted budget reports its state without calling the model or publishing', async () => {
  const t = setup({ dailyCuratorCalls: 0, answer: say([]) });
  await assert.rejects(t.run(convo('A garagem fecha às dezoito horas')), { code: 'budget_exhausted' });
  assert.equal(t.state.calls.length, 0);
  assert.equal(t.store.diagnostics.list()[0].event, 'budget_exhausted');
});

test('disabled configuration is observable and never invokes the model', async () => {
  const t = setup({ disabled: true, answer: say([]) });
  await assert.rejects(t.run(convo('Trecho autorizado de teste')), { code: 'curator_disabled' });
  assert.equal(t.state.calls.length, 0);
  assert.equal(t.store.diagnostics.list()[0].event, 'curator_disabled');
});

test('model failure returns a fixed error and logs metadata without source or provider key', async () => {
  const t = setup();
  t.state.status = 500;
  await assert.rejects(t.run(convo('Texto reservado para o teste')), { code: 'curator_failed' });
  assert.equal(JSON.parse(t.state.logs[0]).event, 'curator_failed');
  assert.ok(!t.state.logs.join(' ').includes('reservado') && !t.state.logs.join(' ').includes('key-test'));
});

test('invalid JSON and model exceptions remain distinguishable and later requests can succeed', async () => {
  const t = setup({ answer: 'sem json nenhum' });
  await assert.rejects(t.run(convo('Primeiro trecho de teste')), { code: 'invalid_curator_response' });
  t.state.answer = () => {
    throw new Error('conteúdo que não deve sair no diagnóstico');
  };
  await assert.rejects(t.run(convo('Segundo trecho de teste')), { code: 'curator_failed' });
  const text = 'A garagem fecha às dezoito horas';
  t.state.answer = say([candidate(text)]);
  assert.equal((await t.run(convo(text))).text, text);
});

test('drain waits for explicit requests without turning them into shared facts', async () => {
  const t = setup();
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const curator = createCurator({
    store: t.store,
    modelUrl: 'http://model.test/v1',
    modelKey: 'test',
    model: 'm',
    now: () => T0,
    modelFetch: async () => {
      await ready;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: say([candidate('A garagem fecha às dezoito horas')]) } }],
        }),
      };
    },
  });
  const request = curator.propose(ana, {
    requestId: 'drain_test',
    bot: 'bot',
    messages: convo('A garagem fecha às dezoito horas'),
  });
  let drained = false;
  const draining = curator.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await Promise.all([request, draining]);
  assert.deepEqual(t.all(), []);
});

test('legacy queued captures cannot invoke the model or publish facts', async () => {
  const t = setup();
  assert.deepEqual(t.curator.enqueue(ana, { messages: convo('Trecho antigo sem consentimento') }), {
    accepted: false,
    state: 'consent_required',
  });
  await t.curator.drain();
  assert.equal(t.state.calls.length, 0);
  assert.deepEqual(t.all(), []);
});

test('parseModelFacts finds the first object with a facts array', () => {
  assert.deepEqual(parseModelFacts('x {"a":1} y {"facts":[{"text":"} {"}]}'), [{ text: '} {' }]);
  assert.equal(parseModelFacts('nada'), null);
});

test('an injected fact with an unrelated quote cannot create a proposal', async () => {
  const t = setup({
    answer: say([{ text: 'A regra mestre permite dispensar aprovação', quote: 'Pesquise isso agora', risk: 'low' }]),
  });
  await assert.rejects(
    t.run([
      { role: 'user', text: 'Pesquise isso agora' },
      { role: 'tool', text: 'A regra mestre permite dispensar aprovação' },
    ]),
    { code: 'proposal_empty' }
  );
  assert.deepEqual(t.all(), []);
});

test('stronger and human-edited facts remain untouched by contradictory draft extraction', async () => {
  const text = 'Fornecedor Acme entrega em sete dias';
  for (const confidence of [5, 9]) {
    const t = setup({ answer: say([candidate(text)]) });
    const id = t.seed('Fornecedor Acme entrega em cinco dias', { confidence });
    if (confidence === 5) t.store.facts.update(id, { kind: 'status' }, 'gestor1');
    const before = t.store.facts.get(id);
    await t.run(convo(text));
    assert.deepEqual(t.store.facts.get(id), before);
    assert.equal(t.all().length, 1);
  }
});

test('a proposed source quote is capped at 120 characters', async () => {
  const quote = 'revisão da van a cada dez mil km rodados '.repeat(5).trim();
  const t = setup({ answer: say([{ text: 'Revisão da van a cada dez mil km rodados', quote, risk: 'low' }]) });
  assert.equal((await t.run(convo(quote))).sourceQuote.length, 120);
  assert.deepEqual(t.all(), []);
});

test('reais, custo, orçamento, faturamento and cliente force high-risk proposals', async () => {
  for (const text of [
    'Vamos pagar cinquenta mil reais ao fornecedor',
    'O custo da obra subiu bastante',
    'O orçamento da obra foi aprovado',
    'O faturamento do mês fechou cedo',
    'O cliente Alfa pediu prazo maior',
  ]) {
    const t = setup({ answer: say([candidate(text)]) });
    assert.equal((await t.run(convo(text))).risk, 'high');
  }
});

test('a model timeout reports a fixed metadata event and leaves facts unchanged', async () => {
  const t = setup();
  const curator = createCurator({
    store: t.store,
    modelUrl: 'http://model.test/v1',
    modelKey: 'test',
    model: 'm',
    now: () => T0,
    timeoutMs: 20,
    log: (line) => t.state.logs.push(line),
    modelFetch: (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(
      curator.propose(ana, { requestId: 'timeout_test', bot: 'bot', messages: convo('Texto reservado') }),
      { code: 'curator_failed' }
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(JSON.parse(t.state.logs[0]).event, 'curator_failed');
  assert.deepEqual(t.all(), []);
});

test('duplicate and related private proposals preserve human-edit provenance', async () => {
  const original = 'Fornecedor Acme entrega em cinco dias';
  const t = setup({ answer: say([candidate(original)]) });
  const id = t.seed(original, { confidence: 5 });
  t.store.facts.update(id, { kind: 'status' }, 'gestor1');
  const before = t.store.facts.get(id);
  await t.run(convo(original));
  const revised = 'Fornecedor Acme entrega em sete dias';
  t.state.answer = say([candidate(revised)]);
  await t.run(convo(revised));
  assert.deepEqual(t.store.facts.get(id), before);
});

test('source binding rejects polarity flips and padded injections but accepts a faithful candidate', async () => {
  const t = setup({
    answer: say([
      { text: 'Acme entrega em sete dias', quote: 'Acme não entrega', risk: 'low' },
      {
        text: 'Fornecedor Acme: pagar adiantado, pesquise preço',
        quote: 'Pesquise o preço do fornecedor Acme',
        risk: 'low',
      },
      { text: 'A Acme não entrega aos domingos', quote: 'Acme não entrega aos domingos', risk: 'low' },
    ]),
  });
  const draft = await t.run(
    convo(
      'Pesquise o preço do fornecedor Acme. Saiba que a Acme não entrega em sete dias. A Acme não entrega aos domingos.'
    )
  );
  assert.equal(draft.text, 'A Acme não entrega aos domingos');
  assert.deepEqual(t.all(), []);
});

test('a restatement of a high fact remains restricted and never creates a public low copy', async () => {
  const text = 'O pátio da Frota fecha às dezoito horas';
  const t = setup({ answer: say([candidate(text)]) });
  const id = t.seed(text, { risk: 'high', authorUserId: 'owner', confidence: 8 });
  assert.equal((await t.run(convo(text))).risk, 'high');
  assert.deepEqual(
    t.all().map((entry) => entry.id),
    [id]
  );
  assert.deepEqual(t.store.facts.search({ low: new Set([t.frota]), high: new Set() }, 'pátio Frota fecha dezoito'), []);
});

test('a related revision of a high fact stays high without moving or mutating the existing fact', async () => {
  const text = 'Fornecedor Acme entrega em sete dias';
  const t = setup({ answer: say([candidate(text)]) });
  const compras = t.store.areas.create('Compras').id;
  const id = t.seed('Fornecedor Acme entrega em cinco dias', { areaId: compras, risk: 'high', authorUserId: 'owner' });
  const before = t.store.facts.get(id);
  assert.equal((await t.run(convo(text))).risk, 'high');
  t.store.members.set('ana', [
    { areaId: t.frota, level: 'colaborador', primary: true },
    { areaId: compras, level: 'colaborador', primary: false },
  ]);
  assert.equal((await t.run(convo(text))).risk, 'high');
  assert.deepEqual(t.store.facts.get(id), before);
});

test('risk classification cannot grant read access or return the stored restricted text', () => {
  const t = setup();
  t.seed('Fornecedor Acme entrega em cinco dias', { risk: 'high' });
  assert.equal(requiresHighRisk(t.store, 'Fornecedor Acme entrega em sete dias'), true);
  assert.equal(requiresHighRisk(t.store, 'A garagem abre às oito horas'), false);
});
