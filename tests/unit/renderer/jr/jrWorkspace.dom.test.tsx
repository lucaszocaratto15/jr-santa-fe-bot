import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  start: vi.fn(),
  theme: vi.fn(),
  logout: vi.fn(),
  report: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
  search: vi.fn(),
  refresh: vi.fn(),
  route: '?bot=bot-1',
  noBots: false,
  user: { id: 'owner', name: 'Lucas', role: 'admin' as const },
  bot: { id: 'bot-1', name: 'Compras', workspace: '/tmp/compras', appearance: { shape: 'cloud', color: 'red' } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/guid', search: mocks.route }),
  useSearchParams: () => [new URLSearchParams(mocks.route), vi.fn()],
}));
vi.mock('swr', () => ({
  default: (key: string | string[] | null) => ({
    data:
      Array.isArray(key) && key[0] === 'jr.bots'
        ? mocks.noBots
          ? []
          : [mocks.bot]
        : Array.isArray(key)
          ? mocks.bot
          : { items: [] },
    mutate: mocks.refresh,
  }),
  mutate: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { listChanged: { on: () => () => {} }, artifactStream: { on: () => () => {} } },
    learn: { state: { invoke: async () => null }, stateChanged: { on: () => () => {} } },
    teach: { lessonsChanged: { on: () => () => {} } },
    jr: { routines: { deliver: { on: () => () => {} }, ack: { invoke: async () => undefined } } },
    cron: { runNow: { invoke: async () => undefined } },
  },
}));
vi.mock('@/renderer/pages/Jr/jrBots', () => ({
  listJrBots: vi.fn(),
  getJrBot: vi.fn(),
  deleteJrBot: vi.fn(),
  startJrConversation: mocks.start,
  reportJrOpenError: (error: unknown) => mocks.report(error),
}));
vi.mock('@/renderer/pages/Jr/JrBotDialog', () => ({
  default: ({ visible, bot }: { visible: boolean; bot?: { id: string } }) =>
    visible ? <section role='dialog' data-bot-id={bot?.id ?? ''} /> : null,
}));
vi.mock('@/renderer/pages/Jr/Connections', () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <section role='dialog' aria-label='common.jr.mcp.title'>
      <button onClick={onClose}>common.close</button>
    </section>
  ),
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', setTheme: mocks.theme, fontSizes: { chat: 14 }, setFontSize: vi.fn() }),
}));
vi.mock('@/renderer/pages/Jr/Access/context', () => ({
  useJrAccess: () => ({ state: { status: 'active', user: mocks.user }, logout: mocks.logout }),
}));
vi.mock('@renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'employee-1', username: 'func' } }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({
  default: ({
    renderTrigger,
  }: {
    renderTrigger: (props: { onClick: () => void; isActive: boolean }) => React.ReactNode;
  }) => renderTrigger({ onClick: mocks.search, isActive: false }),
}));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() }, useAddEventListener: () => {} }));

import JrWorkspace from '@/renderer/pages/Jr';
import JrSidebar from '@/renderer/pages/Jr/JrSidebar';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mocks.user = { id: 'owner', name: 'Lucas', role: 'admin' };
  mocks.route = '?bot=bot-1';
  mocks.noBots = false;
  mocks.start.mockResolvedValue({ id: 'conversation-1' });
});

it('opens the selected bot conversation directly without a second composer', async () => {
  render(<JrWorkspace />);
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith('/conversation/conversation-1?bot=bot-1', { replace: true })
  );
  expect(mocks.start).toHaveBeenCalledWith(mocks.bot);
  expect(screen.queryByLabelText('common.jr.taskTitle')).not.toBeInTheDocument();
});

it('opens a fresh conversation while staying inside the selected bot', async () => {
  mocks.route = '?bot=bot-1&new=1';
  render(<JrWorkspace />);
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith('/conversation/conversation-1?bot=bot-1', { replace: true })
  );
  expect(mocks.start).toHaveBeenCalledWith(mocks.bot, { newConversation: true });
});

it('loads bot details before opening its conversation from a summary in the sidebar', () => {
  render(<JrSidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'Compras' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/guid?bot=bot-1');
  expect(mocks.start).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('common.jr.recentChats')).not.toBeInTheDocument();
});

it('shows a localized retry and the underlying error when the bot conversation cannot be opened', async () => {
  mocks.start.mockRejectedValueOnce(new Error('TEAM_ASSISTANT_NOT_FOUND'));
  render(<JrWorkspace />);
  expect(await screen.findByText('common.jr.connectionError')).toBeInTheDocument();
  expect(screen.queryByText('TEAM_ASSISTANT_NOT_FOUND')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.errorDetail' }));
  expect(screen.getByText('TEAM_ASSISTANT_NOT_FOUND')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.retry' }));
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith('/conversation/conversation-1?bot=bot-1', { replace: true })
  );
});

it('keeps search and allows creating more bots', () => {
  render(<JrSidebar />);
  const buttons = screen.getAllByRole('button');
  expect(buttons[0].getAttribute('aria-label')).toBe('common.jr.search');
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.search' }));
  expect(mocks.search).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'common.jr.newBot' })).toBeInTheDocument();
});

