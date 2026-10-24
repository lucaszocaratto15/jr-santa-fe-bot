import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  JR_MODEL_CONTEXT_DEFAULT,
  JR_MODEL_CONTEXT_MAX,
  JR_MODEL_OUTPUT_DEFAULT,
  applyJrModels,
  jrOpencodeConfigPath,
  resolveJrModelLimit,
  syncJrOpencodeModels,
} from '../../../packages/desktop/src/process/services/jr/modelLimit.ts';

const limit = { context: JR_MODEL_CONTEXT_DEFAULT, output: JR_MODEL_OUTPUT_DEFAULT };

test('uses 160000 by 32000 when the environment is empty', () => {
  assert.deepEqual(resolveJrModelLimit({}), limit);
  assert.equal(limit.context - Math.min(limit.output, 32_000), 128_000);
});

test('accepts a context up to 190000 and an output smaller than that context', () => {
  assert.deepEqual(resolveJrModelLimit({ JR_MODEL_CONTEXT: '190000', JR_MODEL_OUTPUT: '189999' }), {
    context: JR_MODEL_CONTEXT_MAX,
    output: 189_999,
  });
  assert.deepEqual(resolveJrModelLimit({ JR_MODEL_CONTEXT: ' 180000 ', JR_MODEL_OUTPUT: '8000' }), {
    context: 180_000,
    output: 8_000,
  });
});

test('falls back to the defaults when context or output is invalid', () => {
  for (const value of ['190001', '0', '-1', '160000.5', '1e6', '1000000tokens', '160_000']) {
    assert.deepEqual(resolveJrModelLimit({ JR_MODEL_CONTEXT: value }), limit, value);
  }
  assert.deepEqual(resolveJrModelLimit({ JR_MODEL_OUTPUT: '0' }), limit);
  assert.deepEqual(resolveJrModelLimit({ JR_MODEL_OUTPUT: 'nope' }), limit);
  assert.deepEqual(resolveJrModelLimit({ JR_MODEL_CONTEXT: '160000', JR_MODEL_OUTPUT: '160000' }), limit);
  assert.deepEqual(resolveJrModelLimit({ JR_MODEL_CONTEXT: '20000' }), limit);
  assert.deepEqual(resolveJrModelLimit({ JR_MODEL_CONTEXT: '50000', JR_MODEL_OUTPUT: '1000' }), {
    context: 50_000,
    output: 1_000,
  });
});

test('replaces a stored 1 million MiniMax window and leaves other models alone', () => {
  const source = {
    provider: {
      minimax: {
        options: { apiKey: 'secret-key' },
        models: {
          'MiniMax-M3.1-Flash': { name: 'Flash', limit: { context: 1_000_000, output: 128_000 } },
          'MiniMax-M2': { limit: { context: 1_048_576, output: 8_000, input: 1_000 } },
        },
      },
      anthropic: {
        models: { 'claude-opus': { limit: { context: 1_000_000, output: 64_000 } } },
      },
    },
  };
  const applied = applyJrModels(source, limit);
  assert.equal(applied.changed, true);
  assert.equal(source.provider.minimax.models['MiniMax-M3.1-Flash'].limit.context, 1_000_000);
  const config = applied.config;
  assert.equal(config.provider.minimax.options.apiKey, 'secret-key');
  assert.deepEqual(config.provider.minimax.models['MiniMax-M3.1-Flash'].limit, limit);
  assert.equal(config.provider.minimax.models['MiniMax-M3.1-Flash'].name, 'Flash');
  assert.deepEqual(config.provider.minimax.models['MiniMax-M2'].limit, {
    context: limit.context,
    output: limit.output,
    input: 1_000,
  });
  assert.equal(config.provider.minimax.models['MiniMax-M3'].limit.context, limit.context);
  assert.equal(config.provider.anthropic.models['claude-opus'].limit.context, 1_000_000);
});

test('a second application of the same window does not report a change', () => {
  const once = applyJrModels({ provider: { 'jr-minimax': { models: { 'MiniMax-M3.1-Flash': {} } } } }, limit);
  assert.equal(once.changed, true);
  assert.equal(applyJrModels(once.config, limit).changed, false);
});

test('rewrites an existing opencode.json on disk and refuses a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-model-limit-'));
  try {
    const file = join(root, 'opencode.json');
    await writeFile(
      file,
      JSON.stringify({
        provider: {
          'jr-minimax': {
            options: { apiKey: 'do-not-log' },
            models: { 'MiniMax-M3.1-Flash': { limit: { context: 1_000_000, output: 128_000 } } },
          },
        },
      })
    );
    assert.equal(await syncJrOpencodeModels({ path: file, env: {} }), true);
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(written.provider['jr-minimax'].models['MiniMax-M3.1-Flash'].limit, limit);
    assert.equal(written.provider['jr-minimax'].options.apiKey, 'do-not-log');
    assert.equal(await syncJrOpencodeModels({ path: file, env: {} }), false);

    const link = join(root, 'linked.json');
    await symlink(file, link);
    await assert.rejects(syncJrOpencodeModels({ path: link, env: {} }), /JR_MODEL_LIMIT_UNAVAILABLE/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).provider['jr-minimax'].options.apiKey, 'do-not-log');

    await writeFile(file, '{');
    await assert.rejects(syncJrOpencodeModels({ path: file, env: {} }), /JR_MODEL_LIMIT_UNAVAILABLE/);
    assert.equal(await readFile(file, 'utf8'), '{');
    await assert.rejects(syncJrOpencodeModels({ path: 'opencode.json', env: {} }), /JR_MODEL_LIMIT_UNAVAILABLE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creates a private opencode.json when the employee does not have one yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jr-model-limit-new-'));
  try {
    const file = join(root, 'nested', 'opencode.json');
    assert.equal(await syncJrOpencodeModels({ path: file, env: { JR_MODEL_CONTEXT: '170000' } }), true);
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(written.provider.minimax.models['MiniMax-M3.1-Flash'].limit.context, 170_000);
    assert.equal(written.provider.minimax.models['MiniMax-M3.1-Flash'].limit.output, JR_MODEL_OUTPUT_DEFAULT);
    if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o777, 0o600);
    await chmod(file, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves the company config path from the override or the home directory', () => {
  assert.equal(jrOpencodeConfigPath({ JR_OPENCODE_CONFIG: '/tmp/a.json' }, '/home/person'), '/tmp/a.json');
  assert.equal(jrOpencodeConfigPath({ JR_MINIMAX_CONFIG: '/tmp/b.json' }, '/home/person'), '/tmp/b.json');
  assert.equal(jrOpencodeConfigPath({}, '/home/person'), join('/home/person', '.config', 'opencode', 'opencode.json'));
});
