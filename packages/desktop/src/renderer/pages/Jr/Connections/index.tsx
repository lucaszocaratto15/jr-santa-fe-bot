import { Alert, Button, Input, Modal, Spin } from '@arco-design/web-react';
import { Browser, CloseSmall, Search } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useJrAccess } from '@/renderer/pages/Jr/Access/context';
import AdvancedConnections, { type ConnectionConfiguration } from './AdvancedConnections';
import AppDetails from './AppDetails';
import ConnectionDialog from './ConnectionDialog';
import type { ApprovedAppId } from './connections';
import { useConnections } from './useConnections';
import styles from './Connections.module.css';

// Google account connection is paused for the current company pilot.
const APPROVED_APPS: ApprovedAppId[] = ['chrome'];

const Connections: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state } = useJrAccess();
  const admin = state.user?.role === 'admin' || state.status === 'pilot';
  const connections = useConnections();
  const [search, setSearch] = useState('');
  const [selectedApp, setSelectedApp] = useState<ApprovedAppId>();
  const [advanced, setAdvanced] = useState(false);
  const [configuration, setConfiguration] = useState<ConnectionConfiguration>();
  const apps = APPROVED_APPS.filter(() =>
    `${t('common.jr.mcp.chromeTitle')} ${t('common.jr.mcp.appChromeDescription')}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  );
  const close = () => (onClose ? onClose() : navigate('/guid'));
  const content = (
    <>
      <Modal
        visible={!selectedApp && !configuration}
        alignCenter
        className={styles.catalogDialog}
        title={
          <div className={styles.modalHeading}>
            <h1>{t('common.jr.mcp.title')}</h1>
            <Button
              type='text'
              className={styles.closeButton}
              icon={<CloseSmall size={20} />}
              aria-label={t('common.close')}
              onClick={close}
            />
          </div>
        }
        onCancel={close}
        closable={false}
        focusLock
        footer={null}
        unmountOnExit
      >
        <section className={styles.content}>
          <Input
            className={styles.search}
            prefix={<Search size={16} aria-hidden />}
            value={search}
            onChange={setSearch}
            aria-label={t('common.jr.mcp.searchApps')}
            placeholder={t('common.jr.mcp.searchApps')}
          />
          <div className={styles.categories} role='tablist' aria-label={t('common.jr.mcp.allApps')}>
            <Button
              id='jr-app-catalogue-tab'
              type='text'
              role='tab'
              aria-selected
              aria-controls='jr-app-catalogue'
              className={styles.category}
            >
              {t('common.jr.mcp.allApps')}
            </Button>
          </div>
          <div className={styles.catalogBody}>
            {connections.actionError && <Alert type='error' content={t(`common.jr.mcp.${connections.actionError}`)} />}
            {connections.error && (
              <div className={styles.loadError}>
                <Alert type='error' content={t('common.jr.mcp.loadError')} />
                <Button onClick={connections.refresh} aria-label={t('common.reload')}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {connections.isLoading && (
              <div role='status' aria-label={t('common.loading')}>
                <Spin />
              </div>
            )}
            <div
              id='jr-app-catalogue'
              role='tabpanel'
              aria-labelledby='jr-app-catalogue-tab'
              className={styles.catalog}
            >
              {apps.map((app) => (
                <Button
                  key={app}
                  type='text'
                  className={styles.appCard}
                  aria-label={t('common.jr.mcp.appActionLabel', { name: t('common.jr.mcp.chromeTitle') })}
                  onClick={() => setSelectedApp(app)}
                >
                  <span className={styles.appIcon} aria-hidden>
                    <Browser size={40} />
                  </span>
                  <span className={styles.appCopy}>
                    <strong>{t('common.jr.mcp.chromeTitle')}</strong>
                    <span>{t('common.jr.mcp.appChromeDescription')}</span>
                  </span>
                  <span className={styles.addApp}>{t('common.jr.mcp.addApp')}</span>
                </Button>
              ))}
            </div>
            {!apps.length && <p className={styles.empty}>{t('common.jr.mcp.noAppsFound')}</p>}
            {admin && (
              <div className={styles.advancedEntry}>
                <Button
                  type='text'
                  aria-expanded={advanced}
                  aria-controls='jr-advanced-connections'
                  onClick={() => setAdvanced((current) => !current)}
                >
                  {t('common.jr.mcp.advanced')}
                </Button>
              </div>
            )}
            {admin && advanced && (
              <div id='jr-advanced-connections'>
                <AdvancedConnections connections={connections} onConfigure={setConfiguration} />
              </div>
            )}
          </div>
        </section>
      </Modal>
      {selectedApp && <AppDetails connections={connections} onBack={() => setSelectedApp(undefined)} onClose={close} />}
      {configuration && (
        <ConnectionDialog
          {...configuration}
          servers={connections.servers}
          onSave={connections.save}
          onClose={() => setConfiguration(undefined)}
        />
      )}
    </>
  );
  return onClose ? content : <main className={styles.page}>{content}</main>;
};

export default Connections;
