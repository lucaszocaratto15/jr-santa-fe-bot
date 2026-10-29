import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecureInputBroker, SECURE_INPUT_WAIT_MS } from '@process/services/teach/control/secureInput';
import type { SecureRequest } from '@process/services/teach/control/secureInput';
import type { VaultItemPublic, VaultStore } from '@process/services/teach/vault/vault';

const CODE = '948372';
const PASSWORD = 'Senha-Do-Portal-99';
const ORIGIN = 'https://portal.gov.br';

const makeVault = (items: VaultItemPublic[] = []) =>
  ({
    available: vi.fn(() => true),
    list: vi.fn(async () => items),
    upsert: vi.fn(async () => items[0]),
    remove: vi.fn(),
    wipe: vi.fn(),
    readSecret: vi.fn(),
  }) as unknown as VaultStore & { upsert: ReturnType<typeof vi.fn> };

const setup = (opts: { origin?: string | null; vault?: VaultStore | null } = {}) => {
  const emitted: SecureRequest[] = [];
  const fill = vi.fn(async (_value: string, _opts: unknown) => ({ ok: true }) as const);
  const vault = opts.vault === undefined ? makeVault() : opts.vault;
  let n = 0;
  const broker = createSecureInputBroker({
    emit: (req) => emitted.push(req),
    currentOrigin: () => (opts.origin === undefined ? ORIGIN : opts.origin),
    fill,
    vault: () => vault,
    newId: () => `req-${++n}`,
  });
  return { broker, emitted, fill, vault };
};

