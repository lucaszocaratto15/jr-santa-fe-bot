import { ipcBridge } from '@/common';
import type { LearnExclusion, LearnSuggestion } from '@/common/types/agent/learnTypes';
import { Alert, Button, Message, Modal } from '@arco-design/web-react';
import { Lock, PauseOne, PlayOne } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from '../JrSidebar.module.css';
import DataNoticeModal from '../Brain/DataNoticeModal';
import ExclusionList from './ExclusionList';
import InsightList from './InsightList';
import { useLearnState } from '@renderer/hooks/agent/useLearnState';
import { PageHeader, SectionLabel } from '../Teach/PanelParts';

const INSIGHTS_KEY = 'jr.learn.insights';
const EXCLUSIONS_KEY = 'jr.learn.exclusions';

type LearnPanelProps = {
  onTeach: (suggestion: LearnSuggestion) => void;
};

const STATUS_KEY = {
  active: 'common.jr.learn.panel.status.active',
  paused: 'common.jr.learn.panel.status.paused',
  unavailable: 'common.jr.learn.panel.status.unavailable',
} as const;

/**
 * Configurações → Aprender: always on, so there is no opt-in and no off switch. Shows status,
 * the one daily pause (hidden once used, without a word about it), insights, exclusions and the
 * employee's data controls, with a link to the Data Notice.
 */
