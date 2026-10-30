import { describe, expect, it, vi } from 'vitest';
import { createBrainClient } from '@/process/services/jr/brainClient';

const client = (reply: unknown) => {
  const call = vi.fn(async () => reply);
  return { call, brain: createBrainClient(call) };
};

describe('brainClient', () => {
  it('posts the capture and requires accepted:true', async () => {
    const { call, brain } = client({ accepted: true });
    await brain.capture({ conversationRef: 'r', bot: 'b', messages: [{ role: 'user', text: 'oi' }] });
    expect(call.mock.calls[0][0]).toBe('/api/brain/capture');
    expect(
      JSON.parse(
        String((call.mock.calls[0] as unknown[])[1] && ((call.mock.calls[0] as unknown[])[1] as RequestInit).body)
      )
    ).toMatchObject({ bot: 'b' });
    await expect(client({}).brain.capture({ conversationRef: 'r', bot: 'b', messages: [] })).rejects.toThrow(
      'unavailable'
    );
  });

  it('shape-checks search results', async () => {
    const fact = { id: 'f1', text: 't', area: 'Obras', risk: 'low', date: null, confidence: 7, erpRef: null };
    expect(await client({ facts: [fact] }).brain.search('q')).toEqual([fact]);
    await expect(client({ facts: [{ id: 'f1' }] }).brain.search('q')).rejects.toThrow('unavailable');
    await expect(client({ nope: 1 }).brain.search('q')).rejects.toThrow('unavailable');
  });

  it('parses feedback, me and consent', async () => {
    expect(await client({ recorded: true, suspended: true }).brain.feedback('f1', 'errado')).toEqual({
      suspended: true,
    });
    await expect(client({ recorded: true }).brain.feedback('f1')).rejects.toThrow('unavailable');
    const me = {
      areas: [{ id: 'a', name: 'Obras', level: 'gestor', primary: true }],
      isDirector: false,
      manages: ['a'],
    };
    expect(await client(me).brain.me()).toEqual(me);
    await expect(
      client({ areas: [{ id: 'a', level: 'chefe', primary: true }], isDirector: false, manages: [] }).brain.me()
    ).rejects.toThrow('unavailable');
    expect(await client({ version: '1.4', at: 'x' }).brain.consent('1.4')).toEqual({ version: '1.4', at: 'x' });
    expect(await client({ version: null, at: null }).brain.consentState()).toEqual({ version: null, at: null });
    await expect(client({ version: 3 }).brain.consentState()).rejects.toThrow('unavailable');
  });
});
