import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflows, MAX_WORKFLOW_BYTES } from '@/process/services/teach/learn/workflow';
import { isObservedErpRead, monthlyMap } from '@/process/services/teach/learn/workflow/model';
import type { WorkRoutine } from '@/common/types/agent/learnTypes';
import { fakeEncryption } from './fakes';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'private-workflow-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const t0 = Date.parse('2026-11-06T12:00:00Z');
function harness() {
  let user = 'employee-a';
  let active = false;
  let now = t0;
  const encryption = fakeEncryption();
  const service = createWorkflows({
    root,
    encryption,
    currentUser: () => (user ? { id: user } : null),
    collecting: () => active,
    now: () => now,
  });
  return {
    service,
    encryption,
    advance: (ms: number) => {
      now += ms;
    },
    consent: (enabled = true) => {
      active = enabled;
    },
    login: (id: string) => {
      user = id;
    },
  };
}
async function completed(h: ReturnType<typeof harness>) {
  h.consent();
  await h.service.start('Consulta de certidões');
  await h.service.step({ label: 'Consultar portal', sourceType: 'web', actionCategory: 'consulta' });
  await h.service.step({ label: 'Registrar resultado', sourceType: 'erp', actionCategory: 'preenchimento' });
  await h.service.complete();
  return (await h.service.state()).routines[0];
}
const reviewed = (routine: WorkRoutine) => ({ ...routine, status: 'confirmed' as const });
const erpResult = (body: unknown, isError?: boolean) => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  ...(isError === undefined ? {} : { isError }),
});

describe('private workflow markers', () => {
  it('creates no records before opt-in or while paused', async () => {
    const h = harness();
    await expect(h.service.start('Consulta')).rejects.toThrow('workflow_consent_required');
    expect(await readdir(root)).toEqual([]);
    h.consent();
    await h.service.start('Consulta');
    h.consent(false);
    await expect(h.service.step({ label: 'Consultar', sourceType: 'web', actionCategory: 'consulta' })).rejects.toThrow(
      'workflow_consent_required'
    );
    expect((await h.service.state()).active?.steps).toEqual([]);
  });
  it('keeps data encrypted and isolated from another employee', async () => {
    const h = harness();
    await completed(h);
    const raw = await readFile(join(root, (await readdir(root))[0]), 'utf8');
    expect(raw).not.toContain('certidões');
    h.login('employee-b');
    expect((await h.service.state()).routines).toEqual([]);
  });
  it.each(['https://portal.test/path?token=x', 'person@example.test', 'senha secreta', 'Documento 123456'])(
    'rejects sensitive marker text: %s',
    async (name) => {
      const h = harness();
      h.consent();
      await expect(h.service.start(name)).rejects.toThrow('sensitive_workflow');
      expect(await readdir(root)).toEqual([]);
    }
  );
  it('rejects source/action values outside the categorical contract', async () => {
    const h = harness();
    h.consent();
    await h.service.start('Consulta');
    await expect(
      h.service.step({ label: 'Consultar', sourceType: 'http://unsafe' as never, actionCategory: 'consulta' })
    ).rejects.toThrow('invalid_workflow');
    expect((await h.service.state()).active?.steps).toEqual([]);
  });
  it('requires an explicit review before a completed sequence enters a monthly map', async () => {
    const h = harness();
    const routine = await completed(h);
    expect(await h.service.monthly('2026-11')).toBeNull();
    await h.service.review(reviewed(routine));
    expect((await h.service.monthly('2026-11'))?.routines[0].steps).toHaveLength(2);
  });
  it('corrections and exclusions change the private map without publishing anything', async () => {
    const h = harness();
    const routine = await completed(h);
    await h.service.review({ ...reviewed(routine), name: 'Revisar certidões', eventual: true });
    expect((await h.service.monthly('2026-11'))?.routines[0]).toMatchObject({
      name: 'Revisar certidões',
      eventual: true,
    });
    await h.service.review({ ...reviewed(routine), excludedFromSummary: true });
    expect(await h.service.monthly('2026-11')).toBeNull();
  });
  it('rejection and suppression keep future matching candidates out of the map', async () => {
    const h = harness();
    const routine = await completed(h);
    await h.service.review({ ...routine, status: 'rejected', suppressSuggestion: true });
    await completed(h);
    expect((await h.service.state()).routines[1].status).toBe('rejected');
    expect(await h.service.monthly('2026-11')).toBeNull();
  });
  it('stores observations privately and rejects invalid month or untrusted page metadata', async () => {
    const h = harness();
    const routine = await completed(h);
    await h.service.review(reviewed(routine));
    await h.service.observations('2026-11', 'Atividade eventual');
    expect((await h.service.monthly('2026-11'))?.observations).toBe('Atividade eventual');
    await expect(h.service.observations('2026-13', 'x')).rejects.toThrow('invalid_month');
    await expect(h.service.observations('2026-11', 'https://private.test?token=x')).rejects.toThrow(
      'sensitive_workflow'
    );
  });
  it('weak application observations alone cannot produce a monthly map', () => {
    expect(monthlyMap([], '2026-11')).toBeNull();
  });
});

