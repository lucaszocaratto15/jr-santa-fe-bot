import { resolve } from 'node:path';
import { createControlServer } from './server.mjs';

try {
  const port = Number(process.env.JR_CONTROL_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_configuration');
  const control = createControlServer({
    databasePath: resolve(process.env.JR_CONTROL_DATA_DIR ?? './data', 'control.sqlite'),
    adminCode: process.env.JR_ADMIN_CODE,
    upstreamUrl: process.env.JR_UPSTREAM_URL,
    upstreamKey: process.env.JR_UPSTREAM_KEY,
    model: process.env.JR_MODEL ?? 'MiniMax-M3.1-Flash',
    openRouterKey: process.env.OPENROUTER_API_KEY,
    openRouterModels: process.env.OPENROUTER_FALLBACK_MODELS,
    geminiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL,
    fallbackEnabled: process.env.FALLBACK_ENABLED,
    attemptMs: process.env.ATTEMPT_MS,
    compactionBudgetMs: process.env.COMPACTION_BUDGET_MS,
    compactionEnabled: process.env.COMPACTION_ENABLED,
  });
  control.server.once('error', () => {
    process.stderr.write('Não foi possível iniciar o controle de acesso.\n');
    process.exitCode = 1;
    void control.close();
  });
  control.server.listen(port, process.env.JR_CONTROL_HOST ?? '127.0.0.1', () => {
    process.stdout.write('Controle de acesso iniciado.\n');
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void control.close().catch(() => {
        process.exitCode = 1;
      });
    });
} catch {
  process.stderr.write('Configuração inválida. Confira as variáveis do controle de acesso.\n');
  process.exitCode = 1;
}
