import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { homedir, hostname, totalmem } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import {
  parseProviderConfig,
  startRelay,
  verifyArtifact,
  hasLocalExecution,
  probeHealth,
  stopProcessGroup,
  summarizeTurnTiming,
} from './pilot-support.mjs';
import { resolveJrModelLimit } from '../../packages/desktop/src/process/services/jr/modelLimit.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runDir = join(root, '.local-pilot', new Date().toISOString().replace(/[:.]/g, '-'));
const workspace = join(runDir, 'workspace');
const binary = process.env.AIONUI_BACKEND_BIN ?? join(root, 'resources/bundled-aioncore/darwin-arm64/aioncore');
const source = process.env.JR_MINIMAX_CONFIG ?? join(homedir(), '.config/opencode/opencode.json');
const marker = randomBytes(16).toString('hex');
const amounts = [randomInt(1000, 20000), randomInt(1000, 20000), randomInt(1000, 20000)];
const expectedTotal = amounts.reduce((sum, value) => sum + value, 0) / 100;
const encryptionSecret = randomBytes(32).toString('hex');
const report = {
  startedAt: new Date().toISOString(),
  runtime: 'AionCore v0.2.2 / built-in aionrs',
  platform: process.platform,
  architecture: process.arch,
  host: hostname(),
  machineMemoryMiB: Math.round(totalmem() / 1024 ** 2),
  workspace,
  turns: [],
};
let relay, child, ws, provider, backendPort;
let terminal;
const events = [];
const redact = (value) =>
  [provider?.key, relay?.token, encryptionSecret]
    .filter(Boolean)
    .reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const out = (value) => console.log(redact(JSON.stringify(value)));

