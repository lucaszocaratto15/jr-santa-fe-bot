import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ObservedWorkSource,
  WorkEvent,
  WorkFlowState,
  WorkRoutineReview,
  WorkStep,
} from '@/common/types/agent/learnTypes';
import type { OsEncryption } from '@process/services/jr/auth';
import i18n from '@process/services/i18n';
import {
  encryptionUsable,
  ensurePrivateDir,
  INSIGHT_RETENTION_MS,
  RAW_RETENTION_MS,
  writePrivateFile,
} from '../sampleStore';
import { applyReview, monthlyMap, validateStep, workLabel } from './model';

export const MAX_WORKFLOW_BYTES = 4_194_304;
const OBSERVED_GAP_MS = 15 * 60_000;
// shortcut: time groups are review candidates; use business workflow IDs when a source supplies them.
const OBSERVED_MAX_MS = 2 * 60 * 60_000;
const MAX_OBSERVED_ROUTINES = 200;
const sequenceSignature = (steps: WorkStep[]) =>
  JSON.stringify(steps.map((item) => [item.sourceType, item.actionCategory]));

type WorkflowFile = WorkFlowState & { version: 1; events: WorkEvent[]; observations: Record<string, string> };
type WorkflowDeps = {
  root: string;
  encryption: OsEncryption;
  currentUser: () => { id: string } | null;
  collecting: () => boolean;
  now: () => number;
};

