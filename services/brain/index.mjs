import { resolve } from 'node:path';
import { createBrainServer } from './server.mjs';

try {
  const port = Number(process.env.BRAIN_PORT ?? '8790');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_configuration');
  const calls = process.env.BRAIN_DAILY_CURATOR_CALLS;
  // Task 3 replaces this no-op with the real curator (BRAIN_MODEL_URL / BRAIN_MODEL_KEY / BRAIN_MODEL).
  const curator = { enqueue() {}, drain: async () => {} };
  const brain = createBrainServer({
    databasePath: resolve(process.env.BRAIN_DB_PATH ?? './data/brain.sqlite'),
    secret: process.env.BRAIN_SECRET,
    curator,
    ...(/^[0-9]+$/u.test(calls ?? '') ? { dailyCuratorCalls: Number(calls) } : {}),
  });
  const prune = setInterval(() => brain.store.log.prune(90), 86_400_000);
  prune.unref();
  brain.server.once('error', () => {
    process.stderr.write('Não foi possível iniciar o cérebro.\n');
    process.exitCode = 1;
    void brain.close();
  });
  brain.server.listen(port, process.env.BRAIN_HOST ?? '0.0.0.0', () => {
    process.stdout.write('Cérebro iniciado.\n');
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      clearInterval(prune);
      void brain.close().catch(() => {
        process.exitCode = 1;
      });
    });
} catch {
  process.stderr.write('Configuração inválida. Confira as variáveis do cérebro.\n');
  process.exitCode = 1;
}
