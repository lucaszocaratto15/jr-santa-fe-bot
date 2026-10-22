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
}) => <button type="button" className={`w-full flex items-center gap-4 px-4 py-3 rounded-xl transition-all text-left ${active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}>
    <span className="shrink-0">{icon}</span>
    <span className="text-[16px] font-medium">{label}</span>
  </button>;
export const SettingsModalLayout: React.FC<SettingsModalLayoutProps> = ({
  children,
  activeTab,
  onClose
}) => {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-0 sm:p-4">
      <div className="relative flex h-full w-full overflow-hidden rounded-none border border-zinc-800 bg-[#111111] shadow-2xl sm:h-[min(900px,calc(100vh-32px))] sm:max-w-[1440px] sm:rounded-2xl">
        {/* Close Button */}
        <button type="button" aria-label="Fechar configurações" onClick={onClose} className="absolute right-7 top-6 z-10 rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500">
          <X size={25} strokeWidth={1.8} />
        </button>

        {/* Sidebar */}
        <aside className="w-[260px] shrink-0 border-r border-zinc-800 bg-[#111111] px-5 py-8 max-sm:hidden">
          <nav aria-label="Configurações" className="flex flex-col gap-1">
            <MenuTab icon={<Settings size={25} strokeWidth={1.8} />} label="Geral" active={activeTab === 'general'} />
            <MenuTab icon={<Monitor size={25} strokeWidth={1.8} />} label="Computador" active={activeTab === 'computer'} />
            <MenuTab icon={<BarChart3 size={25} strokeWidth={1.8} />} label="Uso e cobrança" active={activeTab === 'usage'} />
            <MenuTab icon={<Download size={25} strokeWidth={1.8} />} label="Atualizações" active={activeTab === 'updates'} />
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="min-w-0 flex-1 overflow-hidden bg-[#111111]">
          <div className="h-full overflow-y-auto px-6 py-16 sm:px-12 sm:py-12 lg:px-16">
            {children}
          </div>
        </main>
      </div>
    </div>;
};