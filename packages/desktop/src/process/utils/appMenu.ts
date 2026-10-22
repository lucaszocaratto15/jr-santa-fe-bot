/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { MenuItemConstructorOptions } from 'electron';
import { Menu, app } from 'electron';
import i18n from '@process/services/i18n';

export function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: i18n.t('common.jr.menu.about') },
        { type: 'separator' },
        { role: 'services', label: i18n.t('common.jr.menu.services') },
        { type: 'separator' },
        { role: 'hide', label: i18n.t('common.jr.menu.hide') },
        { role: 'hideOthers', label: i18n.t('common.jr.menu.hideOthers') },
        { role: 'unhide', label: i18n.t('common.jr.menu.unhide') },
        { type: 'separator' },
        { role: 'quit', label: i18n.t('common.jr.menu.quit') },
      ],
    });
  }

  template.push({
    label: i18n.t('common.jr.menu.edit'),
    submenu: [
      { role: 'undo', label: i18n.t('common.jr.menu.undo') },
      { role: 'redo', label: i18n.t('common.jr.menu.redo') },
      { type: 'separator' },
      { role: 'cut', label: i18n.t('common.jr.menu.cut') },
      { role: 'copy', label: i18n.t('common.jr.menu.copy') },
      { role: 'paste', label: i18n.t('common.jr.menu.paste') },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle', label: i18n.t('common.jr.menu.pasteAndMatchStyle') },
            { role: 'delete', label: i18n.t('common.jr.menu.delete') },
            { role: 'selectAll', label: i18n.t('common.jr.menu.selectAll') },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete', label: i18n.t('common.jr.menu.delete') },
            { type: 'separator' },
            { role: 'selectAll', label: i18n.t('common.jr.menu.selectAll') },
          ] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: i18n.t('common.jr.menu.view'),
    submenu: [
      { role: 'reload', label: i18n.t('common.jr.menu.reload') },
      { role: 'forceReload', label: i18n.t('common.jr.menu.forceReload') },
      { role: 'toggleDevTools', label: i18n.t('common.jr.menu.toggleDevTools') },
      { type: 'separator' },
      { role: 'resetZoom', label: i18n.t('common.jr.menu.resetZoom') },
      { role: 'zoomIn', label: i18n.t('common.jr.menu.zoomIn') },
      { role: 'zoomOut', label: i18n.t('common.jr.menu.zoomOut') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: i18n.t('common.jr.menu.togglefullscreen') },
    ],
  });

  template.push({
    label: i18n.t('common.jr.menu.help'),
    submenu: [
      {
        label: i18n.t('common.jr.menu.updates'),
        click: () => {
          ipcBridge.update.open.emit({ source: 'menu' });
        },
      },
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
