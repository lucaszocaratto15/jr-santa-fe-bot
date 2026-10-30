import { ipcBridge } from '@/common';
import type { JrAdminEmployee, JrInvite } from '@/common/config/clientSettings';
import { Alert, Button, Input, Modal, Spin, Tooltip } from '@arco-design/web-react';
import { Computer, Copy, Edit, Key, Lock, PeopleMinus, Plus, Unlock } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { isJrAdmin, useJrAccess } from './context';
import styles from './Access.module.css';
import HandbookAdmin from './HandbookAdmin';
import TeamUsage from './TeamUsage';

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

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
          title: state.user.title ?? null,
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
  const [toRetitle, setToRetitle] = useState<JrAdminEmployee>();
  const [newTitle, setNewTitle] = useState('');
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
  const openRetitle = (person: JrAdminEmployee) => {
    setFailed(false);
    setNewTitle(person.title ?? '');
    setToRetitle(person);
  };
  const saveTitle = async () => {
    if (!toRetitle || pending) return;
    setPending(toRetitle.id);
    setFailed(false);
    try {
      await ipcBridge.jr.admin.setTitle.invoke({ employeeId: toRetitle.id, title: newTitle.trim() || null });
      setToRetitle(undefined);
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
      <header className={styles.heading}>
        <div className={styles.headingCopy}>
          <h1 className={styles.pageTitle}>{t('common.jr.access.adminTitle')}</h1>
          <p className={styles.subtitle}>{t('common.jr.access.adminSubtitle')}</p>
        </div>
        <Button
          type='primary'
          shape='round'
          className={styles.primary}
          icon={<Plus theme='outline' size={14} fill='currentColor' />}
          disabled={Boolean(pending)}
          onClick={openCreate}
        >
          {t('common.jr.access.newEmployee')}
        </Button>
      </header>
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
          <section aria-labelledby='jr-admin-people'>
            <h2 id='jr-admin-people' className={styles.sectionLabel}>
              {t('common.jr.access.peopleTitle')}
            </h2>
            <div className={styles.list}>
              {people.map((person) => {
                const personState = person.revoked ? 'revoked' : person.blocked ? 'blocked' : 'active';
                const devices = (person.devices ?? [])
                  .filter((device) => !device.revokedAt)
                  .map((device) => device.name);
                return (
                  <article key={person.id} className={styles.row}>
                    <span className={styles.avatar} data-state={personState} aria-hidden='true'>
                      {initialsOf(person.name)}
                    </span>
                    <div className={styles.rowMain}>
                      <div className={styles.rowTitle}>
                        <h2 className={styles.rowName}>{person.name}</h2>
                        <span className={styles.status} data-state={personState}>
                          {t(statusKey(person))}
                        </span>
                      </div>
                      <p className={styles.rowMeta}>
                        <span>{person.title || t('common.jr.access.noTitle')}</span>
                        {devices.length > 0 && (
                          <span className={styles.devices}>
                            <Computer theme='outline' size={12} />
                            {devices.join(', ')}
                          </span>
                        )}
                      </p>
                    </div>
                    {person.role === 'employee' && !person.revoked && (
                      <div className={styles.rowActions}>
                        <Button
                          className={styles.soft}
                          shape='round'
                          size='small'
                          icon={<Key theme='outline' size={13} />}
                          disabled={Boolean(pending)}
                          loading={pending === person.id}
                          onClick={() => void generate(person.id)}
                        >
                          {t('common.jr.access.newCode')}
                        </Button>
                        <Tooltip content={t('common.jr.access.editTitle')}>
                          <Button
                            type='text'
                            shape='circle'
                            size='small'
                            className={styles.quiet}
                            aria-label={t('common.jr.access.editTitle')}
                            icon={<Edit theme='outline' size={15} />}
                            disabled={Boolean(pending)}
                            onClick={() => openRetitle(person)}
                          />
                        </Tooltip>
                        <Tooltip
                          content={t(
                            person.blocked ? 'common.jr.access.unblockAction' : 'common.jr.access.blockAction'
                          )}
                        >
                          <Button
                            type='text'
                            shape='circle'
                            size='small'
                            className={styles.quiet}
                            aria-label={t(
                              person.blocked ? 'common.jr.access.unblockAction' : 'common.jr.access.blockAction'
                            )}
                            icon={
                              person.blocked ? <Unlock theme='outline' size={15} /> : <Lock theme='outline' size={15} />
                            }
                            disabled={Boolean(pending)}
                            loading={pending === person.id}
                            onClick={() => void setBlocked(person)}
                          />
                        </Tooltip>
                        <Tooltip content={t('common.jr.access.revokeAction')}>
                          <Button
                            type='text'
                            shape='circle'
                            size='small'
                            className={styles.dangerQuiet}
                            aria-label={t('common.jr.access.revokeAction')}
                            icon={<PeopleMinus theme='outline' size={15} />}
                            disabled={Boolean(pending)}
                            onClick={() => {
                              setFailed(false);
                              setToRevoke(person);
                            }}
                          />
                        </Tooltip>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}
      <HandbookAdmin />
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
            <Button type='text' shape='round' disabled={Boolean(pending)} onClick={closeCreate}>
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
            <Button
              type='primary'
              shape='round'
              className={styles.primary}
              icon={<Copy theme='outline' size={14} fill='currentColor' />}
              onClick={() => void copy()}
            >
              {t(copied ? 'common.jr.access.copied' : 'common.jr.access.copyCode')}
            </Button>
            {failed && <Alert type='error' content={t('common.jr.access.actionError')} />}
          </div>
        )}
      </Modal>
      <Modal
        visible={Boolean(toRetitle)}
        title={t('common.jr.access.editTitleHeading', { name: toRetitle?.name })}
        closable={!pending}
        maskClosable={!pending}
        onCancel={() => setToRetitle(undefined)}
        footer={[
          <Button
            key='cancel'
            type='text'
            shape='round'
            disabled={Boolean(pending)}
            onClick={() => setToRetitle(undefined)}
          >
            {t('common.cancel')}
          </Button>,
          <Button key='save' type='primary' shape='round' loading={Boolean(pending)} onClick={() => void saveTitle()}>
            {t('common.save')}
          </Button>,
        ]}
      >
        <label className={styles.adminField} htmlFor='jr-employee-retitle'>
          <span>{t('common.jr.access.employeeTitle')}</span>
          <Input
            id='jr-employee-retitle'
            value={newTitle}
            onChange={setNewTitle}
            maxLength={80}
            disabled={Boolean(pending)}
            onPressEnter={() => void saveTitle()}
          />
        </label>
        <p className={styles.hint}>{t('common.jr.access.editTitleHint')}</p>
        {failed && <Alert type='error' content={t('common.jr.access.actionError')} />}
      </Modal>
      <Modal
        visible={Boolean(toRevoke)}
        title={t('common.jr.access.revokeTitle')}
        closable={!pending}
        maskClosable={!pending}
        onCancel={() => setToRevoke(undefined)}
        footer={[
          <Button
            key='cancel'
            type='text'
            shape='round'
            disabled={Boolean(pending)}
            onClick={() => setToRevoke(undefined)}
          >
            {t('common.cancel')}
          </Button>,
          <Button
            key='revoke'
            type='primary'
            status='danger'
            shape='round'
            loading={Boolean(pending)}
            onClick={() => void revoke()}
          >
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
