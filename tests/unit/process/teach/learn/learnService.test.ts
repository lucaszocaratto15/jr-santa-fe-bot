import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearnState } from '@/common/types/agent/learnTypes';
import { createLearnService, type LearnServiceDeps } from '@/process/services/teach/learn/learnService';
import { createInsightStore, createSampleStore, learnProfileDir } from '@/process/services/teach/learn/sampleStore';
import { createLearnSettings } from '@/process/services/teach/learn/learnSettings';
import { fakeEncryption, fakeSpawn } from './fakes';

const T0 = Date.parse('2026-10-29T12:00:00Z');
const connection = { url: 'http://127.0.0.1:1/v1', token: 't', model: 'MiniMax-M2' };
const modelReply = JSON.stringify({
  repetitivas: [{ titulo: 'Baixar NF', descricao: 'd', vezes: 3, minutos: 9 }],
  sugestoes: [],
});
const okRequest = () =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: modelReply } }] })));

let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'learn-service-'));
  root = join(base, 'jr-learn');
  // Most scenarios exercise an employee who has explicitly opted in.
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'settings.json'),
    JSON.stringify({ enabled: true, consentUserId: 'u1', consentedAt: T0 - 86_400_000, paused: false })
  );
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

type Env = {
  idle: number;
  locked: boolean;
  jrFocused: boolean;
  page: { url: string; title: string } | null;
  granted: boolean;
};

function harness(over: Partial<LearnServiceDeps> = {}, reply?: ((n: number) => string | null) | null) {
  const clock = { now: T0 };
  const intervals = new Map<number, { cb: () => void; ms: number }>();
  let nextId = 0;
  const emitted: LearnState[] = [];
  const { spawn, children } = fakeSpawn(reply);
  const env: Env = { idle: 0, locked: false, jrFocused: false, page: null, granted: true };
  const request = okRequest();
  const deps: LearnServiceDeps = {
    root,
    encryption: fakeEncryption(),
    platform: 'win32',
    spawn: spawn as never,
    now: () => clock.now,
    setInterval: (cb, ms) => {
      nextId += 1;
      intervals.set(nextId, { cb, ms });
      return nextId;
    },
    clearInterval: (handle) => {
      intervals.delete(handle as number);
    },
    idleSeconds: () => env.idle,
    isLocked: () => env.locked,
    jrFocused: () => env.jrFocused,
    jrBrowserPage: () => env.page,
    screenTitlesGranted: () => env.granted,
    currentUser: () => ({ id: 'u1', name: 'Ana' }),
    connection: () => connection,
    emit: (state) => emitted.push(state),
    request,
    ...over,
  };
  const service = createLearnService(deps);
  const tickTimers = () => [...intervals.values()].filter((timer) => timer.ms === 15_000);
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i += 1) {
      clock.now += 15_000;
      await service.tick();
    }
  };
  return { service, clock, emitted, spawn, children, env, request, tickTimers, ticks, deps };
}

const store = () => createSampleStore(learnProfileDir(root, 'u1'), fakeEncryption());
const stored = async () => store().readSince(0);
const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

async function seedSamples(count: number, start = T0 - 3_600_000) {
  const s = store();
  for (let i = 0; i < count; i += 1) await s.append({ t: start + i * 15_000, app: 'Excel', title: `NF ${i % 3}` });
}

describe('explicit observation consent', () => {
  it('a fresh install does not sample before explicit consent', async () => {
    await rm(join(root, 'settings.json'));
    const h = harness();
    expect((await h.service.init()).status).toBe('disabled');
    await h.ticks(2);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(await stored()).toEqual([]);
  });

  it('enabling consent starts collection, and revocation stops it without deleting history', async () => {
    await rm(join(root, 'settings.json'));
    const h = harness();
    await h.service.init();
    await h.service.setConsent(true);
    await h.ticks(1);
    await h.service.setConsent(false);
    await h.ticks(2);
    expect(h.service.state().status).toBe('disabled');
    expect(await stored()).toHaveLength(1);
  });

  it('an old settings file does not imply work-learning consent', async () => {
    await writeFile(join(root, 'settings.json'), JSON.stringify({ enabled: true, paused: false }));
    const h = harness();
    expect((await h.service.init()).status).toBe('disabled');
  });
});

