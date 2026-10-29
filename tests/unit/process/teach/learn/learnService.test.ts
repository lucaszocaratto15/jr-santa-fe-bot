import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEARN_TERM_VERSION, type LearnState } from '@/common/types/agent/learnTypes';
import { createLearnService, type LearnServiceDeps } from '@/process/services/teach/learn/learnService';
import { createInsightStore, createSampleStore } from '@/process/services/teach/learn/sampleStore';
import { fakeEncryption, fakeSpawn } from './fakes';

const T0 = Date.parse('2026-10-29T12:00:00Z');
const connection = { url: 'http://127.0.0.1:1/v1', token: 't', model: 'MiniMax-M2' };
const modelReply = JSON.stringify({ repetitivas: [{ titulo: 'Baixar NF', descricao: 'd', vezes: 3, minutos: 9 }], sugestoes: [] });
const okRequest = () =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: modelReply } }] })));

let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'learn-service-'));
  root = join(base, 'jr-learn');
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
  const onRevoke = vi.fn(async () => {});
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
    onRevoke,
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
  return { service, clock, emitted, spawn, children, env, request, onRevoke, tickTimers, ticks, deps };
}

const store = () => createSampleStore(root, fakeEncryption());
const stored = async () => store().readSince(0);
const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

async function seedConsent(termVersion: string, enabled = true) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'settings.json'), JSON.stringify({ enabled }));
  await writeFile(
    join(root, 'consent.json'),
    JSON.stringify({ events: [{ type: 'accept', termVersion, at: '2026-01-01T00:00:00.000Z', user: null }] })
  );
}

async function seedSamples(count: number, start = T0 - 3_600_000) {
  const s = store();
  for (let i = 0; i < count; i += 1) await s.append({ t: start + i * 15_000, app: 'Excel', title: `NF ${i % 3}` });
}

describe('before consent', () => {
  it('fresh install: state off, no spawn, no samples dir after 10 ticks', async () => {
    const h = harness();
    expect((await h.service.init()).status).toBe('off');
    expect(h.tickTimers()).toHaveLength(0);
    await h.ticks(10);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(await exists(join(root, 'samples'))).toBe(false);
    expect(await exists(root)).toBe(false);
  });

  it('accept with an old version is refused and records nothing', async () => {
    const h = harness();
    await h.service.init();
    await expect(h.service.accept('1.1')).rejects.toThrow('LEARN_TERM_VERSION');
    expect(await exists(join(root, 'consent.json'))).toBe(false);
    expect(h.service.state().status).toBe('off');
  });

  it('accept(1.2) records user, version and time, then becomes active', async () => {
    const h = harness();
    await h.service.init();
    const state = await h.service.accept(LEARN_TERM_VERSION);
    expect(state.status).toBe('active');
    expect(state.acceptedVersion).toBe('1.2');
    const consent = JSON.parse(await readFile(join(root, 'consent.json'), 'utf8'));
    expect(consent.events).toEqual([
      { type: 'accept', termVersion: '1.2', at: new Date(T0).toISOString(), user: { id: 'u1', name: 'Ana' } },
    ]);
    expect(h.tickTimers()).toHaveLength(1);
    expect(h.emitted.at(-1)?.status).toBe('active');
  });

  it('enabled with a v1.0 accept on disk → needs-consent and never spawns', async () => {
    await seedConsent('1.0');
    const h = harness();
    const state = await h.service.init();
    expect(state.status).toBe('needs-consent');
    expect(state.acceptedVersion).toBe('1.0');
    expect(h.tickTimers()).toHaveLength(0);
    await h.ticks(5);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(await exists(join(root, 'samples'))).toBe(false);
    await expect(h.service.turnOn()).rejects.toThrow('LEARN_NEEDS_CONSENT');
  });
});

