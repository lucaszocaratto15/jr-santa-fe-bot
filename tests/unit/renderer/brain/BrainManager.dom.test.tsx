import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { ptBR, withI18n } from '../teach/learn/i18nTestUtils';

const mocks = vi.hoisted(() => ({
  facts: vi.fn(),
  updateFact: vi.fn(),
  history: vi.fn(),
  areas: vi.fn(),
  createArea: vi.fn(),
  renameArea: vi.fn(),
  removeArea: vi.fn(),
  setMemberships: vi.fn(),
  deleteAuthorFacts: vi.fn(),
  log: vi.fn(),
  me: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    brain: {
      me: { invoke: mocks.me },
      manage: {
        facts: { invoke: mocks.facts },
        updateFact: { invoke: mocks.updateFact },
        history: { invoke: mocks.history },
        areas: { invoke: mocks.areas },
        createArea: { invoke: mocks.createArea },
        renameArea: { invoke: mocks.renameArea },
        removeArea: { invoke: mocks.removeArea },
        setMemberships: { invoke: mocks.setMemberships },
        deleteAuthorFacts: { invoke: mocks.deleteAuthorFacts },
        log: { invoke: mocks.log },
      },
    },
    jr: { admin: { list: { invoke: mocks.list } } },
  },
}));
vi.mock('@renderer/pages/Jr/Access/context', () => ({
  useJrAccess: () => ({ state: { user: { id: 'owner', name: 'Dono', role: 'admin' } } }),
}));
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } };
});

import BrainManager from '@renderer/pages/Jr/Brain/BrainManager';

const i18n = ptBR();
const mount = (mode: 'owner' | 'manager') =>
  render(
    withI18n(
      i18n,
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <BrainManager mode={mode} />
      </SWRConfig>
    )
  );

const fact = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  areaId: 2,
  risk: 'low',
  kind: 'fato',
  text: `Fato número ${id}`,
  sourceQuote: 'trecho literal da conversa',
  sourceKind: 'usuario_afirmou',
  authorUserId: 'u1',
  authorBot: 'Financeiro',
  erpRef: null,
  createdAt: Date.UTC(2026, 9, 1),
  confidence: 8,
  active: true,
  suspended: false,
  flagConflict: false,
  humanEdited: false,
  updatedAt: null,
  ...over,
});
const employee = (id: string, name: string, revoked = false) => ({ id, name, revoked, role: 'colaborador' });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.areas.mockResolvedValue([
    { id: 1, name: 'Geral', isGeneral: true, members: [] },
    { id: 2, name: 'Obras', isGeneral: false, members: [{ userId: 'u1', level: 'gestor', primary: true }] },
    { id: 3, name: 'Sem área', isGeneral: false, members: [] },
  ]);
  mocks.list.mockResolvedValue([employee('u1', 'Ana Souza'), employee('u2', 'Bruno Lima')]);
  mocks.log.mockResolvedValue([{ id: 1, at: Date.UTC(2026, 9, 2), userId: 'u1', action: 'update_fact', factId: 7 }]);
  mocks.facts.mockResolvedValue([fact(7), fact(8, { risk: 'high', authorUserId: 'gone' })]);
});

describe('BrainManager', () => {
  it('shows the owner the facts, the areas, the people and the access log', async () => {
    mount('owner');
    expect(await screen.findByText('Fato número 7')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Áreas' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Registro de acesso' })).toBeTruthy();
    expect(await screen.findByText('Fato alterado')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Apagar fatos de uma pessoa' })).toBeTruthy();
    // The author of fact 8 is not in the employee list any more.
    expect(screen.getAllByText(/ex-funcionário/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ana Souza/).length).toBeGreaterThan(0);
  });

  it('shows a gestor only the facts of managed areas: no areas, people or log', async () => {
    mocks.me.mockResolvedValue({
      areas: [
        { id: '2', name: 'Obras', level: 'gestor', primary: true },
        { id: '3', name: 'Financeiro', level: 'colaborador', primary: false },
      ],
      isDirector: false,
      manages: ['2'],
    });
    mount('manager');
    expect(await screen.findByText('Fato número 7')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Áreas' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Registro de acesso' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Apagar fatos de uma pessoa' })).toBeNull();
    expect(mocks.areas).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    // The author is not shown to a gestor (no employee list), neither a name nor "ex-funcionário".
    expect(screen.queryByText(/ex-funcionário/)).toBeNull();
    expect(screen.getByTestId('brain-fact-7').textContent).not.toMatch(/Origem: [^\d]*Ana/);
    expect(screen.getByTestId('brain-fact-7').textContent).toContain('Origem: ');
    // Only the managed area is offered in the area filter.
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    expect(await screen.findByRole('option', { name: 'Obras' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Financeiro' })).toBeNull();
  });

  it('disables promote to Geral for high-risk facts and promotes a low one', async () => {
    mount('owner');
    await screen.findByText('Fato número 7');
    const buttons = screen.getAllByRole('button', { name: 'Promover a Geral' });
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    mocks.updateFact.mockResolvedValue(fact(7, { areaId: 1 }));
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(mocks.updateFact).toHaveBeenCalledWith({ id: 7, patch: { general: true } }));
  });

  it('edits the text through the right IPC call with only the changed fields', async () => {
    mount('owner');
    await screen.findByText('Fato número 7');
    fireEvent.click(screen.getAllByRole('button', { name: 'Editar fato' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Editar fato' });
    const area = within(dialog).getByLabelText('Texto do fato');
    fireEvent.change(area, { target: { value: 'Texto corrigido' } });
    mocks.updateFact.mockResolvedValue(fact(7, { text: 'Texto corrigido' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocks.updateFact).toHaveBeenCalledWith({ id: 7, patch: { text: 'Texto corrigido' } }));
  });

  it('asks for confirmation before deleting the facts of a person', async () => {
    mount('owner');
    await screen.findByText('Fato número 7');
    const section = screen.getByTestId('brain-forget');
    fireEvent.click(within(section).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Bruno Lima' }));
    mocks.deleteAuthorFacts.mockResolvedValue(3);
    fireEvent.click(within(section).getByRole('button', { name: 'Apagar fatos' }));
    expect(mocks.deleteAuthorFacts).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: /Apagar todos os fatos de Bruno Lima/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apagar' }));
    await waitFor(() => expect(mocks.deleteAuthorFacts).toHaveBeenCalledWith({ userId: 'u2' }));
  });
});
