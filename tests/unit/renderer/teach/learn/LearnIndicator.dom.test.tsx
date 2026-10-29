import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import type { LearnState } from '@/common/types/agent/learnTypes';
import { ptBR, withI18n } from './i18nTestUtils';

const { learn, listeners } = vi.hoisted(() => {
  const listeners: Array<(state: unknown) => void> = [];
  const fn = () => ({ invoke: vi.fn() });
  return {
    listeners,
    learn: {
      state: fn(),
      stateChanged: {
        on: vi.fn((listener: (state: unknown) => void) => {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        }),
      },
      pause: fn(),
      resume: fn(),
      turnOff: fn(),
    },
  };
});

vi.mock('@/common', () => ({ ipcBridge: { learn } }));

import LearnIndicator from '@renderer/components/layout/Titlebar/LearnIndicator';
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
const active: LearnState = { ...base, status: 'active', acceptedVersion: '1.3', activeSince: Date.now() };

const i18n = ptBR();
const renderIndicator = (state: LearnState) => {
  learn.state.invoke.mockResolvedValue(state);
  return render(
    withI18n(
      i18n,
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <LearnIndicator />
      </SWRConfig>
    )
  );
};
const openMenu = async () => fireEvent.click(await screen.findByRole('button', { name: 'Aprender com seu trabalho' }));

beforeEach(() => {
  learn.state.invoke.mockReset();
  learn.pause.invoke.mockReset().mockResolvedValue(active);
  learn.resume.invoke.mockReset().mockResolvedValue(active);
  learn.turnOff.invoke.mockReset().mockResolvedValue(base);
  listeners.length = 0;
});

describe('LearnIndicator', () => {
  it.each([
    ['off', base],
    ['unavailable', { ...base, status: 'unavailable' as const, unavailableReason: 'encryption' as const }],
    ['never accepted', { ...base, status: 'needs-consent' as const }],
  ])('renders nothing when %s', async (_name, state) => {
    renderIndicator(state);
    await waitFor(() => expect(learn.state.invoke).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('learn-indicator')).not.toBeInTheDocument();
  });

  it('active: menu offers Pausar por 1 hora, Pausar até eu retomar, Ver insights e ajustes, Desligar', async () => {
    renderIndicator(active);
    await openMenu();
    expect(await screen.findByText(/Aprendendo · desde/)).toBeInTheDocument();
    for (const label of ['Pausar por 1 hora', 'Pausar até eu retomar', 'Ver insights e ajustes', 'Desligar']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Retomar')).not.toBeInTheDocument();
  });

  it('Pausar por 1 hora calls learn.pause({ minutes: 60 })', async () => {
    renderIndicator(active);
    await openMenu();
    fireEvent.click(await screen.findByText('Pausar por 1 hora'));
    expect(learn.pause.invoke).toHaveBeenCalledWith({ minutes: 60 });
  });

  it('Pausar até eu retomar pauses with minutes null', async () => {
    renderIndicator(active);
    await openMenu();
    fireEvent.click(await screen.findByText('Pausar até eu retomar'));
    expect(learn.pause.invoke).toHaveBeenCalledWith({ minutes: null });
  });

  it('paused: shows Retomar and the dimmed style; Retomar calls learn.resume', async () => {
    renderIndicator({ ...active, status: 'paused', activeSince: null, pausedUntil: null });
    const button = await screen.findByTestId('learn-indicator');
    expect(button).toHaveClass('app-titlebar__learn--paused');
    await openMenu();
    expect(await screen.findByText('Pausado')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retomar'));
    expect(learn.resume.invoke).toHaveBeenCalled();
  });

  it('Desligar calls learn.turnOff', async () => {
    renderIndicator(active);
    await openMenu();
    fireEvent.click(await screen.findByText('Desligar'));
    expect(learn.turnOff.invoke).toHaveBeenCalled();
  });

  it('Ver insights e ajustes emits jr.settings.open with tab learn', async () => {
    const listener = vi.fn();
    emitter.on('jr.settings.open', listener);
    renderIndicator(active);
    await openMenu();
    fireEvent.click(await screen.findByText('Ver insights e ajustes'));
    expect(listener).toHaveBeenCalledWith({ tab: 'learn' });
    emitter.off('jr.settings.open', listener);
  });

  it('needs-consent after a prior accept shows the warning dot and Revisar opens settings with autoConsent', async () => {
    const listener = vi.fn();
    emitter.on('jr.settings.open', listener);
    const { container } = renderIndicator({ ...base, status: 'needs-consent', acceptedVersion: '1.1' });
    await screen.findByTestId('learn-indicator');
    expect(container.querySelector('.arco-badge-dot')).not.toBeNull();
    await openMenu();
    fireEvent.click(await screen.findByText('O termo mudou: revisar'));
    expect(listener).toHaveBeenCalledWith({ tab: 'learn', autoConsent: true });
    emitter.off('jr.settings.open', listener);
  });

  it('updates when learn.stateChanged fires', async () => {
    renderIndicator(base);
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('learn-indicator')).not.toBeInTheDocument();
    act(() => listeners.forEach((listener) => listener(active)));
    expect(await screen.findByTestId('learn-indicator')).toBeInTheDocument();
    act(() => listeners.forEach((listener) => listener(base)));
    await waitFor(() => expect(screen.queryByTestId('learn-indicator')).not.toBeInTheDocument());
  });
});
