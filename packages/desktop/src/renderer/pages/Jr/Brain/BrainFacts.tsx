import { ipcBridge } from '@/common';
import {
  BRAIN_FACT_KINDS,
  type BrainFactFilters,
  type BrainFactPatch,
  type BrainManagedFact,
} from '@/common/types/agent/brainTypes';
import { Alert, Button, Checkbox, Input, Message, Select, Spin, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { Edit, History, Up } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import accessStyles from '../Access/Access.module.css';
import styles from './Brain.module.css';
import { EditFactModal, HistoryModal } from './BrainFactDialogs';
import { brainErrorKey, canPromote, type BrainAreaOption, type BrainPeople } from './brainShared';

type Props = { areas: BrainAreaOption[]; people: BrainPeople };

/** Facts of the managed areas: search, filters and per-fact review. */
const BrainFacts: React.FC<Props> = ({ areas, people }) => {
  const { t, i18n } = useTranslation();
  const [areaId, setAreaId] = useState<number>();
  const [risk, setRisk] = useState<'low' | 'high'>();
  const [kind, setKind] = useState<string>();
  const [suspendedOnly, setSuspendedOnly] = useState(false);
  const [conflictOnly, setConflictOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [editing, setEditing] = useState<BrainManagedFact>();
  const [historyId, setHistoryId] = useState<number>();
  const [busy, setBusy] = useState<number>();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const filters: BrainFactFilters = {
    ...(areaId !== undefined ? { areaId } : {}),
    ...(risk ? { risk } : {}),
    ...(kind ? { kind } : {}),
    ...(suspendedOnly ? { suspended: true } : {}),
    ...(debounced ? { q: debounced } : {}),
  };
  const facts = useSWR(
    ['jr.brain.facts', areaId, risk, kind, suspendedOnly, debounced],
    () => ipcBridge.brain.manage.facts.invoke(filters),
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );
  const visible = (facts.data ?? []).filter((fact) => !conflictOnly || fact.flagConflict);
  const areaName = (id: number) => areas.find((area) => area.id === id)?.name ?? String(id);
  const movable = areas.filter((area) => !area.isGeneral);

  const update = async (fact: BrainManagedFact, patch: BrainFactPatch): Promise<boolean> => {
    setBusy(fact.id);
    try {
      await ipcBridge.brain.manage.updateFact.invoke({ id: fact.id, patch });
      await facts.mutate();
      return true;
    } catch (failure) {
      Message.error(t(brainErrorKey(failure)));
      void facts.mutate();
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const author = (fact: BrainManagedFact): string | null => {
    // Gestores do not get the author: only the owner does.
    if (!people || fact.authorUserId === null) return null;
    return people.get(fact.authorUserId) ?? t('common.jr.brainManage.exEmployee');
  };

  return (
    <section className={styles.section} data-testid='brain-facts'>
      <h3 className={accessStyles.sectionLabel}>{t('common.jr.brainManage.facts.title')}</h3>
      <div className={styles.filters}>
        <Input.Search
          className={styles.search}
          allowClear
          value={query}
          onChange={setQuery}
          placeholder={t('common.jr.brainManage.facts.searchPlaceholder')}
          aria-label={t('common.jr.brainManage.facts.searchPlaceholder')}
        />
        <Select
          allowClear
          value={areaId}
          onChange={setAreaId}
          placeholder={t('common.jr.brainManage.facts.areaLabel')}
          aria-label={t('common.jr.brainManage.facts.areaLabel')}
        >
          {areas.map((area) => (
            <Select.Option key={area.id} value={area.id}>
              {area.name}
            </Select.Option>
          ))}
        </Select>
        <Select
          allowClear
          value={risk}
          onChange={setRisk}
          placeholder={t('common.jr.brainManage.facts.riskLabel')}
          aria-label={t('common.jr.brainManage.facts.riskLabel')}
        >
          <Select.Option value='low'>{t('common.jr.brainManage.facts.risk.low')}</Select.Option>
          <Select.Option value='high'>{t('common.jr.brainManage.facts.risk.high')}</Select.Option>
        </Select>
        <Select
          allowClear
          value={kind}
          onChange={setKind}
          placeholder={t('common.jr.brainManage.facts.kindLabel')}
          aria-label={t('common.jr.brainManage.facts.kindLabel')}
        >
          {BRAIN_FACT_KINDS.map((known) => (
            <Select.Option key={known} value={known}>
              {t(`common.jr.brainManage.facts.kinds.${known}`)}
            </Select.Option>
          ))}
        </Select>
        <Checkbox checked={suspendedOnly} onChange={setSuspendedOnly}>
          {t('common.jr.brainManage.facts.suspendedOnly')}
        </Checkbox>
        <Checkbox checked={conflictOnly} onChange={setConflictOnly}>
          {t('common.jr.brainManage.facts.conflictOnly')}
        </Checkbox>
      </div>
      {facts.error && <Alert type='error' content={t('common.jr.brainManage.loadFailed')} />}
      {!facts.data && !facts.error && <Spin />}
      {facts.data && visible.length === 0 && <p className={styles.empty}>{t('common.jr.brainManage.facts.empty')}</p>}
      {visible.length > 0 && (
        <div className={styles.list}>
          {visible.map((fact) => {
            const who = author(fact);
            const date = new Date(fact.createdAt).toLocaleDateString(i18n.language);
            const origin = who
              ? t('common.jr.brainManage.facts.origin', { author: who, date })
              : t('common.jr.brainManage.facts.originNoAuthor', { date });
            return (
              <article key={fact.id} className={styles.row} data-testid={`brain-fact-${fact.id}`}>
                <div className={styles.rowMain}>
                  <p className={styles.text}>{fact.text}</p>
                  <div className={styles.tags}>
                    <Tag size='small' color={fact.risk === 'high' ? 'red' : 'gray'}>
                      {t(`common.jr.brainManage.facts.risk.${fact.risk}`)}
                    </Tag>
                    {fact.suspended && (
                      <Tag size='small' color='orange'>
                        {t('common.jr.brainManage.facts.badges.suspended')}
                      </Tag>
                    )}
                    {!fact.active && <Tag size='small'>{t('common.jr.brainManage.facts.badges.inactive')}</Tag>}
                    {fact.flagConflict && (
                      <Tag size='small' color='orange'>
                        {t('common.jr.brainManage.facts.badges.conflict')}
                      </Tag>
                    )}
                    {fact.humanEdited && <Tag size='small'>{t('common.jr.brainManage.facts.badges.edited')}</Tag>}
                  </div>
                  <span className={styles.meta}>
                    {areaName(fact.areaId)} ·{' '}
                    {t(`common.jr.brainManage.facts.kinds.${fact.kind}`, { defaultValue: fact.kind })} ·{' '}
                    {t('common.jr.brainManage.facts.confidence', {
                      value: Math.round((fact.effectiveConfidence ?? fact.confidence) * 10) / 10,
                    })}
                  </span>
                  <span className={styles.meta}>
                    {origin}
                    {fact.authorBot && ` · ${fact.authorBot}`}
                  </span>
                  {fact.sourceQuote && (
                    <span className={`${styles.meta} ${styles.quote}`}>
                      {t('common.jr.brainManage.facts.quote', { quote: fact.sourceQuote })}
                    </span>
                  )}
                </div>
                <div className={styles.actions}>
                  <Tooltip content={t('common.jr.brainManage.facts.edit')}>
                    <Button
                      size='small'
                      shape='circle'
                      aria-label={t('common.jr.brainManage.facts.edit')}
                      icon={<Edit theme='outline' size={15} />}
                      disabled={busy === fact.id}
                      onClick={() => setEditing(fact)}
                    />
                  </Tooltip>
                  <Tooltip content={t('common.jr.brainManage.facts.history')}>
                    <Button
                      size='small'
                      shape='circle'
                      aria-label={t('common.jr.brainManage.facts.history')}
                      icon={<History theme='outline' size={15} />}
                      onClick={() => setHistoryId(fact.id)}
                    />
                  </Tooltip>
                  <Switch
                    size='small'
                    checked={fact.active}
                    disabled={busy === fact.id}
                    aria-label={t('common.jr.brainManage.facts.active')}
                    onChange={(active) => void update(fact, { active })}
                  />
                  {fact.suspended && (
                    <Button
                      size='small'
                      shape='round'
                      disabled={busy === fact.id}
                      onClick={() => void update(fact, { suspended: false })}
                    >
                      {t('common.jr.brainManage.facts.unsuspend')}
                    </Button>
                  )}
                  <Tooltip
                    content={
                      fact.risk === 'high'
                        ? t('common.jr.brainManage.facts.promoteHighHint')
                        : t('common.jr.brainManage.facts.promote')
                    }
                  >
                    <Button
                      size='small'
                      shape='round'
                      icon={<Up theme='outline' size={14} />}
                      aria-label={t('common.jr.brainManage.facts.promote')}
                      disabled={busy === fact.id || !canPromote(fact, areas)}
                      onClick={() => void update(fact, { general: true })}
                    >
                      {t('common.jr.brainManage.facts.promoteShort')}
                    </Button>
                  </Tooltip>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {editing && (
        <EditFactModal
          fact={editing}
          areas={movable}
          busy={busy === editing.id}
          onCancel={() => setEditing(undefined)}
          onSave={(patch) => void update(editing, patch).then((ok) => ok && setEditing(undefined))}
        />
      )}
      {historyId !== undefined && <HistoryModal factId={historyId} onClose={() => setHistoryId(undefined)} />}
    </section>
  );
};

export default BrainFacts;
