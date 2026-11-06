/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types shared by main and renderer for the company brain ("cérebro").
 * Purpose: understand the work to help the employee; never performance evaluation or time control.
 */

/** Data-notice version. Explicit excerpt and per-version sharing consent are separate actions. */
export const BRAIN_TERM_VERSION = '2.0';

export type BrainNoteStatus = 'draft' | 'active' | 'pending_review' | 'rejected' | 'superseded' | 'suspended';
export type BrainNoteKind = 'shared_note' | 'official_procedure';
export type BrainNoteProposal = {
  id: string;
  version: number;
  hash: string;
  text: string;
  sourceQuote: string;
  areaId: number;
  risk: 'low' | 'high';
  kind: BrainNoteKind;
  status: BrainNoteStatus;
  validFrom?: number;
  validUntil?: number | null;
};
export type BrainProposalResult = {
  proposal: BrainNoteProposal;
  audiences?: Array<{ id: number; name: string }>;
};
export type BrainProposalPatch = Pick<
  BrainNoteProposal,
  'version' | 'text' | 'sourceQuote' | 'areaId' | 'kind' | 'validFrom' | 'validUntil'
>;
export type BrainProposalConsent = {
  id: string;
  version: number;
  hash: string;
  decision: 'share' | 'discard';
};

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
  noteType?: BrainNoteKind;
  version?: number;
  sourceQuote?: string | null;
};

export type BrainMe = {
  areas: Array<{ id: string; name: string | null; level: 'colaborador' | 'gestor'; primary: boolean }>;
  isDirector: boolean;
  manages: string[];
  permissionsSource?: 'erp';
  capabilities?: BrainCapabilities;
};

/** Effective rights returned by the ERP, never inferred from a JR role. */
export type BrainCapabilities = {
  read: boolean;
  publish: boolean;
  revise: boolean;
  withdraw: boolean;
  approveOfficial: boolean;
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
  /** Only the owner gets the author; gestores get null. */
  authorUserId: string | null;
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
  noteType?: BrainNoteKind;
  version?: number;
  status?: BrainNoteStatus;
  canRevise?: boolean;
  canWithdraw?: boolean;
  canReactivate?: boolean;
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
