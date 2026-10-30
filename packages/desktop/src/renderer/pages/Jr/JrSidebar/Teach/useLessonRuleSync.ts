import { ipcBridge } from '@/common';
import { useEffect } from 'react';
import { rewriteAllBotRules } from '../../jrBots';

/** Keeps every bot's rule in step with the general lessons: rewrites them when those change. */
export function useLessonRuleSync(): void {
  useEffect(
    () =>
      ipcBridge.teach.lessonsChanged.on(({ scope }) => {
        if (scope === 'general') void rewriteAllBotRules();
      }),
    []
  );
}
