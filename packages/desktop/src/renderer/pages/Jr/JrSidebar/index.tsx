import { ipcBridge } from '@/common';
import type { TTeam } from '@/common/types/team/teamTypes';
import { Button, Dropdown, Menu, Spin } from '@arco-design/web-react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LinkOne, Peoples, Plus, Search } from '@icon-park/react';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';
import React, { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import ConversationSearchPopover from '@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';
import { listJrBots, type JrBot } from '../jrBots';
import JrCharacter from '../JrCharacter';
import { useJrAccess } from '../Access/context';
import {
  applySidebarDrag,
  groupBots,
  isSectionExpanded,
  loadBotPreviews,
  PIN_ZONE_ID,
  pruneSidebarLayout,
  SECTION_PREFIX,
  setSectionCollapsed,
  teamChatsForBots,
  UNSECTIONED_ID,
  type SidebarLayout,
} from './groupBots';
import JrSettingsModal, { type SettingsTab } from './SettingsModal';
import { initialsFromName, sidebarProfile } from './sidebarProfile';
import { readSidebarLayout, writeSidebarLayout } from './preferences';
import styles from './JrSidebar.module.css';

const JrConnections = lazy(() => import('../Connections'));
const JrBotTeamDialog = lazy(() => import('../JrBotTeamDialog'));

const BotRow: React.FC<{
  bot: JrBot;
  preview: string;
  active: boolean;
  onOpen: () => void;
}> = ({ bot, preview, active, onOpen }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bot.id });
  return (
    <Button
      ref={setNodeRef}
      type='text'
      long
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.72 : undefined,
        touchAction: 'none',
      }}
      className={`${styles.botRow} ${styles.botCard} ${active ? styles.botActive : ''}`}
      aria-label={bot.name}
      onClick={onOpen}
    >
      <span className={styles.avatar}>
        <JrCharacter appearance={bot.appearance} size={48} />
      </span>
      <span className={styles.botCopy}>
        <span className={styles.botName}>{bot.name}</span>
        {preview ? (
          <span className={styles.preview} title={preview}>
            {preview}
          </span>
        ) : null}
      </span>
    </Button>
  );
};

const PinZone: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: PIN_ZONE_ID });
  const { active } = useDndContext();
  const empty = React.Children.count(children) === 0;
  return (
    <div
      ref={setNodeRef}
      className={`${styles.pinned} ${isOver ? styles.pinOver : ''}`}
      aria-label={t('common.jr.look.pinnedBots')}
    >
      {children}
      {active && empty ? <div className={styles.pinDrop} /> : null}
    </div>
  );
};

