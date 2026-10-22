import { ipcBridge } from '@/common';
import { Alert, Button, Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from './JrWorkspace.module.css';
import { useJrAccess } from './Access/context';

const JrUsage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { state } = useJrAccess();
  const { data, error, isLoading, mutate } = useSWR(
    ['jr.connection', state.user?.id],
    () => (state.status === 'pilot' ? ipcBridge.jr.status.invoke() : ipcBridge.jr.personalUsage.invoke()),
    {
      refreshInterval: 15000,
      shouldRetryOnError: false,
    }
  );
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <main className={styles.page}>
      <section className={styles.workspace}>
        <span className={styles.eyebrow}>{t('common.jr.companyShortName')}</span>
        <h1>{t('common.jr.usage')}</h1>
        <p className={styles.intro}>
          {t(state.status === 'pilot' ? 'common.jr.usagePeriod' : 'common.jr.access.usagePeriod')}
        </p>
        {isLoading ? (
          <Spin />
        ) : error || !data?.connected ? (
          <div className={styles.fields} role='alert'>
            <Alert type='warning' content={t('common.jr.connectionError')} />
            <Button onClick={() => void mutate()}>{t('common.jr.retry')}</Button>
          </div>
        ) : !data.usage ? (
          <Alert type='info' content={t('common.jr.usageUnavailable')} />
        ) : (
          <>
            <div className={styles.usageGrid}>
              <div className={styles.usageCell}>
                <span>{t('common.jr.inputTokens')}</span>
                <strong>
                  {data.usage.promptTokens == null
                    ? t('common.jr.access.unreported')
                    : number.format(data.usage.promptTokens)}
                </strong>
              </div>
              <div className={styles.usageCell}>
                <span>{t('common.jr.outputTokens')}</span>
                <strong>
                  {data.usage.completionTokens == null
                    ? t('common.jr.access.unreported')
                    : number.format(data.usage.completionTokens)}
                </strong>
              </div>
              <div className={styles.usageCell}>
                <span>{t('common.jr.modelRequests')}</span>
                <strong>{number.format(data.usage.modelRequests)}</strong>
              </div>
            </div>
            <p className={styles.hint}>
              {data.usage.cachedPromptTokens == null
                ? t('common.jr.access.cacheUnknown')
                : t('common.jr.cacheTokens', { count: data.usage.cachedPromptTokens })}
            </p>
            <p className={styles.hint}>
              {t('common.jr.usageSince', { date: new Date(data.usage.startedAt).toLocaleString(i18n.language) })}
            </p>
            <Alert type='info' content={t('common.jr.usageNote')} />
          </>
        )}
      </section>
    </main>
  );
};
export default JrUsage;
