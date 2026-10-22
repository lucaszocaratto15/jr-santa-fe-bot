/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from 'i18next';

const TOOL_LABEL_KEYS: Record<string, string> = {
  write: 'messages.tools.write',
  writefile: 'messages.tools.write',
  read: 'messages.tools.read',
  readfile: 'messages.tools.read',
  fileread: 'messages.tools.read',
  edit: 'messages.tools.edit',
  fileedit: 'messages.tools.edit',
  replace: 'messages.tools.edit',
  exec: 'messages.tools.execute',
  execute: 'messages.tools.execute',
  execcommand: 'messages.tools.execute',
  shellcommand: 'messages.tools.execute',
  bash: 'messages.tools.execute',
  search: 'messages.tools.search',
  grep: 'messages.tools.search',
  glob: 'messages.tools.search',
  fetch: 'messages.tools.fetch',
  listpages: 'messages.tools.browserTabs',
  newpage: 'messages.tools.browserNewTab',
  closepage: 'messages.tools.browserCloseTab',
  selectpage: 'messages.tools.browserSelectTab',
  navigatepage: 'messages.tools.browserNavigate',
  takesnapshot: 'messages.tools.browserSnapshot',
  evaluatescript: 'messages.tools.browserExecute',
  click: 'messages.tools.browserClick',
  hover: 'messages.tools.browserHover',
  fill: 'messages.tools.browserFill',
  fillform: 'messages.tools.browserFillForm',
  presskey: 'messages.tools.browserKeyboard',
  uploadfile: 'messages.tools.browserUpload',
  drag: 'messages.tools.browserDrag',
  handledialog: 'messages.tools.browserDialog',
  takescreenshot: 'messages.tools.browserScreenshot',
  waitfor: 'messages.tools.browserWait',
  resizepage: 'messages.tools.browserResize',
  emulate: 'messages.tools.browserEmulate',
  listconsolemessages: 'messages.tools.browserConsole',
  getconsolemessage: 'messages.tools.browserConsole',
  listnetworkrequests: 'messages.tools.browserNetwork',
  getnetworkrequest: 'messages.tools.browserNetwork',
  tool: 'messages.operation.tool',
};

/** Localize known tool labels while retaining unknown tool identifiers. */
export const localizeToolName = (name: string, t: TFunction): string => {
  const generatedTitle = /^\w+ wants to use: (.+)$/.exec(name);
  const toolName = generatedTitle?.[1] ?? name;
  const key = TOOL_LABEL_KEYS[(toolName.split('/').at(-1) || toolName).replace(/[_ -]/g, '').toLowerCase()];
  return key ? t(key) : generatedTitle ? t('messages.tools.use', { name: toolName }) : name;
};

/** Strip protocol boilerplate only; preserve command and path bytes verbatim. */
export const getToolDescriptionPayload = (description?: string): string | undefined =>
  description?.match(/^(?:Write to |Read from |Read |Execute: |Execute )([\s\S]+)$/)?.[1];