const JrSidebar: React.FC<{ onSessionClick?: () => void; collapsed?: boolean }> = ({ onSessionClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { state, logout } = useJrAccess();
  const { user } = useAuth();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [layout, setLayout] = useState<SidebarLayout>(readSidebarLayout);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setActionsSlot(document.getElementById('jr-sider-actions-slot'));
  }, []);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const { data: bots, error } = useSWR<JrBot[]>('jr.bots', listJrBots);
  const teamUserId = user?.id ?? 'system_default_user';
  const { data: teams, mutate: refreshTeams } = useSWR<TTeam[]>(['jr.teams', teamUserId], () =>
    ipcBridge.team.list.invoke({ user_id: teamUserId })
  );
  const botList = useMemo(() => (Array.isArray(bots) ? bots : []), [bots]);
  const grouped = useMemo(() => groupBots(botList, layout), [botList, layout]);
  const jrTeams = useMemo(() => {
    const rows = Array.isArray(teams) ? teams : [];
    return teamChatsForBots(rows, new Set(botList.map((bot) => bot.id)));
  }, [teams, botList]);
  const activeBot = new URLSearchParams(location.search).get('bot');
  const profile = sidebarProfile(state.user);
  const profileName = profile.name || t('common.jr.companyShortName');
  const initials = profile.name ? profile.initial : initialsFromName(profileName);
  const roleLabel =
    profile.role === 'admin'
      ? t('common.jr.access.roleAdmin')
      : profile.role === 'employee'
        ? t('common.jr.access.roleEmployee')
        : null;

  useEffect(() => {
    // SWR starts as undefined. Pruning that empty placeholder would wipe saved pins.
    if (!Array.isArray(bots)) return;
    setLayout((current) => {
      const next = pruneSidebarLayout(bots, current);
      if (next === current) return current;
      writeSidebarLayout(next);
      return next;
    });
  }, [bots]);

  useEffect(() => {
    if (!ipcBridge.database?.getConversationMessages) return undefined;
    let cancelled = false;
    void loadBotPreviews(botList, async (conversationId) => {
      const page = await loadLatestConversationMessages(conversationId, { limit: 30, contentMode: 'compact' });
      return page?.items ?? [];
    }).then((next) => {
      if (!cancelled) setPreviews(next);
    });
    return () => {
      cancelled = true;
    };
  }, [botList]);

  const open = (path: string) => {
    void navigate(path);
    onSessionClick?.();
  };

  const openBot = (bot: JrBot) => open(`/guid?bot=${encodeURIComponent(bot.id)}`);

  const sectionLabel = (label: string) => (label === UNSECTIONED_ID ? t('common.jr.look.unsectioned') : label);

  const onDragEnd = (event: DragEndEvent) => {
    const overId = event.over ? String(event.over.id) : '';
    setLayout((current) => {
      const next = applySidebarDrag(botList, current, String(event.active.id), overId);
      if (next === current) return current;
      writeSidebarLayout(next);
      return next;
    });
  };

  const sortableIds = [
    ...grouped.pinned.map((bot) => bot.id),
    ...grouped.loose.map((bot) => bot.id),
    ...grouped.sections.flatMap((section) =>
      isSectionExpanded(
        layout,
        section.id,
        section.bots.some((bot) => bot.id === activeBot)
      )
        ? section.bots.map((bot) => bot.id)
        : []
    ),
  ];

  const headerActions = (
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
  );

  return (
    <nav className={styles.sidebar} aria-label={t('common.jr.navigation')}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div className={styles.top}>
            {actionsSlot ? createPortal(headerActions, actionsSlot) : headerActions}
            <PinZone>
              {grouped.pinned.map((bot) => (
                <BotRow
                  key={bot.id}
                  bot={bot}
                  preview={previews[bot.id] ?? ''}
                  active={activeBot === bot.id}
                  onOpen={() => openBot(bot)}
                />
              ))}
            </PinZone>
          </div>
          <div className={styles.list}>
            {error && <span className={styles.hint}>{t('common.jr.loadError')}</span>}
            {!error && botList.length === 0 && <span className={styles.hint}>{t('common.jr.noBots')}</span>}
            {grouped.loose.map((bot) => (
              <BotRow
                key={bot.id}
                bot={bot}
                preview={previews[bot.id] ?? ''}
                active={activeBot === bot.id}
                onOpen={() => openBot(bot)}
              />
            ))}
            {grouped.sections.map((section) => {
              const expanded = isSectionExpanded(
                layout,
                section.id,
                section.bots.some((bot) => bot.id === activeBot)
              );
              const label = sectionLabel(section.label);
              return (
                <SectionBlock
                  key={section.id}
                  id={section.id}
                  label={label}
                  count={section.bots.length}
                  expanded={expanded}
                  onToggle={() => {
                    setLayout((current) => {
                      const next = setSectionCollapsed(current, section.id, expanded);
                      if (next === current) return current;
                      writeSidebarLayout(next);
                      return next;
                    });
                  }}
                >
                  {expanded
                    ? section.bots.map((bot) => (
                        <BotRow
                          key={bot.id}
                          bot={bot}
                          preview={previews[bot.id] ?? ''}
                          active={activeBot === bot.id}
                          onOpen={() => openBot(bot)}
                        />
                      ))
                    : null}
                </SectionBlock>
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
        </SortableContext>
      </DndContext>
      <div className={styles.bottom}>
        <Dropdown
          trigger='click'
          position='tl'
          droplist={
            <Menu
              onClickMenuItem={(key) => {
                if (key === 'settings') setSettingsTab('general');
                if (key === 'sign-out') void logout();
              }}
            >
              <Menu.Item key='settings'>{t('common.settings')}</Menu.Item>
              <Menu.Item key='sign-out'>{t('common.jr.access.signOut')}</Menu.Item>
            </Menu>
          }
        >
          <Button type='text' className={styles.profile} aria-haspopup='menu'>
            <span className={styles.profileIdentity}>
              <span className={styles.initials} aria-hidden='true'>
                {initials}
              </span>
              <span className={styles.profileText}>
                <span className={styles.profileName}>{profileName}</span>
                {roleLabel ? <span className={styles.profileRole}>{roleLabel}</span> : null}
              </span>
            </span>
          </Button>
        </Dropdown>
        <Button
          type='text'
          className={styles.iconButton}
          aria-label={t('common.jr.mcp.title')}
          icon={<LinkOne size={18} />}
          onClick={() => setConnectionsOpen(true)}
        />
      </div>
      {settingsTab && <JrSettingsModal tab={settingsTab} onTab={setSettingsTab} onClose={() => setSettingsTab(null)} />}
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

const SectionBlock: React.FC<{
  id: string;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ id, label, count, expanded, onToggle, children }) => {
  const { setNodeRef } = useDroppable({ id: `${SECTION_PREFIX}${id}` });
  return (
    <section>
      <div ref={setNodeRef}>
        <Button
          type='text'
          long
          className={styles.sectionToggle}
          aria-expanded={expanded}
          aria-label={`${label} ${count}`}
          onClick={onToggle}
        >
          <span>{label}</span>
          <span className={styles.sectionCount}>{count}</span>
        </Button>
      </div>
      {expanded ? children : null}
    </section>
  );
};

export default JrSidebar;
