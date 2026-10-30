import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import type { HandbookActivityBody, HandbookDraft, HandbookDraftsResult } from '@/common/types/agent/handbookTypes';
import { ptBR, withI18n } from '../learn/i18nTestUtils';
import { view } from './fixtures';

const { handbook, message } = vi.hoisted(() => {
  const fn = () => ({ invoke: vi.fn() });
  return {
    handbook: {
      mine: fn(),
      drafts: fn(),
      publish: fn(),
      hide: fn(),
      unhide: fn(),
      withdraw: fn(),
      media: fn(),
      draftShot: fn(),
      preview: fn(),
      adminRoles: fn(),
      adminRole: fn(),
      roles: fn(),
      role: fn(),
    },
    message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

vi.mock('@/common', () => ({ ipcBridge: { jr: { handbook } } }));
vi.mock('@renderer/components/Markdown/MermaidBlock', () => ({
  __esModule: true,
  default: ({ code }: { code: string }) => <pre data-testid='mermaid'>{code}</pre>,
}));
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: message };
});

import HandbookPanel from '@renderer/pages/Jr/JrSidebar/Teach/HandbookPanel';

const activity: HandbookActivityBody = {
  title: 'Lança a nota fiscal',
  description: 'Lança a nota fiscal',
  frequency: 'occasional',
  steps: [
    { text: 'Abrir o portal', shot: 1 },
    { text: 'Emitir', shot: 2 },
  ],
  confirmBefore: ['Valor'],
  skillName: 'jr-tarefa-lancar-nf',
};

const draft: HandbookDraft = {
  key: 'taught:jr-tarefa-lancar-nf',
  kind: 'activity',
  source: 'taught',
  body: activity,
  shots: [1, 2],
  hash: 'h',
  publishedItemId: 'item-1',
};

const entry = { key: draft.key, itemId: 'item-1', kind: 'activity' as const, title: 'Lança a nota fiscal', draft };

const result = (overrides: Partial<HandbookDraftsResult> = {}): HandbookDraftsResult => ({
  role: view.role,
  published: [entry],
  hidden: [],
  ...overrides,
});

const show = () =>
  render(
    withI18n(
      ptBR(),
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <HandbookPanel />
      </SWRConfig>
    )
  );

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
  handbook.drafts.invoke.mockResolvedValue(result());
  handbook.publish.invoke.mockResolvedValue(undefined);
  handbook.draftShot.invoke.mockImplementation(async ({ shot }: { shot: number }) => `data:image/jpeg;base64,${shot}`);
  handbook.preview.invoke.mockResolvedValue('flowchart TD');
  handbook.mine.invoke.mockResolvedValue(view);
  handbook.roles.invoke.mockResolvedValue([]);
});

