import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts ? `${key}|${Object.values(opts).join('|')}` : key),
  }),
}));

const { listAvailableSkills, deleteSkill, listJrBots, startJrConversation, navigate, readTask } = vi.hoisted(() => ({
  readTask: vi.fn(),
  listAvailableSkills: vi.fn(),
  deleteSkill: vi.fn(),
  listJrBots: vi.fn(),
  startJrConversation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      listAvailableSkills: { invoke: listAvailableSkills },
      deleteSkill: { invoke: deleteSkill },
    },
    teach: { readTask: { invoke: readTask }, saveTask: { invoke: vi.fn() } },
  },
}));

vi.mock('@renderer/pages/Jr/index', () => ({ JR_BOTS_KEY: 'jr.bots' }));
vi.mock('@renderer/pages/Jr/jrBots', () => ({ listJrBots, startJrConversation }));

import { Message } from '@arco-design/web-react';
import TasksPanel from '@renderer/pages/Jr/JrSidebar/Teach/TasksPanel';

const skill = (name: string, description = 'desc') => ({
  name,
  description,
  location: `/s/${name}`,
  is_auto_inject: false,
  is_custom: true,
  source: 'custom' as const,
});

const renderPanel = (onClose = vi.fn(), path = '/conversation/x?bot=b2') =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter initialEntries={[path]}>
        <TasksPanel onClose={onClose} />
      </MemoryRouter>
    </SWRConfig>
  );

describe('TasksPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    listAvailableSkills.mockResolvedValue([skill('jr-tarefa-nfs', 'Baixa NFs'), skill('outra-skill')]);
    listJrBots.mockResolvedValue([]);
  });

  it('lists only jr-tarefa-* skills', async () => {
    renderPanel();
    expect(await screen.findByText('jr-tarefa-nfs')).toBeInTheDocument();
    expect(screen.queryByText('outra-skill')).not.toBeInTheDocument();
  });

  it('Executar with no bots shows the noBot message and does not navigate', async () => {
    const onClose = vi.fn();
    renderPanel(onClose);
    await screen.findByText('jr-tarefa-nfs');
    await waitFor(() => expect(listJrBots).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /common.jr.teach.tasks.run$/ }));
    await waitFor(() => expect(Message.warning).toHaveBeenCalledWith('common.jr.teach.tasks.noBot'));
    expect(startJrConversation).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Executar closes the settings and starts the task on the bot open in the sidebar', async () => {
    listJrBots.mockResolvedValue([
      { id: 'b1', name: 'B1', instructions: 'x', workspace: '/w' },
      { id: 'b2', name: 'B2', instructions: 'x', workspace: '/w' },
    ]);
    startJrConversation.mockResolvedValue({ id: 'c9', name: 'B2' });
    const onClose = vi.fn();
    renderPanel(onClose);
    await screen.findByText('jr-tarefa-nfs');
    await waitFor(() => expect(listJrBots).toHaveBeenCalled());
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /common.jr.teach.tasks.run$/ }));
      expect(startJrConversation).toHaveBeenCalled();
    });
    expect(onClose).toHaveBeenCalled();
    expect(startJrConversation.mock.calls[0][0]).toMatchObject({ id: 'b2' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/conversation/c9?bot=b2'));
    expect(sessionStorage.getItem('aionrs_initial_message_c9')).toContain('`jr-tarefa-nfs`');
  });

  it('Executar shows runFailed when the conversation cannot be opened', async () => {
    listJrBots.mockResolvedValue([{ id: 'b1', name: 'B1', instructions: 'x', workspace: '/w' }]);
    startJrConversation.mockRejectedValue(new Error('offline'));
    renderPanel();
    await screen.findByText('jr-tarefa-nfs');
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /common.jr.teach.tasks.run$/ }));
      expect(startJrConversation).toHaveBeenCalled();
    });
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('common.jr.teach.tasks.runFailed'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Editar opens the edit modal for that task', async () => {
    readTask.mockResolvedValue({ name: 'jr-tarefa-nfs', description: 'Baixa NFs', body: '\n## Passos\n1. a\n' });
    renderPanel();
    await screen.findByText('jr-tarefa-nfs');
    fireEvent.click(screen.getByRole('button', { name: /common.jr.teach.tasks.edit$/ }));
    expect(await screen.findByText('common.jr.teach.tasks.editTitle')).toBeInTheDocument();
    expect(readTask).toHaveBeenCalledWith({ name: 'jr-tarefa-nfs' });
  });
});
