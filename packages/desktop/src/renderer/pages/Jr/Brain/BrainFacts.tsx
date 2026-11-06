import { ipcBridge } from '@/common';
import {
  BRAIN_FACT_KINDS,
  type BrainFactFilters,
  type BrainFactPatch,
  type BrainManagedFact,
  type BrainCapabilities,
} from '@/common/types/agent/brainTypes';
import { Alert, Button, Checkbox, Input, Message, Select, Spin, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { History } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import accessStyles from '../Access/Access.module.css';
import styles from './Brain.module.css';
import BrainNoteComposer from './Notes';
import { HistoryModal } from './BrainFactDialogs';
import { brainErrorKey, useBrainContextVersion, type BrainAreaOption, type BrainPeople } from './brainShared';

type Props = {
  areas: BrainAreaOption[];
  people: BrainPeople;
  ownerId: string | null;
  capabilities?: BrainCapabilities;
};

/** Facts of the managed areas: search, filters and per-fact review. */
const BrainFacts: React.FC<Props> = ({ areas, people, ownerId, capabilities }) => {
  const { t, i18n } = useTranslation();
  const contextVersion = useBrainContextVersion();
  const [areaId, setAreaId] = useState<number>();
  const [risk, setRisk] = useState<'low' | 'high'>();
  const [kind, setKind] = useState<string>();
  const [suspendedOnly, setSuspendedOnly] = useState(false);
  const [conflictOnly, setConflictOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
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
    ownerId ? ['jr.brain.facts', ownerId, contextVersion, areaId, risk, kind, suspendedOnly, debounced] : null,
    () => ipcBridge.brain.manage.facts.invoke(filters),
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );
  const visible = (facts.data ?? []).filter((fact) => !conflictOnly || fact.flagConflict);
  const areaName = (id: number) => areas.find((area) => area.id === id)?.name ?? String(id);

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
            const canRevise = capabilities ? capabilities.revise && fact.canRevise === true : true;
            const canWithdraw = capabilities ? capabilities.withdraw && fact.canWithdraw === true : true;
            const canReactivate = capabilities ? capabilities.revise && fact.canReactivate === true : true;
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
                    {fact.status && <Tag size='small'>{t(`common.jr.brainNotes.status.${fact.status}`)}</Tag>}
                    <Tag size='small'>
                      {t(
                        fact.noteType === 'official_procedure'
                          ? 'common.jr.brainNotes.officialProcedure'
                          : 'common.jr.brainNotes.sharedNote'
                      )}
                    </Tag>
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
                  {canRevise && <BrainNoteComposer factId={fact.id} onPublished={() => void facts.mutate()} />}
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
                    disabled={busy === fact.id || !(fact.active ? canWithdraw : canReactivate)}
                    aria-label={t('common.jr.brainManage.facts.active')}
                    onChange={(active) => void update(fact, { active })}
                  />
                  {fact.suspended && canReactivate && (
                    <Button
                      size='small'
                      shape='round'
                      disabled={busy === fact.id}
                      onClick={() => void update(fact, { suspended: false })}
                    >
                      {t('common.jr.brainManage.facts.unsuspend')}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {historyId !== undefined && (
        <HistoryModal
          factId={historyId}
          ownerId={ownerId}
          contextVersion={contextVersion}
          onClose={() => setHistoryId(undefined)}
        />
      )}
    </section>
  );
};

export default BrainFacts;
