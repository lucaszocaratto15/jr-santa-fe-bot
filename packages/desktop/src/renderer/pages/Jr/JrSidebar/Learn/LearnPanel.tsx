import { ipcBridge } from '@/common';
import {
  LEARN_TERM_VERSION,
  type LearnExclusion,
  type LearnState,
  type LearnSuggestion,
} from '@/common/types/agent/learnTypes';
import { Alert, Button, Message, Modal, Tag } from '@arco-design/web-react';
import { PauseOne, PlayOne } from '@icon-park/react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from '../JrSidebar.module.css';
import ConsentModal, { TermModal } from './ConsentModal';
import ExclusionList from './ExclusionList';
import InsightList from './InsightList';
import { useLearnState } from './useLearnState';

const INSIGHTS_KEY = 'jr.learn.insights';
const EXCLUSIONS_KEY = 'jr.learn.exclusions';

type LearnPanelProps = {
  /** Opened by the once-per-session reconsent prompt: show the term modal right away. */
  autoConsent?: boolean;
  onTeach: (suggestion: LearnSuggestion) => void;
};

const STATUS_KEY = {
  active: 'common.jr.learn.panel.status.active',
  paused: 'common.jr.learn.panel.status.paused',
  off: 'common.jr.learn.panel.status.off',
  'needs-consent': 'common.jr.learn.panel.status.needsConsent',
  unavailable: 'common.jr.learn.panel.status.unavailable',
} as const;