const LearnPanel: React.FC<LearnPanelProps> = ({ onTeach }) => {
  const { t } = useTranslation();
  const { state, refresh } = useLearnState();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const available = Boolean(state && state.status !== 'unavailable');
  const insights = useSWR(state ? INSIGHTS_KEY : null, () => ipcBridge.learn.listInsights.invoke());
  const exclusions = useSWR(available ? EXCLUSIONS_KEY : null, () => ipcBridge.learn.getExclusions.invoke());

  const act = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    try {
      await action();
      await refresh();
    } catch {
      Message.error(t('common.jr.learn.panel.actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    act('generate', async () => {
      const result = await ipcBridge.learn.generateNow.invoke();
      if ('code' in result) {
        Message.warning(t(`common.jr.learn.insights.errors.${result.code}`));
        return;
      }
      Message.success(t('common.jr.learn.insights.generated'));
      await insights.mutate();
    });

  const saveExclusions = (rules: LearnExclusion[]) =>
    act('exclusions', async () => {
      await exclusions.mutate(await ipcBridge.learn.setExclusions.invoke(rules), { revalidate: false });
    });

  const restoreExclusions = () =>
    act('exclusions', async () => {
      await exclusions.mutate(await ipcBridge.learn.restoreDefaultExclusions.invoke(), { revalidate: false });
    });

  const confirmedWipe = () => {
    setConfirmWipe(false);
    void act('wipe', () => ipcBridge.learn.wipeSamples.invoke());
  };

  const statusChip = state && (
    <span className={`${styles.chip} ${state.status === 'active' ? styles.chipSuccess : ''}`}>
      <span className={styles.dot} aria-hidden='true' />
      {t(STATUS_KEY[state.status])}
    </span>
  );
  // The pause is offered once per local day; afterwards the button just is not there.
  const pauseButton =
    state?.status === 'paused' ? (
      <Button
        className={styles.softButton}
        shape='round'
        size='small'
        icon={<PlayOne theme='outline' size={14} />}
        loading={busy === 'resume'}
        onClick={() => void act('resume', () => ipcBridge.learn.resume.invoke())}
      >
        {t('common.jr.learn.panel.resume')}
      </Button>
    ) : (
      state?.status === 'active' &&
      state.pauseAvailable && (
        <Button
          className={styles.softButton}
          shape='round'
          size='small'
          icon={<PauseOne theme='outline' size={14} />}
          loading={busy === 'pause'}
          onClick={() => void act('pause', () => ipcBridge.learn.pause.invoke())}
        >
          {t('common.jr.learn.panel.pause')}
        </Button>
      )
    );
  const header = (
    <PageHeader
      title={t('common.jr.learn.panel.title')}
      subtitle={
        available && (
          <>
            <Lock theme='outline' size={12} />
            <span>{t('common.jr.learn.panel.onlyYou')}</span>
          </>
        )
      }
      aside={
        (statusChip || pauseButton) && (
          <>
            {statusChip}
            {pauseButton}
          </>
        )
      }
    />
  );

  if (!state) return header;

  const noticeLink = (
    <Button className={styles.ghostIcon} shape='round' size='small' onClick={() => setNoticeOpen(true)}>
      {t('common.jr.learn.panel.readNotice')}
    </Button>
  );

  const insightList = (
    <InsightList
      batches={insights.data ?? []}
      onTeach={onTeach}
      onDelete={(id) =>
        void act('delete', async () => {
          await ipcBridge.learn.deleteInsight.invoke({ id });
          await insights.mutate();
        })
      }
    />
  );

  const dataCard = (
    <>
      <SectionLabel>{t('common.jr.learn.data.title')}</SectionLabel>
      <div className={`${styles.card} ${styles.cardList}`}>
        <div className={styles.row}>
          <p className={`${styles.rowTitle} flex-1`}>{t('common.jr.learn.data.rawHours', { count: state.rawHours })}</p>
          <div className={styles.rowActions}>
            <Button className={styles.ghostIcon} shape='round' size='small' onClick={() => setConfirmWipe(true)}>
              {t('common.jr.learn.data.wipeNow')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );

  const dialogs = (
    <>
      <Modal
        visible={confirmWipe}
        title={t('common.jr.learn.data.wipeNow')}
        okText={t('common.jr.learn.data.wipeNow')}
        cancelText={t('common.cancel')}
        okButtonProps={{ status: 'danger' }}
        onOk={confirmedWipe}
        onCancel={() => setConfirmWipe(false)}
        unmountOnExit
      >
        {t('common.jr.learn.data.wipeConfirm')}
      </Modal>
      <DataNoticeModal open={noticeOpen} onClose={() => setNoticeOpen(false)} />
    </>
  );

  if (state.status === 'unavailable') {
    return (
      <div>
        {header}
        <p className={styles.muted}>
          {t(
            state.unavailableReason === 'encryption'
              ? 'common.jr.learn.panel.unavailableEncryption'
              : 'common.jr.learn.panel.unavailablePlatform'
          )}
        </p>
        {state.rawHours > 0 && dataCard}
        {dialogs}
      </div>
    );
  }

  return (
    <div>
      {header}
      <p className={`${styles.muted} mb-12px`}>{t('common.jr.learn.panel.intro')}</p>
      <div className='mb-12px'>{noticeLink}</div>

      {state.titles === 'app-only' && (
        <Alert
          className='mb-12px'
          type='info'
          content={t('common.jr.learn.panel.screenRecording')}
          action={
            <Button size='mini' onClick={() => void ipcBridge.learn.openScreenRecordingSettings.invoke()}>
              {t('common.jr.learn.panel.openSettings')}
            </Button>
          }
        />
      )}
      {state.samplerError && (
        <Alert
          className='mb-12px'
          type='error'
          content={t('common.jr.learn.panel.samplerError')}
          action={
            <Button size='mini' onClick={() => void act('retry', () => ipcBridge.learn.resume.invoke())}>
              {t('common.jr.learn.panel.retry')}
            </Button>
          }
        />
      )}

      <SectionLabel
        aside={
          <Button
            type='primary'
            shape='round'
            size='small'
            loading={busy === 'generate'}
            onClick={() => void generate()}
          >
            {t('common.jr.learn.insights.generate')}
          </Button>
        }
      >
        {t('common.jr.learn.insights.title')}
      </SectionLabel>
      {insightList}

      <SectionLabel>{t('common.jr.learn.exclusions.title')}</SectionLabel>
      <div className={styles.card}>
        <ExclusionList
          rules={exclusions.data ?? []}
          onChange={(rules) => void saveExclusions(rules)}
          onRestore={() => void restoreExclusions()}
        />
      </div>

      {dataCard}
      {dialogs}
    </div>
  );
};

export default LearnPanel;
