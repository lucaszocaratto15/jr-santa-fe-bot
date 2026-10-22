import { ipcBridge } from '@/common';
import { Button, Dropdown, Menu, Spin, Tooltip } from '@arco-design/web-react';
import { ChartHistogram, Message, Sun, Moon, LinkOne, Peoples, Logout, Search, Plus, Down } from '@icon-park/react';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import ConversationSearchPopover from '@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';
import { listJrBots } from './jrBots';
import JrCharacter from './JrCharacter';
import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';
import styles from './JrWorkspace.module.css';
import { useJrAccess } from './Access/context';

const JrConnections = lazy(() => import('./Connections'));

const JrSidebar: React.FC<{ onSessionClick?: () => void }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme } = useThemeContext();
  const { state, logout } = useJrAccess();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const { data: bots, error } = useSWR('jr.bots', listJrBots);
  const { data: recent, mutate: refreshRecent } = useSWR('jr.recent', () =>
    ipcBridge.database.getUserConversations.invoke({ limit: 12 })
  );
  useEffect(
    () =>
      ipcBridge.conversation.listChanged.on(() => {
        void refreshRecent();
      }),
    [refreshRecent]
  );
  const open = (path: string) => {
    void navigate(path);
    onSessionClick?.();
  };
  const activeBot = new URLSearchParams(location.search).get('bot');
  const profileName = state.user?.name || t('common.jr.companyShortName');
  const initials = profileName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  const profileMenu = (
    <Menu
      className={styles.profileMenu}
      onClickMenuItem={(key) => {
        if (key === 'theme') void setTheme(theme === 'dark' ? 'light' : 'dark');
        if (key === 'usage') open('/usage');
        if (key === 'admin') open('/admin');
        if (key === 'logout') void logout();
      }}
    >
      <Menu.Item key='theme'>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        {t(theme === 'dark' ? 'common.jr.lightMode' : 'common.jr.darkMode')}
      </Menu.Item>
      <Menu.Item key='usage'>
        <ChartHistogram size={16} />
        {t('common.jr.usage')}
      </Menu.Item>
      {state.user?.role === 'admin' && (
        <Menu.Item key='admin'>
          <Peoples size={16} />
          {t('common.jr.access.adminTitle')}
        </Menu.Item>
      )}
      {state.status === 'pilot' ? (
        <Menu.Item key='pilot' disabled>
          {t('common.jr.access.pilot')}
        </Menu.Item>
      ) : (
        <Menu.Item key='logout'>
          <Logout size={16} />
          {t('common.jr.access.exit')}
        </Menu.Item>
      )}
    </Menu>
  );

  return (
    <nav className={styles.sidebar} aria-label={t('common.jr.navigation')}>
      <div className={styles.sidebarTop}>
        <ConversationSearchPopover
          onSessionClick={onSessionClick}
          renderTrigger={({ onClick, isActive }) => (
            <Button
              type='text'
              shape='circle'
              className={`${styles.sidebarAction} ${isActive ? styles.active : ''}`}
              icon={<Search size={18} />}
              aria-label={t('common.jr.search')}
              title={t('common.jr.search')}
              onClick={onClick}
            />
          )}
        />
        <Tooltip content={t('common.jr.newBot')}>
          <Button
            type='text'
            shape='circle'
            className={styles.sidebarAction}
            aria-label={t('common.jr.newBot')}
            icon={<Plus size={18} />}
            onClick={() => open('/guid?create=1')}
          />
        </Tooltip>
      </div>
      <div className={styles.sidebarList}>
        <div className={styles.sidebarSection} aria-label={t('common.jr.myBots')}>
          {error && <span className={styles.hint}>{t('common.jr.loadError')}</span>}
          {!error && !bots?.length && <span className={styles.hint}>{t('common.jr.noBots')}</span>}
          {bots?.map((bot) => (
            <Button
              key={bot.id}
              type='text'
              long
              className={`${styles.navItem} ${styles.botItem} ${activeBot === bot.id ? styles.active : ''}`}
              icon={<JrCharacter appearance={bot.appearance} size={30} />}
              onClick={() => open(`/guid?bot=${encodeURIComponent(bot.id)}`)}
              title={bot.name}
            >
              {bot.name}
            </Button>
          ))}
        </div>
        {!!recent?.items.length && (
          <div className={styles.sidebarSection} aria-label={t('common.jr.recentChats')}>
            {recent.items
              .filter((item) => item.type === 'aionrs')
              .map((item) => (
                <Button
                  type='text'
                  key={item.id}
                  long
                  className={`${styles.navItem} ${location.pathname === `/conversation/${item.id}` ? styles.active : ''}`}
                  icon={<Message size={17} />}
                  onClick={() => open(`/conversation/${item.id}`)}
                  title={item.name}
                >
                  {item.name}
                </Button>
              ))}
          </div>
        )}
      </div>
      <div className={styles.sidebarBottom}>
        <Dropdown trigger='click' position='top' droplist={profileMenu}>
          <Button type='text' long className={styles.profileButton}>
            <span className={styles.profileAvatar} aria-hidden='true'>
              {initials}
            </span>
            <span className={styles.profileName}>{profileName}</span>
            <Down size={14} />
          </Button>
        </Dropdown>
        <Tooltip content={t('common.jr.mcp.title')}>
          <Button
            type='text'
            shape='circle'
            className={`${styles.sidebarAction} ${connectionsOpen || location.pathname === '/connections' ? styles.active : ''}`}
            aria-label={t('common.jr.mcp.title')}
            icon={<LinkOne size={18} />}
            onClick={() => setConnectionsOpen(true)}
          />
        </Tooltip>
      </div>
      {connectionsOpen && (
        <Suspense fallback={<Spin size={16} aria-label={t('common.loading')} />}>
          <JrConnections onClose={() => setConnectionsOpen(false)} />
        </Suspense>
      )}
    </nav>
  );
};
export default JrSidebar;
