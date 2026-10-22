import { ipcBridge } from '@/common';
import type { JrAdminEmployee, JrInvite } from '@/common/config/clientSettings';
import { Alert, Button, Input, Modal, Spin, Tag } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { useJrAccess } from './context';
import styles from './Access.module.css';

const AdminContent: React.FC = () => {
  const { t, i18n } = useTranslation();
  const {
    data: people = [],
    error,
    isLoading,
    mutate,
  } = useSWR('jr.admin.employees', () => ipcBridge.jr.admin.list.invoke(), {
    refreshInterval: 15000,
    shouldRetryOnError: false,
  });
  const [name, setName] = useState('');
  const [invite, setInvite] = useState<JrInvite>();
  const [pending, setPending] = useState('');
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<JrAdminEmployee>();
  const numeric = new Intl.NumberFormat(i18n.language);
  const tokens = (value: number | null | undefined) =>
    value == null ? t('common.jr.access.unreported') : numeric.format(value);
  const generate = async (employeeId?: string) => {
    if (pending || (!employeeId && !name.trim())) return;
    setPending(employeeId || 'invite');
    setFailed(false);
    setCopied(false);
    setInvite(undefined);
    try {
      const result = employeeId
        ? await ipcBridge.jr.admin.reissue.invoke({ employeeId })
        : await ipcBridge.jr.admin.createInvite.invoke({ name: name.trim() });
      setInvite(result);
      if (!employeeId) setName('');
      void mutate().catch(() => {});
    } catch {
      setFailed(true);
    } finally {
      setPending('');
    }
  };
  const revoke = async () => {
    if (!toRevoke || pending) return;
    setPending(toRevoke.id);
    setFailed(false);
    try {
      await ipcBridge.jr.admin.revoke.invoke({ employeeId: toRevoke.id });
      setToRevoke(undefined);
      await mutate();
    } catch {
      setFailed(true);
    } finally {
      setPending('');
    }
  };
  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  };
  return (
    <main className={styles.admin}>
      <div className={styles.heading}>
        <h1>{t('common.jr.access.adminTitle')}</h1>
        <Button onClick={() => void mutate()}>{t('common.reload')}</Button>
      </div>
      <Alert type='info' content={t('common.jr.access.noLimit')} />
      <div className={styles.inviteForm}>
        <div className={styles.field}>
          <label htmlFor='jr-employee-name'>{t('common.jr.access.employeeName')}</label>
          <Input
            id='jr-employee-name'
            value={name}
            onChange={setName}
            maxLength={80}
            disabled={Boolean(pending)}
            onPressEnter={() => void generate()}
          />
        </div>
        <Button
          type='primary'
          className={styles.primary}
          loading={pending === 'invite'}
          disabled={!name.trim() || Boolean(pending)}
          onClick={() => void generate()}
        >
          {t('common.jr.access.generateCode')}
        </Button>
      </div>
      {failed && <Alert type='error' content={t('common.jr.access.actionError')} />}
      {invite && (
        <section className={styles.person} aria-label={t('common.jr.access.generatedCode')}>
          <h2>{t('common.jr.access.generatedCode')}</h2>
          <code className={styles.code}>{invite.code}</code>
          <p className={styles.hint}>
            {t('common.jr.access.inviteHint', { date: new Date(invite.expiresAt).toLocaleString(i18n.language) })}
          </p>
          <div className={styles.actions}>
            <Button onClick={() => void copy()}>
              {t(copied ? 'common.jr.access.copied' : 'common.jr.access.copyCode')}
            </Button>
            <Button onClick={() => setInvite(undefined)}>{t('common.close')}</Button>
          </div>
        </section>
      )}
      {isLoading ? (
        <Spin />
      ) : error ? (
        <Alert type='error' content={t('common.jr.access.loadError')} />
      ) : !people.length ? (
        <p className={styles.hint}>{t('common.jr.access.noPeople')}</p>
      ) : (
        people.map((person) => (
          <article key={person.id} className={styles.person}>
            <div className={styles.heading}>
              <h2>{person.name}</h2>
              <Tag color={person.revoked ? 'red' : 'green'}>
                {t(person.revoked ? 'common.jr.access.revokedStatus' : 'common.jr.access.activeStatus')}
              </Tag>
            </div>
            <p className={styles.hint}>
              {t('common.jr.access.personUsage', {
                input: tokens(person.usage?.promptTokens),
                output: tokens(person.usage?.completionTokens),
                requests: tokens(person.usage?.modelRequests),
              })}
            </p>
            {!!person.devices?.length && (
              <p className={styles.hint}>
                {t('common.jr.access.devices', { names: person.devices.map((device) => device.name).join(', ') })}
              </p>
            )}
            {person.role === 'employee' && !person.revoked && (
              <div className={styles.actions}>
                <Button
                  disabled={Boolean(pending)}
                  loading={pending === person.id}
                  onClick={() => void generate(person.id)}
                >
                  {t('common.jr.access.newCode')}
                </Button>
                <Button
                  status='danger'
                  disabled={Boolean(pending)}
                  onClick={() => {
                    setFailed(false);
                    setToRevoke(person);
                  }}
                >
                  {t('common.jr.access.revokeAction')}
                </Button>
              </div>
            )}
          </article>
        ))
      )}
      <Modal
        visible={Boolean(toRevoke)}
        title={t('common.jr.access.revokeTitle')}
        closable={false}
        maskClosable={!pending}
        onCancel={() => setToRevoke(undefined)}
        footer={[
          <Button key='cancel' disabled={Boolean(pending)} onClick={() => setToRevoke(undefined)}>
            {t('common.cancel')}
          </Button>,
          <Button key='revoke' type='primary' status='danger' loading={Boolean(pending)} onClick={() => void revoke()}>
            {t('common.jr.access.revokeAction')}
          </Button>,
        ]}
      >
        <p>{t('common.jr.access.revokeDescription', { name: toRevoke?.name })}</p>
        {failed && <Alert type='error' content={t('common.jr.access.actionError')} />}
      </Modal>
    </main>
  );
};

const JrAdmin: React.FC = () => {
  const { state } = useJrAccess();
  const { t } = useTranslation();
  return state.user?.role === 'admin' ? (
    <AdminContent />
  ) : (
    <Alert type='error' content={t('common.jr.access.adminOnly')} />
  );
};
export default JrAdmin;
