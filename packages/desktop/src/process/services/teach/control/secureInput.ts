/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { SecureKind, SecureRequest, SecureRespondResult, SecureResponse } from '@/common/types/agent/teachTypes';
import type { VaultStore } from '../vault/vault';
import { normalizeOrigin } from '../vault/originMatch';
import { FILL_ERRORS } from './secretFill';
import type { FillOptions, FillResult } from './secretFill';

export type { SecureKind, SecureRequest, SecureRespondResult, SecureResponse };

/** What the agent sees. The value is never part of it. */
export type SecureResult =
  | { ok: true; id: string; result: 'enviado' | 'cancelado' | 'aguardando' }
  | { ok: false; error: string };

export type SecureInputBroker = {
  /** `submit` presses Enter after the fill (R13); it stays in main and never reaches the renderer. */
  request(kind: SecureKind, label: string, opts?: { submit?: boolean }): Promise<SecureResult>;
  status(id: string): Promise<SecureResult>;
  respond(response: SecureResponse): Promise<SecureRespondResult>;
  /** Offer to store a password for `origin` (R3). Returns the request id, or null for a bad origin. */
  offerSave(origin: string): string | null;
  /** Requests still waiting for the employee, oldest first. Carries no values. */
  listPending(): SecureRequest[];
};

export type SecureInputDeps = {
  emit(request: SecureRequest): void;
  /** Tells the renderer to drop the card of a request that expired. */
  expired(id: string): void;
  /** Origin of the page attached to the agent browser, or null when nothing is open. */
  currentOrigin(): string | null;
  fill(value: string, opts: FillOptions): Promise<FillResult>;
  vault(): VaultStore | null;
  waitMs?: number;
  ttlMs?: number;
  newId?: () => string;
};

export const SECURE_INPUT_WAIT_MS = 50_000;
/** Every entry (pending or finished-but-unread) is dropped after this long (R10). */
export const SECURE_REQUEST_TTL_MS = 300_000;
const MAX_PENDING = 3;
const MAX_LABEL = 200;

export const SECURE_ERRORS = {
  noPage: 'abra o site no navegador do app antes de pedir',
  tooMany: 'há pedidos seguros demais aguardando o funcionário',
  unknown: 'pedido não encontrado',
  pageChanged: 'a página mudou de site antes do envio',
  fillFailed: 'não foi possível preencher o campo',
} as const;

type Outcome = { result: 'enviado' | 'cancelado' } | { error: string };

type Entry = {
  request: SecureRequest;
  settled: Promise<Outcome>;
  settle(outcome: Outcome): void;
  outcome?: Outcome;
  timer: ReturnType<typeof setTimeout>;
  submit?: boolean;
  /** A save-only vault write is in flight: duplicate responses are ignored. */
  saving?: boolean;
  /** The TTL fired during a save; expire once the save fails (a success settles it anyway). */
  expireAfterSave?: boolean;
};

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Stores a password for `origin`, updating the item that already lists it when there is one.
 * Returns false (and logs only the error name) when the vault is unavailable or the save fails.
 */
async function savePassword(vault: VaultStore | null, origin: string, password: string): Promise<boolean> {
  if (!vault?.available()) return false;
  try {
    const existing = (await vault.list()).find((item) => item.origins.includes(origin));
    await vault.upsert(
      existing
        ? { id: existing.id, name: existing.name, origins: existing.origins, username: existing.username, password }
        : { name: hostOf(origin), origins: [origin], username: '', password }
    );
    return true;
  } catch (error) {
    console.warn('[teach] vault save failed', error instanceof Error ? error.name : undefined);
    return false;
  }
}

/**
 * Pairs agent `secure_input` calls with the employee's secure card. The typed value goes from
 * `respond` straight into `fill` (and optionally the vault); it is never stored on an entry.
 */
