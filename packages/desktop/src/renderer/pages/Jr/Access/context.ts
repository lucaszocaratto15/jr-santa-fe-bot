import type { JrAccessState } from '@/common/config/clientSettings';
import { createContext, useContext } from 'react';

export type JrAccessContextValue = { state: JrAccessState; logout: () => Promise<void> };
export const JrAccessContext = createContext<JrAccessContextValue | undefined>(undefined);
export function useJrAccess(): JrAccessContextValue {
  const value = useContext(JrAccessContext);
  if (!value) throw new Error('Company access provider is missing');
  return value;
}
