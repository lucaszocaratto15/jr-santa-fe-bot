# Otimização

O sistema tem três mecanismos para continuar rápido e barato: **fallback gratuito**, **compactação de contexto longo** e **limites de transporte**.

## Fallback gratuito

Quando o MiniMax falha por rede, tempo esgotado, 5xx, 429, 401 ou 403, a mesma requisição é refeita antes de voltar ao app. A ordem é:

```
openrouter/free  →  OPENROUTER_FALLBACK_MODELS (…:free)  →  Gemini (se houver chave)
```

- O corpo original é preservado, incluindo ferramentas e fluxo SSE.
- O app continua pedindo o MiniMax; o serviço troca só o modelo do fallback.
- Depois de **três falhas seguidas**, o serviço vai direto ao fallback por **três minutos**, e então tenta o MiniMax de novo.
- Cancelamento, sessão revogada e pedido inválido **não** acionam o fallback.

## Compactação de contexto longo

O MiniMax recusa contexto perto de 200 mil tokens. Acima de **130 mil tokens estimados**, o serviço resume os trechos antigos:

1. O system prompt permanece; as últimas mensagens ficam inteiras.
2. Trechos antigos viram blocos; cada bloco é resumido pelo Gemini (`GEMINI_MODEL`, padrão `gemini-3.8-flash`).
3. Sem chave do Gemini (ou se ele falhar/estourar), o bloco vira um excerto (início e fim do texto).
4. Um par `tool_call`/`tool_result` nunca é separado.

`COMPACTION_ENABLED=false` desliga só o resumo; 400/413 e o fallback continuam funcionando.

## Limites e tempos

| Parâmetro              | Padrão | Papel                                        |
| ---------------------- | ------ | -------------------------------------------- |
| `ATTEMPT_MS`           | 90000  | Tempo máximo até os headers de cada provedor |
| `COMPACTION_BUDGET_MS` | 60000  | Teto somado das tentativas de resumo         |
| Teto de headers        | 3 min  | Tempo total para obter os headers            |

O `ATTEMPT_MS` não corta um stream já iniciado. O corpo SSE segue até o cliente encerrar, a sessão ser revogada ou o upstream fechar.

## Medição de consumo

O `GET /usage` devolve o consumo **somente da identidade autenticada**, a partir dos contadores informados pelo provedor: `promptTokens`, `completionTokens`, `cachedPromptTokens`, latência média e contadores de requisições. Valores que o provedor não informa aparecem como desconhecidos, sem estimar saldo de assinatura.

## O que ainda falta validar

- Instalador Windows e desempenho em máquinas de 4/8 GB.
- Dependências de Chrome/MCP em instalação limpa.
- Comparação completa de todos os estados da interface.
