# Execução

A execução acontece **inteiramente no computador do funcionário**. A VPS só valida a identidade e encaminha a chamada ao modelo; ela não executa arquivo, não abre navegador e não recebe documentos.

## Quem executa

O aplicativo (Electron, em `packages/desktop/`) embute o motor de agente **aionrs** (AionCore). Ele é o equivalente ao agente de terminal: recebe um pedido em linguagem natural, planeja etapas, usa ferramentas e devolve o resultado — tudo com o funcionário vendo e aprovando.

```
Pedido  →  agente planeja  →  usa ferramentas  →  aprovação do funcionário  →  resultado
```

## Ferramentas do agente

| Ferramenta                          | O que faz                                                                 | Onde roda         |
| ----------------------------------- | ------------------------------------------------------------------------- | ----------------- |
| Leitura/escrita de arquivo          | Lê e grava arquivos na pasta do bot                                       | PC do funcionário |
| Execução de comando (`ExecCommand`) | Roda comandos locais e devolve o código de saída                          | PC do funcionário |
| Navegação no Chrome                 | Abre o Chrome, lê páginas e executa script (`chrome-devtools-mcp@1.12.0`) | PC do funcionário |
| Documentos                          | Gera PPT, Word e Excel (skills `pptx`/`docx`/`xlsx`, via OfficeCLI)       | PC do funcionário |
| MCP do ERP                          | `strata_list_tools` / `strata_call_tool` para chamar o MCP da empresa     | VPS → ERP         |

## Aprovação de cada ação

Escritas e execuções **não são automáticas**. O funcionário confere o que o agente pede e autoriza só as ações da tarefa. O agente não aprova ferramentas sozinho.

O agente fixa a seleção de ferramentas na criação da conversa. Por isso, **conecte os serviços antes de criar o bot** (Chrome, MCP). Uma conexão adicionada depois vale para bots novos, não para os já criados.

## Bots e conversas

- Cada bot tem **uma conversa permanente** e uma **pasta própria**.
- Selecionar o bot na barra lateral retoma o mesmo histórico e contexto, inclusive depois de fechar o aplicativo.
- Nome, personagem e aparência ficam na própria conversa; não existe lista de conversas avulsas.

## Conexões

- **Chrome** — aparece **Conectado** só após uma conexão real e a leitura das ferramentas. O primeiro uso exige Chrome e um Node.js disponível na máquina.
- **MCP personalizado** — configurado pelo administrador.
- **Strata Certa** — conexão OAuth com o ERP; ver [guarda](guarda.md).

## Como conferir o conector do Chrome sem abrir o app

```sh
node scripts/jr/check-chrome-connector.mjs
```

Saída `{"ok":true,...}` confirma que o conector abriu o Chrome e atuou numa página. Isso não substitui um bot já criado: a conversa só recebe o Chrome se a conexão estiver verificada antes de criar o bot.
