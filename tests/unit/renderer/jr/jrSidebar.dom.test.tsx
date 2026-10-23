import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  messages: vi.fn(),
  search: '?bot=bot-1',
  bots: [] as Array<{
    id: string;
    name: string;
    workspace: string;
    section?: string;
    conversationId?: string;
    appearance: { shape: string; color: string };
  }>,
  accessUser: { id: 'employee-1', name: 'Funcionário JR', role: 'employee' as 'admin' | 'employee' },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/guid', search: mocks.search }),
}));
vi.mock('swr', () => ({
  default: (key: string | string[]) => ({
    data: Array.isArray(key) ? [] : key === 'jr.bots' ? mocks.bots : undefined,
    mutate: vi.fn(),
  }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { listChanged: { on: () => () => {} } },
    team: { list: { invoke: vi.fn() } },
    database: { getConversationMessages: { invoke: mocks.messages } },
  },
}));
vi.mock('@/renderer/pages/Jr/jrBots', () => ({ listJrBots: vi.fn() }));
vi.mock('@/renderer/pages/Jr/Access/context', () => ({
  useJrAccess: () => ({ state: { status: 'active', user: mocks.accessUser }, logout: vi.fn() }),
}));
vi.mock('@renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'employee-1' } }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({
  default: ({
    renderTrigger,
  }: {
    renderTrigger: (props: { onClick: () => void; isActive: boolean }) => React.ReactNode;
  }) => renderTrigger({ onClick: vi.fn(), isActive: false }),
}));

import JrSidebar from '@/renderer/pages/Jr/JrSidebar';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.accessUser = { id: 'employee-1', name: 'Funcionário JR', role: 'employee' };
  mocks.search = '?bot=bot-1';
  mocks.bots = [
    {
      id: 'bot-1',
      name: 'Compras',
      workspace: '/tmp/compras',
      conversationId: 'c-1',
      appearance: { shape: 'cloud', color: 'red' },
    },
    {
      id: 'bot-2',
      name: 'Vendas',
      workspace: '/tmp/vendas',
      conversationId: 'c-2',
      appearance: { shape: 'clover', color: 'blue' },
    },
  ];
  mocks.messages.mockImplementation(async ({ conversation_id }: { conversation_id: string }) => ({
    items:
      conversation_id === 'c-1'
        ? [
            { type: 'text', content: { content: 'older' } },
            { type: 'text', content: { content: '  Sent 1 archive  ' } },
            { type: 'text', hidden: true, content: { content: 'hidden latest' } },
          ]
        : [{ type: 'text', content: { content: 'venda pronta' } }],
  }));
});

