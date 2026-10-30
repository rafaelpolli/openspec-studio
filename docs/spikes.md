# Spikes

## 1.3 OpenCode com múltiplos diretórios

**Mecanismo escolhido: nativo.** A sessão roda com o diretório de trabalho na raiz OpenSpec (o store, num multi-repo), passado como `?directory=` em cada requisição. Os membros não precisam de pasta-pai comum nem de links: o agente lê os arquivos deles pelo caminho absoluto, liberado pelas regras da sessão.

- **Leitura.** A regra padrão do OpenCode já permite `read *`. O que controla o acesso a pastas fora do diretório de trabalho é `external_directory`, avaliado sobre o caminho absoluto. A app libera `external_directory <membro>/**` para cada membro e nega o resto (`external_directory * deny`), sem pedidos pendentes (D8, task 6.8).
- **Escrita.** `edit` é avaliado sobre o caminho relativo à worktree (raiz do repo git ou `/`). Por isso as regras de escrita saem nas duas formas (D8).
- **Verificação com LLM real (DeepSeek V4 Pro, 29/10/2026).**
  - Montagem: um store novo e dois repos git (`repo-api` com a regra de bloqueio após 3 tentativas; `repo-web` com a validação do formulário).
  - Pedido do propose: "mostrar no formulário web a mensagem de conta bloqueada que a API retorna".
  - O log do motor mostra leituras liberadas em `repo-api/src/auth.ts`, `repo-api/test/auth.test.ts` e em `repo-web`.
  - A proposal cita o `reason: "bloqueado"` da API e o `src/login-form.ts` do web, e a change passa em `openspec validate`.
  - Os dois repos ficaram sem alterações, exceto o `openspec/config.yaml` com o ponteiro para o store, gravado no registro do workspace com a confirmação do usuário.
- **Verificação automatizada sem LLM.** `packages/server/src/engine/permissions.engine.test.ts` usa o motor real e um LLM simulado (`src/testing/mock-llm.ts`).

## Apply 1.1 Regras de `bash` e de escrita do apply

Testado com OpenCode 1.19.4, usando o motor real e o LLM simulado, num store e num membro git fora dele.

- **Comandos compostos.** O OpenCode separa o comando nas partes ligadas por `&&`, `;`, `|`, quebra de linha e `$( )`, e exige uma regra `allow` para **cada parte**. Com só `echo ok*` liberado:
  - `echo ok && echo HACK`, `echo ok; echo HACK`, `echo ok | cat` e `echo ok $(echo HACK)` são negados;
  - liberando também `echo HACK*`, todos passam, exceto o do `cat`.
- **Redirecionamento.** `>` não é uma parte. `echo ok > f.txt` casa com `echo ok*` e escreve o arquivo sem passar pelas regras de `edit`. Uma regra `bash *>* ask` depois das liberações pega esses casos.
- **Prefixo.** O curinga vale para qualquer sequência de caracteres: `echo ok*` libera `echo okay`. Por isso cada comando da lista vira dois padrões, `<cmd>` e `<cmd> *`.
- **Diretório do comando.** O `bash` aceita `workdir`. Um `workdir` fora do diretório da sessão é avaliado por `external_directory`. Com o membro liberado (`<membro>` e `<membro>/**`), o comando roda dentro do membro.
- **Escrita num membro fora da worktree.** A worktree da sessão é a do store, e o caminho relativo do membro fica `../member/...`. As regras de `edit` nas duas formas (absoluta e relativa) liberam a escrita.
- **Pedido de permissão.** `bash * ask` antes das liberações gera um `permission.asked` para o comando fora da lista. O backend de hoje recusa o pedido automaticamente, e a resposta chega ao agente como "The user rejected permission…".

## Apply 1.2 Snapshot com index Git temporário

Testado com Git num repo sintético de 5.000 arquivos versionados, com 20.000 arquivos em `node_modules` (ignorado). O repo tinha alterações pendentes: um arquivo modificado sem stage, um com stage e um arquivo novo não rastreado.

