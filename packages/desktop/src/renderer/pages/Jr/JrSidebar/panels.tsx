import { ipcBridge } from '@/common';
import type { JrConnectionStatus } from '@/common/config/clientSettings';
import { DARK_THEME_ID, LIGHT_THEME_ID, SYSTEM_THEME_ID } from '@/common/theme/constants';
import { JrLogo } from '@/renderer/pages/Jr/JrCharacter';
import { useJrAccess } from '@/renderer/pages/Jr/Access/context';
import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';
import {
  getIncludePrerelease,
  runUpdateCheck,
  type CheckUpdateOutcome,
} from '@/renderer/components/settings/checkForUpdatesShared';
import { Alert, Button, Dropdown, Menu, Select, Spin, Switch } from '@arco-design/web-react';
import { CheckOne, Down } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { readConnectorRecords, setConnectorStatus, type ConnectorId, type ConnectorRecord } from './connectors';
import {
  readComputerIdentity,
  readExecutionPreference,
  readRouteTraffic,
  readSpellcheck,
  writeExecutionPreference,
  writeRouteTraffic,
  writeSpellcheck,
  type ExecutionPreference,
} from './preferences';
import { usageMeterFromSnapshot } from './usageMeter';
import styles from './JrSidebar.module.css';

declare const __APP_VERSION__: string;

const MARK: Record<ConnectorId, { letter: string; background: string; color: string }> = {
  gmail: { letter: 'G', background: '#ffffff', color: '#c5221f' },
  chrome: { letter: 'C', background: '#ffffff', color: '#1a73e8' },
  calendar: { letter: 'A', background: '#90182c', color: '#ffffff' },
  files: { letter: 'F', background: '#3d5a80', color: '#ffffff' },
  whatsapp: { letter: 'W', background: '#1f7a4d', color: '#ffffff' },
};

const isConnectionStatus = (value: unknown): value is JrConnectionStatus =>
  Boolean(value) && typeof value === 'object' && value !== null && 'connected' in value;

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

export const GeneralPanel: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, logout } = useJrAccess();
  const { theme, setTheme, selectTheme, activeId } = useThemeContext();
  const [spellcheck, setSpellcheck] = useState(() => readSpellcheck());
  const themeValue =
    activeId === SYSTEM_THEME_ID || activeId === LIGHT_THEME_ID || activeId === DARK_THEME_ID
      ? activeId
      : theme === 'dark'
        ? DARK_THEME_ID
        : LIGHT_THEME_ID;
  const themeLabel =
    themeValue === SYSTEM_THEME_ID
      ? t('common.jr.look.themeSystem')
      : themeValue === DARK_THEME_ID
        ? t('common.jr.look.themeDark')
        : t('common.jr.look.themeLight');
  const profileName = state.user?.name || t('common.jr.companyShortName');
  const chooseTheme = (key: string) => {
    if (key === LIGHT_THEME_ID || key === DARK_THEME_ID) {
      void setTheme(key);
      return;
    }
    if (key === SYSTEM_THEME_ID && selectTheme) void selectTheme(SYSTEM_THEME_ID);
  };

  return (
    <div>
      <h1 className={styles.pageTitle}>{t('common.jr.look.generalTitle')}</h1>
      <section className={styles.card} aria-labelledby='jr-account-heading'>
        <h2 id='jr-account-heading' className={styles.cardTitle}>
          {t('common.jr.look.account')}
        </h2>
        <div className={styles.row}>
          <div>
            <strong>{profileName}</strong>
            <p className={styles.muted}>{t('common.jr.companyName')}</p>
          </div>
          <div className={styles.rowActions}>
            {state.user?.role === 'admin' && (
              <Button type='outline' onClick={() => void navigate('/admin')}>
                {t('common.jr.access.adminTitle')}
              </Button>
            )}
            {state.status === 'pilot' ? (
              <span className={styles.muted}>{t('common.jr.access.pilot')}</span>
            ) : (
              <Button type='outline' onClick={() => void logout()}>
                {t('common.jr.access.exit')}
              </Button>
            )}
          </div>
        </div>
      </section>
      <section className={styles.card} aria-labelledby='jr-appearance-heading'>
        <h2 id='jr-appearance-heading' className={styles.cardTitle}>
          {t('common.jr.look.appearance')}
        </h2>
        <div className={styles.row}>
          <span>{t('common.jr.look.theme')}</span>
          <Dropdown
            trigger='click'
            position='br'
            droplist={
              <Menu onClickMenuItem={chooseTheme}>
                <Menu.Item key={SYSTEM_THEME_ID}>{t('common.jr.look.themeSystem')}</Menu.Item>
                <Menu.Item key={LIGHT_THEME_ID}>{t('common.jr.look.themeLight')}</Menu.Item>
                <Menu.Item key={DARK_THEME_ID}>{t('common.jr.look.themeDark')}</Menu.Item>
              </Menu>
            }
          >
            <Button type='outline' aria-label={t('common.jr.look.theme')}>
              {themeLabel}
              <Down size={14} />
            </Button>
          </Dropdown>
        </div>
        <div className={styles.divider} />
        <div className={styles.row}>
          <span>{t('common.jr.look.accent')}</span>
          <span className={styles.accentValue}>
            <i className={styles.accentSwatch} aria-hidden='true' />
            {t('common.jr.look.accentBot')}
          </span>
        </div>
        <div className={styles.divider} />
        <div className={styles.row}>
          <span>{t('common.jr.look.language')}</span>
          <Select value='pt-BR' style={{ width: 200 }} triggerProps={{ autoAlignPopupWidth: false }}>
            <Select.Option value='pt-BR'>{t('common.jr.look.languagePt')}</Select.Option>
          </Select>
        </div>
        <div className={styles.divider} />
        <div className={styles.row}>
          <span>{t('common.jr.look.spellcheck')}</span>
          <Switch
            className={styles.accentSwitch}
            checked={spellcheck}
            aria-label={t('common.jr.look.spellcheck')}
            onChange={(checked) => {
              setSpellcheck(checked);
              writeSpellcheck(checked);
            }}
          />
        </div>
      </section>
    </div>
  );
};

