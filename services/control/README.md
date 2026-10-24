# Controle de acesso JR

Serviço separado do aplicativo. Executa em Node.js 24, usa SQLite e não possui dependências externas. A execução de arquivos, ferramentas e navegador continua no computador do funcionário. Este serviço controla identidade e acesso ao modelo MiniMax.

## Configuração

| Variável                     | Uso                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `JR_ADMIN_CODE`              | Código exclusivo do administrador, entre 32 e 256 caracteres, sem espaços. Gere um valor aleatório seguro; não use senha comum. |
| `JR_UPSTREAM_KEY`            | Chave real do provedor, disponível somente neste serviço.                                                                       |
| `JR_UPSTREAM_URL`            | Endereço HTTPS do provedor terminando em `/v1`. Para JR: `https://jrsantafe.stratacerta.com.br/mmx/v1`.                         |
| `JR_MODEL`                   | Modelo permitido. Padrão da entrada executável: `MiniMax-M3.1-Flash`.                                                           |
| `JR_CONTROL_DATA_DIR`        | Diretório persistente privado. Padrão local: `./data`. No contêiner: `/data`.                                                   |
| `JR_CONTROL_HOST`            | Padrão local: `127.0.0.1`. No contêiner: `0.0.0.0`, com publicação somente em `127.0.0.1`.                                      |
| `JR_CONTROL_PORT`            | Porta do serviço. Padrão: `8787`.                                                                                               |
| `OPENROUTER_API_KEY`         | Chave do OpenRouter. Sem ela, esse provedor não é chamado.                                                                      |
| `OPENROUTER_FALLBACK_MODELS` | Modelos gratuitos separados por vírgula, cada um terminando em `:free`. O roteador `openrouter/free` vem sempre primeiro.       |
| `GEMINI_API_KEY`             | Chave do AI Studio. Sem ela, o Gemini não é chamado.                                                                            |
| `GEMINI_MODEL`               | Opcional. Padrão: `gemini-2.5-flash`.                                                                                           |
| `FALLBACK_ENABLED`           | `true` ou `false`. Se omitida, o fallback fica ligado somente quando existe uma das chaves acima.                               |

O processo encerra se faltarem credenciais válidas. Não existe código de administrador padrão. Não grave credenciais no código, no histórico de comandos ou em arquivo versionado. O serviço não lê configurações do OpenCode.

Com as variáveis disponíveis no ambiente seguro do processo:

```sh
node services/control/index.mjs
```

Para o contêiner, execute `docker compose -f deploy/compose.yml --env-file .env up -d --build` dentro desta pasta. O volume `control_data` preserva usuários, hashes de sessões e medições. O contêiner roda como usuário `node`, com raiz somente para leitura. Mantenha uma única instância do serviço para que a revogação também encerre os fluxos em curso.

O proxy reverso deve oferecer HTTPS e remover o prefixo público `/bot` antes de encaminhar para `127.0.0.1:8787`. Desative o armazenamento de respostas, a retenção de corpos e o registro de cabeçalhos `Authorization`. Para respostas SSE, desative o armazenamento intermediário e permita até três minutos por requisição. A configuração do proxy e a publicação na VPS não são executadas por este código.

O mesmo host publica o atualizador Windows em `https://jrsantafe.stratacerta.com.br/mmx/updates/latest.yml`. Os arquivos `latest.yml`, o instalador e o `.blockmap` ficam juntos em `/opt/mmx-gw/data/updates`. O overlay Traefik encaminha `/mmx/updates` para esse diretório.

## Fallback gratuito

Quando o MiniMax falha por rede, tempo esgotado, HTTP 5xx, 429, 401 ou 403, a mesma requisição é refeita antes de responder ao aplicativo. A ordem é `openrouter/free`, depois cada modelo de `OPENROUTER_FALLBACK_MODELS`, e por último o Gemini se `GEMINI_API_KEY` existir. O corpo original é preservado, inclusive ferramentas e fluxo SSE. O aplicativo continua pedindo o modelo MiniMax; este serviço troca somente o modelo enviado ao provedor de fallback.

Depois de três falhas seguidas do MiniMax, as próximas requisições vão direto ao fallback por três minutos. Em seguida o MiniMax é tentado de novo. Uma resposta concluída pelo MiniMax zera a contagem. Cancelamento do usuário, sessão revogada e pedido inválido não acionam o fallback.

Cada resposta concluída grava uma linha `Provedor: <nome> <modelo>`. A abertura do intervalo grava `Provedor: circuito aberto`. Essas linhas não incluem chaves. A resposta leva `X-JR-Provider` com `minimax`, `openrouter` ou `gemini`. `GET /usage` inclui `"fallback": true` enquanto o serviço estiver nesse modo, para o texto curto na tela de uso.

Para ativar, coloque as variáveis no ambiente do processo, sem publicá-las no repositório. O exemplo comentado está em `deploy/.env.example`. No contêiner, o `deploy/compose.yml` só repassa a variável se ela existir no ambiente; valor vazio deixa o provedor desligado. Isto não altera a VPS: o fallback permanece desligado até alguém definir uma chave e reiniciar o processo.

```sh
OPENROUTER_API_KEY='cole-a-chave-no-ambiente' \
OPENROUTER_FALLBACK_MODELS='deepseek/deepseek-chat:free,qwen/qwen3-coder:free' \
GEMINI_API_KEY='cole-a-chave-no-ambiente' \
node services/control/index.mjs
```

Para desligar mesmo com chave presente: `FALLBACK_ENABLED=false`.

## Contrato HTTP

Somente `GET /health` e `POST /auth/login` são públicos. Os demais caminhos exigem `Authorization: Bearer <token>`. As funções administrativas exigem o papel `admin`, consultado no banco a cada requisição.