describe('JrSidebar rows', () => {
  it('shows each bot with its name and avatar instead of a workspace folder', async () => {
    mocks.bots[0] = {
      ...mocks.bots[0],
      workspace: '/Users/owner/Library/Application Support/JR Bot/jr-workspaces/aa67fc9c-923b-48d2-8c7a-7ec88aecdb11',
    };
    render(<JrSidebar />);
    expect(await screen.findByText('Sent 1 archive')).toBeInTheDocument();
    const compras = screen.getByRole('button', { name: 'Compras' });
    expect(compras.querySelector('img')).toHaveAttribute('width', '48');
    expect(screen.getByRole('button', { name: 'Vendas' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('common.jr.look.pinnedBots')).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'jr-workspaces 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'compras 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'vendas 1' })).not.toBeInTheDocument();
  });

  it('keeps saved pins above sections, in the saved order', () => {
    localStorage.setItem(
      'jr.sidebarLayout',
      JSON.stringify({ pinnedIds: ['bot-2', 'bot-1'], order: [], collapsed: {} })
    );
    render(<JrSidebar />);
    expect(
      within(screen.getByLabelText('common.jr.look.pinnedBots'))
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Vendas', 'Compras']);
    expect(screen.queryByRole('button', { name: 'vendas 1' })).not.toBeInTheDocument();
  });

  it('persists an expanded user section and shows the bots inside it', () => {
    mocks.bots = mocks.bots.map((bot) => (bot.id === 'bot-2' ? { ...bot, section: 'vendas' } : bot));
    render(<JrSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'vendas 1' }));
    expect(screen.getByRole('button', { name: 'Vendas' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('jr.sidebarLayout') ?? '{}').collapsed.vendas).toBe(false);
  });

  it('hides bots in a user section that was collapsed', () => {
    mocks.bots = mocks.bots.map((bot) => (bot.id === 'bot-1' ? { ...bot, section: 'compras' } : bot));
    localStorage.setItem(
      'jr.sidebarLayout',
      JSON.stringify({ pinnedIds: [], order: [], collapsed: { compras: true } })
    );
    render(<JrSidebar />);
    expect(screen.queryByRole('button', { name: 'Compras' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'compras 1' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('still lists the bot when the latest message cannot be read', async () => {
    mocks.messages.mockRejectedValue(new Error('offline'));
    render(<JrSidebar />);
    expect(screen.getByRole('button', { name: 'Compras' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.messages).toHaveBeenCalled());
    expect(screen.queryByText('Sent 1 archive')).not.toBeInTheDocument();
  });

  it('moves search and new chat into the header slot beside the logo', () => {
    const slot = document.createElement('div');
    slot.id = 'jr-sider-actions-slot';
    document.body.appendChild(slot);
    try {
      render(<JrSidebar />);
      expect(slot.querySelector('[aria-label="common.jr.search"]')).not.toBeNull();
      expect(slot.querySelector('[aria-label="common.jr.newBot"]')).not.toBeNull();
      expect(screen.getByRole('navigation').querySelector('[aria-label="common.jr.search"]')).toBeNull();
    } finally {
      slot.remove();
    }
  });

  it('keeps search in the sidebar when the header slot is missing', () => {
    render(<JrSidebar />);
    expect(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'common.jr.search' })
    ).toBeInTheDocument();
  });

  it('shows the employee name and initials instead of a role title', () => {
    mocks.accessUser = { id: 'emp-1', name: 'Ana Costa', role: 'employee' };
    render(<JrSidebar />);
    expect(screen.getByRole('button', { name: /Ana Costa/ })).toHaveTextContent('common.jr.access.roleEmployee');
    expect(screen.getByText('AC')).toBeInTheDocument();
  });

  it('hides the admin panel from an employee user menu', async () => {
    render(<JrSidebar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Funcionário JR/ }));
    });
    expect(await screen.findByText('common.settings')).toBeInTheDocument();
    expect(screen.queryByText('common.jr.access.adminTitle')).not.toBeInTheDocument();
  });

  it('opens the admin panel from the user menu after a restored admin session', async () => {
    mocks.accessUser = { id: 'owner', name: 'Lucas', role: 'admin' };
    render(<JrSidebar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Lucas/ }));
    });
    fireEvent.click(await screen.findByText('common.jr.access.adminTitle'));
    expect(mocks.navigate).toHaveBeenCalledWith('/admin');
  });

  it('shows the owner profile when the session name is the role word', () => {
    mocks.accessUser = { id: 'owner', name: 'Administrador', role: 'admin' };
    render(<JrSidebar />);
    const profile = screen.getByRole('button', { name: /Lucas Zocaratto/ });
    expect(profile).toHaveTextContent('common.jr.access.roleAdmin');
    expect(profile).not.toHaveTextContent('Administrador');
    expect(screen.getByText('LZ')).toBeInTheDocument();
  });

  it('still lists the bot when the saved layout is corrupt', () => {
    localStorage.setItem('jr.sidebarLayout', '{');
    render(<JrSidebar />);
    expect(screen.getByRole('button', { name: 'Compras' })).toBeInTheDocument();
  });
});
