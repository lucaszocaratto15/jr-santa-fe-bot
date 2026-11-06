import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  clearBrowser: vi.fn(async () => ({ success: true })),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  nativeIds: new Map<string, number>(),
  nextNativeId: 1,
  openTab: undefined as undefined | ((value: { url: string; openerWebContentsId: number }) => void),
  phase: 'idle',
  takenOver: false,
  requests: [] as Array<{ origin: string }>,
  access: undefined as undefined | ((value: { status: string; user: { id: string } | null }) => void),
  activity: undefined as
    | undefined
    | ((value: { type: string; data: unknown; conversation_id?: string; turn_id?: string }) => void),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: { clearBrowserData: { invoke: state.clearBrowser } },
    jr: {
      accessStatus: { invoke: async () => ({ status: 'authenticated', user: { id: 'employee-a' } }) },
      accessChanged: {
        on: (handler: typeof state.access) => {
          state.access = handler;
          return () => {
            state.access = undefined;
          };
        },
      },
    },
    fileStream: { contentUpdate: { on: () => () => {} } },
    teach: {
      openTab: {
        on: (handler: typeof state.openTab) => {
          state.openTab = handler;
          return () => {
            state.openTab = undefined;
          };
        },
      },
    },
    preview: { open: { on: () => () => {} } },
    conversation: {
      responseStream: {
        on: (handler: typeof state.activity) => {
          state.activity = handler;
          return () => {
            state.activity = undefined;
          };
        },
      },
    },
  },
}));
vi.mock('@arco-design/web-react', () => ({ Notification: { error: state.notifyError, warning: state.notifyWarning } }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/TeachCards/teachStore', () => ({ useTeachUi: () => state }));
vi.mock('@/renderer/pages/conversation/Preview/browser/TeachCards/useSecureRequests', () => ({
  useSecureRequests: () => state.requests,
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/TeachControls', () => ({
  default: () => null,
  TeachRecordingBar: () => null,
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserViewer', () => ({
  default: ({
    tabId,
    url,
    agentBrowserActive,
    onWebContentsReady,
  }: {
    tabId: string;
    url: string;
    agentBrowserActive: boolean;
    onWebContentsReady?: (tabId: string, nativeId: number) => void;
  }) => {
    const nativeId = React.useRef<number | null>(null);
    if (nativeId.current === null) nativeId.current = state.nextNativeId++;
    const id = nativeId.current;
    React.useEffect(() => {
      state.nativeIds.set(tabId, id);
      onWebContentsReady?.(tabId, id);
    }, [id, onWebContentsReady, tabId]);
    return <input data-testid={`guest-${tabId}`} data-agent-target={String(agentBrowserActive)} defaultValue={url} />;
  },
}));

import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import { BrowserViewport } from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import { MAX_BROWSER_TABS } from '@/renderer/pages/conversation/Preview/browser/constants';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';

let context: PreviewContextValue;
const Probe = () => {
  context = usePreviewContext();
  return null;
};
const Viewport = () => {
  const value = usePreviewContext();
  return value.isOpen && value.activeTab?.content_type === 'browser' && value.activeTabId ? (
    <BrowserViewport tabId={value.activeTabId} register={value.registerBrowserViewport} />
  ) : null;
};
const Harness = ({ route = true }: { route?: boolean }) => (
  <PreviewProvider>
    <Probe />
    {route && <Viewport />}
  </PreviewProvider>
);
const show = async () => {
  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Harness />);
    await Promise.resolve();
  });
  return view!;
};
const open = (scope: string, url: string) => {
  act(() => context.closePreviewIfScopeChanged(scope));
  act(() => context.openBrowserTab(url));
  return context.activeTabId!;
};
const guest = (id: string) => screen.getByTestId(`guest-${id}`) as HTMLInputElement;
const host = (id: string) => guest(id).closest('[data-browser-session]') as HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  state.clearBrowser.mockReset().mockResolvedValue({ success: true });
  state.notifyError.mockReset();
  state.notifyWarning.mockReset();
  state.nativeIds.clear();
  state.nextNativeId = 1;
  state.phase = 'idle';
  state.takenOver = false;
  state.requests = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    left: 40,
    top: 60,
    width: 640,
    height: 480,
    x: 40,
    y: 60,
    right: 680,
    bottom: 540,
    toJSON: () => ({}),
  }));
});

