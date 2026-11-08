/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Message } from '@arco-design/web-react';
import { Record } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { beginRecording, cancelDescribe, useTeachUi } from './teachStore';
import styles from './TeachCards.module.css';

const MAX_DESCRIPTION = 300;

/** "O que essa tarefa faz?" — one line from the employee, then the recording starts. */
const DescribeCard: React.FC = () => {
  const { t } = useTranslation();
  const { describePrefill } = useTeachUi();
  const [description, setDescription] = useState(describePrefill ?? '');
  const [busy, setBusy] = useState(false);
  const title = t('common.jr.teach.describe.title');

  const start = async () => {
    if (!description.trim() || busy) return;
    setBusy(true);
    try {
      await beginRecording(description.trim());
    } catch {
      Message.error(t('common.jr.teach.describe.startFailed'));
      setBusy(false);
    }
  };

  return (
    <div className={styles.card} role='dialog' aria-label={title}>
      <div className={styles.title}>
        <Record theme='outline' size={16} className={styles.icon} />
        <span>{title}</span>
      </div>
      <Input.TextArea
        autoFocus
        value={description}
        maxLength={MAX_DESCRIPTION}
        autoSize={{ minRows: 2, maxRows: 4 }}
        placeholder={t('common.jr.teach.describe.placeholder')}
        onChange={setDescription}
        onPressEnter={(event) => {
          if (event.shiftKey) return;
          event.preventDefault();
          void start();
        }}
        disabled={busy}
      />
      <div className={styles.footnote}>{t('common.jr.teach.describe.hint')}</div>
      <div className={styles.actions}>
        <Button type='text' onClick={cancelDescribe} disabled={busy}>
          {t('common.jr.teach.describe.cancel')}
        </Button>
        <Button type='primary' onClick={() => void start()} disabled={!description.trim()} loading={busy}>
          {t('common.jr.teach.describe.start')}
        </Button>
      </div>
    </div>
  );
};

export default DescribeCard;
