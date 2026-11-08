import { ipcBridge } from '@/common';
import type { JrAdminEmployee } from '@/common/config/clientSettings';
import { Button, Message, Modal, Select } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import accessStyles from '../Access/Access.module.css';
import styles from './Brain.module.css';
import { brainErrorKey } from './brainShared';

/** Owner: removes every fact a person wrote (also for people who left). Always asks first. */
const BrainForget: React.FC<{ employees: JrAdminEmployee[] }> = ({ employees }) => {
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const person = employees.find((entry) => entry.id === userId);

  const erase = async () => {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const deleted = await ipcBridge.brain.manage.deleteAuthorFacts.invoke({ userId });
      Message.success(t('common.jr.brainManage.forget.done', { count: deleted }));
      setConfirming(false);
      setUserId(undefined);
    } catch (failure) {
      Message.error(t(brainErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} data-testid='brain-forget'>
      <h3 className={accessStyles.sectionLabel}>{t('common.jr.brainManage.forget.title')}</h3>
      <p className={styles.meta}>{t('common.jr.brainManage.forget.hint')}</p>
      <div className={styles.inline}>
        <Select
          className='w-260px'
          showSearch
          value={userId}
          onChange={setUserId}
          placeholder={t('common.jr.brainManage.forget.placeholder')}
          aria-label={t('common.jr.brainManage.forget.placeholder')}
        >
          {employees.map((entry) => (
            <Select.Option key={entry.id} value={entry.id}>
              {entry.revoked ? `${entry.name} (${t('common.jr.brainManage.exEmployee')})` : entry.name}
            </Select.Option>
          ))}
        </Select>
        <Button status='danger' shape='round' disabled={!userId} onClick={() => setConfirming(true)}>
          {t('common.jr.brainManage.forget.action')}
        </Button>
      </div>
      <Modal
        visible={confirming}
        title={t('common.jr.brainManage.forget.confirmTitle', { name: person?.name })}
        closable={!busy}
        maskClosable={!busy}
        onCancel={() => setConfirming(false)}
        footer={[
          <Button key='cancel' type='text' shape='round' disabled={busy} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>,
          <Button key='erase' type='primary' status='danger' shape='round' loading={busy} onClick={() => void erase()}>
            {t('common.jr.brainManage.forget.confirm')}
          </Button>,
        ]}
      >
        <p>{t('common.jr.brainManage.forget.confirmBody')}</p>
      </Modal>
    </section>
  );
};

export default BrainForget;
