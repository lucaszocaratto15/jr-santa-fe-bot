import { describe, expect, it } from 'vitest';
import { isPasswordField, isSecretField } from '@/process/services/teach/recording/fieldClassifier';

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

  it('flags CPF fields (personal data, never photographed or recorded)', () => {
    expect(isSecretField({ tag: 'input', type: 'text', name: 'cpf' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'CPF do titular' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', id: 'nr_cpf' })).toBe(true);
    expect(isPasswordField({ tag: 'input', type: 'text', name: 'cpf' })).toBe(false);
  });

  it('flags codigo/code as a separate token and verificação anywhere', () => {
    expect(isSecretField({ tag: 'input', type: 'text', name: 'codigo' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'Código' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', name: 'code' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', id: 'sms-code' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', placeholder: 'Digite o code recebido' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'Verificação em duas etapas' })).toBe(true);
    expect(isSecretField({ tag: 'input', type: 'text', name: 'verificacao' })).toBe(true);
    // Underscore is a boundary: accepted false positive (masking only).
    expect(isSecretField({ tag: 'input', type: 'text', name: 'codigo_produto' })).toBe(true);
  });

  it('does not flag code inside a longer word', () => {
    expect(isSecretField({ tag: 'input', type: 'text', name: 'zipcode' })).toBe(false);
    expect(isSecretField({ tag: 'input', type: 'text', name: 'postcode' })).toBe(false);
    expect(isSecretField({ tag: 'input', type: 'text', name: 'barcode' })).toBe(false);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'Codificação' })).toBe(false);
  });

  it('does not flag ordinary fields', () => {
    expect(isSecretField({ tag: 'input', type: 'text', name: 'numero_nf' })).toBe(false);
    expect(isSecretField({ tag: 'input', type: 'email', label: 'E-mail' })).toBe(false);
    expect(isSecretField({ tag: 'select', name: 'estado' })).toBe(false);
    expect(isSecretField({ tag: 'input', type: 'text', label: 'Pinheiros' })).toBe(false);
  });
});

describe('isPasswordField', () => {
  it('is true only for password type or password autocomplete tokens', () => {
    expect(isPasswordField({ tag: 'input', type: 'password' })).toBe(true);
    expect(isPasswordField({ tag: 'input', type: 'text', autocomplete: 'current-password' })).toBe(true);
    expect(isPasswordField({ tag: 'input', type: 'text', autocomplete: 'section-a new-password' })).toBe(true);
    expect(isPasswordField({ tag: 'input', type: 'text', autocomplete: 'one-time-code' })).toBe(false);
    expect(isPasswordField({ tag: 'input', type: 'text', autocomplete: 'cc-number' })).toBe(false);
    expect(isPasswordField({ tag: 'input', type: 'text', name: 'senha' })).toBe(false);
  });
});