async function api(path, body, method = body === undefined ? 'GET' : 'POST', timeout = 30000) {
  const response = await fetch(`http://127.0.0.1:${backendPort}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    redirect: 'error',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json();
  if (!response.ok || result.success === false) {
    throw new Error(redact(`Backend ${method} ${path}: ${response.status} ${result.error ?? result.code ?? ''}`));
  }
  return result.data ?? result;
}

function memorySnapshot() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), parent: Number(m[2]), rssKiB: Number(m[3]), executable: m[4] }));
  const owned = new Set([child.pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const processes = rows.filter((row) => owned.has(row.pid));
  return { processes, totalRssMiB: Math.round(processes.reduce((sum, row) => sum + row.rssKiB, 0) / 1024) };
}

async function runTurn(conversationId, name, prompt) {
  const started = performance.now();
  const firstEvent = events.length;
  const firstCall = relay.metrics.calls.length;
  const ack = await api(`/api/conversations/${conversationId}/messages`, { content: prompt });
  out({ phase: name, ack });
  const seenConfirmations = new Set();
  const approvalSamples = [];
  let completed = false;
  while (performance.now() - started < 180000) {
    await delay(300);
    const fresh = events
      .slice(firstEvent)
      .filter((event) => event.conversation_id === conversationId && event.turn_id === ack.turn_id);
    if (fresh.some((event) => ['finish', 'finished', 'done', 'complete'].includes(event.type))) {
      completed = true;
      break;
    }
    const conversation = await api(`/api/conversations/${conversationId}`);
    const runtime = conversation.runtime;
    if (!report.runtimeShape) {
      report.runtimeShape = runtime;
      out({ runtime });
    }
    const confirmations = await api(`/api/conversations/${conversationId}/confirmations`);
    const list = Array.isArray(confirmations)
      ? confirmations
      : (confirmations.items ?? confirmations.confirmations ?? []);
    approvalSamples.push({ at: performance.now(), pending: list.length });
    for (const [index, item] of list.entries()) {
      const id = item.call_id ?? item.id ?? JSON.stringify(item);
      if (!seenConfirmations.has(id)) {
        seenConfirmations.add(id);
        out({ approvalRequired: { backendPort, conversationId, confirmation: item } });
        if (process.stdin.isTTY) {
          terminal ??= createInterface({ input: process.stdin, output: process.stdout });
          const answer = await terminal.question('Review the tool request above. Approve once? [yes/NO] ', {
            signal: AbortSignal.timeout(60000),
          });
          await api(`/api/conversations/${conversationId}/confirmations/${encodeURIComponent(item.call_id)}/confirm`, {
            msg_id: fresh.findLast((event) => event.type === 'tool_call')?.msg_id ?? ack.msg_id,
            data: { value: answer.trim().toLowerCase() === 'yes' ? 'proceed_once' : 'cancel' },
          });
          approvalSamples.push({ at: performance.now(), pending: list.length - index - 1 });
        }
      }
    }
  }
  const finished = performance.now();
  const messages = await api(`/api/conversations/${conversationId}/messages`);
  const turnEvents = events
    .slice(firstEvent)
    .filter((event) => event.conversation_id === conversationId && event.turn_id === ack.turn_id);
  const calls = relay.metrics.calls.slice(firstCall);
  const result = {
    name,
    completed,
    ...summarizeTurnTiming(started, finished, turnEvents, calls, approvalSamples),
    approvalSamplingMs: 300,
    eventTypes: [...new Set(turnEvents.map((event) => event.type))],
    calls,
    messages,
    events: turnEvents,
    memory: memorySnapshot(),
  };
  report.turns.push(result);
  out({
    phase: name,
    completed,
    totalMs: result.totalMs,
    approvalWaitMs: result.approvalWaitMs,
    processingMs: result.processingMs,
    firstApiTextMs: result.firstApiTextMs,
    firstAgentTextMs: result.firstAgentTextMs,
    eventTypes: result.eventTypes,
  });
  if (!completed) throw new Error(`${name}: turn timed out`);
  if (turnEvents.some((event) => event.type === 'error')) throw new Error(`${name}: agent reported an error`);
  return result;
}

try {
  provider = parseProviderConfig(await readFile(source, 'utf8'));
  report.model = provider.model;
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, 'entradas.csv'),
    'item,valor\n' + amounts.map((value, i) => `teste_${i + 1},${(value / 100).toFixed(2)}`).join('\n') + '\n'
  );
  relay = await startRelay(provider);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  backendPort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'SHELL']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
  Object.assign(env, {
    AIONUI_CACHE_DIR: join(runDir, 'cache'),
    AIONUI_WORK_DIR: workspace,
    AIONUI_LOG_DIR: join(runDir, 'logs'),
    AIONUI_ENCRYPTION_SECRET: encryptionSecret,
  });
  const started = performance.now();
  child = spawn(
    binary,
    [
      '--local',
      '--host',
      '127.0.0.1',
      '--port',
      String(backendPort),
      '--data-dir',
      join(runDir, 'data'),
      '--work-dir',
      workspace,
      '--log-dir',
      join(runDir, 'logs'),
      '--log-level',
      'warn',
      '--parent-pid',
      String(process.pid),
    ],
    { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let childError;
  child.on('error', (error) => {
    childError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      // Keep diagnostics local and redact even the temporary relay token.
      const line = redact(chunk.toString());
      void writeFile(join(runDir, 'backend.log'), line, { flag: 'a' });
    });
  let ready = false;
  while (performance.now() - started < 60000) {
    if (childError) throw childError;
    if (child.exitCode !== null) throw new Error('AionCore exited before health check');
    try {
      if (
        await probeHealth(
          `http://127.0.0.1:${backendPort}/health`,
          Math.max(1, Math.min(1500, 60000 - (performance.now() - started)))
        )
      ) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  if (!ready) throw new Error('AionCore health check timed out');
  report.backendStartupMs = Math.round(performance.now() - started);
  out({ backendReady: true, backendPort, startupMs: report.backendStartupMs, runDir });
  ws = new WebSocket(`ws://127.0.0.1:${backendPort}/ws`);
  ws.addEventListener('message', (message) => {
    const receivedAt = performance.now();
    try {
      const packet = JSON.parse(message.data);
      if ((packet.name ?? packet.event) !== 'message.stream') return;
      const event = packet.data ?? packet.payload;
      events.push({ ...JSON.parse(redact(JSON.stringify(event))), receivedAt });
      if (/tool|error|confirm|finish/.test(event.type ?? ''))
        out({ streamEvent: { type: event.type, data: event.data } });
    } catch {}
  });
  await Promise.race([
    once(ws, 'open'),
    delay(10000).then(() => {
      throw new Error('WebSocket connect timed out');
    }),
  ]);
  const configured = await api('/api/providers', {
    platform: 'openai',
    name: 'JR MiniMax local pilot',
    base_url: relay.url,
    api_key: relay.token,
    models: [provider.model],
    enabled: true,
    context_limit: resolveJrModelLimit(process.env).context,
    model_settings: { [provider.model]: { openai_api_mode: 'chat_completions' } },
    capabilities: [{ type: 'text' }, { type: 'function_calling' }],
  });
  const conversation = await api('/api/conversations', {
    type: 'aionrs',
    name: 'JR MiniMax — prova local',
    model: { provider_id: configured.id, model: provider.model },
    extra: { workspace },
  });
  report.conversationId = conversation.id;
  out({ builtInConversation: conversation.id, type: conversation.type, workspace: conversation.extra?.workspace });
  await runTurn(conversation.id, 'greeting', 'Oi! Responda apenas: Olá, JR.');
  const task =
    `Tarefa de teste com dados fictícios. Trabalhe exclusivamente em ${workspace}. ` +
    'Use Read para ler entradas.csv diretamente; não liste a pasta. Use Write para criar calcular.mjs com no máximo 20 linhas, apenas módulos nativos Node. O CSV tem duas colunas simples separadas por vírgula; some a coluna valor usando centavos inteiros. ' +
    `O script deve gravar resultado.json com marker "${marker}", total numérico, linhas:3, hostname obtido de node:os e platform obtido de process.platform. ` +
    'Depois execute o script usando exatamente o comando: /opt/homebrew/bin/node calcular.mjs. ' +
    'Não calcule mentalmente nem grave o resultado sem executar o script. Não acesse outros diretórios ou serviços. ' +
    'O script deve imprimir o JSON gerado. Use esse retorno da execução para conferir o resultado; não precisa de outro Read. Ao terminar, responda em uma frase com o total e os arquivos criados.';
  const codeTask = await runTurn(conversation.id, 'local_code_task', task);
  if (!hasLocalExecution(codeTask.events))
    throw new Error('No successful execution of the requested local command was observed');
  report.artifact = await verifyArtifact(workspace, marker, expectedTotal);
  report.expectedTotal = expectedTotal;
  if (report.artifact.hostname !== hostname() || report.artifact.platform !== process.platform)
    throw new Error('Artifact execution host does not match this computer');
  report.ok = true;
  out({ success: true, artifact: report.artifact, workspace });
} catch (error) {
  report.ok = false;
  report.error = redact(error.message);
  out({ success: false, error: report.error, runDir });
  process.exitCode = 1;
} finally {
  ws?.close();
  terminal?.close();
  if (child?.pid) {
    try {
      await stopProcessGroup(child.pid);
    } catch {
      report.ok = false;
      report.cleanupError = 'Failed to stop the owned pilot process group';
      process.exitCode = 1;
    }
  }
  await relay?.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'report.json'), redact(JSON.stringify(report, null, 2)));
  out({ report: join(runDir, 'report.json') });
}
