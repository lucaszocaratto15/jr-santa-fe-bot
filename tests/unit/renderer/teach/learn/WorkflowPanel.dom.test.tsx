import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { WorkRoutine } from '@/common/types/agent/learnTypes';
import { ptBR, withI18n } from './i18nTestUtils';

const { api } = vi.hoisted(() => ({
  api: Object.fromEntries(
    ['state', 'start', 'step', 'complete', 'review', 'monthly', 'observations'].map((key) => [key, { invoke: vi.fn() }])
  ),
}));
vi.mock('@/common', () => ({ ipcBridge: { learn: { workflow: api } } }));
import WorkflowPanel from '@renderer/pages/Jr/JrSidebar/Learn/WorkflowPanel';

const routine: WorkRoutine = {
  id: 'r1',
  name: 'Consulta de certidões',
  startedAt: 1,
  completedAt: 2,
  status: 'candidate',
  evidence: 'weak',
  steps: [{ id: 's1', label: 'Consultar portal', sourceType: 'web', actionCategory: 'consulta' }],
  notes: '',
  inputs: '',
  outputs: '',
  eventual: false,
  excludedFromSummary: false,
  suppressSuggestion: false,
};
const show = (collecting = true) =>
  render(
    withI18n(
      ptBR(),
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <WorkflowPanel collecting={collecting} ownerId='test-user' />
      </SWRConfig>
    )
  );
beforeEach(() => {
  Object.values(api).forEach((channel) => channel.invoke.mockReset());
  api.state.invoke.mockResolvedValue({ active: null, routines: [] });
});
describe('private workflow review', () => {
  it('distinguishes actual observed actions from manual markers without claiming the routine is verified', async () => {
    api.state.invoke.mockResolvedValue({ active: null, routines: [{ ...routine, observed: true }] });
    show();
    expect(await screen.findByText(/Estas ações foram confirmadas pelo ERP ou navegador/)).toBeInTheDocument();
    expect(screen.queryByText(/Evidência: marcos informados por você/)).not.toBeInTheDocument();
    expect(api.review.invoke).not.toHaveBeenCalled();
  });
  it('cannot start markers while work observation is disabled or paused', async () => {
    show(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome genérico do fluxo' }), {
      target: { value: 'Consulta' },
    });
    expect(screen.getByRole('button', { name: 'Iniciar fluxo' })).toBeDisabled();
    expect(api.start.invoke).not.toHaveBeenCalled();
  });
  it('saves corrected steps and suppression only through the employee review action', async () => {
    api.state.invoke.mockResolvedValue({ active: null, routines: [routine] });
    show();
    const step = await screen.findByRole('textbox', { name: 'Nome genérico da etapa' });
    fireEvent.change(step, { target: { value: 'Revisar portal' } });
    fireEvent.click(screen.getByText('Não sugerir novamente'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar rotina e salvar correções' }));
    await waitFor(() =>
      expect(api.review.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'confirmed',
          suppressSuggestion: true,
          steps: [expect.objectContaining({ label: 'Revisar portal' })],
        })
      )
    );
  });
  it('creates a manual draft only after a reviewed monthly map and explicit request', async () => {
    api.monthly.invoke.mockResolvedValue({
      month: '2026-11',
      routines: [{ name: routine.name, frequency: 1, steps: routine.steps, notes: '', eventual: false }],
      pendingCount: 0,
      observations: '',
    });
    show();
    expect(screen.queryByRole('button', { name: 'Preparar rascunho privado do manual' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar mapa mensal privado' }));
    const manual = await screen.findByRole('button', { name: 'Preparar rascunho privado do manual' });
    expect(screen.queryByRole('textbox', { name: /Rascunho privado/ })).not.toBeInTheDocument();
    fireEvent.click(manual);
    expect((screen.getByRole('textbox', { name: /Rascunho privado/ }) as HTMLTextAreaElement).value).toContain(
      'Consulta de certidões'
    );
  });
  it('explains insufficient evidence instead of inventing a monthly role map', async () => {
    api.monthly.invoke.mockResolvedValue(null);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar mapa mensal privado' }));
    expect(
      await screen.findByText('Confirme ao menos uma rotina concluída neste mês para gerar o mapa.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preparar rascunho privado do manual' })).not.toBeInTheDocument();
  });
});
