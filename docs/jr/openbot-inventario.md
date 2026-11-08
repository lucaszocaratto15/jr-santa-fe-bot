# Inventário completo do OpenBot

Referência observada estaticamente: **OpenBot 0.63.0** — `/Applications/OpenBot.app`, Electron, bundle `app.openbot.desktop`.

> Método: observação estática do `app.asar` (package.json, árvore de `out/`, componentes do renderer), `plugin-catalog`, `managed-skills` e configurações em `~/Library/Application Support/OpenBot/`. Não é observação de execução.

## Identidade

| Campo          | Valor                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| Nome / produto | openbot / OpenBot                                                                 |
| Descrição      | "A local-first multi-agent desktop workspace for Codex, Claude, and Grok."        |
| Versão         | 0.63.0                                                                            |
| Autor          | Norbert Bodziony                                                                  |
| Repositório    | github.com/nightly-labs/openbot                                                   |
| Stack          | Electron + SolidJS 2 + Kobalte + Tailwind 4 + Mermaid 12 + effect 4 + zod 4 + Bun |
| Renderer       | SolidJS (não React)                                                               |
| Idioma         | 14 idiomas, incluindo **Português (Brasil)**                                      |
| Mobile         | App separado (Expo / React Native)                                                |
| Build          | Vite + Rolldown                                                                   |

## ⚠️ Licença — leia antes de copiar

A licença do OpenBot é **PolyForm Noncommercial 1.0.0** (`"license": "PolyForm-Noncommercial-1.0.0"`) e o pacote é `"private": true`.

Isso significa que **você não pode copiar o código do OpenBot** para um produto comercial da JR Santa Fé. O que você pode fazer legalmente é **replicar ideias, funcionalidades e fluxos de UX** — conceitos não são protegidos por direito autoral, mas o código-fonte é. Qualquer reaproveitamento de código do OpenBot no JR Bot (que é comercial) seria violação de licença.

Na prática, o JR Bot já tem base própria (AionUi, Apache-2.0). O OpenBot serve como **referência de comportamento**, não de código.

## Inventário de features

### 1. Agentes e provedores

- Multi-provedor: `opencode` (preferido na config), `claude`, `grok`, `codex` — runtimes baixados em `provider-runtimes/`.
- Importa agentes externos: `hermes-agent`, `grok-bot` (`agent-import/`).
- SDKs: `@anthropic-ai/claude-agent-sdk`, `@agentclientprotocol/sdk` (ACP), `@muse-code/sdk`.
- UI: `ProviderAccountList`, `ProviderModelPicker`, `ProviderLogo`, `FirstAgentSetup`, `AgentSettingsPanel`, `AgentUsagePanel`, `AgentTemplateInstall`, `custom-provider-host-state`.

### 2. Servidores remotos e equipe

- Servidores remotos: `openbot-remote-servers-v1.json` (`activeServerId`, `browserEgressServerIds`).
- `ServerSettingsModal`, `AddServerDialog`, `JoinServerDialog`, `CreateLocalServerDialog`, `ServerActionItems`, `server-capabilities`.
- Fluxo "entrar num servidor por convite" (`sitePage.join`).
- Equipe em tempo real: `@openbot/team-client`, `teamWebrtc`, `team-webrtc.html`.
- Remote desktop: `RemoteDesktopWorkspace`, `remote-desktop-runtime/`, `openbot-ice-helper.sh`.

### 3. Computer Use (controle de computador)

- Driver `cua-driver/darwin`, `ComputerUseSetup`, `computer-use-port`.

### 4. Navegador

- `BrowserFullViewAdapter`, `BrowserDock`, `BrowserLiveView`, `BrowserPreviewSidebar`, `BrowserProfileColor`, `browserPip` (+ `browser-pip.html`), `browser-port`.
- Egresso de navegador por servidor (`browserEgressServerIds`).

### 5. Workflows, rotinas e webhooks

- `WorkflowsPage`, `workflow`, `routine-schedule-ui`, `RoutineWebhookEndpoint`, `webhook-tests-v1`, `webhook-failure-code`.

### 6. Marketplace e plugins

- `MarketplaceModal`, `marketplace-suggestion-events`, `AgentTemplateInstall`.
- Catálogo de plugins (`plugin-catalog/catalog.json`): aave, airtable, apple-apps, atlassian, brave-search, canva, clickup, cloudflare, cobrain, coinbase, composio, context7, figma, firecrawl, higgsfield, huggingface, linear, neon, netlify, notion, obsidian, paper, posthog, prisma, railway, render, resend, revenuecat, robinhood, sentry, stripe, supabase, ticktick, todoist, trello, vercel.

