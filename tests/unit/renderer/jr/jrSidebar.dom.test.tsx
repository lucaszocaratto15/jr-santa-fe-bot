import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  messages: vi.fn(),
  search: '?bot=bot-1',
  bots: [] as Array<{
    id: string;
    name: string;
    workspace: string;
    conversationId?: string;
    appearance: { shape: string; color: string };
  }>,
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
  useJrAccess: () => ({ state: { status: 'active', user: { name: 'Funcionário JR' } }, logout: vi.fn() }),
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
  it('shows an unpinned bot as a large row with its latest message, and collapses other sections', async () => {
    render(<JrSidebar />);
    expect(await screen.findByText('Sent 1 archive')).toBeInTheDocument();
    const compras = screen.getByRole('button', { name: 'Compras' });
    expect(compras.querySelector('img')).toHaveAttribute('width', '48');
    expect(within(screen.getByLabelText('common.jr.look.pinnedBots')).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Vendas' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'vendas 1' })).toHaveAttribute('aria-expanded', 'false');
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

  it('persists an expanded section and shows the bots inside it', () => {
    render(<JrSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'vendas 1' }));
    expect(screen.getByRole('button', { name: 'Vendas' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('jr.sidebarLayout') ?? '{}').collapsed.vendas).toBe(false);
  });

  it('hides bots in a section the user collapsed', () => {
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

  it('still lists the bot when the saved layout is corrupt', () => {
    localStorage.setItem('jr.sidebarLayout', '{');
    render(<JrSidebar />);
    expect(screen.getByRole('button', { name: 'Compras' })).toBeInTheDocument();
  });
});
