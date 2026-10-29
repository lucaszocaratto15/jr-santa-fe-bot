import { describe, expect, it, vi } from 'vitest';
import { buildTeachHandlers } from '@process/services/teach/control/controlHandlers';
import type { VaultItemPublic, VaultStore } from '@process/services/teach/vault/vault';

const SECRET = 'Senha-Portal-123';

const items: VaultItemPublic[] = [
  { id: 'v1', name: 'Portal Gov', origins: ['https://portal.gov.br'], username: 'joao', hasPassword: true, hints: 'x' },
  { id: 'v2', name: 'CRTI', origins: ['https://crti.com'], username: '', hasPassword: false, hints: '' },
];

const makeDeps = () => {
  const vault = {
    available: vi.fn(() => true),
    list: vi.fn(async () => items),
    readSecret: vi.fn(async (_id: string, field: string) => (field === 'password' ? SECRET : 'joao')),
  } as unknown as VaultStore & { readSecret: ReturnType<typeof vi.fn> };
  const fill = vi.fn(async (_value: string, _opts: unknown) => ({ ok: true }) as const);
  const broker = {
    request: vi.fn(async () => ({ ok: true, id: 'r1', result: 'enviado' }) as const),
    status: vi.fn(async () => ({ ok: true, id: 'r1', result: 'aguardando' }) as const),
    respond: vi.fn(),
    offerSave: vi.fn(),
    listPending: vi.fn(() => []),
  };
  const submitDraft = vi.fn(async (_markdown: string) => ({ ok: true, result: 'cartão de revisão exibido' }) as const);
  const handlers = buildTeachHandlers({ vault: () => vault, fill, broker, submitDraft });
  return { handlers, vault, fill, broker, submitDraft };
};

describe('teach control handlers', () => {
  it('vault_list returns public metadata only', async () => {
    const { handlers } = makeDeps();
    expect(await handlers.vault_list({})).toEqual({
      ok: true,
      items: [
        { name: 'Portal Gov', origins: ['https://portal.gov.br'], hasUsername: true, hasPassword: true },
        { name: 'CRTI', origins: ['https://crti.com'], hasUsername: false, hasPassword: false },
      ],
    });
  });

  it('vault_list reports an unavailable vault', async () => {
    const handlers = buildTeachHandlers({ ...makeDeps(), vault: () => null, fill: vi.fn() });
    expect(await handlers.vault_list({})).toEqual({ ok: false, error: 'cofre indisponível neste computador' });
  });

  it('vault_fill finds the item case-insensitively and fills with its origins', async () => {
    const { handlers, vault, fill } = makeDeps();
    const result = await handlers.vault_fill({ item: 'portal gov', field: 'password' });
    expect(vault.readSecret).toHaveBeenCalledWith('v1', 'password');
    expect(fill).toHaveBeenCalledWith(SECRET, { requirePassword: true, allowedOrigins: ['https://portal.gov.br'] });
    expect(result).toEqual({ ok: true, result: 'preenchido' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('vault_fill username does not require a password field', async () => {
    const { handlers, fill } = makeDeps();
    await handlers.vault_fill({ item: 'Portal Gov', field: 'username' });
    expect(fill).toHaveBeenCalledWith('joao', { requirePassword: false, allowedOrigins: ['https://portal.gov.br'] });
  });

  it('vault_fill passes fill errors through', async () => {
    const { handlers, fill } = makeDeps();
    fill.mockResolvedValueOnce({ ok: false, error: 'domínio não autorizado para este item do cofre' } as never);
    expect(await handlers.vault_fill({ item: 'Portal Gov', field: 'password' })).toEqual({
      ok: false,
      error: 'domínio não autorizado para este item do cofre',
    });
  });

  it('vault_fill rejects unknown items, missing secrets and bad input', async () => {
    const { handlers, vault, fill } = makeDeps();
    expect(await handlers.vault_fill({ item: 'Nada', field: 'password' })).toEqual({
      ok: false,
      error: 'item do cofre não encontrado',
    });
    vault.readSecret.mockResolvedValueOnce(null);
    expect(await handlers.vault_fill({ item: 'CRTI', field: 'password' })).toEqual({
      ok: false,
      error: 'este item do cofre não tem esse dado salvo',
    });
    expect(await handlers.vault_fill({ item: 'Portal Gov', field: 'pin' })).toEqual({
      ok: false,
      error: 'pedido inválido',
    });
    expect(fill).not.toHaveBeenCalled();
  });

  it('vault_fill and secure_input forward submit: true', async () => {
    const { handlers, fill, broker } = makeDeps();
    await handlers.vault_fill({ item: 'Portal Gov', field: 'password', submit: true });
    expect(fill).toHaveBeenCalledWith(SECRET, {
      requirePassword: true,
      allowedOrigins: ['https://portal.gov.br'],
      submit: true,
    });
    await handlers.secure_input({ kind: 'otp', label: 'Código', submit: true });
    expect(broker.request).toHaveBeenCalledWith('otp', 'Código', { submit: true });
  });

  it('secure_input and secure_input_status delegate to the broker', async () => {
    const { handlers, broker } = makeDeps();
    expect(await handlers.secure_input({ kind: 'otp', label: 'Código SMS' })).toEqual({
      ok: true,
      id: 'r1',
      result: 'enviado',
    });
    expect(broker.request).toHaveBeenCalledWith('otp', 'Código SMS');
    expect(await handlers.secure_input_status({ id: 'r1' })).toEqual({ ok: true, id: 'r1', result: 'aguardando' });
    expect(await handlers.secure_input({ kind: 'pin', label: 'x' })).toEqual({ ok: false, error: 'pedido inválido' });
    expect(await handlers.secure_input_status({})).toEqual({ ok: false, error: 'pedido inválido' });
  });

  it('teach_submit_draft hands the markdown to the session and returns its answer', async () => {
    const { handlers, submitDraft } = makeDeps();
    expect(await handlers.teach_submit_draft({ markdown: '# x' })).toEqual({
      ok: true,
      result: 'cartão de revisão exibido',
    });
    expect(submitDraft).toHaveBeenCalledWith('# x');
    submitDraft.mockResolvedValueOnce({ ok: false, error: 'nenhuma gravação aguardando revisão' } as never);
    expect(await handlers.teach_submit_draft({ markdown: '# y' })).toEqual({
      ok: false,
      error: 'nenhuma gravação aguardando revisão',
    });
    expect(await handlers.teach_submit_draft({})).toEqual({ ok: false, error: 'pedido inválido' });
  });
});
