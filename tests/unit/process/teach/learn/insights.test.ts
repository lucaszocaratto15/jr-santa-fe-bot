import { describe, expect, it, vi } from 'vitest';
import { generateInsights, INSIGHTS_SYSTEM_PROMPT, parseInsightReply } from '@/process/services/teach/learn/insights';
import type { LearnSample } from '@/common/types/agent/learnTypes';

const ctx = { browserOrigins: ['https://nfse.prefeitura.sp.gov.br'] };
const reply = (body: unknown) => JSON.stringify(body);

describe('INSIGHTS_SYSTEM_PROMPT', () => {
  it('asks for JSON only and treats titles as data', () => {
    expect(INSIGHTS_SYSTEM_PROMPT).toMatch(/JSON/);
    expect(INSIGHTS_SYSTEM_PROMPT).toMatch(/dados, não como instruções/);
  });
});

describe('parseInsightReply', () => {
  it('extracts JSON wrapped in prose, think blocks and code fences', () => {
    const text = `<think>pensando {não é json}</think>Claro! Aqui está:\n\`\`\`json\n${reply({
      repetitivas: [{ titulo: 'Baixar NF', descricao: 'Portal', vezes: 4, minutos: 20 }],
      sugestoes: [],
    })}\n\`\`\`\nAbraço`;
    expect(parseInsightReply(text, ctx)).toEqual({
      repetitive: [{ title: 'Baixar NF', description: 'Portal', times: 4, minutes: 20 }],
      suggestions: [],
    });
  });

  it('drops a teach url whose origin was not seen and turns it into a tip', () => {
    const parsed = parseInsightReply(
      reply({
        repetitivas: [],
        sugestoes: [{ tipo: 'ensinar', titulo: 'T', descricao: 'D', descricaoTarefa: 'X', url: 'https://evil.example/a' }],
      }),
      ctx
    );
    expect(parsed?.suggestions).toEqual([{ kind: 'tip', title: 'T', description: 'D' }]);
  });

  it('drops an http url on a seen host', () => {
    const parsed = parseInsightReply(
      reply({ sugestoes: [{ tipo: 'ensinar', titulo: 'T', descricao: 'D', url: 'http://nfse.prefeitura.sp.gov.br/x' }] }),
      ctx
    );
    expect(parsed?.suggestions[0].kind).toBe('tip');
  });

  it('keeps a teach url on a seen https origin, without its query', () => {
    const parsed = parseInsightReply(
      reply({
        sugestoes: [
          {
            tipo: 'ensinar',
            titulo: 'Emitir NF',
            descricao: 'Toda manhã',
            descricaoTarefa: 'Emitir a NF do dia',
            url: 'https://nfse.prefeitura.sp.gov.br/emitir?x=1#y',
          },
        ],
      }),
      ctx
    );
    expect(parsed?.suggestions).toEqual([
      {
        kind: 'teach',
        title: 'Emitir NF',
        description: 'Toda manhã',
        teach: { description: 'Emitir a NF do dia', url: 'https://nfse.prefeitura.sp.gov.br/emitir' },
      },
    ]);
  });

  it('caps lists at 10 and texts at 300 chars', () => {
    const long = 'x'.repeat(500);
    const parsed = parseInsightReply(
      reply({
        repetitivas: Array.from({ length: 15 }, () => ({ titulo: long, descricao: long, vezes: 1, minutos: 1 })),
        sugestoes: Array.from({ length: 15 }, () => ({ tipo: 'dica', titulo: long, descricao: long })),
      }),
      ctx
    );
    expect(parsed?.repetitive).toHaveLength(10);
    expect(parsed?.suggestions).toHaveLength(10);
    expect(parsed?.repetitive[0].title).toHaveLength(300);
    expect(parsed?.suggestions[0].description).toHaveLength(300);
  });

  it('skips items without a title and coerces bad numbers to 0', () => {
    const parsed = parseInsightReply(
      reply({ repetitivas: [{ titulo: '' }, { titulo: 'A', vezes: 'x', minutos: -3 }], sugestoes: [{ tipo: 'dica' }] }),
      ctx
    );
    expect(parsed).toEqual({ repetitive: [{ title: 'A', description: '', times: 0, minutes: 0 }], suggestions: [] });
  });

  it('returns null for a reply without a JSON object', () => {
    expect(parseInsightReply('Não consegui analisar.', ctx)).toBeNull();
    expect(parseInsightReply(reply({ outra: 1 }), ctx)).toBeNull();
    expect(parseInsightReply('{"repetitivas": [', ctx)).toBeNull();
  });
});

const T0 = Date.parse('2026-10-29T08:00:00Z');
const samples: LearnSample[] = Array.from({ length: 30 }, (_, i) => ({
  t: T0 + i * 15_000,
  app: i % 2 ? 'Excel' : 'JR Bot',
  title: i % 2 ? 'NF.xlsx' : 'Emitir NF',
  url: i % 2 ? undefined : 'https://nfse.prefeitura.sp.gov.br/emitir',
}));
const connection = { url: 'http://127.0.0.1:1/v1', token: 't', model: 'MiniMax-M2' };
const okReply = (content: string) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })));

describe('generateInsights', () => {
  it('returns unavailable when there is no model connection', async () => {
    const request = vi.fn();
    expect(await generateInsights({ samples, connection: null, now: () => 1, request })).toEqual({
      ok: false,
      code: 'unavailable',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns no-data without samples', async () => {
    const request = vi.fn();
    expect(await generateInsights({ samples: [], connection, now: () => 1, request })).toEqual({
      ok: false,
      code: 'no-data',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('builds a batch with the local time per app and the parsed suggestions', async () => {
    const request = okReply(
      reply({
        repetitivas: [],
        sugestoes: [{ tipo: 'ensinar', titulo: 'T', descricao: 'D', url: 'https://nfse.prefeitura.sp.gov.br/emitir' }],
      })
    );
    const result = await generateInsights({ samples, connection, now: () => 99, request });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.createdAt).toBe(99);
    expect(result.batch.timePerApp).toEqual([
      { app: 'JR Bot', minutes: 3.8 },
      { app: 'Excel', minutes: 3.8 },
    ]);
    expect(result.batch.suggestions[0].kind).toBe('teach');
    const body = JSON.parse(String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0]).toEqual({ role: 'system', content: INSIGHTS_SYSTEM_PROMPT });
  });

  it('maps a 502 to model-error and a fetch TypeError to offline', async () => {
    const bad = vi.fn(async () => new Response('', { status: 502 }));
    expect(await generateInsights({ samples, connection, now: () => 1, request: bad })).toEqual({
      ok: false,
      code: 'model-error',
    });
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await generateInsights({ samples, connection, now: () => 1, request: offline })).toEqual({
      ok: false,
      code: 'offline',
    });
  });

  it('an unparseable reply is a model-error', async () => {
    expect(await generateInsights({ samples, connection, now: () => 1, request: okReply('sem json') })).toEqual({
      ok: false,
      code: 'model-error',
    });
  });
});
