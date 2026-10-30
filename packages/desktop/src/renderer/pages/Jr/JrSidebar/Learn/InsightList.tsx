import type { LearnInsightBatch, LearnSuggestion } from '@/common/types/agent/learnTypes';
import { Button, Tooltip } from '@arco-design/web-react';
import { Delete, Lightning, LoopOnce } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../JrSidebar.module.css';
import { EmptyState } from '../Teach/PanelParts';

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

  if (batches.length === 0) {
    return (
      <div className={styles.card}>
        <EmptyState
          icon={<Lightning theme='outline' size={18} />}
          title={t('common.jr.learn.insights.emptyTitle')}
          hint={t('common.jr.learn.insights.emptyHint')}
        />
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-12px'>
      {batches.map((batch) => {
        const apps = batch.timePerApp.slice(0, TOP_APPS);
        const longest = Math.max(1, ...apps.map((entry) => entry.minutes));
        return (
          <div key={batch.id} className={styles.card} data-testid='learn-insight-batch'>
            <div className={styles.cardRow}>
              <p className={`${styles.cardTitle} flex-1`}>
                {t('common.jr.learn.insights.period', { date: day.format(batch.createdAt) })}
              </p>
              <Tooltip content={t('common.jr.learn.insights.delete')}>
                <Button
                  className={styles.ghostIcon}
                  shape='circle'
                  size='small'
                  aria-label={t('common.jr.learn.insights.delete')}
                  icon={<Delete theme='outline' size={15} />}
                  onClick={() => onDelete(batch.id)}
                />
              </Tooltip>
            </div>
            {apps.length > 0 && (
              <div className='mt-12px mb-4px'>
                <p className='m-0 mb-8px text-12px font-500 text-t-tertiary'>
                  {t('common.jr.learn.insights.timePerApp')}
                </p>
                <div className='flex flex-col gap-6px'>
                  {apps.map(({ app, minutes }) => (
                    <div key={app} className={styles.appBar}>
                      <span className={styles.appBarName}>{app}</span>
                      <span className={styles.appBarTrack}>
                        <span className={styles.appBarFill} style={{ width: `${(minutes / longest) * 100}%` }} />
                      </span>
                      <span className={styles.appBarValue}>{formatMinutes(minutes, locale, t as Translate)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {batch.repetitive.map((item, index) => (
              <div key={`r-${index}`} className={styles.row}>
                <span className={styles.rowIcon} aria-hidden='true'>
                  <LoopOnce theme='outline' size={16} />
                </span>
                <div className={styles.rowCopy}>
                  <p className={`${styles.rowTitle} font-500`}>
                    {item.title} <span className={styles.chip}>{t('common.jr.learn.insights.repetitive')}</span>
                  </p>
                  <p className={styles.rowMeta}>
                    {item.description}
                    {item.times > 0 &&
                      ` · ${t('common.jr.learn.insights.times', { times: item.times, minutes: item.minutes })}`}
                  </p>
                </div>
              </div>
            ))}
            {batch.suggestions.map((suggestion, index) => (
              <div key={`s-${index}`} className={styles.row}>
                <span className={styles.rowIcon} aria-hidden='true'>
                  {suggestion.kind === 'teach' ? (
                    <LoopOnce theme='outline' size={16} />
                  ) : (
                    <Lightning theme='outline' size={16} />
                  )}
                </span>
                <div className={styles.rowCopy}>
                  <p className={`${styles.rowTitle} font-500`}>
                    {suggestion.title}{' '}
                    {suggestion.kind === 'tip' && (
                      <span className={styles.chip}>{t('common.jr.learn.insights.tip')}</span>
                    )}
                  </p>
                  <p className={styles.rowMeta}>{suggestion.description}</p>
                </div>
                {suggestion.kind === 'teach' && suggestion.teach && (
                  <div className={styles.rowActions}>
                    <Button
                      className={styles.softButton}
                      shape='round'
                      size='small'
                      onClick={() => onTeach(suggestion)}
                    >
                      {t('common.jr.learn.insights.teach')}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

export default InsightList;
