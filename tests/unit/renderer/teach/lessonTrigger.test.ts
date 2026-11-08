import { describe, expect, it } from 'vitest';
import {
  shouldOffer,
  stretchAfter,
  type TriggerMessage,
} from '@renderer/pages/conversation/Preview/browser/TeachCards/lessonTrigger';

const user = (id: string, text: string): TriggerMessage => ({ id, role: 'user', text });
const bot = (id: string, text: string): TriggerMessage => ({ id, role: 'assistant', text });

describe('shouldOffer', () => {
  it('needs at least two user messages', () => {
    expect(shouldOffer([user('1', 'perfeito')], null, true)).toBe(false);
  });

  it('offers when a correction is followed by an approval word', () => {
    const messages = [
      user('1', 'faz X'),
      bot('2', 'feito'),
      user('3', 'nao, assim'),
      bot('4', 'ok'),
      user('5', 'Agora sim!'),
    ];
    expect(shouldOffer(messages, null, true)).toBe(true);
  });

  it('is silent when the turn failed', () => {
    const messages = [user('1', 'a'), bot('2', 'b'), user('3', 'obrigado')];
    expect(shouldOffer(messages, null, false)).toBe(false);
  });

  it('is silent for a stretch already offered (reload)', () => {
    const messages = [user('1', 'a'), bot('2', 'b'), user('3', 'obrigado')];
    expect(shouldOffer(messages, '3', true)).toBe(false);
  });

  it('offers once the employee moved on after three more messages', () => {
    const messages = [user('1', 'a'), user('2', 'b'), user('3', 'c'), user('4', 'd')];
    expect(shouldOffer(messages, null, true)).toBe(true);
    expect(shouldOffer(messages.slice(0, 3), null, true)).toBe(false);
  });

  it('normalizes accents and ignores words that only contain an approval word', () => {
    expect(shouldOffer([user('1', 'a'), user('2', 'Ótimo, valeu')], null, true)).toBe(true);
    expect(shouldOffer([user('1', 'a'), user('2', 'isolado')], null, true)).toBe(false);
  });
});

describe('stretchAfter', () => {
  it('returns messages after the last offered id', () => {
    const messages = [user('1', 'a'), bot('2', 'b'), user('3', 'c')];
    expect(stretchAfter(messages, '2').map((m) => m.id)).toEqual(['3']);
    expect(stretchAfter(messages, null)).toHaveLength(3);
    expect(stretchAfter(messages, 'gone')).toHaveLength(3);
  });
});
