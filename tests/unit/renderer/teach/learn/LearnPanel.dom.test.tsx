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

const { listJrBots, startJrConversation, queueConversationIntent, navigate } = vi.hoisted(() => ({
  listJrBots: vi.fn(),
  startJrConversation: vi.fn(),
  queueConversationIntent: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('@renderer/pages/Jr/index', () => ({ JR_BOTS_KEY: 'jr.bots' }));
vi.mock('@renderer/pages/Jr/jrBots', () => ({ listJrBots, startJrConversation }));
vi.mock('@renderer/pages/conversation/Preview/browser/TeachCards/teachStore', () => ({ queueConversationIntent }));
vi.mock('@renderer/pages/Jr/JrSidebar/panels', () => ({
  ComputerPanel: () => null,
  GeneralPanel: () => null,
  UpdatesPanel: () => null,
}));
vi.mock('@renderer/pages/Jr/JrSidebar/Teach/TasksPanel', () => ({ __esModule: true, default: () => null }));
vi.mock('@renderer/pages/Jr/JrSidebar/Teach/VaultPanel', () => ({ __esModule: true, default: () => null }));
vi.mock('@renderer/pages/Jr/JrSidebar/Usage/UsagePanel', () => ({ __esModule: true, default: () => null }));

import { MemoryRouter } from 'react-router-dom';
import LearnPanel from '@renderer/pages/Jr/JrSidebar/Learn/LearnPanel';
import JrSettingsModal from '@renderer/pages/Jr/JrSidebar/SettingsModal';
import { useLearnSettingsRequests } from '@renderer/pages/Jr/JrSidebar/Learn/useLearnState';
import { emitter } from '@renderer/utils/emitter';

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
  activeSince: null,
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

describe('Ensinar esta tarefa (through the settings modal)', () => {
  const bot = { id: 'bot-nf', name: 'Fiscal', workspace: '/w' };

  const renderSettings = () => {
    learn.state.invoke.mockResolvedValue(active);
    learn.listInsights.invoke.mockResolvedValue([batch]);
    const onClose = vi.fn();
    render(
      withI18n(
        i18n,
        <MemoryRouter initialEntries={['/conversation/old?bot=bot-nf']}>
          <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <JrSettingsModal tab='learn' onTab={() => {}} onClose={onClose} />
          </SWRConfig>
        </MemoryRouter>
      )
    );
    return { onClose };
  };

  beforeEach(() => {
    listJrBots.mockReset().mockResolvedValue([{ id: 'other', name: 'Outro' }, bot]);
    startJrConversation.mockReset().mockResolvedValue({ id: 'conv-9', name: 'Nova' });
    queueConversationIntent.mockReset();
    navigate.mockReset();
  });

  it('opens the bot conversation with a describe intent for the suggestion url', async () => {
    const { onClose } = renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Ensinar esta tarefa' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/conversation/conv-9?bot=bot-nf'));
    expect(onClose).toHaveBeenCalled();
    expect(startJrConversation).toHaveBeenCalledWith(bot, { newConversation: true });
    expect(queueConversationIntent).toHaveBeenCalledWith('conv-9', {
      openBrowser: true,
      url: 'https://nfse.exemplo.gov.br/emitir',
      describe: 'Emitir a NF do dia',
    });
  });

  it('without a bot it warns and keeps the modal open', async () => {
    listJrBots.mockResolvedValue([]);
    const { onClose } = renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Ensinar esta tarefa' }));
    await waitFor(() => expect(message.warning).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(startJrConversation).not.toHaveBeenCalled();
  });
});

describe('useLearnSettingsRequests', () => {
  const Probe: React.FC<{ open: (autoConsent: boolean) => void }> = ({ open }) => {
    useLearnSettingsRequests(open);
    return null;
  };
  const mount = (state: LearnState, open: (autoConsent: boolean) => void) => {
    learn.state.invoke.mockResolvedValue(state);
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Probe open={open} />
      </SWRConfig>
    );
  };

  beforeEach(() => {
    sessionStorage.clear();
  });

  it('asks once per session after a prior accept of another version', async () => {
    const open = vi.fn();
    const first = mount({ ...base, status: 'needs-consent', acceptedVersion: '1.1' }, open);
    await waitFor(() => expect(open).toHaveBeenCalledWith(true));
    first.unmount();
    const again = vi.fn();
    mount({ ...base, status: 'needs-consent', acceptedVersion: '1.1' }, again);
    await waitFor(() => expect(learn.state.invoke).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(again).not.toHaveBeenCalled();
  });

  it('never asks when nothing was accepted before', async () => {
    const open = vi.fn();
    mount({ ...base, status: 'needs-consent', acceptedVersion: null }, open);
    await waitFor(() => expect(learn.state.invoke).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the tab on jr.settings.open', async () => {
    const open = vi.fn();
    mount(active, open);
    emitter.emit('jr.settings.open', { tab: 'learn' });
    expect(open).toHaveBeenCalledWith(false);
  });
});
