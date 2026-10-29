/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getJrRelayConfig, type JrRelayConfig } from './bootstrap';

/**
 * The local JR model path for main-process features. Set when `startJrAuthProxy` comes up,
 * cleared when it closes. In the local pilot the relay config is used instead. Calls through
 * it count against the employee's quota on the control server like any conversation.
 */
let current: JrRelayConfig | null = null;

export function setJrModelConnection(connection: JrRelayConfig | null): void {
  current = connection;
}

export function getJrModelConnection(): JrRelayConfig | null {
  if (current) return current;
  try {
    return getJrRelayConfig();
  } catch {
    return null;
  }
}

export type ChatMessage = { role: 'system' | 'user'; content: string };

export const CHAT_COMPLETION_TIMEOUT_MS = 120_000;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function firstChoice(value: unknown): Record<string, unknown> | null {
  if (!record(value) || !Array.isArray(value.choices)) return null;
  const choice: unknown = value.choices[0];
  return record(choice) ? choice : null;
}

/** Join `choices[0].delta.content` across `data:` events. */
function joinSse(text: string): string {
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const delta = firstChoice(JSON.parse(data))?.delta;
      if (record(delta) && typeof delta.content === 'string') out += delta.content;
    } catch {
      // Skip a malformed event.
    }
  }
  return out;
}

function jsonContent(text: string): string {
  try {
    const message = firstChoice(JSON.parse(text))?.message;
    return record(message) && typeof message.content === 'string' ? message.content : '';
  } catch {
    return '';
  }
}

/**
 * One non-streaming chat completion. Accepts a JSON or an SSE answer (the control proxy may
 * force streaming). Rejects with `offline` (network/timeout) or `model_error` (any bad answer).
 */
export async function chatCompletion(
  connection: JrRelayConfig,
  messages: ChatMessage[],
  opts: { timeoutMs?: number; request?: typeof fetch; signal?: AbortSignal } = {}
): Promise<string> {
  const request = opts.request ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? CHAT_COMPLETION_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let response: Response;
  let text: string;
  try {
    response = await request(`${connection.url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: connection.model, stream: false, messages }),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('model_error');
    }
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.message === 'model_error') throw error;
    throw new Error('offline');
  }
  if (Buffer.byteLength(text) > MAX_REPLY_BYTES) throw new Error('model_error');
  const streamed = response.headers.get('Content-Type')?.startsWith('text/event-stream') || /^\s*data:/.test(text);
  const content = streamed ? joinSse(text) : jsonContent(text);
  if (!content.trim()) throw new Error('model_error');
  return content;
}
