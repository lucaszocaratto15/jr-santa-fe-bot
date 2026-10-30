# Cérebro da empresa (jr-brain)

Serviço separado que guarda os fatos compartilhados entre os bots dos funcionários. Node.js 24, SQLite embutido, sem dependências externas. Só o servidor de controle fala com ele; os aplicativos nunca chegam aqui diretamente.

## Configuração

| Variável                    | Uso                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `BRAIN_SECRET`              | Segredo interno (cabeçalho `x-brain-secret`). Obrigatório e igual ao do controle. Gere um valor aleatório longo. |
| `BRAIN_PORT`                | Porta interna. Padrão: `8790`.                                                                                   |
| `BRAIN_DB_PATH`             | Banco SQLite. No contêiner: `/data/brain.sqlite`.                                                                |
| `BRAIN_MODEL_URL`           | Endereço do provedor terminando em `/v1`. Padrão: `https://api.minimax.io/v1`.                                   |
| `BRAIN_MODEL_KEY`           | Chave do provedor. Sem ela a captura fica desligada (o serviço continua de pé).                                  |
| `BRAIN_MODEL`               | Modelo do curador. Padrão: `MiniMax-M3.1-Flash`.                                                                 |
| `BRAIN_DAILY_CURATOR_CALLS` | Teto diário de chamadas do curador por empresa. Padrão: `500`. Acima disso o lote é descartado.                  |

O controle recebe `BRAIN_URL=http://brain:8790` e o mesmo `BRAIN_SECRET`.

## Rede

A porta 8790 é somente interna: o serviço não tem `ports:` nem rótulos do Traefik. Ele escuta em `0.0.0.0` dentro do contêiner, mas só é alcançável pela rede privada `jr-internal`, compartilhada com o controle. O `traefik.yml` não o menciona.

## Por que o MiniMax direto (sem mmx-gw)

O mmx-gw grava auditoria de cada requisição. O texto que o curador processa é o trecho de trabalho do funcionário, e esse conteúdo não pode ficar registrado na auditoria. Por isso o cérebro chama o MiniMax direto, com chave própria, e não persiste trechos brutos: guarda apenas os fatos extraídos.

## Backup

O banco fica no volume `brain_data` (`/data/brain.sqlite`). Para copiar com consistência, use o backup do próprio SQLite (copiar o arquivo com o serviço escrevendo pode pegar o WAL pela metade):

```sh
docker compose exec brain node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/brain.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\")"
docker compose cp brain:/data/backup.sqlite ./brain-$(date +%F).sqlite
docker compose exec brain rm /data/backup.sqlite
```

Guarde o backup fora da VPS. Ele contém conhecimento da empresa; trate como dado sensível.
