import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSecureInputBroker,
  SECURE_INPUT_WAIT_MS,
  SECURE_REQUEST_TTL_MS,
} from '@process/services/teach/control/secureInput';
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
  const expired: string[] = [];
  const fill = vi.fn(async (_value: string, _opts: unknown) => ({ ok: true }) as const);
  const vault = opts.vault === undefined ? makeVault() : opts.vault;
  let n = 0;
  const broker = createSecureInputBroker({
    emit: (req) => emitted.push(req),
    expired: (id) => expired.push(id),
    currentOrigin: () => (opts.origin === undefined ? ORIGIN : opts.origin),
    fill,
    vault: () => vault,
    newId: () => `req-${++n}`,
  });
  return { broker, emitted, expired, fill, vault };
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

  it('expires a pending request after the TTL, frees the cap and tells the renderer', async () => {
    const { broker, expired } = setup();
    const results = [1, 2, 3].map(() => broker.request('otp', 'Código'));
    await vi.advanceTimersByTimeAsync(SECURE_INPUT_WAIT_MS);
    await Promise.all(results);
    await vi.advanceTimersByTimeAsync(SECURE_REQUEST_TTL_MS - SECURE_INPUT_WAIT_MS - 10_000);
    const status = broker.status('req-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(SECURE_REQUEST_TTL_MS).toBe(300_000);
    expect(await status).toEqual({ ok: true, id: 'req-1', result: 'cancelado' });
    expect(expired).toEqual(['req-1', 'req-2', 'req-3']);
    expect(broker.listPending()).toEqual([]);
    expect(await broker.status('req-2')).toEqual({ ok: false, error: 'pedido não encontrado' });
    void broker.request('otp', 'Código');
    expect(broker.listPending()).toHaveLength(1);
  });

  it('expires unanswered save-only offers too', async () => {
    const { broker, expired } = setup();
    const id = broker.offerSave(ORIGIN);
    await vi.advanceTimersByTimeAsync(SECURE_REQUEST_TTL_MS);
    expect(expired).toEqual([id]);
    expect(broker.listPending()).toEqual([]);
  });

  it('lists pending requests oldest first without any value', async () => {
    const { broker } = setup();
    void broker.request('otp', 'Código');
    const saveId = broker.offerSave(ORIGIN);
    void broker.request('password', 'Senha');
    await broker.respond({ id: 'req-1', value: CODE });
    const list = broker.listPending();
    expect(list.map((item) => item.id)).toEqual([saveId, 'req-3']);
    expect(JSON.stringify(list)).not.toContain(CODE);
    for (const item of list) expect(item).not.toHaveProperty('value');
  });

  it('reports saved on the fill flow, and a value-free warning when the vault save fails', async () => {
    const vault = makeVault();
    const { broker } = setup({ vault });
    void broker.request('password', 'Senha');
    expect(await broker.respond({ id: 'req-1', value: PASSWORD, save: true })).toEqual({ saved: true });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vault.upsert.mockRejectedValueOnce(new TypeError(`bad ${PASSWORD}`));
    const pending = broker.request('password', 'Senha');
    expect(await broker.respond({ id: 'req-2', value: PASSWORD, save: true })).toEqual({ saved: false });
    expect(await pending).toEqual({ ok: true, id: 'req-2', result: 'enviado' });
    expect(warn).toHaveBeenCalledWith('[teach] vault save failed', 'TypeError');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PASSWORD);
    warn.mockRestore();
  });

  it('keeps a save-only offer open for retry when the save fails', async () => {
    const vault = makeVault();
    const { broker } = setup({ vault });
    const id = broker.offerSave(ORIGIN) as string;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vault.upsert.mockRejectedValueOnce(new Error('disk'));
    expect(await broker.respond({ id, value: PASSWORD })).toEqual({ saved: false });
    expect(broker.listPending().map((item) => item.id)).toEqual([id]);
    expect(await broker.respond({ id, value: PASSWORD })).toEqual({ saved: true });
    expect(broker.listPending()).toEqual([]);
    warn.mockRestore();
  });

  it('ignores a duplicate save-only response while the save is in flight', async () => {
    const vault = makeVault();
    const { broker } = setup({ vault });
    const id = broker.offerSave(ORIGIN) as string;
    let finish!: () => void;
    vault.upsert.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve(undefined))));
    const first = broker.respond({ id, value: PASSWORD });
    await vi.advanceTimersByTimeAsync(0);
    expect(await broker.respond({ id, value: PASSWORD })).toEqual({});
    expect(await broker.respond({ id, cancelled: true })).toEqual({});
    finish();
    expect(await first).toEqual({ saved: true });
    expect(vault.upsert).toHaveBeenCalledTimes(1);
    expect(broker.listPending()).toEqual([]);
  });

  it('does not double-settle when the TTL fires during a save-only write', async () => {
    const vault = makeVault();
    const { broker, expired } = setup({ vault });
    const id = broker.offerSave(ORIGIN) as string;
    let finish!: () => void;
    vault.upsert.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve(undefined))));
    const first = broker.respond({ id, value: PASSWORD });
    await vi.advanceTimersByTimeAsync(SECURE_REQUEST_TTL_MS);
    expect(expired).toEqual([]);
    finish();
    expect(await first).toEqual({ saved: true });
    expect(expired).toEqual([]);
    expect(vault.upsert).toHaveBeenCalledTimes(1);
    expect(broker.listPending()).toEqual([]);
  });

  it('expires after a failed save when the TTL fired during it', async () => {
    const vault = makeVault();
    const { broker, expired } = setup({ vault });
    const id = broker.offerSave(ORIGIN) as string;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail!: () => void;
    vault.upsert.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = () => reject(new Error('disk'))))
    );
    const first = broker.respond({ id, value: PASSWORD });
    await vi.advanceTimersByTimeAsync(SECURE_REQUEST_TTL_MS);
    fail();
    expect(await first).toEqual({ saved: false });
    expect(expired).toEqual([id]);
    expect(broker.listPending()).toEqual([]);
    warn.mockRestore();
  });

  it('passes submit to the fill only when the agent asked for it', async () => {
    const { broker, fill, emitted } = setup();
    void broker.request('password', 'Senha', { submit: true });
    expect(emitted[0]).not.toHaveProperty('submit');
    await broker.respond({ id: 'req-1', value: PASSWORD });
    expect(fill).toHaveBeenCalledWith(PASSWORD, { requirePassword: true, allowedOrigins: [ORIGIN], submit: true });
  });

  it('reports saved false for save-only when the vault is unavailable', async () => {
    const { broker } = setup({ vault: null });
    const id = broker.offerSave(ORIGIN) as string;
    expect(await broker.respond({ id, value: PASSWORD })).toEqual({ saved: false });
  });

  it('words an origin change as the page changing site', async () => {
    const { broker, fill } = setup();
    fill.mockResolvedValueOnce({ ok: false, error: 'domínio não autorizado para este item do cofre' } as never);
    const pending = broker.request('otp', 'Código');
    await broker.respond({ id: 'req-1', value: CODE });
    expect(await pending).toEqual({ ok: false, error: 'a página mudou de site antes do envio' });
  });
});
