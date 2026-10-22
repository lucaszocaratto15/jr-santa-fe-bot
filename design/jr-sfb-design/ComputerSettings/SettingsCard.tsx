import React from 'react';
interface SettingsCardProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  variant?: 'default' | 'danger';
}
export const SettingsCard: React.FC<SettingsCardProps> = ({
  title,
  description,
  children,
  variant = 'default'
}) => {
  return <div className={`mb-8 p-6 rounded-2xl border ${variant === 'danger' ? 'border-red-900/30 bg-red-950/5' : 'border-zinc-800 bg-zinc-900/20'}`}>
      <div className="flex flex-col gap-1 mb-6">
        {title && <h3 className={`text-base font-semibold ${variant === 'danger' ? 'text-red-400' : 'text-zinc-100'}`}>
            {title}
          </h3>}
        {description && <p className="text-sm text-zinc-500 max-w-2xl leading-relaxed">
            {description}
          </p>}
      </div>
      
      <div className="flex flex-col gap-4">
        {children}
      </div>
    </div>;
};

// Sub-components for common settings elements
export const SettingsItem: React.FC<{
  label: string;
  subLabel?: string;
  control: React.ReactNode;
}> = ({
  label,
  subLabel,
  control
}) => <div className="flex items-center justify-between gap-4 py-2">
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium text-zinc-200">{label}</span>
      {subLabel && <span className="text-xs text-zinc-500">{subLabel}</span>}
    </div>
    <div className="shrink-0">
      {control}
    </div>
  </div>;
export const SettingsToggle: React.FC<{
  checked: boolean;
  onChange?: (val: boolean) => void;
}> = ({
  checked,
  onChange
}) => <button onClick={() => onChange?.(!checked)} className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${checked ? 'bg-accent' : 'bg-zinc-700'}`}>
    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
  </button>;