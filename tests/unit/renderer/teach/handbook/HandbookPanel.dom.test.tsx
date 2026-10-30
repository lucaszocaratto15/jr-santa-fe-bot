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
      dismiss: fn(),
      withdraw: fn(),
      media: fn(),
      draftShot: fn(),
      preview: fn(),
      adminRoles: fn(),
      adminRole: fn(),
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
  publishedItemId: null,
  status: 'new',
};

const result = (overrides: Partial<HandbookDraftsResult> = {}): HandbookDraftsResult => ({
  role: view.role,
  drafts: [draft],
  published: [],
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
});

describe('HandbookPanel', () => {
  it('lists drafts with the role and the visibility notice', async () => {
    show();
    expect(await screen.findByText('Cargo: Auxiliar de escritório')).toBeInTheDocument();
    expect(screen.getByText(/ficará|fica visível para o seu gestor/)).toBeInTheDocument();
    expect(screen.getByText(/Atividade · Lança a nota fiscal \(tarefa ensinada\)/)).toBeInTheDocument();
    expect(screen.getByText('2 passos · 2 telas')).toBeInTheDocument();
  });

  it('panel without a title shows the cargo-not-registered message and no Aprovar', async () => {
    handbook.drafts.invoke.mockResolvedValue(result({ role: null }));
    show();
    expect(
      await screen.findByText('Seu cargo não está cadastrado. Peça ao administrador para cadastrá-lo.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Revisar')).not.toBeInTheDocument();
    expect(screen.queryByText('Aprovar e publicar no manual')).not.toBeInTheDocument();
  });

  it('in pilot mode says it works only with the company server', async () => {
    handbook.drafts.invoke.mockRejectedValue(new Error('unavailable'));
    show();
    expect(await screen.findByText('Disponível só com o servidor da empresa.')).toBeInTheDocument();
  });

  it('Aprovar asks for confirmation that names gestor and future role holders, then publishes', async () => {
    show();
    fireEvent.click(await screen.findByText('Revisar'));
    fireEvent.click(await screen.findByText('Aprovar e publicar no manual'));
    expect(handbook.publish.invoke).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Este item ficará visível para o seu gestor e para quem ocupar o seu cargo. Publicar?')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Publicar'));
    await waitFor(() => expect(handbook.publish.invoke).toHaveBeenCalledTimes(1));
    const call = handbook.publish.invoke.mock.calls[0][0];
    expect(call.key).toBe(draft.key);
    expect(call.keepShots).toEqual([1, 2]);
    expect(call.body.confirmBefore).toEqual(['Valor']);
    expect(message.success).toHaveBeenCalledWith('Publicado no manual');
  });

  it('removing a screenshot in the editor excludes it from keepShots', async () => {
    show();
    fireEvent.click(await screen.findByText('Revisar'));
    fireEvent.click(await screen.findByTestId('remove-shot-1'));
    expect(screen.queryByTestId('remove-shot-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Aprovar e publicar no manual'));
    fireEvent.click(await screen.findByText('Publicar'));
    await waitFor(() => expect(handbook.publish.invoke).toHaveBeenCalled());
    const call = handbook.publish.invoke.mock.calls[0][0];
    expect(call.keepShots).toEqual([2]);
    expect(call.body.steps[0]).toEqual({ text: 'Abrir o portal' });
  });

  it('a publish refused for no_role shows the role message and keeps the editor open', async () => {
    handbook.publish.invoke.mockRejectedValue(
      new Error("Error invoking remote method 'jr-handbook-publish': Error: no_role")
    );
    show();
    fireEvent.click(await screen.findByText('Revisar'));
    fireEvent.click(await screen.findByText('Aprovar e publicar no manual'));
    fireEvent.click(await screen.findByText('Publicar'));
    expect(
      await screen.findByText('Seu cargo não está cadastrado. Peça ao administrador para cadastrá-lo.')
    ).toBeInTheDocument();
    expect(screen.getByText('Aprovar e publicar no manual')).toBeInTheDocument();
  });

  it('Descartar dismisses the draft', async () => {
    show();
    fireEvent.click(await screen.findByText('Descartar'));
    await waitFor(() => expect(handbook.dismiss.invoke).toHaveBeenCalledWith({ key: draft.key }));
  });

  it('Retirar calls withdraw and removes the row', async () => {
    const entry = { key: draft.key, itemId: 'item-1', kind: 'activity' as const, title: 'Lançar NF' };
    handbook.drafts.invoke.mockResolvedValueOnce(result({ drafts: [], published: [entry] }));
    handbook.drafts.invoke.mockResolvedValue(result({ drafts: [], published: [] }));
    handbook.withdraw.invoke.mockResolvedValue(undefined);
    show();
    const row = await screen.findByTestId('published-item-1');
    fireEvent.click(within(row).getByText('Retirar'));
    const popup = await screen.findByText('Retirar este item do manual do cargo agora?');
    const confirm = popup.closest('.arco-popconfirm')?.querySelector('.arco-btn-primary') as HTMLElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(handbook.withdraw.invoke).toHaveBeenCalledWith({ itemId: 'item-1' }));
    await waitFor(() => expect(screen.queryByTestId('published-item-1')).not.toBeInTheDocument());
  });

  it('there is no manager-approval state anywhere in the panel', async () => {
    const entry = { key: draft.key, itemId: 'item-1', kind: 'activity' as const, title: 'Lançar NF' };
    handbook.drafts.invoke.mockResolvedValue(result({ published: [entry] }));
    const { container } = show();
    await screen.findByTestId('published-item-1');
    expect(container.textContent).not.toMatch(/Aguardando gestor|aprovação do gestor|pendente/i);
  });
});
