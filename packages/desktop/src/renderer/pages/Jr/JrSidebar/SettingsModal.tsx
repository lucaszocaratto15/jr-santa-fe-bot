import { Button } from '@arco-design/web-react';
import { Brain, ChartHistogram, Close, Computer, Download, ListCheckbox, Lock, SettingTwo } from '@icon-park/react';
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { isMacOS } from '@/renderer/utils/platform';
import { ComputerPanel, GeneralPanel, UpdatesPanel } from './panels';
import LearnPanel from './Learn/LearnPanel';
import TasksPanel from './Teach/TasksPanel';
import UsagePanel from './Usage/UsagePanel';
import VaultPanel from './Teach/VaultPanel';
import styles from './JrSidebar.module.css';

export const SETTINGS_TABS = ['general', 'computer', 'usage', 'vault', 'tasks', 'learn', 'updates'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABEL = {
  general: 'common.jr.look.tabs.general',
  computer: 'common.jr.look.tabs.computer',
  usage: 'common.jr.look.tabs.usage',
  vault: 'common.jr.look.tabs.vault',
  tasks: 'common.jr.look.tabs.tasks',
  learn: 'common.jr.look.tabs.learn',
  updates: 'common.jr.look.tabs.updates',
} as const;

const tabIcon = (id: SettingsTab) => {
  if (id === 'computer') return <Computer size={20} />;
  if (id === 'usage') return <ChartHistogram size={20} />;
  if (id === 'vault') return <Lock size={20} />;
  if (id === 'tasks') return <ListCheckbox size={20} />;
  if (id === 'learn') return <Brain size={20} />;
  if (id === 'updates') return <Download size={20} />;
  return <SettingTwo size={20} />;
};

const JrSettingsModal: React.FC<{
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  /** Learn tab opened by the reconsent prompt: open the term modal right away. */
  autoConsent?: boolean;
}> = ({ tab, onTab, onClose, autoConsent }) => {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dismissBackdrop = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    onClose();
  };

  return createPortal(
    <div className={isMacOS() ? `${styles.overlay} ${styles.overlayMac}` : styles.overlay} onClick={dismissBackdrop}>
      <div className={styles.windowDrag} aria-hidden='true' />
      <div
        className={styles.panel}
        role='dialog'
        aria-modal='true'
        aria-label={t('common.jr.look.settingsNav')}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type='text'
          shape='circle'
          className={styles.close}
          aria-label={t('common.jr.look.closeSettings')}
          icon={<Close size={18} />}
          onMouseDown={(event) => event.stopPropagation()}
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
              {tabIcon(id)}
              <span className={styles.tabLabel}>{t(TAB_LABEL[id])}</span>
            </Button>
          ))}
        </nav>
        <div className={styles.content}>
          {tab === 'general' && <GeneralPanel />}
          {tab === 'computer' && <ComputerPanel />}
          {tab === 'usage' && <UsagePanel />}
          {tab === 'vault' && <VaultPanel />}
          {tab === 'tasks' && <TasksPanel onClose={onClose} />}
          {tab === 'learn' && <LearnPanel autoConsent={autoConsent} onTeach={() => {}} />}
          {tab === 'updates' && <UpdatesPanel />}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default JrSettingsModal;
