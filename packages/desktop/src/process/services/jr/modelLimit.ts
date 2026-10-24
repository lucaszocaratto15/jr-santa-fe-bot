import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** OpenCode compacts at context − min(output, 32000). 160000 − 32000 = 128000. */
export const JR_MODEL_CONTEXT_DEFAULT = 160_000;
export const JR_MODEL_OUTPUT_DEFAULT = 32_000;
/** MiniMax rejects requests near 200k. Values above this are not applied. */
export const JR_MODEL_CONTEXT_MAX = 190_000;
export type JrModelLimit = { context: number; output: number };
type Env = Record<string, string | undefined>;

const MINIMAX_MODEL_ID = /^minimax(?:-|$)/i;
const MINIMAX_PROVIDER_ID = /minimax/i;
const MODEL_LIMIT_ERROR = 'JR_MODEL_LIMIT_UNAVAILABLE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nodeCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

/**
 * Positive integer from an environment variable.
 * An absent or blank value is missing. Anything else that is not a safe positive integer is invalid.
 */
function parseTokenSetting(value: string | undefined): 'missing' | 'invalid' | number {
  if (value == null) return 'missing';
  const text = value.trim();
  if (!text) return 'missing';
  if (!/^[0-9]+$/u.test(text)) return 'invalid';
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 'invalid';
  return parsed;
}

/**
 * Resolve the MiniMax window.
 * Invalid context, context above {@link JR_MODEL_CONTEXT_MAX}, or an output that is not
 * strictly smaller than context falls back to the defaults. The defaults always satisfy both locks.
 * Callers that only have a context field, such as AionCore `context_limit`, use `context`.
 */
export function resolveJrModelLimit(env: Env = process.env): JrModelLimit {
  const contextSetting = parseTokenSetting(env.JR_MODEL_CONTEXT);
  const outputSetting = parseTokenSetting(env.JR_MODEL_OUTPUT);
  let context =
    contextSetting === 'missing' || contextSetting === 'invalid' || contextSetting > JR_MODEL_CONTEXT_MAX
      ? JR_MODEL_CONTEXT_DEFAULT
      : contextSetting;
  let output = outputSetting === 'missing' || outputSetting === 'invalid' ? JR_MODEL_OUTPUT_DEFAULT : outputSetting;
  if (output >= context) output = JR_MODEL_OUTPUT_DEFAULT;
  if (output >= context) {
    context = JR_MODEL_CONTEXT_DEFAULT;
    output = JR_MODEL_OUTPUT_DEFAULT;
  }
  return { context, output };
}

function assignLimit(model: Record<string, unknown>, limit: JrModelLimit): boolean {
  const current = model.limit;
  if (isRecord(current) && current.context === limit.context && current.output === limit.output) return false;
  const previous = isRecord(current) ? current : {};
  model.limit = { ...previous, context: limit.context, output: limit.output };
  return true;
}

/**
 * Write `limit: { context, output }` onto MiniMax models that are already present.
 * A missing provider or model stays absent. Other providers stay untouched,
 * including models that legitimately advertise 1_000_000.
 */
export function applyJrModels(config: unknown, limit: JrModelLimit): { config: unknown; changed: boolean } {
  if (!isRecord(config) || !isRecord(config.provider)) return { config, changed: false };
  const next = structuredClone(config);
  const provider = next.provider;
  if (!isRecord(provider)) return { config, changed: false };
  let changed = false;
  for (const [providerId, entry] of Object.entries(provider)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue;
    const providerIsMinimax = MINIMAX_PROVIDER_ID.test(providerId);
    for (const [modelId, model] of Object.entries(entry.models)) {
      if (!isRecord(model)) continue;
      if (!providerIsMinimax && !MINIMAX_MODEL_ID.test(modelId)) continue;
      if (assignLimit(model, limit)) changed = true;
    }
  }
  return { config: next, changed };
}

/** Path of the OpenCode config this client rewrites. `JR_OPENCODE_CONFIG` wins, then `JR_MINIMAX_CONFIG`. */
export function jrOpencodeConfigPath(env: Env = process.env, home: string = homedir()): string {
  const override = env.JR_OPENCODE_CONFIG?.trim() || env.JR_MINIMAX_CONFIG?.trim();
  if (override) return override;
  return join(home, '.config', 'opencode', 'opencode.json');
}

/**
 * Replace MiniMax context windows already stored in opencode.json.
 * A missing file is left absent. A symlink or invalid JSON is left untouched.
 * @returns whether the file was rewritten
 */
export async function syncJrOpencodeModels(
  options: { path?: string; env?: Env; home?: string } = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  const filePath = options.path ?? jrOpencodeConfigPath(env, options.home ?? homedir());
  if (!isAbsolute(filePath)) throw new Error(MODEL_LIMIT_ERROR);
  const limit = resolveJrModelLimit(env);
  const directory = dirname(filePath);
  let text = '';
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1_048_576) throw new Error(MODEL_LIMIT_ERROR);
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      text = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return false;
    if (error instanceof Error && error.message === MODEL_LIMIT_ERROR) throw error;
    throw new Error(MODEL_LIMIT_ERROR, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(MODEL_LIMIT_ERROR);
  }
  const applied = applyJrModels(parsed, limit);
  if (!applied.changed) return false;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error(MODEL_LIMIT_ERROR);
  const temporary = join(directory, `.opencode-${randomUUID()}.json.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(applied.config, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const destination = await lstat(filePath).catch((error: unknown): null => {
      if (nodeCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (destination?.isSymbolicLink()) throw new Error(MODEL_LIMIT_ERROR);
    await rename(temporary, filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === MODEL_LIMIT_ERROR) throw error;
    throw new Error(MODEL_LIMIT_ERROR, { cause: error });
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
