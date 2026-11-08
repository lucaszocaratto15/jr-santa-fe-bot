import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { OsEncryption } from '@/process/services/jr/auth';

export type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  requests: number;
};

/** Fake `spawn`: `reply(n)` answers the n-th request overall; null (or no `reply`) stays silent. */
export function fakeSpawn(reply: ((n: number) => string | null) | null = () => '{"app":"EXCEL","title":"NF.xlsx"}') {
  const children: FakeChild[] = [];
  let total = 0;
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.requests = 0;
    child.kill = vi.fn(() => {
      child.emit('exit', null, 'SIGTERM');
      return true;
    });
    child.stdin.on('data', (chunk: Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch !== '\n') continue;
        child.requests += 1;
        total += 1;
        const line = reply?.(total) ?? null;
        // A real child answers asynchronously.
        if (line !== null) setImmediate(() => child.stdout.write(`${line}\n`));
      }
    });
    children.push(child);
    return child;
  });
  return { spawn, children };
}

/** Reversible, non-identity "encryption" so plaintext checks are meaningful. */
export const fakeEncryption = (backend = 'keychain'): OsEncryption => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: (text: string) => Buffer.from(text.split('').toReversed().join('')),
  decryptString: (buffer: Buffer) => buffer.toString().split('').toReversed().join(''),
});
