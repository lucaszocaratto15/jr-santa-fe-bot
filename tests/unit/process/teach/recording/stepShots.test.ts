import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createShotTaker,
  decideShot,
  extractShotRefs,
  type ShotDecision,
} from '@/process/services/teach/recording/stepShots';

afterEach(() => {
  vi.useRealTimers();
});

const base = { eventSecret: false, secretDirty: false, liveSecret: false, taken: 0, max: 40 };

describe('decideShot', () => {
  it('skips secret events, dirty tabs, live secrets and the limit', () => {
    expect(decideShot({ ...base, eventSecret: true })).toEqual({ take: false, reason: 'secret-event' });
    expect(decideShot({ ...base, secretDirty: true })).toEqual({ take: false, reason: 'secret-dirty' });
    expect(decideShot({ ...base, liveSecret: true })).toEqual({ take: false, reason: 'live-secret' });
    expect(decideShot({ ...base, taken: 40 })).toEqual({ take: false, reason: 'limit' });
    expect(decideShot(base)).toEqual({ take: true });
  });
});

const setup = (encode: (jpeg: Buffer, quality: number) => Buffer | null = (jpeg) => jpeg) => {
  const writes: Array<{ n: number; data: Buffer }> = [];
  const capture = vi.fn(async () => Buffer.from('raw-jpeg'));
  const taker = createShotTaker({
    capture,
    encode,
    write: async (n, data) => {
      writes.push({ n, data });
    },
  });
  return { taker, writes, capture };
};

describe('createShotTaker', () => {
  it('takes a shot 800 ms after the event', async () => {
    vi.useFakeTimers();
    const { taker, writes } = setup();
    taker.schedule(0, () => ({ take: true }));
    await vi.advanceTimersByTimeAsync(799);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await taker.flush()).toEqual(new Map([[0, 1]]));
    expect(writes.map((w) => w.n)).toEqual([1]);
  });

  it('re-checks at capture time: a vault fill during the 800 ms delay skips the shot', async () => {
    vi.useFakeTimers();
    const { taker, writes, capture } = setup();
    let live = false;
    taker.schedule(0, () => decideShot({ ...base, liveSecret: live }));
    await vi.advanceTimersByTimeAsync(400);
    live = true;
    await vi.advanceTimersByTimeAsync(400);
    expect(await taker.flush()).toEqual(new Map());
    expect(capture).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('drops the image when a secret appears while the capture is in flight', async () => {
    let secret = false;
    const writes: number[] = [];
    const taker = createShotTaker({
      capture: async () => {
        secret = true;
        return Buffer.from('raw');
      },
      encode: (jpeg) => jpeg,
      write: async (n) => {
        writes.push(n);
      },
      delayMs: 0,
    });
    taker.schedule(0, () => decideShot({ ...base, secretDirty: secret }));
    expect(await taker.flush()).toEqual(new Map());
    expect(writes).toEqual([]);
  });

  it('coalesces a click and the navigation it causes into one shot', async () => {
    vi.useFakeTimers();
    const { taker, writes } = setup();
    taker.schedule(3, () => ({ take: true }));
    await vi.advanceTimersByTimeAsync(300);
    taker.schedule(4, () => ({ take: true }));
    await vi.advanceTimersByTimeAsync(800);
    expect(await taker.flush()).toEqual(new Map([[4, 1]]));
    expect(writes).toHaveLength(1);
  });

  it('retries at q40 when q60 is over 300 KB and skips when still over', async () => {
    const big = Buffer.alloc(300 * 1024 + 1);
    const small = Buffer.alloc(10);
    const qualities: number[] = [];
    const fits = setup((_jpeg, quality) => {
      qualities.push(quality);
      return quality === 60 ? big : small;
    });
    fits.taker.schedule(0, () => ({ take: true }));
    expect(await fits.taker.flush()).toEqual(new Map([[0, 1]]));
    expect(qualities).toEqual([60, 40]);
    expect(fits.writes[0].data).toBe(small);

    const never = setup(() => big);
    never.taker.schedule(0, () => ({ take: true }));
    expect(await never.taker.flush()).toEqual(new Map());
    expect(never.writes).toHaveLength(0);
  });

  it('numbers shots in order and stops at the limit', async () => {
    const { taker } = setup();
    const decide = (): ShotDecision => decideShot({ ...base, taken: taker.count(), max: 2 });
    for (const index of [0, 1, 2]) {
      taker.schedule(index, decide);
      // flush runs the pending shot at once
      // eslint-disable-next-line no-await-in-loop
      await taker.flush();
    }
    expect(await taker.flush()).toEqual(
      new Map([
        [0, 1],
        [1, 2],
      ])
    );
  });

  it('a failed capture writes nothing', async () => {
    const taker = createShotTaker({
      capture: async () => {
        throw new Error('detached');
      },
      encode: (jpeg) => jpeg,
      write: vi.fn(),
    });
    taker.schedule(0, () => ({ take: true }));
    expect(await taker.flush()).toEqual(new Map());
  });
});

describe('extractShotRefs', () => {
  it('lists cited shots once, in order', () => {
    expect(extractShotRefs('1. Abrir [tela 1]\n2. Entrar [tela 2] [tela 3]')).toEqual([1, 2, 3]);
    expect(extractShotRefs('[tela 2] e de novo [tela 2], [tela 0], [tela x]')).toEqual([2]);
  });
});