- **Snapshot.** A sequência é copiar `.git/index` para um arquivo temporário, rodar `GIT_INDEX_FILE=<tmp> git add -A` e depois `git write-tree`. Leva cerca de 30 ms com a cópia do index, que reaproveita o cache de stat, e cerca de 95 ms com um index vazio. O `.gitignore` deixa `node_modules` de fora.
- **Diff.** `git diff-tree -r --name-status <antes> <depois>` lista exatamente o que a "task" fez: `M`, `D` e `A`. As alterações pendentes anteriores não entram no diff.
- **Desfazer.** Arquivos `A` são removidos. Os demais são restaurados com `git read-tree <antes>` e `git checkout-index -f -- <caminho>`, num index temporário. Depois disso, o `git status` ficou idêntico ao de antes da task, preservando o arquivo modificado, o que tinha stage e o não rastreado.
- **O que fica intocado.** HEAD, branch, stash e o conteúdo do index do usuário (o stage) não mudam, e nenhum commit é criado. O único efeito colateral é que os objetos de blob e tree do snapshot ficam soltos em `.git/objects`, até o `git gc` removê-los (por padrão, depois de 2 semanas).

## Devcontainer 1.1 OpenCode dentro de containers

Testado em 29/10/2026 com Docker 29.9.2, Node 22.22.1, OpenCode 1.19.4 e as imagens `mcr.microsoft.com/devcontainers/base:debian`, `typescript-node:22` e `base:alpine`. O usuário da máquina tem UID 1000.

- **CLI do devcontainer.** A `@devcontainers/cli` 0.80.0 trava depois de "Container started" com o Docker 29, tanto no Node quanto no Bun e tanto dentro quanto fora do sandbox. A 0.89.0 funciona no Node. A CLI exige Node na máquina, porque no Bun ela não é suportada.
- **Variantes do binário.** O pacote `opencode-ai` lista binários glibc e musl para x64 e arm64 (e as variantes `baseline`), mas o bun instala só a variante da máquina. O binário glibc não roda no Alpine (`exec … no such file or directory`), e o `opencode-linux-x64-musl` roda. A variante musl precisa ser obtida à parte, pelo tarball do registro npm na versão embarcada.
- **Motor no container.** Com `docker run` direto, nas três imagens com o binário certo:
  - o motor sobe;
  - com a porta publicada só em `127.0.0.1`, a resposta sem senha é 401;
  - o arquivo criado num membro montado pertence ao usuário da máquina;
  - o `~/.ssh` da máquina não existe no container.
- **Montagens.** As montagens nos mesmos caminhos absolutos funcionam, tanto pelo `docker run` quanto pelo `--mount` da CLI, para membros extras. O `--mount` da CLI **não aceita `readonly`**.
- **Binário no container.** Por isso, em vez de montar o binário, a app copia com `docker cp` para `/opt/studio/opencode` depois do `up`. A cópia leva cerca de 0,6 s com o arquivo em cache, e a primeira pode demorar vários segundos. O `docker cp` **preserva o dono do arquivo de origem**: o binário ficou com o UID 1000, gravável pelo usuário do container. Por isso, depois da cópia, é obrigatório `chown root:root` e `chmod 755`. Sem isso, um comando do agente poderia trocar o binário do motor.
- **Acesso ao motor.** O motor sobe com `docker exec -d` como o usuário da máquina e é acessado pelo IP do container na rede do Docker, por exemplo `172.17.0.2:4096`, com senha. Assim não é preciso publicar uma porta, o que exigiria mudar o `devcontainer.json` do usuário.
- **UID.** O `updateRemoteUserUID` alinha o usuário do container com o da máquina: um usuário de UID 1001 virou 1000, e o arquivo criado é do usuário da máquina. A CLI **não** troca o UID quando o UID da máquina já pertence a outro usuário da imagem. Nas imagens `mcr.microsoft.com/devcontainers/*`, o `vscode` tem 1000, o que só coincide com uma máquina de UID 1000.
- **Reaproveitamento.** Um segundo `up` com o container já ativo leva cerca de 0,8 s.
- **Não testado.** Docker rootless e Podman, que não estão instalados nesta máquina, ficam como limitação documentada.

## Devcontainer 1.2 Regras do apply com o motor no container

