/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tooltip } from '@arco-design/web-react';
import { RadioTwo } from '@icon-park/react';
import React, { useState } from 'react';
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
  const [hintVisible, setHintVisible] = useState(false);
  const openBrowserTab = useOptionalPreviewContext()?.openBrowserTab;
  if (!openBrowserTab || !teach.available || teach.phase !== 'idle' || teach.hosts.length === 0) return null;

  return (
    <Tooltip
      content={t('common.jr.look.recordHint')}
      trigger={['hover', 'focus']}
      popupVisible={hintVisible}
      onVisibleChange={setHintVisible}
    >
      <Button
        type='text'
        size='small'
        className='jr-teach-chat-btn'
        aria-label={t('common.jr.look.recordProcedure')}
        icon={<RadioTwo theme='outline' size={18} />}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setHintVisible(false);
        }}
        onClick={() => {
          setHintVisible(false);
          openBrowserTab();
          openDescribe();
        }}
        data-testid='aionrs-teach-btn'
      />
    </Tooltip>
  );
};

export default TeachChatButton;
