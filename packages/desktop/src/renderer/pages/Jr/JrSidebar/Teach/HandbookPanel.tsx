/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Message, Modal, Popconfirm, Spin } from '@arco-design/web-react';
import { BookOpen, ChartHistogram, Check, FileText } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type {
  HandbookActivityBody,
  HandbookDraft,
  HandbookIndicatorsBody,
  HandbookPublished,
} from '@/common/types/agent/handbookTypes';
import HandbookViewer from '@renderer/components/media/HandbookViewer';
import styles from '../JrSidebar.module.css';
import HandbookDraftEditor, { handbookErrorKey } from './HandbookDraftEditor';
import { EmptyState, PageHeader, SectionLabel } from './PanelParts';

const DRAFTS_KEY = 'jr.handbook.drafts';
const MINE_KEY = 'jr.handbook.mine';
const loadMedia = (id: string) => ipcBridge.jr.handbook.media.invoke({ id });

const draftLabel = (draft: HandbookDraft, t: (key: string, options?: Record<string, unknown>) => string) => {
  if (draft.kind === 'indicators')
    return t('common.jr.handbook.kindIndicators', { week: (draft.body as HandbookIndicatorsBody).weekStart });
  const { title } = draft.body as HandbookActivityBody;
  return t(draft.source === 'taught' ? 'common.jr.handbook.kindTaught' : 'common.jr.handbook.kindLearn', { title });
};

/**
 * "Manual da função" tab: the employee reviews each draft and approves it (which publishes it to
 * the role handbook), dismisses it, or withdraws what they approved. There is no manager step.
 */
const HandbookPanel: React.FC = () => {
  const { t } = useTranslation();
  const drafts = useSWR(DRAFTS_KEY, () => ipcBridge.jr.handbook.drafts.invoke(), { shouldRetryOnError: false });
  const [editing, setEditing] = useState<HandbookDraft | null>(null);
  const [viewing, setViewing] = useState<HandbookPublished | null>(null);
  const mine = useSWR(viewing ? MINE_KEY : null, () => ipcBridge.jr.handbook.mine.invoke());
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, action: () => Promise<void>, success?: string) => {
    setBusy(id);
    try {
      await action();
      if (success) Message.success(t(success));
      await drafts.mutate();
    } catch (error) {
      Message.error(t(handbookErrorKey(error)));
    } finally {
      setBusy(null);
    }
  };

  const header = (
    <PageHeader
      title={t('common.jr.handbook.title')}
      subtitle={drafts.data?.role ? t('common.jr.handbook.visibleNotice') : undefined}
      aside={
        drafts.data?.role && (
          <span className={styles.chip}>
            <BookOpen theme='outline' size={11} />
            {t('common.jr.handbook.roleLabel', { role: drafts.data.role.title })}
          </span>
        )
      }
    />
  );
  if (drafts.isLoading)
    return (
      <div>
        {header}
        <Spin />
      </div>
    );
  if (drafts.error || !drafts.data) {
    const unavailable = handbookErrorKey(drafts.error) === 'common.jr.handbook.errors.unavailable';
    return (
      <div>
        {header}
        <Alert
          type='warning'
          content={t(unavailable ? 'common.jr.handbook.unavailable' : 'common.jr.handbook.loadFailed')}
        />
      </div>
    );
  }
  const { role, published } = drafts.data;
  if (!role) {
    return (
      <div>
        {header}
        <Alert type='warning' content={t('common.jr.handbook.noRole')} />
      </div>
    );
  }
  return (
    <div>
      {header}
      <SectionLabel>{t('common.jr.handbook.draftsTitle')}</SectionLabel>
      <div className={`${styles.card} ${styles.cardList}`}>
        {drafts.data.drafts.length === 0 && (
          <EmptyState icon={<Check theme='outline' size={18} />} title={t('common.jr.handbook.noDrafts')} />
        )}
        {drafts.data.drafts.map((draft) => (
          <div key={draft.key} className={styles.row} data-testid={`draft-${draft.key}`}>
            <span className={styles.rowIcon} aria-hidden='true'>
              {draft.kind === 'activity' ? (
                <FileText theme='outline' size={16} />
              ) : (
                <ChartHistogram theme='outline' size={16} />
              )}
            </span>
            <div className={styles.rowCopy}>
              <p className={`${styles.rowTitle} font-500`}>
                {draftLabel(draft, t)}{' '}
                {draft.status === 'changed' && (
                  <span className={`${styles.chip} ${styles.chipWarning}`}>{t('common.jr.handbook.changed')}</span>
                )}
              </p>
              {draft.kind === 'activity' && (
                <p className={styles.rowMeta}>
                  {t('common.jr.handbook.stepsCount', {
                    steps: (draft.body as HandbookActivityBody).steps.length,
                    shots: draft.shots.length,
                  })}
                </p>
              )}
            </div>
            <div className={styles.rowActions}>
              <Button className={styles.softButton} shape='round' size='small' onClick={() => setEditing(draft)}>
                {t('common.jr.handbook.review')}
              </Button>
              <Button
                className={styles.ghostIcon}
                shape='round'
                size='small'
                loading={busy === draft.key}
                onClick={() => void act(draft.key, () => ipcBridge.jr.handbook.dismiss.invoke({ key: draft.key }))}
              >
                {t('common.jr.handbook.dismiss')}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <SectionLabel>{t('common.jr.handbook.publishedTitle')}</SectionLabel>
      <div className={`${styles.card} ${styles.cardList}`}>
        {published.length === 0 && (
          <EmptyState icon={<BookOpen theme='outline' size={18} />} title={t('common.jr.handbook.noPublished')} />
        )}
        {published.map((entry) => (
          <div key={entry.key} className={styles.row} data-testid={`published-${entry.itemId}`}>
            <span className={styles.rowIcon} aria-hidden='true'>
              {entry.kind === 'activity' ? (
                <FileText theme='outline' size={16} />
              ) : (
                <ChartHistogram theme='outline' size={16} />
              )}
            </span>
            <p className={`${styles.rowTitle} font-500 flex-1`}>
              {entry.kind === 'indicators'
                ? t('common.jr.handbook.kindIndicators', { week: entry.title })
                : entry.title}
            </p>
            <div className={styles.rowActions}>
              {entry.kind === 'activity' && (
                <Button className={styles.ghostIcon} shape='round' size='small' onClick={() => setViewing(entry)}>
                  {t('common.jr.handbook.view')}
                </Button>
              )}
              <Popconfirm
                title={t('common.jr.handbook.withdrawConfirm')}
                onOk={() =>
                  void act(
                    entry.itemId,
                    () => ipcBridge.jr.handbook.withdraw.invoke({ itemId: entry.itemId }),
                    'common.jr.handbook.withdrawn'
                  )
                }
              >
                <Button size='small' type='text' shape='round' status='danger' loading={busy === entry.itemId}>
                  {t('common.jr.handbook.withdraw')}
                </Button>
              </Popconfirm>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <HandbookDraftEditor
          draft={editing}
          onDone={() => {
            setEditing(null);
            void drafts.mutate();
          }}
        />
      )}
      <Modal visible={Boolean(viewing)} title={viewing?.title} footer={null} onCancel={() => setViewing(null)}>
        {mine.data && viewing && (
          <HandbookViewer payload={mine.data} activityId={viewing.itemId} loadMedia={loadMedia} />
        )}
        {mine.error && <Alert type='error' content={t('common.jr.handbook.loadFailed')} />}
      </Modal>
    </div>
  );
};

export default HandbookPanel;
