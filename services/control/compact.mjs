import { httpError } from './validation.mjs';

/** Portuguese and source text are denser than English; do not estimate with 4 characters per token. */
export const CHARS_PER_TOKEN = 3;
export const TOKEN_CEILING = 130_000;
export const CHAR_CEILING = TOKEN_CEILING * CHARS_PER_TOKEN;

const SUMMARY_INSTRUCTION =
  'Resuma o trecho de conversa em português do Brasil. Preserve decisões, números, caminhos, comandos e resultados de ferramentas. Não invente fatos. Seja fiel e breve.';
const EXCERPT_MARK = '[contexto compactado]';
const SUMMARY_MARK = '[Resumo de trecho anterior da conversa]';

function jsonSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Estimate request tokens from the JSON payload at 3 characters per token. */
export function estimateTokens(messages) {
  return Math.ceil(jsonSize(messages) / CHARS_PER_TOKEN);
}

function cloneMessage(message) {
  if (!message || typeof message !== 'object') return { role: 'user', content: '' };
  return { ...message };
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => textOf(part)).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function messagePlain(message) {
  const chunks = [];
  const content = textOf(message?.content);
  if (content) chunks.push(content);
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      const name = call?.function?.name ?? call?.name ?? '';
      const args = call?.function?.arguments ?? call?.arguments ?? '';
      chunks.push(`tool_call ${name} ${textOf(args)}`);
    }
  }
  if (typeof message?.tool_call_id === 'string' && message.tool_call_id) chunks.push(`tool_call_id ${message.tool_call_id}`);
  return chunks.join('\n');
}

function isToolResult(message) {
  return message?.role === 'tool' || message?.role === 'function';
}

/** Keep an assistant tool call and its tool results in one indivisible group. */
function atomicGroups(messages) {
  const groups = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const group = [message];
      const ids = new Set(
        message.tool_calls.map((call) => call?.id).filter((id) => typeof id === 'string' && id.length > 0)
      );
      while (index + 1 < messages.length && isToolResult(messages[index + 1])) {
        const next = messages[index + 1];
        if (ids.size > 0 && typeof next?.tool_call_id === 'string' && !ids.has(next.tool_call_id)) break;
        group.push(next);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    if (isToolResult(message) && groups.length > 0) {
      groups[groups.length - 1].push(message);
      continue;
    }
    groups.push([message]);
  }
  return groups;
}

function truncateMiddle(text, maxChars) {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const marker = '\n…[trecho omitido]…\n';
  if (maxChars <= marker.length + 16) return text.slice(0, maxChars);
  const budget = maxChars - marker.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

/** Start and end of each old message, without calling a model. */
export function excerptSummary(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  const parts = list.map((message) => {
    const role = typeof message?.role === 'string' ? message.role : 'mensagem';
    const text = messagePlain(message);
    const body = text.length > 1_200 ? `${text.slice(0, 600)}\n…\n${text.slice(-600)}` : text;
    return `${role}: ${body}`;
  });
  const joined = parts.join('\n');
  if (joined.length <= 8_000) return joined;
  return `${joined.slice(0, 4_000)}\n…\n${joined.slice(-4_000)}`;
}

function excerptMessage(messages) {
  return { role: 'user', content: `${EXCERPT_MARK}\n${excerptSummary(messages)}` };
}

function redact(text, secrets) {
  let output = typeof text === 'string' ? text : '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) output = output.split(secret).join('[redacted]');
  }
  return output;
}

function shrinkSystems(messages, limit) {
  const next = messages.map(cloneMessage);
  for (let pass = 0; pass < 4 && jsonSize(next) > limit; pass += 1) {
    let shrunk = false;
    for (const message of next) {
      if (jsonSize(next) <= limit) return next;
      if (message?.role !== 'system' || typeof message.content !== 'string' || message.content.length === 0) continue;
      const overflow = jsonSize(next) - limit;
      const room = message.content.length - overflow - 16;
      message.content = truncateMiddle(message.content, room < 40 ? 40 : room);
      shrunk = true;
    }
    if (!shrunk) break;
  }
  if (jsonSize(next) <= limit) return next;
  const text = next
    .filter((message) => message?.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
  if (!text) return next;
  const only = [{ role: 'system', content: truncateMiddle(text, Math.max(40, limit - 64)) }];
  return jsonSize(only) <= limit ? only : next;
}

/**
 * Fit messages under the character ceiling.
 * A system prompt that alone exceeds the ceiling is truncated in place.
 * The function does not recurse and never returns an empty payload.
 */
export function clampToSend(messages, ceilingChars = CHAR_CEILING) {
  if (!Array.isArray(messages) || messages.length === 0) throw httpError(413, 'context_too_large');
  let flat = messages.map(cloneMessage);
  const limit = ceilingChars;
  let guard = 0;
  while (jsonSize(flat) > limit && guard < 64) {
    guard += 1;
    const groups = atomicGroups(flat);
    const nonSystemIndexes = [];
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index].some((message) => message?.role !== 'system')) nonSystemIndexes.push(index);
    }
    if (nonSystemIndexes.length <= 1) break;
    flat = groups.filter((_, index) => index !== nonSystemIndexes[0]).flat();
    if (flat.length === 0) break;
  }
  if (jsonSize(flat) > limit) flat = shrinkSystems(flat, limit);
  if (jsonSize(flat) > limit) {
    const groups = atomicGroups(flat);
    const dropAt = groups.findIndex((group) => group.some((message) => message?.role !== 'system'));
    if (dropAt !== -1) {
      const excerpted = excerptMessage(groups[dropAt]);
      const others = groups.filter((_, index) => index !== dropAt).flat();
      const room = limit - jsonSize(others) - 48;
      if (room < 24) flat = others;
      else {
        if (excerpted.content.length > room) excerpted.content = truncateMiddle(excerpted.content, room);
        flat = groups.map((group, index) => (index === dropAt ? [excerpted] : group)).flat();
      }
    }
  }
  if (jsonSize(flat) > limit) flat = shrinkSystems(flat, limit);
  if (!Array.isArray(flat) || flat.length === 0 || jsonSize(flat) > limit) throw httpError(413, 'context_too_large');
  return flat;
}

