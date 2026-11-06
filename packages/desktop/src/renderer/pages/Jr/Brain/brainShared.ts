import { BRAIN_FALLBACK_AREA_NAME, type BrainManagedFact } from '@/common/types/agent/brainTypes';
import { ipcBridge } from '@/common';
import { useSyncExternalStore } from 'react';

let contextVersion = 0;
const contextListeners = new Set<() => void>();
const invalidateBrainContext = (): void => {
  contextVersion++;
  for (const listener of contextListeners) listener();
};
ipcBridge.jr?.strata?.changed?.on?.(invalidateBrainContext);
ipcBridge.jr?.accessChanged?.on?.((state) => {
  if (state.status !== 'authenticated') invalidateBrainContext();
});
const subscribeContext = (listener: () => void): (() => void) => {
  contextListeners.add(listener);
  return () => contextListeners.delete(listener);
};
export const getBrainContextVersion = (): number => contextVersion;

/** A changed ERP account or company must never reuse a previous company's cached content. */
export const useBrainContextVersion = (): number =>
  useSyncExternalStore(subscribeContext, getBrainContextVersion, getBrainContextVersion);

export type BrainAreaOption = { id: number; name: string; isGeneral: boolean; isFallback: boolean };

/** Author names by user id; null when the caller cannot list employees (only the owner can). */
export type BrainPeople = Map<string, string> | null;

const ERROR_KEYS = {
  BRAIN_REJECTED: 'common.jr.brainManage.errors.rejected',
  BRAIN_CONFLICT: 'common.jr.brainManage.errors.conflict',
  BRAIN_FORBIDDEN: 'common.jr.brainManage.errors.forbidden',
  BRAIN_NOT_FOUND: 'common.jr.brainManage.errors.notFound',
} as const;

/** i18n key for a rejected manager IPC call (the main process sends `BRAIN_*` as the message). */
export const brainErrorKey = (
  failure: unknown
): (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] | 'common.jr.brainManage.errors.generic' => {
  const message = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '';
  const code = (Object.keys(ERROR_KEYS) as Array<keyof typeof ERROR_KEYS>).find((known) => message.includes(known));
  return code ? ERROR_KEYS[code] : 'common.jr.brainManage.errors.generic';
};

export const isGeneralFact = (fact: BrainManagedFact, areas: BrainAreaOption[]): boolean =>
  areas.some((area) => area.id === fact.areaId && area.isGeneral);

/** Promotion to Geral is only for low-risk facts that are not there yet. */
export const canPromote = (fact: BrainManagedFact, areas: BrainAreaOption[]): boolean =>
  fact.risk === 'low' && !isGeneralFact(fact, areas);

/** Geral and the owner-only fallback cannot be renamed, removed or assigned to people. */
export const isProtectedArea = (area: { name: string; isGeneral: boolean }): boolean =>
  area.isGeneral || area.name === BRAIN_FALLBACK_AREA_NAME;
