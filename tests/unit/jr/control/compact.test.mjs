import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAR_CEILING,
  CHARS_PER_TOKEN,
  clampToSend,
  compactMessages,
  estimateTokens,
  excerptSummary,
  TOKEN_CEILING,
} from '../../../../services/control/compact.mjs';
import {
  DEFAULT_ATTEMPT_MS,
  DEFAULT_COMPACTION_BUDGET_MS,
  DEFAULT_GEMINI_MODEL,
  validateConfiguration,
} from '../../../../services/control/validation.mjs';
import { ADMIN_CODE, MODEL, UPSTREAM_KEY } from './support.mjs';

const baseConfig = {
  adminCode: ADMIN_CODE,
  upstreamKey: UPSTREAM_KEY,
  upstreamUrl: 'https://example.test/v1',
  model: MODEL,
};

test('token estimate uses 3 characters per token and a 130k ceiling', () => {
  assert.equal(CHARS_PER_TOKEN, 3);
  assert.equal(TOKEN_CEILING, 130_000);
  assert.equal(CHAR_CEILING, 390_000);
  const messages = [{ role: 'user', content: 'a'.repeat(12) }];
  const raw = JSON.stringify(messages).length;
  assert.equal(estimateTokens(messages), Math.ceil(raw / 3));
  assert.notEqual(estimateTokens(messages), Math.ceil(raw / 4));
  assert.ok(estimateTokens([{ role: 'user', content: 'a'.repeat(CHARS_PER_TOKEN * 140_000) }]) > 140_000);
});

test('excerpt keeps the start and the end of an old message', () => {
  const middle = 'UNICO-MEIO';
  const text = `COMECO ${'a'.repeat(2_000)} ${middle} ${'b'.repeat(2_000)} FIM`;
  const excerpt = excerptSummary([{ role: 'user', content: text }]);
  assert.match(excerpt, /COMECO/);
  assert.match(excerpt, /FIM/);
  assert.equal(excerpt.includes(middle), false);
});

test('ATTEMPT_MS defaults to 90000 and GEMINI_MODEL defaults to gemini-3.8-flash', () => {
  const config = validateConfiguration(baseConfig);
  assert.equal(config.attemptMs, 90_000);
  assert.equal(config.attemptMs, DEFAULT_ATTEMPT_MS);
  assert.equal(config.compactionBudgetMs, DEFAULT_COMPACTION_BUDGET_MS);
  assert.equal(config.compactionEnabled, true);
  const gemini = validateConfiguration({ ...baseConfig, geminiKey: 'gemini-test-key-not-real-xx' });
  assert.equal(gemini.fallback.providers.at(-1).model, DEFAULT_GEMINI_MODEL);
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
  const custom = validateConfiguration({
    ...baseConfig,
    geminiKey: 'gemini-test-key-not-real-xx',
    geminiModel: 'gemini-3.8-pro',
    attemptMs: '120000',
    compactionBudgetMs: '0',
    compactionEnabled: 'false',
  });
  assert.equal(custom.attemptMs, 120_000);
  assert.equal(custom.compactionBudgetMs, 0);
  assert.equal(custom.compactionEnabled, false);
  assert.equal(custom.fallback.providers.at(-1).model, 'gemini-3.8-pro');
  assert.throws(() => validateConfiguration({ ...baseConfig, attemptMs: 'nope' }), /invalid_configuration/);
  assert.throws(() => validateConfiguration({ ...baseConfig, attemptMs: '10' }), /invalid_configuration/);
  assert.throws(
    () => validateConfiguration({ ...baseConfig, geminiKey: 'gemini-test-key-not-real-xx', geminiModel: 'bad model' }),
    /invalid_configuration/
  );
});

