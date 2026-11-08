import { ipcBridge } from '@/common';
import { Alert, Button, Spin } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import accessStyles from '../Access/Access.module.css';
import styles from './Brain.module.css';
import type { BrainPeople } from './brainShared';

const DAY = 24 * 60 * 60 * 1000;
const LOG_DAYS = 90;
const PAGE = 100;
const ACTIONS = ['update_fact', 'suspend', 'read_high', 'set_members', 'delete_author_facts'] as const;

/** Owner: fact changes and reads of high-risk facts of the last 90 days (never the question). */
const BrainLog: React.FC<{ people: BrainPeople }> = ({ people }) => {
  const { t, i18n } = useTranslation();
  const [shown, setShown] = useState(PAGE);
  const log = useSWR('jr.brain.log', () => ipcBridge.brain.manage.log.invoke({ since: Date.now() - LOG_DAYS * DAY }), {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });
  const rows = log.data ?? [];
  const actionLabel = (action: string) =>
    (ACTIONS as readonly string[]).includes(action)
      ? t(`common.jr.brainManage.log.actions.${action as (typeof ACTIONS)[number]}`)
      : action;

  return (
    <section className={styles.section} data-testid='brain-log'>
      <h3 className={accessStyles.sectionLabel}>{t('common.jr.brainManage.log.title')}</h3>
      <p className={styles.meta}>{t('common.jr.brainManage.log.hint')}</p>
      {log.error && <Alert type='error' content={t('common.jr.brainManage.loadFailed')} />}
      {!log.data && !log.error && <Spin />}
      {log.data && rows.length === 0 && <p className={styles.empty}>{t('common.jr.brainManage.log.empty')}</p>}
      {rows.length > 0 && (
        <div className={styles.list}>
          {rows.slice(0, shown).map((row) => (
            <div key={row.id} className={styles.areaRow}>
              <div className={styles.grow}>
                <p className={styles.text}>{actionLabel(row.action)}</p>
                <span className={styles.meta}>
                  {new Date(row.at).toLocaleString(i18n.language)} ·{' '}
                  {people?.get(row.userId) ?? t('common.jr.brainManage.exEmployee')}
                  {row.factId !== null && ` · ${t('common.jr.brainManage.log.fact', { id: row.factId })}`}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {rows.length > shown && (
        <Button shape='round' className='self-start' onClick={() => setShown(shown + PAGE)}>
          {t('common.jr.brainManage.log.more')}
        </Button>
      )}
    </section>
  );
};

export default BrainLog;