Teste temporário com o motor real dentro de um container `base:debian`, com o store, o membro e os dados do motor montados nos mesmos caminhos, e o LLM simulado ouvindo no gateway do Docker (`172.17.0.1`). As regras do `applyPermissions` funcionam **sem nenhuma tradução de caminhos**:
- a escrita em `repo-api/src/novo.ts` é permitida, e o arquivo fica com o UID da máquina;
- a escrita no `tasks.md` da change e fora do workspace é negada;
- `echo ok` roda com `workdir` no membro;
- `id -u` (fora da lista) gera um `permission.asked`, com padrão `["id -u"]`, e com "once" roda como UID 1000.

O teste foi removido depois. A verificação permanente fica com a task 3.1 (o teste de integração com Docker).

## Devcontainer 5.2 Verificação manual com LLM real e docker compose

Repo de exemplo com `.devcontainer/devcontainer.json` baseado em `dockerComposeFile` (serviço `app` em `typescript-node:22` + `db` em `postgres:16-alpine`), registrado como mono-repo, change criada pelo propose com um provedor real e tasks executadas pelo painel de apply:
- as montagens extras nos mesmos caminhos (`--mount`) funcionam com compose; os dois serviços sobem e o motor roda no `app`;
- primeiro preparo: cerca de 20 s do início do preparo até o motor responder, com a imagem e o Postgres já baixados (o build/pull da primeira vez não entrou na medida);
- task com o ambiente já pronto: começa quase de imediato (não cronometrado);
- com alterações não commitadas no repo, o aviso "tem alterações não commitadas" aparece e o diff da task mostra só o que o agente mudou.

## 1.5 Isolamento do motor embarcado e auth de provedor

Testado com `opencode-ai` 1.19.4, usando o binário em `packages/server/node_modules/.bin/opencode`, sem OpenCode global.

- **Isolamento XDG funciona.** Com `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` e `XDG_CACHE_HOME` apontando para uma pasta própria, o `GET /path` reporta `config` e `state` nessa pasta. `auth.json` (modo 600), `opencode.db`, `log/` e `repos/` são criados lá, e nada é escrito em `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode` nem `~/.cache/opencode` durante o uso.
- **A instalação escreve no global.** O `postinstall` do `opencode-ai`, executado pelo `bun add`, criou esses quatro diretórios globais vazios (`log/`, `repos/` e `bin/` sem arquivos).
- **Auth de provedor via API.** `PUT /auth/{providerID}` com `{"type":"api","key":"..."}` grava em `<XDG_DATA_HOME>/opencode/auth.json` e passa a valer na hora (o provedor aparece em `GET /provider` → `connected`). `DELETE /auth/{providerID}` remove do arquivo, mas o provedor só sai de `connected` depois de reiniciar o motor. `GET /provider/auth` lista os métodos por provedor (api e oauth).
- **Provedor embutido.** Um motor novo, sem nenhuma credencial, já reporta `connected: ["opencode"]`.
- **Senha do servidor.** Sem `OPENCODE_SERVER_PASSWORD`, o servidor avisa que está sem proteção e aceita qualquer requisição local. Com a variável definida, requisições sem credencial recebem 401, e as feitas com Basic Auth `opencode:<senha>` recebem 200.
- **Ambiente herdado.** O processo filho herda o ambiente do backend. Variáveis de chave de provedor (por exemplo `ANTHROPIC_API_KEY`), se existissem, seriam usadas pelo motor. Nesta máquina não há nenhuma.

## 1.4 `openspec archive` de uma change sem `tasks.md`

Testado com OpenSpec 1.15.0 numa raiz temporária (`openspec init --tools none`), com uma change `baseline-auth` contendo apenas `proposal.md` e `specs/auth/spec.md`.

Resultado: `openspec archive baseline-auth -y` termina com código 0, reporta `Task status: No tasks`, cria `openspec/specs/auth/spec.md` e move a change para `openspec/changes/archive/<data>-baseline-auth`.

Decisão: as changes de baseline **não** geram `tasks.md`. Para uso não interativo pelo backend, o archive deve ser chamado com `-y` (ou `--json`). Um `## Why` com menos de 50 caracteres gera só um aviso não bloqueante.