describe('real work observation context', () => {
  it('starts no receipt before consent, and records no data from a callback invalidated by pause/resume', async () => {
    await rm(join(root, 'settings.json'));
    const h = harness();
    await h.service.init();
    expect(h.service.beginWorkEvent('erp.read')).toBeNull();
    await h.service.setConsent(true);
    const completed = h.service.beginWorkEvent('browser.download', { origin: 'https://portal.gov.br' });
    await h.service.pause();
    await h.service.resume();
    await completed?.();
    expect((await h.service.workflows.state()).routines).toEqual([]);
  });
  it('invalidates pending actions on consent revocation even when consent is granted again', async () => {
    const h = harness();
    await h.service.init();
    await h.service.setConsent(true);
    const completed = h.service.beginWorkEvent('erp.read');
    await h.service.setConsent(false);
    await h.service.setConsent(true);
    await completed?.();
    expect((await h.service.workflows.state()).routines).toEqual([]);
  });
  it('never credits a download or MCP call to a different employee or a later login of the same employee', async () => {
    let user: { id: string; name: string } | null = { id: 'u1', name: 'Ana' };
    const h = harness({ currentUser: () => user });
    await h.service.init();
    await h.service.setConsent(true);
    const completed = h.service.beginWorkEvent('browser.download', { origin: 'https://portal.gov.br' });
    user = null;
    await h.service.refreshProfile();
    user = { id: 'u2', name: 'Other' };
    await h.service.refreshProfile();
    await completed?.();
    expect((await h.service.workflows.state()).routines).toEqual([]);
    user = { id: 'u1', name: 'Ana' };
    await h.service.refreshProfile();
    await completed?.();
    expect((await h.service.workflows.state()).routines).toEqual([]);
  });
  it('records a successful receipt once and leaves it private until review', async () => {
    const h = harness();
    await h.service.init();
    await h.service.setConsent(true);
    const completed = h.service.beginWorkEvent('erp.read');
    await completed?.();
    await completed?.();
    const [routine] = (await h.service.workflows.state()).routines;
    expect(routine.steps).toHaveLength(1);
    expect(routine.status).toBe('candidate');
    expect(await h.service.workflows.monthly('2026-10')).toBeNull();
  });
  it('drops an in-flight storage write when the employee changes before it executes', async () => {
    let id = 'u1';
    const h = harness({ currentUser: () => ({ id, name: 'Fixture' }) });
    await h.service.init();
    await h.service.setConsent(true);
    const pending = h.service.beginWorkEvent('erp.read')?.();
    id = 'u2';
    await pending;
    expect((await h.service.workflows.state()).routines).toEqual([]);
  });
  it('does not widen an earlier sampler-only consent to include newly added event sources', async () => {
    const h = harness();
    await h.service.init();
    expect(h.service.state().workEventsEnabled).toBe(false);
    expect(h.service.beginWorkEvent('erp.read')).toBeNull();
    await h.service.setConsent(true);
    expect(h.service.state().workEventsEnabled).toBe(true);
    expect(h.service.beginWorkEvent('erp.read')).toBeTypeOf('function');
  });
  it('uses only a transient origin to enforce download exclusions at start and again before storage', async () => {
    const h = harness();
    await h.service.init();
    await h.service.setConsent(true);
    expect(h.service.beginWorkEvent('browser.download', { origin: 'https://itau.com.br' })).toBeNull();
    expect(
      h.service.beginWorkEvent('browser.download', { origin: 'https://portal.gov.br/file?token=private' })
    ).toBeNull();
    const complete = h.service.beginWorkEvent('browser.download', { origin: 'https://portal.gov.br' });
    expect(complete).toBeTypeOf('function');
    await h.service.setExclusions([{ id: 'private', kind: 'domain', pattern: 'portal.gov.br', builtin: false }]);
    await complete?.();
    expect((await h.service.workflows.state()).routines).toEqual([]);
  });
});