it('opens creation from the main sidebar even when a bot exists', () => {
  render(<JrSidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.newBot' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/guid?create=1');
  expect(screen.queryByRole('button', { name: 'common.jr.firstBot' })).not.toBeInTheDocument();
});

it('offers creation on the main sidebar before the employee has a bot', () => {
  mocks.noBots = true;
  render(<JrSidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.newBot' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/guid?create=1');
  expect(screen.queryByRole('button', { name: 'common.jr.editBot' })).not.toBeInTheDocument();
});

async function openSettingsFromUserMenu(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Lucas/ }));
  });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'common.settings' }));
}

it('opens a user menu with settings and sign out, and signs out from the account card', async () => {
  render(<JrSidebar />);
  expect(screen.queryByRole('region', { name: 'common.jr.look.settingsNav' })).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Lucas/ })));
  expect(await screen.findByRole('menuitem', { name: 'common.settings' })).toBeInTheDocument();
  fireEvent.click(screen.getByText('common.jr.access.signOut'));
  expect(mocks.logout).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('region', { name: 'common.jr.look.settingsNav' })).not.toBeInTheDocument();

  mocks.logout.mockClear();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Lucas/ })));
  fireEvent.click(screen.getByRole('menuitem', { name: 'common.settings' }));
  expect(await screen.findByRole('region', { name: 'common.jr.look.settingsNav' })).toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: 'common.jr.look.settingsNav' })).getByRole('button', {
      name: 'common.jr.access.adminTitle',
    })
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.access.signOut' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.theme' }));
  fireEvent.click(await screen.findByText('common.jr.look.themeDark'));
  expect(mocks.theme).toHaveBeenCalledWith('dark');
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.tabs.usage' }));
  expect(await screen.findByRole('heading', { name: 'common.jr.look.usageTitle' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.tabs.general' }));
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.access.signOut' }));
  expect(mocks.logout).toHaveBeenCalledTimes(1);
});

it('closes settings from the close button', async () => {
  render(<JrSidebar />);
  await openSettingsFromUserMenu();
  expect(await screen.findByRole('region', { name: 'common.jr.look.settingsNav' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.closeSettings' }));
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'common.jr.look.settingsNav' })).not.toBeInTheDocument()
  );
});

it('keeps settings open when the dialog is clicked', async () => {
  render(<JrSidebar />);
  await openSettingsFromUserMenu();
  const dialog = await screen.findByRole('region', { name: 'common.jr.look.settingsNav' });
  fireEvent.click(dialog);
  expect(screen.getByRole('region', { name: 'common.jr.look.settingsNav' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.tabs.computer' }));
  expect(screen.getByRole('region', { name: 'common.jr.look.settingsNav' })).toBeInTheDocument();
});

it('keeps the current chat and its draft mounted while settings is open', async () => {
  render(
    <>
      <JrSidebar />
      <div id='jr-workspace-content'>
        <textarea aria-label='draft' defaultValue='Mensagem não enviada' />
      </div>
      <div id='jr-settings-host' />
    </>
  );
  const draft = screen.getByRole('textbox', { name: 'draft' });
  await openSettingsFromUserMenu();
  expect(document.getElementById('jr-workspace-content')?.inert).toBe(true);
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'common.jr.look.settingsNav' })).not.toBeInTheDocument()
  );
  expect(screen.getByRole('textbox', { name: 'draft' })).toBe(draft);
  expect(draft).toHaveValue('Mensagem não enviada');
});

it('keeps all settings sections reachable without changing the chat route', async () => {
  render(<JrSidebar />);
  await openSettingsFromUserMenu();
  expect(screen.queryByRole('button', { name: 'common.jr.look.tabs.connectors' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.tabs.computer' }));
  expect(screen.getByRole('button', { name: 'common.jr.look.execution' })).toBeInTheDocument();
  expect(screen.queryByText('common.jr.look.routeTraffic')).not.toBeInTheDocument();
});

it('shows plain usage figures without a fake ceiling or an unreported placeholder', async () => {
  render(<JrSidebar />);
  await openSettingsFromUserMenu();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.tabs.usage' }));
  expect(await screen.findByRole('heading', { name: 'common.jr.look.usageTitle' })).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByText('common.jr.access.unreported')).not.toBeInTheDocument();
});

it('shows the update status beside the check button', async () => {
  render(<JrSidebar />);
  await openSettingsFromUserMenu();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.look.tabs.updates' }));
  expect(await screen.findByText('common.jr.look.versionLabel')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.jr.look.checkUpdates' })).toBeEnabled());
});

it('opens and closes connections over the current chat without navigation', async () => {
  render(
    <>
      <JrSidebar />
      <main data-testid='current-chat'>Mensagem atual</main>
    </>
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Lucas/ }));
  });
  fireEvent.click(await screen.findByText('common.jr.mcp.title'));
  expect(await screen.findByRole('dialog', { name: 'common.jr.mcp.title' })).toBeInTheDocument();
  expect(screen.getByTestId('current-chat')).toHaveTextContent('Mensagem atual');
  expect(mocks.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByTestId('current-chat')).toBeInTheDocument();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('opens creation without reopening or editing the existing bot', async () => {
  mocks.route = '?bot=bot-1&create=1';
  render(<JrWorkspace />);
  expect(await screen.findByRole('dialog')).toHaveAttribute('data-bot-id', '');
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
