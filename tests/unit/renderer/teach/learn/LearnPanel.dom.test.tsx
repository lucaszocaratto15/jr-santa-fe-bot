import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import type { LearnExclusion, LearnInsightBatch, LearnState } from '@/common/types/agent/learnTypes';
import { ptBR, withI18n } from './i18nTestUtils';

const { learn, message } = vi.hoisted(() => {
  const fn = () => ({ invoke: vi.fn() });
  return {
    learn: {
      state: fn(),
      stateChanged: { on: vi.fn(() => () => {}) },
      accept: fn(),
      turnOn: fn(),
      pause: fn(),
      resume: fn(),
      turnOff: fn(),
      revoke: fn(),
      getExclusions: fn(),
      setExclusions: fn(),
      restoreDefaultExclusions: fn(),
      listInsights: fn(),
      deleteInsight: fn(),
      generateNow: fn(),
      wipeSamples: fn(),
      openScreenRecordingSettings: fn(),
    },
    message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

vi.mock('@/common', () => ({ ipcBridge: { learn } }));
vi.mock('@renderer/components/Markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: message };
});

import LearnPanel from '@renderer/pages/Jr/JrSidebar/Learn/LearnPanel';

const base: LearnState = {
  status: 'off',
  unavailableReason: null,
  pausedUntil: null,
  titles: 'full',
  samplerError: false,
  rawHours: 0,
  acceptedVersion: null,
  acceptedAt: null,
  lastInsightsAt: null,
};
const active: LearnState = {
  ...base,
  status: 'active',
  rawHours: 9,
  acceptedVersion: '1.2',
  acceptedAt: '2026-10-29T18:02:00.000Z',
};
const bankRule = (id: string): LearnExclusion => ({ id, kind: 'domain', pattern: `${id}.com.br`, builtin: true });
const defaults = [bankRule('bank-domain-itau'), bankRule('whatsapp-domain'), bankRule('mail-domain-uol')];
const batch: LearnInsightBatch = {
  id: 'b1',
  createdAt: Date.parse('2026-10-29T18:00:00Z'),
  periodStart: 0,
  periodEnd: 0,
  timePerApp: [
    { app: 'Excel', minutes: 130 },
    { app: 'Portal NF', minutes: 65 },
  ],
  repetitive: [{ title: 'Baixar NF no portal', description: 'Toda manhã', times: 4, minutes: 20 }],
  suggestions: [
    { kind: 'tip', title: 'Atalho no Excel', description: 'Use Ctrl+Shift+L' },
    {
      kind: 'teach',
      title: 'Emitir NF',
      description: 'Feito todo dia',
      teach: { description: 'Emitir a NF do dia', url: 'https://nfse.exemplo.gov.br/emitir' },
    },
  ],
};

const i18n = ptBR();
const renderPanel = (state: LearnState, props: Partial<React.ComponentProps<typeof LearnPanel>> = {}) => {
  learn.state.invoke.mockResolvedValue(state);
  const onTeach = vi.fn();
  render(
    withI18n(
      i18n,
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <LearnPanel onTeach={onTeach} {...props} />
      </SWRConfig>
    )
  );
  return { onTeach };
};

beforeEach(() => {
  for (const channel of Object.values(learn)) {
    if ('invoke' in channel) channel.invoke.mockReset();
  }
  Object.values(message).forEach((fn) => fn.mockReset());
  learn.listInsights.invoke.mockResolvedValue([]);
  learn.getExclusions.invoke.mockResolvedValue(defaults);
});

describe('LearnPanel', () => {
  it('off: shows Ativar, which opens the consent modal', async () => {
    renderPanel(base);
    fireEvent.click(await screen.findByRole('button', { name: 'Ativar' }));
    expect(await screen.findByText('Li e concordo com o Termo de Consentimento de Dados')).toBeInTheDocument();
    expect(learn.turnOn.invoke).not.toHaveBeenCalled();
  });

  it('off after Desligar with the current term: Ativar turns it back on without the modal', async () => {
    learn.turnOn.invoke.mockResolvedValue(active);
    renderPanel({ ...base, acceptedVersion: '1.2', acceptedAt: active.acceptedAt });
    fireEvent.click(await screen.findByRole('button', { name: 'Ativar' }));
    await waitFor(() => expect(learn.turnOn.invoke).toHaveBeenCalled());
    expect(screen.queryByText('Li e concordo com o Termo de Consentimento de Dados')).not.toBeInTheDocument();
  });

  it('active: shows insights, exclusions and data controls', async () => {
    learn.listInsights.invoke.mockResolvedValue([batch]);
    renderPanel(active);
    expect(await screen.findByText('Baixar NF no portal')).toBeInTheDocument();
    expect(screen.getByText(/Excel 2h10 · Portal NF 1h05/)).toBeInTheDocument();
    expect(await screen.findByText('Bancos')).toBeInTheDocument();
    expect(screen.getByText('Registros brutos: 9 h guardadas (apagadas em até 48 h)')).toBeInTheDocument();
    expect(screen.getByText(/Termo aceito em .* \(v1\.2\)/)).toBeInTheDocument();
    expect(screen.getByText('Só você vê isto.')).toBeInTheDocument();
  });

  it('Revogar asks for confirmation, then calls learn.revoke', async () => {
    learn.revoke.invoke.mockResolvedValue(base);
    renderPanel(active);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar consentimento e apagar tudo' }));
    expect(learn.revoke.invoke).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Para religar, será preciso aceitar o termo de novo.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revogar consentimento e apagar tudo' }));
    await waitFor(() => expect(learn.revoke.invoke).toHaveBeenCalledTimes(1));
  });

  it('Gerar insights agora shows the no-data message for code no-data', async () => {
    learn.generateNow.invoke.mockResolvedValue({ ok: false, code: 'no-data' });
    renderPanel(active);
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar insights agora' }));
    await waitFor(() => expect(message.warning).toHaveBeenCalledWith(expect.stringMatching(/Ainda não há dados/)));
  });

  it('titles app-only on mac shows the Screen Recording notice with Abrir Ajustes', async () => {
    renderPanel({ ...active, titles: 'app-only' });
    expect(await screen.findByText(/Sem permissão de Gravação de Tela/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir Ajustes' }));
    expect(learn.openScreenRecordingSettings.invoke).toHaveBeenCalled();
  });

  it('a sampler error offers Tentar de novo, which resumes', async () => {
    learn.resume.invoke.mockResolvedValue(active);
    renderPanel({ ...active, samplerError: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(learn.resume.invoke).toHaveBeenCalled());
  });

  it('a builtin exclusion can be removed and Restaurar padrão brings it back', async () => {
    learn.setExclusions.invoke.mockImplementation(async (rules: LearnExclusion[]) => rules);
    learn.restoreDefaultExclusions.invoke.mockResolvedValue(defaults);
    renderPanel(active);
    const banks = await screen.findByText('Bancos');
    expect(screen.queryByRole('button', { name: 'Restaurar padrão' })).not.toBeInTheDocument();
    const close = banks.closest('.arco-tag')?.querySelector('.arco-tag-close-btn');
    fireEvent.click(close as Element);
    await waitFor(() =>
      expect(learn.setExclusions.invoke).toHaveBeenCalledWith([defaults[1], defaults[2]])
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Restaurar padrão' }));
    await waitFor(() => expect(learn.restoreDefaultExclusions.invoke).toHaveBeenCalled());
    expect(await screen.findByText('Bancos')).toBeInTheDocument();
  });

  it('adds a custom exclusion', async () => {
    learn.setExclusions.invoke.mockImplementation(async (rules: LearnExclusion[]) => rules);
    renderPanel(active);
    fireEvent.change(await screen.findByPlaceholderText('Ex.: meubanco.com.br'), {
      target: { value: 'meubanco.com.br' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() =>
      expect(learn.setExclusions.invoke).toHaveBeenCalledWith([
        ...defaults,
        expect.objectContaining({ kind: 'domain', pattern: 'meubanco.com.br', builtin: false }),
      ])
    );
  });

  it('a tip has no Ensinar button; a teach suggestion has one and calls onTeach', async () => {
    learn.listInsights.invoke.mockResolvedValue([batch]);
    const { onTeach } = renderPanel(active);
    await screen.findByText('Atalho no Excel');
    const buttons = screen.getAllByRole('button', { name: 'Ensinar esta tarefa' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onTeach).toHaveBeenCalledWith(batch.suggestions[1]);
  });

  it('autoConsent with needs-consent opens the modal with the reconsent notice', async () => {
    renderPanel({ ...base, status: 'needs-consent', acceptedVersion: '1.1' }, { autoConsent: true });
    expect(await screen.findByText(/O termo mudou. Leia a versão 1.2/)).toBeInTheDocument();
  });

  it('needs-consent without autoConsent waits for Revisar o termo', async () => {
    renderPanel({ ...base, status: 'needs-consent', acceptedVersion: '1.1' });
    const review = await screen.findByRole('button', { name: 'Revisar o termo' });
    expect(screen.queryByText(/Leia a versão 1.2/)).not.toBeInTheDocument();
    fireEvent.click(review);
    expect(await screen.findByText(/Leia a versão 1.2/)).toBeInTheDocument();
  });

  it('unavailable without encryption says why and offers no Ativar', async () => {
    renderPanel({ ...base, status: 'unavailable', unavailableReason: 'encryption' });
    expect(await screen.findByText(/não oferece criptografia/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ativar' })).not.toBeInTheDocument();
  });

  it('Pausar pauses until resumed', async () => {
    learn.pause.invoke.mockResolvedValue({ ...active, status: 'paused' });
    renderPanel(active);
    fireEvent.click(await screen.findByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(learn.pause.invoke).toHaveBeenCalledWith({ minutes: null }));
  });
});
