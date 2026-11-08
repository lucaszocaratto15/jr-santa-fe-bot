import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { readTask, saveTask } = vi.hoisted(() => ({ readTask: vi.fn(), saveTask: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: { teach: { readTask: { invoke: readTask }, saveTask: { invoke: saveTask } } },
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { success: vi.fn(), error: vi.fn() } };
});

import { Message } from '@arco-design/web-react';
import EditTaskModal from '@renderer/pages/Jr/JrSidebar/Teach/EditTaskModal';

const BODY = '\n## Passos\n1. Abrir\n';

const saveButton = () => screen.getByRole('button', { name: 'common.save' });

describe('EditTaskModal', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    readTask.mockResolvedValue({ name: 'jr-tarefa-nfs', description: 'Baixa NFs', body: BODY });
    saveTask.mockResolvedValue(undefined);
  });

  it('loads description and body into the fields', async () => {
    render(<EditTaskModal name='jr-tarefa-nfs' onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByDisplayValue('Baixa NFs')).toBeInTheDocument();
    expect((screen.getByTestId('edit-task-body') as HTMLTextAreaElement).value).toBe(BODY);
    expect(readTask).toHaveBeenCalledWith({ name: 'jr-tarefa-nfs' });
  });

  it('renders nothing while name is null', () => {
    render(<EditTaskModal name={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(readTask).not.toHaveBeenCalled();
    expect(screen.queryByText('common.jr.teach.tasks.editTitle')).not.toBeInTheDocument();
  });

  it('save sends trimmed description and the body as typed', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<EditTaskModal name='jr-tarefa-nfs' onClose={onClose} onSaved={onSaved} />);
    const description = await screen.findByDisplayValue('Baixa NFs');
    fireEvent.change(description, { target: { value: '  X  ' } });
    fireEvent.change(screen.getByTestId('edit-task-body'), { target: { value: '\n## Passos\n1. Novo\n' } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveTask).toHaveBeenCalledWith({ name: 'jr-tarefa-nfs', description: 'X', body: '\n## Passos\n1. Novo\n' })
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(Message.success).toHaveBeenCalledWith('common.jr.teach.tasks.editSaved');
  });

  it('shows the mapped error for no_steps and keeps the modal open', async () => {
    saveTask.mockRejectedValue(new Error("Error invoking remote method 'teach:save-task': Error: no_steps"));
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<EditTaskModal name='jr-tarefa-nfs' onClose={onClose} onSaved={onSaved} />);
    await screen.findByDisplayValue('Baixa NFs');
    fireEvent.click(saveButton());
    expect(await screen.findByText('common.jr.teach.errors.no_steps')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows editFailed for an unknown save error', async () => {
    saveTask.mockRejectedValue(new Error('outside_dir'));
    render(<EditTaskModal name='jr-tarefa-nfs' onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByDisplayValue('Baixa NFs');
    fireEvent.click(saveButton());
    expect(await screen.findByText('common.jr.teach.tasks.editFailed')).toBeInTheDocument();
  });

  it('disables Salvar while the description is empty', async () => {
    render(<EditTaskModal name='jr-tarefa-nfs' onClose={vi.fn()} onSaved={vi.fn()} />);
    const description = await screen.findByDisplayValue('Baixa NFs');
    fireEvent.change(description, { target: { value: '   ' } });
    expect(saveButton()).toBeDisabled();
  });

  it('shows editFailed when readTask rejects and offers no Salvar', async () => {
    readTask.mockRejectedValue(new Error('not_found'));
    render(<EditTaskModal name='jr-tarefa-nfs' onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('common.jr.teach.tasks.editFailed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.save' })).not.toBeInTheDocument();
  });
});
