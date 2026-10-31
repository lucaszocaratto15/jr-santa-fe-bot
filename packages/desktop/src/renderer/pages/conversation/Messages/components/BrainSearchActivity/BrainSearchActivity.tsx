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
import { BRAIN_CENTER, BRAIN_DOTS, BRAIN_POINT, CONVERSATION_POINT } from './brainShape';
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
 * Chat feedback while a bot consults the company brain: dots assemble into a brain that pulses
 * with signal waves while a small bot loops from the conversation to it and back. Never shows
 * fact text or ids.
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
        <path
          className={styles.link}
          d={`M ${CONVERSATION_POINT.x + 10} ${CONVERSATION_POINT.y} Q ${(CONVERSATION_POINT.x + BRAIN_POINT.x) / 2} ${CONVERSATION_POINT.y - 10} ${BRAIN_POINT.x} ${BRAIN_POINT.y}`}
        />
        {/* Conversation: a small chat bubble with a tail. */}
        <path
          className={styles.conversation}
          d={`M ${CONVERSATION_POINT.x - 8} ${CONVERSATION_POINT.y - 6} h 16 a 3 3 0 0 1 3 3 v 6 a 3 3 0 0 1 -3 3 h -10 l -4 4 v -4 h -2 a 3 3 0 0 1 -3 -3 v -6 a 3 3 0 0 1 3 -3 z`}
        />
        <circle className={styles.pulse} cx={BRAIN_CENTER.x} cy={BRAIN_CENTER.y} r={22} />
        {BRAIN_DOTS.map((dot, index) => (
          <circle
            key={index}
            className={styles.dot}
            cx={dot.x}
            cy={dot.y}
            r={1.5}
            style={
              {
                '--from-x': `${dot.fromX}px`,
                '--from-y': `${dot.fromY}px`,
                '--rise': `${dot.rise}s`,
                '--wave': `${dot.wave}s`,
              } as React.CSSProperties
            }
          />
        ))}
        {/* Bot: outer group moves across, inner group bends the path into a loop. */}
        <g className={styles.botTrack}>
          <g className={styles.botLift}>
            <circle className={styles.bot} cx={CONVERSATION_POINT.x + 10} cy={CONVERSATION_POINT.y} r={3} />
          </g>
        </g>
      </svg>
      <span className={styles.label} role='status'>
        {label}
      </span>
    </div>
  );
};

export default BrainSearchActivity;