function splitTail(groups, tailChars) {
  const tail = [];
  let size = 0;
  let index = groups.length;
  while (index > 0) {
    const group = groups[index - 1];
    const length = jsonSize(group);
    if (tail.length > 0 && size + length > tailChars) break;
    tail.unshift(group);
    size += length;
    index -= 1;
  }
  if (tail.length === 0 && groups.length > 0) {
    tail.push(groups[groups.length - 1]);
    index = groups.length - 1;
  }
  return { old: groups.slice(0, index), tail };
}

function chunkGroups(groups, maxChars) {
  const blocks = [];
  let current = [];
  let size = 0;
  for (const group of groups) {
    const length = jsonSize(group);
    if (current.length > 0 && size + length > maxChars) {
      blocks.push(current);
      current = [];
      size = 0;
    }
    current.push(group);
    size += length;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

async function summarizeWithGemini(messages, gemini) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('summary_timeout')), gemini.timeoutMs);
  const userSignal = gemini.signal;
  const abortFromUser = () => controller.abort(userSignal.reason);
  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else userSignal.addEventListener('abort', abortFromUser, { once: true });
  }
  try {
    const plain = messages.map((message) => messagePlain(message)).join('\n---\n').slice(0, 100_000);
    const response = await gemini.fetch(gemini.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gemini.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: gemini.model,
        stream: false,
        messages: [
          { role: 'system', content: SUMMARY_INSTRUCTION },
          { role: 'user', content: plain },
        ],
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new Error('summary_failed');
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('summary_failed');
    }
    const summary = data?.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || summary.trim().length === 0) throw new Error('summary_failed');
    return redact(summary.trim().slice(0, 6_000), gemini.secrets ?? []);
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', abortFromUser);
  }
}

/**
 * Summarize old turns when the payload is over the token ceiling.
 * Gemini failures, 400/413 and timeouts become an excerpt. Past the total budget,
 * remaining blocks are not sent to Gemini.
 */
export async function compactMessages(messages, options = {}) {
  const charsPerToken = options.charsPerToken ?? CHARS_PER_TOKEN;
  const ceilingChars = (options.ceilingTokens ?? TOKEN_CEILING) * charsPerToken;
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (jsonSize(messages) <= ceilingChars) return messages;

  const systems = [];
  const rest = [];
  for (const message of messages) {
    if (message?.role === 'system') systems.push(cloneMessage(message));
    else rest.push(cloneMessage(message));
  }
  const { old, tail } = splitTail(atomicGroups(rest), options.tailChars ?? 90_000);
  const blocks = chunkGroups(old, options.blockChars ?? 80_000);
  const summaries = [];
  const clock = options.now ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? 180_000;
  const attemptMs = options.attemptMs ?? 90_000;
  const signal = options.signal;
  const gemini = options.gemini?.key && typeof options.gemini.fetch === 'function' ? options.gemini : null;
  let geminiBlocks = 0;
  let excerptBlocks = 0;

  for (const block of blocks) {
    const flat = block.flat();
    const elapsed = clock() - started;
    const remaining = budgetMs - elapsed;
    if (!gemini || remaining <= 0) {
      excerptBlocks += 1;
      summaries.push(excerptMessage(flat));
      continue;
    }
    try {
      const text = await summarizeWithGemini(flat, {
        ...gemini,
        secrets: options.secrets ?? [],
        timeoutMs: Math.max(1, Math.min(attemptMs, remaining)),
        signal,
      });
      geminiBlocks += 1;
      summaries.push({ role: 'system', content: `${SUMMARY_MARK}\n${text}` });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      excerptBlocks += 1;
      const status = Number.isInteger(error?.status) ? error.status : 'erro';
      options.log?.(
        `Compactação: resumo indisponível status=${status} modelo=${gemini.model ?? '-'}; pedido segue com excerto`
      );
      summaries.push(excerptMessage(flat));
    }
  }

  const result = clampToSend([...systems, ...summaries, ...tail.flat()], ceilingChars);
  options.log?.(
    `Compactação: tokens~${estimateTokens(messages)} para tokens~${estimateTokens(result)} gemini=${geminiBlocks} excerto=${excerptBlocks}`
  );
  return result;
}
