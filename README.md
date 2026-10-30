# OpenSpec Studio

Aplicação web local para usar o [OpenSpec](https://github.com/Fission-AI/OpenSpec) de forma visual: painel de specs e changes, propose guiado artefato por artefato e onboarding de projetos novos ou existentes (greenfield e brownfield, mono-repo e multi-repo). O agente que escreve os artefatos é o [OpenCode](https://opencode.ai), embarcado no backend.

A aplicação roda só na sua máquina: o backend escuta em `127.0.0.1` e cada execução gera um token que a página recebe automaticamente.

## Pré-requisitos

| Ferramenta | Versão | Observação |
|---|---|---|
| [Bun](https://bun.sh) | 1.4.4 | runtime, gerenciador de pacotes e testes |
| [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec) | 1.15.0 ou mais nova | precisa estar no `PATH` como `openspec` (ou em `STUDIO_OPENSPEC_BIN`) |
| git | 2.32 ou mais novo | usado para reverter escritas indevidas em repositórios limpos, pelo diff e pelo Desfazer do apply e pelos commits feitos pela app |
| Docker | 29 ou compatível | só para rodar o apply em container; o usuário precisa acessar o Docker (grupo `docker`) |
| Node.js | 18 ou mais novo | só para rodar o apply em container: a CLI do devcontainer roda no Node |

O **OpenCode não precisa ser instalado**. Ele vem como dependência npm (`opencode-ai` 1.19.4, versão exata) e o backend inicia o binário de `node_modules`, nunca um `opencode` do `PATH`.

## Instalar e rodar

```bash
bun install
bun run start
```

O `start` compila a UI e sobe o backend. Abra o endereço impresso (`open http://127.0.0.1:4317 in your browser`). A porta muda com `STUDIO_PORT`.

### Provedores de LLM

Na primeira vez, as ações de IA ficam desabilitadas com o aviso "Nenhum provedor de LLM configurado". Abra **Provedores** no topo da página e configure um provedor com chave de API ou OAuth, e escolha o modelo padrão.

- As credenciais ficam só no `auth.json` do motor embarcado, dentro da pasta de dados da app (modo 600). Nenhuma resposta da API nem a tela devolvem a chave.
- Variáveis como `ANTHROPIC_API_KEY` exportadas no seu shell **não** são repassadas ao motor: o ambiente dele é montado a partir de uma lista fixa.
- O provedor embutido `opencode` do OpenCode não conta como provedor configurado.

### Onde ficam os dados

Tudo fica em `~/.local/share/openspec-studio/` (ou `$XDG_DATA_HOME/openspec-studio`, ou `STUDIO_DATA_DIR`):

- `studio.db`: workspaces, sessões, aprovações e jobs de onboarding (SQLite);
- `opencode/`: configuração, credenciais e dados do motor embarcado, isolados de qualquer instalação global do OpenCode;
- `onboarding/`: a lista de capacidades que a descoberta brownfield escreve;
- `run.json`: URL e token da execução atual (modo 600), lido pelo servidor de desenvolvimento.

> **Aviso:** o `bun install` executa o `postinstall` do pacote `opencode-ai`, que cria diretórios **vazios** do OpenCode no seu home (`~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode` e `~/.cache/opencode`, com subpastas `log/`, `repos/` e `bin/` sem arquivos). Durante o uso, a aplicação não escreve nada neles. Se não usar o OpenCode por fora, pode apagá-los.

## Fluxos

- **Workspaces:** registre uma pasta (mono-repo) ou um store do OpenSpec com vários repositórios de código (multi-repo). O store pode ser criado pela tela de cadastro. A app nunca apaga nada do disco ao remover um workspace.
- **Painel:** specs com requisitos e cenários, changes com o grafo de artefatos e o progresso de tasks, validação sob demanda. Edições feitas fora da app aparecem em poucos segundos.
- **Explorar:** para pensar uma ideia antes de existir uma change, use "Nova exploração" na seção "Explorações" do workspace. É uma conversa com o agente, que lembra das mensagens anteriores e recebe ao começar as specs e as changes ativas do workspace. Ele lê o código, as specs e as changes, mas não escreve nada no workspace nem roda comandos. A resposta aparece enquanto é escrita, "Parar" interrompe, e o histórico fica salvo. O agente sugere o título, que você pode trocar em "Editar título".
  - **Virar change:** o agente propõe o nome, uma descrição que resume a conversa e as decisões tomadas nela. Você edita, remove ou acrescenta antes de "Criar change". A change nasce com essas decisões já respondidas no checkpoint, marcadas "da exploração", e o checkpoint só pergunta o que ficou em aberto. A conversa vai para `exploration.md`, na pasta da change, e a exploração fica só leitura, com o link para a change.
  - **Descartar e continuar:** "Descartar" encerra uma exploração sem change. "Continuar a partir de…" abre uma exploração nova que começa com o resumo da anterior, para uma ideia que rende mais de uma change.
- **Propose guiado:** descreva a change; o agente gera um artefato por vez, a app valida com `openspec validate`, e você aprova, edita (CodeMirror) ou pede ajuste antes de liberar os dependentes. "Gerar o resto automaticamente" gera tudo de uma vez e para no primeiro erro.
  - **Decisões antes do proposal:** ao criar a change, o agente lê a descrição e o código e levanta as decisões que só você pode tomar (escopo, comportamento, compatibilidade), cada uma com opções e uma recomendada pré-marcada. Escolha uma opção ou escreva em "Outra resposta" e clique em "Salvar respostas", ou use "Aceitar recomendações" ou "Pular". O proposal só pode ser gerado depois disso. As respostas entram no pedido de todos os artefatos e ficam em `decisions.md`, na pasta da change, que vai junto para o archive. "Editar respostas" continua disponível, mas manda para "a revisar" os artefatos já gerados. "Gerar o resto automaticamente" para uma vez nas decisões ainda sem resposta e continua sozinho depois que você responde. Changes criadas antes desta versão seguem sem esse passo.
  - **Suposições do agente:** o que o agente decidiu sozinho ao escrever um artefato, inclusive as perguntas que ele fez e ninguém respondeu, aparece em "Suposições do agente", na revisão do artefato, e nunca dentro do arquivo. "Ajustar" numa suposição preenche o pedido de ajuste com ela. Ao aprovar, as suposições ficam registradas como aceitas em `decisions.md`.
- **Onboarding:** o wizard inicializa o OpenSpec com os comandos do OpenCode e o idioma dos artefatos. Num projeto brownfield, o agente descobre as capacidades, você revisa a lista (renomear, mesclar, remover, adicionar) e confirma a estimativa. Depois, uma change `baseline-<capacidade>` é gerada por sessão, até 3 ao mesmo tempo. Cada baseline mostra os requisitos com as evidências `arquivo:linha` e o selo "inferido" quando não há teste. Aprove, ajuste ou descarte cada uma e arquive as aprovadas em lote.

- **Apply:** na tela da change, "Executar próxima" ou "Executar todas" roda as tasks pelo agente, uma etapa por task. Cada task fica aguardando revisão, com o diff por membro: aceite (a task é marcada no `tasks.md`), peça ajuste ou desfaça (os arquivos voltam ao estado anterior, via Git, sem commits). O agente roda sem perguntar só os comandos da lista do workspace. Para qualquer outro comando, a app pergunta: permitir uma vez, sempre neste workspace, ou recusar.
- **Apply em container:** em "Configurações do apply", na tela do workspace, escolha onde o apply roda: no `devcontainer.json` do projeto, numa imagem padrão (Debian, Node, Python) ou sem container. Cada workspace ganha o próprio container, com runtimes, pacotes globais, portas e serviços separados. O container recebe só os repositórios do workspace e as credenciais da app, nunca o seu `$HOME`. Ele para depois de um tempo sem tasks e pode ser parado ou reconstruído pelo painel.
- **Git pela app:** a seção "Git" da tela do workspace mostra, para cada membro e para o store, se há repositório, a branch, as alterações pendentes e quem assina os commits.
  - **Inicializar Git:** cria o repositório sempre com um commit inicial. Antes, a app mostra o `.gitignore` sugerido (editável), os arquivos e o tamanho do commit, e destaca arquivos com cara de segredo (`.env`, chaves), que ficam fora por padrão. Um `.gitignore` existente nunca é substituído, só recebe linhas novas no fim.
  - **Identidade:** dá para definir um nome e e-mail próprios de um repositório. Eles ficam no `.git/config` dele; o seu `~/.gitconfig` nunca é alterado.
  - **Aceitar e commitar:** na revisão de uma task, cria um commit por repositório só com os arquivos da task, com o conteúdo que ela deixou (uma edição sua depois da task continua pendente), e com o `tasks.md` marcado. A mensagem vem pronta e pode ser editada. Só a task mais antiga em revisão pode ser commitada, e a app avisa quando um arquivo da task já tinha alterações suas não commitadas (aí só dá para aceitar sem commit).
  - **Commitar pendências:** commita as alterações de um membro com a sua mensagem, a partir do aviso antes do apply ou da seção Git. Fica indisponível enquanto há task rodando ou em revisão.
  - Os commits rodam na sua máquina, com os hooks e a configuração do repositório, também quando o apply usa container: um hook de pre-commit usa as ferramentas da máquina, não as do container. Se um hook recusar o commit, a app mostra a saída e oferece "Commitar sem hooks". Se o repositório exigir commits assinados e o assinador (gpg, por exemplo) pedir uma senha, o commit termina em 60 s sem efeito: faça esse commit pelo terminal. Push, pull e branches continuam fora da app.
- **Verificar e arquivar:** depois do apply, o painel "Verificação" da change confere se cada cenário das delta specs (`#### Scenario:` dos requisitos adicionados e modificados) é coberto por um teste que passa, e depois arquiva a change.
  - **Quando dá para verificar:** "Verificar change" fica disponível quando a change tem `tasks.md` e nenhuma task está rodando, aguardando permissão, em revisão ou incompleta. Enquanto a verificação roda, o apply e o "Commitar pendências" do workspace ficam bloqueados. "Parar verificação" interrompe a verificação e mantém o relatório anterior.
  - **Quem faz o quê:** um agente, numa sessão só de leitura (não escreve nos membros nem no `openspec/`, não roda comandos), aponta para cada cenário o teste que o exercita (membro, arquivo, linha e nome), ou o classifica como de verificação manual ou sem teste. O veredito nunca depende do que o agente diz: o backend confere que o arquivo existe dentro do membro e que o nome do teste aparece na linha apontada ou até 5 linhas depois. Uma evidência que não confere vira "evidência inválida" e o teste não roda. Os testes conferidos rodam um por vez no ambiente do apply (no container do workspace, ou na máquina sem container), filtrados pelo nome, com limite de 5 min cada.
  - **Runners:** `bun test`, `vitest`, `jest` e `pytest`, detectados pelo `package.json`, pelo lockfile ou pelos arquivos de configuração do pytest. Com outro runner, o item fica "não executado" e precisa ser conferido à mão.
  - **Veredito:** **FAIL** quando algum teste executado falha; **CONCERNS** quando não há falha, mas há cenário sem teste, evidência inválida, teste não executado, cobertura fraca, verificação manual não conferida ou task pendente no `tasks.md`; **PASS** nos outros casos. Uma change sem cenários sai PASS sem chamar o agente.
  - **Relatório:** fica em `verification.md` na pasta da change e vai junto para o archive. Se o código de algum membro ou os artefatos da change mudarem depois da verificação, o relatório aparece como desatualizado e o archive pede uma nova verificação. Justificar ou conferir um item não desatualiza o relatório.
  - **Ações por item:** "Conferido" marca um cenário manual como verificado; "Justificar" registra por que um item que deixa o veredito em CONCERNS é aceitável; "Gerar task de teste" acrescenta ao `tasks.md` uma task pendente pedindo o teste do cenário, no grupo "Verificação", para rodar pelo apply; "Provar" faz a prova vermelho → verde de um item coberto.
  - **Prova vermelho → verde:** a app monta duas cópias do membro fora dos seus arquivos, uma com o estado atual (controle) e outra com o código de antes da change e os testes atuais, e roda o teste nas duas. A prova é **forte** quando o teste passa no controle e falha na cópia anterior, **fraca** quando passa nas duas (o teste não depende da change, o que deixa o veredito em CONCERNS) e **inconclusiva** quando falha no controle. Limitações: só existe para changes cujas tasks rodaram pela app, porque usa o retrato de antes da primeira task; as dependências (`node_modules`, `.venv`, `venv`) entram nas cópias como link simbólico; arquivos ignorados pelo Git, como `.env`, não são copiados; num monorepo com dependências içadas para a raiz, o controle pode falhar e a prova sai inconclusiva. Seus arquivos, o índice e o HEAD não são tocados, e as cópias são apagadas no fim.
  - **Arquivar:** "Arquivar" fica bloqueado sem relatório, com relatório desatualizado ou com FAIL; com CONCERNS, cada item precisa de uma justificativa. O archive roda o `openspec archive`, que aplica as delta specs em `openspec/specs/` e move a change para `openspec/changes/archive/`; se ele recusar, a mensagem aparece e a change fica onde estava. Quando a raiz OpenSpec está num repositório Git, "Arquivar e commitar" cria um commit só com os arquivos que o archive moveu ou alterou (mensagem sugerida `archive: <change>`); outras alterações pendentes ficam fora. Se um hook recusar esse commit, a change continua arquivada e a app oferece "Tentar de novo" e "Commitar sem hooks".
  - **Testes nomeados pelos cenários:** o pedido de cada task do apply passa a listar os cenários das delta specs e pede um teste com o nome do cenário no nome do teste, o que facilita o rastreio na verificação.

No propose e no onboarding, o agente pode ler os repositórios de código, mas só escreve dentro da pasta `openspec/` da raiz. Uma escrita fora dela é mostrada como violação e revertida quando o repositório é git e estava limpo. No apply, ele escreve também nos repositórios, nunca no `tasks.md` nem fora do workspace.

## Desenvolvimento

```bash
bun run dev        # backend com --watch + Vite em http://127.0.0.1:5173
bun run typecheck  # TypeScript estrito em todos os pacotes e nos testes E2E
bun run test       # testes do servidor (incluindo o motor real) e da UI
bun run e2e        # testes no navegador com Playwright
```

Os testes E2E usam o Chromium do Playwright. Na primeira vez:

```bash
bunx playwright install chromium
```

Os testes isolam a pasta de dados e o registro de stores do OpenSpec em pastas temporárias e não tocam nos seus dados reais. A maioria usa um agente roteirizado no lugar do OpenCode. Os testes do motor sobem o binário real do OpenCode, mas nunca chamam um LLM.

Estrutura:

- `packages/server`: backend Hono (API, adaptador do CLI do OpenSpec, motor OpenCode, propose e onboarding);
- `packages/web`: UI React + Vite + TanStack Query;
- `packages/shared`: tipos e schemas zod da API;
- `e2e`: testes Playwright;
- `docs/spikes.md`: resultados das investigações técnicas.