### 7. Vault (segredos)

- `VaultPanel`, integração `@1password/sdk`.

### 8. Integrações / conectores

- `IntegrationLayout`, `GitHubConnectorPanel`, `linear-*.js` + plugins acima.

### 9. Skills gerenciadas

- `managed-skills/`: `openbot-data`, `openbot-site-hosting`, `openbot-skill-creator`.
- `SkillPreview`, `skills-port`.

### 10. Voz

- `voice-transcription-host.js`, `voice-speech-host.js`, `speech-speed`, `completion-sound`.

### 11. Personagens e avatares

- Personagens de pelúcia animados: malu, fred, vita, yoshi, cloe, nexo (+ variações `corps`, olhos, formas).
- `avatar-*`, `user-avatar`, `ChatColorSetting`, `avatar-hue-label`.

### 12. Monitor de recursos ("machine sidebar")

- `sidebar.machine.*` (cpuTitle, freeBody, cpuBody, meterLabel, alertTo, details, dismiss).
- Histogramas de RAM/CPU por processo em `openbot-resource-summary-v1.json` (`rss_mb`, `cpu_pct`, `loop_ms`, `db_ms`).
- `cpu`, `hard-drive`, `gauge`, `AgentUsagePanel`.

### 13. Brain (memória)

- `brain-*.js` (memória/contexto do agente).

### 14. Busca global

- `GlobalSearch`.

### 15. Onboarding e conta

- `FirstRunFlow`, `InitialSetup`, `LanguageStep`, `AccountLogin`, `sign-in-relay`, `createCodeSignInFallback`, `openbot-central-auth-v1.bin`.

### 16. Notificações e telemetria

- `agent-notification-levels`, `openbot-notification-preference-v1`, `new-message-tally`.
- `@openbot/telemetry`, `@opentelemetry`, `@openpanel`, `analytics`.

### 17. Extras de plataforma

- `OpenBotDynamicIsland` (Mac), `openbot-main-window-state-v1`, `whats-new-releases`, `LicenseSection`.

## Mapa para o JR Bot

| Feature do OpenBot                 | JR Bot hoje                | Gap              |
| ---------------------------------- | -------------------------- | ---------------- |
| Agente local                       | aionrs (AionCore)          | ✅               |
| Multi-provedor (codex/claude/grok) | Só MiniMax (intencional)   | — (não replicar) |
| Servidores remotos                 | —                          | ❌               |
| Equipe (WebRTC)                    | Team Mode (ACP) parcial    | ⚠️               |
| Remote desktop                     | —                          | ❌               |
| Computer Use                       | Só Chrome                  | ❌               |
| Navegador                          | Chrome (MCP)               | ⚠️ (menos rico)  |
| Workflows/rotinas/webhooks         | Cron do AionUi             | ⚠️               |
| Marketplace/plugins                | MCP Strata + Chrome        | ❌               |
| Vault de segredos                  | Chave na VPS (fora do app) | — (intencional)  |
| Skills                             | built-in + custom          | ✅               |
| Voz                                | —                          | ❌               |
| Personagens                        | Personagens JR             | ✅ (próprio)     |
| Monitor de recursos                | Só `/usage` do modelo      | ❌               |
| Brain (memória)                    | Brain JR (conhecimento)    | ✅ (mais forte)  |
| Busca global                       | —                          | ❌               |
| Onboarding/conta                   | Convite + login JR         | ✅ (próprio)     |

## Decisões a tomar

O que faz sentido copiar para um **assistente corporativo** (e que não conflita com o controle central do MiniMax):

1. **Workflows + rotinas + webhooks** — automação recorrente que a empresa usa de verdade.
2. **Monitor de recursos** — painel de RAM/CPU do agente (útil para máquinas de 4/8 GB).
3. **Marketplace de conectores** — catálogo de integrações aprovadas pela empresa (não as 30 genéricas, mas as que a JR usa: ERP/Strata, planilhas, drive).
4. **Voz** — transcrição/TTS em pt-BR.
5. **Equipe multi-agente** — já existe base (Team Mode), dá pra evoluir.

Não faz sentido copiar: multi-provedor (conflita com o MiniMax central), vault (a chave já fica segura na VPS), remote desktop/computer use (alto risco para dados da empresa).
