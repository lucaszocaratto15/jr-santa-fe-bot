import { Alert, Button, Spin, Switch } from '@arco-design/web-react';
import { Plus, Refresh } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { IMcpServer } from '@/common/config/storage';
import {
  EMPTY_CONNECTION,
  builtinServerLabel,
  draftFromServer,
  isGmailServer,
  type ConnectionDraft,
} from './connections';
import type { ConnectionsController } from './useConnections';
import styles from './Connections.module.css';

export type ConnectionConfiguration = { draft: ConnectionDraft; server?: IMcpServer };

const AdvancedConnections: React.FC<{
  connections: ConnectionsController;
  onConfigure: (configuration: ConnectionConfiguration) => void;
}> = ({ connections, onConfigure }) => {
  const { t } = useTranslation();
  const { servers, error, isLoading, tests, pending, test, toggle, authorize } = connections;
  return (
    <section className={styles.advanced} aria-label={t('common.jr.mcp.advanced')}>
      <div className={styles.header}>
        <h2>{t('common.jr.mcp.configured')}</h2>
        <div className={styles.actions}>
          <Button
            type='text'
            className={styles.iconButton}
            icon={<Refresh size={16} />}
            aria-label={t('common.reload')}
            onClick={connections.refresh}
            loading={isLoading}
          />
          <Button
            icon={<Plus />}
            disabled={isLoading || Boolean(error)}
            onClick={() => onConfigure({ draft: EMPTY_CONNECTION })}
          >
            {t('common.jr.mcp.customAction')}
          </Button>
        </div>
      </div>
      <p className={styles.hint}>{t('common.jr.mcp.testHint')}</p>
      {isLoading ? (
        <Spin />
      ) : !error && !servers.length ? (
        <Alert type='info' content={t('common.jr.mcp.empty')} />
      ) : (
        servers.map((server) => {
          const result = tests[server.id];
          const busy = result?.state === 'testing' || pending === server.id;
          const labelKey = builtinServerLabel(server);
          const name = labelKey ? t(`common.jr.mcp.${labelKey}`) : server.name;
          return (
            <article key={server.id} className={styles.server} aria-label={name}>
              <div className={styles.header}>
                <h3>{name}</h3>
                <div className={styles.actions}>
                  <span className={styles.hint}>
                    {t(server.enabled ? 'common.jr.mcp.enabled' : 'common.jr.mcp.disabled')}
                  </span>
                  <Switch
                    checked={server.enabled}
                    loading={pending === server.id}
                    disabled={Boolean(pending) || busy || (isGmailServer(server) && !server.enabled)}
                    aria-label={t('common.jr.mcp.toggleLabel', { name })}
                    onChange={() => void toggle(server)}
                  />
                </div>
              </div>
              <p className={styles.hint} role='status'>
                {t(
                  `common.jr.mcp.${result?.state === 'failed' ? result.errorKey || 'testFailed' : result?.state || 'untested'}`
                )}
                {result?.state === 'verified' && result.toolCount !== undefined && (
                  <span className={styles.toolCount}>{t('common.jr.mcp.toolCount', { count: result.toolCount })}</span>
                )}
              </p>
              {isGmailServer(server) && <p className={styles.hint}>{t('common.jr.mcp.gmailPending')}</p>}
              <div className={`${styles.actions} ${styles.serverActions}`}>
                <Button loading={result?.state === 'testing'} disabled={busy} onClick={() => void test(server)}>
                  {t('common.jr.mcp.test')}
                </Button>
                {!server.builtin && (
                  <Button disabled={busy} onClick={() => onConfigure({ draft: draftFromServer(server), server })}>
                    {t('common.edit')}
                  </Button>
                )}
                {result?.state === 'authRequired' && result.oauth && !isGmailServer(server) && (
                  <Button disabled={busy} onClick={() => void authorize(server)}>
                    {t('common.jr.mcp.authorize')}
                  </Button>
                )}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
};

export default AdvancedConnections;
