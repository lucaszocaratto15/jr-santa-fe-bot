# Comparativo OpenBot → JR Bot

Referência observada: **OpenBot 0.63.0** (`/Applications/OpenBot.app`, Electron, bundle `app.openbot.desktop`).
O alvo é o **JR Bot** (edição corporativa do AionUi, este repositório).

> Método: observação estática dos arquivos empacotados (`app.asar`, `plugin-catalog`, `managed-skills`, configurações em `~/Library/Application Support/OpenBot/`). Não é observação de execução. Versão: primeira passagem, sem runtime.

## O que o OpenBot é

App desktop multi-agente (SolidJS no renderer). Roda vários agentes ao mesmo tempo via runtimes baixados (`opencode`, `claude`, `grok`, `codex`) e importa outros (`hermes-agent`, `grok-bot`). Tem catálogo de plugins, skills gerenciadas, automação, aprovação automática, servidores remotos, controle de computador e telemetria de recursos.

## Comparativo por área

| Área                       | OpenBot (observado)                                                                | JR Bot (hoje)                              | Situação                                         |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| **Modelo**                 | Vários provedores (opencode, claude, grok, codex)                                  | Só MiniMax-M3.1-Flash, via VPS             | Igual por design (empresa controla o modelo)     |
| **Execução local**         | Roda agente no PC                                                                  | Roda agente aionrs no PC                   | ✅ Tem                                           |
| **Plugins / conexões**     | Catálogo com ~30 (Notion, Linear, Figma, Canva, Stripe, Airtable, Trello, Vercel…) | MCP do Strata + Chrome + MCP personalizado | ⚠️ Parcial — sem catálogo                        |
| **Skills**                 | `managed-skills` (openbot-data, site-hosting, skill-creator)                       | Skills built-in (pptx, docx, xlsx, pdf…)   | ✅ Tem                                           |
| **Automação**              | Roda em segundo plano, planeja e executa (30 rodadas/h)                            | Cron do AionUi (agendado)                  | ⚠️ Parcial — sem loop "planejar + auto-executar" |
| **Aprovação**              | Auto-aprovação (YOLO) com override por agente                                      | Confirmação manual de ferramenta           | ⚠️ Sem auto-aprovar                              |
| **Servidores remotos**     | Servidores remotos + remote desktop                                                | WebUI/Telegram/Lark (base AionUi)          | ⚠️ Sem remote desktop                            |
| **Controle de computador** | `cua-driver` (computer use)                                                        | Só Chrome (chrome-devtools-mcp)            | ❌ Falta                                         |
| **Monitor de recursos**    | Histograma de RAM/CPU por processo                                                 | Só medição de modelo (`/usage`)            | ❌ Falta                                         |
| **Equipe multi-agente**    | `@openbot/team-client` + ACP                                                       | Team Mode (base AionUi)                    | ⚠️ Parcial                                       |
| **Sandbox de código**      | QuickJS WASM (`@jitl/quickjs-wasmfile`)                                            | Execução nativa (`ExecCommand`)            | ⚠️ Sem sandbox                                   |
| **Gravação de sessão**     | rrweb                                                                              | —                                          | ❌ Falta                                         |
| **WhatsApp**               | `@openbot/whatsapp`                                                                | — (Gmail já foi removido)                  | ❌ Falta                                         |
| **Idioma pt-BR**           | Sim (`pt_BR.lproj`, `@openbot/i18n`)                                               | Sim                                        | ✅ Tem                                           |
| **Telemetria**             | OpenTelemetry + OpenPanel                                                          | Sentry                                     | ⚠️ Parcial                                       |

## Lacunas principais (o que "copiar o OpenBot" significaria)

1. **Catálogo de conexões** — além de MCP + Chrome, uma lista de integrações prontas (não necessariamente as mesmas 30; as que importam pra JR: ERP/Strata já existe, talvez planilhas, e-mail, drive interno).
2. **Automação real** — o agente planejar e executar em segundo plano com limite por hora, sem o funcionário digitar a cada passo.
3. **Aprovação automática com override** — regra de "aprovar por padrão" desligável por bot/ação.
4. **Controle de computador (CUA)** — ir além do Chrome.
5. **Painel de recursos** — ver RAM/CPU do agente em tempo real.

## Decisão pendente

Estas lacunas precisam ser priorizadas com você antes de implementar. Algumas conflitam com o desenho atual do JR Bot (ex.: auto-aprovação vai contra a política de confirmação manual e de guarda; multi-provedor vai contra o controle central do MiniMax).
