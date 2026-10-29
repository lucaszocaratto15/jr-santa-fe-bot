/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types shared by main and renderer for "Ensinar tarefa" and the vault (Cofre) IPC.
 * None of these ever carries a stored secret back to the renderer.
 */

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export type VaultItemPublic = {
  id: string;
  name: string;
  origins: string[];
  username: string;
  hasPassword: boolean;
  hints: string;
};

/** Omitted `password` keeps the stored one. */
export type VaultUpsert = {
  id?: string;
  name: string;
  origins: string[];
  username: string;
  password?: string;
  hints?: string;
};

// ---------------------------------------------------------------------------
// Secure input
// ---------------------------------------------------------------------------

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

/** Main → renderer after an answer: `saved` is set only when a vault save was attempted. */
export type SecureRespondResult = { saved?: boolean };

// ---------------------------------------------------------------------------
// Teach recording and drafts
// ---------------------------------------------------------------------------

export type RecorderState = 'idle' | 'recording' | 'paused';

export type TeachDraft = {
  name: string;
  description: string;
  inputs: string[];
  steps: string[];
  confirmBefore: string[];
  logins: string[];
};

/** Value-free reason a draft was refused; the renderer maps it to i18n. */
export type DraftErrorCode = 'too_large' | 'no_frontmatter' | 'bad_name' | 'no_description' | 'no_steps';

export type TeachStateEvent = { state: RecorderState; elapsedMs: number };

export type TeachStopResult = {
  id: string;
  timeline: string;
  description: string;
  secretOrigins: string[];
  /** The fixed draft prompt, sent by the renderer as a normal user message. */
  prompt: string;
};

export type TeachDraftEvent = { markdown: string; recordingId: string; draft: TeachDraft };

/** Main → renderer when the bot's draft was refused. Carries a code, never the draft. */
export type TeachDraftRejectedEvent = { recordingId: string; error: DraftErrorCode };

export type TeachSaveDraftInput = { markdown: string; recordingId: string; name?: string; description?: string };
