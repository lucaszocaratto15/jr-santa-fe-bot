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
    // R16: a username is redaction-only, so the agent can keep driving the login page.
    expect(fill).toHaveBeenCalledWith('joao', {
      requirePassword: false,
      redactOnly: true,
      allowedOrigins: ['https://portal.gov.br'],
    });
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

describe('handbook tools', () => {
  const ITEM = '11111111-2222-4333-8444-555555555555';
  const OTHER = '22222222-2222-4333-8444-555555555555';
  const MEDIA = '66666666-7777-4888-9999-aaaaaaaaaaaa';
  const activity = (id: string, title: string, description: string, steps: string[]) => ({
    id,
    kind: 'activity' as const,
    source: 'taught' as const,
    body: {
      title,
      description,
      frequency: 'daily' as const,
      steps: steps.map((text, index) => (index === 0 ? { text, mediaId: MEDIA } : { text })),
      confirmBefore: ['Valor da nota'],
    },
    approvedAt: 1,
    updatedAt: 1,
    media: [MEDIA],
  });
  const view = (overrides: Record<string, unknown> = {}) => ({
    role: { key: 'auxiliar de escritorio', title: 'Auxiliar de escritório' },
    items: [
      activity(OTHER, 'Conferir extrato', 'Confere o extrato do banco', ['Abrir o banco', 'Baixar extrato']),
      activity(ITEM, 'Lançar NF', 'Lança a nota fiscal no portal', ['Abrir o portal [tela 1]', 'Clicar em Emitir']),
    ],
    indicators: {
      activities: [{ title: 'Lançar NF', timesPerWeek: 5, minutesPerRun: 6 }],
      timePerApp: [{ app: 'Excel', minutesPerDay: 40 }],
      contributors: 2,
    },
    roleFlowchart: 'flowchart TD\n  role(["Auxiliar de escritório"])',
    flowcharts: {},
    ...overrides,
  });
  const setup = (
    options: { admin?: boolean; payload?: Record<string, unknown>; unavailable?: boolean; adminItems?: unknown[] } = {}
  ) => {
    const service = {
      mine: vi.fn(async () => {
        if (options.unavailable) throw new Error('unavailable');
        return view(options.payload);
      }),
      adminRole: vi.fn(async () =>
        view({ role: { key: 'financeiro', title: 'Financeiro' }, items: options.adminItems ?? [] })
      ),
    };
    const showHandbook = vi.fn();
    const handlers = buildTeachHandlers({
      ...makeDeps(),
      handbook: () => service as never,
      showHandbook,
      isAdmin: () => options.admin === true,
    });
    return { handlers, service, showHandbook };
  };
  const text = (result: unknown) => (result as { result?: string; error?: string }).result ?? '';

  it('lookup for a user without title returns the not-registered text', async () => {
    const { handlers } = setup({ payload: { role: null, items: [], indicators: null } });
    expect(await handlers.handbook_lookup({})).toEqual({
      ok: true,
      result: 'Seu cargo não está cadastrado no JR Bot. Peça ao administrador para cadastrá-lo.',
    });
  });

  it('lookup for an empty role returns the no-handbook text with the role title', async () => {
    const { handlers } = setup({ payload: { items: [], indicators: null } });
    expect(text(await handlers.handbook_lookup({ query: 'nota' }))).toBe(
      'Ainda não existe Manual da função para o cargo Auxiliar de escritório.'
    );
  });

  it('lookup in pilot mode or offline returns the unavailable text', async () => {
    const offline = setup({ unavailable: true });
    expect(await offline.handlers.handbook_lookup({})).toEqual({
      ok: false,
      error: 'O Manual da função só funciona conectado ao servidor da empresa.',
    });
    const pilot = buildTeachHandlers({
      ...makeDeps(),
      handbook: () => null,
      showHandbook: vi.fn(),
      isAdmin: () => false,
    });
    expect(await pilot.handbook_lookup({})).toEqual({
      ok: false,
      error: 'O Manual da função só funciona conectado ao servidor da empresa.',
    });
  });

  it('lookup by an employee ignores role and uses their own', async () => {
    const { handlers, service } = setup();
    const result = text(await handlers.handbook_lookup({ role: 'Financeiro' }));
    expect(service.adminRole).not.toHaveBeenCalled();
    expect(service.mine).toHaveBeenCalled();
    expect(result).toContain('Manual da função do cargo Auxiliar de escritório.');
  });

  it('an admin may ask for another role by its title', async () => {
    const { handlers, service } = setup({ admin: true });
    const result = text(await handlers.handbook_lookup({ role: 'Financeiro' }));
    expect(service.adminRole).toHaveBeenCalledWith('financeiro');
    expect(result).toBe('Ainda não existe Manual da função para o cargo Financeiro.');
  });

  it('lookup result has steps and a mermaid fence but no media ids or base64', async () => {
    const { handlers } = setup();
    const result = text(await handlers.handbook_lookup({}));
    expect(result).toContain('1. Abrir o portal');
    expect(result).not.toContain('[tela');
    expect(result).toContain('```mermaid\nflowchart TD');
    expect(result).toContain('Confirmar antes de: Valor da nota');
    expect(result).toContain('Faça 3 perguntas curtas');
    expect(result).toContain('média de 2 pessoa(s)');
    expect(result).not.toMatch(/mediaId|base64|data:image/);
    expect(result).not.toContain(MEDIA);
  });

  it('lookup with query "lançar nota fiscal" puts the matching activity steps first', async () => {
    const { handlers } = setup();
    const result = text(await handlers.handbook_lookup({ query: 'lançar nota fiscal' }));
    expect(result.indexOf('### Lançar NF')).toBeGreaterThan(-1);
    expect(result.indexOf('### Lançar NF')).toBeLessThan(result.indexOf('### Conferir extrato'));
    const unmatched = text(await handlers.handbook_lookup({ query: 'pagar fornecedor' }));
    expect(unmatched).toContain('Nenhuma atividade corresponde ao pedido');
    expect(unmatched.indexOf('### Conferir extrato')).toBeLessThan(unmatched.indexOf('### Lançar NF'));
  });

  it('show with an unknown activity id returns não encontrado and emits nothing', async () => {
    const { handlers, showHandbook } = setup();
    expect(await handlers.handbook_show({ activityId: 'nope' })).toEqual({ ok: false, error: 'não encontrado' });
    expect(showHandbook).not.toHaveBeenCalled();
    expect(await handlers.handbook_show({ activityId: ITEM })).toEqual({ ok: true, result: 'mostrado' });
    expect(showHandbook).toHaveBeenCalledWith({ activityId: ITEM });
  });

  const FIN_ITEM = '33333333-3333-4333-8333-333333333333';
  const finActivity = () => activity(FIN_ITEM, 'Conciliar banco', 'Concilia o banco', ['Abrir o banco']);

  it('an admin shows an activity of the role they looked up, read-only through that role', async () => {
    const { handlers, service, showHandbook } = setup({ admin: true, adminItems: [finActivity()] });
    await handlers.handbook_lookup({ role: 'Financeiro' });
    expect(await handlers.handbook_show({ activityId: FIN_ITEM })).toEqual({ ok: true, result: 'mostrado' });
    expect(showHandbook).toHaveBeenCalledWith({ activityId: FIN_ITEM, roleKey: 'financeiro' });
    expect(service.adminRole).toHaveBeenLastCalledWith('financeiro');
  });

  it('an admin may name the role in handbook_show directly', async () => {
    const { handlers, showHandbook } = setup({ admin: true, adminItems: [finActivity()] });
    expect(await handlers.handbook_show({ activityId: FIN_ITEM, role: 'Financeiro' })).toEqual({
      ok: true,
      result: 'mostrado',
    });
    expect(showHandbook).toHaveBeenCalledWith({ activityId: FIN_ITEM, roleKey: 'financeiro' });
  });

  it('an admin showing an activity of their own role gets the plain card', async () => {
    const { handlers, showHandbook } = setup({ admin: true, adminItems: [finActivity()] });
    await handlers.handbook_lookup({ role: 'Financeiro' });
    expect(await handlers.handbook_show({ activityId: ITEM })).toEqual({ ok: true, result: 'mostrado' });
    expect(showHandbook).toHaveBeenCalledWith({ activityId: ITEM });
  });

  it('an employee cannot show another role, by role or after a lookup', async () => {
    const { handlers, service, showHandbook } = setup({ adminItems: [finActivity()] });
    await handlers.handbook_lookup({ role: 'Financeiro' });
    expect(await handlers.handbook_show({ activityId: FIN_ITEM, role: 'Financeiro' })).toEqual({
      ok: false,
      error: 'não encontrado',
    });
    expect(service.adminRole).not.toHaveBeenCalled();
    expect(showHandbook).not.toHaveBeenCalled();
  });

  it('rejects malformed arguments', async () => {
    const { handlers } = setup();
    expect(await handlers.handbook_lookup({ query: 3 })).toEqual({ ok: false, error: 'pedido inválido' });
    expect(await handlers.handbook_show({})).toEqual({ ok: false, error: 'pedido inválido' });
    expect(await handlers.handbook_show({ activityId: ITEM, role: 3 })).toEqual({
      ok: false,
      error: 'pedido inválido',
    });
  });
});
