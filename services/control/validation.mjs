class ControlHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Create an HTTP error containing only a stable public code. */
export function httpError(status, code) {
  return new ControlHttpError(status, code);
}

/** Recognize service errors without trusting provider exception fields. */
export function isHttpError(error) {
  return error instanceof ControlHttpError;
}

/** Validate a short text field before it crosses the persistence boundary. */
export function textField(value, minimum, maximum) {
  if (
    typeof value !== 'string' ||
    value.trim().length < minimum ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw httpError(400, 'invalid_request');
  }
  return value.trim();
}

/** Validate service configuration without including secrets in errors. */
export function validateConfiguration(options) {
  try {
    if (
      typeof options.adminCode !== 'string' ||
      options.adminCode.length < 32 ||
      options.adminCode.length > 256 ||
      /\s/u.test(options.adminCode)
    )
      throw new Error();
    if (
      typeof options.upstreamKey !== 'string' ||
      options.upstreamKey.length < 16 ||
      /[\r\n]/u.test(options.upstreamKey)
    )
      throw new Error();
    if (typeof options.model !== 'string' || !/^MiniMax-[a-zA-Z0-9._-]+$/u.test(options.model)) throw new Error();
    const url = new URL(options.upstreamUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/v1')
    )
      throw new Error();
    return {
      ...options,
      upstreamUrl: url.toString().replace(/\/$/u, ''),
      fallback: fallbackProviders(options),
    };
  } catch {
    throw new Error('invalid_configuration');
  }
}

/** Return validated provider counters, preserving missing cache data as unknown. */
export function parseUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  if (!Number.isSafeInteger(prompt) || prompt < 0 || !Number.isSafeInteger(completion) || completion < 0) return null;
  const cached = value.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedPromptTokens: Number.isSafeInteger(cached) && cached >= 0 && cached <= prompt ? cached : null,
  };
}

const FREE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}:free$/u;
const GEMINI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

function optionalSecret(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /[\r\n\0]/u.test(value))
    throw new Error();
  return value;
}

function fallbackSwitch(value, hasKey) {
  if (value == null || value === '') return hasKey;
  if (typeof value !== 'string') throw new Error();
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new Error();
}

/** Build the free-provider chain. Missing keys disable that provider and never appear in errors. */
export function fallbackProviders(options) {
  const openRouterKey = optionalSecret(options.openRouterKey);
  const geminiKey = optionalSecret(options.geminiKey);
  const enabled = fallbackSwitch(options.fallbackEnabled, Boolean(openRouterKey || geminiKey));
  const secrets = [openRouterKey, geminiKey].filter(Boolean);
  let geminiModel = 'gemini-2.5-flash';
  if (options.geminiModel != null && options.geminiModel !== '') {
    if (typeof options.geminiModel !== 'string' || !GEMINI_MODEL.test(options.geminiModel)) throw new Error();
    geminiModel = options.geminiModel;
  }
  let models = [];
  if (options.openRouterModels != null && options.openRouterModels !== '') {
    if (typeof options.openRouterModels !== 'string') throw new Error();
    models = options.openRouterModels
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (enabled && openRouterKey) {
      for (const model of models) {
        if (!FREE_MODEL.test(model) || model.includes('..') || model.includes('//')) throw new Error();
      }
    } else models = [];
  }
  if (!enabled) return { enabled: false, providers: [], secrets };
  const providers = [];
  if (openRouterKey) {
    const seen = new Set();
    for (const model of ['openrouter/free', ...models]) {
      if (seen.has(model)) continue;
      seen.add(model);
      providers.push({ id: 'openrouter', model, url: OPENROUTER_URL, key: openRouterKey });
    }
  }
  if (geminiKey) providers.push({ id: 'gemini', model: geminiModel, url: GEMINI_URL, key: geminiKey });
  return { enabled: providers.length > 0, providers, secrets };
}

/** Validate complete SSE frames before forwarding them; retain only cumulative usage between frames. */
export function createSseReader(forbiddenSecret) {
  const secrets = (Array.isArray(forbiddenSecret) ? forbiddenSecret : [forbiddenSecret]).filter(
    (secret) => typeof secret === 'string' && secret.length > 0
  );
  const decoder = new TextDecoder();
  let pending = '';
  let usage = null;
  return {
    push(chunk, final = false) {
      pending += decoder.decode(chunk, { stream: !final });
      if (pending.length > 1_048_576) throw httpError(502, 'upstream_unavailable');
      const frames = [];
      let boundary;
      while ((boundary = /\r?\n\r?\n/u.exec(pending))) {
        const end = boundary.index + boundary[0].length;
        frames.push(pending.slice(0, end));
        pending = pending.slice(end);
      }
      if (final && pending) {
        frames.push(pending);
        pending = '';
      }
      for (const frame of frames) {
        if (secrets.some((secret) => frame.includes(secret)) || /^event:\s*error\s*$/mu.test(frame))
          throw httpError(502, 'upstream_unavailable');
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Heartbeats and non-JSON extension events carry no token counters.
        }
        if (parsed?.error) throw httpError(502, 'upstream_unavailable');
        usage = parseUsage(parsed?.usage) ?? usage;
      }
      return { usage, frames };
    },
  };
}
