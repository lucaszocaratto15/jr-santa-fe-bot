import type { IMcpServer } from '@/common/config/storage';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  toggle: vi.fn(),
  test: vi.fn(),
  login: vi.fn(),
  info: vi.fn(),
  open: vi.fn(),
  navigate: vi.fn(),
  access: { status: 'pilot', user: null as { id: string; name: string; role: 'admin' | 'employee' } | null },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; name?: string }) =>
      options?.name ? `${key} ${options.name}` : options?.count === undefined ? key : `${key} ${options.count}`,
  }),
}));
vi.mock('@/renderer/pages/Jr/Access/context', () => ({
  useJrAccess: () => ({ state: mocks.access, logout: vi.fn() }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  application: { systemInfo: { invoke: mocks.info } },
  shell: { openExternal: { invoke: mocks.open } },
  mcpService: {
    listServers: { invoke: mocks.list },
    createServer: { invoke: mocks.create },
    updateServer: { invoke: mocks.update },
    toggleServer: { invoke: mocks.toggle },
    testMcpConnection: { invoke: mocks.test },
    loginMcpOAuth: { invoke: mocks.login },
  },
}));

import Connections from '@/renderer/pages/Jr/Connections';

const local: IMcpServer = {
  id: 'mcp-1',
  name: 'Local server',
  enabled: false,
  created_at: 1,
  updated_at: 1,
  original_json: '{}',
  transport: { type: 'stdio', command: 'node', args: ['server.js'] },
  last_test_status: 'connected',
};
const chrome: IMcpServer = { ...local, id: 'chrome-jr', name: 'chrome-jr' };
const remote: IMcpServer = {
  ...local,
  id: 'remote',
  name: 'Gmail server',
  transport: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
};
const show = (onClose?: () => void) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Connections onClose={onClose} />
    </SWRConfig>
  );
const openApp = (app: 'chrome') =>
  fireEvent.click(screen.getByRole('button', { name: `common.jr.mcp.appActionLabel common.jr.mcp.${app}Title` }));
const openAdvanced = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.advanced' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.jr.mcp.customAction' })).not.toBeDisabled());
};
const beginGmailSetup = async () => {
  await openAdvanced();
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.customAction' }));
  fireEvent.change(screen.getByLabelText('common.jr.mcp.name'), { target: { value: 'Legacy remote' } });
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByText('common.jr.mcp.httpTransport'));
  fireEvent.change(screen.getByLabelText('common.jr.mcp.url'), {
    target: { value: remote.transport.type === 'http' ? remote.transport.url : '' },
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.status = 'pilot';
  mocks.access.user = null;
  mocks.list.mockResolvedValue([]);
  mocks.info.mockResolvedValue({ cacheDir: '/app/cache' });
});