describe('secure input broker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits a fill request for the current origin', async () => {
    const { broker, emitted } = setup();
    void broker.request('otp', 'Código enviado por SMS');
    expect(emitted).toEqual([
      { id: 'req-1', origin: ORIGIN, kind: 'otp', label: 'Código enviado por SMS', allowSave: false, purpose: 'fill' },
    ]);
  });

  it('offers vault saving only for passwords', () => {
    const { broker, emitted } = setup();
    void broker.request('password', 'Senha do portal');
    expect(emitted[0].allowSave).toBe(true);
  });

  it('returns aguardando after 50 s and later enviado via status, never the value', async () => {
    const { broker, fill } = setup();
    const pending = broker.request('otp', 'Código');
    await vi.advanceTimersByTimeAsync(SECURE_INPUT_WAIT_MS);
    const first = await pending;
    expect(SECURE_INPUT_WAIT_MS).toBe(50_000);
    expect(first).toEqual({ ok: true, id: 'req-1', result: 'aguardando' });

    await broker.respond({ id: 'req-1', value: CODE });
    expect(fill).toHaveBeenCalledWith(CODE, { requirePassword: false, allowedOrigins: [ORIGIN] });
    const later = await broker.status('req-1');
    expect(later).toEqual({ ok: true, id: 'req-1', result: 'enviado' });
    expect(JSON.stringify([first, later])).not.toContain(CODE);
  });

  it('resolves enviado directly when the employee answers in time', async () => {
    const { broker } = setup();
    const pending = broker.request('otp', 'Código');
    await broker.respond({ id: 'req-1', value: CODE });
    expect(await pending).toEqual({ ok: true, id: 'req-1', result: 'enviado' });
  });

  it('status keeps waiting while pending and reports aguardando again', async () => {
    const { broker } = setup();
    void broker.request('otp', 'Código');
    await vi.advanceTimersByTimeAsync(SECURE_INPUT_WAIT_MS);
    const status = broker.status('req-1');
    await vi.advanceTimersByTimeAsync(SECURE_INPUT_WAIT_MS);
    expect(await status).toEqual({ ok: true, id: 'req-1', result: 'aguardando' });
  });

  it('reports cancelado and does not fill', async () => {
    const { broker, fill } = setup();
    const pending = broker.request('otp', 'Código');
    await broker.respond({ id: 'req-1', cancelled: true });
    expect(await pending).toEqual({ ok: true, id: 'req-1', result: 'cancelado' });
    expect(fill).not.toHaveBeenCalled();
  });

  it('passes a fill error back without the value', async () => {
    const { broker, fill } = setup();
    fill.mockResolvedValueOnce({ ok: false, error: 'clique no campo antes de preencher' } as never);
    const pending = broker.request('password', 'Senha');
    await broker.respond({ id: 'req-1', value: PASSWORD });
    const result = await pending;
    expect(result).toEqual({ ok: false, error: 'clique no campo antes de preencher' });
    expect(fill).toHaveBeenCalledWith(PASSWORD, { requirePassword: true, allowedOrigins: [ORIGIN] });
  });

  it('saves a password to a new vault item named after the host', async () => {
    const { broker, vault } = setup();
    const pending = broker.request('password', 'Senha');
    await broker.respond({ id: 'req-1', value: PASSWORD, save: true });
    await pending;
    expect((vault as unknown as { upsert: ReturnType<typeof vi.fn> }).upsert).toHaveBeenCalledWith({
      name: 'portal.gov.br',
      origins: [ORIGIN],
      username: '',
      password: PASSWORD,
    });
  });

  it('updates the existing vault item for the origin instead of duplicating it', async () => {
    const existing = {
      id: 'v1',
      name: 'Portal',
      origins: [ORIGIN],
      username: 'joao',
      hasPassword: true,
      hints: '',
    };
    const vault = makeVault([existing]);
    const { broker } = setup({ vault });
    void broker.request('password', 'Senha');
    await broker.respond({ id: 'req-1', value: PASSWORD, save: true });
    expect(vault.upsert).toHaveBeenCalledWith({
      id: 'v1',
      name: 'Portal',
      origins: [ORIGIN],
      username: 'joao',
      password: PASSWORD,
    });
  });

  it('never saves an OTP even if asked', async () => {
    const { broker, vault } = setup();
    void broker.request('otp', 'Código');
    await broker.respond({ id: 'req-1', value: CODE, save: true });
    expect((vault as unknown as { upsert: ReturnType<typeof vi.fn> }).upsert).not.toHaveBeenCalled();
  });

  it('save-only offers upsert the vault and never fill', async () => {
    const { broker, emitted, fill, vault } = setup();
    const id = broker.offerSave('https://portal.gov.br/login?x=1');
    expect(emitted[0]).toMatchObject({ id, origin: ORIGIN, kind: 'password', purpose: 'save-only' });
    await broker.respond({ id: id as string, value: PASSWORD, save: true });
    expect(fill).not.toHaveBeenCalled();
    expect((vault as unknown as { upsert: ReturnType<typeof vi.fn> }).upsert).toHaveBeenCalledWith(
      expect.objectContaining({ origins: [ORIGIN], password: PASSWORD })
    );
  });

  it('refuses when no page is open in the app browser', async () => {
    const { broker, emitted } = setup({ origin: null });
    expect(await broker.request('otp', 'Código')).toEqual({
      ok: false,
      error: 'abra o site no navegador do app antes de pedir',
    });
    expect(emitted).toEqual([]);
  });

  it('reports an unknown id and ignores responses for it', async () => {
    const { broker, fill } = setup();
    await broker.respond({ id: 'nope', value: CODE });
    expect(fill).not.toHaveBeenCalled();
    expect(await broker.status('nope')).toEqual({ ok: false, error: 'pedido não encontrado' });
  });

  it('ignores a second response for the same request', async () => {
    const { broker, fill } = setup();
    void broker.request('otp', 'Código');
    await broker.respond({ id: 'req-1', value: CODE });
    await broker.respond({ id: 'req-1', value: 'other' });
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('limits the number of pending requests', async () => {
    const { broker } = setup();
    for (let i = 0; i < 3; i++) void broker.request('otp', 'Código');
    expect(await broker.request('otp', 'Código')).toEqual({
      ok: false,
      error: 'há pedidos seguros demais aguardando o funcionário',
    });
  });
});
