# Cérebro da empresa (jr-brain)

Serviço separado de notas da empresa. Node.js 24, SQLite embutido, sem dependências externas. Só o servidor de controle fala com ele; os aplicativos nunca chegam aqui diretamente.

## Ciclo de publicação e diagnóstico

O caminho antigo `/capture` responde `503 consent_required` e nunca chama o curador. O código 503 mantém o item na fila dos clientes antigos; uma resposta 409 faria esses clientes apagarem o item como falha permanente. A atualização de cliente e servidor precisa ser coordenada: o cliente novo deixa a fila antiga intacta e não a reenvia. O servidor sozinho não impede que clientes antigos continuem coletando ou eliminem itens por atingir seu limite local. O aviso de uso de dados continua sendo apenas um registro informativo; ele não autoriza publicar notas. Arquivos e fatos antigos não são apagados nem reprocessados por esta mudança.

O fluxo novo usa apenas um trecho explicitamente autorizado:

1. `POST /proposals` recebe `{requestId, authorized: true, messages}`. `requestId` deve ser UUID v4; `messages` contém somente o trecho escolhido, com papel `user` ou `assistant`. O curador gera um rascunho privado e não escreve fatos pesquisáveis. O retorno contém `{proposal, audiences, state}`.
2. `PATCH /proposals/:id` recebe `{version, text, sourceQuote, areaId, kind, validFrom?, validUntil?}`. `kind` é `shared_note` ou `official_procedure`. A fonte editada deve continuar contida no trecho autorizado. Cada revisão recebe nova versão e hash. Datas são milissegundos Unix; validade final nula significa sem expiração.
3. `POST /proposals/:id/consent` recebe `{version, hash, decision: "share"|"discard"}`. O hash vincula o texto, fonte, público, tipo e validade exatos que a pessoa revisou. Nota comum autorizada fica `active`; procedimento oficial fica `pending_review`. Recusa não cria um fato compartilhado.
4. `GET /manage/proposals` lista somente propostas oficiais que o responsável pode ler e revisar. `POST /manage/proposals/:id/review` recebe `{version, decision: "approve"|"reject"}`. Aprovação ativa a versão; rejeição não a publica. Procedimentos pendentes ou rejeitados não podem ser ativados pelo PATCH legado de fatos.
5. `POST /proposals` com `{requestId, authorized: true, factId}` prepara uma edição privada de uma nota que o servidor confirmou ser acessível. O consentimento da nova versão substitui a versão compartilhada anterior; em procedimento oficial, a versão anterior continua vigente até aprovação da nova. A consulta operacional exclui versões substituídas, suspensas, futuras e expiradas.

O rascunho guarda o trecho escolhido para permitir revisão da fonte. Ao compartilhar ou recusar, guarda somente a citação revisada nessa coluna; a conversa completa nunca é uma fonte pública. Dados ficam no SQLite privado do serviço. O controle e o brain não registram texto de proposta, conversa, query, token ou credencial nos novos eventos operacionais.

No adaptador legado de testes, `GET /manage/diagnostics` é exclusivo do administrador JR; o modo ERP bloqueia essa rota administrativa local. O armazenamento interno mantém até 5.000 eventos por empresa. Eventos contêm apenas IDs opacos, versão do serviço, etapa, estado, duração e quantidades. Erros distinguem `curator_disabled`, `curator_failed`, `invalid_curator_response`, `budget_exhausted`, `batch_full`, `proposal_empty`, `authorization_failed` e `search_failed`. Uma proposta criada não significa uma nota publicada.

## Autorização efetiva do ERP

O executável instala `createStrataBrainAuthorization` e habilita `erpAuthorization`. O controle resolve a conta existente, a organização selecionada e a política atual da ferramenta `conhecimento.autorizacao`. Sem vínculo, política válida ou comunicação com o ERP, conteúdo compartilhado falha fechado. Um administrador ou gestor do JR não recebe acesso adicional.

O contrato da política é `{policy_version:1,user_id,organization_id,audiences,capabilities}`. Os públicos têm chaves estáveis `empresa` ou `modulo:<id ERP>`, rótulo e direitos explícitos de leitura, publicação e revisão. As capacidades são `read`, `publish`, `revise`, `withdraw` e `approveOfficial`. Esses poderes são definidos no ERP, com os módulos `conhecimento` e `conhecimento-procedimentos`; o JR não cadastra permissões equivalentes. Uma organização pode ter públicos restritos a um módulo ERP, sem transformar áreas antigas do JR em autorização.

O controle assina esses dados com HMAC no contexto interno v2, junto de IDs JR/ERP/organização, método, caminho, hash do corpo, nonce e validade de 30 segundos. O brain verifica assinatura, formato, sujeito, requisição, prazo e uso único antes de selecionar o tenant. O cliente externo não fornece esse contexto: headers são reconstruídos no controle. Tokens OAuth e permissões declaradas pelo renderer nunca entram nesse header. Provas antigas sem política continuam recusadas com `erp_knowledge_policy_required`.

O SQLite mantém partição por organização. Cada requisição usa seu store por contexto assíncrono, sem variável global de empresa mutável. Chaves ERP são associadas a rótulos de público; não há associação por nome, e-mail ou cargo JR. Publicação, busca, gestão e histórico exigem a organização e o público autorizados. A busca aplica isso no SQL antes do ranking e do limite, além de status ativo, vigência, ausência de substituição, consentimento e autoria ERP comprovados.

