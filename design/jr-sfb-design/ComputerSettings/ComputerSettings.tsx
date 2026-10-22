import { useState } from 'react';
import { CheckCircle2, ChevronDown } from 'lucide-react';
import { SettingsCard, SettingsToggle } from './SettingsCard';
import { SettingsModalLayout } from './SettingsModalLayout';
export const ComputerSettings = () => {
  const [trafficRouting, setTrafficRouting] = useState(true);
  const [permission, setPermission] = useState('Sempre permitir');
  const [permissionOpen, setPermissionOpen] = useState(false);
  return <SettingsModalLayout activeTab="computer">
      <section className="mx-auto w-full max-w-[1060px]" aria-labelledby="computer-settings-title">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 id="computer-settings-title" className="text-[30px] font-semibold tracking-[-0.03em] text-white">
              Computador
            </h1>
            <div className="mt-12 flex items-center gap-8 text-[17px]">
              <span className="text-zinc-500">Seu computador</span>
              <strong className="font-normal text-zinc-100">Lucass-MacBook-Pro.local</strong>
            </div>
          </div>
        </header>

        <SettingsCard>
          <div className="flex flex-col gap-7">
            <div className="flex flex-col gap-2 pr-0 lg:flex-row lg:items-start lg:justify-between lg:gap-8">
              <div className="max-w-[700px]">
                <h2 className="text-[17px] font-medium text-zinc-100">Execução neste computador</h2>
                <p className="mt-1 text-[16px] leading-6 text-zinc-400">{"Permita que o JR Santa F\xE9 Bot abra arquivos e execute tarefas no seu computador. O Auto-review continua verificando tudo antes."}</p>
              </div>
              <div className="relative mt-2 shrink-0 lg:mt-0">
                <button type="button" aria-haspopup="listbox" aria-expanded={permissionOpen} onClick={() => setPermissionOpen(open => !open)} className="flex min-w-[190px] items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-[16px] text-zinc-100 transition hover:border-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/60">
                  
                  <span>{permission}</span>
                  <ChevronDown size={17} className="text-zinc-500" />
                </button>
                {permissionOpen && <div className="absolute right-0 top-[calc(100%+8px)] z-20 min-w-[190px] rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl" role="listbox">
                    {['Sempre permitir', 'Perguntar sempre'].map(option => <button key={option} type="button" role="option" aria-selected={permission === option} onClick={() => {
                  setPermission(option);
                  setPermissionOpen(false);
                }} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                    
                        {option}
                      </button>)}
                  </div>}
              </div>
            </div>
            <div className="h-px bg-zinc-800" />
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
              <div className="max-w-[820px]">
                <h2 className="text-[17px] font-medium text-zinc-100">Rotear o tráfego por este computador</h2>
                <p className="mt-1 text-[16px] leading-6 text-zinc-400">
                  Roteia o tráfego de rede do computador do Grok Bot pelo seu computador desktop local em vez da nuvem. 1 roteados nesta sessão.
                </p>
              </div>
              <SettingsToggle checked={trafficRouting} onChange={setTrafficRouting} />
            </div>
          </div>
        </SettingsCard>

        <h2 className="mb-4 mt-10 text-[17px] font-medium text-zinc-400">Computador do Bot</h2>
        <SettingsCard>
          <div>
            <h2 className="text-[17px] font-medium text-zinc-100">Atualizar o computador do Bot</h2>
            <p className="mt-1 max-w-[920px] text-[16px] leading-6 text-zinc-400">
              Atualiza o computador que seus assistentes compartilham. Seus arquivos e logins ficam, mas aplicativos e pacotes instalados são removidos. Todos os assistentes atualizam juntos.
            </p>
            <div className="mt-6 flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-950/30 px-5 py-4 text-[16px] text-blue-400">
              <CheckCircle2 size={20} aria-hidden="true" />
              <span>Seu computador está na versão mais recente</span>
            </div>
          </div>
          <div className="h-px bg-zinc-800" />
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
            <div className="max-w-[850px]">
              
              
            </div>
            
          </div>
        </SettingsCard>
      </section>
    </SettingsModalLayout>;
};