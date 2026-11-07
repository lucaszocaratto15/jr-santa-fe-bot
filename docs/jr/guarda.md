# Guarda

A "guarda" tem três camadas: **identidade** (quem pode entrar), **revogação** (como cortar o acesso) e **consentimento** (o que vira conhecimento da empresa). Tudo passa pelo serviço de controle, na VPS.

## Identidade e convite

- Só o **administrador** acessa a Administração (o funcionário não vê essa tela).
- O administrador informa o nome e gera um convite. O convite **expira em sete dias** e **só pode ser usado uma vez**.
- O funcionário digita o código ao abrir o aplicativo. O perfil local fica vinculado a essa pessoa e ao serviço que a ativou.
- A chave MiniMax e o código do administrador ficam **no ambiente privado da VPS**, fora do repositório. O funcionário nunca vê a chave.

## Revogação

Ao revogar um funcionário, a VPS recusa novas chamadas e **cancela respostas em andamento**. O aplicativo valida a sessão ao abrir, em cada chamada ao modelo e cerca de uma vez por minuto. Na resposta de revogação, apaga o token cifrado e volta à tela de acesso.

> Revogação não recupera nem apaga documentos já copiados ou exportados. O JR Bot não é um sistema de prevenção de cópia.

## Limites de uso

| Limite                             | Valor                                                |
| ---------------------------------- | ---------------------------------------------------- |
| Corpo da requisição                | até 16 MiB                                           |
| Requisições simultâneas por pessoa | 4                                                    |
| Requisições simultâneas no serviço | 16                                                   |
| Teto de contexto enviado ao modelo | 130 mil tokens estimados                             |
| Sessão                             | 256 bits, expira em 30 dias, armazenada só como hash |

## O caminho do conhecimento (consentimento)

O conhecimento que os funcionários criam passa por **consentimento explícito** antes de virar nota pesquisável:

1. O funcionário escolhe um trecho específico da conversa para compartilhar (nunca a conversa inteira).
2. O cérebro cria um **rascunho privado** e o curador (MiniMax, chave própria) propõe uma nota.
3. O funcionário revisa e **consente** (ou descarta). O consentimento fica ligado à versão e ao hash exatos.
4. Nota comum fica `active`; procedimento oficial fica `pending_review` até um responsável do ERP aprovar.

Nenhuma conversa completa vira fonte pública. A busca só alcança notas com consentimento, autoria e permissão ERP comprovadas.

## Permissões reais vêm do Strata (ERP)

O JR **não cria** permissões. Ele consulta a política canônica do ERP via OAuth PKCE e aplica os públicos (`empresa` ou `modulo:<id>`) e as capacidades (`read`, `publish`, `revise`, `withdraw`, `approveOfficial`). Sem vínculo, política válida ou comunicação com o ERP, o compartilhamento **falha fechado**.

## O que nunca fica guardado

O banco do controle guarda identidade, nomes de dispositivos, datas, hashes e consumo agregado. **Não guarda**: código de convite em texto, tokens de sessão, chave do provedor, mensagens, documentos ou respostas do modelo.
