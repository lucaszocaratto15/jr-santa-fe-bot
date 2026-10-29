import { Button, Message } from '@arco-design/web-react';
import {
  BookOpen,
  Brain,
  ChartHistogram,
  Close,
  Computer,
  Download,
  ListCheckbox,
  Lock,
  SettingTwo,
} from '@icon-park/react';
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import type { LearnSuggestion } from '@/common/types/agent/learnTypes';
import { JR_BOTS_KEY } from '@renderer/pages/Jr/index';
import { listJrBots, startJrConversation } from '@renderer/pages/Jr/jrBots';
import { queueConversationIntent } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';
import { isMacOS } from '@/renderer/utils/platform';
import { ComputerPanel, GeneralPanel, UpdatesPanel } from './panels';
import LearnPanel from './Learn/LearnPanel';
import HandbookPanel from './Teach/HandbookPanel';
import TasksPanel from './Teach/TasksPanel';
import { pickRunBot } from './Teach/taskActions';
import UsagePanel from './Usage/UsagePanel';
import VaultPanel from './Teach/VaultPanel';
import styles from './JrSidebar.module.css';

export const SETTINGS_TABS = [
  'general',
  'computer',
  'usage',
  'vault',
  'tasks',
  'learn',
  'handbook',
  'updates',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABEL = {
  general: 'common.jr.look.tabs.general',
  computer: 'common.jr.look.tabs.computer',
  usage: 'common.jr.look.tabs.usage',
  vault: 'common.jr.look.tabs.vault',
  tasks: 'common.jr.look.tabs.tasks',
  learn: 'common.jr.look.tabs.learn',
  handbook: 'common.jr.look.tabs.handbook',
  updates: 'common.jr.look.tabs.updates',
} as const;

const tabIcon = (id: SettingsTab) => {
  if (id === 'computer') return <Computer size={20} />;
  if (id === 'usage') return <ChartHistogram size={20} />;
  if (id === 'vault') return <Lock size={20} />;
  if (id === 'tasks') return <ListCheckbox size={20} />;
  if (id === 'learn') return <Brain size={20} />;
  if (id === 'handbook') return <BookOpen size={20} />;
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
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const bots = useSWR(tab === 'learn' ? JR_BOTS_KEY : null, listJrBots);

  /** "Ensinar esta tarefa": a new conversation of the active bot, browser on the url, Ensinar prefilled. */
  const teachSuggestion = async (suggestion: LearnSuggestion) => {
    if (!suggestion.teach) return;
    const bot = pickRunBot(bots.data ?? (await listJrBots()), params.get('bot'));
    if (!bot) {
      Message.warning(t('common.jr.teach.tasks.noBot'));
      return;
    }
    onClose();
    try {
      const conversation = await startJrConversation(bot, { newConversation: true });
      queueConversationIntent(conversation.id, {
        openBrowser: true,
        url: suggestion.teach.url,
        describe: suggestion.teach.description,
      });
      void navigate(`/conversation/${conversation.id}?bot=${encodeURIComponent(bot.id)}`);
    } catch {
      Message.error(t('common.jr.teach.tasks.runFailed'));
    }
  };

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
          {tab === 'learn' && (
            <LearnPanel autoConsent={autoConsent} onTeach={(suggestion) => void teachSuggestion(suggestion)} />
          )}
          {tab === 'handbook' && <HandbookPanel />}
          {tab === 'updates' && <UpdatesPanel />}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default JrSettingsModal;
