import { ipcBridge } from '@/common';
import { BRAIN_FALLBACK_AREA_NAME } from '@/common/types/agent/brainTypes';
import { useJrAccess } from '@renderer/pages/Jr/Access/context';
import { PageHeader } from '@renderer/pages/Jr/JrSidebar/Teach/PanelParts';
import { Alert, Spin } from '@arco-design/web-react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import accessStyles from '../Access/Access.module.css';
import styles from './Brain.module.css';
import BrainAreas from './BrainAreas';
import BrainFacts from './BrainFacts';
import BrainForget from './BrainForget';
import BrainLog from './BrainLog';
import BrainPeople from './BrainPeople';
import type { BrainAreaOption, BrainPeople as People } from './brainShared';

export type BrainManagerProps = {
  /** `owner`: the whole brain (admin page). `manager`: facts of the areas the user manages (settings tab). */
  mode: 'owner' | 'manager';
};

const BrainManager: React.FC<BrainManagerProps> = ({ mode }) => {
  const { t } = useTranslation();
  const { state } = useJrAccess();
  const owner = mode === 'owner';
  const areas = useSWR(owner ? 'jr.brain.areas' : null, () => ipcBridge.brain.manage.areas.invoke(), {
    shouldRetryOnError: false,
  });
  const employees = useSWR(owner ? 'jr.admin.employees' : null, () => ipcBridge.jr.admin.list.invoke(), {
    shouldRetryOnError: false,
  });
  const me = useSWR(owner ? null : 'jr.brain.me', () => ipcBridge.brain.me.invoke(), { shouldRetryOnError: false });

  const options = useMemo<BrainAreaOption[]>(() => {
    if (owner)
      return (areas.data ?? []).map((area) => ({
        id: area.id,
        name: area.name,
        isGeneral: area.isGeneral,
        isFallback: area.name === BRAIN_FALLBACK_AREA_NAME,
      }));
    return (me.data?.areas ?? [])
      .filter((area) => me.data?.manages.includes(area.id))
      .map((area) => ({ id: Number(area.id), name: area.name ?? area.id, isGeneral: false, isFallback: false }));
  }, [owner, areas.data, me.data]);

  const people = useMemo<People>(() => {
    if (!owner) return null;
    const names = new Map((employees.data ?? []).filter((person) => !person.revoked).map((p) => [p.id, p.name]));
    if (state.user) names.set(state.user.id, state.user.name);
    return names;
  }, [owner, employees.data, state.user]);

  const failed = owner ? areas.error : me.error;
  const loading = owner ? !areas.data : !me.data;
  const body = failed ? (
    <Alert type='error' content={t('common.jr.brainManage.loadFailed')} />
  ) : loading ? (
    <Spin />
  ) : (
    <>
      <BrainFacts areas={options} people={people} />
      {owner && areas.data && (
        <>
          <BrainAreas areas={areas.data} onChanged={() => void areas.mutate()} />
          <BrainPeople areas={areas.data} employees={employees.data ?? []} onChanged={() => void areas.mutate()} />
          <BrainForget employees={employees.data ?? []} />
          <BrainLog people={people} />
        </>
      )}
    </>
  );

  return (
    <section className={styles.section} data-testid='brain-manager'>
      {owner ? (
        <div>
          <h2 className={accessStyles.sectionLabel}>{t('common.jr.brainManage.title')}</h2>
          <p className={`${accessStyles.hint} m-0 text-12.5px`}>{t('common.jr.brainManage.subtitle')}</p>
        </div>
      ) : (
        <PageHeader title={t('common.jr.brainManage.title')} subtitle={t('common.jr.brainManage.subtitle')} />
      )}
      {body}
    </section>
  );
};

export default BrainManager;
