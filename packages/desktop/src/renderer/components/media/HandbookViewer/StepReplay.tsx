/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Image } from '@arco-design/web-react';
import { Left, Right } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HandbookStep } from '@/common/types/agent/handbookTypes';

type StepReplayProps = {
  steps: HandbookStep[];
  /** Resolves a published image id to a data URL (fetched through main). */
  loadMedia: (id: string) => Promise<string>;
};

/** The handbook "video": one screen and one text per step, with Anterior/Próximo. */
const StepReplay: React.FC<StepReplayProps> = ({ steps, loadMedia }) => {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [image, setImage] = useState<{ id: string; url: string | null } | null>(null);
  const step = steps[Math.min(index, steps.length - 1)];
  const mediaId = step?.mediaId;

  useEffect(() => {
    setIndex(0);
  }, [steps]);

  useEffect(() => {
    if (!mediaId) return;
    let alive = true;
    setImage({ id: mediaId, url: null });
    loadMedia(mediaId).then(
      (url) => alive && setImage({ id: mediaId, url }),
      () => alive && setImage(null)
    );
    return () => {
      alive = false;
    };
  }, [mediaId, loadMedia]);

  if (!step) return <p className='text-t-secondary text-13px'>{t('common.jr.handbook.replay.empty')}</p>;
  const shown = mediaId && image?.id === mediaId ? image.url : null;
  return (
    <div className='flex flex-col gap-8px' data-testid='handbook-replay'>
      <div className='flex items-center gap-8px'>
        <Button
          size='small'
          type='text'
          shape='round'
          icon={<Left />}
          disabled={index === 0}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
        >
          {t('common.jr.handbook.replay.previous')}
        </Button>
        <span className='text-12px text-t-tertiary flex-1 text-center tabular-nums'>
          {t('common.jr.handbook.replay.step', { current: index + 1, total: steps.length })}
        </span>
        <Button
          size='small'
          type='text'
          shape='round'
          disabled={index >= steps.length - 1}
          onClick={() => setIndex((current) => Math.min(steps.length - 1, current + 1))}
        >
          {t('common.jr.handbook.replay.next')}
          <Right />
        </Button>
      </div>
      <div className='min-h-140px flex items-center justify-center rd-12px bg-fill-2 overflow-hidden border border-solid border-[var(--jr-hairline)]'>
        {!mediaId ? (
          <p className='text-t-secondary text-13px p-16px'>{t('common.jr.handbook.replay.noShot')}</p>
        ) : shown ? (
          <Image src={shown} alt={step.text} width='100%' preview={false} />
        ) : (
          <p className='text-t-secondary text-13px p-16px'>{t('common.jr.handbook.replay.loadingShot')}</p>
        )}
      </div>
      <p className='m-0 text-14px leading-22px'>{step.text}</p>
    </div>
  );
};

export default StepReplay;
