import { ipcBridge } from '@/common';
import type { LearnState } from '@/common/types/agent/learnTypes';
import { useAddEventListener } from '@renderer/utils/emitter';
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

const RECONSENT_ASKED_KEY = 'jr.learn.reconsentAsked';

/**
 * Opens Configurações → Aprender on `jr.settings.open` (the 🧠 menu), and once per session
 * when the term changed after a prior accept (with the term modal: `autoConsent`).
 */
export function useLearnSettingsRequests(open: (autoConsent: boolean) => void): void {
  const { state } = useLearnState();
  const needsReconsent = state?.status === 'needs-consent' && state.acceptedVersion !== null;

  useAddEventListener('jr.settings.open', ({ autoConsent }) => open(Boolean(autoConsent)), [open]);

  useEffect(() => {
    if (!needsReconsent) return;
    try {
      if (sessionStorage.getItem(RECONSENT_ASKED_KEY)) return;
      sessionStorage.setItem(RECONSENT_ASKED_KEY, '1');
    } catch {
      // Storage unavailable: still ask, once per mount.
    }
    open(true);
  }, [needsReconsent, open]);
}
