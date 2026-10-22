import { ipcBridge } from '@/common';
import type { JrAccessState } from '@/common/config/clientSettings';
import { Alert, Button, Input, Spin } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JrLogo } from '../JrCharacter';
import { JrAccessContext } from './context';
import styles from './Access.module.css';

const JrAccessGate: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<JrAccessState>({ status: 'checking', user: null });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'invalidCode' | 'profileUnbound' | 'deviceBound' | 'storageUnavailable' | null>(
    null
  );
  const refresh = useCallback(async () => {
    try {
      setState(await ipcBridge.jr.accessStatus.invoke());
    } catch {
      setState({ status: 'offline', user: null });
    }
  }, []);
  useEffect(() => {
    const dispose = ipcBridge.jr.accessChanged.on(setState);
    void refresh();
    return dispose;
  }, [refresh]);
  const logout = async () => {
    try {
      await ipcBridge.jr.logout.invoke();
    } finally {
      setCode('');
      await refresh();
    }
  };
  const login = async () => {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setState(await ipcBridge.jr.login.invoke({ code: code.trim() }));
      setCode('');
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '';
      setError(
        message.includes('PROFILE_UNBOUND')
          ? 'profileUnbound'
          : message.includes('DEVICE_BOUND') || message.includes('device_bound_to_other_employee')
            ? 'deviceBound'
            : message.includes('STORAGE_UNAVAILABLE')
              ? 'storageUnavailable'
              : 'invalidCode'
      );
    } finally {
      setBusy(false);
    }
  };
  const permitted = state.status === 'authenticated' || state.status === 'pilot';
  if (permitted) return <JrAccessContext.Provider value={{ state, logout }}>{children}</JrAccessContext.Provider>;
  const message =
    state.status === 'revoked'
      ? 'common.jr.access.revoked'
      : state.status === 'offline'
        ? 'common.jr.access.offline'
        : state.status === 'unconfigured'
          ? 'common.jr.access.unconfigured'
          : null;
  return (
    <main className={styles.page}>
      <section className={styles.login} aria-labelledby='jr-access-title'>
        <JrLogo height={48} className={styles.brand} />
        <h1 id='jr-access-title'>{t('common.jr.access.title')}</h1>
        <p className={styles.hint}>{t('common.jr.access.description')}</p>
        {state.status === 'checking' ? (
          <Spin aria-label={t('common.loading')} />
        ) : (
          <>
            {message && <Alert type={state.status === 'revoked' ? 'error' : 'warning'} content={t(message)} />}
            {error && <Alert type='error' content={t(`common.jr.access.${error}`)} />}
            <label htmlFor='jr-access-code'>{t('common.jr.access.code')}</label>
            <Input
              id='jr-access-code'
              type='password'
              autoComplete='off'
              value={code}
              onChange={setCode}
              maxLength={200}
              disabled={busy}
              autoFocus
              onPressEnter={() => void login()}
            />
            <Button
              type='primary'
              long
              className={styles.primary}
              loading={busy}
              disabled={!code.trim()}
              onClick={() => void login()}
            >
              {t('common.jr.access.enter')}
            </Button>
            {message && (
              <Button type='text' onClick={() => void refresh()}>
                {t('common.jr.retry')}
              </Button>
            )}
            <p className={styles.hint}>{t('common.jr.access.askAdmin')}</p>
          </>
        )}
      </section>
    </main>
  );
};
export default JrAccessGate;
