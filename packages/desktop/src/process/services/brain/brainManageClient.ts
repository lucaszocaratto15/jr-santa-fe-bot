/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manager routes of the company brain (`/api/brain/manage/*`). Responses are shape-checked like the
 * rest of the brain client; failures reach the renderer as `BRAIN_*` messages (see BrainManageError).
 */

import type {
  BrainAreaMember,
  BrainFactFilters,
  BrainFactPatch,
  BrainLogEntry,
  BrainManagedArea,
  BrainManagedFact,
  BrainManageError,
  BrainMembership,
} from '@/common/types/agent/brainTypes';
import type { BrainCall } from '@process/services/jr/brainClient';

export type BrainManageClient = {
  facts(filters: BrainFactFilters): Promise<BrainManagedFact[]>;
  updateFact(id: number, patch: BrainFactPatch): Promise<BrainManagedFact>;
  history(id: number): Promise<BrainManagedFact[]>;
  areas(): Promise<BrainManagedArea[]>;
  createArea(name: string): Promise<{ id: number; name: string }>;
  renameArea(id: number, name: string): Promise<void>;
  removeArea(id: number): Promise<void>;
  setMemberships(userId: string, memberships: BrainMembership[]): Promise<BrainMembership[]>;
  deleteAuthorFacts(userId: string): Promise<number>;
  log(since?: number): Promise<BrainLogEntry[]>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
const nullableNumber = (value: unknown): value is number | null => value === null || Number.isFinite(value);
const level = (value: unknown): value is 'colaborador' | 'gestor' => value === 'colaborador' || value === 'gestor';

const invalid = (): never => {
  throw new Error('unavailable');
};

/** The control server collapses brain errors into its own codes; map them back to what the screen shows. */
function toManageError(failure: unknown): Error {
  const status = (failure as { status?: unknown } | null)?.status;
  const message = failure instanceof Error ? failure.message : '';
  let code: BrainManageError | null = null;
  if (status === 400) code = 'BRAIN_REJECTED';
  else if (status === 404) code = 'BRAIN_NOT_FOUND';
  else if (message === 'JR_ACCESS_EMPLOYEE_REVOKED' || status === 409) code = 'BRAIN_CONFLICT';
  else if (message === 'JR_ACCESS_FORBIDDEN' || status === 403) code = 'BRAIN_FORBIDDEN';
  return code ? new Error(code, { cause: failure }) : failure instanceof Error ? failure : new Error('unavailable');
}

function parseFact(value: unknown): BrainManagedFact {
  if (
    !record(value) ||
    !Number.isInteger(value.id) ||
    !Number.isInteger(value.areaId) ||
    (value.risk !== 'low' && value.risk !== 'high') ||
    typeof value.kind !== 'string' ||
    typeof value.text !== 'string' ||
    !nullableText(value.sourceQuote) ||
    (value.sourceKind !== 'usuario_afirmou' && value.sourceKind !== 'bot_concluiu') ||
    typeof value.authorUserId !== 'string' ||
    !nullableText(value.authorBot) ||
    !nullableText(value.erpRef) ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.confidence) ||
    typeof value.active !== 'boolean' ||
    typeof value.suspended !== 'boolean' ||
    typeof value.flagConflict !== 'boolean' ||
    typeof value.humanEdited !== 'boolean' ||
    !nullableNumber(value.updatedAt) ||
    !(value.effectiveConfidence === undefined || Number.isFinite(value.effectiveConfidence))
  )
    return invalid();
  return {
    id: value.id as number,
    areaId: value.areaId as number,
    risk: value.risk,
    kind: value.kind,
    text: value.text,
    sourceQuote: value.sourceQuote,
    sourceKind: value.sourceKind,
    authorUserId: value.authorUserId,
    authorBot: value.authorBot,
    erpRef: value.erpRef,
    createdAt: value.createdAt as number,
    confidence: value.confidence as number,
    active: value.active,
    suspended: value.suspended,
    flagConflict: value.flagConflict,
    humanEdited: value.humanEdited,
    updatedAt: value.updatedAt,
    ...(value.effectiveConfidence === undefined ? {} : { effectiveConfidence: value.effectiveConfidence as number }),
  };
}

