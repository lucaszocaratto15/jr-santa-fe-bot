import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { MainSidebar } from './MainSidebar';
import { ChatInputBar } from './ChatInputBar';
export const ChatDashboard = () => {
  const [connected, setConnected] = useState(true);
  return <main className="flex h-screen min-h-[640px] w-full overflow-hidden bg-[#0D0D0D] text-[#F5F5F5] font-sans">
      <MainSidebar />
      <section className="flex min-w-0 flex-1 flex-col bg-[#111111]">
        <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-white/[0.06] px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#9C642B] text-lg shadow-inner shadow-white/10">✦</div>
            <div>
              <h1 className="text-[15px] font-semibold tracking-[-0.01em]">JR Prospecção</h1>
              <p className="text-xs text-zinc-500">Grok Bot</p>
            </div>
          </div>
          <button aria-label="Mais opções" className="rounded-full p-2 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"><MoreHorizontal size={20} /></button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8 lg:px-12">
          <div className="mx-auto flex max-w-[980px] flex-col gap-5">
            <p className="self-center pb-4 text-xs text-zinc-500">Hoje 14:29</p>
            <article className="max-w-[720px] rounded-2xl rounded-tl-md border border-white/[0.06] bg-[#202020] px-5 py-4 text-[15px] leading-7 text-zinc-200">
              Os 4 rascunhos já estão atualizados nos Rascunhos do seu Gmail. Damha, Nobrevile e Facchini. Saíram as datas e entrou a reunião na sede deles ou online. O assunto agora começa com “Reunião de apresentação” e o portfólio continua anexado. Os antigos foram apagados, então não tem duplicado. Nada foi enviado: é só abrir e apertar enviar.
            </article>
            <p className="self-end rounded-2xl rounded-tr-md bg-[#95602d] px-5 py-3 text-[15px] leading-6 text-white shadow-sm">criei um email oficial para enviarmos sem ser pelo meu</p>
            <article className="max-w-[720px] rounded-2xl rounded-tl-md border border-white/[0.06] bg-[#202020] px-5 py-4 text-[15px] leading-7 text-zinc-200">
              Boa. Qual é o endereço? Se for Gmail ou Google Workspace, eu conecto ele aqui e refaço os 4 rascunhos já saindo dele, com o PDF anexado. Se não for, dá pra adicionar como “Enviar como” no seu Gmail.
            </article>
            <p className="self-end rounded-2xl rounded-tr-md bg-[#95602d] px-5 py-3 text-[15px] leading-6 text-white">lucaszocaratto@jrsantafe.com.br é gmail</p>
            <article className="max-w-[720px] rounded-2xl rounded-tl-md border border-white/[0.06] bg-[#202020] px-5 py-3 text-[15px] leading-7 text-zinc-200">
              Vou conectar o <span className="text-[#c99868]">lucaszocaratto@jrsantafe.com.br</span> aqui.
            </article>

            <div className="flex max-w-[720px] items-center gap-4 rounded-3xl border border-white/[0.05] bg-[#202020] px-5 py-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white text-2xl font-bold tracking-[-0.12em] text-[#EA4335]">G<span className="text-[#4285F4]">m</span></div>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-zinc-100">Gmail (jr) <span className="text-[#4798ff]">✦</span></p>
                <p className="text-sm text-zinc-400">{connected ? 'Conectado · 1 conta' : 'Desconectado'}</p>
              </div>
              <button className="hidden rounded-xl px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/[0.06] hover:text-white sm:block">Adicionar conta</button>
              <button onClick={() => setConnected(!connected)} className="rounded-xl bg-[#292929] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-[#343434]">Gerenciar</button>
            </div>
            <p className="max-w-[720px] px-4 text-xs leading-5 text-zinc-500">O Grok Bot sempre pergunta antes de fazer alterações. Desconecte quando quiser.</p>
            <article className="max-w-[720px] rounded-2xl rounded-tl-md border border-white/[0.06] bg-[#202020] px-5 py-3 text-[15px] leading-7 text-zinc-200">Abri o card de conexão aqui no chat. Entra com o <span className="text-[#c99868]">lucaszocaratto@jrsantafe.com.br</span>. Quando conectar, eu refaço os 4 rascunhos saindo dele, com o PDF anexado, e apago os do seu Gmail pessoal.</article>
            <article className="max-w-[560px] rounded-2xl rounded-tl-md border border-white/[0.06] bg-[#202020] px-5 py-3 text-[15px] leading-7 text-zinc-200">Conectado. Vou refazer agora os 4 rascunhos no e-mail da JR.</article>
            <article className="max-w-[720px] rounded-2xl rounded-tl-md border border-white/[0.06] bg-[#202020] px-5 py-3 text-[15px] leading-7 text-zinc-200">Estou recriando os 4 rascunhos no e-mail da JR com o PDF anexado e depois apago os antigos. Te aviso quando terminar. Nada vai ser enviado.</article>
            <div className="flex items-center gap-3 px-2 pt-1 text-sm text-zinc-400">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#9C642B] text-sm">✦</div>
              <span>Avançando</span>
              <span className="flex gap-1 text-[#c99868]" aria-label="Carregando"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" /></span>
            </div>
          </div>
        </div>
        <ChatInputBar placeholder="Mensagem para JR Prospecção" />
      </section>
    </main>;
};