describe('collection', () => {
  it('records the foreground sample from the child', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    expect(h.spawn).not.toHaveBeenCalled();
    await h.ticks(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual([{ t: T0 + 15_000, app: 'EXCEL', title: 'NF.xlsx' }]);
    expect(h.service.state().rawHours).toBe(1);
  });

  it('tick while locked or idle >= 120 s writes nothing', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
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
    await h.service.accept(LEARN_TERM_VERSION);
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

  it('excluded sample is not written and leaves no trace', async () => {
    const h = harness({}, () => '{"app":"Google Chrome","title":"Itaú - Internet Banking"}');
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.ticks(3);
    expect(h.spawn).toHaveBeenCalled();
    expect(await exists(join(root, 'samples'))).toBe(false);
    expect(h.service.state().rawHours).toBe(0);
  });

  it('an excluded JR browser site is not written', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    h.env.jrFocused = true;
    h.env.page = { url: 'https://www2.bb.com.br/aapf/login', title: 'Login' };
    await h.ticks(1);
    expect(await stored()).toEqual([]);
  });

  it('a new exclusion applies on the next tick', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.service.setExclusions([{ id: 'x', kind: 'app', pattern: 'excel', builtin: false }]);
    await h.ticks(2);
    expect(await stored()).toEqual([]);
    expect(await h.service.getExclusions()).toEqual([{ id: 'x', kind: 'app', pattern: 'excel', builtin: false }]);
  });

  it('three sampler failures set samplerError, and resume() retries with a fresh child', async () => {
    const h = harness({}, () => 'garbage');
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.ticks(4);
    expect(h.service.state().samplerError).toBe(true);
    expect(h.spawn).toHaveBeenCalledTimes(3);
    await h.service.resume();
    expect(h.service.state().samplerError).toBe(false);
    await h.ticks(1);
    expect(h.spawn).toHaveBeenCalledTimes(4);
  });
});

describe('pause, off and revoke', () => {
  it('pause(60) stops writing; the first tick after pausedUntil resumes and emits once', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    const paused = await h.service.pause(60);
    expect(paused.status).toBe('paused');
    expect(paused.pausedUntil).toBe(T0 + 3_600_000);
    await h.ticks(3);
    expect(await stored()).toEqual([]);
    expect(h.children[0]?.requests ?? 0).toBe(0);
    // The machine slept past the end of the pause.
    h.clock.now = T0 + 5 * 3_600_000;
    h.env.locked = true; // Isolate the resume from a sample write.
    const before = h.emitted.length;
    await h.service.tick();
    expect(h.emitted.slice(before)).toEqual([expect.objectContaining({ status: 'active', pausedUntil: null })]);
    h.env.locked = false;
    await h.service.tick();
    expect(await stored()).toHaveLength(1);
  });

  it('pause(null) stays paused until resume()', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.service.pause(null);
    h.clock.now += 30 * 86_400_000;
    await h.service.tick();
    expect(h.service.state().status).toBe('paused');
    expect(await stored()).toEqual([]);
    expect((await h.service.resume()).status).toBe('active');
  });

  it('rejects an invalid pause length', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await expect(h.service.pause(-5)).rejects.toThrow('LEARN_BAD_PAUSE');
  });

  it('turnOff keeps consent and insights; re-enable does not need a new accept', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.ticks(1);
    await seedSamples(30);
    expect((await h.service.generateNow()).ok).toBe(true);
    const off = await h.service.turnOff();
    expect(off.status).toBe('off');
    expect(off.acceptedVersion).toBe('1.2');
    expect(h.children[0].kill).toHaveBeenCalled();
    expect(h.tickTimers()).toHaveLength(0);
    expect(await h.service.listInsights()).toHaveLength(1);
    expect((await h.service.turnOn()).status).toBe('active');
  });

  it('revoke wipes samples and insights and needs a new accept', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.ticks(1);
    await seedSamples(30);
    await h.service.generateNow();
    const state = await h.service.revoke();
    expect(state.status).toBe('off');
    expect(state.acceptedVersion).toBeNull();
    expect(state.rawHours).toBe(0);
    expect(await exists(join(root, 'samples'))).toBe(false);
    expect(await exists(join(root, 'insights.bin'))).toBe(false);
    expect(await h.service.listInsights()).toEqual([]);
    expect(h.children[0].kill).toHaveBeenCalled();
    const consent = JSON.parse(await readFile(join(root, 'consent.json'), 'utf8'));
    expect(consent.events.map((e: { type: string }) => e.type)).toEqual(['accept', 'revoke']);
    await expect(h.service.turnOn()).rejects.toThrow('LEARN_NEEDS_CONSENT');
    await h.ticks(2);
    expect(await exists(join(root, 'samples'))).toBe(false);
  });

  it('revoke during generateNow writes no batch', async () => {
    let release!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const h = harness({ request });
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await seedSamples(30);
    const run = h.service.generateNow();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const revoked = h.service.revoke();
    release(new Response(JSON.stringify({ choices: [{ message: { content: modelReply } }] })));
    expect((await run).ok).toBe(false);
    await revoked;
    expect(await exists(join(root, 'insights.bin'))).toBe(false);
    expect(await h.service.listInsights()).toEqual([]);
  });

  it('revoke calls onRevoke after the local wipe and still resolves off when it rejects', async () => {
    const onRevoke = vi.fn(async () => {
      expect(await exists(join(root, 'samples'))).toBe(false);
      throw new Error('server down');
    });
    const h = harness({ onRevoke });
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.ticks(1);
    expect((await h.service.revoke()).status).toBe('off');
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  it('wipeSamples deletes raw samples but keeps consent and insights', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await seedSamples(30);
    await h.service.generateNow();
    const state = await h.service.wipeSamples();
    expect(state.rawHours).toBe(0);
    expect(state.status).toBe('active');
    expect(await stored()).toEqual([]);
    expect(await h.service.listInsights()).toHaveLength(1);
  });
});