describe('approved app catalogue', () => {
  it('opens the catalogue in a named dialog and closes back to the workspace', async () => {
    show();
    const catalogue = screen.getByRole('dialog', { name: /common.jr.mcp.title/ });
    fireEvent.click(within(catalogue).getByRole('button', { name: 'common.close' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/guid');
  });

  it('closes an embedded catalogue through its callback without navigating or adding a page', async () => {
    const onClose = vi.fn();
    show(onClose);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: /common.jr.mcp.title/ })).getByRole('button', { name: 'common.close' })
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it('returns from app details to the catalogue without losing the search', async () => {
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'common.jr.mcp.searchApps' }), {
      target: { value: 'CHROME' },
    });
    openApp('chrome');
    fireEvent.click(screen.getByRole('button', { name: 'common.goBack' }));
    expect(screen.getByRole('textbox', { name: 'common.jr.mcp.searchApps' })).toHaveValue('CHROME');
    expect(screen.getByRole('tab', { name: 'common.jr.mcp.allApps' })).toHaveAttribute('aria-selected', 'true');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('keeps technical configuration out of the normal app flow', async () => {
    show();
    openApp('chrome');
    expect(screen.getByText('common.jr.mcp.accounts')).toBeInTheDocument();
    expect(screen.queryByLabelText('common.jr.mcp.arguments')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('filters approved apps by the search input', () => {
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'common.jr.mcp.searchApps' }), {
      target: { value: 'CHROME' },
    });
    expect(
      screen.getByRole('button', { name: 'common.jr.mcp.appActionLabel common.jr.mcp.chromeTitle' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'common.jr.mcp.appActionLabel common.jr.mcp.gmailTitle' })
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'common.jr.mcp.searchApps' }), {
      target: { value: 'missing-app' },
    });
    expect(screen.getByText('common.jr.mcp.noAppsFound')).toBeInTheDocument();
  });

  it('shows employees only the approved apps and hides advanced controls', async () => {
    mocks.access.status = 'authenticated';
    mocks.access.user = { id: 'employee', name: 'Employee', role: 'employee' };
    mocks.list.mockResolvedValue([local]);
    show();
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'common.jr.mcp.advanced' })).not.toBeInTheDocument();
    expect(screen.queryByText(local.name)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /common.jr.mcp.appActionLabel/ })).toHaveLength(1);
  });

  it('allows an authenticated administrator to open advanced settings', async () => {
    mocks.access.status = 'authenticated';
    mocks.access.user = { id: 'admin', name: 'Admin', role: 'admin' };
    show();
    await openAdvanced();
    expect(screen.getByText('common.jr.mcp.empty')).toBeInTheDocument();
  });

  it('does not offer Google connection or preparation during the pilot', async () => {
    mocks.list.mockResolvedValue([{ ...remote, enabled: true, last_test_status: 'connected' }]);
    show();
    expect(
      screen.queryByRole('button', { name: 'common.jr.mcp.appActionLabel common.jr.mcp.gmailTitle' })
    ).not.toBeInTheDocument();
    await openAdvanced();
    expect(screen.queryByRole('button', { name: 'common.jr.mcp.gmailAction' })).not.toBeInTheDocument();
    expect(screen.queryByText('common.jr.mcp.connected')).not.toBeInTheDocument();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('creates the private pinned Chrome preset instead of reusing the backend built-in', async () => {
    const builtin: IMcpServer = {
      ...local,
      id: 'builtin-chrome',
      name: 'chrome-devtools',
      builtin: true,
      transport: { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest'] },
    };
    mocks.list.mockResolvedValue([builtin]);
    mocks.create.mockImplementation(async (payload: Partial<IMcpServer>) => ({ ...chrome, ...payload }));
    mocks.test.mockResolvedValue({ success: true, tools: [] });
    mocks.toggle.mockResolvedValue({ ...chrome, enabled: true });
    show();
    openApp('chrome');
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.jr.mcp.connect' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.connect' }));
    expect(await screen.findByText('common.jr.mcp.connected')).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'chrome-jr',
        transport: expect.objectContaining({
          args: expect.arrayContaining(['chrome-devtools-mcp@1.12.0', '--user-data-dir=/app/cache/jr-chrome-profile']),
        }),
      })
    );
    expect(mocks.toggle).toHaveBeenCalledWith({ id: chrome.id });
  });

  it('waits for actual Chrome tool discovery before showing Connected', async () => {
    let finishTest: (value: { success: boolean; tools: [] }) => void = vi.fn();
    mocks.list.mockResolvedValue([chrome]);
    mocks.test.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishTest = resolve;
        })
    );
    mocks.toggle.mockResolvedValue({ ...chrome, enabled: true });
    show();
    openApp('chrome');
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.jr.mcp.connect' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.connect' }));
    await waitFor(() => expect(mocks.test).toHaveBeenCalled());
    expect(screen.queryByText('common.jr.mcp.connected')).not.toBeInTheDocument();
    await act(async () => finishTest({ success: true, tools: [] }));
    expect(await screen.findByText('common.jr.mcp.connected')).toBeInTheDocument();
  });

  it('runs Chrome discovery once when a newly created preset is already enabled', async () => {
    mocks.create.mockResolvedValue({ ...chrome, enabled: true });
    mocks.test.mockResolvedValue({ success: true, tools: [] });
    show();
    openApp('chrome');
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.jr.mcp.connect' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.connect' }));
    expect(await screen.findByText('common.jr.mcp.connected')).toBeInTheDocument();
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(mocks.toggle).not.toHaveBeenCalled();
  });

  it('does not claim Chrome is connected after a failed discovery', async () => {
    mocks.list.mockResolvedValue([chrome]);
    mocks.test.mockRejectedValue(new Error('private backend detail'));
    show();
    openApp('chrome');
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.jr.mcp.connect' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.connect' }));
    expect(await screen.findByText('common.jr.mcp.appConnectError')).toBeInTheDocument();
    expect(screen.queryByText('common.jr.mcp.connected')).not.toBeInTheDocument();
    expect(screen.queryByText('private backend detail')).not.toBeInTheDocument();
  });
});

