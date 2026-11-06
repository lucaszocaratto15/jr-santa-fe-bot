import { ipcBridge } from '@/common';
import { Alert, Button, Message, Modal, Spin, Tag } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

/** Per-employee connection state. The browser handles login; no credentials enter the renderer. */
export default function StrataConnection({ ownerId }: { ownerId: string | null }): React.JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [awaitingUntil, setAwaitingUntil] = useState<number | null>(null);
  const status = useSWR(ownerId ? ['jr.strata.status', ownerId] : null, () => ipcBridge.jr.strata.status.invoke(), {
    shouldRetryOnError: false,
    refreshInterval: () => (awaitingUntil !== null && Date.now() < awaitingUntil ? 3000 : 0),
  });
  useEffect(() => {
    setAwaitingUntil(null);
  }, [ownerId]);
  useEffect(() => {
    if (awaitingUntil === null) return;
    const timer = setTimeout(() => setAwaitingUntil(null), Math.max(0, awaitingUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [awaitingUntil]);
  useEffect(() => {
    if (status.data?.linked) setAwaitingUntil(null);
  }, [status.data?.linked]);
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      await status.mutate();
    } catch {
      Message.error(t('common.jr.strata.failed'));
    } finally {
      setBusy(false);
    }
  };
  const connect = (): void => {
    void run(async () => {
      const result = await ipcBridge.jr.strata.connect.invoke();
      setAwaitingUntil(Date.parse(result.expiresAt));
      Message.info(t('common.jr.strata.browserOpened'));
    });
  };
  const disconnect = (): void => {
    Modal.confirm({
      title: t('common.jr.strata.disconnectTitle'),
      content: t('common.jr.strata.disconnectBody'),
      onOk: async () => {
        await run(async () => {
          await ipcBridge.jr.strata.disconnect.invoke();
          setAwaitingUntil(null);
          Message.success(t('common.jr.strata.disconnected'));
        });
      },
    });
  };
  return (
    <section className='border border-base rounded-12px p-16px mb-16px' aria-label={t('common.jr.strata.title')}>
      <h3 className='m-0 mb-8px'>{t('common.jr.strata.title')}</h3>
      <p>{t('common.jr.strata.description')}</p>
      {!ownerId ? (
        <Alert type='info' content={t('common.jr.strata.notLinked')} />
      ) : status.error ? (
        <>
          <Alert type='error' content={t('common.jr.strata.unavailable')} />
          <div className='flex gap-8px mt-12px'>
            <Button loading={busy} onClick={connect}>
              {t('common.jr.strata.connect')}
            </Button>
            <Button disabled={busy} onClick={disconnect}>
              {t('common.jr.strata.disconnect')}
            </Button>
          </div>
        </>
      ) : !status.data ? (
        <Spin />
      ) : !status.data.configured ? (
        <Alert type='info' content={t('common.jr.strata.unconfigured')} />
      ) : (
        <>
          {status.data.linked && status.data.erpUser ? (
            <>
              <Tag>{t('common.jr.strata.linkedAs', { name: status.data.erpUser.name })}</Tag>
              <p>{t('common.jr.strata.permissions')}</p>
              <p>{t('common.jr.strata.consent')}</p>
              <Button disabled={busy} onClick={disconnect}>
                {t('common.jr.strata.disconnect')}
              </Button>
            </>
          ) : (
            <>
              <p>{t('common.jr.strata.notLinked')}</p>
              {awaitingUntil !== null && <p role='status'>{t('common.jr.strata.connecting')}</p>}
              <Button type='primary' loading={busy} onClick={connect}>
                {t('common.jr.strata.connect')}
              </Button>
            </>
          )}
        </>
      )}
      {ownerId && (
        <Button type='text' disabled={busy} onClick={() => void run(async () => {})}>
          {t('common.jr.strata.refresh')}
        </Button>
      )}
    </section>
  );
}
