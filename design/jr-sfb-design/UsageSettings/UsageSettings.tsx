import React from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { SettingsCard } from './SettingsCard';
import { SettingsModalLayout } from '../shared/SettingsModalLayout';
export const UsageSettings: React.FC = () => {
  return (
    <SettingsModalLayout activeTab='usage' onClose={() => undefined}>
      <div className='mx-auto w-full max-w-[1000px]'>
        <header className='mb-12'>
          <h1 className='text-[30px] font-semibold tracking-[-0.03em] text-white'>Uso e cobrança</h1>
        </header>

        <section aria-labelledby='weekly-limit-heading'>
          <SettingsCard>
            <div className='space-y-5'>
              <h2 id='weekly-limit-heading' className='text-[21px] font-medium tracking-[-0.015em] text-zinc-100'>
                Limite de uso semanal
              </h2>
              <p className='flex items-baseline gap-2 text-zinc-400'>
                <strong className='text-[43px] font-medium leading-none tracking-[-0.04em] text-zinc-100'>63%</strong>
                <span className='text-[21px]'>usado</span>
              </p>
              <div
                aria-label='63% do limite semanal usado'
                role='progressbar'
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={63}
                className='h-2 w-full overflow-hidden rounded-full bg-zinc-800'
              >
                <div className='h-full w-[63%] rounded-full bg-[#1683e8]' />
              </div>
              <p className='text-[18px] text-zinc-400'>Renova em 1 dia</p>
            </div>
          </SettingsCard>
          <p className='-mt-4 mb-12 text-[17px] text-zinc-500'>Uso incluído na sua assinatura. Renova toda semana.</p>
        </section>

        <section aria-labelledby='monthly-limit-heading'>
          <SettingsCard>
            <div className='flex items-center justify-between gap-8'>
              <div>
                <h2 id='monthly-limit-heading' className='text-[21px] font-medium text-zinc-100'>
                  Limite mensal sob demanda
                </h2>
                <p className='mt-1 text-[18px] text-zinc-400'>Cobrado pelo Cursor</p>
              </div>
              <button
                type='button'
                aria-label='Selecionar limite mensal'
                className='flex min-w-[168px] items-center justify-between gap-5 rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-3 text-[18px] text-zinc-100 transition-colors hover:border-zinc-700 hover:bg-zinc-800/60 focus:outline-none focus:ring-2 focus:ring-blue-500/60'
              >
                <span>Nenhum</span>
                <ChevronDown size={19} className='text-zinc-400' aria-hidden='true' />
              </button>
            </div>
          </SettingsCard>
        </section>

        <section aria-labelledby='plan-heading' className='mt-12'>
          <h2 id='plan-heading' className='mb-5 text-[18px] text-zinc-400'>
            Gerenciar plano
          </h2>
          <SettingsCard>
            <div className='flex items-center justify-between gap-8 py-1'>
              <div>
                <h3 className='text-[21px] font-medium text-zinc-100'>Plano atual</h3>
                <p className='mt-1 text-[18px] text-zinc-400'>
                  O uso renova em 22 de out.. Faça upgrade para ter mais uso.
                </p>
              </div>
              <button
                type='button'
                className='shrink-0 rounded-full border border-zinc-700 bg-zinc-100 px-5 py-2.5 text-[17px] font-medium text-zinc-900 transition-colors hover:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/60'
              >
                Ver planos unificados
              </button>
            </div>
            <div className='h-px bg-zinc-800' />
            <div className='flex items-center justify-between gap-8 py-1'>
              <h3 className='text-[21px] font-medium text-zinc-100'>Gerenciar cobrança no Cursor</h3>
              <button
                type='button'
                className='flex shrink-0 items-center gap-2 rounded-full border border-zinc-700 bg-zinc-800/50 px-5 py-2.5 text-[17px] text-zinc-100 transition-colors hover:bg-zinc-700/70 focus:outline-none focus:ring-2 focus:ring-blue-500/60'
              >
                <span>Gerenciar cobrança</span>
                <ExternalLink size={17} aria-hidden='true' />
              </button>
            </div>
          </SettingsCard>
        </section>
      </div>
    </SettingsModalLayout>
  );
};
