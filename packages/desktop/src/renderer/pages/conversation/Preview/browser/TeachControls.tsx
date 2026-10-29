/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Message, Popconfirm } from '@arco-design/web-react';
import { Pause, PlayOne, Record } from '@icon-park/react';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  discardRecording,
  finishRecording,
  openDescribe,
  pauseRecording,
  resumeRecording,
  resyncTakeOver,
  setTakenOver,
  useTeachUi,
} from '@/renderer/pages/conversation/Preview/browser/TeachCards/teachStore';
import styles from './TeachControls.module.css';

/** Hard limit shown next to the timer; main enforces it (recorder RECORDING_LIMIT_MS). */
const LIMIT_LABEL = '10:00';

export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const ACTIVE_PHASES = new Set(['recording', 'paused', 'stopping', 'discarding']);

/**
 * Browser nav bar slot: "Ensinar" (opens the describe card in the chat; needs a chat that can
 * show the teach cards) and, while the agent drives the browser, "Assumir" / "Devolver ao
 * bot". Hidden when teach is unavailable (CDP bridge off) or a recording is active.
 */
const TeachControls: React.FC<{ agentActive: boolean }> = ({ agentActive }) => {
  const { t } = useTranslation();
  const teach = useTeachUi();
  useEffect(() => {
    void resyncTakeOver();
  }, []);
  if (!teach.available || ACTIVE_PHASES.has(teach.phase)) return null;
  const canTeach = teach.hosts.length > 0;
  const showTakeOver = agentActive || teach.takenOver;
  if (!canTeach && !showTakeOver) return null;

  const toggleTakeOver = async () => {
    try {
      await setTakenOver(!teach.takenOver);
    } catch {
      Message.error(t('common.jr.teach.controls.takeOverFailed'));
    }
  };

  return (
    <div className={styles.slot}>
      {showTakeOver && (
        <Button size='small' type={teach.takenOver ? 'primary' : 'secondary'} onClick={() => void toggleTakeOver()}>
          {teach.takenOver ? t('common.jr.teach.controls.giveBack') : t('common.jr.teach.controls.takeOver')}
        </Button>
      )}
      {canTeach && (
        <Button
          size='small'
          icon={<Record theme='outline' size={14} />}
          disabled={teach.phase !== 'idle'}
          onClick={openDescribe}
        >
          {t('common.jr.teach.controls.teach')}
        </Button>
      )}
    </div>
  );
};

/** Thin bar on top of the browser while a recording is active. */
export const TeachRecordingBar: React.FC = () => {
  const { t } = useTranslation();
  const teach = useTeachUi();
  if (!ACTIVE_PHASES.has(teach.phase)) return null;
  const paused = teach.phase === 'paused';
  const busy = teach.phase === 'stopping' || teach.phase === 'discarding';

  const run = async (action: () => Promise<void>, failureKey: string) => {
    try {
      await action();
    } catch {
      Message.error(t(failureKey));
    }
  };

  return (
    <div className={styles.bar} role='status'>
      <span className={paused ? `${styles.dot} ${styles.dotPaused}` : styles.dot} aria-hidden='true' />
      <span className={styles.timer}>
        {paused ? t('common.jr.teach.controls.paused') : t('common.jr.teach.controls.recording')}{' '}
        {formatElapsed(teach.elapsedMs)} / {LIMIT_LABEL}
      </span>
      <div className={styles.barActions}>
        <Button
          size='small'
          type='text'
          disabled={busy}
          icon={paused ? <PlayOne theme='outline' size={14} /> : <Pause theme='outline' size={14} />}
          onClick={() => void run(paused ? resumeRecording : pauseRecording, 'common.jr.teach.controls.actionFailed')}
        >
          {paused ? t('common.jr.teach.controls.resume') : t('common.jr.teach.controls.pause')}
        </Button>
        <Popconfirm
          title={t('common.jr.teach.controls.discardConfirm')}
          okText={t('common.jr.teach.controls.discard')}
          cancelText={t('common.jr.teach.describe.cancel')}
          onOk={() => void run(discardRecording, 'common.jr.teach.controls.actionFailed')}
        >
          <Button size='small' type='text' status='danger' disabled={busy} loading={teach.phase === 'discarding'}>
            {t('common.jr.teach.controls.discard')}
          </Button>
        </Popconfirm>
        <Button
          size='small'
          type='primary'
          disabled={busy}
          loading={teach.phase === 'stopping'}
          onClick={() => void run(finishRecording, 'common.jr.teach.controls.stopFailed')}
        >
          {t('common.jr.teach.controls.finish')}
        </Button>
      </div>
    </div>
  );
};

export default TeachControls;
