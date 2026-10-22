import { Button, Spin } from '@arco-design/web-react';
import { Down, LinkOne, Plus, Right, Search } from '@icon-park/react';
import React, { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import ConversationSearchPopover from '@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';
import { listJrBots, type JrBot } from '../jrBots';
import JrCharacter from '../JrCharacter';
import { useJrAccess } from '../Access/context';
import { groupBots, UNSECTIONED_ID } from './groupBots';
import JrSettingsModal, { type SettingsTab } from './SettingsModal';
import styles from './JrSidebar.module.css';

const JrConnections = lazy(() => import('../Connections'));

const JrSidebar: React.FC<{ onSessionClick?: () => void; collapsed?: boolean }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { state } = useJrAccess();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const { data: bots, error } = useSWR('jr.bots', listJrBots);
  const grouped = useMemo(() => groupBots(bots ?? []), [bots]);
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
        {!error && !bots?.length && <span className={styles.hint}>{t('common.jr.noBots')}</span>}
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
    </nav>
  );
};

export default JrSidebar;
