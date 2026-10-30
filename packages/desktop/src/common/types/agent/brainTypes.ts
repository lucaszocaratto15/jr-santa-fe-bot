/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types shared by main and renderer for the company brain ("cérebro").
 * Purpose: understand the work to help the employee; never performance evaluation or time control.
 */

/** Version of the "Aviso de uso de dados". The employee can only acknowledge it; nothing is gated by it. */
export const BRAIN_TERM_VERSION = '1.4';

export type BrainRole = 'user' | 'assistant' | 'tool';

export type BrainMessage = { id: string; role: BrainRole; text: string };

/** What the renderer hands to main for one conversation stretch. */
export type BrainCaptureInput = { conversationId: string; messages: BrainMessage[] };

/** What goes to the brain (`POST /capture`): no local message ids, secrets already redacted. */
export type BrainCapturePayload = {
  conversationRef: string;
  bot: string;
  messages: Array<{ role: BrainRole; text: string }>;
};

export type BrainNoticeState = {
  acknowledgedVersion: string | null;
  /** ISO time of the latest acknowledgement. */
  acknowledgedAt: string | null;
  /** True when the acknowledged version is the current notice. */
  current: boolean;
};

export type BrainFact = {
  id: string;
  text: string;
  area: string | null;
  risk: 'low' | 'high';
  date: string | null;
  confidence: number;
  erpRef: string | null;
};

export type BrainMe = {
  areas: Array<{ id: string; name: string | null; level: 'colaborador' | 'gestor'; primary: boolean }>;
  isDirector: boolean;
  manages: string[];
};

/** Kinds the curator assigns to a fact. */
export const BRAIN_FACT_KINDS = ['fato', 'decisao', 'procedimento', 'contato', 'status'] as const;

/** A fact as the managers' screen sees it (`GET /manage/facts`): origin and review flags included. */
export type BrainManagedFact = {
  id: number;
  areaId: number;
  risk: 'low' | 'high';
  kind: string;
  text: string;
  sourceQuote: string | null;
  sourceKind: 'usuario_afirmou' | 'bot_concluiu';
  authorUserId: string;
  authorBot: string | null;
  erpRef: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  confidence: number;
  active: boolean;
  suspended: boolean;
  flagConflict: boolean;
  humanEdited: boolean;
  updatedAt: number | null;
  /** Confidence after recency decay and feedback; absent in history rows. */
  effectiveConfidence?: number;
};

export type BrainFactFilters = {
  areaId?: number;
  risk?: 'low' | 'high';
  kind?: string;
  suspended?: boolean;
  q?: string;
};

/** `general: true` promotes a low-risk fact to Geral. */
export type BrainFactPatch = {
  text?: string;
  areaId?: number;
  risk?: 'low' | 'high';
  active?: boolean;
  suspended?: boolean;
  general?: true;
};

export type BrainAreaMember = { userId: string; level: 'colaborador' | 'gestor'; primary: boolean };

export type BrainManagedArea = { id: number; name: string; isGeneral: boolean; members: BrainAreaMember[] };

export type BrainMembership = { areaId: number; level: 'colaborador' | 'gestor'; primary: boolean };

export type BrainLogEntry = {
  id: number;
  /** Epoch milliseconds. */
  at: number;
  userId: string;
  action: string;
  factId: number | null;
};

/** Errors of the manager routes, as the message of the IPC rejection. */
export const BRAIN_MANAGE_ERRORS = ['BRAIN_REJECTED', 'BRAIN_CONFLICT', 'BRAIN_FORBIDDEN', 'BRAIN_NOT_FOUND'] as const;
export type BrainManageError = (typeof BRAIN_MANAGE_ERRORS)[number];

/** Owner-only protected areas by name (the brain seeds both). */
export const BRAIN_FALLBACK_AREA_NAME = 'Sem área';
