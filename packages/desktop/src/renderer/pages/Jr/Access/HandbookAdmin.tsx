/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Spin } from '@arco-design/web-react';
import { BookOpen, Left } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import HandbookViewer from '@renderer/components/media/HandbookViewer';
import styles from './Access.module.css';

const loadMedia = (id: string) => ipcBridge.jr.handbook.media.invoke({ id });

/**
 * `/admin` → "Manual da função": every role's handbook and indicators, read only. The manager
 * neither approves nor edits nor deletes: only the employee approves or withdraws an item.
 */
const HandbookAdmin: React.FC = () => {
  const { t, i18n } = useTranslation();
  const roles = useSWR('jr.handbook.adminRoles', () => ipcBridge.jr.handbook.adminRoles.invoke(), {
    shouldRetryOnError: false,
  });
  const [open, setOpen] = useState<string | null>(null);
  const role = useSWR(open ? ['jr.handbook.adminRole', open] : null, () =>
    ipcBridge.jr.handbook.adminRole.invoke({ key: open as string })
  );
  return (
    <section className='flex flex-col gap-12px mt-24px' data-testid='handbook-admin'>
      <h2 className={`${styles.pageTitle} flex items-center gap-8px`}>
        <BookOpen /> {t('common.jr.handbook.admin.title')}
      </h2>
      <p className={styles.hint}>{t('common.jr.handbook.admin.readOnly')}</p>
      {open ? (
        <>
          <Button type='text' icon={<Left />} className='self-start' onClick={() => setOpen(null)}>
            {t('common.jr.handbook.viewer.back')}
          </Button>
          {role.isLoading && <Spin />}
          {role.error && <Alert type='error' content={t('common.jr.handbook.loadFailed')} />}
          {role.data && (
            <>
              <h3 className='m-0'>{role.data.role?.title}</h3>
              <HandbookViewer payload={role.data} loadMedia={loadMedia} />
            </>
          )}
        </>
      ) : roles.isLoading ? (
        <Spin />
      ) : roles.error ? (
        <Alert type='error' content={t('common.jr.handbook.loadFailed')} />
      ) : !roles.data?.length ? (
        <p className={styles.hint}>{t('common.jr.handbook.admin.empty')}</p>
      ) : (
        <div className='flex flex-col gap-4px'>
          {roles.data.map((entry) => (
            <Button key={entry.key} long className='!text-left !h-auto py-8px' onClick={() => setOpen(entry.key)}>
              <span className='font-600'>{entry.title}</span>
              <span className='text-t-secondary'>
                {' · '}
                {t('common.jr.handbook.admin.activities', { count: entry.activities })}
                {entry.updatedAt > 0 &&
                  ` · ${t('common.jr.handbook.admin.updated', {
                    date: new Date(entry.updatedAt).toLocaleDateString(i18n.language),
                  })}`}
              </span>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
};

export default HandbookAdmin;
