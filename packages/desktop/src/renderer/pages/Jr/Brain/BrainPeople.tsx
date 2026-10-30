import { ipcBridge } from '@/common';
import type { JrAdminEmployee } from '@/common/config/clientSettings';
import type { BrainManagedArea, BrainMembership } from '@/common/types/agent/brainTypes';
import { Button, Checkbox, Message, Modal, Radio, Select } from '@arco-design/web-react';
import { Edit } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import accessStyles from '../Access/Access.module.css';
import styles from './Brain.module.css';
import { brainErrorKey, isProtectedArea } from './brainShared';

type Props = { areas: BrainManagedArea[]; employees: JrAdminEmployee[]; onChanged: () => void };

type Draft = Map<number, { level: BrainMembership['level'] }>;

const membershipsOf = (areas: BrainManagedArea[], userId: string): BrainMembership[] =>
  areas.flatMap((area) =>
    area.members
      .filter((m) => m.userId === userId)
      .map((m) => ({ areaId: area.id, level: m.level, primary: m.primary }))
  );

/** Owner: which areas each person belongs to, at which level, and the primary one. */
const BrainPeople: React.FC<Props> = ({ areas, employees, onChanged }) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<JrAdminEmployee>();
  const [draft, setDraft] = useState<Draft>(new Map());
  const [primary, setPrimary] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const assignable = areas.filter((area) => !isProtectedArea(area));
  const active = employees.filter((person) => !person.revoked);
  const areaName = (id: number) => areas.find((area) => area.id === id)?.name ?? String(id);

  const open = (person: JrAdminEmployee) => {
    const current = membershipsOf(areas, person.id);
    setDraft(
      new Map(
        current.filter((m) => assignable.some((a) => a.id === m.areaId)).map((m) => [m.areaId, { level: m.level }])
      )
    );
    setPrimary(current.find((m) => m.primary)?.areaId ?? null);
    setEditing(person);
  };

  const toggle = (areaId: number, on: boolean) => {
    const next = new Map(draft);
    if (on) next.set(areaId, { level: 'colaborador' });
    else next.delete(areaId);
    setDraft(next);
    if (!on && primary === areaId) setPrimary(null);
  };

  const save = async () => {
    if (!editing) return;
    // A stored Geral membership is kept as it is; the owner-only fallback never holds members.
    const kept = membershipsOf(areas, editing.id).filter((m) => areas.some((a) => a.id === m.areaId && a.isGeneral));
    const chosen = [...draft].map(([areaId, value]) => ({ areaId, level: value.level, primary: primary === areaId }));
    setBusy(true);
    try {
      await ipcBridge.brain.manage.setMemberships.invoke({
        userId: editing.id,
        memberships: [...kept, ...chosen],
      });
      onChanged();
      setEditing(undefined);
    } catch (failure) {
      Message.error(t(brainErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} data-testid='brain-people'>
      <h3 className={accessStyles.sectionLabel}>{t('common.jr.brainManage.people.title')}</h3>
      {active.length === 0 && <p className={styles.empty}>{t('common.jr.brainManage.people.empty')}</p>}
      {active.length > 0 && (
        <div className={styles.list}>
          {active.map((person) => {
            const current = membershipsOf(areas, person.id).filter((m) => assignable.some((a) => a.id === m.areaId));
            return (
              <div key={person.id} className={styles.areaRow}>
                <div className={styles.grow}>
                  <p className={styles.text}>{person.name}</p>
                  <span className={styles.meta}>
                    {current.length === 0
                      ? t('common.jr.brainManage.people.noAreas')
                      : current
                          .map(
                            (m) =>
                              `${areaName(m.areaId)} (${t(`common.jr.brainManage.people.level.${m.level}`)}${m.primary ? `, ${t('common.jr.brainManage.people.primary')}` : ''})`
                          )
                          .join(' · ')}
                  </span>
                </div>
                <Button
                  size='small'
                  shape='circle'
                  aria-label={t('common.jr.brainManage.people.edit', { name: person.name })}
                  icon={<Edit theme='outline' size={15} />}
                  onClick={() => open(person)}
                />
              </div>
            );
          })}
        </div>
      )}
      <Modal
        visible={Boolean(editing)}
        title={t('common.jr.brainManage.people.editTitle', { name: editing?.name })}
        closable={!busy}
        onCancel={() => setEditing(undefined)}
        footer={[
          <Button key='cancel' type='text' shape='round' disabled={busy} onClick={() => setEditing(undefined)}>
            {t('common.cancel')}
          </Button>,
          <Button key='save' type='primary' shape='round' loading={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>,
        ]}
      >
        {assignable.length === 0 && <p className={styles.empty}>{t('common.jr.brainManage.people.noAreasYet')}</p>}
        <Radio.Group value={primary ?? undefined} onChange={(value: number) => setPrimary(value)} className='w-full'>
          {assignable.map((area) => {
            const entry = draft.get(area.id);
            return (
              <div key={area.id} className={styles.areaRow}>
                <Checkbox checked={Boolean(entry)} onChange={(on) => toggle(area.id, on)} className={styles.grow}>
                  {area.name}
                </Checkbox>
                <Select
                  size='small'
                  className='w-130px'
                  disabled={!entry}
                  value={entry?.level ?? 'colaborador'}
                  aria-label={t('common.jr.brainManage.people.levelLabel', { area: area.name })}
                  onChange={(level: BrainMembership['level']) => setDraft(new Map(draft).set(area.id, { level }))}
                >
                  <Select.Option value='colaborador'>
                    {t('common.jr.brainManage.people.level.colaborador')}
                  </Select.Option>
                  <Select.Option value='gestor'>{t('common.jr.brainManage.people.level.gestor')}</Select.Option>
                </Select>
                <Radio value={area.id} disabled={!entry}>
                  {t('common.jr.brainManage.people.primary')}
                </Radio>
              </div>
            );
          })}
        </Radio.Group>
      </Modal>
    </section>
  );
};

export default BrainPeople;
