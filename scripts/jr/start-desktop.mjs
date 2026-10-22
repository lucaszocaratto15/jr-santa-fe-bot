import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { parseProviderConfig, startRelay, stopProcessGroup } from './pilot-support.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configPath = process.env.JR_MINIMAX_CONFIG || join(homedir(), '.config/opencode/opencode.json');
let relay;
let child;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (child?.pid) await stopProcessGroup(child.pid);
  await relay?.close();
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  const controlUrl = process.env.JR_CONTROL_URL;
  const provider = controlUrl ? null : parseProviderConfig(await readFile(configPath, 'utf8'));
  if (provider) relay = await startRelay(provider);
  const profile = process.env.JR_DESKTOP_PROFILE === 'admin' ? 'desktop-admin-control' : 'desktop-control';
  const dataDir = join(root, controlUrl ? '.local-pilot/' + profile : '.local-pilot/desktop');
  await mkdir(dataDir, { recursive: true });
  const environment = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'SHELL']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
  const env = {
    ...environment,
    JR_RELAY_URL: relay?.url,
    JR_RELAY_TOKEN: relay?.token,
    JR_MINIMAX_MODEL: provider?.model,
    JR_CONTROL_URL: controlUrl,
    JR_ALLOW_INSECURE_CONTROL_TEST: process.env.JR_ALLOW_INSECURE_CONTROL_TEST,
    JR_LOCAL_PILOT: controlUrl ? undefined : '1',
    AIONUI_BACKEND_BIN: process.env.AIONUI_BACKEND_BIN,
    AIONUI_E2E_TEST: '1',
    AIONUI_E2E_USER_DATA_DIR: dataDir,
    AIONUI_MULTI_INSTANCE: '1',
    ELECTRON_ENABLE_LOGGING: '0',
  };
  // The disposable profile keeps this first build separate from earlier company bots.
  child = spawn(join(root, 'node_modules/.bin/electron'), [root], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const redact = (text) =>
    provider ? text.replaceAll(provider.key, '[REDACTED]').replaceAll(relay.token, '[REDACTED]') : text;
  const forward = (stream, target) => {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        target.write(redact(buffer.slice(0, newline + 1)));
        buffer = buffer.slice(newline + 1);
      }
    });
    stream.on('end', () => target.write(redact(buffer + decoder.end())));
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  console.log(
    controlUrl
      ? 'Aplicativo JR iniciando com acesso corporativo.'
      : 'Aplicativo JR iniciando em modo de desenvolvimento.'
  );
  const [code] = await once(child, 'exit');
  process.exitCode = code || 0;
} catch (error) {
  console.error(
    error.code === 'ENOENT'
      ? 'Configuração ou compilação do aplicativo ausente.'
      : 'O aplicativo JR não conseguiu iniciar.'
  );
  process.exitCode = 1;
} finally {
  await stop();
}