describe('HandbookPanel', () => {
  it('lists the published items with the role and the visibility notice, no approval step', async () => {
    const { container } = show();
    expect(await screen.findByText('Cargo: Auxiliar de escritório')).toBeInTheDocument();
    expect(screen.getByText(/fica visível para o seu gestor/)).toBeInTheDocument();
    expect(await screen.findByTestId('published-item-1')).toHaveTextContent('Lança a nota fiscal');
    expect(container.textContent).not.toMatch(/Aprovar|Aguardando gestor|aprovação do gestor|pendente|Rascunho/i);
  });

  it('panel without a title shows the cargo-not-registered message and no Editar', async () => {
    handbook.drafts.invoke.mockResolvedValue(result({ role: null }));
    show();
    expect(
      await screen.findByText('Seu cargo não está cadastrado. Peça ao administrador para cadastrá-lo.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Editar')).not.toBeInTheDocument();
  });

  it('in pilot mode says it works only with the company server', async () => {
    handbook.drafts.invoke.mockRejectedValue(new Error('unavailable'));
    show();
    expect(await screen.findByText('Disponível só com o servidor da empresa.')).toBeInTheDocument();
  });

  it('Editar opens the item and Salvar alterações republishes it with the edit, without a confirmation', async () => {
    show();
    fireEvent.click(await screen.findByText('Editar'));
    fireEvent.click(await screen.findByText('Salvar alterações'));
    await waitFor(() => expect(handbook.publish.invoke).toHaveBeenCalledTimes(1));
    const call = handbook.publish.invoke.mock.calls[0][0];
    expect(call.key).toBe(draft.key);
    expect(call.keepShots).toEqual([1, 2]);
    expect(call.body.confirmBefore).toEqual(['Valor']);
    expect(message.success).toHaveBeenCalledWith('Alterações salvas');
  });

  it('removing a screenshot in the editor excludes it from keepShots', async () => {
    show();
    fireEvent.click(await screen.findByText('Editar'));
    fireEvent.click(await screen.findByTestId('remove-shot-1'));
    expect(screen.queryByTestId('remove-shot-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Salvar alterações'));
    await waitFor(() => expect(handbook.publish.invoke).toHaveBeenCalled());
    const call = handbook.publish.invoke.mock.calls[0][0];
    expect(call.keepShots).toEqual([2]);
    expect(call.body.steps[0]).toEqual({ text: 'Abrir o portal' });
  });

  it('a save refused for no_role shows the role message and keeps the editor open', async () => {
    handbook.publish.invoke.mockRejectedValue(
      new Error("Error invoking remote method 'jr-handbook-publish': Error: no_role")
    );
    show();
    fireEvent.click(await screen.findByText('Editar'));
    fireEvent.click(await screen.findByText('Salvar alterações'));
    expect(
      await screen.findByText('Seu cargo não está cadastrado. Peça ao administrador para cadastrá-lo.')
    ).toBeInTheDocument();
    expect(screen.getByText('Salvar alterações')).toBeInTheDocument();
  });

  it('an item whose source is gone has no Editar', async () => {
    handbook.drafts.invoke.mockResolvedValue(result({ published: [{ ...entry, draft: null }] }));
    show();
    await screen.findByTestId('published-item-1');
    expect(screen.queryByText('Editar')).not.toBeInTheDocument();
  });

  it('Ocultar hides the item after a confirmation and moves it to the hidden list; Mostrar de novo brings it back', async () => {
    handbook.hide.invoke.mockResolvedValue(undefined);
    handbook.unhide.invoke.mockResolvedValue(undefined);
    handbook.drafts.invoke.mockResolvedValueOnce(result());
    handbook.drafts.invoke.mockResolvedValueOnce(
      result({ published: [], hidden: [{ key: draft.key, kind: 'activity', title: 'Lança a nota fiscal' }] })
    );
    show();
    const row = await screen.findByTestId('published-item-1');
    fireEvent.click(within(row).getByText('Ocultar'));
    const popup = await screen.findByText(/Ocultar este item\?/);
    fireEvent.click(popup.closest('.arco-popconfirm')?.querySelector('.arco-btn-primary') as HTMLElement);
    await waitFor(() => expect(handbook.hide.invoke).toHaveBeenCalledWith({ key: draft.key }));
    const hiddenRow = await screen.findByTestId(`hidden-${draft.key}`);
    expect(screen.queryByTestId('published-item-1')).not.toBeInTheDocument();
    handbook.drafts.invoke.mockResolvedValue(result());
    fireEvent.click(within(hiddenRow).getByText('Mostrar de novo'));
    await waitFor(() => expect(handbook.unhide.invoke).toHaveBeenCalledWith({ key: draft.key }));
    await screen.findByTestId('published-item-1');
  });

  it('shows no hidden section when nothing is hidden', async () => {
    show();
    await screen.findByTestId('published-item-1');
    expect(screen.queryByText('Itens ocultos')).not.toBeInTheDocument();
  });

  it('lists other roles of the area and opens one without indicators when the server withheld them', async () => {
    handbook.roles.invoke.mockResolvedValue([
      { key: view.role!.key, title: view.role!.title, activities: 1, updatedAt: 1 },
      { key: 'frota', title: 'Frota', activities: 2, updatedAt: 1 },
    ]);
    handbook.role.invoke.mockResolvedValue({
      ...view,
      role: { key: 'frota', title: 'Frota' },
      indicators: null,
      indicatorsHidden: true,
      roleFlowchart: 'flowchart TD',
    });
    show();
    const row = await screen.findByTestId('peer-role-frota');
    expect(screen.queryByTestId(`peer-role-${view.role!.key}`)).not.toBeInTheDocument();
    fireEvent.click(within(row).getByText('Ver'));
    await waitFor(() => expect(handbook.role.invoke).toHaveBeenCalledWith({ key: 'frota' }));
    await screen.findByTestId('handbook-role');
    expect(screen.queryByTestId('handbook-indicators')).not.toBeInTheDocument();
  });

  it('shows no area section when the employee only has their own role', async () => {
    handbook.roles.invoke.mockResolvedValue([
      { key: view.role!.key, title: view.role!.title, activities: 1, updatedAt: 1 },
    ]);
    show();
    await screen.findByText('Cargo: Auxiliar de escritório');
    expect(screen.queryByText('Manuais da sua área')).not.toBeInTheDocument();
  });
});
