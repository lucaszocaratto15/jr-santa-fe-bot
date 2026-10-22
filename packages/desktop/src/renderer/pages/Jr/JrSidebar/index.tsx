import { ipcBridge } from '@/common';
import type { TTeam } from '@/common/types/team/teamTypes';
import { Button, Spin } from '@arco-design/web-react';
import { Down, LinkOne, Peoples, Plus, Right, Search } from '@icon-park/react';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import React, { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import ConversationSearchPopover from '@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';
import { listJrBots, type JrBot } from '../jrBots';
import JrCharacter from '../JrCharacter';
import { useJrAccess } from '../Access/context';
import { groupBots, teamChatsForBots, UNSECTIONED_ID } from './groupBots';
import JrSettingsModal, { type SettingsTab } from './SettingsModal';
import styles from './JrSidebar.module.css';

const JrConnections = lazy(() => import('../Connections'));
const JrBotTeamDialog = lazy(() => import('../JrBotTeamDialog'));

const JrSidebar: React.FC<{ onSessionClick?: () => void; collapsed?: boolean }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { state } = useJrAccess();
  const { user } = useAuth();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const { data: bots, error } = useSWR<JrBot[]>('jr.bots', listJrBots);
  const teamUserId = user?.id ?? 'system_default_user';
  const { data: teams, mutate: refreshTeams } = useSWR<TTeam[]>(['jr.teams', teamUserId], () =>
    ipcBridge.team.list.invoke({ user_id: teamUserId })
  );
  const botList = useMemo(() => (Array.isArray(bots) ? bots : []), [bots]);
  const grouped = useMemo(() => groupBots(botList), [botList]);
  const jrTeams = useMemo(() => {
    const rows = Array.isArray(teams) ? teams : [];
    return teamChatsForBots(rows, new Set(botList.map((bot) => bot.id)));
  }, [teams, botList]);
  const activeBot = new URLSearchParams(location.search).get('bot');
  const profileName = state.user?.name || t('common.jr.companyShortName');
  const initials = profileName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  const open = (path: string) => {
    void navigate(path);
    onSessionClick?.();
  };

  const sectionLabel = (label: string) => (label === UNSECTIONED_ID ? t('common.jr.look.unsectioned') : label);

  return (
    <nav className={styles.sidebar} aria-label={t('common.jr.navigation')}>
      <div className={styles.top}>
        <div className={styles.actions}>
          <ConversationSearchPopover
            onSessionClick={onSessionClick}
            renderTrigger={({ onClick, isActive }) => (
              <Button
                type='text'
                className={`${styles.iconButton} ${isActive ? styles.pinActive : ''}`}
                icon={<Search size={18} />}
                aria-label={t('common.jr.search')}
                onClick={onClick}
              />
            )}
          />
          <Button
            type='text'
            className={styles.iconButton}
            aria-label={t('common.jr.newBot')}
            icon={<Plus size={18} />}
            onClick={() => open('/guid?create=1')}
          />
        </div>
        <div className={styles.pinned}>
          {grouped.pinned.map((bot) => (
            <Button
              key={bot.id}
              type='text'
              className={`${styles.pin} ${activeBot === bot.id ? styles.pinActive : ''}`}
              aria-label={bot.name}
              onClick={() => open(`/guid?bot=${encodeURIComponent(bot.id)}`)}
            >
              <span className={styles.avatar}>
                <JrCharacter appearance={bot.appearance} size={52} />
              </span>
              <span className={styles.pinName}>{bot.name}</span>
            </Button>
          ))}
        </div>
      </div>
      <div className={styles.list}>
        {error && <span className={styles.hint}>{t('common.jr.loadError')}</span>}
        {!error && botList.length === 0 && <span className={styles.hint}>{t('common.jr.noBots')}</span>}
        {grouped.sections.map((section, index) => {
          const expanded = openSections[section.id] ?? index === 0;
          const label = sectionLabel(section.label);
          return (
            <section key={section.id}>
              <Button
                type='text'
                long
                className={styles.sectionToggle}
                aria-expanded={expanded}
                onClick={() => setOpenSections((current) => ({ ...current, [section.id]: !expanded }))}
              >
                <span>
                  {expanded ? <Down size={14} /> : <Right size={14} />} {label}
                </span>
                <span className={styles.sectionCount}>{section.bots.length}</span>
              </Button>
              <div className={`${styles.sectionBody} ${expanded ? styles.sectionOpen : ''}`}>
                <div>
                  {section.bots.map((bot: JrBot) => (
                    <Button
                      key={bot.id}
                      type='text'
                      long
                      className={`${styles.botRow} ${activeBot === bot.id ? styles.botActive : ''}`}
                      onClick={() => open(`/guid?bot=${encodeURIComponent(bot.id)}`)}
                    >
                      <JrCharacter appearance={bot.appearance} size={28} />
                      <span className={styles.botName}>{bot.name}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
        {botList.length > 1 && (
          <section aria-label={t('common.jr.teamChats')}>
            <span className={styles.teamLabel}>{t('common.jr.teamChats')}</span>
            <Button type='text' long className={styles.botRow} onClick={() => setTeamDialogOpen(true)}>
              <Peoples size={18} />
              <span className={styles.botName}>{t('common.jr.teamChat')}</span>
            </Button>
            {jrTeams.map((team) => (
              <Button
                key={team.id}
                type='text'
                long
                className={`${styles.botRow} ${location.pathname === `/team/${team.id}` ? styles.botActive : ''}`}
                onClick={() => open(`/team/${team.id}`)}
                title={team.name}
              >
                <Peoples size={18} />
                <span className={styles.botName}>{team.name}</span>
              </Button>
            ))}
          </section>
        )}
      </div>
      <div className={styles.bottom}>
        <Button type='text' className={styles.profile} onClick={() => setSettingsTab('general')}>
          <span className={styles.initials} aria-hidden='true'>
            {initials}
          </span>
          <span className={styles.profileName}>{profileName}</span>
        </Button>
        <Button
          type='text'
          className={styles.iconButton}
          aria-label={t('common.jr.mcp.title')}
          icon={<LinkOne size={18} />}
          onClick={() => setConnectionsOpen(true)}
        />
      </div>
      {settingsTab && (
        <JrSettingsModal
          tab={settingsTab}
          onTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
          onOpenAdvanced={() => {
            setSettingsTab(null);
            setConnectionsOpen(true);
          }}
        />
      )}
      {connectionsOpen && (
        <Suspense fallback={<Spin size={16} aria-label={t('common.loading')} />}>
          <JrConnections onClose={() => setConnectionsOpen(false)} />
        </Suspense>
      )}
      {teamDialogOpen && (
        <Suspense fallback={null}>
          <JrBotTeamDialog
            visible
            bots={botList}
            onClose={() => setTeamDialogOpen(false)}
            onCreated={(team) => {
              void refreshTeams();
              open(`/team/${team.id}`);
            }}
          />
        </Suspense>
      )}
    </nav>
  );
};

export default JrSidebar;
