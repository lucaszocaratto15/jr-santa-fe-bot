import { ipcBridge } from '@/common';
import type { JrAdminEmployee, JrInvite } from '@/common/config/clientSettings';
import { Alert, Button, Input, Modal, Spin } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { isJrAdmin, useJrAccess } from './context';
import styles from './Access.module.css';
import TeamUsage from './TeamUsage';

const statusKey = (person: JrAdminEmployee) => {
  if (person.revoked) return 'common.jr.access.revokedStatus';
  if (person.blocked) return 'common.jr.access.blockedStatus';
  return 'common.jr.access.activeStatus';
};

const AdminContent: React.FC = () => {
  const { t } = useTranslation();
  const {
    data: people = [],
    error,
    isLoading,
    mutate,
  } = useSWR('jr.admin.employees', () => ipcBridge.jr.admin.list.invoke(), {
    refreshInterval: 15000,
    shouldRetryOnError: false,
  });
  const { state } = useJrAccess();
  const { data: own } = useSWR(['jr.admin.self', state.user?.id], () => ipcBridge.jr.personalUsage.invoke(), {
    refreshInterval: 15000,
    shouldRetryOnError: false,
  });
  const self: JrAdminEmployee | undefined =
    state.user && own?.usage
      ? {
          id: state.user.id,
          name: state.user.name,
          role: state.user.role,
          revoked: false,
          createdAt: own.usage.startedAt,
          revokedAt: null,
          blocked: false,
          blockedAt: null,
          tokenLimit: null,
          accessStart: null,
          accessEnd: null,
          devices: [],
          usage: own.usage,
        }
      : undefined;
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState<JrInvite>();
  const [pending, setPending] = useState('');
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<JrAdminEmployee>();
  const openCreate = () => {
    if (pending) return;
    setFailed(false);
    setCreating(true);
  };
  const closeCreate = () => {
    if (pending) return;
    setCreating(false);
  };
  const generate = async (employeeId?: string) => {
    const trimmedName = name.trim();
    const trimmedTitle = title.trim();
    if (pending || (!employeeId && !trimmedName)) return;
    setPending(employeeId || 'invite');
    setFailed(false);
    setCopied(false);
    setInvite(undefined);
    try {
      const result = employeeId
        ? await ipcBridge.jr.admin.reissue.invoke({ employeeId })
        : await ipcBridge.jr.admin.createInvite.invoke({
            name: trimmedName,
            email: null,
            title: trimmedTitle || null,
            tokenLimit: null,
            accessStart: null,
            accessEnd: null,
          });
      setInvite(result);
      if (!employeeId) {
        setName('');
        setTitle('');
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
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return (
    <main className={styles.admin}>
      <div className={styles.heading}>
        <h1 className={styles.pageTitle}>{t('common.jr.access.adminTitle')}</h1>
        <Button
          type='primary'
          shape='round'
          className={styles.primary}
          disabled={Boolean(pending)}
          onClick={openCreate}
        >
          {t('common.jr.access.newEmployee')}
        </Button>
      </div>
      {failed && !creating && !invite && <Alert type='error' content={t('common.jr.access.actionError')} />}
      {isLoading ? (
        <Spin />
      ) : error ? (
        <Alert type='error' content={t('common.jr.access.loadError')} />
      ) : !people.length ? (
        <p className={styles.hint}>{t('common.jr.access.noPeople')}</p>
      ) : (
        <>
          <TeamUsage people={people} self={self} />
          <div className={styles.list}>
            {people.map((person) => (
              <article key={person.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <h2 className={styles.rowName}>{person.name}</h2>
                  {person.title ? <p className={styles.rowMeta}>{person.title}</p> : null}
                </div>
                <span
                  className={styles.status}
                  data-state={person.revoked ? 'revoked' : person.blocked ? 'blocked' : 'active'}
                >
                  {t(statusKey(person))}
                </span>
                {person.role === 'employee' && !person.revoked && (
                  <div className={styles.rowActions}>
                    <Button
                      type='text'
                      className={styles.quiet}
                      disabled={Boolean(pending)}
                      loading={pending === person.id}
                      onClick={() => void setBlocked(person)}
                    >
                      {t(person.blocked ? 'common.jr.access.unblockAction' : 'common.jr.access.blockAction')}
                    </Button>
                    <Button
                      type='text'
                      className={styles.quiet}
                      disabled={Boolean(pending)}
                      loading={pending === person.id}
                      onClick={() => void generate(person.id)}
                    >
                      {t('common.jr.access.newCode')}
                    </Button>
                    <Button
                      type='text'
                      className={styles.dangerQuiet}
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
            ))}
          </div>
        </>
      )}
      <Modal
        visible={creating}
        title={t('common.jr.access.newEmployeeTitle')}
        closable={!pending}
        maskClosable={!pending}
        escToExit={!pending}
        onCancel={closeCreate}
        footer={null}
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
          <label className={styles.adminField} htmlFor='jr-employee-title'>
            <span>{t('common.jr.access.employeeTitle')}</span>
            <Input
              id='jr-employee-title'
              value={title}
              onChange={setTitle}
              maxLength={80}
              disabled={Boolean(pending)}
              onPressEnter={() => void generate()}
            />
          </label>
          {failed && <Alert type='error' content={t('common.jr.access.actionError')} />}
          <div className={styles.sheetActions}>
            <Button disabled={Boolean(pending)} onClick={closeCreate}>
              {t('common.cancel')}
            </Button>
            <Button
              type='primary'
              shape='round'
              className={styles.primary}
              loading={pending === 'invite'}
              disabled={!name.trim() || Boolean(pending)}
              onClick={() => void generate()}
            >
              {t('common.jr.access.createEmployee')}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        visible={Boolean(invite)}
        title={t('common.jr.access.generatedCode')}
        footer={null}
        onCancel={() => setInvite(undefined)}
      >
        {invite && (
          <div className={styles.codeSheet}>
            <code className={styles.code}>{invite.code}</code>
            <Button type='primary' shape='round' className={styles.primary} onClick={() => void copy()}>
              {t(copied ? 'common.jr.access.copied' : 'common.jr.access.copyCode')}
            </Button>
            {failed && <Alert type='error' content={t('common.jr.access.actionError')} />}
          </div>
        )}
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