describe('advanced connection list and tests', () => {
  it('distinguishes load failure from an empty list and retries through the backend', async () => {
    mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    show();
    expect(await screen.findByText('common.jr.mcp.loadError')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.reload' }));
    await waitFor(() => expect(screen.queryByText('common.jr.mcp.loadError')).not.toBeInTheDocument());
    await openAdvanced();
    expect(screen.getByText('common.jr.mcp.empty')).toBeInTheDocument();
  });

  it('does not treat a stored last-test result as a verified current connection', async () => {
    mocks.list.mockResolvedValue([local]);
    show();
    await openAdvanced();
    expect(screen.getByText('common.jr.mcp.untested')).toBeInTheDocument();
    expect(mocks.test).not.toHaveBeenCalled();
    expect(screen.queryByText('common.jr.mcp.verified')).not.toBeInTheDocument();
  });

  it('shows tools only after real discovery and clears success after a failed retest', async () => {
    mocks.list.mockResolvedValue([local]);
    mocks.test
      .mockResolvedValueOnce({ success: true, tools: [{ name: 'click' }] })
      .mockResolvedValueOnce({ success: false, code: 'MCP_COMMAND_NOT_FOUND' });
    show();
    await openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.test' }));
    expect(await screen.findByText('common.jr.mcp.toolCount 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.test' }));
    expect(await screen.findByText('common.jr.mcp.runtimeMissing')).toBeInTheDocument();
    expect(screen.queryByText('common.jr.mcp.verified')).not.toBeInTheDocument();
  });

  it('handles a rejected test without displaying private transport details', async () => {
    mocks.list.mockResolvedValue([local]);
    mocks.test.mockRejectedValue(new Error('private backend detail'));
    show();
    await openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.test' }));
    expect(await screen.findByText('common.jr.mcp.testFailed')).toBeInTheDocument();
    expect(screen.queryByText('private backend detail')).not.toBeInTheDocument();
  });

  it('keeps Gmail authorization unavailable when its OAuth client has not been configured', async () => {
    mocks.list.mockResolvedValue([remote]);
    mocks.test.mockResolvedValue({ success: false, needs_auth: true, auth_method: 'oauth' });
    show();
    await openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.test' }));
    expect(await screen.findByText('common.jr.mcp.authRequired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.jr.mcp.authorize' })).not.toBeInTheDocument();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('retests a compatible remote server after native OAuth before verification', async () => {
    mocks.list.mockResolvedValue([
      { ...remote, name: 'Remote server', transport: { type: 'http', url: 'https://example.test/mcp' } },
    ]);
    mocks.test
      .mockResolvedValueOnce({ success: false, needsAuth: true, authMethod: 'oauth' })
      .mockResolvedValueOnce({ success: true, tools: [] });
    mocks.login.mockResolvedValue({ success: true });
    show();
    await openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.test' }));
    fireEvent.click(await screen.findByRole('button', { name: 'common.jr.mcp.authorize' }));
    expect(await screen.findByText('common.jr.mcp.verified')).toBeInTheDocument();
    expect(mocks.test).toHaveBeenCalledTimes(2);
    expect(mocks.login).toHaveBeenCalledWith({ server_url: 'https://example.test/mcp' });
  });

  it('reflects the persisted enabled state and retains it after a failed toggle', async () => {
    mocks.list.mockResolvedValue([local]);
    mocks.toggle.mockResolvedValueOnce({ ...local, enabled: true }).mockRejectedValueOnce(new Error('offline'));
    show();
    await openAdvanced();
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    expect(await screen.findByText('common.jr.mcp.actionError')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('blocks enabling pending Gmail but permits disabling an active pending record', async () => {
    mocks.list.mockResolvedValue([{ ...remote, enabled: true }]);
    mocks.toggle.mockResolvedValue({ ...remote, enabled: false });
    show();
    await openAdvanced();
    const toggle = screen.getByRole('switch');
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(toggle).toBeDisabled();
  });

  it('renders built-in names in Portuguese while retaining the wire name for the backend', async () => {
    const builtin = { ...local, id: 'browser', name: 'aionui-browser', builtin: true };
    mocks.list.mockResolvedValue([
      builtin,
      { ...builtin, id: 'image', name: 'aionui-image-generation' },
      { ...builtin, id: 'chrome', name: 'chrome-devtools' },
    ]);
    mocks.test.mockResolvedValue({ success: true, tools: [] });
    show();
    await openAdvanced();
    expect(screen.getByRole('article', { name: 'common.jr.mcp.imageCreation' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'common.jr.mcp.integratedChrome' })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('article', { name: 'common.jr.mcp.appBrowser' })).getByRole('button', {
        name: 'common.jr.mcp.test',
      })
    );
    await waitFor(() => expect(mocks.test).toHaveBeenCalledWith(expect.objectContaining({ name: 'aionui-browser' })));
  });
});

describe('advanced connection configuration form', () => {
  it('keeps a partially saved remote record visible after returning to the catalogue', async () => {
    mocks.create.mockResolvedValue({ ...remote, enabled: true });
    mocks.toggle.mockRejectedValue(new Error('offline'));
    show();
    await beginGmailSetup();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await screen.findByText('common.jr.mcp.partialSaveError');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    const article = await screen.findByRole('article', { name: remote.name });
    expect(within(article).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('retries a partially saved remote record without creating another', async () => {
    mocks.create.mockResolvedValue({ ...remote, enabled: true });
    mocks.toggle.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...remote, enabled: false });
    mocks.update.mockResolvedValue({ ...remote, enabled: true });
    show();
    await beginGmailSetup();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('common.jr.mcp.partialSaveError')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(screen.queryByLabelText('common.jr.mcp.name')).not.toBeInTheDocument());
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ id: remote.id }));
  });

  it('saves unconfigured Gmail disabled when the backend creates it enabled', async () => {
    mocks.create.mockResolvedValue({ ...remote, enabled: true });
    mocks.toggle.mockResolvedValue({ ...remote, enabled: false });
    show();
    await beginGmailSetup();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    const article = await screen.findByRole('article', { name: remote.name });
    expect(mocks.toggle).toHaveBeenCalledWith({ id: remote.id });
    expect(within(article).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(within(article).getByRole('switch')).toBeDisabled();
  });

  it('retains custom configuration after a failed save', async () => {
    mocks.create.mockRejectedValue(new Error('offline'));
    show();
    await openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.customAction' }));
    fireEvent.change(screen.getByLabelText('common.jr.mcp.name'), { target: { value: 'Custom local' } });
    fireEvent.change(screen.getByLabelText('common.jr.mcp.command'), { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('common.jr.mcp.saveError')).toBeInTheDocument();
    expect(screen.getByLabelText('common.jr.mcp.name')).toHaveValue('Custom local');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('rejects malformed arguments before calling a save API', async () => {
    show();
    await openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'common.jr.mcp.customAction' }));
    fireEvent.change(screen.getByLabelText('common.jr.mcp.name'), { target: { value: 'Custom' } });
    fireEvent.change(screen.getByLabelText('common.jr.mcp.command'), { target: { value: 'node' } });
    fireEvent.change(screen.getByLabelText('common.jr.mcp.arguments'), { target: { value: '{broken' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('common.jr.mcp.invalidArguments')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('updates a persisted local server without losing its environment', async () => {
    const configured: IMcpServer = {
      ...local,
      transport: { type: 'stdio', command: 'node', env: { MODE: 'private' } },
    };
    mocks.list.mockResolvedValue([configured]);
    mocks.update.mockImplementation(async ({ data }: { data: Partial<IMcpServer> }) => ({ ...configured, ...data }));
    show();
    await openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(screen.getByLabelText('common.jr.mcp.name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByRole('article', { name: 'Renamed' })).toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: local.id,
        data: expect.objectContaining({ transport: expect.objectContaining({ env: { MODE: 'private' } }) }),
      })
    );
  });
});
