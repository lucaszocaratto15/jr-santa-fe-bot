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
      <h3 className='m-0 text-12px font-500 text-t-tertiary'>{t('common.jr.handbook.indicators.title')}</h3>
      {!indicators || (indicators.activities.length === 0 && indicators.timePerApp.length === 0) ? (
        <p className='text-t-secondary text-13px'>{t('common.jr.handbook.indicators.empty')}</p>
      ) : (
        <>
          <ul className='m-0 p-0 list-none grid grid-cols-1 sm:grid-cols-2 gap-8px text-13px'>
            {indicators.activities.map((activity) => (
              <li key={`a:${activity.title}`} className='rd-12px bg-fill-2 px-12px py-10px'>
                {t('common.jr.handbook.indicators.activity', {
                  title: activity.title,
                  times: activity.timesPerWeek,
                  minutes: activity.minutesPerRun,
                })}
              </li>
            ))}
            {indicators.timePerApp.map((app) => (
              <li key={`p:${app.app}`} className='rd-12px bg-fill-2 px-12px py-10px'>
                {t('common.jr.handbook.indicators.app', { app: app.app, minutes: app.minutesPerDay })}
              </li>
            ))}
          </ul>
          <p className='m-0 text-t-tertiary text-12px'>
            {t('common.jr.handbook.indicators.contributors', { count: indicators.contributors })}
          </p>
        </>
      )}
    </section>
  );
};

export default RoleIndicators;
