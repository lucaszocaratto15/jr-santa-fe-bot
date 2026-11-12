/**
 * Webhook routines IPC and delivery nudge. Main collects pending triggers; the renderer
 * runs the linked cron job with the existing AionCore session, then acks.
 */

import { ipcBridge } from '@/common';
import type { JrAccessState } from '@/common/config/clientSettings';
import type { JrRoutineCreateInput, JrRoutineTrigger } from '@/common/types/agent/routineTypes';
import { createRoutinesClient, type RoutinesClient } from './routinesClient';

type RoutineCall = (path: string, init?: RequestInit) => Promise<unknown>;

let client: RoutinesClient | null = null;
let delivering: Promise<void> | null = null;

const requireClient = (): RoutinesClient => {
  if (!client) throw new Error('unavailable');
  return client;
};

/** Register IPC channels used by the Minhas tarefas panel. */
export function initRoutinesBridge(): void {
  ipcBridge.jr.routines.list.provider(async () => requireClient().list());
  ipcBridge.jr.routines.create.provider(async (input: JrRoutineCreateInput) => requireClient().create(input));
  ipcBridge.jr.routines.setEnabled.provider(async ({ id, enabled }) => requireClient().setEnabled(id, enabled));
  ipcBridge.jr.routines.ack.provider(async ({ routineId, triggerId, outcome }) =>
    requireClient().ack(routineId, triggerId, outcome ?? 'delivered')
  );
}

export function startRoutinesClient(call: RoutineCall): RoutinesClient {
  client = createRoutinesClient(call);
  return client;
}

/** After a successful session refresh, pull pending webhook triggers for the renderer to run. */
export function onRoutinesAccessChanged(status: JrAccessState['status']): void {
  if (status !== 'authenticated' || !client) return;
  if (delivering) return;
  delivering = (async () => {
    const triggers = await client!.pending();
    for (const trigger of triggers) {
      ipcBridge.jr.routines.deliver.emit(trigger);
    }
  })()
    .catch(() => {})
    .finally(() => {
      delivering = null;
    });
}

export type { JrRoutineTrigger };
