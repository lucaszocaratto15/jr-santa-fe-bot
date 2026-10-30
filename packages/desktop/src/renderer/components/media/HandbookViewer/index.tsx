/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Empty, Tag } from '@arco-design/web-react';
import { FileText, Left, Right } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HandbookView } from '@/common/types/agent/handbookTypes';
import MermaidBlock from '@renderer/components/Markdown/MermaidBlock';
import RoleIndicators from './RoleIndicators';
import StepReplay from './StepReplay';

export type HandbookViewerProps = {
  payload: HandbookView;
  /** Show this activity only (chat card). Without it the role overview is shown. */
  activityId?: string;
  loadMedia: (id: string) => Promise<string>;
};

/**
 * Read-only "Manual da função" view shared by the employee tab, `/admin` and the chat card:
 * the role flowchart, its activities, each activity's flowchart and step replay, and the role
 * indicators. It has no edit or delete control.
 */
const HandbookViewer: React.FC<HandbookViewerProps> = ({ payload, activityId, loadMedia }) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | undefined>(activityId);
  useEffect(() => setSelected(activityId), [activityId]);
  const item = payload.items.find((entry) => entry.id === selected);

  if (item) {
    const flowchart = payload.flowcharts[item.id];
    return (
      <div className='flex flex-col gap-12px' data-testid='handbook-activity'>
        {!activityId && (
          <Button
            size='small'
            type='text'
            shape='round'
            icon={<Left />}
            className='self-start !text-t-secondary'
            onClick={() => setSelected(undefined)}
          >
            {t('common.jr.handbook.viewer.back')}
          </Button>
        )}
        <div>
          <h3 className='text-15px font-600 m-0 tracking-[-0.01em]'>{item.body.title}</h3>
          {item.body.description && <p className='text-t-secondary text-13px mt-2px mb-8px'>{item.body.description}</p>}
          <Tag size='small'>{t(`common.jr.handbook.frequency.${item.body.frequency}`)}</Tag>
        </div>
        {flowchart && <MermaidBlock code={flowchart} showOpenInPanelButton={false} />}
        <StepReplay steps={item.body.steps} loadMedia={loadMedia} />
        {item.body.confirmBefore.length > 0 && (
          <div>
            <h4 className='text-13px font-600 m-0'>{t('common.jr.handbook.viewer.confirmBefore')}</h4>
            <ul className='m-0 pl-18px text-13px'>
              {item.body.confirmBefore.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (payload.items.length === 0) {
    return (
      <div className='flex flex-col gap-12px'>
        <Empty description={t('common.jr.handbook.viewer.noHandbook')} />
        <RoleIndicators indicators={payload.indicators} />
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-12px' data-testid='handbook-role'>
      <MermaidBlock code={payload.roleFlowchart} showOpenInPanelButton={false} />
      <h3 className='text-12px font-500 text-t-tertiary m-0'>{t('common.jr.handbook.viewer.activities')}</h3>
      <div className='flex flex-col'>
        {payload.items.map((entry) => (
          <Button
            key={entry.id}
            type='text'
            long
            className='!h-auto !py-10px !px-10px !rd-12px !text-left !text-t-primary'
            onClick={() => setSelected(entry.id)}
          >
            <span className='flex items-center gap-10px'>
              <FileText theme='outline' size={15} className='text-t-tertiary shrink-0' />
              <span className='flex-1 min-w-0 truncate text-13px'>
                {entry.body.title} · {t(`common.jr.handbook.frequency.${entry.body.frequency}`)}
              </span>
              <Right theme='outline' size={14} className='text-t-tertiary shrink-0' />
            </span>
          </Button>
        ))}
      </div>
      <RoleIndicators indicators={payload.indicators} />
    </div>
  );
};

export default HandbookViewer;
