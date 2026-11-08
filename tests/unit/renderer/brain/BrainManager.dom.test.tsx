import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { ptBR, withI18n } from '../teach/learn/i18nTestUtils';

const mocks = vi.hoisted(() => ({
  facts: vi.fn(),
  createNote: vi.fn(),
  pending: vi.fn(),
  revise: vi.fn(),
  consent: vi.fn(),
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
const connection = vi.hoisted(() => ({ changed: null as (() => void) | null }));

vi.mock('@/common', () => ({
  ipcBridge: {
    brain: {
      me: { invoke: mocks.me },
      notes: {
        create: { invoke: mocks.createNote },
        pending: { invoke: mocks.pending },
        revise: { invoke: mocks.revise },
        consent: { invoke: mocks.consent },
      },
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
    jr: {
      admin: { list: { invoke: mocks.list } },
      strata: {
        changed: {
          on: (listener: () => void) => {
            connection.changed = listener;
            return () => {};
          },
        },
      },
    },
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
const capabilities = { read: true, publish: true, revise: false, withdraw: false, approveOfficial: false };
const erpMe = (rights = capabilities) => ({
  areas: [{ id: '2', name: 'Obras', level: 'gestor', primary: true }],
  isDirector: false,
  manages: ['2'],
  permissionsSource: 'erp',
  capabilities: rights,
});

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
  });
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.pending.mockResolvedValue([]);
  mocks.me.mockResolvedValue({ areas: [], isDirector: true, manages: [] });
  mocks.createNote.mockResolvedValue({
    proposal: {
      id: 'fixture-proposal',
      version: 1,
      hash: 'hash-one',
      text: 'Fato número 7',
      sourceQuote: 'trecho literal da conversa',
      areaId: 2,
      risk: 'low',
      kind: 'shared_note',
      status: 'draft',
    },
    audiences: [{ id: 2, name: 'Obras' }],
  });
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
  it('does not grant a JR administrator ERP management rights or load the local permissions matrix', async () => {
    mocks.me.mockResolvedValue(erpMe());
    mount('owner');
    expect(await screen.findByText(i18n.t('common.jr.brainManage.erpPermissions'))).toBeTruthy();
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.areas).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Áreas' })).toBeNull();
  });

  it('uses ERP per-note revision and withdrawal rights without exposing an approval queue', async () => {
    mocks.me.mockResolvedValue(erpMe({ ...capabilities, revise: true }));
    mocks.facts.mockResolvedValue([
      fact(7, { canRevise: true, canWithdraw: false, canReactivate: true }),
      fact(8, { canRevise: false, canWithdraw: false, canReactivate: false }),
    ]);
    mount('owner');
    await screen.findByText('Fato número 7');
    expect(screen.getAllByRole('button', { name: i18n.t('common.jr.brainNotes.edit') })).toHaveLength(1);
    expect(
      screen
        .getAllByRole('switch')
        .every((button) => button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled'))
    ).toBe(true);
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.areas).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('shows official review only with the ERP approval capability', async () => {
    mocks.me.mockResolvedValue(erpMe({ ...capabilities, approveOfficial: true }));
    mocks.pending.mockResolvedValue([
      { id: 'pending-fixture', version: 1, text: 'Procedimento pendente', sourceQuote: 'Fonte autorizada' },
    ]);
    mount('manager');
    expect(await screen.findByText('Procedimento pendente')).toBeTruthy();
    expect(screen.getByRole('button', { name: i18n.t('common.jr.brainNotes.approve') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: i18n.t('common.jr.brainNotes.edit') })).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('drops cached company content immediately when the ERP connection context changes', async () => {
    mocks.me.mockResolvedValueOnce(erpMe({ ...capabilities, revise: true }));
    mocks.me.mockImplementationOnce(() => new Promise(() => {}));
    mount('owner');
    await screen.findByText('Fato número 7');
    act(() => connection.changed?.());
    expect(screen.queryByText('Fato número 7')).toBeNull();
    expect(screen.queryByText('trecho literal da conversa')).toBeNull();
  });

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

  it('does not expose the legacy direct promotion shortcut without note consent', async () => {
    mount('owner');
    await screen.findByText('Fato número 7');
    expect(screen.queryByRole('button', { name: 'Promover a Geral' })).toBeNull();
    expect(mocks.updateFact).not.toHaveBeenCalled();
  });

  it('edits an active fact through a private version proposal before any publication', async () => {
    mount('owner');
    await screen.findByText('Fato número 7');
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('common.jr.brainNotes.edit') })[0]);
    const dialog = await screen.findByRole('dialog', { name: i18n.t('common.jr.brainNotes.create') });
    expect(mocks.createNote).toHaveBeenCalledWith({ factId: 7 });
    fireEvent.change(within(dialog).getByLabelText(i18n.t('common.jr.brainNotes.text')), {
      target: { value: 'Texto corrigido' },
    });
    expect(mocks.updateFact).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
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
