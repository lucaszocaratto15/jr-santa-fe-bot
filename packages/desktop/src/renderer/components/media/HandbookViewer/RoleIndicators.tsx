/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HandbookRoleIndicators } from '@/common/types/agent/handbookTypes';

/** Role indicators: averages of the role's people. The payload never names anyone. */
const RoleIndicators: React.FC<{ indicators: HandbookRoleIndicators | null }> = ({ indicators }) => {
  const { t } = useTranslation();
  return (
    <section className='flex flex-col gap-6px' data-testid='handbook-indicators'>
      <h3 className='text-14px font-600'>{t('common.jr.handbook.indicators.title')}</h3>
      {!indicators || (indicators.activities.length === 0 && indicators.timePerApp.length === 0) ? (
        <p className='text-t-secondary text-13px'>{t('common.jr.handbook.indicators.empty')}</p>
      ) : (
        <>
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
          <p className='text-t-secondary text-12px'>
            {t('common.jr.handbook.indicators.contributors', { count: indicators.contributors })}
          </p>
        </>
      )}
    </section>
  );
};

export default RoleIndicators;
