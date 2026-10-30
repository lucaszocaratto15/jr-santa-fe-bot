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
