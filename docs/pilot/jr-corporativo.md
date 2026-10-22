# Operação da edição JR

Registro de 22/10/2026. Base: AionUI v2.2.2; agente embutido AionCore v0.2.2; modelo MiniMax-M3.1-Flash.

## Onde cada parte executa

O aplicativo, os arquivos, os comandos e o Chrome executam no PC do funcionário. O serviço da VPS valida identidade e encaminha chamadas ao modelo. O processamento do modelo acontece no provedor remoto. O banco do controle não recebe documentos nem histórico de conversa; o conteúdo necessário ao modelo passa pelo proxy durante cada requisição.

A conexão Google/Gmail foi removida do catálogo e da seleção de ferramentas desta versão. Nenhum cliente OAuth Google foi criado ou conectado a uma conta de funcionário. O Chrome continua como conexão independente.

## Acesso do administrador

O endereço corporativo é `https://jrsantafe.stratacerta.com.br/bot`. A chave MiniMax e o código do administrador ficam no ambiente privado do serviço, fora do repositório. O código do administrador foi entregue em arquivo local privado ao responsável. Não distribua esse código aos funcionários.

No perfil do administrador, abra **Administração**, informe o nome do funcionário e gere um convite. O convite expira em sete dias e só pode ser usado uma vez. O funcionário informa esse código ao abrir o aplicativo.

O perfil local fica vinculado ao funcionário e ao serviço que o ativou. Após sair ou expirar a sessão, um novo convite precisa pertencer à mesma pessoa. A transferência do PC para outra pessoa exige limpar/recriar o perfil por procedimento administrativo; não existe troca automática que exponha os arquivos anteriores.

Use **Revogar acesso** para bloquear uma pessoa. A VPS recusa novas chamadas e cancela respostas em andamento. O aplicativo confere a sessão a cada 15 segundos, com timeout de 10 segundos por consulta; em falha de conexão, bloqueia o uso e encerra o agente que iniciou. O teste local observou encerramento em 1.012 ms, conforme o instante do ciclo de consulta.

Revogação não recupera nem apaga documentos já copiados. O aplicativo não é um sistema de prevenção de cópia de documentos.

## Uso do funcionário

1. Entre com o convite recebido.
2. Use **Novo Bot**, dê um nome e escolha o personagem e a cor.
3. Envie o pedido na conversa. O aplicativo cria uma pasta local para esse bot.
4. Confira as ações solicitadas e autorize as escritas ou execuções permitidas.
5. No perfil, acompanhe **Uso**, altere o tema ou saia.

Em **Conectar aplicativos**, adicionar o Chrome só mostra **Conectado** após uma conexão real e a leitura das ferramentas. O primeiro uso exige Chrome e um ambiente Node.js disponível; em computadores limpos isso ainda precisa ser validado antes da distribuição Windows. O administrador também pode configurar MCP personalizado. Configure somente serviços apropriados aos dados da empresa.

As regras atuais incluem confirmações de ferramentas e o bloqueio central de identidade/modelo. Um editor administrativo completo de políticas por ferramenta não faz parte desta entrega. A medição não aplica teto inicial de tokens. Valores ausentes do provedor aparecem como desconhecidos, sem estimar saldo da assinatura.

## Evidência operacional

| Verificação                                   | Resultado observado                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Administrador e funcionário no aplicativo Mac | Login real, convite consumido uma vez, administração ausente para funcionário                                                          |
| Chrome pelo agente MiniMax                    | Navegação, leitura e execução de script na página `https://example.com`                                                                |
| Arquivo local                                 | `validacao-chrome-jr.json` criado pelo agente e conferido em disco; título `Example Domain`, cabeçalho ausente representado por `null` |
| Revogação do aplicativo                       | Agente local encerrou em 1.012 ms no teste; tela de acesso revogado conferida no aplicativo                                            |
| Controle na VPS                               | HTTPS válido; login, convites, papéis, consumo e revogação exercitados                                                                 |
| Modelo via VPS                                | Resposta real em 1.067 ms; 258 tokens de entrada, 23 de saída e 128 de cache informados pelo provedor                                  |
| Fluxo interrompido na VPS                     | Primeiro trecho em 1.307 ms; término 78 ms após revogação; medição ausente permaneceu desconhecida                                     |

A tarefa Chrome teve confirmações manuais, consultas repetidas e reconexão do navegador. Não existe uma medição válida do tempo total automatizado dessa tarefa. As instruções dos novos bots passaram a orientar o reaproveitamento de resultados e uma única verificação; o ganho ainda não foi medido.

O visual usa medidas estáticas da referência, com fonte de sistema, ícones e personagens próprios. Não foi comprovada igualdade visual exata; o tema escuro usa uma paleta JR aproximada. Os controles são funcionais, sem autenticação simulada ou conexões inventadas.

## Desenvolvimento

Node.js 24 e Bun são necessários. Na raiz:

```sh
bun install
bun run package
JR_CONTROL_URL=https://jrsantafe.stratacerta.com.br/bot bun run start:jr
```

O núcleo AionCore precisa estar disponível no pacote ou ser indicado em `AIONUI_BACKEND_BIN`. O lançador usa um perfil descartável em `.local-pilot/`; um perfil ativado no controle local de teste não pode ser reutilizado como perfil de produção.

`bun run start:jr` sem `JR_CONTROL_URL` seleciona o piloto de desenvolvimento, que requer configuração local do provedor. Esse modo não é a distribuição de funcionários. O aplicativo empacotado usa o controle corporativo por padrão e não aceita o modo piloto por variável de ambiente.

Antes de publicar código, use `just push`; o comando executa lint, formatação, TypeScript, traduções e testes. Segredos, perfis, relatórios privados e documentos locais permanecem fora do Git.

## Limites antes da distribuição

Ainda precisam ser exercitados: instalador Windows, máquinas de 4/8 GB, dependências de Chrome/MCP em instalação limpa e comparação completa de todos os estados da interface. A memória medida do processo AionCore isolado no primeiro piloto não representa o consumo total do Electron, navegador ou pico de memória.

O serviço atual roda em processo único para cancelar fluxos imediatamente. Preserve o volume SQLite e suas cópias de segurança. Não escale para múltiplas instâncias sem distribuir os eventos de revogação.
