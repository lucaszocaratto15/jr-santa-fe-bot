/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards ①② (stale-tree on project switch): the conversation route must publish
 * the active project SYNCHRONOUSLY from the in-memory list snapshot the instant
 * the route id changes — before the async `conversation.get` resolves. Here the
 * fetcher NEVER resolves, so any published project id can only have come from the
 * synchronous snapshot path.
 *   - known conversation → its project id, immediately (covers cold/never-opened
 *     rows, which are in the snapshot but were never fetched);
 *   - unknown conversation (not in snapshot) → null placeholder, never the
 *     previous project (宁空勿画错).
 *
 * Mutation: revert the route to async-only (drop the layout-effect snapshot
 * publish) → with the fetch hanging, currentProject stays null and these assert
 * fail.
 */

import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';

let currentId = 'c1';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: currentId }), useNavigate: () => vi.fn() }));
vi.mock('@/renderer/pages/conversation/components/ChatConversation', () => ({
  default: () => <div data-testid='chat' />,
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ closePreviewIfScopeChanged: vi.fn() }),
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({ useAutoTitle: () => ({ syncTitleFromHistory: vi.fn() }) }));

// Fetcher that NEVER resolves — proves the publish came from the sync snapshot,
// not from conversation.get.
const getConversationOrNull = vi.fn<(id: string) => Promise<TChatConversation | null>>(() => new Promise(() => {}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (id: string) => getConversationOrNull(id),
}));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { listChanged: { on: () => () => {} } } } }));

import ChatConversationIndex from '@/renderer/pages/conversation/index';
import {
  getCurrentProject,
  resetCurrentProjectForTest,
} from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { setConversationProjectMapForTest } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';

const renderIndex = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ChatConversationIndex />
    </SWRConfig>
  );

beforeEach(() => {
  resetCurrentProjectForTest();
  getConversationOrNull.mockReset();
  getConversationOrNull.mockImplementation(() => new Promise(() => {}));
  currentId = 'c1';
  // snapshot loaded from GET /api/conversations — every row carries project_id.
  setConversationProjectMapForTest([
    ['c1', 'p1'],
    ['c2', 'p2'],
    ['cNoProject', null],
  ]);
});
afterEach(() => {
  cleanup();
  setConversationProjectMapForTest([]);
});

describe('conversation route — synchronous project publish from list snapshot (①②)', () => {
  it('publishes the known conversation project id synchronously (fetch never resolves)', () => {
    renderIndex();
    expect(getConversationOrNull).toHaveBeenCalled(); // fetch started…
    expect(getCurrentProject()).toBe('p1'); // …but project already published, sync
  });

  it('publishes a cold (never-opened) conversation project on switch', () => {
    const { rerender } = renderIndex();
    expect(getCurrentProject()).toBe('p1');
    currentId = 'c2';
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ChatConversationIndex />
      </SWRConfig>
    );
    expect(getCurrentProject()).toBe('p2');
  });

  it('does not open the files panel for a JR conversation that already has a project id', () => {
    setConversationProjectMapForTest([['c1', 'p-backfill', true]]);
    renderIndex();
    expect(getCurrentProject()).toBeNull();
  });

  it('closes the files panel once a loaded JR conversation reports a backfilled project', async () => {
    getConversationOrNull.mockImplementation(
      async () => ({ id: 'c1', type: 'aionrs', project_id: 'p-backfill' }) as TChatConversation
    );
    renderIndex();
    await waitFor(() => expect(getCurrentProject()).toBeNull());
  });

  it('publishes null placeholder for an unknown conversation — never the previous project', () => {
    const { rerender } = renderIndex();
    expect(getCurrentProject()).toBe('p1');
    currentId = 'unknown-not-in-snapshot';
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ChatConversationIndex />
      </SWRConfig>
    );
    expect(getCurrentProject()).toBeNull(); // placeholder, not stale 'p1'
  });

  it('publishes null for a known conversation whose project_id is null (pre-backfill)', () => {
    currentId = 'cNoProject';
    renderIndex();
    expect(getCurrentProject()).toBeNull();
  });
});
