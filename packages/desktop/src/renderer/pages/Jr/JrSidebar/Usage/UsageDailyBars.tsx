import type { JrUsageDay } from '@/common/config/clientSettings';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { compactTokens } from './usageMeter';
import styles from './Usage.module.css';

/** One bar per São Paulo day; the tallest day fills the chart. */
const UsageDailyBars: React.FC<{ daily: JrUsageDay[] }> = ({ daily }) => {
  const { t, i18n } = useTranslation();
  const max = Math.max(0, ...daily.map((day) => day.tokens));
  const label = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit' });
  if (daily.length === 0) return null;
  return (
    <div role='img' aria-label={t('common.jr.usageStats.chartLabel')}>
      <div className={styles.bars}>
        {daily.map((day) => (
          <span
            key={day.date}
            className={`${styles.bar} ${day.tokens === 0 ? styles.barEmpty : ''}`}
            style={{ height: max > 0 ? `${Math.max(2, (day.tokens / max) * 100)}%` : '2px' }}
            title={t('common.jr.usageStats.dayTooltip', {
              date: label(day.date),
              tokens: compactTokens(day.tokens, i18n.language),
              requests: day.requests,
            })}
          />
        ))}
      </div>
      <div className={styles.axis}>
        <span>{label(daily[0].date)}</span>
        <span>{label(daily[daily.length - 1].date)}</span>
      </div>
    </div>
  );
};

export default UsageDailyBars;
