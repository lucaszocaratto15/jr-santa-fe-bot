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

type StreamMessage = { type: string; data: unknown; conversation_id: string; msg_id: string };

const { mine, adminRole, media, listPending, handbookListeners, streamListeners } = vi.hoisted(() => ({
  mine: vi.fn(),
  adminRole: vi.fn(),
  media: vi.fn(),
  listPending: vi.fn(async (): Promise<unknown[]> => []),
  handbookListeners: [] as Array<(event: { activityId: string; roleKey?: string }) => void>,
  streamListeners: [] as Array<(message: StreamMessage) => void>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (fn: (message: StreamMessage) => void) => {
          streamListeners.push(fn);
          return () => streamListeners.splice(streamListeners.indexOf(fn), 1);
        },
      },
    },
    jr: { handbook: { mine: { invoke: mine }, adminRole: { invoke: adminRole }, media: { invoke: media } } },
    teach: {
      secureRespond: { invoke: vi.fn(async () => ({})) },
      secureListPending: { invoke: listPending },
      secureRequest: { on: () => () => {} },
      secureExpired: { on: () => () => {} },
      showHandbook: {
        on: (fn: (event: { activityId: string; roleKey?: string }) => void) => {
          handbookListeners.push(fn);
          return () => handbookListeners.splice(handbookListeners.indexOf(fn), 1);
        },
      },
    },
  },
}));

import HandbookCard from '@renderer/pages/conversation/Preview/browser/TeachCards/HandbookCard';
import TeachCardHost from '@renderer/pages/conversation/Preview/browser/TeachCards/TeachCardHost';
import {
  isHandbookShowCall,
  resetHandbookCards,
} from '@renderer/pages/conversation/Preview/browser/TeachCards/handbookCardStore';
import { cancelDescribe, openDescribe } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';
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
  adminRole.mockResolvedValue(view);
  media.mockResolvedValue('data:image/jpeg;base64,AAAA');
  listPending.mockResolvedValue([]);
  resetHandbookCards();
  cancelDescribe();
  await act(() => resyncSecureRequests());
});

/** The bot of `conversationId` calls handbook_show (the tool_group frame of its turn). */
const botCalls = (conversationId: string, status = 'Executing') =>
  act(() =>
    streamListeners.forEach((fn) =>
      fn({
        type: 'tool_group',
        data: [{ name: 'jr-teach__handbook_show', status }],
        conversation_id: conversationId,
        msg_id: 'm1',
      })
    )
  );
/** Main relays the card request (`teach.showHandbook`). */
const mainShows = (roleKey?: string) =>
  act(() => handbookListeners.forEach((fn) => fn({ activityId: ITEM_ID, ...(roleKey ? { roleKey } : {}) })));

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

  it('the host shows the card when its own bot asks and hides it on close', async () => {
    render(withSwr(<TeachCardHost conversationId='c1' />));
    botCalls('c1');
    mainShows();
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
    fireEvent.click(screen.getByText('common.jr.handbook.card.close'));
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
  });

  it('the card request may arrive before the tool frame of the conversation', async () => {
    render(withSwr(<TeachCardHost conversationId='c1' />));
    mainShows();
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
    botCalls('c1');
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
  });

  it('a card asked for by another conversation never shows here and waits for that conversation', async () => {
    const view1 = render(withSwr(<TeachCardHost conversationId='c1' />));
    botCalls('c2');
    mainShows();
    await act(async () => {});
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
    view1.unmount();
    render(withSwr(<TeachCardHost conversationId='c2' />));
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
  });

  it('a card request with no handbook_show call in any conversation shows nowhere', async () => {
    render(withSwr(<TeachCardHost conversationId='c1' />));
    mainShows();
    await act(async () => {});
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
  });

  it('an admin card for another role reads that role, read-only, and not the own handbook', async () => {
    render(withSwr(<TeachCardHost conversationId='c1' />));
    botCalls('c1');
    mainShows('financeiro');
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
    expect(adminRole).toHaveBeenCalledWith({ key: 'financeiro' });
    expect(mine).not.toHaveBeenCalled();
  });

  it('the handbook card does not hide the teach describe card', async () => {
    render(withSwr(<TeachCardHost conversationId='c1' />));
    act(() => openDescribe());
    botCalls('c1');
    mainShows();
    expect(await screen.findByText('common.jr.teach.describe.title')).toBeInTheDocument();
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
    act(() => cancelDescribe());
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
  });

  it('a pending secure request still takes priority over the handbook card', async () => {
    // Main is the source of truth for pending secure requests (the host resyncs on mount).
    listPending.mockResolvedValue([secure]);
    render(withSwr(<TeachCardHost conversationId='c1' />));
    botCalls('c1');
    mainShows();
    expect(await screen.findByText('Código enviado por SMS')).toBeInTheDocument();
    expect(screen.queryByTestId('handbook-replay')).not.toBeInTheDocument();
  });
});

describe('isHandbookShowCall', () => {
  it('matches an in-flight handbook_show entry of a tool_group, with or without the server prefix', () => {
    for (const name of ['handbook_show', 'jr-teach__handbook_show', 'mcp__jr-teach__handbook_show']) {
      expect(isHandbookShowCall('tool_group', [{ name, status: 'Executing' }]), name).toBe(true);
    }
    expect(isHandbookShowCall('tool_group', [{ name: 'handbook_show', status: 'Success' }])).toBe(false);
    expect(isHandbookShowCall('tool_group', [{ name: 'handbook_lookup', status: 'Executing' }])).toBe(false);
    expect(isHandbookShowCall('tool_group', [{ name: 'my_handbook_show', status: 'Executing' }])).toBe(false);
    expect(isHandbookShowCall('content', [{ name: 'handbook_show', status: 'Executing' }])).toBe(false);
    expect(isHandbookShowCall('tool_group', null)).toBe(false);
  });
});
