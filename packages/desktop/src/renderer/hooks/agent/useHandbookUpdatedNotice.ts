/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message } from '@arco-design/web-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';

export const HANDBOOK_DRAFTS_KEY = 'jr.handbook.drafts';

/**
 * One non-blocking notice per sync that auto-published Manual items ("Seu Manual foi atualizado —
 * revise se quiser"), and a refresh of the Manual panel. Mount once in the JR sidebar.
 */
export function useHandbookUpdatedNotice(): void {
  const { t } = useTranslation();
  useEffect(
    () =>
      ipcBridge.jr.handbook.updated.on(() => {
        Message.info(t('common.jr.handbook.updatedNotice'));
        void mutate(HANDBOOK_DRAFTS_KEY);
      }),
    [t]
  );
}
