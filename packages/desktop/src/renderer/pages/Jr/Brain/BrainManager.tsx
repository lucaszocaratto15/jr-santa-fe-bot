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
import { useBrainContextVersion, type BrainAreaOption, type BrainPeople as People } from './brainShared';
import ReviewQueue from './Notes/ReviewQueue';

export type BrainManagerProps = {
  /** `owner`: the whole brain (admin page). `manager`: facts of the areas the user manages (settings tab). */
  mode: 'owner' | 'manager';
};

const BrainManager: React.FC<BrainManagerProps> = ({ mode }) => {
  const { t } = useTranslation();
  const { state } = useJrAccess();
  const owner = mode === 'owner';
  const ownerId = state.user?.id ?? null;
  const contextVersion = useBrainContextVersion();
  const me = useSWR(ownerId ? ['jr.brain.me', ownerId, contextVersion] : null, () => ipcBridge.brain.me.invoke(), {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });
  const erp = me.data?.permissionsSource === 'erp';
  const legacyOwner = owner && Boolean(me.data) && !erp;
  const capabilities = erp ? me.data?.capabilities : undefined;
  const canManage = !erp || Boolean(capabilities?.revise || capabilities?.withdraw || capabilities?.approveOfficial);
  const areas = useSWR(
    legacyOwner && ownerId ? ['jr.brain.areas', ownerId, contextVersion] : null,
    () => ipcBridge.brain.manage.areas.invoke(),
    {
      shouldRetryOnError: false,
      revalidateOnFocus: false,
    }
  );
  const employees = useSWR(
    legacyOwner && ownerId ? ['jr.admin.employees', ownerId] : null,
    () => ipcBridge.jr.admin.list.invoke(),
    {
      shouldRetryOnError: false,
    }
  );
  const options = useMemo<BrainAreaOption[]>(() => {
    if (legacyOwner)
      return (areas.data ?? []).map((area) => ({
        id: area.id,
        name: area.name,
        isGeneral: area.isGeneral,
        isFallback: area.name === BRAIN_FALLBACK_AREA_NAME,
      }));
    return (me.data?.areas ?? [])
      .filter((area) => me.data?.manages.includes(area.id))
      .map((area) => ({ id: Number(area.id), name: area.name ?? area.id, isGeneral: false, isFallback: false }));
  }, [legacyOwner, areas.data, me.data]);

  const people = useMemo<People>(() => {
    if (!legacyOwner) return null;
    const names = new Map((employees.data ?? []).filter((person) => !person.revoked).map((p) => [p.id, p.name]));
    if (state.user) names.set(state.user.id, state.user.name);
    return names;
  }, [legacyOwner, employees.data, state.user]);

  const failed = me.error || (legacyOwner && areas.error);
  const loading = !me.data || (legacyOwner && !areas.data);
  const body = failed ? (
    <Alert type='error' content={t('common.jr.brainManage.loadFailed')} />
  ) : loading ? (
    <Spin />
  ) : (
    <>
      {erp && <Alert type='info' content={t('common.jr.brainManage.erpPermissions')} />}
      {canManage && (
        <BrainFacts
          key={`${ownerId}-${contextVersion}`}
          ownerId={ownerId}
          areas={options}
          people={people}
          capabilities={capabilities}
        />
      )}
      {(!erp || capabilities?.approveOfficial) && (
        <ReviewQueue key={`reviews-${ownerId}-${contextVersion}`} ownerId={ownerId} />
      )}
      {legacyOwner && areas.data && (
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
