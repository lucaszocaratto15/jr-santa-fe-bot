import { Alert, Button } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isGmailServer, isJrChromeServer } from '../Connections/connections';
import { useConnections } from '../Connections/useConnections';
import {
  applyLiveConnectorStatus,
  readConnectorRecords,
  setConnectorStatus,
  type ConnectorId,
  type ConnectorRecord,
} from './connectors';
import styles from './JrSidebar.module.css';

const MARK: Record<ConnectorId, { letter: string; background: string; color: string }> = {
  gmail: { letter: 'G', background: '#ffffff', color: '#c5221f' },
  chrome: { letter: 'C', background: '#ffffff', color: '#1a73e8' },
  calendar: { letter: 'A', background: '#90182c', color: '#ffffff' },
  files: { letter: 'F', background: '#3d5a80', color: '#ffffff' },
  whatsapp: { letter: 'W', background: '#1f7a4d', color: '#ffffff' },
};

const connectorName = (id: ConnectorId) => {
  switch (id) {
    case 'gmail':
      return 'common.jr.look.connector.gmail.name' as const;
    case 'chrome':
      return 'common.jr.look.connector.chrome.name' as const;
    case 'calendar':
      return 'common.jr.look.connector.calendar.name' as const;
    case 'files':
      return 'common.jr.look.connector.files.name' as const;
    case 'whatsapp':
      return 'common.jr.look.connector.whatsapp.name' as const;
  }
};

const connectorDescription = (id: ConnectorId) => {
  switch (id) {
    case 'gmail':
      return 'common.jr.look.connector.gmail.description' as const;
    case 'chrome':
      return 'common.jr.look.connector.chrome.description' as const;
    case 'calendar':
      return 'common.jr.look.connector.calendar.description' as const;
    case 'files':
      return 'common.jr.look.connector.files.description' as const;
    case 'whatsapp':
      return 'common.jr.look.connector.whatsapp.description' as const;
  }
};

/** Settings connector list. Chrome and Gmail follow MCP servers; the other rows stay local. */
const LiveConnectors: React.FC<{ onOpenAdvanced: () => void }> = ({ onOpenAdvanced }) => {
  const { t } = useTranslation();
  const connections = useConnections();
  const [stored, setStored] = useState<ConnectorRecord[]>(() => readConnectorRecords());
  const servers = Array.isArray(connections.servers) ? connections.servers : [];
  const chromeServer = servers.find(isJrChromeServer);
  const gmailServer = servers.find(isGmailServer);
  const records = applyLiveConnectorStatus(stored, {
    chrome: chromeServer?.enabled ? 'connected' : 'disconnected',
    gmail: gmailServer?.enabled ? 'connected' : 'disconnected',
  });

  const toggleRecord = (record: ConnectorRecord, connected: boolean) => {
    if (record.id === 'chrome') {
      if (connected && chromeServer) {
        void connections.toggle(chromeServer);
        return;
      }
      void connections.connectChrome();
      return;
    }
    if (record.id === 'gmail') {
      if (connected && gmailServer) {
        void connections.toggle(gmailServer);
        return;
      }
      onOpenAdvanced();
      return;
    }
    setStored(setConnectorStatus(record.id, connected ? 'disconnected' : 'connected'));
  };

  return (
    <div>
      <h1 className={styles.pageTitle}>{t('common.jr.look.connectorsTitle')}</h1>
      <p className={styles.muted}>{t('common.jr.look.connectorsIntro')}</p>
      <p className={styles.muted}>{t('common.jr.look.mockNote')}</p>
      {connections.actionError && <Alert type='error' content={t(`common.jr.mcp.${connections.actionError}`)} />}
      <ul className={styles.connectorList}>
        {records.map((record) => {
          const mark = MARK[record.id];
          const connected = record.status === 'connected';
          const busy =
            (record.id === 'chrome' &&
              (connections.pending === 'chrome' || connections.pending === chromeServer?.id)) ||
            (record.id === 'gmail' && connections.pending === gmailServer?.id);
          return (
            <li key={record.id} className={styles.connectorRow}>
              <span className={styles.connectorMark} style={{ background: mark.background, color: mark.color }}>
                {mark.letter}
              </span>
              <div className={styles.rowCopy}>
                <strong>{t(connectorName(record.id))}</strong>
                <p className={styles.muted}>{t(connectorDescription(record.id))}</p>
                <span className={styles.muted}>
                  {connected ? t('common.jr.look.connected') : t('common.jr.look.disconnected')}
                </span>
              </div>
              <Button
                type={connected ? 'outline' : 'primary'}
                loading={busy}
                disabled={busy}
                onClick={() => toggleRecord(record, connected)}
              >
                {connected ? t('common.jr.look.disconnect') : t('common.jr.look.connect')}
              </Button>
            </li>
          );
        })}
      </ul>
      <Button type='outline' onClick={onOpenAdvanced}>
        {t('common.jr.look.advancedConnections')}
      </Button>
    </div>
  );
};

export default LiveConnectors;
