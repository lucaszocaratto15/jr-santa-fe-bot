# Atualizações automáticas no Windows (JR Bot)

O app já tem o canal de atualização pronto: ele consulta o feed da empresa, baixa a versão nova e instala pelo próprio app. Você **não precisa enviar o instalador** para os funcionários. O que falta é publicar a versão no feed e garantir que o perfil (bots, conversas, contexto) continue intacto.

## Como funciona

- Feed: `https://jrsantafe.stratacerta.com.br/mmx/updates/latest.yml` (Traefik → `/opt/mmx-gw/data/updates`).
- O app verifica o feed 3 segundos após abrir (`checkForUpdatesAndNotify`), mostra a atualização no próprio app e instala quando o funcionário clica em **Reiniciar e atualizar** (é esse clique que dispara o backup do perfil).
- O build usa o provedor `generic` do electron-updater com `latest.yml`, `.exe` e `.blockmap` (delta).
- `autoDownload=false` e `autoInstallOnAppQuit=false` por segurança: o funcionário vê o aviso, baixa e confirma **Reiniciar e atualizar**. Assim o backup pré-update roda sempre; instalar só no quit (autoInstallOnAppQuit=true) pularia o backup.

## Dados preservados

- `appId` (`br.com.jrsantafe.bot`) e `productName` (`JR Bot`) são estáveis. **Não mude esses valores**, senão o Windows passa a usar outra pasta de perfil e o app "perde" os dados.
- Instalação por usuário (`nsis.perMachine: false`) e `deleteAppDataOnUninstall: false`: atualizar/desinstalar não apaga o perfil.
- O perfil fica em `%APPDATA%\JR Bot` (banco `aionui\aionui.db`, `config`, `jr-access`, `jr-vault`, `jr-lessons`, `jr-learn`, `jr-handbook`, `taught-*`, `jr-workspaces`).
- Antes de instalar, o app para o backend e copia o perfil para `%APPDATA%\JR Bot\jr-update-backups\<versão>-<timestamp>`. Guarda as 3 cópias mais recentes (limite de 2 GB por cópia, caches/logs fora).

## Passo a passo do release

1. Suba a versão em `package.json` (ex.: `2.2.8` → `2.2.9`) e faça o commit.
2. Crie e envie a tag: `git tag v2.2.9 && git push origin v2.2.9`.
3. O workflow `Build and Release` roda no push da tag e publica a release no GitHub.
4. Ao publicar a release, o `Distribute Release Assets` roda o job `publish-jr-windows-feed`, valida `latest.yml`/checksum e envia por SFTP para o feed (`/updates`), trocando o `latest.yml` de forma atômica.
5. Confira: `curl -s https://jrsantafe.stratacerta.com.br/mmx/updates/latest.yml | head` deve mostrar a versão nova.
6. Abra o app em uma máquina de teste e confirme o aviso de atualização, o download e a instalação.

## Configuração necessária no GitHub

Variáveis (Settings → Variables):

- `PUBLISH_RELEASE=true`
- `PUBLISH_JR_UPDATES=true`
- `JR_UPDATES_SSH_HOST` (ex.: `jrsantafe.stratacerta.com.br`)
- `JR_UPDATES_SSH_USER`

Segredos:

- `JR_UPDATES_SSH_PRIVATE_KEY` (chave ed25519 do publicador)
- `JR_UPDATES_SSH_KNOWN_HOSTS` (host key fixa)

O job de S3 (opcional) usa `AWS_REGION`, `AWS_ROLE_ARN` e `AWS_S3_BUCKET`. O job do feed JR não depende do S3.

## Rollback

- O `latest.yml` do feed é sobrescrito; não há downgrade automático. Para voltar, publique uma versão **maior** com o build anterior (ou reinstale o `.exe` antigo na máquina).
- O instalador e o `latest.yml` antigos ficam na GitHub Release e em `JR-Bot-Windows-2.2.8/`, no Desktop.
- Mantenha as releases antigas no GitHub até confirmar a nova versão em produção.

## Assinatura do Windows

O instalador do Windows hoje não é assinado (só o macOS tem assinatura/notarização). O auto-update funciona, mas o SmartScreen pode exibir aviso na primeira execução. Para produção, configure um certificado de code signing (`CSC_LINK`/`CSC_KEY_PASSWORD` no CI) e, se usar `publisherName`, garanta que o certificado corresponda.

## Ordem segura de rollout

1. Publique a tag e valide em uma máquina de teste.
2. Confirme que o perfil de teste manteve bots, conversas e configurações.
3. Avise os funcionários; o app mostra o aviso no próximo início.
4. Se algo falhar, use o backup em `%APPDATA%\JR Bot\jr-update-backups` (copie de volta com o app fechado) e publique uma correção.

## Observações

- Nunca publique versão com o mesmo número de uma já existente: o job de S3 recusa sobrescrever e o feed pode ficar inconsistente.
- Não publique pré-release (`-dev-`) no feed dos funcionários; o job só aceita tag estável `vX.Y.Z`.
- O backup pré-update é best-effort: se o disco estiver cheio ou o perfil maior que 2 GB, ele registra no log e segue com a atualização.
