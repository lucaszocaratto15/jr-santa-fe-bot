/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Image, Input, Message, Modal, Select } from '@arco-design/web-react';
import { Delete } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type {
  HandbookActivityBody,
  HandbookDraft,
  HandbookError,
  HandbookIndicatorsBody,
  HandbookStep,
} from '@/common/types/agent/handbookTypes';
import MermaidBlock from '@renderer/components/Markdown/MermaidBlock';

const HANDBOOK_ERRORS: HandbookError[] = ['no_role', 'unavailable', 'forbidden', 'too_large'];

/** i18n key of a handbook IPC error (the code may be wrapped by the IPC layer). */
export function handbookErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = HANDBOOK_ERRORS.find((entry) => new RegExp(`(^|\\W)${entry}$`).test(message.trim()));
  return `common.jr.handbook.errors.${code ?? 'generic'}`;
}

const FREQUENCIES = ['daily', 'weekly', 'occasional'] as const;

type HandbookDraftEditorProps = { draft: HandbookDraft; onDone: () => void };

/** Draft screenshot of a step, read through main; the remove button drops it from the publish. */
const DraftShot: React.FC<{ draftKey: string; shot: number; onRemove: () => void }> = ({
  draftKey,
  shot,
  onRemove,
}) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipcBridge.jr.handbook.draftShot.invoke({ key: draftKey, shot }).then(
      (value) => alive && setUrl(value),
      () => alive && setUrl(null)
    );
    return () => {
      alive = false;
    };
  }, [draftKey, shot]);
  return (
    <div className='flex items-start gap-8px'>
      {url && <Image src={url} width={160} alt='' className='rd-8px overflow-hidden' />}
      <Button size='mini' type='text' icon={<Delete />} onClick={onRemove} data-testid={`remove-shot-${shot}`}>
        {t('common.jr.handbook.editor.removeShot')}
      </Button>
    </div>
  );
};

/**
 * Review of one draft. Only "Aprovar e publicar no manual", after a confirmation that names who
 * will see the item, sends it to the company server. Nothing waits for a manager.
 */
