import type { JrAdminEmployee } from '@/common/config/clientSettings';
import { Radio, Table } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import UsageDailyBars from '../JrSidebar/Usage/UsageDailyBars';
import { compactTokens, readUsageConsumption, usagePeriod, type UsagePeriodDays } from '../JrSidebar/Usage/usageMeter';
import usageStyles from '../JrSidebar/Usage/Usage.module.css';
import styles from './Access.module.css';

type Row = {
  id: string;
  name: string;
  last5h: number | null;
  period: ReturnType<typeof usagePeriod>;
};

/** Per-employee usage so the owner can pick a fair 5-hour limit from real data. */
export function teamUsageRows(people: JrAdminEmployee[], days: UsagePeriodDays): Row[] {
  return people
    .filter((person) => !person.revoked)
    .map((person) => ({
      id: person.id,
      name: person.name,
      last5h: readUsageConsumption(person.usage).last5h,
      period: usagePeriod(person.usage, days),
    }))
    .sort((a, b) => (b.period.tokens ?? -1) - (a.period.tokens ?? -1));
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const TeamUsage: React.FC<{ people: JrAdminEmployee[]; self?: JrAdminEmployee }> = ({ people, self }) => {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState<UsagePeriodDays>(7);
  const rows = teamUsageRows(self ? [self, ...people] : people, days);
  const tokens = (value: number | null) => (value == null ? '—' : compactTokens(value, i18n.language));
  const active = rows.filter((row) => (row.period.requests ?? 0) > 0);
  const teamTokens = rows.reduce((sum, row) => sum + (row.period.tokens ?? 0), 0);
  const averages = active.map((row) => row.period.averagePerDay ?? 0);
  const averagePerPerson = averages.length
    ? Math.round(averages.reduce((sum, value) => sum + value, 0) / averages.length)
    : null;
  const top = rows.reduce<Row | null>(
    (best, row) => ((row.period.peak5h ?? 0) > (best?.period.peak5h ?? 0) ? row : best),
    null
  );
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language, {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';

  const tile = (label: string, value: string, hint: string) => (
    <div className={styles.usageTile}>
      <p className={styles.usageTileLabel}>{label}</p>
      <p className={styles.usageTileValue}>{value}</p>
      <p className={styles.usageTileHint}>{hint}</p>
    </div>
  );
  const number = (value: number | null) => <span className={usageStyles.number}>{tokens(value)}</span>;

  return (
    <section aria-labelledby='jr-team-usage'>
      <div className={styles.usageHead}>
        <h2 id='jr-team-usage' className={styles.sectionLabel}>
          {t('common.jr.usageStats.teamTitle')}
        </h2>
        <Radio.Group
          type='button'
          className={styles.periods}
          value={days}
          onChange={(value: UsagePeriodDays) => setDays(value)}
        >
          <Radio value={1}>{t('common.jr.usageStats.today')}</Radio>
          <Radio value={7}>{t('common.jr.usageStats.days', { count: 7 })}</Radio>
          <Radio value={30}>{t('common.jr.usageStats.days', { count: 30 })}</Radio>
        </Radio.Group>
      </div>
      <div className={styles.usageTiles}>
        {tile(t('common.jr.usageStats.teamTotal'), tokens(teamTokens), t('common.jr.usageStats.tokens'))}
        {tile(
          t('common.jr.usageStats.averagePerPerson'),
          tokens(averagePerPerson),
          t('common.jr.usageStats.activePeople', { count: active.length })
        )}
        {tile(
          t('common.jr.usageStats.biggestPeak'),
          tokens(top?.period.peak5h ?? null),
          top ? `${top.name} · ${when(top.period.peakStartedAt)}` : ''
        )}
      </div>
      <Table
        className={`${usageStyles.table} ${styles.usageTable}`}
        rowKey='id'
        data={rows}
        pagination={false}
        border={false}
        tableLayoutFixed={false}
        scroll={{ x: 680 }}
        expandProps={{ expandRowByClick: true, width: 36 }}
        expandedRowRender={(row: Row) => <UsageDailyBars daily={row.period.daily} />}
        columns={[
          {
            title: t('common.jr.usageStats.employee'),
            dataIndex: 'name',
            render: (_: unknown, row: Row) => (
              <span className={styles.person}>
                <span className={styles.avatar} aria-hidden='true'>
                  {initials(row.name)}
                </span>
                <span className='min-w-0'>
                  <span className={styles.personName}>{row.name}</span>
                  <span className={styles.personMeta}>
                    {t('common.jr.usageStats.requestsCount', { count: row.period.requests ?? 0 })}
                  </span>
                </span>
              </span>
            ),
          },
          {
            title: t('common.jr.usageStats.last5h'),
            align: 'right',
            render: (_: unknown, row: Row) => number(row.last5h),
          },
          {
            title: t('common.jr.usageStats.averagePerDay'),
            align: 'right',
            render: (_: unknown, row: Row) => number(row.period.averagePerDay),
          },
          {
            title: t('common.jr.usageStats.peak5h'),
            align: 'right',
            render: (_: unknown, row: Row) => (
              <span className={row.id === top?.id ? usageStyles.peak : usageStyles.number}>
                {tokens(row.period.peak5h)}
              </span>
            ),
          },
          {
            title: t('common.jr.usageStats.periodTotal'),
            align: 'right',
            render: (_: unknown, row: Row) => (
              <strong className={usageStyles.number}>{tokens(row.period.tokens)}</strong>
            ),
          },
        ]}
      />
      <p className={styles.usageHint}>{t('common.jr.usageStats.adminHint')}</p>
    </section>
  );
};

export default TeamUsage;
