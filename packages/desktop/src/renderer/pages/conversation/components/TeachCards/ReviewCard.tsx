/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TeachDraftEvent } from '@/common/adapter/ipcBridge';
import { Alert, Button, Input, Message, Popconfirm } from '@arco-design/web-react';
import { ListCheckbox } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { discardRecording, sendToTeachConversation } from './teachStore';
import styles from './TeachCards.module.css';

type ReviewCardProps = {
  event: TeachDraftEvent;
  /** The draft prompt, re-sent by "Pedir de novo". */
  prompt: string | null;
};

type Busy = 'save' | 'discard' | null;

/**
 * The bot's draft of a taught task, in plain language. Salvar writes the SKILL.md in main,
 * imports it through the skills flow and then drops the raw recording.
 */
const ReviewCard: React.FC<ReviewCardProps> = ({ event, prompt }) => {
  const { t } = useTranslation();
  const { draft } = event;
  const [name, setName] = useState(draft.name);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const { skillPath } = await ipcBridge.teach.saveDraft.invoke({
        markdown: event.markdown,
        recordingId: event.recordingId,
        name: name.trim(),
      });
      const imported = await ipcBridge.fs.importSkill.invoke({ skill_path: skillPath });
      if (imported.failed?.length) throw new Error(imported.failed[0].code);
      // The skill is imported; the raw recording is no longer needed.
      await discardRecording().catch(() => {});
      Message.success(t('common.jr.teach.review.saved'));
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t('common.jr.teach.review.saveFailed'));
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy('discard');
    try {
      await discardRecording();
    } catch {
      Message.error(t('common.jr.teach.review.discardFailed'));
      setBusy(null);
    }
  };

  const testNow = () => {
    sendToTeachConversation(`${event.markdown}\n\n${t('common.jr.teach.review.testPrompt', { name: name.trim() })}`);
  };

  const meta: Array<{ label: string; values: string[] }> = [
    { label: t('common.jr.teach.review.inputs'), values: draft.inputs },
    {
      label: t('common.jr.teach.review.logins'),
      values: draft.logins.map((login) => `${login} · ${t('common.jr.teach.review.vault')}`),
    },
    { label: t('common.jr.teach.review.confirmBefore'), values: draft.confirmBefore },
  ].filter((row) => row.values.length > 0);

  const title = t('common.jr.teach.review.title');

  return (
    <div className={styles.card} role='dialog' aria-label={title}>
      <div className={styles.title}>
        <ListCheckbox theme='outline' size={16} className={styles.icon} />
        <span>{title}</span>
      </div>
      <Input
        value={name}
        onChange={setName}
        disabled={busy !== null}
        aria-label={t('common.jr.teach.review.name')}
        addBefore={t('common.jr.teach.review.name')}
      />
      <div className={styles.label}>{draft.description}</div>
      {meta.length > 0 && (
        <dl className={styles.meta}>
          {meta.map((row) => (
            <React.Fragment key={row.label}>
              <dt className={styles.metaLabel}>{row.label}</dt>
              <dd className={styles.metaValue}>{row.values.join('; ')}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <ol className={styles.steps}>
        {draft.steps.map((step, index) => (
          <li key={`${index}-${step}`}>{step}</li>
        ))}
      </ol>
      {error && (
        <Alert
          type='error'
          content={t('common.jr.teach.review.error', { error })}
          action={
            prompt ? (
              <Button size='mini' type='text' onClick={() => sendToTeachConversation(prompt)}>
                {t('common.jr.teach.review.askAgain')}
              </Button>
            ) : undefined
          }
        />
      )}
      <div className={styles.actions}>
        <Popconfirm
          title={t('common.jr.teach.review.discardConfirm')}
          okText={t('common.jr.teach.review.discard')}
          cancelText={t('common.jr.teach.describe.cancel')}
          onOk={() => void discard()}
        >
          <Button disabled={busy !== null} loading={busy === 'discard'}>
            {t('common.jr.teach.review.discard')}
          </Button>
        </Popconfirm>
        <Button onClick={testNow} disabled={busy !== null}>
          {t('common.jr.teach.review.test')}
        </Button>
        <Button
          type='primary'
          onClick={() => void save()}
          disabled={busy !== null || !name.trim()}
          loading={busy === 'save'}
        >
          {t('common.jr.teach.review.save')}
        </Button>
      </div>
    </div>
  );
};

export default ReviewCard;