describe('retention and insights runs', () => {
  it('hourly purges even when off', async () => {
    await createSampleStore(root, fakeEncryption()).append({ t: T0 - 50 * 3_600_000, app: 'old', title: null });
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
    expect(h.service.state().status).toBe('off');
    await h.service.hourly();
    expect(await stored()).toEqual([]);
    expect(await createInsightStore(root, fakeEncryption()).list()).toEqual([]);
  });

  it('daily run waits for 24 h and 120 samples; max 3 attempts per day', async () => {
    const request = vi.fn(async () => new Response('', { status: 502 }));
    const h = harness({ request });
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await seedSamples(150, T0 + 3_600_000);
    h.clock.now = T0 + 20 * 3_600_000;
    await h.service.hourly();
    expect(request).not.toHaveBeenCalled(); // < 24 h since the accept
    h.clock.now = T0 + 25 * 3_600_000;
    for (let i = 0; i < 5; i += 1) {
      await h.service.hourly();
      h.clock.now += 60_000;
    }
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('daily run skips when there are fewer than 120 samples', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await seedSamples(100, T0 + 3_600_000);
    h.clock.now = T0 + 25 * 3_600_000;
    await h.service.hourly();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('a successful daily run stores a batch and sets lastInsightsAt', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await seedSamples(150, T0 + 3_600_000);
    h.clock.now = T0 + 25 * 3_600_000;
    await h.service.hourly();
    expect(await h.service.listInsights()).toHaveLength(1);
    expect(h.service.state().lastInsightsAt).toBe(h.clock.now);
  });

  it('generateNow with < 20 samples returns no-data without calling the model', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
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
    await h.service.accept(LEARN_TERM_VERSION);
    await seedSamples(30);
    const first = h.service.generateNow();
    expect(await h.service.generateNow()).toEqual({ ok: false, code: 'busy' });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    release(new Response(JSON.stringify({ choices: [{ message: { content: modelReply } }] })));
    expect((await first).ok).toBe(true);
  });

  it('generateNow without a current accept is unavailable', async () => {
    const h = harness();
    await h.service.init();
    expect(await h.service.generateNow()).toEqual({ ok: false, code: 'unavailable' });
  });

  it('the summary sent to the model has no secret titles or e-mails', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    const s = store();
    for (let i = 0; i < 30; i += 1) {
      await s.append({ t: T0 + i * 15_000, app: 'Chrome', title: i % 2 ? 'Digite sua senha' : 'Caixa - ana@jrsantafe.com.br' });
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
    await expect(h.service.accept(LEARN_TERM_VERSION)).rejects.toThrow('LEARN_UNAVAILABLE');
  });

  it('unavailable on linux even with a stored accept', async () => {
    await seedConsent('1.2');
    const h = harness({ platform: 'linux' });
    expect(await h.service.init()).toMatchObject({ status: 'unavailable', unavailableReason: 'platform' });
    await h.ticks(2);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('darwin without screen permission reports titles app-only', async () => {
    const h = harness({ platform: 'darwin', screenTitlesGranted: () => false });
    expect((await h.service.init()).titles).toBe('app-only');
  });

  it('a stored v1.2 accept with enabled settings starts active after a restart', async () => {
    await seedConsent('1.2');
    const h = harness();
    expect((await h.service.init()).status).toBe('active');
    expect(h.tickTimers()).toHaveLength(1);
  });

  it('dispose stops the timers and the child', async () => {
    const h = harness();
    await h.service.init();
    await h.service.accept(LEARN_TERM_VERSION);
    await h.ticks(1);
    h.service.dispose();
    expect(h.tickTimers()).toHaveLength(0);
    expect(h.children[0].kill).toHaveBeenCalled();
  });
});