| Método e caminho                   | Entrada ou resposta                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | `{ "status": "ok" }`; não revela configuração.                                                                                                                                    |
| `POST /auth/login`                 | Entrada `{code, deviceId, deviceName, employeeId?}`. Resposta `{token, user:{id,name,role}}`. `employeeId` impede consumir um convite de outra pessoa em instalação já vinculada. |
| `GET /auth/session`                | `{user:{id,name,role}}`; recusa sessão revogada ou expirada.                                                                                                                      |
| `POST /auth/logout`                | Encerra a sessão atual e suas requisições de modelo.                                                                                                                              |
| `GET /admin/employees`             | `{employees:[{id,name,role,email,createdAt,revoked,revokedAt,devices,usage}]}`. `email` é nulo quando não foi informado.                                                          |
| `POST /admin/invites`              | Entrada `{name,email?}`. Cria funcionário e responde `201 {id,code,expiresAt}`. E-mail vazio é aceito; e-mail malformado retorna `invalid_request`.                               |
| `POST /admin/employees/:id/invite` | Reemite convite para o mesmo funcionário ativo. Invalida convites anteriores não usados. Responde `201 {id,code,expiresAt}`.                                                      |
| `POST /admin/employees/:id/revoke` | Revoga funcionário, convites e sessões; cancela suas requisições em curso. Resposta `{revoked:true}`. Não permite revogar o administrador.                                        |
| `GET /usage`                       | `{model,usage}` com consumo apenas da identidade autenticada.                                                                                                                     |
| `GET /v1/models`                   | Lista OpenAI com o único modelo permitido.                                                                                                                                        |
| `POST /v1/chat/completions`        | Encaminha para o provedor configurado; aceita JSON ou SSE. Recusa modelo diferente.                                                                                               |

O código de convite aparece somente na criação ou reemissão. Expira em sete dias e é consumido na primeira ativação. Sessões usam 256 bits aleatórios, expiram em trinta dias e são armazenadas somente como hash. Após sair ou expirar, o funcionário precisa de novo convite para o mesmo cadastro. Reemitir convite não reativa funcionário revogado nem encerra sua sessão existente. Para bloquear acesso, use a revogação.

O código do dono cria apenas sessões de administrador. Nenhum campo enviado pelo cliente altera papéis. O parâmetro de vínculo `employeeId` complementa o isolamento do perfil local; a segurança do modelo depende da validação da sessão no servidor.

Erros usam `{error:{code}}`. Códigos de autenticação: `invalid_credentials` e `invalid_session` (`401`), `forbidden` e `device_bound_to_other_employee` (`403`), `employee_revoked` (`409`), `rate_limited` (`429`). Entrada inválida retorna `invalid_request` (`400`). O cliente deve traduzir esses códigos e bloquear o uso quando o servidor não puder validar a sessão.

## Consumo e latência

`usage` é `null` enquanto não houver requisições de modelo. Depois disso contém:

```text
startedAt, model, modelRequests, requests, completedRequests,
meteredRequests, unmeteredRequests,
promptTokens, completionTokens, cachedPromptTokens,
averageLatencyMs, averageFirstByteMs, lastRequestAt
```

Os contadores vêm exclusivamente de `usage` informado pelo provedor. Ausência de medição permanece `null`. Quando apenas parte das requisições possui medição, os totais incluem essa parte; `unmeteredRequests` mostra a lacuna. Em SSE, cada requisição registra a última medição cumulativa recebida, sem somar eventos repetidos. Cancelamentos preservam a medição já recebida.

A latência mede o tempo do envio ao provedor até o fim da resposta. `averageFirstByteMs` mede a chegada do primeiro trecho do corpo. Essas médias não incluem aprovação humana de ferramentas e não comprovam velocidade no computador do funcionário.

Não existe teto inicial de tokens. Existem proteções de transporte: corpo máximo de 16 MiB, quatro requisições simultâneas por pessoa, dezesseis no serviço e duração máxima de três minutos. A reserva de concorrência ocorre antes da leitura de corpos. Login permite sessenta tentativas por minuto por endereço de conexão; com proxy local, esse limite é compartilhado.

## Dados e limites reais

O banco guarda identidade, nomes de dispositivos, datas, hashes e consumo agregado por requisição. Não guarda códigos em texto, tokens de sessão, chave do provedor, mensagens, documentos ou respostas do modelo. Os registros de consumo permanecem associados à pessoa depois da revogação. Datas usam ISO 8601 em UTC.

Revogar bloqueia novas chamadas ao modelo imediatamente e interrompe o fluxo ativo no servidor. O aplicativo precisa consultar a sessão periodicamente, parar o agente e bloquear a interface após revogação ou perda da conexão. O serviço não apaga documentos locais nem recupera arquivos que já foram copiados ou exportados. Autorização Gmail e credenciais MCP continuam separadas do login corporativo.

O armazenamento SQLite precisa de backup e de disco persistente protegido. Não rode múltiplas instâncias: o cancelamento dos fluxos em curso é mantido em memória no processo único. Este componente, isoladamente, não comprova instalação Windows, proteção contra extração do banco local ou configuração do proxy reverso.

## Verificação

Na raiz do repositório:

```sh
node --test tests/unit/jr/control/*.test.mjs
```

Os testes usam HTTP real em porta local efêmera, SQLite temporário e provedor injetado sem rede externa. Cobrem códigos, sessões, isolamento por papel, expiração, revogação antes e durante SSE, reemissão, vínculo, medições reais do protocolo, limites e ausência de segredos persistidos. Não acessam a conta MiniMax de produção.