test('a short conversation is not summarized', async () => {
  let calls = 0;
  const messages = [{ role: 'user', content: 'oi' }];
  const result = await compactMessages(messages, {
    gemini: {
      key: 'k'.repeat(20),
      model: 'gemini-3.8-flash',
      url: 'https://example.test/gemini',
      fetch: async () => {
        calls += 1;
        throw new Error('não deveria resumir');
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(result[0].content, 'oi');
});

test('without a Gemini key a long history becomes an excerpt and keeps the recent tool pair', async () => {
  let calls = 0;
  const messages = [
    { role: 'system', content: 'Regras.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'list', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_old', content: 'arquivo.txt' },
    { role: 'user', content: `MEIO-ANTIGO ${'z'.repeat(20_000)}` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'save', arguments: '{"a":1}' } }],
    },
    { role: 'tool', tool_call_id: 'call_new', content: 'ok-salvo' },
    { role: 'user', content: 'ULTIMA' },
  ];
  const result = await compactMessages(messages, {
    ceilingTokens: 3_000,
    tailChars: 800,
    blockChars: 30_000,
    gemini: {
      key: '',
      fetch: async () => {
        calls += 1;
        throw new Error('sem chave');
      },
    },
  });
  assert.equal(calls, 0);
  const tool = result.find((message) => message.tool_call_id === 'call_new');
  assert.equal(tool.content, 'ok-salvo');
  assert.match(JSON.stringify(result), /ULTIMA/);
  assert.match(JSON.stringify(result), /contexto compactado/);
  assert.ok(estimateTokens(result) <= 3_000);
});

test('Gemini summaries preserve a recent tool pair and a total time budget stops later blocks', async () => {
  let clock = 1_000;
  let geminiCalls = 0;
  const seen = [];
  const messages = [
    { role: 'system', content: 'sys' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'list', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_old', content: 'arquivo.txt' },
    { role: 'user', content: 'A'.repeat(5_000) },
    { role: 'user', content: 'B'.repeat(5_000) },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'save', arguments: '{"a":1}' } }],
    },
    { role: 'tool', tool_call_id: 'call_new', content: 'ok-salvo' },
    { role: 'user', content: 'RECENT' },
  ];
  const result = await compactMessages(messages, {
    ceilingTokens: 2_000,
    tailChars: 700,
    blockChars: 6_000,
    budgetMs: 1_000,
    attemptMs: 90_000,
    now: () => clock,
    gemini: {
      key: 'k'.repeat(20),
      model: 'gemini-3.8-flash',
      url: 'https://example.test/gemini',
      fetch: async (_url, options) => {
        geminiCalls += 1;
        seen.push(JSON.parse(options.body).messages.at(-1).content);
        clock += 2_000;
        return Response.json({ choices: [{ message: { content: 'resumo curto' } }] });
      },
    },
  });
  assert.equal(geminiCalls, 1);
  assert.match(seen[0], /call_old/);
  assert.match(seen[0], /arquivo.txt/);
  assert.match(JSON.stringify(result), /resumo curto/);
  assert.match(JSON.stringify(result), /contexto compactado/);
  assert.equal(result.find((message) => message.tool_call_id === 'call_new').content, 'ok-salvo');
  assert.match(JSON.stringify(result), /RECENT/);
});

test('Gemini 400, 413 and timeout become excerpts instead of failing the request', async (t) => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: `ANTIGO ${'q'.repeat(8_000)}` },
    { role: 'user', content: 'RECENT' },
  ];
  for (const status of [400, 413]) {
    const result = await compactMessages(messages, {
      ceilingTokens: 2_000,
      tailChars: 200,
      gemini: {
        key: 'k'.repeat(20),
        model: 'gemini-3.8-flash',
        url: 'https://example.test/gemini',
        fetch: async () => new Response(JSON.stringify({ error: { message: 'nao' } }), { status }),
      },
    });
    assert.match(JSON.stringify(result), /contexto compactado/);
    assert.match(JSON.stringify(result), /RECENT/);
  }
  const timed = await compactMessages(messages, {
    ceilingTokens: 2_000,
    tailChars: 200,
    attemptMs: 30,
    budgetMs: 90_000,
    gemini: {
      key: 'k'.repeat(20),
      model: 'gemini-3.8-flash',
      url: 'https://example.test/gemini',
      fetch: (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        }),
    },
  });
  assert.match(JSON.stringify(timed), /contexto compactado/);
  assert.match(JSON.stringify(timed), /RECENT/);
  t.diagnostic('resumo que estoura o tempo cai no excerto');
});

test('a system prompt that alone exceeds the ceiling is truncated without a loop or an empty result', () => {
  const started = Date.now();
  const result = clampToSend(
    [{ role: 'system', content: `INICIO-${'S'.repeat(500_000)}-FIM` }, { role: 'user', content: 'ping' }],
    CHAR_CEILING
  );
  assert.ok(Date.now() - started < 1_000);
  assert.ok(estimateTokens(result) <= TOKEN_CEILING);
  assert.match(result[0].content, /INICIO-/);
  assert.match(result[0].content, /FIM/);
  assert.equal(result.at(-1).content, 'ping');
  const many = Array.from({ length: 40 }, (_value, index) => ({
    role: 'user',
    content: `${index}-${'q'.repeat(10_000)}`,
  }));
  const clamped = clampToSend(many, 5_000);
  assert.ok(JSON.stringify(clamped).length <= 5_000);
  assert.ok(clamped.length > 0);
  assert.throws(
    () => clampToSend([{ role: 'user', content: 'x'.repeat(100) }], 8),
    (error) => error.status === 413 && error.code === 'context_too_large'
  );
});
