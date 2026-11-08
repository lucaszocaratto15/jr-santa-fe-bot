import React, { useState } from 'react';
import { Alert, Button, Checkbox, Input, Message, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type {
  WorkActionCategory,
  WorkMonthlyMap,
  WorkRoutine,
  WorkRoutineReview,
  WorkSourceType,
} from '@/common/types/agent/learnTypes';
import { SectionLabel } from '../Teach/PanelParts';
import styles from '../JrSidebar.module.css';

const sources: WorkSourceType[] = ['erp', 'web', 'desktop', 'integration', 'manual'];
const actions: WorkActionCategory[] = ['consulta', 'exportacao', 'preenchimento', 'envio', 'aprovacao', 'outro'];
const api = ipcBridge.learn.workflow;

function RoutineEditor({
  routine,
  save,
}: {
  routine: WorkRoutine;
  save: (review: WorkRoutineReview) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<WorkRoutineReview>({ ...routine });
  const [busy, setBusy] = useState(false);
  const review = async (status: WorkRoutineReview['status']) => {
    setBusy(true);
    try {
      await save({ ...draft, status });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${styles.card} flex flex-col gap-8px`}>
      <span className={styles.chip}>{t(`common.jr.learn.workflow.status.${routine.status}`)}</span>
      {!routine.suppressSuggestion && routine.status !== 'rejected' && (
        <Alert
          type='info'
          content={t('common.jr.learn.workflow.automationCandidate', { count: routine.steps.length })}
        />
      )}
      <p className={styles.muted}>
        {t(routine.observed ? 'common.jr.learn.workflow.observedEvidence' : 'common.jr.learn.workflow.manualEvidence')}
      </p>
      <Input
        aria-label={t('common.jr.learn.workflow.name')}
        value={draft.name}
        onChange={(name) => setDraft({ ...draft, name })}
        maxLength={120}
      />
      {draft.steps.map((step, index) => (
        <div key={step.id} className='flex flex-col gap-4px'>
          <Input
            aria-label={t('common.jr.learn.workflow.step')}
            value={step.label}
            maxLength={120}
            onChange={(value) =>
              setDraft({
                ...draft,
                steps: draft.steps.map((item, i) => (i === index ? { ...item, label: value } : item)),
              })
            }
          />
          <Select
            aria-label={t('common.jr.learn.workflow.source')}
            value={step.sourceType}
            onChange={(sourceType: WorkSourceType) =>
              setDraft({
                ...draft,
                steps: draft.steps.map((item, i) => (i === index ? { ...item, sourceType } : item)),
              })
            }
            options={sources.map((source) => ({
              value: source,
              label: t(`common.jr.learn.workflow.sources.${source}`),
            }))}
          />
          <Select
            aria-label={t('common.jr.learn.workflow.action')}
            value={step.actionCategory}
            onChange={(actionCategory: WorkActionCategory) =>
              setDraft({
                ...draft,
                steps: draft.steps.map((item, i) => (i === index ? { ...item, actionCategory } : item)),
              })
            }
            options={actions.map((action) => ({
              value: action,
              label: t(`common.jr.learn.workflow.actions.${action}`),
            }))}
          />
          <Button onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}>
            {t('common.delete')}
          </Button>
        </div>
      ))}
      <Input
        aria-label={t('common.jr.learn.workflow.inputs')}
        placeholder={t('common.jr.learn.workflow.inputs')}
        value={draft.inputs}
        maxLength={300}
        onChange={(inputs) => setDraft({ ...draft, inputs })}
      />
      <Input
        aria-label={t('common.jr.learn.workflow.outputs')}
        placeholder={t('common.jr.learn.workflow.outputs')}
        value={draft.outputs}
        maxLength={300}
        onChange={(outputs) => setDraft({ ...draft, outputs })}
      />
      <Input.TextArea
        aria-label={t('common.jr.learn.workflow.notes')}
        placeholder={t('common.jr.learn.workflow.notes')}
        value={draft.notes}
        maxLength={600}
        onChange={(notes) => setDraft({ ...draft, notes })}
      />
      <Checkbox checked={draft.eventual} onChange={(eventual) => setDraft({ ...draft, eventual })}>
        {t('common.jr.learn.workflow.eventual')}
      </Checkbox>
      <Checkbox
        checked={draft.excludedFromSummary}
        onChange={(excludedFromSummary) => setDraft({ ...draft, excludedFromSummary })}
      >
        {t('common.jr.learn.workflow.exclude')}
      </Checkbox>
      <Checkbox
        checked={draft.suppressSuggestion}
        onChange={(suppressSuggestion) => setDraft({ ...draft, suppressSuggestion })}
      >
        {t('common.jr.learn.workflow.suppress')}
      </Checkbox>
      <div className='flex flex-wrap gap-8px'>
        <Button type='primary' loading={busy} onClick={() => void review('confirmed')}>
          {t('common.jr.learn.workflow.confirm')}
        </Button>
        <Button loading={busy} onClick={() => void review('rejected')}>
          {t('common.jr.learn.workflow.reject')}
        </Button>
      </div>
    </div>
  );
}

/** Explicit markers and reviewed routines stay private; this component has no brain publishing path. */
export default function WorkflowPanel({ collecting, ownerId }: { collecting: boolean; ownerId: string | null }) {
  const { t } = useTranslation();
  const data = useSWR(ownerId ? ['jr.learn.workflow', ownerId] : null, () => api.state.invoke(), {
    refreshInterval: collecting ? 5000 : 0,
  });
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [sourceType, setSource] = useState<WorkSourceType>('web');
  const [actionCategory, setAction] = useState<WorkActionCategory>('consulta');
  const [month, setMonth] = useState(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
  const [map, setMap] = useState<WorkMonthlyMap | null>(null);
  const [mapRequested, setMapRequested] = useState(false);
  const [observations, setObservations] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      await data.mutate();
      setMap(null);
      setManual('');
    } catch {
      Message.error(t('common.jr.learn.workflow.error'));
    } finally {
      setBusy(false);
    }
  };
  const generateMap = async () => {
    try {
      const result = await api.monthly.invoke({ month });
      setMapRequested(true);
      setMap(result);
      setObservations(result?.observations ?? '');
      setManual('');
    } catch {
      Message.error(t('common.jr.learn.workflow.error'));
    }
  };
  const prepareManual = () => {
    if (!map) return;
    setManual(
      [
        t('common.jr.learn.workflow.draft'),
        month,
        t('common.jr.learn.workflow.responsibilities'),
        ...map.routines.map((routine) =>
          [
            routine.name,
            t('common.jr.learn.workflow.frequency', { count: routine.frequency }),
            t('common.jr.learn.workflow.systems'),
            ...[...new Set(routine.steps.map((step) => step.sourceType))].map((source) =>
              t(`common.jr.learn.workflow.sources.${source}`)
            ),
            t('common.jr.learn.workflow.steps'),
            ...routine.steps.map((step, index) => `${index + 1}. ${step.label}`),
            t('common.jr.learn.workflow.inputs'),
            routine.inputs,
            t('common.jr.learn.workflow.outputs'),
            routine.outputs,
            t('common.jr.learn.workflow.exceptions'),
            routine.notes,
          ].join('\n')
        ),
        t('common.jr.learn.workflow.pending', { count: map.pendingCount }),
        observations,
        t('common.jr.learn.workflow.opportunities'),
        t('common.jr.learn.workflow.opportunity'),
      ].join('\n\n')
    );
  };
  return (
    <div className='flex flex-col gap-12px'>
      <SectionLabel>{t('common.jr.learn.workflow.title')}</SectionLabel>
      <p className={styles.muted}>{t('common.jr.learn.workflow.privacy')}</p>
      <div className={`${styles.card} flex flex-col gap-8px`}>
        {data.data?.active ? (
          <>
            <p>{data.data.active.name}</p>
            <Input
              placeholder={t('common.jr.learn.workflow.step')}
              aria-label={t('common.jr.learn.workflow.step')}
              value={label}
              maxLength={120}
              onChange={setLabel}
            />
            <Select
              aria-label={t('common.jr.learn.workflow.source')}
              value={sourceType}
              onChange={setSource}
              options={sources.map((source) => ({
                value: source,
                label: t(`common.jr.learn.workflow.sources.${source}`),
              }))}
            />
            <Select
              aria-label={t('common.jr.learn.workflow.action')}
              value={actionCategory}
              onChange={setAction}
              options={actions.map((action) => ({
                value: action,
                label: t(`common.jr.learn.workflow.actions.${action}`),
              }))}
            />
            <Button
              disabled={!collecting || !label.trim() || busy}
              onClick={() =>
                void run(async () => {
                  await api.step.invoke({ label, sourceType, actionCategory });
                  setLabel('');
                })
              }
            >
              {t('common.jr.learn.workflow.addStep')}
            </Button>
            <Button
              disabled={!collecting || !data.data.active.steps.length || busy}
              onClick={() => void run(() => api.complete.invoke())}
            >
              {t('common.jr.learn.workflow.complete')}
            </Button>
            <ol>
              {data.data.active.steps.map((step) => (
                <li key={step.id}>{step.label}</li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <Input
              placeholder={t('common.jr.learn.workflow.name')}
              aria-label={t('common.jr.learn.workflow.name')}
              value={name}
              maxLength={120}
              onChange={setName}
            />
            <Button
              disabled={!collecting || !name.trim() || busy}
              onClick={() =>
                void run(async () => {
                  await api.start.invoke({ name });
                  setName('');
                })
              }
            >
              {t('common.jr.learn.workflow.start')}
            </Button>
          </>
        )}
      </div>
      <SectionLabel>{t('common.jr.learn.workflow.review')}</SectionLabel>
      {data.data?.routines.map((routine) => (
        <RoutineEditor
          key={`${routine.id}-${routine.status}`}
          routine={routine}
          save={async (review) => {
            await run(() => api.review.invoke(review));
          }}
        />
      ))}
      <div className={`${styles.card} flex flex-col gap-8px`}>
        <Input
          aria-label={t('common.jr.learn.workflow.month')}
          value={month}
          onChange={(value) => {
            setMonth(value);
            setMap(null);
            setManual('');
            setMapRequested(false);
          }}
          maxLength={7}
        />
        <Button disabled={busy} onClick={() => void generateMap()}>
          {t('common.jr.learn.workflow.monthly')}
        </Button>
        {mapRequested && !map && <Alert content={t('common.jr.learn.workflow.insufficient')} />}
        {map && (
          <>
            {map.routines.map((routine, index) => (
              <div key={`${routine.name}-${index}`}>
                <p>
                  {routine.name} — {t('common.jr.learn.workflow.frequency', { count: routine.frequency })}
                </p>
                <ol>
                  {routine.steps.map((step) => (
                    <li key={step.id}>{step.label}</li>
                  ))}
                </ol>
              </div>
            ))}
            <p>{t('common.jr.learn.workflow.pending', { count: map.pendingCount })}</p>
            <Input.TextArea
              aria-label={t('common.jr.learn.workflow.notes')}
              value={observations}
              onChange={setObservations}
              maxLength={600}
            />
            <Button onClick={() => void run(() => api.observations.invoke({ month, text: observations }))}>
              {t('common.jr.learn.workflow.saveNotes')}
            </Button>
            <Button onClick={prepareManual}>{t('common.jr.learn.workflow.manual')}</Button>
          </>
        )}
        {manual && (
          <>
            <Alert type='info' content={t('common.jr.learn.workflow.draft')} />
            <Input.TextArea
              aria-label={t('common.jr.learn.workflow.draft')}
              value={manual}
              onChange={setManual}
              autoSize={{ minRows: 8 }}
            />
          </>
        )}
      </div>
    </div>
  );
}
