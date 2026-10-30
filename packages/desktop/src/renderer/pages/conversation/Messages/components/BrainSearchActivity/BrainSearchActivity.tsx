/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NormalizedToolStatus } from '@/common/chat/normalizeToolCall';
import styles from './BrainSearchActivity.module.css';
import { BRAIN_DOTS, BRAIN_POINT, CONVERSATION_POINT } from './brainShape';
import { parseBrainSearchOutput } from './parseBrainSearch';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const read = () => typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!query) return undefined;
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

type Props = {
  status: NormalizedToolStatus;
  output?: string;
};

/**
 * Chat feedback while a bot consults the company brain: dots form a brain and a small bot dot
 * fetches from it and returns to the conversation. Never shows fact text or ids.
 */
const BrainSearchActivity: React.FC<Props> = ({ status, output }) => {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const pending = status === 'pending' || status === 'running';
  const animated = pending && !reducedMotion;

  const label = useMemo(() => {
    if (pending) return t('common.jr.brain.activity.running');
    if (status !== 'completed') return t('common.jr.brain.activity.unavailable');
    const outcome = parseBrainSearchOutput(output);
    if (outcome.kind === 'unavailable') return t('common.jr.brain.activity.unavailable');
    if (outcome.count === 0) return t('common.jr.brain.activity.doneNone');
    if (outcome.count === 1) return t('common.jr.brain.activity.doneOne', { count: outcome.count });
    return t('common.jr.brain.activity.done', { count: outcome.count });
  }, [pending, status, output, t]);

  return (
    <div className={classNames(styles.root, animated && styles.animated)} data-testid='brain-search-activity'>
      <svg className={styles.svg} viewBox='0 0 120 64' aria-hidden='true' focusable='false'>
        <line
          className={styles.link}
          x1={CONVERSATION_POINT.x + 8}
          y1={CONVERSATION_POINT.y}
          x2={BRAIN_POINT.x}
          y2={BRAIN_POINT.y}
        />
        <circle className={styles.conversation} cx={CONVERSATION_POINT.x} cy={CONVERSATION_POINT.y} r={6} />
        {BRAIN_DOTS.map((dot, index) => (
          <circle
            key={index}
            className={styles.dot}
            cx={dot.x}
            cy={dot.y}
            r={1.6}
            style={
              {
                '--from-x': `${dot.fromX}px`,
                '--from-y': `${dot.fromY}px`,
                '--delay': `${dot.delay}s`,
              } as React.CSSProperties
            }
          />
        ))}
        <circle className={styles.bot} cx={CONVERSATION_POINT.x + 10} cy={CONVERSATION_POINT.y} r={3.2} />
      </svg>
      <span className={styles.label} role='status'>
        {label}
      </span>
    </div>
  );
};

export default BrainSearchActivity;