export const ComputerPanel: React.FC = () => {
  const { t } = useTranslation();
  const identity = readComputerIdentity();
  const [execution, setExecution] = useState<ExecutionPreference>(() => readExecutionPreference());
  const [routeTraffic, setRouteTraffic] = useState(() => readRouteTraffic());
  const executionLabel = execution === 'ask' ? t('common.jr.look.askAlways') : t('common.jr.look.allowAlways');

  return (
    <div>
      <h1 className={styles.pageTitle}>{t('common.jr.look.computerTitle')}</h1>
      <div className={styles.identityRow}>
        <span className={styles.muted}>{t('common.jr.look.yourComputer')}</span>
        <strong>{identity.hostname || t('common.jr.look.computerMock')}</strong>
      </div>
      <section className={styles.card}>
        <div className={styles.row}>
          <div className={styles.rowCopy}>
            <h2 className={styles.cardTitle}>{t('common.jr.look.execution')}</h2>
            <p className={styles.muted}>{t('common.jr.look.executionHint')}</p>
          </div>
          <Dropdown
            trigger='click'
            position='br'
            droplist={
              <Menu
                onClickMenuItem={(key) => {
                  const next: ExecutionPreference = key === 'ask' ? 'ask' : 'allow';
                  setExecution(next);
                  writeExecutionPreference(next);
                }}
              >
                <Menu.Item key='allow'>{t('common.jr.look.allowAlways')}</Menu.Item>
                <Menu.Item key='ask'>{t('common.jr.look.askAlways')}</Menu.Item>
              </Menu>
            }
          >
            <Button type='outline' aria-label={t('common.jr.look.execution')}>
              {executionLabel}
              <Down size={14} />
            </Button>
          </Dropdown>
        </div>
        <div className={styles.divider} />
        <div className={styles.row}>
          <div className={styles.rowCopy}>
            <h2 className={styles.cardTitle}>{t('common.jr.look.routeTraffic')}</h2>
            <p className={styles.muted}>{t('common.jr.look.routeTrafficHint')}</p>
          </div>
          <Switch
            className={styles.accentSwitch}
            checked={routeTraffic}
            aria-label={t('common.jr.look.routeTraffic')}
            onChange={(checked) => {
              setRouteTraffic(checked);
              writeRouteTraffic(checked);
            }}
          />
        </div>
      </section>
      <h2 className={styles.sectionLabel}>{t('common.jr.look.botComputer')}</h2>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t('common.jr.look.updateBotComputer')}</h2>
        <p className={styles.muted}>{t('common.jr.look.updateBotComputerHint')}</p>
        <div className={styles.banner}>
          <CheckOne size={18} />
          <span>{t('common.jr.look.upToDateBanner')}</span>
        </div>
      </section>
    </div>
  );
};

