import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import type { SecureRequest } from '@/common/types/agent/teachTypes';
import { ITEM_ID, view } from './fixtures';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('@renderer/components/Markdown/MermaidBlock', () => ({
  __esModule: true,
  default: ({ code }: { code: string }) => <pre data-testid='mermaid'>{code}</pre>,
}));

const { mine, media, listPending, handbookListeners } = vi.hoisted(() => ({
  mine: vi.fn(),
  media: vi.fn(),
  listPending: vi.fn(async (): Promise<unknown[]> => []),
  handbookListeners: [] as Array<(event: { activityId: string }) => void>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    jr: { handbook: { mine: { invoke: mine }, media: { invoke: media } } },
    teach: {
      secureRespond: { invoke: vi.fn(async () => ({})) },
      secureListPending: { invoke: listPending },
      secureRequest: { on: () => () => {} },
      secureExpired: { on: () => () => {} },
      showHandbook: {
        on: (fn: (event: { activityId: string }) => void) => {
          handbookListeners.push(fn);
          return () => handbookListeners.splice(handbookListeners.indexOf(fn), 1);
        },
      },
    },
  },
}));

import HandbookCard from '@renderer/pages/conversation/Preview/browser/TeachCards/HandbookCard';
import TeachCardHost from '@renderer/pages/conversation/Preview/browser/TeachCards/TeachCardHost';
import { resyncSecureRequests } from '@renderer/pages/conversation/Preview/browser/TeachCards/useSecureRequests';

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map() }}>{node}</SWRConfig>;

const secure: SecureRequest = {
  id: 'r1',
  origin: 'https://portal.gov.br',
  kind: 'otp',
  label: 'Código enviado por SMS',
  allowSave: false,
  purpose: 'fill',
};

beforeEach(async () => {
  vi.clearAllMocks();
  mine.mockResolvedValue(view);
  media.mockResolvedValue('data:image/jpeg;base64,AAAA');
  listPending.mockResolvedValue([]);
  await act(() => resyncSecureRequests());
});

describe('HandbookCard', () => {
  it('HandbookCard renders the activity replay and closes', async () => {
    const onClose = vi.fn();
    render(withSwr(<HandbookCard activityId={ITEM_ID} onClose={onClose} />));
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
    expect(screen.getByText('Abrir o portal')).toBeInTheDocument();
    await waitFor(() => expect(media).toHaveBeenCalled());
    fireEvent.click(screen.getByText('common.jr.handbook.card.close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('the host shows the card when the bot asks and hides it on close', async () => {
    render(withSwr(<TeachCardHost conversationId='c1' />));
    act(() => handbookListeners.forEach((fn) => fn({ activityId: ITEM_ID })));
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
    fireEvent.click(screen.getByText('common.jr.handbook.card.close'));
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
  });

  it('a pending secure request still takes priority over the handbook card', async () => {
    // Main is the source of truth for pending secure requests (the host resyncs on mount).
    listPending.mockResolvedValue([secure]);
    render(withSwr(<TeachCardHost conversationId='c1' />));
    act(() => handbookListeners.forEach((fn) => fn({ activityId: ITEM_ID })));
    expect(await screen.findByText('Código enviado por SMS')).toBeInTheDocument();
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
  });
});
