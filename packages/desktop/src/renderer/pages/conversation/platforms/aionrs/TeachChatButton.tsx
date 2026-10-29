/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Record } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { openDescribe, useTeachUi } from '@/renderer/pages/conversation/Preview/browser/TeachCards/teachStore';

/**
 * "Ensinar" in the bot's send box: opens the in-app browser and the describe card in this
 * chat, the same flow as the browser nav bar button. Hidden when teach is unavailable or a
 * teaching is already under way.
 */
const TeachChatButton: React.FC = () => {
  const { t } = useTranslation();
  const teach = useTeachUi();
  const openBrowserTab = useOptionalPreviewContext()?.openBrowserTab;
  if (!openBrowserTab || !teach.available || teach.phase !== 'idle' || teach.hosts.length === 0) return null;

  return (
    <Button
      type='secondary'
      shape='round'
      size='small'
      icon={<Record theme='outline' size={14} />}
      onClick={() => {
        openBrowserTab();
        openDescribe();
      }}
      data-testid='aionrs-teach-btn'
    >
      {t('common.jr.teach.controls.teach')}
    </Button>
  );
};

export default TeachChatButton;
