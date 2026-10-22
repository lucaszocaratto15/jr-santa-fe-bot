import { application, mcpService, shell } from '@/common/adapter/ipcBridge';
import type { IMcpServer } from '@/common/config/storage';
import { useCallback, useState } from 'react';
import useSWR from 'swr';
import {
  ConnectionSaveError,
  connectionPayload,
  createChromeDraft,
  isGmailServer,
  isJrChromeServer,
} from './connections';

export type ConnectionTest = {
  state: 'testing' | 'verified' | 'authRequired' | 'failed';
  toolCount?: number;
  oauth?: boolean;
  errorKey?: 'testFailed' | 'runtimeMissing' | 'timeout' | 'authFailed';
};

/** Shares real backend state between the approved app flow and the admin controls. */
export const useConnections = () => {
  const {
    data: servers = [],
    error,
    isLoading,
    mutate,
  } = useSWR('jr.mcp.servers', () => mcpService.listServers.invoke(), {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });
  const [tests, setTests] = useState<Record<string, ConnectionTest>>({});
  const [pending, setPending] = useState('');
  const [actionError, setActionError] = useState('');

  const replaceServer = useCallback(
    async (server: IMcpServer) => {
      await mutate((current = []) => [...current.filter((item) => item.id !== server.id), server], {
        revalidate: false,
      });
      setTests((current) => {
        const next = { ...current };
        delete next[server.id];
        return next;
      });
    },
    [mutate]
  );

  const save = async (payload: ReturnType<typeof connectionPayload>, server?: IMcpServer): Promise<IMcpServer> => {
    let saved = server
      ? await mcpService.updateServer.invoke({ id: server.id, data: payload })
      : await mcpService.createServer.invoke(payload);
    if (saved.enabled && isGmailServer(saved)) {
      try {
        saved = await mcpService.toggleServer.invoke({ id: saved.id });
      } catch {
        await replaceServer(saved);
        throw new ConnectionSaveError(saved);
      }
    }
    await replaceServer(saved);
    return saved;
  };

  const test = useCallback(async (server: IMcpServer): Promise<ConnectionTest> => {
    setTests((current) => ({ ...current, [server.id]: { state: 'testing' } }));
    let next: ConnectionTest;
    try {
      const result = await mcpService.testMcpConnection.invoke({ ...server, runtime_scope_id: server.id });
      next =
        (result.needsAuth ?? result.needs_auth)
          ? { state: 'authRequired', oauth: (result.authMethod ?? result.auth_method) === 'oauth' }
          : result.success
            ? { state: 'verified', toolCount: result.tools?.length }
            : {
                state: 'failed',
                errorKey:
                  result.code === 'MCP_COMMAND_NOT_FOUND'
                    ? 'runtimeMissing'
                    : result.code === 'MCP_TIMEOUT'
                      ? 'timeout'
                      : 'testFailed',
              };
    } catch {
      next = { state: 'failed', errorKey: 'testFailed' };
    }
    setTests((current) => ({ ...current, [server.id]: next }));
    return next;
  }, []);

  const connectChrome = async () => {
    setPending('chrome');
    setActionError('');
    try {
      let server = servers.find(isJrChromeServer);
      if (!server) {
        const { cacheDir } = await application.systemInfo.invoke();
        server = await save(connectionPayload(createChromeDraft(cacheDir)));
      }
      const result = await test(server);
      if (result.state !== 'verified') {
        setActionError('appConnectError');
        return;
      }
      if (!server.enabled) {
        const enabled = await mcpService.toggleServer.invoke({ id: server.id });
        await replaceServer(enabled);
        setTests((current) => ({ ...current, [enabled.id]: result }));
      }
    } catch {
      setActionError('appConnectError');
    } finally {
      setPending('');
    }
  };

  const toggle = async (server: IMcpServer) => {
    if (isGmailServer(server) && !server.enabled) return;
    setPending(server.id);
    setActionError('');
    try {
      await replaceServer(await mcpService.toggleServer.invoke({ id: server.id }));
    } catch {
      setActionError('actionError');
    } finally {
      setPending('');
    }
  };

  const authorize = async (server: IMcpServer) => {
    if (server.transport.type === 'stdio' || isGmailServer(server)) return;
    setPending(server.id);
    try {
      const result = await mcpService.loginMcpOAuth.invoke({ server_url: server.transport.url });
      if (!result.success) throw new Error('authFailed');
      await test(server);
    } catch {
      setTests((current) => ({ ...current, [server.id]: { state: 'failed', errorKey: 'authFailed' } }));
    } finally {
      setPending('');
    }
  };

  const openDocs = async (url: string) => {
    try {
      await shell.openExternal.invoke(url);
    } catch {
      setActionError('actionError');
    }
  };

  const refresh = () => {
    setTests({});
    void mutate().catch(() => {});
  };

  return {
    servers,
    error,
    isLoading,
    tests,
    pending,
    actionError,
    save,
    test,
    toggle,
    authorize,
    connectChrome,
    openDocs,
    refresh,
  };
};

export type ConnectionsController = ReturnType<typeof useConnections>;
