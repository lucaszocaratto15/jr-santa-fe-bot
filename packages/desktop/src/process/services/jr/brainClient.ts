/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control-server client of the company brain. Every response is shape-checked; a reply that does
 * not match throws 'unavailable'. The JR session token stays in main.
 */

import type { BrainCapturePayload, BrainFact, BrainMe } from '@/common/types/agent/brainTypes';
import { createBrainManageClient, type BrainManageClient } from '@process/services/brain/brainManageClient';

export type BrainCall = (path: string, init?: RequestInit, admin?: boolean) => Promise<unknown>;

export type BrainClient = {
  capture(payload: BrainCapturePayload): Promise<void>;
  search(query: string): Promise<BrainFact[]>;
  feedback(factId: string, reason?: string): Promise<{ suspended: boolean }>;
  me(): Promise<BrainMe>;
  consent(termVersion: string): Promise<{ version: string | null; at: string | null }>;
  consentState(): Promise<{ version: string | null; at: string | null }>;
  /** Manager routes (`/api/brain/manage/*`). */
  manage: BrainManageClient;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';

const invalid = (): never => {
  throw new Error('unavailable');
};

/** Fact ids are integers on the brain; the shared type keeps them as strings. */
const factIdText = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : Number.isInteger(value) ? String(value) : null;

function parseFact(value: unknown): BrainFact {
  if (
    !record(value) ||
    !factIdText(value.id) ||
    typeof value.text !== 'string' ||
    (value.risk !== 'low' && value.risk !== 'high') ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence)
  )
    return invalid();
  const area = value.area ?? null;
  const date = value.date ?? null;
  const erpRef = value.erpRef ?? null;
  if (!nullableText(area) || !nullableText(date) || !nullableText(erpRef)) return invalid();
  return {
    id: factIdText(value.id) as string,
    text: value.text,
    area,
    risk: value.risk,
    date,
    confidence: value.confidence,
    erpRef,
  };
}

/** The brain sends numeric area ids; the shared type keeps them as strings. */
const areaIdText = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : Number.isInteger(value) ? String(value) : null;

function parseMe(value: unknown): BrainMe {
  if (!record(value) || !Array.isArray(value.areas) || typeof value.isDirector !== 'boolean') return invalid();
  if (!Array.isArray(value.manages)) return invalid();
  const manages = value.manages.map(areaIdText);
  if (manages.some((id) => id === null)) return invalid();
  const areas = value.areas.map((entry): BrainMe['areas'][number] => {
    const id = record(entry) ? areaIdText(entry.id) : null;
    if (
      !record(entry) ||
      id === null ||
      (entry.level !== 'colaborador' && entry.level !== 'gestor') ||
      typeof entry.primary !== 'boolean' ||
      !nullableText(entry.name ?? null)
    )
      return invalid();
    return { id, name: (entry.name ?? null) as string | null, level: entry.level, primary: entry.primary };
  });
  return { areas, isDirector: value.isDirector, manages: manages as string[] };
}

function parseConsent(value: unknown): { version: string | null; at: string | null } {
  if (!record(value) || !nullableText(value.version ?? null)) return invalid();
  // The brain stores the acknowledgement time as epoch milliseconds.
  const raw = value.at ?? null;
  if (raw !== null && typeof raw !== 'string' && !Number.isFinite(raw)) return invalid();
  const at = typeof raw === 'number' ? new Date(raw).toISOString() : raw;
  return { version: (value.version ?? null) as string | null, at: at as string | null };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function createBrainClient(call: BrainCall): BrainClient {
  return {
    async capture(payload) {
      const value = await call('/api/brain/capture', post(payload));
      if (!record(value) || value.accepted !== true) invalid();
    },
    async search(query) {
      const value = await call('/api/brain/search', post({ query }));
      if (!record(value) || !Array.isArray(value.facts)) return invalid();
      return value.facts.map(parseFact);
    },
    async feedback(factId, reason) {
      // The brain wants a positive integer id; anything else never reaches it.
      if (!/^[0-9]{1,12}$/u.test(factId) || Number(factId) < 1) return invalid();
      const id = Number(factId);
      const value = await call('/api/brain/feedback', post(reason ? { factId: id, reason } : { factId: id }));
      if (!record(value) || value.recorded !== true || typeof value.suspended !== 'boolean') return invalid();
      return { suspended: value.suspended };
    },
    async me() {
      return parseMe(await call('/api/brain/me'));
    },
    async consent(termVersion) {
      return parseConsent(await call('/api/brain/consent', post({ termVersion })));
    },
    async consentState() {
      return parseConsent(await call('/api/brain/consent'));
    },
    manage: createBrainManageClient(call),
  };
}
