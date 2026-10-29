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

const {
  listAvailableSkills,
  deleteSkill,
  listJrBots,
  startJrConversation,
  navigate,
  readTask,
  listJobs,
  removeJob,
  providersForNewConversation,
  calls,
} = vi.hoisted(() => ({
  calls: [] as string[],
  listJobs: vi.fn(),
  removeJob: vi.fn(),
  providersForNewConversation: vi.fn(),
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
    cron: {
      listJobs: { invoke: listJobs },
      removeJob: { invoke: removeJob },
      onJobCreated: { on: () => () => {} },
      onJobUpdated: { on: () => () => {} },
      onJobRemoved: { on: () => () => {} },
    },
  },
}));

vi.mock('@renderer/pages/Jr/index', () => ({ JR_BOTS_KEY: 'jr.bots' }));
vi.mock('@renderer/pages/Jr/jrBots', () => ({
  listJrBots,
  startJrConversation,
  providersForNewConversation,
  selectJrModel: (providers: Array<{ id: string }> | undefined) =>
    providers?.[0] ? { ...providers[0], use_model: 'MiniMax-M3.1-Flash' } : null,
}));

type DialogProps = {
  visible: boolean;
  editJob?: { id: string };
  prefill?: {
    name: string;
    prompt: string;
    assistantId: string;
    frequency: string;
    time: string;
    model: { providerId: string; modelId: string };
    resolveConversation: () => Promise<{ id: string; title: string }>;
  };
};
const { dialogProps } = vi.hoisted(() => ({ dialogProps: [] as DialogProps[] }));
vi.mock('@renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog', () => ({
  __esModule: true,
  default: (props: DialogProps) => {
    dialogProps.push(props);
    return props.visible ? (
      <div data-testid='cron-dialog'>{props.editJob ? `edit:${props.editJob.id}` : `new:${props.prefill?.name}`}</div>
    ) : null;
  },
}));

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
    listJobs.mockResolvedValue([]);
    dialogProps.length = 0;
    calls.length = 0;
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

  const taughtJob = (id: string, skillName: string) => ({
    id,
    name: 'NFs',
    schedule: { kind: 'cron', expr: '0 9 * * MON-FRI', description: 'Dias úteis às 09:00' },
    target: { execution_mode: 'existing', payload: { kind: 'message', text: `Execução agendada \`${skillName}\`` } },
    metadata: { conversation_id: 'c1' },
  });

  it('shows the schedule description of an existing job', async () => {
    listJobs.mockResolvedValue([taughtJob('j1', 'jr-tarefa-nfs')]);
    renderPanel();
    expect(await screen.findByText('Dias úteis às 09:00')).toBeInTheDocument();
  });

  it('Agendar opens the dialog in edit mode when the task already has a job', async () => {
    listJobs.mockResolvedValue([taughtJob('j1', 'jr-tarefa-nfs')]);
    renderPanel();
    await screen.findByText('Dias úteis às 09:00');
    fireEvent.click(screen.getByRole('button', { name: /common.jr.teach.tasks.schedule$/ }));
    expect(await screen.findByTestId('cron-dialog')).toHaveTextContent('edit:j1');
    expect(listJrBots).toHaveBeenCalledTimes(1);
  });

  it('Agendar prefills a new job for the bot open in the sidebar, weekdays at 09:00', async () => {
    listJrBots.mockResolvedValue([
      { id: 'b1', name: 'B1', instructions: 'x', workspace: '/w1' },
      { id: 'b2', name: 'B2', instructions: 'x', workspace: '/w2' },
    ]);
    providersForNewConversation.mockResolvedValue({ providers: [{ id: 'p1' }] });
    startJrConversation.mockResolvedValue({ id: 'c7', name: 'B2' });
    renderPanel();
    await screen.findByText('jr-tarefa-nfs');
    fireEvent.click(screen.getByRole('button', { name: /common.jr.teach.tasks.schedule$/ }));
    expect(await screen.findByTestId('cron-dialog')).toHaveTextContent('new:Baixa NFs');
    const prefill = dialogProps.at(-1)?.prefill;
    expect(prefill).toMatchObject({
      assistantId: 'b2',
      frequency: 'weekdays',
      time: '09:00',
      model: { providerId: 'p1', modelId: 'MiniMax-M3.1-Flash' },
    });
    expect(prefill?.prompt).toContain('common.jr.teach.tasks.scheduledPrompt|`jr-tarefa-nfs`');
    expect(startJrConversation).not.toHaveBeenCalled();
    expect(await prefill?.resolveConversation()).toEqual({ id: 'c7', title: 'B2' });
    expect(startJrConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'b2' }), { newConversation: true });
  });

  it('Agendar without the JR model shows scheduleFailed and opens no dialog', async () => {
    listJrBots.mockResolvedValue([{ id: 'b1', name: 'B1', instructions: 'x', workspace: '/w1' }]);
    providersForNewConversation.mockResolvedValue({ providers: [] });
    renderPanel();
    await screen.findByText('jr-tarefa-nfs');
    fireEvent.click(screen.getByRole('button', { name: /common.jr.teach.tasks.schedule$/ }));
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('common.jr.teach.tasks.scheduleFailed'));
    expect(screen.queryByTestId('cron-dialog')).not.toBeInTheDocument();
  });

  const openDelete = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.teach.tasks.more' }));
    fireEvent.click(await screen.findByText('common.jr.teach.tasks.delete'));
  };

  it('Excluir removes the task jobs before deleting the skill', async () => {
    listJobs.mockResolvedValue([
      taughtJob('j1', 'jr-tarefa-nfs'),
      taughtJob('j2', 'jr-tarefa-nfs'),
      taughtJob('j3', 'jr-tarefa-outra'),
    ]);
    removeJob.mockImplementation(async ({ job_id }: { job_id: string }) => {
      calls.push(`removeJob:${job_id}`);
    });
    deleteSkill.mockImplementation(async () => {
      calls.push('deleteSkill');
    });
    renderPanel();
    await screen.findByText('Dias úteis às 09:00');
    await openDelete();
    expect(await screen.findByText('common.jr.teach.tasks.deleteConfirmScheduled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.teach.tasks.delete' }));
    await waitFor(() => expect(calls).toEqual(['removeJob:j1', 'removeJob:j2', 'deleteSkill']));
  });

  it('Excluir keeps the skill when removing a job fails', async () => {
    listJobs.mockResolvedValue([taughtJob('j1', 'jr-tarefa-nfs')]);
    removeJob.mockRejectedValue(new Error('offline'));
    renderPanel();
    await screen.findByText('Dias úteis às 09:00');
    await openDelete();
    fireEvent.click(await screen.findByRole('button', { name: 'common.jr.teach.tasks.delete' }));
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('common.jr.teach.tasks.deleteFailed'));
    expect(deleteSkill).not.toHaveBeenCalled();
  });

  it('Excluir without a schedule asks the plain confirmation', async () => {
    renderPanel();
    await screen.findByText('jr-tarefa-nfs');
    await waitFor(() => expect(listJobs).toHaveBeenCalled());
    await openDelete();
    expect(await screen.findByText('common.jr.teach.tasks.deleteConfirm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.teach.tasks.delete' }));
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith({ skill_name: 'jr-tarefa-nfs' }));
    expect(removeJob).not.toHaveBeenCalled();
  });
});
