/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Message, Modal, Popconfirm, Spin } from '@arco-design/web-react';
import { BookOpen, ChartHistogram, FileText } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { HandbookDraft, HandbookPublished } from '@/common/types/agent/handbookTypes';
import { HANDBOOK_DRAFTS_KEY } from '@renderer/hooks/agent/useHandbookUpdatedNotice';
import HandbookViewer from '@renderer/components/media/HandbookViewer';
import styles from '../JrSidebar.module.css';
import HandbookDraftEditor, { handbookErrorKey } from './HandbookDraftEditor';
import { EmptyState, PageHeader, SectionLabel } from './PanelParts';

const MINE_KEY = 'jr.handbook.mine';
const ROLES_KEY = 'jr.handbook.roles';
const ROLE_KEY = 'jr.handbook.role';
const loadMedia = (id: string) => ipcBridge.jr.handbook.media.invoke({ id });

/**
 * "Seu Manual" tab: everything generated from the employee's work is already published to the role
 * handbook. The employee reviews afterwards: edits an item, hides it (withdrawn, and not published
 * again until its source changes) or shows a hidden one again. There is no manager step.
 */
const HandbookPanel: React.FC = () => {
  const { t } = useTranslation();
  const drafts = useSWR(HANDBOOK_DRAFTS_KEY, () => ipcBridge.jr.handbook.drafts.invoke(), {
    shouldRetryOnError: false,
  });
  const [editing, setEditing] = useState<HandbookDraft | null>(null);
  const [viewing, setViewing] = useState<HandbookPublished | null>(null);
  const mine = useSWR(viewing ? MINE_KEY : null, () => ipcBridge.jr.handbook.mine.invoke());
  const [busy, setBusy] = useState<string | null>(null);
  const [peerRole, setPeerRole] = useState<{ key: string; title: string } | null>(null);
  // Roles of the employee's areas. A server without area sharing answers with the own role only.
  const roles = useSWR(ROLES_KEY, () => ipcBridge.jr.handbook.roles.invoke(), { shouldRetryOnError: false });
  const peerPayload = useSWR(
    peerRole ? [ROLE_KEY, peerRole.key] : null,
    () => ipcBridge.jr.handbook.role.invoke({ key: (peerRole as { key: string }).key }),
    { shouldRetryOnError: false }
  );

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
  const { role, published, hidden } = drafts.data;
  const otherRoles = (roles.data ?? []).filter((entry) => entry.key !== role?.key && entry.activities > 0);
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
      <SectionLabel>{t('common.jr.handbook.publishedTitle')}</SectionLabel>
      <p className={styles.rowMeta}>{t('common.jr.handbook.reviewHint')}</p>
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
              {entry.draft && (
                <Button
                  className={styles.softButton}
                  shape='round'
                  size='small'
                  onClick={() => setEditing(entry.draft)}
                >
                  {t('common.jr.handbook.edit')}
                </Button>
              )}
              <Popconfirm
                title={t('common.jr.handbook.hideConfirm')}
                onOk={() =>
                  void act(
                    entry.key,
                    () => ipcBridge.jr.handbook.hide.invoke({ key: entry.key }),
                    'common.jr.handbook.hidden'
                  )
                }
              >
                <Button size='small' type='text' shape='round' loading={busy === entry.key}>
                  {t('common.jr.handbook.hide')}
                </Button>
              </Popconfirm>
            </div>
          </div>
        ))}
      </div>
      {hidden.length > 0 && (
        <>
          <SectionLabel>{t('common.jr.handbook.hiddenTitle')}</SectionLabel>
          <div className={`${styles.card} ${styles.cardList}`}>
            {hidden.map((entry) => (
              <div key={entry.key} className={styles.row} data-testid={`hidden-${entry.key}`}>
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
                  <Button
                    className={styles.softButton}
                    shape='round'
                    size='small'
                    loading={busy === entry.key}
                    onClick={() => void act(entry.key, () => ipcBridge.jr.handbook.unhide.invoke({ key: entry.key }))}
                  >
                    {t('common.jr.handbook.unhide')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {otherRoles.length > 0 && (
        <>
          <SectionLabel>{t('common.jr.handbook.peerRolesTitle')}</SectionLabel>
          <p className={styles.rowMeta}>{t('common.jr.handbook.peerRolesHint')}</p>
          <div className={`${styles.card} ${styles.cardList}`}>
            {otherRoles.map((entry) => (
              <div key={entry.key} className={styles.row} data-testid={`peer-role-${entry.key}`}>
                <span className={styles.rowIcon} aria-hidden='true'>
                  <BookOpen theme='outline' size={16} />
                </span>
                <div className={styles.rowCopy}>
                  <p className={`${styles.rowTitle} font-500`}>{entry.title}</p>
                  <p className={styles.rowMeta}>
                    {t('common.jr.handbook.peerRoleActivities', { count: entry.activities })}
                  </p>
                </div>
                <div className={styles.rowActions}>
                  <Button
                    className={styles.ghostIcon}
                    shape='round'
                    size='small'
                    onClick={() => setPeerRole({ key: entry.key, title: entry.title })}
                  >
                    {t('common.jr.handbook.view')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {editing && (
        <HandbookDraftEditor
          draft={editing}
          onDone={() => {
            setEditing(null);
            void drafts.mutate();
          }}
        />
      )}
      <Modal visible={Boolean(peerRole)} title={peerRole?.title} footer={null} onCancel={() => setPeerRole(null)}>
        {peerPayload.data && <HandbookViewer payload={peerPayload.data} loadMedia={loadMedia} />}
        {peerPayload.error && <Alert type='error' content={t('common.jr.handbook.loadFailed')} />}
      </Modal>
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
