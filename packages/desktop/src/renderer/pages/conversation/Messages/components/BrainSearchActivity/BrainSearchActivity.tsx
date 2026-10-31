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
import { parseBrainSearchOutput } from './parseBrainSearch';

/** Four dots in a square, listed clockwise so the pulse goes around. */
const DOTS: ReadonlyArray<readonly [number, number]> = [
  [4, 4],
  [12, 4],
  [12, 12],
  [4, 12],
];

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
 * Chat feedback while a bot consults the company brain: four dots pulse in turn while the lookup
 * runs and rest when it ends. Never shows fact text or ids.
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
      <svg className={styles.svg} viewBox='0 0 16 16' aria-hidden='true' focusable='false'>
        {DOTS.map(([cx, cy], index) => (
          <circle
            key={index}
            className={styles.dot}
            cx={cx}
            cy={cy}
            r={2.2}
            style={{ '--step': index } as React.CSSProperties}
          />
        ))}
      </svg>
      <span className={styles.label} role='status'>
        {label}
      </span>
    </div>
  );
};

export default BrainSearchActivity;
