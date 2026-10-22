# Piloto local: AionUI + MiniMax

## Resultado em 22/10/2026

O agente embutido `aionrs` executou uma tarefa real neste Mac usando `MiniMax-M3.1-Flash`. Leu um CSV fictício, criou `calcular.mjs`, executou o script localmente e gravou `resultado.json`. O verificador conferiu o arquivo no disco, o marcador exclusivo da execução, a soma calculada e a identificação do computador. A ferramenta `ExecCommand` também retornou código de saída zero.

Este é o piloto do núcleo local. A interface Electron, a identidade visual JR, os logins de funcionários e administrador e a distribuição Windows ainda não foram validados por este trabalho.

## Ambiente confirmado

| Item                        | Versão ou condição                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Fonte                       | [AionUI v2.2.2](https://github.com/iOfficeAI/AionUi/tree/v2.2.2), commit `6744099b279b991c17e31c243f0920477bd31cb6` |
| Núcleo                      | [AionCore v0.2.2](https://github.com/iOfficeAI/AionCore/releases/tag/v0.2.2), agente embutido `aionrs`              |
| Modelo efetivamente chamado | `MiniMax-M3.1-Flash`, pelo gateway JR já configurado                                                                |
| Computador                  | Apple M4 Pro, arm64, macOS, 24 GB de memória                                                                        |
| Executor do piloto          | Node.js v24.21.0                                                                                                    |
| Dados da tarefa             | Três valores fictícios: 58,41; 95,95; 194,86                                                                        |
| Resultado conferido         | Total `349.22`, três linhas, marcador exclusivo e plataforma `darwin`                                               |

Arquivo oficial usado: `aioncore-v0.2.2-aarch64-apple-darwin.tar.gz`. SHA-256 conferido antes da execução:

```text
70c50b84be9e17ba574a2c74370e6d57a267f44bdd6ecf641740cf220737d5cb
```

## Tempos da última execução completa

Execução iniciada em `2026-10-22T14:47:44.650Z`. Núcleo pronto em **3.227 ms**. Medições por turno começam depois da inicialização.

| Medida                                          | Saudação | Criar e executar código |
| ----------------------------------------------- | -------: | ----------------------: |
| Primeiro texto recebido da API                  | 3.806 ms |                2.976 ms |
| Primeiro texto recebido do agente por WebSocket | 4.305 ms |                2.976 ms |
| Tempo total do turno                            | 4.561 ms |               46.303 ms |
| Tempo com confirmações pendentes                |     0 ms |               28.351 ms |
| Total menos espera por confirmação              | 4.561 ms |               17.952 ms |
| Chamadas ao modelo                              |        1 |                       4 |
| RSS do núcleo e filhos, amostra ao fim do turno |   55 MiB |                  44 MiB |

O alvo de saudação em até cinco segundos foi atingido nesta execução. A tarefa levou **46,3 segundos no relógio**, incluindo a revisão e aprovação manual de `Write` e `ExecCommand`. Os **18,0 segundos** restantes incluem modelo, ferramentas, rede e orquestração; não são uma medição isolada de CPU.

As confirmações são consultadas a cada 300 ms. O tempo pendente usa a união dos intervalos, sem duplicar confirmações simultâneas. Primeiro texto da API e primeiro texto do agente são medidos separadamente. O primeiro texto pode ser uma explicação anterior às ferramentas; não significa que a tarefa terminou.

Uma tentativa anterior com instruções mais amplas exigiu 32.282 ms de processamento e gerou 104 linhas de código. A instrução reduzida gerou 20 linhas em 15.848 ms; a repetição acima gerou 18 linhas em 17.952 ms. Essa amostra pequena indica uma melhoria possível com instruções curtas. Não estabelece uma garantia de desempenho.

As amostras de RSS não incluem Electron, navegador, pico de memória ou o consumo total do aplicativo. O resultado neste Mac não comprova desempenho em PCs Windows com 4–8 GB.

## Consumo observado

Na tarefa, o provedor informou 22.782 tokens de entrada somados entre quatro chamadas, dos quais 20.736 vieram de cache, e 880 tokens de saída. A saudação usou 4.896 tokens de entrada e 30 de saída. Esses contadores são uso observado da API. Não determinam saldo, franquia da assinatura nem custo faturado.

## Como repetir

O piloto requer Node.js 24, terminal interativo, o binário oficial AionCore compatível com o Mac e o provedor `jr-minimax` já configurado. Ele lê a credencial do arquivo local de configuração existente; o processo OpenCode não é iniciado. É possível selecionar outro arquivo local com `JR_MINIMAX_CONFIG`.

```bash
AIONUI_BACKEND_BIN=/caminho/para/aioncore node scripts/jr/pilot-minimax.mjs
```

Revise as solicitações de escrita e execução e responda `yes` apenas para as ações da tarefa. O piloto não aprova ferramentas automaticamente. Artefatos, banco, logs e relatório detalhado ficam em `.local-pilot/<execução>/`, ignorado pelo Git. O relatório público resumido está em [minimax-local-results.json](./minimax-local-results.json).

Testes locais do suporte, sem chamadas pagas ao modelo:

```bash
node --test tests/unit/jr/*.test.mjs
```

## Proteção da credencial e limites do piloto

- A credencial do gateway fica na memória de um relay temporário em loopback. O núcleo recebe apenas um token temporário.
- O relay aceita somente o host HTTPS JR configurado, fixa o modelo selecionado, rejeita redirecionamentos e limita rotas e tamanho de requisição.
- A saída conhecida como sensível é removida dos relatórios e logs. Dados da execução e binários não entram no repositório.
- O núcleo usa acesso local de usuário único. Isso ainda não implementa autorização por funcionário, revogação, auditoria central nem limites de consumo.
- A pasta da tarefa é uma instrução ao agente, não uma barreira de segurança do sistema operacional. Isolamento e permissões corporativas precisam de implementação própria antes da distribuição.
- Navegação em sites, Google Workspace, interface completa, instalador Windows e teste em máquinas de 4–8 GB continuam pendentes.

O núcleo e os processos pertencentes ao piloto foram encerrados depois do teste. A fonte original e sua licença Apache-2.0 foram preservadas.
