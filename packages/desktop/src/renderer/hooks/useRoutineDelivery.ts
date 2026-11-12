import { ipcBridge } from '@/common';
import type { JrRoutineTrigger } from '@/common/types/agent/routineTypes';
import { Message } from '@arco-design/web-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * When main emits a pending webhook trigger, run the linked cron job and ack the control service.
 * Payload is never sent as an instruction; the cron job already carries the routine text.
 */
export function useRoutineDelivery(): void {
  const { t } = useTranslation();
  const busy = useRef(new Set<string>());

  useEffect(() => {
    const routines = ipcBridge.jr?.routines;
    if (!routines?.deliver?.on) return;
    const off = routines.deliver.on((trigger: JrRoutineTrigger) => {
      if (busy.current.has(trigger.id)) return;
      busy.current.add(trigger.id);
      void (async () => {
        try {
          await ipcBridge.cron.runNow.invoke({ job_id: trigger.cronJobId });
          await routines.ack.invoke({
            routineId: trigger.routineId,
            triggerId: trigger.id,
            outcome: 'delivered',
          });
          Message.success(t('cron.webhook.delivered', { name: trigger.name }));
        } catch {
          try {
            await routines.ack.invoke({
              routineId: trigger.routineId,
              triggerId: trigger.id,
              outcome: 'failed',
            });
          } catch {
            // Delivery already failed; a second ack error must not loop.
          }
          Message.error(t('cron.webhook.deliverFailed', { name: trigger.name }));
        } finally {
          busy.current.delete(trigger.id);
        }
      })();
    });
    return () => off();
  }, [t]);
}
