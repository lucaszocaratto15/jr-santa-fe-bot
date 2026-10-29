import { describe, expect, it } from 'vitest';
import { isSecretField } from '@/process/services/teach/fieldClassifier';

describe('isSecretField', () => {
  it('flags password inputs', () => {
    expect(isSecretField({ tag: 'input', type: 'password' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'PASSWORD' })).toBe(true);
  });

  it('flags secret autocomplete tokens', () => {
    expect(isSecretField({ tag: 'input', type: 'text', autocomplete: 'one-time-code' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', autocomplete: 'current-password' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', autocomplete: 'section-a new-password' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', autocomplete: 'cc-number' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', autocomplete: 'username' })).toBe(false);
  });

  it('flags secret-looking names, ids, labels and placeholders (PT and EN)', () => {
    expect(isSecretField({ tag: 'input', type: 'text', label: 'Código de verificação' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'Codigo de verificacao' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', name: 'user_senha' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', id: 'otp' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', placeholder: 'Número do cartão' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'tel', label: 'CVV' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'PIN' })).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(isSecretField({ tag: 'input', type: 'text', name: 'numero_nf' })).toBe(false);
    expect(isSecretField({ tag: 'input', type: 'email', label: 'E-mail' })).toBe(false);
    expect(isSecretField({ tag: 'select', name: 'estado' })).toBe(false);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'Pinheiros' })).toBe(false);
  });
});
