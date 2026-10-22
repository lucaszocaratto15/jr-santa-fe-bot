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
import { readUsageConsumption, usageMeterFromSnapshot } from './usageMeter';
import styles from './JrSidebar.module.css';

declare const __APP_VERSION__: string;

const isConnectionStatus = (value: unknown): value is JrConnectionStatus =>
  Boolean(value) && typeof value === 'object' && value !== null && 'connected' in value;

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
  const consumption = readUsageConsumption(status?.usage);
  const number = new Intl.NumberFormat(i18n?.language);
  const totalTokens =
    meter.inputTokens == null && meter.outputTokens == null
      ? null
      : (meter.inputTokens ?? 0) + (meter.outputTokens ?? 0);

  const consumptionCard = (id: string, title: string, value: number | null) => (
    <section key={id} className={`${styles.card} ${styles.quotaCard}`} aria-labelledby={id}>
      <h2 id={id} className={styles.cardTitle}>
        {title}
      </h2>
      <p className={styles.meterLine}>
        <strong className={styles.meterValue}>
          {value == null ? t('common.jr.access.unreported') : number.format(value)}
        </strong>
        <span>{t('common.jr.look.tokensLabel')}</span>
      </p>
    </section>
  );

  return (
    <div>
      <h1 className={styles.pageTitle}>{t('common.jr.look.usageTitle')}</h1>
      {isLoading ? (
        <Spin aria-label={t('common.loading')} />
      ) : (
        <>
          {error || (status && !status.connected) ? (
            <div className={styles.stack}>
              <Alert type='warning' content={t('common.jr.connectionError')} />
              <Button onClick={() => void mutate()}>{t('common.jr.retry')}</Button>
            </div>
          ) : null}
          <div className={styles.quotaGrid}>
            {consumptionCard('jr-used-5h', t('common.jr.look.usedLast5h'), consumption.last5h)}
            {consumptionCard('jr-used-week', t('common.jr.look.usedThisWeek'), consumption.thisWeek)}
            {consumptionCard('jr-used-total', t('common.jr.look.usedTotal'), consumption.total)}
          </div>
          <p className={styles.muted}>{t('common.jr.look.usageReportedOnly')}</p>
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
                  <span>
                    {totalTokens == null ? t('common.jr.look.requestsLabel') : t('common.jr.look.tokensLabel')}
                  </span>
                </p>
                <p className={styles.muted}>
                  {t('common.jr.look.inputShare', { percent: meter.inputSharePercent ?? 0 })}
                  {' · '}
                  {t('common.jr.look.outputShare', {
                    percent: meter.inputSharePercent == null ? 0 : 100 - meter.inputSharePercent,
                  })}
                  {' · '}
                  {t('common.jr.look.requestsLabel')}: {number.format(meter.requests)}
                </p>
                {meter.startedAt && (
                  <p className={styles.muted}>
                    {t('common.jr.usageSince', { date: new Date(meter.startedAt).toLocaleString(i18n?.language) })}
                  </p>
                )}
              </>
            )}
          </section>
        </>
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
