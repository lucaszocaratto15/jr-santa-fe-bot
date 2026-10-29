/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Message, Skeleton, Spin } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { discardRecording, knownTeachError, sendToTeachConversation, useTeachUi } from './teachStore';
import styles from './TeachCards.module.css';

/**
 * Shown while the bot turns the recording into a draft. Lets the employee ask again (when the
 * prompt could not be sent or the bot's draft was refused) or give up and drop the recording.
 */
const GeneratingCard: React.FC = () => {
  const { t } = useTranslation();
  const { prompt, sendFailed, draftError } = useTeachUi();
  const [discarding, setDiscarding] = useState(false);
  const title = t('common.jr.teach.generating.title');

  let problem: string | null = null;
  if (sendFailed) problem = t('common.jr.teach.generating.sendFailed');
  else if (draftError) {
    const code = knownTeachError(draftError);
    problem = code ? t(`common.jr.teach.errors.${code}`) : t('common.jr.teach.generating.rejected');
  }

  const discard = async () => {
    setDiscarding(true);
    try {
      await discardRecording();
    } catch {
      Message.error(t('common.jr.teach.review.discardFailed'));
      setDiscarding(false);
    }
  };

  return (
    <div className={styles.card} role='dialog' aria-label={title}>
      <div className={styles.title}>
        <Spin size={14} />
        <span>{title}</span>
      </div>
      {problem ? (
        <div className={styles.label} role='alert'>
          {problem}
        </div>
      ) : (
        <Skeleton animation text={{ rows: 2, width: ['65%', '45%'] }} />
      )}
      <div className={styles.actions}>
        <Button onClick={() => void discard()} loading={discarding}>
          {t('common.jr.teach.review.discard')}
        </Button>
        <Button onClick={() => prompt && sendToTeachConversation(prompt)} disabled={!prompt || discarding}>
          {t('common.jr.teach.review.askAgain')}
        </Button>
      </div>
    </div>
  );
};

export default GeneratingCard;