/** Local encrypted records are partitioned by the authenticated employee, never sent to the brain. */
export function createWorkflows(deps: WorkflowDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const owner = () => {
    if (!encryptionUsable(deps.encryption)) throw new Error('workflow_unavailable');
    const id = deps.currentUser()?.id;
    if (!id) throw new Error('workflow_unavailable');
    return id;
  };
  const fileFor = (id: string) => join(deps.root, `workflow-${createHash('sha256').update(id).digest('hex')}.bin`);
  const loadFile = async (file: string): Promise<WorkflowFile> => {
    try {
      const encrypted = await readFile(file, 'utf8');
      if (Buffer.byteLength(encrypted) > MAX_WORKFLOW_BYTES) throw new Error('invalid_workflow_storage');
      const value: unknown = JSON.parse(deps.encryption.decryptString(Buffer.from(encrypted, 'base64')));
      if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('routines' in value) ||
        !Array.isArray(value.routines) ||
        !('events' in value) ||
        !Array.isArray(value.events) ||
        !('observations' in value) ||
        !value.observations ||
        typeof value.observations !== 'object'
      )
        throw new Error('invalid_workflow_storage');
      return value as WorkflowFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 1, active: null, routines: [], events: [], observations: {} };
    }
  };
  const prune = (data: WorkflowFile): boolean => {
    const before = JSON.stringify(data);
    const now = deps.now();
    data.events = data.events.filter((item) => now - item.occurredAt < RAW_RETENTION_MS);
    data.routines = data.routines.filter((item) => now - (item.completedAt ?? item.startedAt) < INSIGHT_RETENTION_MS);
    if (data.active && now - data.active.startedAt >= INSIGHT_RETENTION_MS) data.active = null;
    for (const month of Object.keys(data.observations)) {
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || now - Date.parse(`${month}-01T00:00:00Z`) >= INSIGHT_RETENTION_MS)
        delete data.observations[month];
    }
    return before !== JSON.stringify(data);
  };
  const transact = <T>(
    run: (data: WorkflowFile) => T | Promise<T>,
    write = true,
    guard?: () => boolean
  ): Promise<T> => {
    let requester: string;
    try {
      requester = owner();
    } catch (error) {
      return Promise.reject(error);
    }
    const sameOwner = () => {
      if (owner() !== requester) throw new Error('workflow_identity_changed');
      if (guard && !guard()) throw new Error('workflow_observation_stale');
    };
    const operation = chain
      .catch(() => {})
      .then(async () => {
        sameOwner();
        const data = await loadFile(fileFor(requester));
        sameOwner();
        const pruned = prune(data);
        const result = await run(data);
        sameOwner();
        if (write || pruned) {
          const encrypted = deps.encryption.encryptString(JSON.stringify(data)).toString('base64');
          if (Buffer.byteLength(encrypted) > MAX_WORKFLOW_BYTES) throw new Error('workflow_storage_full');
          await ensurePrivateDir(deps.root);
          sameOwner();
          await writePrivateFile(fileFor(requester), encrypted, sameOwner);
        }
        sameOwner();
        return result;
      });
    chain = operation;
    return operation;
  };
  const recording = () => {
    if (!deps.collecting()) throw new Error('workflow_consent_required');
  };
  const event = (data: WorkflowFile, eventType: WorkEvent['eventType'], workflowKey: string, step?: WorkStep) => {
    data.events.push({
      id: randomUUID(),
      eventType,
      sourceType: 'manual',
      sourceId: 'jr-manual',
      actionCategory: step?.actionCategory ?? 'outro',
      workflowKey,
      occurredAt: deps.now(),
      evidence: 'strong',
      metadata: { systemCategory: step?.sourceType ?? 'manual' },
    });
  };
  return {
    async purge() {
      if (!encryptionUsable(deps.encryption)) return;
      const names = await readdir(deps.root).catch((): string[] => []);
      const operation = chain
        .catch(() => {})
        .then(async () => {
          for (const name of names.filter((item) => /^workflow-[a-f0-9]{64}\.bin$/.test(item))) {
            const file = join(deps.root, name);
            try {
              const data = await loadFile(file);
              if (prune(data)) {
                const encrypted = deps.encryption.encryptString(JSON.stringify(data)).toString('base64');
                if (Buffer.byteLength(encrypted) <= MAX_WORKFLOW_BYTES) await writePrivateFile(file, encrypted);
              }
            } catch {
              /* A corrupt file is preserved for recovery. */
            }
          }
        });
      chain = operation;
      await operation;
    },
    state: () => transact((data): WorkFlowState => ({ active: data.active, routines: data.routines }), false),
    observe: (source: ObservedWorkSource, id: string, guard: () => boolean) =>
      transact(
        (data) => {
          recording();
          if (!['erp.read', 'browser.download'].includes(source) || !/^[a-f0-9-]{36}$/i.test(id))
            throw new Error('invalid_workflow');
          if (data.events.some((item) => item.id === id)) return;
          const now = deps.now();
          const query = source === 'erp.read';
          const step: WorkStep = {
            id,
            label: i18n.t(
              query ? 'common.jr.learn.workflow.observedQuery' : 'common.jr.learn.workflow.observedDownload'
            ),
            sourceType: query ? 'erp' : 'web',
            actionCategory: query ? 'consulta' : 'exportacao',
          };
          let routine = data.active;
          if (!routine) {
            const previous = data.routines.at(-1);
            if (
              previous?.observed &&
              previous.status === 'candidate' &&
              previous.reviewedAt === undefined &&
              !previous.suppressSuggestion &&
              previous.steps.length < 40 &&
              now - (previous.completedAt ?? previous.startedAt) <= OBSERVED_GAP_MS &&
              now - previous.startedAt <= OBSERVED_MAX_MS
            )
              routine = previous;
            else {
              if (data.routines.filter((item) => item.observed).length >= MAX_OBSERVED_ROUTINES) return;
              routine = {
                id: randomUUID(),
                name: i18n.t('common.jr.learn.workflow.observedName'),
                startedAt: now,
                completedAt: now,
                status: 'candidate',
                evidence: 'weak',
                steps: [],
                notes: '',
                inputs: '',
                outputs: '',
                eventual: false,
                excludedFromSummary: false,
                suppressSuggestion: false,
                observed: true,
              };
              data.routines.push(routine);
            }
          }
          if (routine.steps.length >= 40) return;
          routine.steps.push(step);
          routine.observed = true;
          if (routine !== data.active) routine.completedAt = now;
          if (
            routine !== data.active &&
            data.routines.some(
              (item) =>
                item !== routine &&
                item.observed &&
                item.suppressSuggestion &&
                sequenceSignature(item.steps) === sequenceSignature(routine.steps)
            )
          ) {
            routine.status = 'rejected';
            routine.suppressSuggestion = true;
          }
          data.events.push({
            id,
            eventType: 'workflow_step_observed',
            sourceType: query ? 'erp' : 'web',
            sourceId: query ? 'jr-strata' : 'jr-browser',
            actionCategory: step.actionCategory,
            workflowKey: routine.id,
            occurredAt: now,
            evidence: 'strong',
            metadata: { systemCategory: step.sourceType },
          });
          data.events = data.events.slice(-2000);
        },
        true,
        guard
      ),
    start: (rawName: string) =>
      transact((data) => {
        recording();
        const name = workLabel(rawName);
        if (!name || data.active) throw new Error('invalid_workflow');
        data.active = {
          id: randomUUID(),
          name,
          startedAt: deps.now(),
          completedAt: null,
          status: 'candidate',
          evidence: 'weak',
          steps: [],
          notes: '',
          inputs: '',
          outputs: '',
          eventual: false,
          excludedFromSummary: false,
          suppressSuggestion: false,
        };
        event(data, 'workflow_started', data.active.id);
      }),
    step: (input: Omit<WorkStep, 'id'>) =>
      transact((data) => {
        recording();
        if (!data.active || data.active.steps.length >= 40) throw new Error('invalid_workflow');
        const step = validateStep({ ...input, id: randomUUID() });
        data.active.steps.push(step);
        event(data, 'workflow_step_observed', data.active.id, step);
      }),
    complete: () =>
      transact((data) => {
        recording();
        if (!data.active?.steps.length) throw new Error('invalid_workflow');
        data.active.completedAt = deps.now();
        const suppressed = data.routines.some(
          (routine) =>
            routine.suppressSuggestion && routine.name.toLocaleLowerCase() === data.active?.name.toLocaleLowerCase()
        );
        data.active.suppressSuggestion = suppressed;
        if (suppressed) data.active.status = 'rejected';
        data.routines.push(data.active);
        event(data, 'workflow_completed', data.active.id);
        data.active = null;
      }),
    review: (input: WorkRoutineReview) =>
      transact((data) => {
        const index = data.routines.findIndex((routine) => routine.id === input.id);
        if (index < 0) throw new Error('workflow_not_found');
        data.routines[index] = { ...applyReview(data.routines[index], input), reviewedAt: deps.now() };
      }),
    monthly: (month: string) =>
      transact((data) => monthlyMap(data.routines, month, data.observations[month] ?? ''), false),
    observations: (month: string, value: string) =>
      transact((data) => {
        monthlyMap(data.routines, month);
        data.observations[month] = workLabel(value, 600);
      }),
  };
}
