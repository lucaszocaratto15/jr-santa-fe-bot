import { ipcBridge } from '@/common';
import type { JrConnectionStatus } from '@/common/config/clientSettings';
import { useJrAccess } from '@/renderer/pages/Jr/Access/context';
import { Alert, Button, Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import sidebarStyles from '../JrSidebar.module.css';
import UsageDailyBars from './UsageDailyBars';
import { compactTokens, readUsageConsumption, usagePeriod } from './usageMeter';
import styles from './Usage.module.css';

const isConnectionStatus = (value: unknown): value is JrConnectionStatus =>
  Boolean(value) && typeof value === 'object' && value !== null && 'connected' in value;

/** The signed-in person's own usage. No limit exists yet, so it shows plain figures, not quota bars. */
const UsagePanel: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { state } = useJrAccess();
  const { data, error, isLoading, mutate } = useSWR(
    ['jr.connection', state.user?.id ?? 'anon'],
    () => (state.status === 'pilot' ? ipcBridge.jr.status.invoke() : ipcBridge.jr.personalUsage.invoke()),
    { refreshInterval: 15000, shouldRetryOnError: false }
  );
  const status = isConnectionStatus(data) ? data : null;
  const usage = status?.usage;
  const consumption = readUsageConsumption(usage);
  const week = usagePeriod(usage, 7);
  const month = usagePeriod(usage, 30);
  const tokens = (value: number | null) => (value == null ? '—' : compactTokens(value, i18n.language));

  const tile = (label: string, value: string, hint: string) => (
    <div className={styles.tile}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={styles.tileValue}>{value}</div>
      <div className={styles.tileHint}>{hint}</div>
    </div>
  );

  return (
    <div>
      <h1 className={sidebarStyles.pageTitle}>{t('common.jr.look.usageTitle')}</h1>
      {status?.fallback ? <p className={sidebarStyles.muted}>{t('common.jr.fallbackNotice')}</p> : null}
      {isLoading ? (
        <Spin aria-label={t('common.loading')} />
      ) : error || (status && !status.connected) ? (
        <div className={sidebarStyles.stack}>
          <Alert type='warning' content={t('common.jr.connectionError')} />
          <Button onClick={() => void mutate()}>{t('common.jr.retry')}</Button>
        </div>
      ) : !usage ? (
        <p className={sidebarStyles.muted}>{t('common.jr.look.noUsage')}</p>
      ) : (
        <>
          <div className={styles.tiles}>
            {tile(t('common.jr.usageStats.last5h'), tokens(consumption.last5h), t('common.jr.usageStats.tokens'))}
            {tile(t('common.jr.usageStats.last7d'), tokens(week.tokens), t('common.jr.usageStats.tokens'))}
            {tile(
              t('common.jr.usageStats.averagePerDay'),
              tokens(week.averagePerDay),
              t('common.jr.usageStats.last7dHint')
            )}
            {tile(t('common.jr.usageStats.peak5h'), tokens(week.peak5h), t('common.jr.usageStats.last7dHint'))}
            {tile(
              t('common.jr.usageStats.requests'),
              week.requests == null ? '—' : new Intl.NumberFormat(i18n.language).format(week.requests),
              t('common.jr.usageStats.last7dHint')
            )}
            {tile(t('common.jr.usageStats.total'), tokens(consumption.total), t('common.jr.usageStats.sinceStart'))}
          </div>
          {month.daily.length > 0 && (
            <section className={sidebarStyles.card} aria-labelledby='jr-usage-daily'>
              <h2 id='jr-usage-daily' className={sidebarStyles.cardTitle}>
                {t('common.jr.usageStats.last30d')}
              </h2>
              <UsageDailyBars daily={month.daily} />
            </section>
          )}
          <p className={sidebarStyles.muted}>{t('common.jr.usageStats.noLimitYet')}</p>
        </>
      )}
    </div>
  );
};

export default UsagePanel;
