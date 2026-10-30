import { describe, expect, it, vi } from 'vitest';
import { createSampler, parseSampleLine } from '@/process/services/teach/learn/sampler';
import { MAC_SCRIPT, samplerCommand, WINDOWS_SCRIPT } from '@/process/services/teach/learn/samplerScripts';
import { fakeSpawn } from './fakes';

const make = (spawn: unknown, extra: { now?: () => number; timeoutMs?: number; firstTimeoutMs?: number } = {}) =>
  createSampler({
    spawn: spawn as never,
    platform: 'darwin',
    now: extra.now ?? (() => Date.now()),
    timeoutMs: extra.timeoutMs ?? 50,
    firstTimeoutMs: extra.firstTimeoutMs ?? 50,
  });

describe('parseSampleLine', () => {
  it('parses an app and title', () => {
    expect(parseSampleLine('{"app":"EXCEL","title":"NF.xlsx"}')).toEqual({ app: 'EXCEL', title: 'NF.xlsx' });
  });
  it('rejects an empty app and non-JSON', () => {
    expect(parseSampleLine('{"app":"","title":"x"}')).toBeNull();
    expect(parseSampleLine('not json')).toBeNull();
    expect(parseSampleLine('[1]')).toBeNull();
    expect(parseSampleLine('{"app":"X","title":5}')).toBeNull();
  });
  it('turns an empty title into null, trims and caps', () => {
    expect(parseSampleLine('{"app":"X","title":""}')).toEqual({ app: 'X', title: null });
    expect(parseSampleLine('\uFEFF{"app":" X ","title":null}')).toEqual({ app: 'X', title: null });
    expect(parseSampleLine(JSON.stringify({ app: 'A', title: 'b'.repeat(400) }))?.title).toHaveLength(300);
  });
});