const HandbookDraftEditor: React.FC<HandbookDraftEditorProps> = ({ draft, onDone }) => {
  const { t } = useTranslation();
  const isActivity = draft.kind === 'activity';
  const [body, setBody] = useState<HandbookActivityBody | null>(
    isActivity ? (draft.body as HandbookActivityBody) : null
  );
  const [confirmText, setConfirmText] = useState(
    isActivity ? (draft.body as HandbookActivityBody).confirmBefore.join('\n') : ''
  );
  const [preview, setPreview] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edited: HandbookActivityBody | null = body
    ? {
        ...body,
        confirmBefore: confirmText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }
    : null;

  // The preview follows the visible fields; the JSON text is the effect's dependency.
  const previewSource = edited ? JSON.stringify(edited) : null;
  useEffect(() => {
    if (!previewSource) return;
    let alive = true;
    const timer = setTimeout(() => {
      ipcBridge.jr.handbook.preview.invoke({ body: JSON.parse(previewSource) as HandbookActivityBody }).then(
        (chart) => alive && setPreview(chart),
        () => {}
      );
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [previewSource]);

  const updateStep = (index: number, change: Partial<HandbookStep> | null) => {
    setBody((current) => {
      if (!current) return current;
      const steps = current.steps.flatMap((step, position) => {
        if (position !== index) return [step];
        if (change === null) return [];
        const next = { ...step, ...change };
        if ('shot' in change && change.shot === undefined) delete next.shot;
        return [next];
      });
      return { ...current, steps };
    });
  };

  const publish = async () => {
    setPublishing(true);
    setError(null);
    try {
      const keepShots = edited ? edited.steps.flatMap((step) => (step.shot === undefined ? [] : [step.shot])) : [];
      await ipcBridge.jr.handbook.publish.invoke({
        key: draft.key,
        body: edited ?? (draft.body as HandbookIndicatorsBody),
        keepShots,
      });
      Message.success(t('common.jr.handbook.editor.published'));
      setConfirming(false);
      onDone();
    } catch (failure) {
      setConfirming(false);
      setError(t(handbookErrorKey(failure)));
    } finally {
      setPublishing(false);
    }
  };

  const indicators = isActivity ? null : (draft.body as HandbookIndicatorsBody);
  return (
    <Modal
      visible
      title={t('common.jr.handbook.editor.title')}
      onCancel={onDone}
      className='!w-720px max-w-[calc(100vw-32px)]'
      footer={
        <Button
          type='primary'
          shape='round'
          loading={publishing}
          disabled={edited !== null && !edited.title.trim()}
          onClick={() => setConfirming(true)}
        >
          {t('common.jr.handbook.editor.approve')}
        </Button>
      }
    >
      <div className='flex flex-col gap-12px'>
        {error && <Alert type='error' content={error} />}
        {edited && body && (
          <>
            <div className='grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-12px'>
              <label className='flex flex-col gap-6px'>
                <span className='text-12px font-500 text-t-secondary'>{t('common.jr.handbook.editor.fieldTitle')}</span>
                <Input value={body.title} maxLength={120} onChange={(title) => setBody({ ...body, title })} />
              </label>
              <label className='flex flex-col gap-6px'>
                <span className='text-12px font-500 text-t-secondary'>
                  {t('common.jr.handbook.editor.fieldFrequency')}
                </span>
                <Select
                  value={body.frequency}
                  onChange={(frequency: HandbookActivityBody['frequency']) => setBody({ ...body, frequency })}
                  options={FREQUENCIES.map((value) => ({ value, label: t(`common.jr.handbook.frequency.${value}`) }))}
                />
              </label>
            </div>
            <label className='flex flex-col gap-6px'>
              <span className='text-12px font-500 text-t-secondary'>
                {t('common.jr.handbook.editor.fieldDescription')}
              </span>
              <Input.TextArea
                value={body.description}
                maxLength={2000}
                autoSize={{ minRows: 2, maxRows: 6 }}
                onChange={(description) => setBody({ ...body, description })}
              />
            </label>
            <h4 className='m-0 text-12px font-500 text-t-secondary'>{t('common.jr.handbook.editor.steps')}</h4>
            {body.steps.map((step, index) => (
              <div
                key={`${index}:${step.shot ?? ''}`}
                className='flex flex-col gap-8px rd-12px border border-solid border-[var(--jr-hairline)] p-8px'
                data-testid={`step-${index}`}
              >
                <div className='flex items-start gap-8px'>
                  <span className='mt-5px grid place-items-center shrink-0 w-20px h-20px rd-full bg-fill-2 text-11px text-t-secondary tabular-nums'>
                    {index + 1}
                  </span>
                  <Input.TextArea
                    aria-label={t('common.jr.handbook.editor.stepLabel', { index: index + 1 })}
                    value={step.text}
                    maxLength={1000}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    onChange={(text) => updateStep(index, { text })}
                  />
                  <Button
                    size='small'
                    type='text'
                    shape='circle'
                    icon={<Delete />}
                    aria-label={t('common.jr.handbook.editor.removeStep')}
                    onClick={() => updateStep(index, null)}
                  />
                </div>
                {step.shot !== undefined && (
                  <DraftShot
                    draftKey={draft.key}
                    shot={step.shot}
                    onRemove={() => updateStep(index, { shot: undefined })}
                  />
                )}
              </div>
            ))}
            <label className='flex flex-col gap-6px'>
              <span className='text-12px font-500 text-t-secondary'>
                {t('common.jr.handbook.editor.confirmBefore')}
              </span>
              <Input.TextArea value={confirmText} autoSize={{ minRows: 2, maxRows: 6 }} onChange={setConfirmText} />
            </label>
            <h4 className='m-0 text-12px font-500 text-t-secondary'>{t('common.jr.handbook.editor.preview')}</h4>
            {preview && <MermaidBlock code={preview} showOpenInPanelButton={false} />}
          </>
        )}
        {indicators && (
          <>
            <p className='text-t-secondary text-13px'>{t('common.jr.handbook.editor.indicatorsHint')}</p>
            <ul className='m-0 pl-18px text-13px'>
              {indicators.activities.map((activity) => (
                <li key={`a:${activity.title}`}>
                  {t('common.jr.handbook.indicators.activity', {
                    title: activity.title,
                    times: activity.timesPerWeek,
                    minutes: activity.minutesPerRun,
                  })}
                </li>
              ))}
              {indicators.timePerApp.map((app) => (
                <li key={`p:${app.app}`}>
                  {t('common.jr.handbook.indicators.app', { app: app.app, minutes: app.minutesPerDay })}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Modal
        visible={confirming}
        title={t('common.jr.handbook.editor.confirmTitle')}
        onCancel={() => setConfirming(false)}
        footer={[
          <Button key='cancel' shape='round' disabled={publishing} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>,
          <Button key='publish' type='primary' shape='round' loading={publishing} onClick={() => void publish()}>
            {t('common.jr.handbook.editor.publish')}
          </Button>,
        ]}
      >
        <p>{t('common.jr.handbook.editor.confirmBody')}</p>
      </Modal>
    </Modal>
  );
};

export default HandbookDraftEditor;