export const UsagePanel: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { state } = useJrAccess();
  const { data, error, isLoading, mutate } = useSWR(
    ['jr.connection', state.user?.id ?? 'anon'],
    () => (state.status === 'pilot' ? ipcBridge.jr.status.invoke() : ipcBridge.jr.personalUsage.invoke()),
    { refreshInterval: 15000, shouldRetryOnError: false }
  );
  const status = isConnectionStatus(data) ? data : null;
  const meter = usageMeterFromSnapshot(status?.usage);
  const number = new Intl.NumberFormat(i18n?.language);
  const totalTokens =
    meter.inputTokens == null && meter.outputTokens == null
      ? null
      : (meter.inputTokens ?? 0) + (meter.outputTokens ?? 0);
  const share = meter.inputSharePercent;

  return (
    <div>
      <h1 className={styles.pageTitle}>{t('common.jr.look.usageTitle')}</h1>
      {isLoading ? (
        <Spin aria-label={t('common.loading')} />
      ) : error || (status && !status.connected) ? (
        <div className={styles.stack}>
          <Alert type='warning' content={t('common.jr.connectionError')} />
          <Button onClick={() => void mutate()}>{t('common.jr.retry')}</Button>
        </div>
      ) : (
        <section className={styles.card} aria-labelledby='jr-usage-heading'>
          <h2 id='jr-usage-heading' className={styles.cardTitle}>
            {t('common.jr.look.sessionUsage')}
          </h2>
          {totalTokens == null && meter.requests === 0 ? (
            <p className={styles.muted}>{t('common.jr.look.noUsage')}</p>
          ) : (
            <>
              <p className={styles.meterLine}>
                <strong className={styles.meterValue}>{number.format(totalTokens ?? meter.requests)}</strong>
                <span>{totalTokens == null ? t('common.jr.look.requestsLabel') : t('common.jr.look.tokensLabel')}</span>
              </p>
              <div
                className={styles.bar}
                role='progressbar'
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={share ?? 0}
                aria-label={t('common.jr.look.inputShare', { percent: share ?? 0 })}
              >
                <span style={{ width: `${share ?? 0}%` }} />
              </div>
              <p className={styles.muted}>
                {t('common.jr.look.inputShare', { percent: share ?? 0 })}
                {' · '}
                {t('common.jr.look.outputShare', { percent: share == null ? 0 : 100 - share })}
                {' · '}
                {t('common.jr.look.requestsLabel')}: {number.format(meter.requests)}
              </p>
              {meter.startedAt && (
                <p className={styles.muted}>
                  {t('common.jr.usageSince', { date: new Date(meter.startedAt).toLocaleString(i18n.language) })}
                </p>
              )}
            </>
          )}
          <p className={styles.muted}>{t('common.jr.look.usageCaption')}</p>
        </section>
      )}
    </div>
  );
};

export const UpdatesPanel: React.FC = () => {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<CheckUpdateOutcome | null>(null);
  const [phase, setPhase] = useState<'checking' | 'ready'>('checking');

  const check = () => {
    setPhase('checking');
    void runUpdateCheck({
      includePrerelease: getIncludePrerelease(),
      fallbackVersion: __APP_VERSION__,
      checkFailedLabel: t('update.checkFailed'),
    }).then((result) => {
      setOutcome(result);
      setPhase('ready');
    });
  };

  useEffect(() => {
    let cancelled = false;
    setPhase('checking');
    void runUpdateCheck({
      includePrerelease: getIncludePrerelease(),
      fallbackVersion: __APP_VERSION__,
      checkFailedLabel: t('update.checkFailed'),
    }).then((result) => {
      if (cancelled) return;
      setOutcome(result);
      setPhase('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const version = outcome && outcome.kind !== 'error' ? outcome.currentVersion : __APP_VERSION__;

  return (
    <div>
      <div className={styles.updatesBrand}>
        <JrLogo height={36} />
      </div>
      <h1 className={styles.pageTitle}>{t('common.jr.look.updatesTitle')}</h1>
      <section className={styles.card}>
        <p className={styles.muted}>{t('common.jr.look.versionLabel', { version })}</p>
        {phase === 'checking' ? (
          <p className={styles.muted}>{t('common.jr.look.checking')}</p>
        ) : outcome?.kind === 'error' ? (
          <Alert type='warning' content={outcome.message || t('update.checkFailed')} />
        ) : outcome?.kind === 'available' ? (
          <div className={styles.stack}>
            <Alert type='info' content={t('update.availableTitle')} />
            <Button
              type='primary'
              onClick={() => {
                window.dispatchEvent(new CustomEvent('aionui-open-update-modal', { detail: { source: 'settings' } }));
              }}
            >
              {t('update.downloadButton')}
            </Button>
          </div>
        ) : (
          <div className={styles.banner}>
            <CheckOne size={18} />
            <span>{t('update.upToDateTitle')}</span>
          </div>
        )}
        <Button type='outline' onClick={check} disabled={phase === 'checking'}>
          {t('common.jr.look.checkUpdates')}
        </Button>
      </section>
    </div>
  );
};

export const ConnectorsPanel: React.FC<{ onOpenAdvanced: () => void }> = ({ onOpenAdvanced }) => {
  const { t } = useTranslation();
  const [records, setRecords] = useState<ConnectorRecord[]>(() => readConnectorRecords());

  return (
    <div>
      <h1 className={styles.pageTitle}>{t('common.jr.look.connectorsTitle')}</h1>
      <p className={styles.muted}>{t('common.jr.look.connectorsIntro')}</p>
      <p className={styles.muted}>{t('common.jr.look.mockNote')}</p>
      <ul className={styles.connectorList}>
        {records.map((record) => {
          const mark = MARK[record.id];
          const connected = record.status === 'connected';
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
                onClick={() => {
                  const next = setConnectorStatus(record.id, connected ? 'disconnected' : 'connected');
                  setRecords(next);
                }}
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