describe('samplerCommand', () => {
  it('has no command on linux', () => {
    expect(samplerCommand('linux')).toBeNull();
  });
  it('runs an encoded PowerShell script on Windows', () => {
    const command = samplerCommand('win32', { SystemRoot: 'C:\\Windows' });
    expect(command?.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(command?.args).toContain('-EncodedCommand');
    const encoded = command?.args.at(-1) ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain('GetForegroundWindow');
  });
  it('runs JXA through osascript on macOS', () => {
    const command = samplerCommand('darwin');
    expect(command?.command).toBe('/usr/bin/osascript');
    expect(command?.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
  });
});

describe('sampler script bodies', () => {
  it('Windows reads one line per request, answers compact JSON and never hooks input', () => {
    expect(WINDOWS_SCRIPT).toContain('[Console]::In.ReadLine()');
    expect(WINDOWS_SCRIPT).toContain('if ($null -eq $request) { break }');
    expect(WINDOWS_SCRIPT).toContain('ConvertTo-Json -Compress');
    expect(WINDOWS_SCRIPT).toContain('GetWindowText');
    expect(WINDOWS_SCRIPT).toContain('GetWindowThreadProcessId');
    expect(WINDOWS_SCRIPT).not.toMatch(/SetWindowsHookEx|GetAsyncKeyState|GetKeyState|CopyFromScreen|Clipboard/);
  });
  it('macOS answers through stdout with JSON.stringify, reads only app and window name, never input', () => {
    expect(MAC_SCRIPT).toContain('JSON.stringify(obj)');
    expect(MAC_SCRIPT).toContain('fileHandleWithStandardOutput');
    expect(MAC_SCRIPT).toContain("'kCGWindowName'");
    expect(MAC_SCRIPT).toContain('frontmostApplication');
    expect(MAC_SCRIPT).toContain('if (data.length === 0) break;');
    expect(MAC_SCRIPT).not.toMatch(/CGEventTap|keystroke|CGWindowListCreateImage|NSPasteboard/);
  });
});

describe('createSampler', () => {
  it('returns null on an unsupported platform', () => {
    expect(createSampler({ spawn: vi.fn() as never, platform: 'linux', now: Date.now })).toBeNull();
  });

  it('does not spawn until the first sample() call', () => {
    const { spawn } = fakeSpawn();
    make(spawn);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('writes "s\\n" and resolves with the next stdout line', async () => {
    const { spawn, children } = fakeSpawn();
    const sampler = make(spawn)!;
    expect(await sampler.sample()).toEqual({ app: 'EXCEL', title: 'NF.xlsx' });
    expect(children[0].requests).toBe(1);
    expect(await sampler.sample()).toEqual({ app: 'EXCEL', title: 'NF.xlsx' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a second sample() while one is pending shares the same request', async () => {
    const { spawn, children } = fakeSpawn();
    const sampler = make(spawn)!;
    const [a, b] = await Promise.all([sampler.sample(), sampler.sample()]);
    expect(a).toEqual(b);
    expect(children[0].requests).toBe(1);
  });

  it('a well-formed reply with no app resolves null without counting a failure', async () => {
    const { spawn } = fakeSpawn(() => '{"app":"","title":null}');
    const sampler = make(spawn)!;
    expect(await sampler.sample()).toBeNull();
    expect(await sampler.sample()).toBeNull();
    expect(await sampler.sample()).toBeNull();
    expect(sampler.failed()).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('kills and respawns after a timeout, resolving null', async () => {
    const { spawn, children } = fakeSpawn((n) => (n === 1 ? null : '{"app":"A","title":null}'));
    const sampler = make(spawn)!;
    expect(await sampler.sample()).toBeNull();
    expect(children[0].kill).toHaveBeenCalled();
    expect(await sampler.sample()).toEqual({ app: 'A', title: null });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('an invalid line kills the child', async () => {
    const { spawn, children } = fakeSpawn(() => 'garbage');
    const sampler = make(spawn)!;
    expect(await sampler.sample()).toBeNull();
    expect(children[0].kill).toHaveBeenCalled();
  });

  it('reports failed() after 3 failures within 10 minutes and stops respawning', async () => {
    let clock = 0;
    const { spawn } = fakeSpawn(null);
    const sampler = make(spawn, { now: () => clock })!;
    for (let i = 0; i < 3; i += 1) {
      clock += 60_000;
      expect(await sampler.sample()).toBeNull();
    }
    expect(sampler.failed()).toBe(true);
    expect(await sampler.sample()).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('once it gave up it stays failed after the 10-minute window and never respawns', async () => {
    let clock = 0;
    const { spawn } = fakeSpawn(null);
    const sampler = make(spawn, { now: () => clock })!;
    for (let i = 0; i < 3; i += 1) {
      clock += 60_000;
      await sampler.sample();
    }
    clock += 11 * 60_000;
    expect(sampler.failed()).toBe(true);
    expect(await sampler.sample()).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('old failures decay: two failures, then a third after 10 minutes, do not give up', async () => {
    let clock = 0;
    const { spawn } = fakeSpawn(null);
    const sampler = make(spawn, { now: () => clock })!;
    await sampler.sample();
    clock += 60_000;
    await sampler.sample();
    clock += 10 * 60_000;
    await sampler.sample();
    expect(sampler.failed()).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('the first reply after a spawn gets the longer startup timeout', async () => {
    const { spawn, children } = fakeSpawn(null);
    const sampler = make(spawn, { timeoutMs: 20, firstTimeoutMs: 1_000 })!;
    const first = sampler.sample();
    setTimeout(() => children[0].stdout.write('{"app":"A","title":null}\n'), 100);
    expect(await first).toEqual({ app: 'A', title: null });
    expect(children[0].kill).not.toHaveBeenCalled();
    // Later requests use the short timeout.
    expect(await sampler.sample()).toBeNull();
    expect(children[0].kill).toHaveBeenCalled();
  });

  it('failures spread over more than 10 minutes do not trip failed()', async () => {
    let clock = 0;
    const { spawn } = fakeSpawn(null);
    const sampler = make(spawn, { now: () => clock })!;
    for (let i = 0; i < 3; i += 1) {
      clock += 6 * 60_000;
      await sampler.sample();
    }
    expect(sampler.failed()).toBe(false);
  });

  it('stop() kills the child and later sample() resolves null without spawning', async () => {
    const { spawn, children } = fakeSpawn();
    const sampler = make(spawn)!;
    await sampler.sample();
    sampler.stop();
    expect(children[0].kill).toHaveBeenCalled();
    expect(await sampler.sample()).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('handles two JSON lines arriving in one chunk', async () => {
    const { spawn, children } = fakeSpawn(null);
    const sampler = make(spawn, { timeoutMs: 1000 })!;
    const first = sampler.sample();
    children[0].stdout.write('{"app":"A","title":null}\n{"app":"B","title":null}\n');
    expect(await first).toEqual({ app: 'A', title: null });
    // The stray second line is not handed to the next request.
    children[0].stdout.write('{"app":"C","title":null}\n');
    const second = sampler.sample();
    children[0].stdout.write('{"app":"D","title":null}\n');
    expect(await second).toEqual({ app: 'D', title: null });
  });

  it('a child that exits mid-request resolves null', async () => {
    const { spawn, children } = fakeSpawn(null);
    const sampler = make(spawn, { timeoutMs: 1000 })!;
    const pending = sampler.sample();
    children[0].emit('exit', 1, null);
    expect(await pending).toBeNull();
  });

  it('a spawn error resolves null', async () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const sampler = make(spawn)!;
    expect(await sampler.sample()).toBeNull();
  });
});
