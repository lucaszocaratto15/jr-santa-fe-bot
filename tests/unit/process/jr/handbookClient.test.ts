import { afterEach, describe, expect, it, vi } from 'vitest';
import { JrAccessController } from '@/process/services/jr/auth';
import { createHandbookClient, type HandbookCall } from '@/process/services/jr/handbookClient';

const url = 'https://company.example/bot';
const token = 's'.repeat(64);
const ITEM_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';

afterEach(() => {
  vi.restoreAllMocks();
});

type Responder = (path: string, init?: RequestInit) => Response | undefined;

function controllerFor(user: Record<string, unknown>, respond: Responder = () => undefined, pilot = false) {
  let data: { deviceId: string; issuer: string; ownerId: string; token: string } | null = null;
  const store = {
    read: vi.fn(async () => data),
    write: vi.fn(async (value: typeof data) => {
      data = value;
    }),
  };
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(url.length);
    const custom = respond(path, init);
    if (custom) return custom;
    if (path === '/auth/login') return Response.json({ token, user });
    if (path === '/auth/session') return Response.json({ user });
    if (path === '/v1/models') return Response.json({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
    return Response.json({});
  });
  const controller = new JrAccessController({
    url,
    pilot,
    store,
    request,
    configureCore: vi.fn(async () => {}),
    stopCore: vi.fn(async () => {}),
    onChange: vi.fn(),
  });
  return { controller, request };
}

const employee = { id: 'employee-1', name: 'Ana', role: 'employee' };

describe('JrAccessController title and call()', () => {
  it('parses a session user without title as having no title (old servers)', async () => {
    const { controller } = controllerFor(employee);
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    expect(controller.state.user?.title ?? null).toBeNull();
  });

  it('reads the title of the session user', async () => {
    const { controller } = controllerFor({ ...employee, title: 'Auxiliar de escritório' });
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    expect(controller.state.user?.title).toBe('Auxiliar de escritório');
  });

  it('rejects a title over 80 chars from the server as invalid response', async () => {
    const { controller } = controllerFor({ ...employee, title: 'x'.repeat(81) });
    await controller.initialize();
    await expect(controller.login({ code: 'a-company-invite' })).rejects.toThrow();
    expect(controller.state.status).not.toBe('authenticated');
  });

  it('call() enforces admin for admin paths like authorized()', async () => {
    const { controller, request } = controllerFor(employee);
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    request.mockClear();
    await expect(controller.call('/admin/handbook/roles')).rejects.toThrow('JR_ACCESS_FORBIDDEN');
    await expect(controller.call('/handbook/mine', {}, true)).rejects.toThrow('JR_ACCESS_FORBIDDEN');
    expect(request).not.toHaveBeenCalled();
  });

  it('call() maps 409 no_role and 413', async () => {
    const { controller } = controllerFor(employee, (path) => {
      if (path === '/handbook/items') return Response.json({ error: { code: 'no_role' } }, { status: 409 });
      if (path === '/handbook/big') return Response.json({ error: { code: 'too_large' } }, { status: 413 });
      return undefined;
    });
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    await expect(controller.call('/handbook/items', { method: 'POST', body: '{}' })).rejects.toThrow(
      'JR_HANDBOOK_NO_ROLE'
    );
    await expect(controller.call('/handbook/big')).rejects.toThrow('JR_HANDBOOK_TOO_LARGE');
  });

  it('call() is unavailable in pilot mode', async () => {
    const { controller, request } = controllerFor(employee, undefined, true);
    await expect(controller.call('/handbook/mine')).rejects.toThrow('JR_ACCESS_UNCONFIGURED');
    expect(request).not.toHaveBeenCalled();
  });

  it('setEmployeeTitle posts to /admin/employees/:id/title', async () => {
    const { controller, request } = controllerFor({ id: 'owner', name: 'Lucas', role: 'admin' }, (path) =>
      path === '/admin/employees/employee-1/title' ? Response.json({ title: 'Financeiro' }) : undefined
    );
    await controller.initialize();
    await controller.login({ code: 'a-company-invite' });
    await expect(controller.setEmployeeTitle({ employeeId: 'employee-1', title: ' Financeiro ' })).resolves.toEqual({
      title: 'Financeiro',
    });
    const call = request.mock.calls.find(([input]) => String(input).endsWith('/title'));
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ title: 'Financeiro' });
  });
});

