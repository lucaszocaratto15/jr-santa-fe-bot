import { ipcBridge } from '@/common';
import type { BrainManagedArea } from '@/common/types/agent/brainTypes';
import { Button, Input, Message, Modal } from '@arco-design/web-react';
import { Delete, Edit } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import accessStyles from '../Access/Access.module.css';
import styles from './Brain.module.css';
import { brainErrorKey, isProtectedArea } from './brainShared';

type Props = { areas: BrainManagedArea[]; onChanged: () => void };

/** Owner: create, rename and remove areas. Geral and "Sem área" are fixed. */
const BrainAreas: React.FC<Props> = ({ areas, onChanged }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ area: BrainManagedArea; name: string }>();
  const [removing, setRemoving] = useState<BrainManagedArea>();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      onChanged();
      return true;
    } catch (failure) {
      Message.error(t(brainErrorKey(failure)));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const value = name.trim();
    if (!value || busy) return;
    if (await run(() => ipcBridge.brain.manage.createArea.invoke({ name: value }))) setName('');
  };

  return (
    <section className={styles.section} data-testid='brain-areas'>
      <h3 className={accessStyles.sectionLabel}>{t('common.jr.brainManage.areas.title')}</h3>
      <div className={styles.inline}>
        <Input
          className={styles.search}
          value={name}
          onChange={setName}
          maxLength={80}
          placeholder={t('common.jr.brainManage.areas.newPlaceholder')}
          aria-label={t('common.jr.brainManage.areas.newPlaceholder')}
          onPressEnter={() => void create()}
        />
        <Button type='primary' shape='round' disabled={!name.trim() || busy} onClick={() => void create()}>
          {t('common.jr.brainManage.areas.create')}
        </Button>
      </div>
      <div className={styles.list}>
        {areas.map((area) => (
          <div key={area.id} className={styles.areaRow}>
            <div className={styles.grow}>
              <p className={styles.text}>{area.name}</p>
              <span className={styles.meta}>
                {isProtectedArea(area)
                  ? t('common.jr.brainManage.areas.protected')
                  : t('common.jr.brainManage.areas.members', { count: area.members.length })}
              </span>
            </div>
            {!isProtectedArea(area) && (
              <>
                <Button
                  size='small'
                  shape='circle'
                  aria-label={t('common.jr.brainManage.areas.rename')}
                  icon={<Edit theme='outline' size={15} />}
                  onClick={() => setRenaming({ area, name: area.name })}
                />
                <Button
                  size='small'
                  shape='circle'
                  status='danger'
                  aria-label={t('common.jr.brainManage.areas.remove')}
                  icon={<Delete theme='outline' size={15} />}
                  onClick={() => setRemoving(area)}
                />
              </>
            )}
          </div>
        ))}
      </div>
      <Modal
        visible={Boolean(renaming)}
        title={t('common.jr.brainManage.areas.renameTitle')}
        closable={!busy}
        onCancel={() => setRenaming(undefined)}
        footer={[
          <Button key='cancel' type='text' shape='round' disabled={busy} onClick={() => setRenaming(undefined)}>
            {t('common.cancel')}
          </Button>,
          <Button
            key='save'
            type='primary'
            shape='round'
            loading={busy}
            disabled={!renaming?.name.trim() || renaming.name.trim() === renaming.area.name}
            onClick={() =>
              renaming &&
              void run(() =>
                ipcBridge.brain.manage.renameArea.invoke({ id: renaming.area.id, name: renaming.name.trim() })
              ).then((ok) => ok && setRenaming(undefined))
            }
          >
            {t('common.save')}
          </Button>,
        ]}
      >
        <Input
          value={renaming?.name ?? ''}
          maxLength={80}
          onChange={(value) => renaming && setRenaming({ ...renaming, name: value })}
          aria-label={t('common.jr.brainManage.areas.renameTitle')}
        />
      </Modal>
      <Modal
        visible={Boolean(removing)}
        title={t('common.jr.brainManage.areas.removeTitle', { name: removing?.name })}
        closable={!busy}
        onCancel={() => setRemoving(undefined)}
        footer={[
          <Button key='cancel' type='text' shape='round' disabled={busy} onClick={() => setRemoving(undefined)}>
            {t('common.cancel')}
          </Button>,
          <Button
            key='remove'
            type='primary'
            status='danger'
            shape='round'
            loading={busy}
            onClick={() =>
              removing &&
              void run(() => ipcBridge.brain.manage.removeArea.invoke({ id: removing.id })).then(
                (ok) => ok && setRemoving(undefined)
              )
            }
          >
            {t('common.jr.brainManage.areas.remove')}
          </Button>,
        ]}
      >
        <p>{t('common.jr.brainManage.areas.removeBody', { name: removing?.name })}</p>
      </Modal>
    </section>
  );
};

export default BrainAreas;
