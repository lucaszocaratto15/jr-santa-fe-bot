import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { openBrowserTab } = vi.hoisted(() => ({ openBrowserTab: vi.fn() }));

vi.mock('@renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: {
      available: { invoke: async () => true },
      state: { on: () => () => {} },
      draft: { on: () => () => {} },
      draftRejected: { on: () => () => {} },
      secureListPending: { invoke: async () => [] },
      secureRequest: { on: () => () => {} },
      secureExpired: { on: () => () => {} },
    },
  },
}));

import TeachCardHost from '@renderer/pages/conversation/Preview/browser/TeachCards/TeachCardHost';
import {
  queueConversationIntent,
  resetTeachUiForTests,
  takeConversationIntent,
} from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';

describe('conversation intents', () => {
  beforeEach(() => {
    openBrowserTab.mockReset();
    resetTeachUiForTests();
    takeConversationIntent('c1');
  });

  it('returns a queued intent once', () => {
    queueConversationIntent('c1', { openBrowser: true });
    expect(takeConversationIntent('c1')).toEqual({ openBrowser: true });
    expect(takeConversationIntent('c1')).toBeNull();
  });

  it('TeachCardHost opens the browser once for a queued intent and not on remount', () => {
    queueConversationIntent('c1', { openBrowser: true, url: 'https://portal.gov.br' });
    const first = render(<TeachCardHost conversationId='c1' />);
    expect(openBrowserTab).toHaveBeenCalledTimes(1);
    expect(openBrowserTab).toHaveBeenCalledWith('https://portal.gov.br');
    first.unmount();
    render(<TeachCardHost conversationId='c1' />);
    expect(openBrowserTab).toHaveBeenCalledTimes(1);
  });

  it('a mounted TeachCardHost consumes an intent queued for its conversation at once', () => {
    render(<TeachCardHost conversationId='c1' />);
    expect(openBrowserTab).not.toHaveBeenCalled();
    act(() => queueConversationIntent('c1', { openBrowser: true }));
    expect(openBrowserTab).toHaveBeenCalledTimes(1);
    expect(takeConversationIntent('c1')).toBeNull();
  });

  it('a mounted TeachCardHost leaves an intent queued for another conversation', () => {
    render(<TeachCardHost conversationId='c1' />);
    act(() => queueConversationIntent('c2', { openBrowser: true }));
    expect(openBrowserTab).not.toHaveBeenCalled();
    expect(takeConversationIntent('c2')).toEqual({ openBrowser: true });
  });

  it('ignores an intent queued for another conversation', () => {
    queueConversationIntent('c2', { openBrowser: true });
    render(<TeachCardHost conversationId='c1' />);
    expect(openBrowserTab).not.toHaveBeenCalled();
    takeConversationIntent('c2');
  });

  it('a describe intent opens the Ensinar card prefilled', async () => {
    queueConversationIntent('c1', { openBrowser: true, describe: 'Baixar NFs do mês' });
    render(<TeachCardHost conversationId='c1' />);
    expect(await screen.findByDisplayValue('Baixar NFs do mês')).toBeInTheDocument();
    expect(openBrowserTab).toHaveBeenCalledWith(undefined);
  });
});
