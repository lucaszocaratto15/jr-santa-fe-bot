import { Button } from '@arco-design/web-react';
import { ChartHistogram, Close, Computer, Download, LinkOne, SettingTwo } from '@icon-park/react';
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ComputerPanel, ConnectorsPanel, GeneralPanel, UpdatesPanel, UsagePanel } from './panels';
import styles from './JrSidebar.module.css';

export const SETTINGS_TABS = ['general', 'computer', 'usage', 'updates', 'connectors'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABEL = {
  general: 'common.jr.look.tabs.general',
  computer: 'common.jr.look.tabs.computer',
  usage: 'common.jr.look.tabs.usage',
  updates: 'common.jr.look.tabs.updates',
  connectors: 'common.jr.look.tabs.connectors',
} as const;

const JrSettingsModal: React.FC<{
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  onOpenAdvanced: () => void;
}> = ({ tab, onTab, onClose, onOpenAdvanced }) => {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const icon = (id: SettingsTab) => {
    if (id === 'computer') return <Computer size={20} />;
    if (id === 'usage') return <ChartHistogram size={20} />;
    if (id === 'updates') return <Download size={20} />;
    if (id === 'connectors') return <LinkOne size={20} />;
    return <SettingTwo size={20} />;
  };

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.panel}
        role='dialog'
        aria-modal='true'
        aria-label={t('common.jr.look.settingsNav')}
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type='text'
          shape='circle'
          className={styles.close}
          aria-label={t('common.jr.look.closeSettings')}
          icon={<Close size={18} />}
          onClick={onClose}
        />
        <nav className={styles.nav} aria-label={t('common.jr.look.settingsNav')}>
          {SETTINGS_TABS.map((id) => (
            <Button
              key={id}
              type='text'
              long
              className={`${styles.tab} ${tab === id ? styles.tabActive : ''}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => onTab(id)}
            >
              {icon(id)}
              <span>{t(TAB_LABEL[id])}</span>
            </Button>
          ))}
        </nav>
        <div className={styles.content}>
          {tab === 'general' && <GeneralPanel />}
          {tab === 'computer' && <ComputerPanel />}
          {tab === 'usage' && <UsagePanel />}
          {tab === 'updates' && <UpdatesPanel />}
          {tab === 'connectors' && <ConnectorsPanel onOpenAdvanced={onOpenAdvanced} />}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default JrSettingsModal;