function parseMember(value: unknown): BrainAreaMember {
  if (!record(value) || typeof value.userId !== 'string' || !level(value.level) || typeof value.primary !== 'boolean')
    return invalid();
  return { userId: value.userId, level: value.level, primary: value.primary };
}

function parseMembership(value: unknown): BrainMembership {
  if (!record(value) || !Number.isInteger(value.areaId) || !level(value.level) || typeof value.primary !== 'boolean')
    return invalid();
  return { areaId: value.areaId as number, level: value.level, primary: value.primary };
}

function parseArea(value: unknown): BrainManagedArea {
  if (
    !record(value) ||
    !Number.isInteger(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.isGeneral !== 'boolean' ||
    !Array.isArray(value.members)
  )
    return invalid();
  return {
    id: value.id as number,
    name: value.name,
    isGeneral: value.isGeneral,
    members: value.members.map(parseMember),
  };
}

function parseLog(value: unknown): BrainLogEntry {
  if (
    !record(value) ||
    !Number.isInteger(value.id) ||
    !Number.isFinite(value.at) ||
    typeof value.userId !== 'string' ||
    typeof value.action !== 'string' ||
    !(value.factId === null || Number.isInteger(value.factId))
  )
    return invalid();
  return {
    id: value.id as number,
    at: value.at as number,
    userId: value.userId,
    action: value.action,
    factId: value.factId as number | null,
  };
}

/** Non-GET calls always carry a JSON body: the control server only parses bodies with a content type. */
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
});

export function createBrainManageClient(rawCall: BrainCall): BrainManageClient {
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    try {
      return await rawCall(path, init);
    } catch (failure) {
      throw toManageError(failure);
    }
  };
  const list = <T>(value: unknown, key: string, parse: (entry: unknown) => T): T[] =>
    record(value) && Array.isArray(value[key]) ? (value[key] as unknown[]).map(parse) : invalid();
  return {
    async facts(filters) {
      const params = new URLSearchParams();
      if (filters.areaId !== undefined) params.set('areaId', String(filters.areaId));
      if (filters.risk) params.set('risk', filters.risk);
      if (filters.kind) params.set('kind', filters.kind);
      if (filters.suspended !== undefined) params.set('suspended', String(filters.suspended));
      if (filters.q?.trim()) params.set('q', filters.q.trim());
      const query = params.toString();
      return list(await call(`/api/brain/manage/facts${query ? `?${query}` : ''}`, send('GET')), 'facts', parseFact);
    },
    async updateFact(id, patch) {
      const value = await call(`/api/brain/manage/facts/${id}`, send('PATCH', patch));
      return record(value) ? parseFact(value.fact) : invalid();
    },
    async history(id) {
      return list(await call(`/api/brain/manage/facts/${id}/history`, send('GET')), 'history', parseFact);
    },
    async areas() {
      return list(await call('/api/brain/manage/areas', send('GET')), 'areas', parseArea);
    },
    async createArea(name) {
      const value = await call('/api/brain/manage/areas', send('POST', { name }));
      const area = record(value) ? value.area : null;
      if (!record(area) || !Number.isInteger(area.id) || typeof area.name !== 'string') return invalid();
      return { id: area.id as number, name: area.name };
    },
    async renameArea(id, name) {
      const value = await call(`/api/brain/manage/areas/${id}`, send('PATCH', { name }));
      if (!record(value) || !record(value.area)) invalid();
    },
    async removeArea(id) {
      const value = await call(`/api/brain/manage/areas/${id}`, send('DELETE'));
      if (!record(value) || value.removed !== true) invalid();
    },
    async setMemberships(userId, memberships) {
      const value = await call(`/api/brain/manage/members/${encodeURIComponent(userId)}`, send('PUT', { memberships }));
      return list(value, 'memberships', parseMembership);
    },
    async deleteAuthorFacts(userId) {
      const value = await call(`/api/brain/manage/authors/${encodeURIComponent(userId)}/facts`, send('DELETE'));
      return record(value) && Number.isInteger(value.deleted) ? (value.deleted as number) : invalid();
    },
    async log(since) {
      const query = since ? `?since=${Math.floor(since)}` : '';
      return list(await call(`/api/brain/manage/log${query}`, send('GET')), 'log', parseLog);
    },
  };
}
