import { Alert, Button, Modal, Tag } from '@arco-design/web-react';
import { Browser, CloseSmall, Left } from '@icon-park/react';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { isJrChromeServer } from './connections';
import type { ConnectionsController } from './useConnections';
import styles from './Connections.module.css';

type AppDetailsProps = {
  connections: ConnectionsController;
  onBack: () => void;
  onClose: () => void;
};

const AppDetails: React.FC<AppDetailsProps> = ({ connections, onBack, onClose }) => {
  const { t } = useTranslation();
  const { servers, tests, test, pending, actionError, connectChrome } = connections;
  const server = servers.find(isJrChromeServer);
  const result = server ? tests[server.id] : undefined;
  const connected = server?.enabled && result?.state === 'verified';
  const busy = pending === 'chrome' || result?.state === 'testing';
  useEffect(() => {
    if (server?.enabled && !result && pending !== 'chrome') void test(server);
  }, [server, result, pending, test]);

  return (
    <Modal
      visible
      alignCenter
      className={styles.detailsDialog}
      title={
        <div className={styles.modalHeading}>
          <Button
            type='text'
            className={styles.backButton}
            icon={<Left size={18} />}
            aria-label={t('common.goBack')}
            onClick={onBack}
          />
          <h1>{t('common.jr.mcp.chromeTitle')}</h1>
          <Button
            type='text'
            className={styles.closeButton}
            icon={<CloseSmall size={20} />}
            aria-label={t('common.close')}
            onClick={onClose}
          />
        </div>
      }
      onCancel={onClose}
      closable={false}
      focusLock
      footer={null}
    >
      <div className={styles.appDetails}>
        <div className={styles.appOverview}>
          <div className={styles.detailIcon} aria-hidden>
            <Browser size={32} />
          </div>
          <div>
            <h2>{t('common.jr.mcp.chromeTitle')}</h2>
            <p className={styles.detailDescription}>{t('common.jr.mcp.appChromeDescription')}</p>
          </div>
        </div>
        <section className={styles.accounts}>
          <div className={styles.accountsHeading}>
            <h3>{t('common.jr.mcp.accounts')}</h3>
            {!connected && (
              <Button
                className={styles.connectButton}
                type='primary'
                loading={busy}
                disabled={busy || connections.isLoading || Boolean(connections.error)}
                onClick={() => void connectChrome()}
              >
                {t('common.jr.mcp.connect')}
              </Button>
            )}
          </div>
          {connected ? (
            <div className={styles.accountRow}>
              <div>
                <strong>{t('common.jr.mcp.localProfile')}</strong>
                <p className={styles.hint}>{t('common.jr.mcp.localProfileDescription')}</p>
              </div>
              <Tag className={styles.connected}>{t('common.jr.mcp.connected')}</Tag>
            </div>
          ) : (
            <p className={styles.noAccounts}>{t('common.jr.mcp.noAccounts')}</p>
          )}
        </section>
        {!connected && actionError && <Alert type='error' content={t(`common.jr.mcp.${actionError}`)} />}
      </div>
    </Modal>
  );
};

export default AppDetails;
