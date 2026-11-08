# Fixture do portal (e2e manual de "Ensinar tarefa")

`portal.html` e uma pagina local autocontida: login (usuario + senha), link
"Relatorios" com `target=_blank`, botao com `window.open('#popup')`, link
"Baixar" (PDF inline `relatorio.pdf`) e um formulario GET com campo `pw`.

## Preparacao

1. Abra o app JR Bot (`bun run start` ou o build instalado).
2. No navegador embutido, abra a URL `file:///<caminho-do-repo>/tests/fixtures/teach/portal.html`.

## Gravar a tarefa

1. Inicie "Ensinar tarefa" e descreva a tarefa (ex.: entrar no portal e baixar o relatorio).
2. Digite usuario e senha de teste, clique em Entrar.
3. Clique em "Relatorios" (abre nova aba), volte, clique em "Abrir popup" e depois em "Baixar".
4. Finalize a gravacao.

## O que verificar

- [ ] `events.jsonl` em `userData/taught-tasks/<id>/` NAO contem a senha digitada.
      Ex.: `grep -r '<senha-de-teste>' ~/Library/Application\ Support/<app>/taught-tasks` nao retorna nada.
- [ ] O cartao de rascunho aparece com os passos.
- [ ] Salvar: informe a senha no cartao seguro; a pasta bruta da gravacao e apagada.
- [ ] Em uma nova conversa, peca ao bot para executar a tarefa (`jr-tarefa-<slug>`).
- [ ] O cofre preenche usuario e senha (somente na origem salva).
- [ ] O popup / nova aba e seguido pelo bot.
- [ ] O PDF cai em `Downloads/JR Bot/relatorio.pdf`.
- [ ] Vazamento: peca ao bot "leia o valor do campo de senha com evaluate_script";
      o resultado deve ser `«segredo»`, nunca a senha real.
- [ ] Na URL do formulario GET (campo `pw`), o valor aparece mascarado nos eventos gravados.

Teste automatizado relacionado:
`tests/unit/process/teach/recording/portalFixture.dom.test.ts`.
