import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  start: vi.fn(),
  theme: vi.fn(),
  logout: vi.fn(),
  search: vi.fn(),
  refresh: vi.fn(),
  user: { name: 'Funcionário JR', role: 'admin' },
  bot: { id: 'bot-1', name: 'Compras', workspace: '/tmp/compras', appearance: { shape: 'cloud', color: 'red' } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/guid', search: '?bot=bot-1' }),
  useSearchParams: () => [new URLSearchParams('bot=bot-1'), vi.fn()],
}));
vi.mock('swr', () => ({
  default: (key: string | string[]) => ({
    data: Array.isArray(key) ? mocks.bot : key === 'jr.bots' ? [mocks.bot] : { items: [] },
    mutate: mocks.refresh,
  }),
  mutate: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { listChanged: { on: () => () => {} } } },
}));
vi.mock('@/renderer/pages/Jr/jrBots', () => ({
  listJrBots: vi.fn(),
  getJrBot: vi.fn(),
  deleteJrBot: vi.fn(),
  startJrConversation: mocks.start,
}));
vi.mock('@/renderer/pages/Jr/JrBotDialog', () => ({ default: () => null }));
vi.mock('@/renderer/pages/Jr/Connections', () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <section role='dialog' aria-label='common.jr.mcp.title'>
      <button onClick={onClose}>common.close</button>
    </section>
  ),
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', setTheme: mocks.theme }),
}));
vi.mock('@/renderer/pages/Jr/Access/context', () => ({
  useJrAccess: () => ({ state: { status: 'active', user: mocks.user }, logout: mocks.logout }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({
  default: ({
    renderTrigger,
  }: {
    renderTrigger: (props: { onClick: () => void; isActive: boolean }) => React.ReactNode;
  }) => renderTrigger({ onClick: mocks.search, isActive: false }),
}));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() } }));

import JrWorkspace from '@/renderer/pages/Jr';
import JrSidebar from '@/renderer/pages/Jr/JrSidebar';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
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

it('loads bot details before opening its conversation from a summary in the sidebar', () => {
  render(<JrSidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'Compras' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/guid?bot=bot-1');
  expect(mocks.start).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('common.jr.recentChats')).not.toBeInTheDocument();
});

it('shows a localized retry when the bot conversation cannot be opened', async () => {
  mocks.start.mockRejectedValueOnce(new Error('offline'));
  render(<JrWorkspace />);
  expect(await screen.findByText('common.jr.connectionError')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.retry' }));
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith('/conversation/conversation-1?bot=bot-1', { replace: true })
  );
});

it('keeps search and new bot controls first, with real search and creation actions', () => {
  render(<JrSidebar />);
  const buttons = screen.getAllByRole('button');
  expect(buttons.slice(0, 2).map((button) => button.getAttribute('aria-label'))).toEqual([
    'common.jr.search',
    'common.jr.newBot',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.search' }));
  expect(mocks.search).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.newBot' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/guid?create=1');
});

it('keeps theme, administration, usage and logout available in the profile menu', async () => {
  render(<JrSidebar />);
  expect(screen.queryByText('common.jr.usage')).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Funcionário JR/ })));
  expect(await screen.findByText('common.jr.access.adminTitle')).toBeInTheDocument();
  expect(screen.getByText('common.jr.access.exit')).toBeInTheDocument();
  fireEvent.click(await screen.findByText('common.jr.darkMode'));
  expect(mocks.theme).toHaveBeenCalledWith('dark');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Funcionário JR/ })));
  fireEvent.click(await screen.findByText('common.jr.usage'));
  expect(mocks.navigate).toHaveBeenCalledWith('/usage');
});

it('opens and closes connections over the current chat without navigation', async () => {
  render(
    <>
      <JrSidebar />
      <main data-testid='current-chat'>Mensagem atual</main>
    </>
  );
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.title' }));
  expect(await screen.findByRole('dialog', { name: 'common.jr.mcp.title' })).toBeInTheDocument();
  expect(screen.getByTestId('current-chat')).toHaveTextContent('Mensagem atual');
  expect(mocks.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByTestId('current-chat')).toBeInTheDocument();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
