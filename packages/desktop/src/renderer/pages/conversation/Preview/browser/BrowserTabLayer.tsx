/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useLayoutEffect, useRef } from 'react';
import type { PreviewTab, PreviewTabPatch } from '../context/PreviewContext';
import type { PreviewScopeKey } from '../context/previewScope';
import { isElectronDesktop } from '@/renderer/utils/platform';
import BrowserViewer from './BrowserViewer';
import TeachControls, { TeachRecordingBar } from './TeachControls';

export type LiveBrowserSession = {
  ownerId: string;
  scopeKey: PreviewScopeKey;
  tab: PreviewTab;
  webContentsId?: number;
};
export type BrowserViewportState = {
  tabId: string;
  ownerId: string;
  scopeKey: PreviewScopeKey;
  left: number;
  top: number;
  width: number;
  height: number;
};
export type RegisterBrowserViewport = (tabId: string, element: HTMLElement) => () => void;

export interface BrowserTabLayerProps {
  /** 所有浏览器类型的 tab / Every browser-type tab */
  sessions: LiveBrowserSession[];
  /** 当前激活的 tab id（可能不是浏览器 tab）/ Active tab id (may not be a browser tab) */
  viewport: BrowserViewportState | null;
  agentTargetTabId: string | null;
  /** 回写 tab 字段 / Patch fields back onto a tab */
  updateTab: (tabId: string, patch: PreviewTabPatch) => void;
  registerGuest: (session: LiveBrowserSession, webContentsId: number) => void;
}

/** A panel supplies geometry only; moving a webview between DOM parents destroys its guest. */
export const BrowserViewport: React.FC<{ tabId: string; register?: RegisterBrowserViewport }> = ({
  tabId,
  register,
}) => {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (element.current && register) return register(tabId, element.current);
  }, [register, tabId]);
  return <div ref={element} className='flex-1 min-h-0 w-full' data-browser-viewport={tabId} />;
};

const BrowserSessionView: React.FC<{
  session: LiveBrowserSession;
  viewport: BrowserViewportState | null;
  agentTargetTabId: string | null;
  updateTab: BrowserTabLayerProps['updateTab'];
  registerGuest: BrowserTabLayerProps['registerGuest'];
}> = ({ session, viewport, agentTargetTabId, updateTab, registerGuest }) => {
  const { tab } = session;
  const container = useRef<HTMLDivElement>(null);
  const visible = Boolean(
    viewport &&
    viewport.tabId === tab.id &&
    viewport.ownerId === session.ownerId &&
    viewport.scopeKey === session.scopeKey
  );
  const size = useRef({ width: 1024, height: 768 });
  if (visible && viewport) size.current = { width: viewport.width, height: viewport.height };
  useLayoutEffect(() => {
    if (
      !visible &&
      container.current?.contains(document.activeElement) &&
      document.activeElement instanceof HTMLElement
    )
      document.activeElement.blur();
  }, [visible]);
  return (
    <div
      ref={container}
      data-browser-session={tab.id}
      aria-hidden={!visible}
      inert={!visible}
      className='flex flex-col overflow-hidden bg-1'
      style={{
        position: 'fixed',
        left: visible ? viewport!.left : -10000,
        top: visible ? viewport!.top : 0,
        ...size.current,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <TeachRecordingBar />
      <BrowserViewer
        url={tab.content}
        tabId={tab.id}
        agentBrowserActive={agentTargetTabId === tab.id}
        onWebContentsReady={(_id, webContentsId) => registerGuest(session, webContentsId)}
        onUrlChange={(id, content) => updateTab(id, { content })}
        onTitleChange={(id, title) => updateTab(id, { title })}
        onFaviconChange={(id, favicon) => updateTab(id, { metadata: { favicon } })}
        navBarExtra={<TeachControls agentActive={Boolean(tab.metadata?.agentActive)} />}
      />
    </div>
  );
};

/**
 * 常驻挂载的浏览器层 / Always-mounted browser layer.
 *
 * 预览面板原本只渲染当前激活的 tab，对文档没问题，但对浏览器是致命的：
 * 切走再切回会重新加载页面，滚动位置、表单内容、未提交的操作全部丢失，
 * Agent 正在进行的操作也会被打断。
 *
 * 所以这一层把所有浏览器 tab 一直挂着，只切换可见性 —— webview 进程不销毁，
 * 页面状态完整保留。非激活的 tab 用 visibility 隐藏而不是 display:none，
 * 这样它们仍有真实尺寸，切回来时不需要重新布局。
 *
 * The preview panel renders only the active tab, which is fine for documents but
 * fatal for a browser: switching away and back would reload the page, losing
 * scroll position, form input, and any in-flight agent operation. This layer keeps
 * every browser tab mounted and only toggles visibility, so the webview process
 * survives. Inactive tabs are hidden via `visibility` rather than `display:none`
 * so they retain real dimensions and need no relayout when shown again.
 */
const BrowserTabLayer: React.FC<BrowserTabLayerProps> = ({
  sessions,
  viewport,
  agentTargetTabId,
  updateTab,
  registerGuest,
}) => {
  if (!isElectronDesktop() || sessions.length === 0) return null;
  return (
    <div data-browser-session-host style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 30 }}>
      {sessions.map((session) => (
        <BrowserSessionView
          key={`${session.ownerId}:${session.tab.id}`}
          session={session}
          viewport={viewport}
          agentTargetTabId={agentTargetTabId}
          updateTab={updateTab}
          registerGuest={registerGuest}
        />
      ))}
    </div>
  );
};

export default BrowserTabLayer;
