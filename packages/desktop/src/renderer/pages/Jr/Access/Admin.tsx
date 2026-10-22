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
  const [tokenLimit, setTokenLimit] = useState('');
  const [accessStart, setAccessStart] = useState('');
  const [accessEnd, setAccessEnd] = useState('');
  const [policyDrafts, setPolicyDrafts] = useState<
    Record<string, { tokenLimit: string; accessStart: string; accessEnd: string }>
  >({});
  const [invite, setInvite] = useState<JrInvite>();
  const [pending, setPending] = useState('');
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<JrAdminEmployee>();
  const numeric = new Intl.NumberFormat(i18n.language);
  const tokens = (value: number | null | undefined) =>
    value == null ? t('common.jr.access.unreported') : numeric.format(value);
  const policyFor = (person: JrAdminEmployee) =>
    policyDrafts[person.id] ?? {
      tokenLimit: person.tokenLimit == null ? '' : String(person.tokenLimit),
      accessStart: person.accessStart ?? '',
      accessEnd: person.accessEnd ?? '',
    };
  const updatePolicyDraft = (
    person: JrAdminEmployee,
    field: 'tokenLimit' | 'accessStart' | 'accessEnd',
    value: string
  ) =>
    setPolicyDrafts((current) => ({
      ...current,
      [person.id]: { ...policyFor(person), [field]: value },
    }));
  const generate = async (employeeId?: string) => {
    if (pending || (!employeeId && !name.trim())) return;
    if (
      !employeeId &&
      ((accessStart === '') !== (accessEnd === '') ||
        (tokenLimit !== '' && (!/^\d+$/u.test(tokenLimit) || !Number.isSafeInteger(Number(tokenLimit)))))
    ) {
      setFailed(true);
      return;
    }
    setPending(employeeId || 'invite');
    setFailed(false);
    setCopied(false);
    setInvite(undefined);
    try {
      const result = employeeId
        ? await ipcBridge.jr.admin.reissue.invoke({ employeeId })
        : await ipcBridge.jr.admin.createInvite.invoke({
            name: name.trim(),
            tokenLimit: tokenLimit === '' ? null : Number(tokenLimit),
            accessStart: accessStart || null,
            accessEnd: accessEnd || null,
          });
      setInvite(result);
      if (!employeeId) {
        setName('');
        setTokenLimit('');
        setAccessStart('');
        setAccessEnd('');
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
  const savePolicy = async (person: JrAdminEmployee) => {
    const draft = policyFor(person);
    const limit = draft.tokenLimit === '' ? null : Number(draft.tokenLimit);
    if (
      pending ||
      person.revoked ||
      (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) ||
      (draft.accessStart === '') !== (draft.accessEnd === '') ||
      (draft.accessStart !== '' && draft.accessStart === draft.accessEnd)
    ) {
      setFailed(true);
      return;
    }
    setPending(`policy:${person.id}`);
    setFailed(false);
    try {
      await ipcBridge.jr.admin.updatePolicy.invoke({
        employeeId: person.id,
        tokenLimit: limit,
        accessStart: draft.accessStart || null,
        accessEnd: draft.accessEnd || null,
      });
      await mutate();
      setPolicyDrafts((current) => {
        const next = { ...current };
        delete next[person.id];
        return next;
      });
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
        <div className={styles.invitePolicy}>
          <label className={styles.field}>
            <span>{t('common.jr.access.tokenLimit')}</span>
            <input
              type='number'
              min={0}
              step={1}
              value={tokenLimit}
              onChange={(event) => setTokenLimit(event.target.value)}
              disabled={Boolean(pending)}
              className={styles.policyInput}
            />
          </label>
          <label className={styles.field}>
            <span>{t('common.jr.access.startTime')}</span>
            <input
              type='time'
              value={accessStart}
              onChange={(event) => setAccessStart(event.target.value)}
              disabled={Boolean(pending)}
              className={styles.policyInput}
            />
          </label>
          <label className={styles.field}>
            <span>{t('common.jr.access.endTime')}</span>
            <input
              type='time'
              value={accessEnd}
              onChange={(event) => setAccessEnd(event.target.value)}
              disabled={Boolean(pending)}
              className={styles.policyInput}
            />
          </label>
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
      </div>
      <p className={styles.hint}>
        {t('common.jr.access.policyHint')} {t('common.jr.access.accessTimezone')}
      </p>
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
              {t('common.jr.access.tokenUsage', {
                used: tokens(person.usage?.totalTokens),
                limit: person.tokenLimit == null ? t('common.jr.access.noLimit') : tokens(person.tokenLimit),
              })}
            </p>
            <div className={styles.policyForm}>
              <label className={styles.field}>
                <span>{t('common.jr.access.tokenLimit')}</span>
                <input
                  type='number'
                  min={0}
                  step={1}
                  value={policyFor(person).tokenLimit}
                  onChange={(event) => updatePolicyDraft(person, 'tokenLimit', event.target.value)}
                  disabled={Boolean(pending) || person.revoked}
                  className={styles.policyInput}
                />
              </label>
              <label className={styles.field}>
                <span>{t('common.jr.access.startTime')}</span>
                <input
                  type='time'
                  value={policyFor(person).accessStart}
                  onChange={(event) => updatePolicyDraft(person, 'accessStart', event.target.value)}
                  disabled={Boolean(pending) || person.revoked}
                  className={styles.policyInput}
                />
              </label>
              <label className={styles.field}>
                <span>{t('common.jr.access.endTime')}</span>
                <input
                  type='time'
                  value={policyFor(person).accessEnd}
                  onChange={(event) => updatePolicyDraft(person, 'accessEnd', event.target.value)}
                  disabled={Boolean(pending) || person.revoked}
                  className={styles.policyInput}
                />
              </label>
            </div>
            {!!person.devices?.length && (
              <p className={styles.hint}>
                {t('common.jr.access.devices', { names: person.devices.map((device) => device.name).join(', ') })}
              </p>
            )}
            {person.role === 'employee' && !person.revoked && (
              <div className={styles.actions}>
                <Button
                  disabled={Boolean(pending)}
                  loading={pending === `policy:${person.id}`}
                  onClick={() => void savePolicy(person)}
                >
                  {t('common.jr.access.savePolicy')}
                </Button>
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
