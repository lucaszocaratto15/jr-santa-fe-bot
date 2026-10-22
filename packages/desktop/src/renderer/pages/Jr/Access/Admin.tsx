import { ipcBridge } from '@/common';
import type { JrAdminEmployee, JrInvite } from '@/common/config/clientSettings';
import { Alert, Button, Input, Modal, Spin, Tag } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { isJrAdmin, useJrAccess } from './context';
import styles from './Access.module.css';

const EMPLOYEE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

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
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [invite, setInvite] = useState<JrInvite>();
  const [pending, setPending] = useState('');
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<JrAdminEmployee>();
  const numeric = new Intl.NumberFormat(i18n.language);
  const tokens = (value: number | null | undefined) =>
    value == null ? t('common.jr.access.unreported') : numeric.format(value);
  const openCreate = () => {
    if (pending) return;
    setFailed(false);
    setEmailInvalid(false);
    setCreating(true);
  };
  const closeCreate = () => {
    if (pending) return;
    setCreating(false);
    setEmailInvalid(false);
  };
  const generate = async (employeeId?: string) => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (pending || (!employeeId && !trimmedName)) return;
    if (!employeeId && trimmedEmail && (trimmedEmail.length > 120 || !EMPLOYEE_EMAIL.test(trimmedEmail))) {
      setEmailInvalid(true);
      setFailed(false);
      return;
    }
    setPending(employeeId || 'invite');
    setFailed(false);
    setEmailInvalid(false);
    setCopied(false);
    setInvite(undefined);
    try {
      const result = employeeId
        ? await ipcBridge.jr.admin.reissue.invoke({ employeeId })
        : await ipcBridge.jr.admin.createInvite.invoke({
            name: trimmedName,
            email: trimmedEmail || null,
            tokenLimit: null,
            accessStart: null,
            accessEnd: null,
          });
      setInvite(result);
      if (!employeeId) {
        setName('');
        setEmail('');
        setCreating(false);
      }
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
  const setBlocked = async (person: JrAdminEmployee) => {
    if (pending || person.revoked) return;
    setPending(person.id);
    setFailed(false);
    try {
      await ipcBridge.jr.admin.setBlocked.invoke({ employeeId: person.id, blocked: !person.blocked });
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
        <h1 className={styles.pageTitle}>{t('common.jr.access.adminTitle')}</h1>
        <div className={styles.actions}>
          <Button
            type='primary'
            shape='round'
            className={styles.primary}
            disabled={Boolean(pending)}
            onClick={openCreate}
          >
            {t('common.jr.access.newEmployee')}
          </Button>
          <Button shape='round' onClick={() => void mutate()}>
            {t('common.reload')}
          </Button>
        </div>
      </div>
      {failed && !creating && <Alert type='error' content={t('common.jr.access.actionError')} />}
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
              <div>
                <h2>{person.name}</h2>
                {person.email ? <p className={styles.hint}>{person.email}</p> : null}
              </div>
              <Tag color={person.revoked ? 'red' : person.blocked ? 'orange' : 'green'}>
                {t(
                  person.revoked
                    ? 'common.jr.access.revokedStatus'
                    : person.blocked
                      ? 'common.jr.access.blockedStatus'
                      : 'common.jr.access.activeStatus'
                )}
              </Tag>
            </div>
            <p className={styles.hint}>
              {t('common.jr.access.personUsage', {
                input: tokens(person.usage?.promptTokens),
                output: tokens(person.usage?.completionTokens),
                requests: tokens(person.usage?.modelRequests),
              })}
            </p>
            <p className={styles.hint}>
              {t('common.jr.access.tokensUsed', {
                used: tokens(person.usage?.totalTokens),
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
                  onClick={() => void setBlocked(person)}
                >
                  {t(person.blocked ? 'common.jr.access.unblockAction' : 'common.jr.access.blockAction')}
                </Button>
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
        visible={creating}
        title={t('common.jr.access.newEmployeeTitle')}
        closable={!pending}
        maskClosable={!pending}
        escToExit={!pending}
        onCancel={closeCreate}
        footer={[
          <Button key='cancel' disabled={Boolean(pending)} onClick={closeCreate}>
            {t('common.cancel')}
          </Button>,
          <Button
            key='create'
            type='primary'
            className={styles.primary}
            loading={pending === 'invite'}
            disabled={!name.trim() || Boolean(pending)}
            onClick={() => void generate()}
          >
            {t('common.jr.access.createEmployee')}
          </Button>,
        ]}
      >
        <div className={styles.dialogForm}>
          <label className={styles.adminField} htmlFor='jr-employee-name'>
            <span>{t('common.jr.access.employeeName')}</span>
            <Input
              id='jr-employee-name'
              value={name}
              onChange={setName}
              maxLength={80}
              disabled={Boolean(pending)}
              onPressEnter={() => void generate()}
            />
          </label>
          <label className={styles.adminField} htmlFor='jr-employee-email'>
            <span>{t('common.jr.access.employeeEmail')}</span>
            <Input
              id='jr-employee-email'
              value={email}
              onChange={(value) => {
                setEmail(value);
                setEmailInvalid(false);
              }}
              maxLength={120}
              placeholder={t('common.jr.access.employeeEmailPlaceholder')}
              disabled={Boolean(pending)}
              onPressEnter={() => void generate()}
            />
          </label>
          {emailInvalid && <Alert type='error' content={t('common.jr.access.invalidEmail')} />}
          {failed && <Alert type='error' content={t('common.jr.access.actionError')} />}
        </div>
      </Modal>
      <Modal
        visible={Boolean(toRevoke)}
        title={t('common.jr.access.revokeTitle')}
        closable={!pending}
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
  return isJrAdmin(state.user) ? <AdminContent /> : <Alert type='error' content={t('common.jr.access.adminOnly')} />;
};
export default JrAdmin;
