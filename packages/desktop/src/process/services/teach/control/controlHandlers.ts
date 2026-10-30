/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HandbookService } from '../handbook/handbookService';
import type { VaultStore } from '../vault/vault';
import type { TeachHandlers } from './controlServer';
import type { FillOptions, FillResult } from './secretFill';
import { formatHandbookForBot, handbookEmptyText, HANDBOOK_UNAVAILABLE_TEXT } from './handbookForBot';
import type { SecureInputBroker, SecureKind } from './secureInput';

export type TeachHandlerDeps = {
  vault(): VaultStore | null;
  fill(value: string, opts: FillOptions): Promise<FillResult>;
  broker: SecureInputBroker;
  /** Validates a taught-task draft and shows the review card (see teachSession.ts). */
  submitDraft(markdown: string): Promise<unknown>;
  /** "Manual da função"; null when there is no JR access controller (handbook unavailable). */
  handbook(): HandbookService | null;
  /**
   * Shows the handbook card of an activity above the send box (`teach.showHandbook`).
   * `roleKey` is set only for an admin viewing another role (read-only).
   */
  showHandbook(request: { activityId: string; roleKey?: string }): void;
  /** Whether the signed-in JR user is an administrator (only admins may ask for another role). */
  isAdmin(): boolean;
};

const INVALID = { ok: false, error: 'pedido inválido' } as const;
const UNAVAILABLE = { ok: false, error: 'cofre indisponível neste computador' } as const;
const SECURE_KINDS: ReadonlySet<unknown> = new Set<SecureKind>(['otp', 'password', 'text']);

const MAX_QUERY = 300;
const MAX_ROLE = 80;

/** Same normalization as the control server's role key. */
const roleKey = (title: string): string =>
  title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

const field = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;

/**
 * Single registration point for control handlers. Every response is `{ ok, ... }` and never
 * contains a secret or typed value.
 */
export function buildTeachHandlers(deps: TeachHandlerDeps): TeachHandlers {
  const usableVault = () => {
    const vault = deps.vault();
    return vault?.available() ? vault : null;
  };

  /** Role key of an admin's last handbook_lookup of another role (handbook_show falls back to it). */
  let adminLookedUpRole: string | null = null;

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
      const submit = field(body, 'submit') === true;
      const filled = await deps.fill(secret, {
        requirePassword: which === 'password',
        // R16: usernames are redaction-only so they never block the rest of the login flow.
        ...(which === 'username' ? { redactOnly: true } : {}),
        allowedOrigins: item.origins,
        ...(submit ? { submit } : {}),
      });
      return filled.ok === false ? { ok: false, error: filled.error } : { ok: true, result: 'preenchido' };
    },

    secure_input: async (body) => {
      const kind = field(body, 'kind');
      const label = field(body, 'label');
      if (!SECURE_KINDS.has(kind) || typeof label !== 'string') return INVALID;
      return field(body, 'submit') === true
        ? deps.broker.request(kind as SecureKind, label, { submit: true })
        : deps.broker.request(kind as SecureKind, label);
    },

    secure_input_status: async (body) => {
      const id = field(body, 'id');
      if (typeof id !== 'string' || id === '') return INVALID;
      return deps.broker.status(id);
    },

    teach_submit_draft: async (body) => {
      const markdown = field(body, 'markdown');
      if (typeof markdown !== 'string') return INVALID;
      return deps.submitDraft(markdown);
    },

    handbook_lookup: async (body) => {
      const query = field(body, 'query');
      const role = field(body, 'role');
      if ((query !== undefined && typeof query !== 'string') || (role !== undefined && typeof role !== 'string'))
        return INVALID;
      const service = deps.handbook();
      if (!service) return { ok: false, error: HANDBOOK_UNAVAILABLE_TEXT };
      const text = typeof query === 'string' ? query.slice(0, MAX_QUERY) : undefined;
      // An employee only reads the handbook of their own registered role; `role` is ignored.
      const wanted = typeof role === 'string' ? role.trim().slice(0, MAX_ROLE) : '';
      if (wanted && deps.isAdmin()) {
        try {
          const key = roleKey(wanted);
          const payload = await service.adminRole(key);
          adminLookedUpRole = key;
          return { ok: true, result: formatHandbookForBot(payload, text) };
        } catch {
          return { ok: true, result: handbookEmptyText(wanted) };
        }
      }
      try {
        return { ok: true, result: formatHandbookForBot(await service.mine(), text) };
      } catch {
        return { ok: false, error: HANDBOOK_UNAVAILABLE_TEXT };
      }
    },

    handbook_show: async (body) => {
      const activityId = field(body, 'activityId');
      const role = field(body, 'role');
      if (typeof activityId !== 'string' || activityId === '' || (role !== undefined && typeof role !== 'string'))
        return INVALID;
      const service = deps.handbook();
      if (!service) return { ok: false, error: HANDBOOK_UNAVAILABLE_TEXT };
      const has = (payload: { items: Array<{ id: string }> }) => payload.items.some((item) => item.id === activityId);
      // An admin may show, read-only, an activity of any role: the one named, else the last looked up.
      const admin = deps.isAdmin();
      const wanted = admin && typeof role === 'string' ? role.trim().slice(0, MAX_ROLE) : '';
      try {
        if (wanted) {
          const key = roleKey(wanted);
          if (!has(await service.adminRole(key))) return { ok: false, error: 'não encontrado' };
          deps.showHandbook({ activityId, roleKey: key });
          return { ok: true, result: 'mostrado' };
        }
        if (has(await service.mine())) {
          deps.showHandbook({ activityId });
          return { ok: true, result: 'mostrado' };
        }
        if (admin && adminLookedUpRole && has(await service.adminRole(adminLookedUpRole))) {
          deps.showHandbook({ activityId, roleKey: adminLookedUpRole });
          return { ok: true, result: 'mostrado' };
        }
      } catch {
        return { ok: false, error: HANDBOOK_UNAVAILABLE_TEXT };
      }
      return { ok: false, error: 'não encontrado' };
    },
  };
}
