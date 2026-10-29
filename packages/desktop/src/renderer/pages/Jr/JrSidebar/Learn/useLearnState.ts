import { ipcBridge } from '@/common';
import type { LearnState } from '@/common/types/agent/learnTypes';
import { useCallback, useEffect } from 'react';
import useSWR from 'swr';

export const LEARN_STATE_KEY = 'jr.learn.state';

/** "Aprender" state from main, kept fresh by `learn.stateChanged`. Never carries raw samples. */
export function useLearnState(): { state: LearnState | null; refresh: () => Promise<void> } {
  const { data, mutate } = useSWR(LEARN_STATE_KEY, () => ipcBridge.learn.state.invoke());

  useEffect(
    () =>
      ipcBridge.learn.stateChanged.on((next) => {
        void mutate(next, { revalidate: false });
      }),
    [mutate]
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return { state: data ?? null, refresh };
}