Rascunhos já nascem vinculados ao subject ERP e à organização. Reconectar outra conta não libera nem reinterpreta propostas anteriores. O consentimento permanece ligado à versão e ao hash exatos. O autor precisa do direito ERP de alteração para revisar uma nota; alterar uma nota comum não exige poder de aprovação oficial. Uma revisão de fonte restrita preserva seu público, sem ampliá-lo para toda a empresa. Procedimentos oficiais ficam pendentes até revisão autorizada no ERP; rejeição nunca publica. Ativar novamente um procedimento oficial também exige esse poder.

Um trecho de texto livre escolhido pelo funcionário é tratado como uma nova fonte autorizada manualmente. O sistema não consegue provar de onde veio um texto colado nem herdar automaticamente as permissões de um documento ou de uma resposta citada nesse texto. A preservação técnica do público original existe nas revisões vinculadas a uma nota por `factId`; o consentimento de texto livre não deve ser apresentado como prova das permissões da sua fonte externa.

As telas recebem os públicos e capacidades efetivos por `/me`, sem poderes de diretoria JR. A edição local de áreas/membros, os logs administrativos legados e `/peers` ficam bloqueados no modo ERP. Manuais de terceiros não são liberados por áreas locais. Registros históricos sem chave de público, consentimento e autoria ERP comprovados permanecem preservados e fora da busca e da gestão operacionais; não ocorre migração automática.

Validação local: `node --test tests/unit/jr/brain/*.test.mjs`. As fixtures cobrem organização, públicos ERP, revogação, proprietário JR sem privilégio adicional, revisão oficial, rejeição, autoria imutável, conteúdo legado e requisições concorrentes. Isso não comprova OAuth real nem a configuração do ambiente publicado. O serviço mantém no máximo 100 stores de organizações abertos por processo; uma instalação maior exige estratégia de descarte de stores ociosos.

## Configuração

| Variável                    | Uso                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `BRAIN_SECRET`              | Segredo interno (cabeçalho `x-brain-secret`). Obrigatório e igual ao do controle. Gere um valor aleatório longo.    |
| `BRAIN_PORT`                | Porta interna. Padrão: `8790`.                                                                                      |
| `BRAIN_DB_PATH`             | Banco SQLite. No contêiner: `/data/brain.sqlite`.                                                                   |
| `BRAIN_MODEL_URL`           | Endereço do provedor terminando em `/v1`. Padrão: `https://api.minimax.io/v1`.                                      |
| `BRAIN_MODEL_KEY`           | Chave do provedor. Sem ela, propostas respondem `curator_disabled` e geram diagnóstico sem conteúdo.                |
| `BRAIN_MODEL`               | Modelo do curador. Padrão: `MiniMax-M3.1-Flash`.                                                                    |
| `BRAIN_DAILY_CURATOR_CALLS` | Teto diário de chamadas do curador por empresa. Padrão: `500`. Acima disso a proposta falha com `budget_exhausted`. |

O controle recebe `BRAIN_URL=http://brain:8790` e o mesmo `BRAIN_SECRET`.

## Rede

A porta 8790 é somente interna: o serviço não tem `ports:` nem rótulos do Traefik. Ele escuta em `0.0.0.0` dentro do contêiner, mas só é alcançável pela rede privada `jr-internal`, compartilhada com o controle. O `traefik.yml` não o menciona.

## Por que o MiniMax direto (sem mmx-gw)

O mmx-gw grava auditoria de cada requisição. O curador recebe somente o trecho explicitamente autorizado pelo funcionário. Por isso o cérebro chama o MiniMax direto, com chave própria. A aplicação guarda o trecho selecionado no rascunho privado para revisão; o provedor recebe esse trecho para processar a proposta. Isso não configura nem comprova a política de retenção do provedor.

## Backup

O banco fica no volume `brain_data` (`/data/brain.sqlite`). Para copiar com consistência, use o backup do próprio SQLite (copiar o arquivo com o serviço escrevendo pode pegar o WAL pela metade):

```sh
docker compose exec brain node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/brain.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\")"
docker compose cp brain:/data/backup.sqlite ./brain-$(date +%F).sqlite
docker compose exec brain rm /data/backup.sqlite
```

Guarde o backup fora da VPS. Ele contém conhecimento da empresa; trate como dado sensível.

## Base compartilhada do grupo

A política assinada v3 contém o grupo e suas empresas, definidos pelo ERP. A busca usa o banco SQLite existente com uma única consulta FTS, filtrando grupo, módulos autorizados, proveniência, consentimento e vigência antes de retornar candidatos. Ranking, limite de notas e limite de caracteres são globais. O cliente não escolhe o escopo da busca. A empresa é preservada como origem no resultado; feedback usa essa origem. Rascunhos privados e edições permanecem vinculados à empresa de origem. Nenhuma nota precisa ser copiada ou migrada.

O controle consulta `conhecimento.autorizacao` uma vez antes e uma vez após a operação, sem consultas por empresa. A assinatura v3, o grupo e a confirmação de protocolo impedem que uma versão antiga entregue uma busca parcial como se fosse consolidada. Políticas sem grupo continuam isoladas por empresa.
