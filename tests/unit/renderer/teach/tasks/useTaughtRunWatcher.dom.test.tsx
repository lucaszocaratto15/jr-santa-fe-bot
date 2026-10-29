import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { IConversationArtifact, ICronJob } from '@/common/adapter/ipcBridge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts ? `${key}|${Object.values(opts).join('|')}` : key),
  }),
}));

const { listeners, getJob, navigate, notify } = vi.hoisted(() => ({
  listeners: [] as Array<(artifact: unknown) => void>,
  getJob: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

vi.mock('@arco-design/web-react', () => ({ Message: { info: vi.fn() } }));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      artifactStream: {
        on: (fn: (artifact: unknown) => void) => {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    },
    cron: { getJob: { invoke: getJob } },
    notification: { show: { invoke: notify } },
  },
}));

import { Message } from '@arco-design/web-react';
import { useTaughtRunWatcher } from '@renderer/pages/Jr/JrSidebar/Teach/useTaughtRunWatcher';
import { takeConversationIntent } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';

let seq = 0;
/** Each test gets fresh artifact ids: handled triggers are remembered for the window's life. */
const nextId = () => `a${++seq}`;

const trigger = (id = nextId(), jobId = 'job-1'): IConversationArtifact =>
  ({
    id,
    conversation_id: 'c1',
    cron_job_id: jobId,
    kind: 'cron_trigger',
    status: 'active',
    payload: { cron_job_id: jobId, cron_job_name: 'NFs', triggered_at: 1 },
    created_at: 1,
    updated_at: 1,
  }) as IConversationArtifact;

const cronJob = (text: string): ICronJob =>
  ({
    id: 'job-1',
    name: 'Relatório de NFs',
    target: { execution_mode: 'existing', payload: { kind: 'message', text } },
    metadata: { conversation_id: 'c1', agent_config: { assistant_id: 'b1' } },
  }) as unknown as ICronJob;

const emit = (artifact: IConversationArtifact) => listeners.forEach((fn) => fn(artifact));

describe('useTaughtRunWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
    notify.mockResolvedValue(undefined);
    takeConversationIntent('c1');
  });

  it('navigates and queues the browser intent for a taught job trigger', async () => {
    getJob.mockResolvedValue(cronJob('Execução agendada da tarefa salva `jr-tarefa-nfs`.'));
    renderHook(() => useTaughtRunWatcher());
    emit(trigger());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/conversation/c1?bot=b1'));
    expect(getJob).toHaveBeenCalledWith({ job_id: 'job-1' });
    expect(takeConversationIntent('c1')).toEqual({ openBrowser: true });
    expect(Message.info).toHaveBeenCalledWith('common.jr.teach.tasks.runningScheduled|Relatório de NFs');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'c1' }));
  });

  it('handles the same trigger only once', async () => {
    getJob.mockResolvedValue(cronJob('`jr-tarefa-nfs`'));
    renderHook(() => useTaughtRunWatcher());
    const same = trigger();
    emit(same);
    emit(same);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it('ignores cron_trigger of a non-taught job', async () => {
    getJob.mockResolvedValue(cronJob('Resumo diário das vendas'));
    renderHook(() => useTaughtRunWatcher());
    emit(trigger());
    await waitFor(() => expect(getJob).toHaveBeenCalled());
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(takeConversationIntent('c1')).toBeNull();
  });

  it('ignores skill_suggest artifacts', () => {
    renderHook(() => useTaughtRunWatcher());
    emit({ ...trigger(), kind: 'skill_suggest' } as unknown as IConversationArtifact);
    expect(getJob).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing when getJob rejects', async () => {
    getJob.mockRejectedValue(new Error('offline'));
    renderHook(() => useTaughtRunWatcher());
    emit(trigger());
    await waitFor(() => expect(getJob).toHaveBeenCalled());
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useTaughtRunWatcher());
    expect(listeners).toHaveLength(1);
    unmount();
    expect(listeners).toHaveLength(0);
  });
});
