/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VaultStore } from '../vault/vault';
import type { TeachHandlers } from './controlServer';
import type { FillOptions, FillResult } from './secretFill';
import type { SecureInputBroker, SecureKind } from './secureInput';

export type TeachHandlerDeps = {
  vault(): VaultStore | null;
  fill(value: string, opts: FillOptions): Promise<FillResult>;
  broker: SecureInputBroker;
};

const INVALID = { ok: false, error: 'pedido inválido' } as const;
const UNAVAILABLE = { ok: false, error: 'cofre indisponível neste computador' } as const;
const SECURE_KINDS: ReadonlySet<unknown> = new Set<SecureKind>(['otp', 'password', 'text']);

const field = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;

const notReady = async (): Promise<unknown> => ({ ok: false, error: 'not ready' });

/**
 * Single registration point for control handlers. Every response is `{ ok, ... }` and never
 * contains a secret or typed value. Task 9 replaces `teach_submit_draft`.
 */
export function buildTeachHandlers(deps: TeachHandlerDeps): TeachHandlers {
  const usableVault = () => {
    const vault = deps.vault();
    return vault?.available() ? vault : null;
  };

  return {
    vault_list: async () => {
      const vault = usableVault();
      if (!vault) return UNAVAILABLE;
      const items = await vault.list();
      return {
        ok: true,
        items: items.map((item) => ({
          name: item.name,
          origins: item.origins,
          hasUsername: item.username !== '',
          hasPassword: item.hasPassword,
        })),
      };
    },

    vault_fill: async (body) => {
      const name = field(body, 'item');
      const which = field(body, 'field');
      if (typeof name !== 'string' || (which !== 'username' && which !== 'password')) return INVALID;
      const vault = usableVault();
      if (!vault) return UNAVAILABLE;
      const wanted = name.trim().toLowerCase();
      const item = (await vault.list()).find((entry) => entry.name.trim().toLowerCase() === wanted);
      if (!item) return { ok: false, error: 'item do cofre não encontrado' };
      const secret = await vault.readSecret(item.id, which);
      if (!secret) return { ok: false, error: 'este item do cofre não tem esse dado salvo' };
      const filled = await deps.fill(secret, { requirePassword: which === 'password', allowedOrigins: item.origins });
      return filled.ok === false ? { ok: false, error: filled.error } : { ok: true, result: 'preenchido' };
    },

    secure_input: async (body) => {
      const kind = field(body, 'kind');
      const label = field(body, 'label');
      if (!SECURE_KINDS.has(kind) || typeof label !== 'string') return INVALID;
      return deps.broker.request(kind as SecureKind, label);
    },

    secure_input_status: async (body) => {
      const id = field(body, 'id');
      if (typeof id !== 'string' || id === '') return INVALID;
      return deps.broker.status(id);
    },

    teach_submit_draft: notReady,
  };
}
