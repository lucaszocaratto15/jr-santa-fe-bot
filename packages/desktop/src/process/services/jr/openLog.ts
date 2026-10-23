import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

/** Hide bearer tokens and long hex secrets before a field log is written. */
export function redactJrLog(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]');
}

export function formatJrOpenLog(entry: { message: string; stack?: string }, now = new Date()): string {
  const message = redactJrLog(entry.message).slice(0, 8000);
  const stack = entry.stack ? redactJrLog(entry.stack).slice(0, 16000) : '';
  return `${now.toISOString()} ${message}${stack ? `\n${stack}` : ''}\n`;
}

/** Append one open failure to `userData/logs/jr.log`. A file past 1 MB starts over. */
export async function appendJrOpenLog(
  userData: string,
  entry: { message: string; stack?: string },
  now = new Date()
): Promise<void> {
  const directory = join(userData, 'logs');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'jr.log');
  const line = formatJrOpenLog(entry, now);
  try {
    const info = await stat(file);
    if (info.size > MAX_BYTES) {
      await writeFile(file, line, 'utf8');
      return;
    }
  } catch {
    // The first failure creates the file.
  }
  await appendFile(file, line, 'utf8');
}