export function createSecureInputBroker(deps: SecureInputDeps): SecureInputBroker {
  const waitMs = deps.waitMs ?? SECURE_INPUT_WAIT_MS;
  const ttlMs = deps.ttlMs ?? SECURE_REQUEST_TTL_MS;
  const newId = deps.newId ?? randomUUID;
  const entries = new Map<string, Entry>();

  const pending = () => [...entries.values()].filter((entry) => !entry.outcome);

  const remove = (entry: Entry) => {
    clearTimeout(entry.timer);
    entries.delete(entry.request.id);
  };

  const expire = (entry: Entry) => {
    if (entry.saving) {
      entry.expireAfterSave = true;
      return;
    }
    remove(entry);
    if (entry.outcome) return;
    entry.settle({ result: 'cancelado' });
    deps.expired(entry.request.id);
  };

  const open = (request: SecureRequest): Entry => {
    const { promise: settled, resolve } = deferred<Outcome>();
    const entry: Entry = {
      request,
      settled,
      settle: (outcome) => {
        entry.outcome = outcome;
        resolve(outcome);
      },
      timer: setTimeout(() => expire(entry), ttlMs),
    };
    entries.set(request.id, entry);
    deps.emit(request);
    return entry;
  };

  /** Waits up to `waitMs`; a final outcome is reported once and then forgotten. */
  const wait = async (entry: Entry): Promise<SecureResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    const outcome = await Promise.race([entry.settled, timeout]);
    clearTimeout(timer);
    const id = entry.request.id;
    if (!outcome) return { ok: true, id, result: 'aguardando' };
    remove(entry);
    return 'error' in outcome ? { ok: false, error: outcome.error } : { ok: true, id, result: outcome.result };
  };

  return {
    async request(kind, label, opts) {
      const origin = normalizeOrigin(deps.currentOrigin() ?? '');
      if (!origin) return { ok: false, error: SECURE_ERRORS.noPage };
      const waiting = pending().filter((entry) => entry.request.purpose === 'fill').length;
      if (waiting >= MAX_PENDING) return { ok: false, error: SECURE_ERRORS.tooMany };
      const entry = open({
        id: newId(),
        origin,
        kind,
        label: label.trim().slice(0, MAX_LABEL),
        allowSave: kind === 'password',
        purpose: 'fill',
      });
      if (opts?.submit) entry.submit = true;
      return wait(entry);
    },

    async status(id) {
      const entry = entries.get(id);
      if (!entry || entry.request.purpose !== 'fill') return { ok: false, error: SECURE_ERRORS.unknown };
      return wait(entry);
    },

    offerSave(rawOrigin) {
      const origin = normalizeOrigin(rawOrigin);
      if (!origin) return null;
      return open({ id: newId(), origin, kind: 'password', label: '', allowSave: true, purpose: 'save-only' }).request
        .id;
    },

    listPending() {
      return pending().map((entry) => ({ ...entry.request }));
    },

    async respond({ id, value, cancelled, save }) {
      const entry = entries.get(id);
      if (!entry || entry.outcome || entry.saving) return {};
      const { request } = entry;
      if (cancelled || !value) {
        entry.settle({ result: 'cancelado' });
        if (request.purpose === 'save-only') remove(entry);
        return {};
      }
      if (request.purpose === 'save-only') {
        // Guard before awaiting so a duplicate response or the TTL cannot double-upsert/settle.
        entry.saving = true;
        const saved = await savePassword(deps.vault(), request.origin, value);
        entry.saving = false;
        if (!saved) {
          // Keep the entry on failure so the employee can retry from the same card.
          if (entry.expireAfterSave) expire(entry);
          return { saved: false };
        }
        entry.settle({ result: 'enviado' });
        remove(entry);
        return { saved: true };
      }
      // Mark settled before awaiting so a duplicate response cannot fill twice.
      entry.outcome = { result: 'enviado' };
      const filled = await deps
        .fill(value, {
          requirePassword: request.kind === 'password',
          allowedOrigins: [request.origin],
          ...(entry.submit ? { submit: true } : {}),
        })
        .catch((): FillResult => ({ ok: false, error: SECURE_ERRORS.fillFailed }));
      if (filled.ok === false) {
        // The request is not a vault item, so the origin error gets its own wording.
        entry.settle({ error: filled.error === FILL_ERRORS.origin ? SECURE_ERRORS.pageChanged : filled.error });
        return {};
      }
      entry.settle({ result: 'enviado' });
      if (save && request.kind === 'password' && request.allowSave) {
        return { saved: await savePassword(deps.vault(), request.origin, value) };
      }
      return {};
    },
  };
}
