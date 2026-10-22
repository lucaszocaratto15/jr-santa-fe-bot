import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { stopProcessGroup } from '../../../scripts/jr/pilot-support.mjs';

test(
  'cleanup stops an owned orphan without killing unrelated processes',
  { timeout: 4000, skip: process.platform === 'win32' },
  async (t) => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    t.after(() => unrelated.kill('SIGKILL'));
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    child.unref(); console.log(child.pid); setTimeout(()=>process.exit(0),150);
  `,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    t.after(() => {
      try {
        process.kill(-leader.pid, 'SIGKILL');
      } catch {}
    });
    const [data] = await once(leader.stdout, 'data');
    const orphanPid = Number(data.toString().trim());
    await once(leader, 'exit');
    process.kill(orphanPid, 0);
    await stopProcessGroup(leader.pid, 40);
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(orphanPid, 0);
      } catch {
        break;
      }
      await delay(20);
    }
    assert.throws(() => process.kill(orphanPid, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  }
);