describe('login gate', () => {
  it('samples nothing while logged out, starts when a user appears, stops on logout', async () => {
    let user: { id: string; name: string } | null = null;
    const h = harness({ currentUser: () => user });
    await h.service.init();
    await h.ticks(3);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(await exists(join(root, 'samples'))).toBe(false);
    user = { id: 'u1', name: 'Ana' };
    await h.ticks(2);
    expect(await stored()).toHaveLength(2);
    user = null;
    await h.ticks(2);
    expect(await stored()).toHaveLength(2);
    expect(h.children[0].kill).toHaveBeenCalled();
  });

  it('the daily insights run also waits for a login', async () => {
    let user: { id: string; name: string } | null = null;
    const h = harness({ currentUser: () => user });
    await h.service.init();
    await seedSamples(150, T0 + 3_600_000);
    h.clock.now = T0 + 5 * 3_600_000;
    await h.service.hourly();
    expect(h.request).not.toHaveBeenCalled();
    user = { id: 'u1', name: 'Ana' };
    await h.service.hourly();
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});

describe('collection', () => {
  it('records the foreground sample from the child', async () => {
    const h = harness();
    await h.service.init();
    expect(h.spawn).not.toHaveBeenCalled();
    await h.ticks(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual([{ t: T0 + 15_000, app: 'EXCEL', title: 'NF.xlsx' }]);
    expect(h.service.state().rawHours).toBe(1);
  });

  it('tick while locked or idle >= 120 s writes nothing', async () => {
    const h = harness();
    await h.service.init();
    h.env.locked = true;
    await h.ticks(2);
    h.env.locked = false;
    h.env.idle = 120;
    await h.ticks(2);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(await stored()).toEqual([]);
  });

  it('tick while JR is focused records the in-app browser page and not the child', async () => {
    const h = harness();
    await h.service.init();
    h.env.jrFocused = true;
    h.env.page = { url: 'https://nfse.prefeitura.sp.gov.br/emitir', title: 'Emitir NF' };
    await h.ticks(1);
    h.env.page = null;
    await h.ticks(1);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(await stored()).toEqual([
      { t: T0 + 15_000, app: 'JR Bot', title: 'Emitir NF', url: 'https://nfse.prefeitura.sp.gov.br/emitir' },
      { t: T0 + 30_000, app: 'JR Bot', title: null },
    ]);
  });

  it('a secret window title is stored as app-only, never with the code', async () => {
    const h = harness({}, () => '{"app":"Outlook","title":"Seu código de verificação é 482913 - Outlook"}');
    await h.service.init();
    await h.ticks(1);
    expect(await stored()).toEqual([{ t: T0 + 15_000, app: 'Outlook', title: null }]);
    const raw = JSON.stringify(await stored());
    expect(raw).not.toMatch(/c[oó]digo/i);
    expect(raw).not.toContain('482913');
  });

  it('a title is redacted before it is stored', async () => {
    const h = harness({}, () => '{"app":"Chrome","title":"Pedido 9981234 - ana@exemplo.com"}');
    await h.service.init();
    await h.ticks(1);
    expect(await stored()).toEqual([{ t: T0 + 15_000, app: 'Chrome', title: 'Pedido # - [email]' }]);
  });

  it('a JR browser url is stored without its query string or fragment', async () => {
    const h = harness();
    await h.service.init();
    h.env.jrFocused = true;
    h.env.page = { url: 'https://portal.exemplo.com/clientes?cliente=Ana&cpf=12345678909#ficha', title: 'Clientes' };
    await h.ticks(1);
    const [sample] = await stored();
    expect(sample.url).toBe('https://portal.exemplo.com/clientes');
    expect(sample.url).not.toMatch(/[?#]/);
  });

  it('an exclusion still matches the raw title before redaction', async () => {
    const h = harness({}, () => '{"app":"Chrome","title":"Caixa de entrada - joao@gmail.com - Gmail"}');
    await h.service.init();
    await h.ticks(2);
    expect(await stored()).toEqual([]);
  });

  it('darwin: titles reported as app-only after many title-less samples despite the permission', async () => {
    const h = harness({ platform: 'darwin' }, () => '{"app":"Finder","title":null}');
    await h.service.init();
    expect(h.service.state().titles).toBe('full');
    await h.ticks(20);
    expect(h.service.state().titles).toBe('app-only');
  });

  it('darwin: one sample with a title clears the app-only notice', async () => {
    let titled = false;
    const h = harness({ platform: 'darwin' }, () =>
      titled ? '{"app":"Excel","title":"NF.xlsx"}' : '{"app":"Finder","title":null}'
    );
    await h.service.init();
    await h.ticks(20);
    titled = true;
    await h.ticks(1);
    expect(h.service.state().titles).toBe('full');
  });

  it('excluded sample is not written and leaves no trace', async () => {
    const h = harness({}, () => '{"app":"Google Chrome","title":"Itaú - Internet Banking"}');
    await h.service.init();
    await h.ticks(3);
    expect(h.spawn).toHaveBeenCalled();
    expect(await exists(join(root, 'samples'))).toBe(false);
    expect(h.service.state().rawHours).toBe(0);
  });

  it('an excluded JR browser site is not written', async () => {
    const h = harness();
    await h.service.init();
    h.env.jrFocused = true;
    h.env.page = { url: 'https://www2.bb.com.br/aapf/login', title: 'Login' };
    await h.ticks(1);
    expect(await stored()).toEqual([]);
  });

  it('a new exclusion applies on the next tick', async () => {
    const h = harness();
    await h.service.init();
    await h.service.setExclusions([{ id: 'x', kind: 'app', pattern: 'excel', builtin: false }]);
    await h.ticks(2);
    expect(await stored()).toEqual([]);
    expect(await h.service.getExclusions()).toEqual([{ id: 'x', kind: 'app', pattern: 'excel', builtin: false }]);
  });

  it('restoreDefaultExclusions brings removed defaults back and keeps custom rules', async () => {
    const h = harness();
    await h.service.init();
    const custom = { id: 'c', kind: 'title' as const, pattern: 'Salário', builtin: false };
    await h.service.setExclusions([custom]);
    const restored = await h.service.restoreDefaultExclusions();
    expect(restored.filter((rule) => rule.builtin).length).toBeGreaterThan(30);
    expect(restored).toContainEqual(custom);
  });

  it('a sampler that gave up stays failed and does not respawn 11 minutes later', async () => {
    const h = harness({}, () => 'garbage');
    await h.service.init();
    await h.ticks(4);
    expect(h.service.state().samplerError).toBe(true);
    h.clock.now += 11 * 60_000;
    await h.ticks(4);
    expect(h.spawn).toHaveBeenCalledTimes(3);
    expect(h.service.state().samplerError).toBe(true);
  });

  it('three sampler failures set samplerError, and resume() retries with a fresh child', async () => {
    const h = harness({}, () => 'garbage');
    await h.service.init();
    await h.ticks(4);
    expect(h.service.state().samplerError).toBe(true);
    expect(h.spawn).toHaveBeenCalledTimes(3);
    await h.service.resume();
    expect(h.service.state().samplerError).toBe(false);
    await h.ticks(1);
    expect(h.spawn).toHaveBeenCalledTimes(4);
  });
});

describe('persistent pause', () => {
  it('pause stops writes and remains paused after hours and explicit ticks', async () => {
    const h = harness();
    await h.service.init();
    await h.service.pause();
    h.clock.now += 5 * 3_600_000;
    await h.ticks(2);
    expect(h.service.state()).toMatchObject({ status: 'paused', pausedUntil: null });
    expect(await stored()).toEqual([]);
    await h.service.resume();
    await h.ticks(1);
    expect(await stored()).toHaveLength(1);
  });

  it('a pause never auto resumes after 15 minutes', async () => {
    const h = harness();
    await h.service.init();
    await h.service.pause();
    h.clock.now += 15 * 60_000;
    await h.ticks(1);
    expect(h.service.state().status).toBe('paused');
  });

  it('collection can be paused again after an explicit resume', async () => {
    const h = harness();
    await h.service.init();
    await h.service.pause();
    await h.service.resume();
    expect((await h.service.pause()).status).toBe('paused');
    await h.ticks(1);
    expect(await stored()).toEqual([]);
  });

  it('the next day does not override a pause', async () => {
    const h = harness();
    await h.service.init();
    await h.service.pause();
    h.clock.now += 86_400_000;
    await h.service.tick();
    expect(h.service.state().status).toBe('paused');
  });

  it('the paused flag is persisted without a timer deadline', async () => {
    const h = harness();
    await h.service.init();
    await h.service.pause();
    const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
    expect(settings.paused).toBe(true);
    expect(settings).not.toHaveProperty('pausedUntil');
  });

  it('a restart preserves a pause and does not start a child', async () => {
    const first = harness();
    await first.service.init();
    await first.service.pause();
    first.service.dispose();
    const second = harness();
    expect((await second.service.init()).status).toBe('paused');
    await second.ticks(2);
    expect(second.spawn).not.toHaveBeenCalled();
  });

  it('reports activeSince for the current active stretch only', async () => {
    const h = harness();
    await h.service.init();
    expect(h.service.state().activeSince).toBe(T0);
    await h.service.pause();
    expect(h.service.state().activeSince).toBeNull();
    h.clock.now += 60_000;
    expect((await h.service.resume()).activeSince).toBe(T0 + 60_000);
  });

  it('concurrent pause calls keep collection paused without a deadline', async () => {
    const h = harness();
    await h.service.init();
    await Promise.all([h.service.pause(), h.service.pause()]);
    expect(h.service.state()).toMatchObject({ status: 'paused', pausedUntil: null });
  });

  it('wipeSamples deletes raw samples but keeps insights, and Aprender keeps running', async () => {
    const h = harness();
    await h.service.init();
    await seedSamples(30);
    await h.service.generateNow();
    const state = await h.service.wipeSamples();
    expect(state.rawHours).toBe(0);
    expect(state.status).toBe('active');
    expect(await stored()).toEqual([]);
    expect(await h.service.listInsights()).toHaveLength(1);
  });

  it('generateNow works while paused', async () => {
    const h = harness();
    await h.service.init();
    await seedSamples(30);
    await h.service.pause();
    expect((await h.service.generateNow()).ok).toBe(true);
  });
});

describe('retention and insights runs', () => {
  it('expires old legacy raw observations without attributing, migrating or replaying recent legacy samples', async () => {
    const legacy = createSampleStore(root, fakeEncryption());
    await legacy.append({ t: T0 - 48 * 3_600_000, app: 'Expired legacy', title: null });
    await legacy.append({ t: T0, app: 'Recent legacy', title: null });
    const h = harness();
    await h.service.init();
    expect((await legacy.readSince(0)).map((sample) => sample.app)).toEqual(['Recent legacy']);
    expect(await stored()).toEqual([]);
    h.clock.now += 48 * 3_600_000;
    await h.service.hourly();
    expect(await legacy.readSince(0)).toEqual([]);
  });
  it('hourly purges stale samples and insights', async () => {
    await createSampleStore(learnProfileDir(root, 'u1'), fakeEncryption()).append({
      t: T0 - 50 * 3_600_000,
      app: 'old',
      title: null,
    });
    await createInsightStore(root, fakeEncryption()).add({
      id: 'old',
      createdAt: T0 - 91 * 86_400_000,
      periodStart: 0,
      periodEnd: 0,
      timePerApp: [],
      repetitive: [],
      suggestions: [],
    });
    const h = harness();
    await h.service.init();
    await h.service.hourly();
    expect(await stored()).toEqual([]);
    expect(await createInsightStore(root, fakeEncryption()).list()).toEqual([]);
  });

  it('a tick purges raw samples so none outlives 48 h', async () => {
    const hourStart = T0 - 47 * 3_600_000;
    await createSampleStore(learnProfileDir(root, 'u1'), fakeEncryption()).append({
      t: hourStart,
      app: 'old',
      title: null,
    });
    const h = harness();
    await h.service.init();
    h.env.locked = true; // No new sample: only the purge runs.
    await h.service.tick();
    expect(await stored()).toEqual([]);
  });

  it('a newly added exclusion also filters samples already on disk before the model call', async () => {
    const h = harness();
    await h.service.init();
    const s = store();
    for (let i = 0; i < 60; i += 1) {
      await s.append({ t: T0 + i * 15_000, app: i % 2 ? 'Excel' : 'MeuBanco', title: i % 2 ? 'NF.xlsx' : 'Extrato' });
    }
    await h.service.setExclusions([{ id: 'x', kind: 'app', pattern: 'meubanco', builtin: false }]);
    await h.service.generateNow();
    const body = JSON.parse(String((h.request.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[1].content).not.toMatch(/meubanco|extrato/i);
  });

  it('daily run needs 120 samples; max 3 attempts per day', async () => {
    const request = vi.fn(async () => new Response('', { status: 502 }));
    const h = harness({ request });
    await h.service.init();
    await seedSamples(150, T0 + 3_600_000);
    h.clock.now = T0 + 25 * 3_600_000;
    for (let i = 0; i < 5; i += 1) {
      await h.service.hourly();
      h.clock.now += 60_000;
    }
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('no second daily run within 24 h of a successful one', async () => {
    const h = harness();
    await h.service.init();
    await seedSamples(150, T0 + 3_600_000);
    h.clock.now = T0 + 5 * 3_600_000;
    await h.service.hourly();
    expect(h.request).toHaveBeenCalledTimes(1);
    h.clock.now += 20 * 3_600_000;
    await h.service.hourly();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('daily run skips when there are fewer than 120 samples', async () => {
    const h = harness();
    await h.service.init();
    await seedSamples(100, T0 + 3_600_000);
    h.clock.now = T0 + 25 * 3_600_000;
    await h.service.hourly();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('a successful daily run stores a batch and sets lastInsightsAt', async () => {
    const h = harness();
    await h.service.init();
    await seedSamples(150, T0 + 3_600_000);
    h.clock.now = T0 + 25 * 3_600_000;
    await h.service.hourly();
    expect(await h.service.listInsights()).toHaveLength(1);
    expect(h.service.state().lastInsightsAt).toBe(h.clock.now);
  });

  it('generateNow with < 20 samples returns no-data without calling the model', async () => {
    const h = harness();
    await h.service.init();
    await seedSamples(19);
    expect(await h.service.generateNow()).toEqual({ ok: false, code: 'no-data' });
    expect(h.request).not.toHaveBeenCalled();
  });

  it('generateNow while another run is in flight returns busy', async () => {
    let release!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const h = harness({ request });
    await h.service.init();
    await seedSamples(30);
    const first = h.service.generateNow();
    expect(await h.service.generateNow()).toEqual({ ok: false, code: 'busy' });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    release(new Response(JSON.stringify({ choices: [{ message: { content: modelReply } }] })));
    expect((await first).ok).toBe(true);
  });

  it('the summary sent to the model has no secret titles or e-mails', async () => {
    const h = harness();
    await h.service.init();
    const s = store();
    for (let i = 0; i < 30; i += 1) {
      await s.append({
        t: T0 + i * 15_000,
        app: 'Chrome',
        title: i % 2 ? 'Digite sua senha' : 'Caixa - ana@jrsantafe.com.br',
      });
    }
    await h.service.generateNow();
    const body = JSON.parse(String((h.request.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const summary: string = body.messages[1].content;
    expect(summary).not.toMatch(/senha/i);
    expect(summary).not.toContain('ana@jrsantafe.com.br');
  });
});

describe('availability', () => {
  it('unavailable when encryption is basic_text', async () => {
    const h = harness({ encryption: fakeEncryption('basic_text') });
    const state = await h.service.init();
    expect(state).toMatchObject({ status: 'unavailable', unavailableReason: 'encryption' });
    expect(await h.service.generateNow()).toEqual({ ok: false, code: 'unavailable' });
  });

  it('unavailable on linux', async () => {
    const h = harness({ platform: 'linux' });
    expect(await h.service.init()).toMatchObject({ status: 'unavailable', unavailableReason: 'platform' });
    await h.ticks(2);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('darwin without screen permission reports titles app-only', async () => {
    const h = harness({ platform: 'darwin', screenTitlesGranted: () => false });
    expect((await h.service.init()).titles).toBe('app-only');
  });

  it('dispose stops the timers and the child', async () => {
    const h = harness();
    await h.service.init();
    await h.ticks(1);
    h.service.dispose();
    expect(h.tickTimers()).toHaveLength(0);
    expect(h.children[0].kill).toHaveBeenCalled();
  });
});

describe('profile isolation and immediate collection controls', () => {
  it('never attributes legacy samples and wipes only current-profile plus legacy raw data, preserving other profiles', async () => {
    const legacy = createSampleStore(root, fakeEncryption());
    const other = createSampleStore(learnProfileDir(root, 'u2'), fakeEncryption());
    await legacy.append({ t: T0, app: 'Legacy', title: null });
    await other.append({ t: T0, app: 'Other', title: null });
    const h = harness();
    await h.service.init();
    await h.ticks(1);
    expect(h.service.state().rawHours).toBe(1);
    await h.service.wipeSamples();
    expect(await legacy.readSince(0)).toEqual([]);
    expect(await other.readSince(0)).toHaveLength(1);
    expect(await stored()).toEqual([]);
  });

  it('reads only the current profile when generating insights', async () => {
    const legacy = createSampleStore(root, fakeEncryption());
    const other = createSampleStore(learnProfileDir(root, 'u2'), fakeEncryption());
    await legacy.append({ t: T0, app: 'LegacyOnly', title: null });
    await other.append({ t: T0, app: 'OtherProfileOnly', title: null });
    await seedSamples(30);
    const h = harness();
    await h.service.init();
    await h.service.generateNow();
    const body = String((h.request.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).not.toMatch(/LegacyOnly|OtherProfileOnly/);
  });

  it.each(['pause', 'revoke'] as const)(
    'blocks collection immediately while %s persistence is pending',
    async (control) => {
      const realSettings = createLearnSettings(root);
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settings = {
        read: realSettings.read,
        write: async (patch: Parameters<typeof realSettings.write>[0]) => {
          await wait;
          return realSettings.write(patch);
        },
      };
      const h = harness({ settings });
      await h.service.init();
      const pending = control === 'pause' ? h.service.pause() : h.service.setConsent(false);
      await h.ticks(2);
      expect(h.spawn).not.toHaveBeenCalled();
      expect(await stored()).toEqual([]);
      release();
      await pending;
    }
  );

  it('auth refresh stops old polling and restarts it immediately for the consenting owner', async () => {
    let user: { id: string; name: string } | null = { id: 'u1', name: 'User' };
    const h = harness({ currentUser: () => user });
    await h.service.init();
    user = null;
    await h.service.refreshProfile();
    expect(h.tickTimers()).toHaveLength(0);
    user = { id: 'u1', name: 'User' };
    await h.service.refreshProfile();
    expect(h.tickTimers()).toHaveLength(1);
    await h.ticks(1);
    expect(await stored()).toHaveLength(1);
  });

  it('does not return former employee insights if identity changes during the read', async () => {
    let user = { id: 'u1', name: 'User' };
    const h = harness({ currentUser: () => user });
    await h.service.init();
    await seedSamples(30);
    await h.service.generateNow();
    const pending = h.service.listInsights();
    user = { id: 'u2', name: 'Other' };
    expect(await pending).toEqual([]);
  });
});

describe('private insight response persistence boundary', () => {
  it('does not return an old employee batch after identity changes during settings persistence', async () => {
    let user = { id: 'u1', name: 'User' };
    let release!: () => void;
    let entered!: () => void;
    const reachedWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSettings = createLearnSettings(root);
    const settings = {
      read: realSettings.read,
      write: async (patch: Parameters<typeof realSettings.write>[0]) => {
        entered();
        await wait;
        return realSettings.write(patch);
      },
    };
    const h = harness({ currentUser: () => user, settings });
    await h.service.init();
    await seedSamples(30);
    const pending = h.service.generateNow();
    await reachedWrite;
    user = { id: 'u2', name: 'Other' };
    release();
    const result = await pending;
    expect(result).toEqual({ ok: false, code: 'unavailable' });
    expect(result).not.toHaveProperty('batch');
  });
});