describe('persistent employee browser host', () => {
  it('keeps the same guest and unsent form state while the panel collapses', async () => {
    await show();
    const id = open('project-a', 'https://work.example.com');
    const original = guest(id);
    fireEvent.change(original, { target: { value: 'unsent form value' } });
    act(() => context.closePreview());
    expect(guest(id)).toBe(original);
    expect(host(id).style.visibility).toBe('hidden');
    act(() => context.openPreview('notes', 'code'));
    act(() => context.switchTab(id));
    expect(guest(id)).toBe(original);
    expect(guest(id).value).toBe('unsent form value');
    expect(host(id).style.visibility).toBe('visible');
  });

  it('parks the old project without exposing it and restores its exact guest on return', async () => {
    await show();
    const a = open('project-a', 'https://a.example.com');
    const original = guest(a);
    original.focus();
    expect(document.activeElement).toBe(original);
    const b = open('project-b', 'https://b.example.com');
    expect(host(a).style.visibility).toBe('hidden');
    expect(host(a).getAttribute('inert')).not.toBeNull();
    expect(document.activeElement).not.toBe(original);
    expect(host(b).style.visibility).toBe('visible');
    act(() => context.closePreviewIfScopeChanged('project-a'));
    expect(guest(a)).toBe(original);
    expect(host(a).style.visibility).toBe('visible');
    expect(host(b).style.visibility).toBe('hidden');
  });

  it('retains the guest while its route and viewport unmount', async () => {
    const view = await show();
    const id = open('project-a', 'https://work.example.com');
    const original = guest(id);
    view.rerender(<Harness route={false} />);
    expect(guest(id)).toBe(original);
    expect(host(id).style.visibility).toBe('hidden');
    view.rerender(<Harness />);
    expect(guest(id)).toBe(original);
    expect(host(id).style.visibility).toBe('visible');
  });

  it('does not let a new visible project claim CDP during an old browser-using turn', async () => {
    await show();
    const a = open('project-a', 'https://a.example.com');
    const message = {
      type: 'tool_group',
      conversation_id: 'chat-a',
      turn_id: 'turn-a',
      data: [{ name: `${BUILTIN_BROWSER_MCP_NAME}__navigate_page`, status: 'Executing' }],
    };
    act(() => state.activity?.(message));
    const b = open('project-b', 'https://b.example.com');
    expect(guest(a).dataset.agentTarget).toBe('true');
    expect(guest(b).dataset.agentTarget).toBe('false');
    act(() => state.activity?.({ ...message, data: [{ ...message.data[0], status: 'Success' }] }));
    expect(guest(b).dataset.agentTarget).toBe('false');
    act(() => state.activity?.({ type: 'finish', data: null, conversation_id: 'chat-a', turn_id: 'old-turn' }));
    expect(guest(b).dataset.agentTarget).toBe('false');
    act(() => state.activity?.({ type: 'finish', data: null, conversation_id: 'chat-a', turn_id: 'turn-a' }));
    expect(guest(b).dataset.agentTarget).toBe('true');
  });

  it('keeps a secure login target until its request finishes', async () => {
    const view = await show();
    const a = open('project-a', 'https://login.example.com');
    state.requests = [{ origin: 'https://login.example.com' }];
    view.rerender(<Harness />);
    const b = open('project-b', 'https://b.example.com');
    expect(guest(b).dataset.agentTarget).toBe('false');
    state.requests = [];
    view.rerender(<Harness />);
    expect(guest(a).dataset.agentTarget).toBe('false');
    expect(guest(b).dataset.agentTarget).toBe('true');
  });

  it('clears every project guest on logout, including a protected parked browser', async () => {
    await show();
    const a = open('project-a', 'https://a.example.com');
    open('project-b', 'https://b.example.com');
    act(() => context.updateTab(a, { metadata: { agentActive: true } }));
    act(() => state.access?.({ status: 'signed-out', user: null }));
    expect(screen.queryAllByTestId(/^guest-/)).toHaveLength(0);
    expect(context.tabs).toHaveLength(0);
  });

  it('does not reuse the previous employee guest when another employee signs in', async () => {
    await show();
    const a = open('project-a', 'https://a.example.com');
    await act(async () => {
      state.access?.({ status: 'authenticated', user: { id: 'employee-b' } });
      await Promise.resolve();
    });
    const b = open('project-a', 'https://b.example.com');
    expect(screen.queryByTestId(`guest-${a}`)).toBeNull();
    expect(guest(b)).toBeTruthy();
  });

  it('waits for cookie cleanup before a new employee can create a guest', async () => {
    let finish!: (value: { success: boolean }) => void;
    state.clearBrowser.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await show();
    open('project-a', 'https://a.example.com');
    await act(async () => {
      state.access?.({ status: 'authenticated', user: { id: 'employee-b' } });
      await Promise.resolve();
    });
    open('project-b', 'https://b.example.com');
    expect(screen.queryAllByTestId(/^guest-/)).toHaveLength(0);
    await act(async () => {
      finish({ success: true });
      await Promise.resolve();
    });
    const id = open('project-b', 'https://b.example.com');
    expect(guest(id)).toBeTruthy();
  });

  it('does not restore a new employee browser when cookie cleanup fails', async () => {
    state.clearBrowser.mockResolvedValue({ success: false });
    await show();
    open('project-a', 'https://a.example.com');
    await act(async () => {
      state.access?.({ status: 'authenticated', user: { id: 'employee-b' } });
      await Promise.resolve();
    });
    open('project-b', 'https://b.example.com');
    expect(screen.queryAllByTestId(/^guest-/)).toHaveLength(0);
    expect(state.notifyError).toHaveBeenCalledOnce();
  });

  it('keeps logout and login of the same employee behind the pending cookie cleanup', async () => {
    let finish!: (value: { success: boolean }) => void;
    state.clearBrowser.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await show();
    open('project-a', 'https://a.example.com');
    await act(async () => {
      state.access?.({ status: 'signed-out', user: null });
      state.access?.({ status: 'authenticated', user: { id: 'employee-a' } });
      await Promise.resolve();
    });
    open('project-a', 'https://a.example.com');
    expect(screen.queryAllByTestId(/^guest-/)).toHaveLength(0);
    await act(async () => {
      finish({ success: true });
      await Promise.resolve();
    });
    const id = open('project-a', 'https://a.example.com');
    expect(guest(id)).toBeTruthy();
    expect(state.clearBrowser).toHaveBeenCalledOnce();
  });

  it('does not clear browser cookies on a same-employee app restart', async () => {
    const first = await show();
    open('project-a', 'https://a.example.com');
    first.unmount();
    await show();
    expect(state.clearBrowser).not.toHaveBeenCalled();
  });

  it('applies the live session cap across projects without destroying protected guests', async () => {
    await show();
    act(() => context.closePreviewIfScopeChanged('project-a'));
    for (let index = 0; index < MAX_BROWSER_TABS; index += 1) {
      act(() => context.openBrowserTab(`https://a.example.com/${index}`));
      act(() => context.updateTab(context.activeTabId!, { metadata: { agentActive: true } }));
    }
    const originals = screen.getAllByTestId(/^guest-/);
    act(() => context.closePreviewIfScopeChanged('project-b'));
    act(() => context.openBrowserTab('https://b.example.com'));
    expect(screen.getAllByTestId(/^guest-/)).toEqual(originals);
    expect(context.tabs).toHaveLength(0);
    expect(context.browserSessionLimitHitAt).toBeTypeOf('number');
  });

  it('does not evict an idle parked form to make room in another project', async () => {
    await show();
    act(() => context.closePreviewIfScopeChanged('project-a'));
    for (let index = 0; index < MAX_BROWSER_TABS; index += 1)
      act(() => context.openBrowserTab(`https://a.example.com/${index}`));
    const originals = screen.getAllByTestId(/^guest-/);
    act(() => context.closePreviewIfScopeChanged('project-b'));
    act(() => context.openBrowserTab('https://b.example.com'));
    expect(screen.getAllByTestId(/^guest-/)).toEqual(originals);
    expect(context.tabs).toHaveLength(0);
    expect(context.browserSessionLimitHitAt).toBeTypeOf('number');
  });

  it('opens a popup only for its live current-project opener', async () => {
    await show();
    const id = open('project-a', 'https://a.example.com');
    act(() => state.openTab?.({ url: 'https://popup.example.com', openerWebContentsId: state.nativeIds.get(id)! }));
    expect(context.tabs).toHaveLength(2);
    expect(context.activeTab?.content).toBe('https://popup.example.com');
    expect(state.notifyWarning).not.toHaveBeenCalled();
  });

  it('does not open a parked project popup in the currently visible project', async () => {
    await show();
    const a = open('project-a', 'https://a.example.com');
    const b = open('project-b', 'https://b.example.com');
    act(() =>
      state.openTab?.({
        url: 'https://popup.example.com/private?source=a',
        openerWebContentsId: state.nativeIds.get(a)!,
      })
    );
    expect(context.tabs.map((tab) => tab.id)).toEqual([b]);
    expect(state.notifyWarning).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.notifyWarning.mock.calls)).not.toContain('private?source');
  });

  it('refuses a popup from an unknown native guest', async () => {
    await show();
    open('project-a', 'https://a.example.com');
    act(() => state.openTab?.({ url: 'https://popup.example.com', openerWebContentsId: 99999 }));
    expect(context.tabs).toHaveLength(1);
    expect(state.notifyWarning).toHaveBeenCalledOnce();
  });

  it('refuses a delayed popup after its guest was closed', async () => {
    await show();
    const a = open('project-a', 'https://a.example.com');
    const nativeId = state.nativeIds.get(a)!;
    act(() => context.closeTab(a));
    act(() => state.openTab?.({ url: 'https://popup.example.com', openerWebContentsId: nativeId }));
    expect(context.tabs).toHaveLength(0);
    expect(state.notifyWarning).toHaveBeenCalledOnce();
  });

  it('refuses a popup from the previous employee native guest', async () => {
    await show();
    const a = open('project-a', 'https://a.example.com');
    const nativeId = state.nativeIds.get(a)!;
    await act(async () => {
      state.access?.({ status: 'authenticated', user: { id: 'employee-b' } });
      await Promise.resolve();
    });
    const b = open('project-a', 'https://b.example.com');
    act(() => state.openTab?.({ url: 'https://popup.example.com', openerWebContentsId: nativeId }));
    expect(context.tabs.map((tab) => tab.id)).toEqual([b]);
    expect(state.notifyWarning).toHaveBeenCalledOnce();
  });
});
