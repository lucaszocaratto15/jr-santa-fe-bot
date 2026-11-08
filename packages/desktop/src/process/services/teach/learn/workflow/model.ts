import type { WorkMonthlyMap, WorkRoutine, WorkRoutineReview, WorkStep } from '@/common/types/agent/learnTypes';

export const SOURCE_TYPES = new Set(['erp', 'web', 'desktop', 'integration', 'manual']);
export const ACTION_CATEGORIES = new Set(['consulta', 'exportacao', 'preenchimento', 'envio', 'aprovacao', 'outro']);

const ERP_LIST_READS = new Set([
  'frota.equipamentos.listar',
  'frota.os.listar',
  'obras.listar',
  'compras.aprovacoes.minhas',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Accept only actual successful query receipts from the known ERP contract, never model assertions. */
export function isObservedErpRead(name: string, result: Record<string, unknown>): boolean {
  if (result.isError === true || (!ERP_LIST_READS.has(name) && name !== 'frota.equipamentos.obter')) return false;
  let data: unknown = result.structuredContent;
  if (!record(data)) {
    if (!Array.isArray(result.content) || result.content.length !== 1) return false;
    const [item] = result.content;
    if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') return false;
    try {
      data = JSON.parse(item.text);
    } catch {
      return false;
    }
  }
  if (
    !record(data) ||
    data.ok === false ||
    ['error', 'errors', 'consent_url', 'confirmation_id', 'status'].some((key) => key in data)
  )
    return false;
  return ERP_LIST_READS.has(name)
    ? Array.isArray(data.items) &&
        record(data.page) &&
        Number.isInteger(data.page.limit) &&
        Number(data.page.limit) > 0 &&
        Number.isInteger(data.page.offset) &&
        Number(data.page.offset) >= 0 &&
        Number.isInteger(data.page.total) &&
        Number(data.page.total) >= 0
    : typeof data.id === 'string' &&
        data.id.length > 0 &&
        'codigo' in data &&
        (data.codigo === null || typeof data.codigo === 'string');
}

/** Only generic labels belong in workflow markers, never copied page or document content. */
export function workLabel(value: unknown, max = 120): string {
  if (typeof value !== 'string') throw new Error('invalid_workflow');
  const text = value.trim();
  if (
    text.length > max ||
    /[\r\n]|https?:|www\.|@|\d{4,}|\b(?:token|senha|password|cookie|secret|cpf|cnpj)\b/i.test(text)
  ) {
    throw new Error('sensitive_workflow');
  }
  return text;
}

export function validateStep(step: WorkStep): WorkStep {
  if (!step || !SOURCE_TYPES.has(step.sourceType) || !ACTION_CATEGORIES.has(step.actionCategory)) {
    throw new Error('invalid_workflow');
  }
  const label = workLabel(step.label);
  if (!label) throw new Error('invalid_workflow');
  return { id: step.id, label, sourceType: step.sourceType, actionCategory: step.actionCategory };
}

export function applyReview(routine: WorkRoutine, review: WorkRoutineReview): WorkRoutine {
  if (
    !['candidate', 'confirmed', 'rejected'].includes(review.status) ||
    !Array.isArray(review.steps) ||
    review.steps.length > 40
  ) {
    throw new Error('invalid_workflow');
  }
  const name = workLabel(review.name);
  if (!name || !review.steps.length) throw new Error('invalid_workflow');
  for (const flag of [review.eventual, review.excludedFromSummary, review.suppressSuggestion]) {
    if (typeof flag !== 'boolean') throw new Error('invalid_workflow');
  }
  const steps = review.steps.map(validateStep);
  if (steps.some((step) => !routine.steps.some((old) => old.id === step.id))) throw new Error('invalid_workflow');
  return {
    ...routine,
    name,
    steps,
    notes: workLabel(review.notes, 600),
    inputs: workLabel(review.inputs ?? '', 300),
    outputs: workLabel(review.outputs ?? '', 300),
    status: review.status,
    evidence: review.status === 'confirmed' ? 'medium' : 'weak',
    eventual: review.eventual,
    excludedFromSummary: review.excludedFromSummary,
    suppressSuggestion: review.suppressSuggestion,
  };
}

/** Application/window observations never enter the monthly map: only reviewed completed routines do. */
export function monthlyMap(routines: WorkRoutine[], month: string, observations = ''): WorkMonthlyMap | null {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('invalid_month');
  const inMonth = routines.filter((routine) => {
    if (routine.completedAt === null) return false;
    const date = new Date(routine.completedAt);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` === month;
  });
  const confirmed = inMonth.filter((routine) => routine.status === 'confirmed' && !routine.excludedFromSummary);
  if (!confirmed.length) return null;
  const grouped = new Map<string, WorkMonthlyMap['routines'][number]>();
  for (const routine of confirmed) {
    const key = JSON.stringify([
      routine.name.toLocaleLowerCase(),
      routine.steps.map((step) => [step.label.toLocaleLowerCase(), step.sourceType, step.actionCategory]),
      routine.inputs ?? '',
      routine.outputs ?? '',
      routine.notes,
      routine.eventual,
    ]);
    const previous = grouped.get(key);
    grouped.set(key, {
      name: routine.name,
      frequency: (previous?.frequency ?? 0) + 1,
      steps: routine.steps,
      notes: routine.notes,
      inputs: routine.inputs ?? '',
      outputs: routine.outputs ?? '',
      eventual: routine.eventual,
    });
  }
  return {
    month,
    routines: [...grouped.values()],
    pendingCount: inMonth.filter((routine) => routine.status === 'candidate' && !routine.suppressSuggestion).length,
    observations,
  };
}
