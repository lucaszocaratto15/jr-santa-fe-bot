/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Spin } from '@arco-design/web-react';
import { BookOpen } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import HandbookViewer from '@renderer/components/media/HandbookViewer';
import styles from './TeachCards.module.css';

type HandbookCardProps = {
  activityId: string;
  /** Set only for an admin viewing another role's activity (read-only). */
  roleKey?: string;
  onClose: () => void;
};

const loadMedia = (id: string) => ipcBridge.jr.handbook.media.invoke({ id });

/**
 * "Manual da função" card above the send box (bot tool `handbook_show`): the activity's
 * flowchart and its step replay. The screens are shown to the person only, never to the model.
 * With `roleKey` (admin only) it reads that role's handbook instead of the person's own.
 */
const HandbookCard: React.FC<HandbookCardProps> = ({ activityId, roleKey, onClose }) => {
  const { t } = useTranslation();
  const mine = useSWR(roleKey ? `jr.handbook.adminRole.${roleKey}` : 'jr.handbook.mine', () =>
    roleKey ? ipcBridge.jr.handbook.adminRole.invoke({ key: roleKey }) : ipcBridge.jr.handbook.mine.invoke()
  );
  const title = t('common.jr.handbook.card.title');
  return (
    <div className={`${styles.card} max-h-[60vh] overflow-auto`} role='dialog' aria-label={title}>
      <div className={styles.title}>
        <span className={styles.icon}>
          <BookOpen />
        </span>
        <span className='flex-1'>{title}</span>
        <Button size='small' type='text' onClick={onClose}>
          {t('common.jr.handbook.card.close')}
        </Button>
      </div>
      {mine.isLoading && <Spin size={14} />}
      {mine.error && <div className={styles.label}>{t('common.jr.handbook.card.loadFailed')}</div>}
      {mine.data && <HandbookViewer payload={mine.data} activityId={activityId} loadMedia={loadMedia} />}
    </div>
  );
};

export default HandbookCard;