/** Configurações → Aprender: consent, insights, exclusions and the employee's data controls. */
const LearnPanel: React.FC<LearnPanelProps> = ({ autoConsent, onTeach }) => {
  const { t, i18n } = useTranslation();
  const { state, refresh } = useLearnState();
  const [consentOpen, setConsentOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const [confirm, setConfirm] = useState<'revoke' | 'wipe' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const autoOpened = useRef(false);
  const on = state?.status === 'active' || state?.status === 'paused';
  const insights = useSWR(on ? INSIGHTS_KEY : null, () => ipcBridge.learn.listInsights.invoke());
  const exclusions = useSWR(on ? EXCLUSIONS_KEY : null, () => ipcBridge.learn.getExclusions.invoke());

  useEffect(() => {
    if (!autoConsent || autoOpened.current || state?.status !== 'needs-consent') return;
    autoOpened.current = true;
    setConsentOpen(true);
  }, [autoConsent, state?.status]);

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

  const enable = () => {
    // Same term already accepted ("Desligar" keeps consent): no need to ask again.
    if (state?.acceptedVersion === LEARN_TERM_VERSION) void act('enable', () => ipcBridge.learn.turnOn.invoke());
    else setConsentOpen(true);
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

  const runConfirmed = () => {
    const which = confirm;
    setConfirm(null);
    if (which === 'revoke') {
      void act('revoke', async () => {
        await ipcBridge.learn.revoke.invoke();
        await insights.mutate([], { revalidate: false });
        Message.success(t('common.jr.learn.data.revokeDone'));
      });
    } else if (which === 'wipe') {
      void act('wipe', () => ipcBridge.learn.wipeSamples.invoke());
    }
  };

  const onAccepted = (_next: LearnState) => {
    setConsentOpen(false);
    void refresh();
  };

  const header = (
    <div className='flex items-center gap-12px mb-4px'>
      <h2 className={`${styles.pageTitle} flex-1 !mb-0`}>{t('common.jr.learn.panel.title')}</h2>
      {state && state.status !== 'unavailable' && (
        <Tag color={state.status === 'active' ? 'green' : undefined}>{t(STATUS_KEY[state.status])}</Tag>
      )}
    </div>
  );

  const consentModal = (
    <ConsentModal
      visible={consentOpen}
      reconsent={state?.status === 'needs-consent'}
      onClose={() => setConsentOpen(false)}
      onAccepted={onAccepted}
    />
  );

  if (!state) return header;

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
      </div>
    );
  }

  if (state.status === 'off' || state.status === 'needs-consent') {
    const reconsent = state.status === 'needs-consent';
    return (
      <div>
        {header}
        <p className={`${styles.muted} mb-16px`}>
          {t(reconsent ? 'common.jr.learn.panel.needsConsent' : 'common.jr.learn.panel.offIntro')}
        </p>
        <Button type='primary' loading={busy === 'enable'} onClick={reconsent ? () => setConsentOpen(true) : enable}>
          {t(reconsent ? 'common.jr.learn.panel.reviewTerm' : 'common.jr.learn.panel.enable')}
        </Button>
        {consentModal}
      </div>
    );
  }

  const paused = state.status === 'paused';
  const acceptedAt = state.acceptedAt
    ? new Intl.DateTimeFormat(i18n.language || 'pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(state.acceptedAt)
      )
    : '';

  return (
    <div>
      {header}
      <p className={`${styles.muted} mb-16px`}>{t('common.jr.learn.panel.onlyYou')}</p>

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

      <div className={`${styles.cardRow} mb-12px`}>
        <h3 className={`${styles.cardTitle} flex-1`}>{t('common.jr.learn.insights.title')}</h3>
        <Button
          className={styles.softButton}
          size='small'
          icon={paused ? <PlayOne theme='outline' size={14} /> : <PauseOne theme='outline' size={14} />}
          loading={busy === 'pause'}
          onClick={() =>
            void act('pause', () =>
              paused ? ipcBridge.learn.resume.invoke() : ipcBridge.learn.pause.invoke({ minutes: null })
            )
          }
        >
          {t(paused ? 'common.jr.learn.panel.resume' : 'common.jr.learn.panel.pause')}
        </Button>
        <Button type='primary' size='small' loading={busy === 'generate'} onClick={() => void generate()}>
          {t('common.jr.learn.insights.generate')}
        </Button>
      </div>
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

      <div className={`${styles.card} mt-14px`}>
        <h3 className={styles.cardTitle}>{t('common.jr.learn.exclusions.title')}</h3>
        <ExclusionList
          rules={exclusions.data ?? []}
          onChange={(rules) => void saveExclusions(rules)}
          onRestore={() => void restoreExclusions()}
        />
      </div>

      <div className={`${styles.card} ${styles.cardList}`}>
        <div className={styles.row}>
          <div className={styles.rowCopy}>
            <p className={styles.rowTitle}>{t('common.jr.learn.data.title')}</p>
            <p className={styles.muted}>{t('common.jr.learn.data.rawHours', { count: state.rawHours })}</p>
          </div>
          <div className={styles.rowActions}>
            <Button className={styles.softButton} size='small' onClick={() => setConfirm('wipe')}>
              {t('common.jr.learn.data.wipeNow')}
            </Button>
          </div>
        </div>
        <div className={styles.row}>
          <p className={`${styles.muted} flex-1`}>
            {t('common.jr.learn.data.accepted', { date: acceptedAt, version: state.acceptedVersion ?? '' })}
          </p>
          <div className={styles.rowActions}>
            <Button type='text' size='small' onClick={() => setTermOpen(true)}>
              {t('common.jr.learn.data.readTerm')}
            </Button>
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.rowActions}>
            <Button
              className={styles.softButton}
              size='small'
              loading={busy === 'off'}
              onClick={() => void act('off', () => ipcBridge.learn.turnOff.invoke())}
            >
              {t('common.jr.learn.data.turnOff')}
            </Button>
            <Button status='danger' size='small' loading={busy === 'revoke'} onClick={() => setConfirm('revoke')}>
              {t('common.jr.learn.data.revoke')}
            </Button>
          </div>
        </div>
      </div>

      <Modal
        visible={confirm !== null}
        title={t(confirm === 'revoke' ? 'common.jr.learn.data.revoke' : 'common.jr.learn.data.wipeNow')}
        okText={t(confirm === 'revoke' ? 'common.jr.learn.data.revoke' : 'common.jr.learn.data.wipeNow')}
        cancelText={t('common.cancel')}
        okButtonProps={{ status: 'danger' }}
        onOk={runConfirmed}
        onCancel={() => setConfirm(null)}
        unmountOnExit
      >
        {t(confirm === 'revoke' ? 'common.jr.learn.data.revokeConfirm' : 'common.jr.learn.data.wipeConfirm')}
      </Modal>
      <TermModal visible={termOpen} onClose={() => setTermOpen(false)} />
      {consentModal}
    </div>
  );
};

export default LearnPanel;
