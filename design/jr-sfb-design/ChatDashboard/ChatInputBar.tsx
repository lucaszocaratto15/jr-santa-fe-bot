import { Mic, Plus, Waves } from 'lucide-react';
import { useState } from 'react';
interface ChatInputBarProps {
  placeholder?: string;
  onSendMessage?: (message: string) => void;
}
export const ChatInputBar = ({ placeholder = 'Mensagem para...', onSendMessage }: ChatInputBarProps) => {
  const [value, setValue] = useState('');
  const send = () => {
    if (value.trim()) {
      onSendMessage?.(value.trim());
      setValue('');
    }
  };
  return (
    <div className='shrink-0 px-4 pb-5 pt-2 sm:px-8'>
      <div className='mx-auto flex max-w-[980px] items-center gap-3 rounded-3xl border border-white/[0.09] bg-[#202020] px-3 py-2 shadow-2xl shadow-black/20 focus-within:border-white/20'>
        <button
          aria-label='Adicionar anexo'
          className='rounded-full p-2 text-zinc-500 transition hover:bg-white/[0.07] hover:text-zinc-200'
        >
          <Plus size={22} />
        </button>
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className='max-h-28 min-h-[26px] flex-1 resize-none bg-transparent py-1 text-sm text-zinc-200 outline-none placeholder:text-zinc-500'
          aria-label={placeholder}
        />
        <div className='flex items-center gap-1'>
          <button
            aria-label='Usar microfone'
            className='rounded-full p-2 text-zinc-500 transition hover:bg-white/[0.07] hover:text-zinc-200'
          >
            <Mic size={19} />
          </button>
          <button
            aria-label='Modo de voz'
            className='rounded-full bg-[#9C642B] p-2 text-white transition hover:bg-[#b77b38]'
          >
            <Waves size={19} />
          </button>
        </div>
      </div>
    </div>
  );
};
