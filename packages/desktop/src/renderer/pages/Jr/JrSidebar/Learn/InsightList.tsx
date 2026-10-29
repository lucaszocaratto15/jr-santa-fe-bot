import type { LearnInsightBatch, LearnSuggestion } from '@/common/types/agent/learnTypes';
import { Button, Empty, Tag } from '@arco-design/web-react';
import { Delete } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../JrSidebar.module.css';

const TOP_APPS = 5;

type Translate = (key: string, options: Record<string, unknown>) => string;

/** `130` → `2h10`, `45` → `45 min`, `2.5` → `2,5 min` (locale decimals, units from i18n). */
export function formatMinutes(minutes: number, locale: string, t: Translate): string {
  if (minutes < 60) {
    const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(minutes);
    return t('common.jr.learn.insights.minutesShort', { value });
  }
  const total = Math.round(minutes);
  return t('common.jr.learn.insights.hoursMinutes', {
    hours: Math.floor(total / 60),
    minutes: String(total % 60).padStart(2, '0'),
  });
}

type InsightListProps = {
  batches: LearnInsightBatch[];
  onDelete: (id: string) => void;
  onTeach: (suggestion: LearnSuggestion) => void;
};

/** Private insight batches, newest first. Only teach suggestions on a JR-browser site get a button. */
const InsightList: React.FC<InsightListProps> = ({ batches, onDelete, onTeach }) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'pt-BR';
  const day = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' });

  if (batches.length === 0) return <Empty description={t('common.jr.learn.insights.empty')} />;

  return (
    <div className='flex flex-col gap-12px'>
      {batches.map((batch) => (
        <div key={batch.id} className={styles.card} data-testid='learn-insight-batch'>
          <div className={styles.cardRow}>
            <p className={`${styles.cardTitle} flex-1`}>
              {t('common.jr.learn.insights.period', { date: day.format(batch.createdAt) })}
            </p>
            <Button
              className={styles.softButton}
              size='small'
              icon={<Delete theme='outline' size={14} />}
              onClick={() => onDelete(batch.id)}
            >
              {t('common.jr.learn.insights.delete')}
            </Button>
          </div>
          {batch.timePerApp.length > 0 && (
            <p className={styles.muted}>
              <strong>{t('common.jr.learn.insights.timePerApp')}</strong>{' '}
              {batch.timePerApp
                .slice(0, TOP_APPS)
                .map(({ app, minutes }) => `${app} ${formatMinutes(minutes, locale, t as Translate)}`)
                .join(' · ')}
            </p>
          )}
          {batch.repetitive.map((item, index) => (
            <div key={`r-${index}`} className={styles.row}>
              <div className={styles.rowCopy}>
                <p className={styles.rowTitle}>
                  <Tag size='small' className='mr-8px'>
                    {t('common.jr.learn.insights.repetitive')}
                  </Tag>
                  {item.title}
                </p>
                <p className={styles.muted}>
                  {item.description}
                  {item.times > 0 &&
                    ` · ${t('common.jr.learn.insights.times', { times: item.times, minutes: item.minutes })}`}
                </p>
              </div>
            </div>
          ))}
          {batch.suggestions.map((suggestion, index) => (
            <div key={`s-${index}`} className={styles.row}>
              <div className={styles.rowCopy}>
                <p className={styles.rowTitle}>
                  {suggestion.kind === 'tip' && (
                    <Tag size='small' className='mr-8px'>
                      {t('common.jr.learn.insights.tip')}
                    </Tag>
                  )}
                  {suggestion.title}
                </p>
                <p className={styles.muted}>{suggestion.description}</p>
              </div>
              {suggestion.kind === 'teach' && suggestion.teach && (
                <div className={styles.rowActions}>
                  <Button className={styles.softButton} size='small' onClick={() => onTeach(suggestion)}>
                    {t('common.jr.learn.insights.teach')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

export default InsightList;
