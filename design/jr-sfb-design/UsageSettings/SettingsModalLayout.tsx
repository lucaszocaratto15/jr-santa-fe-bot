import React from 'react';
import { X, Settings, Monitor, BarChart3, Download } from 'lucide-react';
interface SettingsModalLayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onClose?: () => void;
}
const MenuTab: React.FC<{
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}> = ({
  icon,
  label,
  active
}) => <button type="button" className={`w-full flex items-center gap-4 px-4 py-3 rounded-xl transition-all text-left ${active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900 hover:text-white'}`}>
    <span className="shrink-0">{icon}</span>
    <span className="text-[18px] font-normal">{label}</span>
  </button>;
export const SettingsModalLayout: React.FC<SettingsModalLayoutProps> = ({
  children,
  activeTab,
  onClose
}) => {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-0 sm:p-4">
      <div className="relative flex h-full w-full max-w-[1400px] overflow-hidden rounded-none border border-zinc-800 bg-[#111111] shadow-2xl sm:h-[calc(100vh-32px)] sm:rounded-2xl">
        <button type="button" aria-label="Fechar configurações" onClick={onClose} className="absolute right-6 top-6 z-10 rounded-full p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/60">
          <X size={24} />
        </button>

        <aside className="w-[260px] shrink-0 border-r border-zinc-800 bg-[#111111] px-4 py-7">
          <nav aria-label="Configurações" className="flex flex-col gap-1">
            <MenuTab icon={<Settings size={24} strokeWidth={1.8} />} label="Geral" active={activeTab === 'general'} />
            <MenuTab icon={<Monitor size={24} strokeWidth={1.8} />} label="Computador" active={activeTab === 'computer'} />
            <MenuTab icon={<BarChart3 size={24} strokeWidth={1.8} />} label="Uso e cobrança" active={activeTab === 'usage'} />
            <MenuTab icon={<Download size={24} strokeWidth={1.8} />} label="Atualizações" active={activeTab === 'updates'} />
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-[#141414]">
          <div className="px-6 pb-16 pt-14 sm:px-12 sm:pt-16">
            {children}
          </div>
        </main>
      </div>
    </div>;
};