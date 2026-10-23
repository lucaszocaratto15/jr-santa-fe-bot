import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendJrOpenLog, redactJrLog } from '@/process/services/jr/openLog';

it('redacts secrets before appending the open failure to userData/logs/jr.log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-log-'));
  const secret = 'd'.repeat(64);
  await appendJrOpenLog(
    root,
    { message: `Bearer ${secret}`, stack: `at open (${secret})` },
    new Date('2026-10-23T01:32:00.000Z')
  );
  const text = await readFile(join(root, 'logs', 'jr.log'), 'utf8');
  expect(text).toContain('2026-10-23T01:32:00.000Z Bearer [redacted]');
  expect(text).not.toContain(secret);
  expect(redactJrLog(`token ${secret}`)).toBe('token [redacted]');
});

it('starts a new log when the file is already past the size cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-log-'));
  const file = join(root, 'logs', 'jr.log');
  await appendJrOpenLog(root, { message: 'first' }, new Date('2026-10-23T01:00:00.000Z'));
  await writeFile(file, `${'x'.repeat(1024 * 1024 + 1)}\n`);
  await appendJrOpenLog(root, { message: 'second' }, new Date('2026-10-23T01:32:00.000Z'));
  const text = await readFile(file, 'utf8');
  expect(text).toBe('2026-10-23T01:32:00.000Z second\n');
  expect(text).not.toContain('first');
});
