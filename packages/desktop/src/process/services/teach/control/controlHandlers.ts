/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TeachHandlers } from './controlServer';

const notReady = async (): Promise<unknown> => ({ ok: false, error: 'not ready' });

/** Single registration point for control handlers; Tasks 8 and 9 replace the stubs. */
export function buildTeachHandlers(): TeachHandlers {
  return {
    vault_list: notReady,
    vault_fill: notReady,
    secure_input: notReady,
    secure_input_status: notReady,
    teach_submit_draft: notReady,
  };
}