describe('trusted work receipts', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  it('groups actual actions privately but never promotes an inferred sequence before review', async () => {
    const h = harness();
    h.consent();
    await h.service.observe('erp.read', first, () => true);
    h.advance(1000);
    await h.service.observe('browser.download', second, () => true);
    const [routine] = (await h.service.state()).routines;
    expect(routine).toMatchObject({ status: 'candidate', observed: true, evidence: 'weak' });
    expect(routine.steps.map((step) => [step.sourceType, step.actionCategory])).toEqual([
      ['erp', 'consulta'],
      ['web', 'exportacao'],
    ]);
    expect(await h.service.monthly('2026-11')).toBeNull();
    await h.service.review(reviewed(routine));
    expect((await h.service.monthly('2026-11'))?.routines[0].steps).toHaveLength(2);
  });
  it('deduplicates receipt IDs and keeps observed data encrypted', async () => {
    const h = harness();
    h.consent();
    await h.service.observe('erp.read', first, () => true);
    await h.service.observe('erp.read', first, () => true);
    expect((await h.service.state()).routines[0].steps).toHaveLength(1);
    const raw = await readFile(join(root, (await readdir(root))[0]), 'utf8');
    expect(raw).not.toContain('jr-strata');
  });
  it('discards a receipt when its original consent context expires before the queued write', async () => {
    const h = harness();
    h.consent();
    let valid = true;
    const pending = h.service.observe('erp.read', first, () => valid);
    valid = false;
    await expect(pending).rejects.toThrow('workflow_observation_stale');
    expect((await h.service.state()).routines).toEqual([]);
  });
  it('does not append new observations to a routine the employee already reviewed', async () => {
    const h = harness();
    h.consent();
    await h.service.observe('erp.read', first, () => true);
    const [routine] = (await h.service.state()).routines;
    await h.service.review(reviewed(routine));
    await h.service.observe('browser.download', second, () => true);
    expect((await h.service.state()).routines.map((item) => item.steps.length)).toEqual([1, 1]);
  });
  it('a real action adds only a categorical step to an explicitly active workflow', async () => {
    const h = harness();
    h.consent();
    await h.service.start('Consulta de certidões');
    await h.service.observe('browser.download', first, () => true);
    const state = await h.service.state();
    expect(state.active).toMatchObject({ observed: true, completedAt: null });
    expect(state.active?.steps[0]).toMatchObject({ sourceType: 'web', actionCategory: 'exportacao' });
    expect(state.routines).toEqual([]);
  });
  it('suppression applies to matching action sequences, not unrelated work', async () => {
    const h = harness();
    h.consent();
    await h.service.observe('erp.read', first, () => true);
    const [routine] = (await h.service.state()).routines;
    await h.service.review({ ...routine, status: 'rejected', suppressSuggestion: true });
    await h.service.observe('erp.read', second, () => true);
    await h.service.observe('browser.download', '33333333-3333-4333-8333-333333333333', () => true);
    expect((await h.service.state()).routines.map((item) => [item.status, item.suppressSuggestion])).toEqual([
      ['rejected', true],
      ['rejected', true],
      ['candidate', false],
    ]);
  });
  it('does not record a real receipt without current opt-in', async () => {
    const h = harness();
    await expect(h.service.observe('erp.read', first, () => true)).rejects.toThrow('workflow_consent_required');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('ERP read evidence', () => {
  it('recognizes the actual completed ERP query contract, including empty results', () => {
    expect(isObservedErpRead('obras.listar', erpResult({ items: [], page: { limit: 20, offset: 0, total: 0 } }))).toBe(
      true
    );
    expect(isObservedErpRead('frota.equipamentos.obter', erpResult({ id: 'equipment', codigo: 'EQ' }))).toBe(true);
  });
  it('accepts nullable ERP projection fields and item business status, but rejects a malformed page receipt', () => {
    expect(isObservedErpRead('frota.equipamentos.obter', erpResult({ id: 'equipment', codigo: null }))).toBe(true);
    expect(
      isObservedErpRead(
        'obras.listar',
        erpResult({ items: [{ status: 'EM ANDAMENTO' }], page: { limit: 20, offset: 0, total: 1 } })
      )
    ).toBe(true);
    expect(isObservedErpRead('obras.listar', erpResult({ items: [], page: 1 }))).toBe(false);
  });
  it('does not count rejected, pending, unrecognized, or malformed calls as completed work', () => {
    for (const receipt of [
      erpResult({ items: [], page: { limit: 20, offset: 0, total: 0 } }, true),
      erpResult({ items: [], page: { limit: 20, offset: 0, total: 0 }, error: 'denied' }),
      erpResult({ items: [], page: { limit: 20, offset: 0, total: 0 }, consent_url: 'https://erp.test/confirm' }),
      erpResult({ status: 'aguardando_consentimento' }),
      erpResult({ ok: false }),
      { content: [{ type: 'text', text: 'The bot says it completed' }] },
    ]) {
      expect(isObservedErpRead('obras.listar', receipt)).toBe(false);
    }
    expect(isObservedErpRead('unknown.read', erpResult({ items: [], page: { limit: 20, offset: 0, total: 0 } }))).toBe(
      false
    );
    expect(isObservedErpRead('compras.aprovacoes.decidir', erpResult({ status: 'aplicado' }))).toBe(false);
  });
});

describe('monthly evidence boundaries', () => {
  const routine: WorkRoutine = {
    id: 'example',
    name: 'Consulta',
    startedAt: t0,
    completedAt: t0,
    status: 'confirmed',
    evidence: 'medium',
    steps: [{ id: 'step', label: 'Consultar portal', sourceType: 'web', actionCategory: 'consulta' }],
    notes: '',
    inputs: '',
    outputs: '',
    eventual: false,
    excludedFromSummary: false,
    suppressSuggestion: false,
  };
  it('keeps same-named sequences with different sources or steps separate', () => {
    const other = { ...routine, id: 'other', steps: [{ ...routine.steps[0], sourceType: 'erp' as const }] };
    const map = monthlyMap([routine, { ...routine, id: 'repeat' }, other], '2026-11');
    expect(map?.routines.map((item) => item.frequency)).toEqual([2, 1]);
    expect(map?.routines.map((item) => item.steps[0].sourceType)).toEqual(['web', 'erp']);
  });
  it('uses the employee local calendar at a UTC month boundary', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    try {
      const atBoundary = { ...routine, completedAt: new Date(2026, 9, 31, 23, 30).getTime() };
      expect(monthlyMap([atBoundary], '2026-10')?.routines).toHaveLength(1);
      expect(monthlyMap([atBoundary], '2026-11')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('never uses an unconfirmed sequence or rejected routine as evidence of a role', () => {
    expect(
      monthlyMap(
        [
          { ...routine, status: 'candidate' },
          { ...routine, status: 'rejected' },
        ],
        '2026-11'
      )
    ).toBeNull();
  });
});

describe('workflow identity and storage boundaries', () => {
  it('rejects a queued operation when the initiating employee changes before execution', async () => {
    const h = harness();
    h.consent();
    const pending = h.service.start('Consulta');
    h.login('employee-b');
    await expect(pending).rejects.toThrow('workflow_identity_changed');
    expect(await readdir(root)).toEqual([]);
    expect((await h.service.state()).active).toBeNull();
  });
  it('rejects an oversized encrypted replacement and preserves the prior record', async () => {
    const h = harness();
    h.consent();
    await h.service.start('Consulta');
    const path = join(root, (await readdir(root))[0]);
    const before = await readFile(path, 'utf8');
    const spy = vi.spyOn(h.encryption, 'encryptString').mockReturnValue(Buffer.alloc(MAX_WORKFLOW_BYTES));
    await expect(h.service.step({ label: 'Consultar', sourceType: 'web', actionCategory: 'consulta' })).rejects.toThrow(
      'workflow_storage_full'
    );
    spy.mockRestore();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await h.service.state()).active?.steps).toEqual([]);
  });
  it('does not merge confirmed routines with different inputs, outputs or exceptions', () => {
    const routine: WorkRoutine = {
      id: 'r1',
      name: 'Consulta',
      startedAt: t0,
      completedAt: t0,
      status: 'confirmed',
      evidence: 'medium',
      steps: [{ id: 's1', label: 'Consultar', sourceType: 'web', actionCategory: 'consulta' }],
      inputs: 'Requisição',
      outputs: 'Resultado',
      notes: '',
      eventual: false,
      excludedFromSummary: false,
      suppressSuggestion: false,
    };
    const variations = [
      routine,
      { ...routine, inputs: 'Pedido' },
      { ...routine, outputs: 'Planilha' },
      { ...routine, notes: 'Exceção manual' },
    ];
    expect(monthlyMap(variations, '2026-11')?.routines).toHaveLength(4);
  });
});
