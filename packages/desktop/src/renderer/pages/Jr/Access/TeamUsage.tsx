import type { JrAdminEmployee } from '@/common/config/clientSettings';
import { Radio, Table } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import UsageDailyBars from '../JrSidebar/Usage/UsageDailyBars';
import { compactTokens, readUsageConsumption, usagePeriod, type UsagePeriodDays } from '../JrSidebar/Usage/usageMeter';
import usageStyles from '../JrSidebar/Usage/Usage.module.css';

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
    <div className={usageStyles.tile}>
      <div className={usageStyles.tileLabel}>{label}</div>
      <div className={usageStyles.tileValue}>{value}</div>
      <div className={usageStyles.tileHint}>{hint}</div>
    </div>
  );
  const number = (value: number | null) => <span className={usageStyles.number}>{tokens(value)}</span>;

  return (
    <section aria-labelledby='jr-team-usage'>
      <h2 id='jr-team-usage'>{t('common.jr.usageStats.teamTitle')}</h2>
      <Radio.Group type='button' value={days} onChange={(value: UsagePeriodDays) => setDays(value)}>
        <Radio value={1}>{t('common.jr.usageStats.today')}</Radio>
        <Radio value={7}>{t('common.jr.usageStats.days', { count: 7 })}</Radio>
        <Radio value={30}>{t('common.jr.usageStats.days', { count: 30 })}</Radio>
      </Radio.Group>
      <div className={usageStyles.tiles} style={{ marginTop: 12 }}>
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
        className={usageStyles.table}
        rowKey='id'
        data={rows}
        pagination={false}
        border={false}
        tableLayoutFixed={false}
        scroll={{ x: 760 }}
        expandedRowRender={(row: Row) => <UsageDailyBars daily={row.period.daily} />}
        columns={[
          { title: t('common.jr.usageStats.employee'), dataIndex: 'name' },
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
            render: (_: unknown, row: Row) => number(row.period.tokens),
          },
          {
            title: t('common.jr.usageStats.requests'),
            align: 'right',
            render: (_: unknown, row: Row) => <span className={usageStyles.number}>{row.period.requests ?? '—'}</span>,
          },
        ]}
      />
      <p>{t('common.jr.usageStats.adminHint')}</p>
    </section>
  );
};

export default TeamUsage;
