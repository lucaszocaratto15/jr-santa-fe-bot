# JR Santa Fé Bot — MagicPath design export

Project "UsageSettings" (464074461591781376), exported 2026-10-22. Target: AionUi fork (Electron+React).
Install target suggested by MagicPath: src/components/magicpath/<folder>/ ; util `cn()` -> src/lib/utils.ts (copy in lib/utils.ts).
Deps: lucide-react, clsx, tailwind-merge, class-variance-authority. Styling: Tailwind (arbitrary hex values), font-sans (system), dark only.

## Tokens (dark, Grok Bot-like)

- App bg #0D0D0D (sidebar) / #111111 (chat + modal) / #141414 (settings content)
- Surface #202020 (assistant bubbles, input, cards), #1c1c1c/#292929/#343434 buttons; borders white/[0.06–0.09] or zinc-800
- Text #F5F5F5 / zinc-200 body / zinc-400-500 secondary
- Accent (bronze/caramel): #9C642B avatar & voice btn (hover #b77b38), user bubble #95602d, highlight text #c99868
- Blue: progress #1683e8, focus ring blue-500/60, "up to date" banner blue-950/30 + blue-400
- Radii: bubbles rounded-2xl with one corner rounded-md, input rounded-3xl, cards rounded-2xl, modal rounded-2xl
- NOTE: SettingsToggle uses `bg-accent` (undefined token in host) -> define or replace (e.g. #1683e8 / JR red #90182C).
- JR brand red #90182C does NOT appear in the design; accent is bronze.

## 1. ChatDashboard (main screen)

- Layout: full-height flex. Left MainSidebar 270px (collapses to 76px icon rail < md) + chat column.
- Sidebar: top 2 pinned bot avatars (CEO w/ star badge, "Founder Le..."), round Search + New chat buttons; section "Mercado Livre" with bot rows (avatar square, name, truncated last message); section/folder rows with counts (Jr Santa Fé 6, Strata Certa 2, Sem seção 1, Bots ocultos 5); footer user (Lucas Zocaratto, purple avatar, Bell).
- Header 72px: bot avatar (✦ bronze circle), title "JR Prospecção", subtitle "Grok Bot", "…" menu.
- Message list max-w 980px: centered timestamp "Hoje 14:29"; assistant bubbles left (#202020, max 720px); user bubbles right (bronze); inline connector card (Gmail (jr) – "Conectado · 1 conta", "Adicionar conta", "Gerenciar" toggles connected state) with disclaimer; working indicator "Avançando" + 3 pulsing dots.
- ChatInputBar: rounded pill, + attach, auto textarea (Enter sends, Shift+Enter newline, onSendMessage prop), mic, bronze voice-mode button. Placeholder "Mensagem para JR Prospecção".
- Mock data: pt-BR conversation about Gmail drafts/connecting lucaszocaratto@jrsantafe.com.br.

## 2. Settings modal shell (SettingsModalLayout, shared)

- Fixed overlay black/80, centered panel max 1400–1440px, h = 100vh-32px, close X top-right (onClose).
- Left nav 260px tabs (lucide icons, 18px labels): Geral (Settings), Computador (Monitor), Uso e cobrança (BarChart3), Atualizações (Download). Active = bg-zinc-800. Tabs are static (no onClick) — host must wire activeTab switching.
- SettingsCard (title/description/children, variant default|danger), SettingsItem, SettingsToggle.

## 3. UsageSettings (tab "Uso e cobrança")

- H1 "Uso e cobrança". Card "Limite de uso semanal": 63% usado, blue progress bar, "Renova em 1 dia"; caption "Uso incluído na sua assinatura…".
- Card "Limite mensal sob demanda / Cobrado pelo Cursor" + dropdown button "Nenhum" (no menu impl).
- "Gerenciar plano": Plano atual (renova 22 de out.) + white pill "Ver planos unificados"; "Gerenciar cobrança no Cursor" + outline pill w/ ExternalLink. All values mock.

## 4. ComputerSettings (tab "Computador")

- H1 "Computador"; "Seu computador: Lucass-MacBook-Pro.local".
- Card: "Execução neste computador" + working dropdown (Sempre permitir / Perguntar sempre); divider; "Rotear o tráfego por este computador" + toggle (on).
- Section "Computador do Bot": card "Atualizar o computador do Bot" + blue status banner "Seu computador está na versão mais recente" (empty trailing block, likely removed button).

## Flow

Chat screen is home. Sidebar = bot list (sections/folders, 2–3 pinned bots). Settings opens as modal over chat (entry point not drawn — suggest user footer or "…" menu) with left tabs Geral/Computador/Uso e cobrança/Atualizações; X closes back to chat. Connector cards appear inline in chat. Geral and Atualizações tabs were not designed.
