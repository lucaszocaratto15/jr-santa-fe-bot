import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

const compose = read('services/control/deploy/compose.yml');
const traefik = read('services/control/deploy/traefik.yml');

/** Returns the text block of a top-level compose service (up to the next 2-space-indented key). */
const serviceBlock = (text, name) => {
  const match = text.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, 'm'));
  assert.ok(match, `service ${name} missing`);
  return match[1];
};

const copiedFiles = (dockerfile) =>
  [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(.+?)\s+\.\/\s*$/gm)].flatMap((m) =>
    m[1].split(/\s+/).filter((f) => f.endsWith('.mjs'))
  );

test('brain service is internal only: no ports, no traefik labels', () => {
  const brain = serviceBlock(compose, 'brain');
  assert.doesNotMatch(brain, /^\s+ports:/m);
  assert.doesNotMatch(brain, /traefik/i);
  assert.doesNotMatch(traefik, /brain/);
});

test('brain and control share the private jr-internal network', () => {
  assert.match(serviceBlock(compose, 'brain'), /networks:\n\s+- jr-internal/);
  assert.match(serviceBlock(compose, 'control'), /networks:\n(?:\s+- .+\n)*?\s+- jr-internal/);
  assert.match(compose, /^networks:\n\s+jr-internal:/m);
});

test('brain env wiring and hardening', () => {
  const brain = serviceBlock(compose, 'brain');
  for (const needle of [
    'BRAIN_SECRET: ${BRAIN_SECRET:?',
    'BRAIN_PORT: 8790',
    'BRAIN_DB_PATH: /data/brain.sqlite',
    'BRAIN_MODEL_URL: ${BRAIN_MODEL_URL:-https://api.minimax.io/v1}',
    'BRAIN_MODEL_KEY: ${BRAIN_MODEL_KEY:-}',
    'BRAIN_MODEL: ${BRAIN_MODEL:-MiniMax-M3.1-Flash}',
    'BRAIN_DAILY_CURATOR_CALLS: ${BRAIN_DAILY_CURATOR_CALLS:-500}',
    'brain_data:/data',
    'read_only: true',
    '/tmp:rw,noexec,nosuid',
    '- ALL',
    'no-new-privileges:true',
    'pids_limit: 128',
    'mem_limit: 512m',
    '/health',
  ]) {
    assert.ok(brain.includes(needle), `brain missing: ${needle}`);
  }
  const control = serviceBlock(compose, 'control');
  assert.ok(control.includes('BRAIN_URL: http://brain:8790'));
  assert.ok(control.includes('BRAIN_SECRET: ${BRAIN_SECRET:?'));
  assert.match(compose, /^volumes:\n(?:\s+.+\n)*?\s+brain_data:/m);
});

for (const dir of ['control', 'brain']) {
  test(`${dir} .dockerignore allowlists every .mjs the Dockerfile copies`, () => {
    const files = copiedFiles(read(`services/${dir}/Dockerfile`));
    assert.ok(files.length > 0);
    const ignore = read(`services/${dir}/.dockerignore`).split('\n');
    assert.ok(ignore.includes('*'));
    for (const file of files) assert.ok(ignore.includes(`!${file}`), `${dir}/.dockerignore lacks !${file}`);
    assert.ok(ignore.includes('!Dockerfile'));
  });
}
