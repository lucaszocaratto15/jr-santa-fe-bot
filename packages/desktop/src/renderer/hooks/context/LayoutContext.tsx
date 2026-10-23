/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';

export interface LayoutContextValue {
  isMobile: boolean;
  siderCollapsed: boolean;
  setSiderCollapsed: (value: boolean) => void;
  /**
   * Right-rail toggle in the window titlebar. False hides it (JR chats have no
   * rail). Omitted means the titlebar may show it — older callers and tests.
   */
  workspaceToggleVisible?: boolean;
  setWorkspaceToggleVisible?: (visible: boolean) => void;
}

export const LayoutContext = React.createContext<LayoutContextValue | null>(null);

export function useLayoutContext(): LayoutContextValue | null {
  return React.useContext(LayoutContext);
}
