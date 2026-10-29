/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { VaultStore } from '../vault/vault';
import { normalizeOrigin } from '../vault/originMatch';
import type { FillOptions, FillResult } from './secretFill';

export type SecureKind = 'otp' | 'password' | 'text';

/** Main → renderer: show a secure card. Never carries a value. */
export type SecureRequest = {
  id: string;
  origin: string;
  kind: SecureKind;
  label: string;
  allowSave: boolean;
  /** 'save-only' just stores the typed password in the vault for `origin`; nothing is filled. */
  purpose: 'fill' | 'save-only';
};

/** Renderer → main: the employee's answer. */
export type SecureResponse = { id: string; value?: string; cancelled?: boolean; save?: boolean };

/** What the agent sees. The value is never part of it. */
export type SecureResult =
  | { ok: true; id: string; result: 'enviado' | 'cancelado' | 'aguardando' }
  | { ok: false; error: string };

export type SecureInputBroker = {
  request(kind: SecureKind, label: string): Promise<SecureResult>;
  status(id: string): Promise<SecureResult>;
  respond(response: SecureResponse): Promise<void>;
  /** Offer to store a password for `origin` (R3). Returns the request id, or null for a bad origin. */
  offerSave(origin: string): string | null;
};

export type SecureInputDeps = {
  emit(request: SecureRequest): void;
  /** Origin of the page attached to the agent browser, or null when nothing is open. */
  currentOrigin(): string | null;
  fill(value: string, opts: FillOptions): Promise<FillResult>;
  vault(): VaultStore | null;
  waitMs?: number;
  newId?: () => string;
};

export const SECURE_INPUT_WAIT_MS = 50_000;
const MAX_PENDING = 3;
const MAX_ENTRIES = 50;
const MAX_LABEL = 200;

export const SECURE_ERRORS = {
  noPage: 'abra o site no navegador do app antes de pedir',
  tooMany: 'há pedidos seguros demais aguardando o funcionário',
  unknown: 'pedido não encontrado',
} as const;

type Outcome = { result: 'enviado' | 'cancelado' } | { error: string };

type Entry = {
  request: SecureRequest;
  settled: Promise<Outcome>;
  settle(outcome: Outcome): void;
  outcome?: Outcome;
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

/** Stores a password for `origin`, updating the item that already lists it when there is one. */
async function savePassword(vault: VaultStore | null, origin: string, password: string): Promise<void> {
  if (!vault?.available()) return;
  const existing = (await vault.list()).find((item) => item.origins.includes(origin));
  await vault.upsert(
    existing
      ? { id: existing.id, name: existing.name, origins: existing.origins, username: existing.username, password }
      : { name: hostOf(origin), origins: [origin], username: '', password }
  );
}

/**
 * Pairs agent `secure_input` calls with the employee's secure card. The typed value goes from
 * `respond` straight into `fill` (and optionally the vault); it is never stored on an entry.
 */
export function createSecureInputBroker(deps: SecureInputDeps): SecureInputBroker {
  const waitMs = deps.waitMs ?? SECURE_INPUT_WAIT_MS;
  const newId = deps.newId ?? randomUUID;
  const entries = new Map<string, Entry>();

  const pendingCount = () =>
    [...entries.values()].filter((entry) => entry.request.purpose === 'fill' && !entry.outcome).length;

  const open = (request: SecureRequest): Entry => {
    const { promise: settled, resolve } = deferred<Outcome>();
    const entry: Entry = {
      request,
      settled,
      settle: (outcome) => {
        entry.outcome = outcome;
        resolve(outcome);
      },
    };
    // Forget the oldest finished requests whose outcome the agent never asked for.
    for (const [id, old] of entries) {
      if (entries.size < MAX_ENTRIES) break;
      if (old.outcome) entries.delete(id);
    }
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
    entries.delete(id);
    return 'error' in outcome ? { ok: false, error: outcome.error } : { ok: true, id, result: outcome.result };
  };

  return {
    async request(kind, label) {
      const origin = normalizeOrigin(deps.currentOrigin() ?? '');
      if (!origin) return { ok: false, error: SECURE_ERRORS.noPage };
      if (pendingCount() >= MAX_PENDING) return { ok: false, error: SECURE_ERRORS.tooMany };
      const entry = open({
        id: newId(),
        origin,
        kind,
        label: label.trim().slice(0, MAX_LABEL),
        allowSave: kind === 'password',
        purpose: 'fill',
      });
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

    async respond({ id, value, cancelled, save }) {
      const entry = entries.get(id);
      if (!entry || entry.outcome) return;
      const { request } = entry;
      if (cancelled || !value) {
        entry.settle({ result: 'cancelado' });
        if (request.purpose === 'save-only') entries.delete(id);
        return;
      }
      if (request.purpose === 'save-only') {
        entries.delete(id);
        entry.settle({ result: 'enviado' });
        await savePassword(deps.vault(), request.origin, value);
        return;
      }
      // Mark settled before awaiting so a duplicate response cannot fill twice.
      entry.outcome = { result: 'enviado' };
      const filled = await deps
        .fill(value, { requirePassword: request.kind === 'password', allowedOrigins: [request.origin] })
        .catch((): FillResult => ({ ok: false, error: 'não foi possível preencher o campo' }));
      if (filled.ok === false) {
        entry.settle({ error: filled.error });
        return;
      }
      if (save && request.kind === 'password' && request.allowSave) {
        await savePassword(deps.vault(), request.origin, value).catch((): void => undefined);
      }
      entry.settle({ result: 'enviado' });
    },
  };
}