const payload = {
  role: { key: 'auxiliar de escritorio', title: 'Auxiliar de escritório' },
  items: [
    {
      id: ITEM_ID,
      kind: 'activity',
      source: 'taught',
      body: {
        title: 'Lançar NF',
        description: 'Lança a nota',
        frequency: 'daily',
        steps: [{ text: 'Abrir', mediaId: MEDIA_ID }],
        confirmBefore: ['Valor'],
      },
      approvedAt: 1,
      updatedAt: 2,
      media: [MEDIA_ID],
    },
  ],
  indicators: {
    activities: [{ title: 'Lançar NF', timesPerWeek: 5, minutesPerRun: 6 }],
    timePerApp: [{ app: 'Excel', minutesPerDay: 40 }],
    contributors: 2,
  },
};

describe('createHandbookClient', () => {
  it('validates and returns the role handbook', async () => {
    const call = vi.fn<HandbookCall>(async () => payload);
    await expect(createHandbookClient(call).mine()).resolves.toEqual(payload);
    expect(call).toHaveBeenCalledWith('/handbook/mine');
  });

  it('handbookClient maps 409 no_role to Error(no_role)', async () => {
    const client = createHandbookClient(async () => {
      throw new Error('JR_HANDBOOK_NO_ROLE');
    });
    await expect(
      client.publish({ id: ITEM_ID, kind: 'activity', source: 'taught', body: {}, media: [] })
    ).rejects.toThrow('no_role');
  });

  it('maps forbidden, too large and anything else to unavailable', async () => {
    const failing = (code: string) =>
      createHandbookClient(async () => {
        throw new Error(code);
      });
    await expect(failing('JR_ACCESS_FORBIDDEN').adminRoles()).rejects.toThrow('forbidden');
    await expect(failing('JR_HANDBOOK_TOO_LARGE').mine()).rejects.toThrow('too_large');
    await expect(failing('JR_ACCESS_UNCONFIGURED').mine()).rejects.toThrow('unavailable');
    await expect(failing('JR_ACCESS_UNAVAILABLE').mine()).rejects.toThrow('unavailable');
  });

  it('handbookClient rejects a payload whose item lacks media array', async () => {
    const broken = { ...payload, items: [{ ...payload.items[0], media: undefined }] };
    await expect(createHandbookClient(async () => broken).mine()).rejects.toThrow('unavailable');
  });

  it('rejects indicators with per-person shapes it does not know', async () => {
    const broken = { ...payload, indicators: { activities: [{ title: 'x' }], timePerApp: [], contributors: 1 } };
    await expect(createHandbookClient(async () => broken).mine()).rejects.toThrow('unavailable');
  });

  it('publishes with a long timeout and checks the echoed id', async () => {
    const call = vi.fn<HandbookCall>(async () => ({ id: ITEM_ID }));
    const input = { id: ITEM_ID, kind: 'activity' as const, source: 'taught' as const, body: { a: 1 }, media: [] };
    await expect(createHandbookClient(call).publish(input)).resolves.toEqual({ id: ITEM_ID });
    const init = call.mock.calls[0][1];
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it('admin calls use admin paths and encode the role key', async () => {
    const call = vi.fn<HandbookCall>(async () => payload);
    await createHandbookClient(call).adminRole('auxiliar de escritorio');
    expect(call).toHaveBeenCalledWith('/admin/handbook/roles/auxiliar%20de%20escritorio', {}, true);
  });

  it('refuses a media id that is not a uuid before calling', async () => {
    const call = vi.fn<HandbookCall>(async () => ({}));
    await expect(createHandbookClient(call).media('../admin')).rejects.toThrow('unavailable');
    expect(call).not.toHaveBeenCalled();
  });
});
