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
    return { ...options, upstreamUrl: url.toString().replace(/\/$/u, '') };
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

/** Validate complete SSE frames before forwarding them; retain only cumulative usage between frames. */
export function createSseReader(forbiddenSecret) {
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
        if (frame.includes(forbiddenSecret) || /^event:\s*error\s*$/mu.test(frame))
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
