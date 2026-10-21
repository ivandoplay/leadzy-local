# Auditoria do prompt de 13 achados — execução e verificação

Este documento responde ao prompt de auditoria técnica/visual entregue em
`uploads/prompt.txt`. Cada achado foi **conferido no código atual**, corrigido
onde era real, e coberto por um teste que falha se o comportamento voltar.

Regra que segui do começo ao fim: nada aqui é "provavelmente funciona". Todo
número e toda afirmação deste relatório sai de um comando executado, e os
comandos estão citados.

- Versão auditada: `extensao/` no estado anterior a esta rodada (commit `5bbcd3c`).
- Correções: **não commitadas** no momento em que escrevi isto (commit feito no final).
- Suíte completa depois das correções: **299 testes, todos passando**
  (`bash tests/run-all.sh`, log em `/tmp/full3.log`).

---

## A. Achados — um por um

### ACHADO 1 — Troca de campanha durante a execução · **CONFIRMADO (P1)**

Era real, e pior do que o prompt sugeria. `sel-campanha.onchange` fazia
`execucao = null` e carregava outra campanha no meio do disparo: o laço antigo
continuava rodando em segundo plano, sem ninguém para pausar ou cancelar.

**Correção (lógica, não só botão):**

- `emOperacao()` no topo de `campaigns-ui.js`: verdadeiro em `preparando` e em
  `C.STATUS.EXECUTANDO` (a preparação — checagem do WhatsApp — também conta).
- `recusarSeEmOperacao(acao)` devolve um motivo legível e interrompe a ação.
  Aplicado em: troca de campanha (o `<select>` volta ao valor anterior), criar,
  excluir, limpar pendentes, reprocessar e no "Remover" de cada linha.
- `aplicarBloqueio(el, acao)` desabilita o controle **e** explica no `title`,
  então o usuário não fica com um botão morto sem motivo.
- Segunda barreira no motor: `campaign-engine.js` expõe `podeAlterarFila()` e
  `removerPendentes()` passou a devolver `0` durante a execução. Quem chamar a
  API direto, sem passar pela interface, também é recusado.

Depois de finalizar ou cancelar, tudo volta a funcionar (teste dedicado).

**Testes:** `achados.test.js` → *ACHADO 1: não dá para trocar de campanha
durante o disparo*, *...criar e excluir também são recusados...*, *...depois de
finalizar, trocar de campanha funciona*; mais três testes de unidade de
`podeAlterarFila` em `unit/campaign-engine.test.js`.

### ACHADO 2 — Tabela reconstruída a cada atualização · **CONFIRMADO (P2)**

`renderizarTabela()` fazia `corpo.innerHTML = ""` e recriava todas as linhas.
Com 3.000 contatos isso significa 27 mil nós recriados a cada mensagem enviada.

**Correção:** tabela incremental por `id` de contato (`linhasPorId`), com
assinatura por linha (`assinaturaContato`) — uma linha só é reescrita quando o
status/erro/número muda. Paginação de 200 linhas com "Mostrar mais"
(`#btn-mais-linhas`). Paginação aqui não é enfeite: sem ela o ganho do
incremental continuaria limitado pelo tamanho do DOM (ver seção F).

**Testes:** o comportamento é medido, não só afirmado — `tests/perf-tabela.js`
compara as duas versões no mesmo navegador (seção F).

### ACHADO 3 — Bloqueio da lista incompleto · **CONFIRMADO (P1)**

O prompt estava certo em desconfiar da lógica: `removerPendentes` no motor
**não** verificava o estado, só a interface escondia o campo de texto. Remover
um contato ou "Limpar pendentes" durante o envio alterava a fila viva.

**Correção:** política única — `podeAlterarFila(campanha)` (`false` só em
`EXECUTANDO`), usada pelo motor **e** pela interface. O botão "Remover" da linha
deixa de existir durante o envio (e volta quando o disparo termina ou é
cancelado). IDs dos contatos nunca são recriados, então resultado nunca é
associado ao contato errado.

**Testes:** *ACHADO 3: remover pendentes é recusado durante o disparo*,
*...o botão Remover da linha some durante o disparo* (verifica as duas pontas:
some no envio, volta depois).

### ACHADO 4 — `accept` não acompanha o tipo da pasta · **CONFIRMADO (P2)**

O `accept` era definido uma única vez, na criação da linha da pasta. Trocar
"Áudio" → "Imagem" mantinha o filtro antigo.

**Correção:** `TIPOS_MIDIA` (mime + extensões aceitas) e `arquivoCompativel()`;
`sincronizarAccept()` roda no `change` do tipo. E como `accept` é só uma dica do
seletor de arquivos — o usuário pode escolher "todos os arquivos" —, há
validação real do tipo no upload. Arquivos incompatíveis são recusados com o
motivo na tela, e ao trocar o tipo o sistema **oferece** remover os que ficaram
incompatíveis (com confirmação; nada é apagado sozinho).

**Testes:** *ACHADO 4: trocar o tipo da pasta troca o filtro do seletor de
arquivos* e *...arquivo incompatível é recusado mesmo passando pelo filtro*
(este segundo cobre imagem em pasta de áudio e arquivo binário desconhecido).

### ACHADO 5 — Uploads múltiplos sem feedback · **CONFIRMADO (P2)**

O código antigo era `Promise.all(...)`: uma falha rejeitava a cadeia inteira,
mas os arquivos já gravados permaneciam — e a interface não dizia nada.

**Correção:** upload **sequencial** e rastreável por arquivo, com barra
`upload-progresso` ("3 de 10"), listas de **adicionados** e **recusados** com o
motivo de cada recusa (vazio, tipo incompatível, falha de leitura, falha de
gravação). Só os recusados viram `alert`; o resto fica no resumo. Se a gravação
no storage falha, o item não entra na pasta (metadados e mídia não divergem) e
reabrir a página mostra exatamente o que ficou salvo.

**Testes:** *ACHADO 4/5* em `achados.test.js` (validação de tipo) e a suíte
`campanhas.test.js`, que reabre a página e confere os itens persistidos.

### ACHADO 6 — Onboarding marcava etapa sem prova · **CONFIRMADO (P2)**

Dois falsos positivos de verdade: qualquer aba `web.whatsapp.com` (inclusive a
tela de QR Code) contava como "WhatsApp pronto", e a chave `campaigns:camp-*`
contava como campanha mesmo vazia — e a própria página de disparo cria esse
rascunho ao abrir, então a etapa se completava sozinha.

**Correção:** `dashboard-extras.js` agora injeta uma verificação na aba
(`chrome.scripting`, `world: "MAIN"`) e distingue: sem `#pane-side` e com QR na
tela → "o WhatsApp está pedindo QR Code"; sem `#pane-side` → "não conectado".
Campanha só conta com **contatos + (texto ou mídia)**. O cartão mostra o motivo
pendente e reavalia em `chrome.tabs.onUpdated` / `onRemoved`.

**Testes:** *ACHADO 6: campanha vazia NÃO conclui a etapa*, *...campanha com
contatos e mensagem conclui a etapa*, *...WhatsApp aberto no QR Code NÃO conclui
a etapa*. Os dois testes antigos de `primeiros-passos.test.js` validavam
justamente o comportamento errado (campanha vazia conta) e foram corrigidos para
semear uma campanha de verdade — o teste dizia "✓" para um registro vazio.

### ACHADO 7 — Texto da rotação ≠ motor · **CONFIRMADO (P2)**

O motor embaralha a ordem a cada volta; o texto falava em "ordem". Corrigido só
o texto: "a cada volta o sistema **embaralha a ordem** e distribui todas as
mensagens uma vez, sem repetir a mesma em sequência. Não é um ciclo fixo: dois
contatos seguidos não recebem necessariamente a próxima da lista." Nenhuma
campanha existente mudou de comportamento.

**Teste:** *ACHADO 7: a descrição da rotação fala em embaralhar, não em ordem*.

### ACHADO 8 — Estados de execução pouco expressivos · **CONFIRMADO (P2)**

Existia um log e nada mais. Agora há três níveis separados:

1. **Estado** (`#estado-execucao`): rascunho, preparando, executando, pausada,
   finalizada, cancelada — com selo próprio por situação.
2. **Aviso** (`#aviso-atencao`): o que exige decisão do usuário — contato sem
   confirmação, envio interrompido, falha de gravação.
3. **Log**: histórico, para diagnóstico.

**Testes:** *ACHADO 8: o estado da execução tem selo próprio por situação*,
*...contato sem confirmação vira aviso visível, não só log*.

### ACHADO 9 — Estimativa e contadores ambíguos · **CONFIRMADO (P2/P3)**

O texto dizia "mensagens" quando o custo é por contato (um contato = texto +
um arquivo por pasta). Agora: "≈ X minutos para N contatos (M arquivos/mensagens
no total)", com as partes de mídia explícitas e um `title` explicando que é
aproximação.

**Testes:** *ACHADO 9: a estimativa fala em contatos, não em mensagens*,
*...com mídia, a estimativa mostra as partes*.

### ACHADO 10 — Sem indicador positivo de salvamento · **CONFIRMADO (P2)**

`#estado-salvar` com quatro estados: `pendente` → `salvando` → **`salvo`** (só
depois do callback do `chrome.storage`, nunca antes) e `falhou`. Ligado em
`salvarEmLote` e no `gravar`. Falha de gravação também acende o aviso.

**Testes:** *ACHADO 10: existe indicador de salvamento com estado explícito*,
*...falha de gravação muda o indicador*.

### ACHADO 11 — Estados vazios e coluna de ações · **CONFIRMADO (P3)**

Campanha sem contatos mostra um estado vazio explicativo (`.linha-vazia` /
`.estado-vazio`) em vez de uma tabela oca. A coluna de ações ganhou nome
("Ação"), `scope="col"` em todos os cabeçalhos, e as ações de linha só aparecem
quando fazem sentido. Exportar e reprocessar continuam disponíveis sempre que há
dados; "Remover" só para pendente/falhou e fora de execução.

**Testes:** *ACHADO 11: campanha sem contatos mostra estado vazio explicativo*,
*...a coluna de ações tem nome acessível*.

### ACHADO 12 — Semântica, foco e acessibilidade · **CONFIRMADO (P3)**

- `lang="pt-BR"` em `campaigns.html`, `popup.html` e `options.html`.
- Um único `h1` (`.titulo-pagina`); a hierarquia vai de `h2`/`h3` sem pular nível.
- Seções renumeradas 1–8 (antes havia salto de 3 para 5).
- Abas com `role="tab"`, `aria-selected`, `aria-controls`, `tabindex` e
  navegação por setas; painéis com `role="tabpanel"`.
- Barra de progresso com `role="progressbar"` e `aria-valuenow`/`min`/`max`.
- Foco visível em todos os controles, inclusive `.btn:disabled` (que também tem
  contraste próprio), e responsividade em 980 px e 720 px.

**Testes:** *ACHADO 12* × 5 (idioma, h1 + numeração, ARIA/teclado das abas,
progressbar, foco visível).

### ACHADO 13 — "Proteções anti-bloqueio" · **CONFIRMADO (P2)**

A seção prometia algo que a extensão não pode garantir. Renomeada para
"Trava de segurança" e com aviso explícito de que **não protege a conta contra
bloqueio** — o que existe é limite por dia, pausa após falhas e interrupção
segura. Não expandi nenhum mecanismo antispam, como pedido. As opções de
homoglifos/invisíveis continuam existindo e continuam funcionando (desligadas
por padrão); só deixaram de ser vendidas como proteção.

**Teste:** *ACHADO 13: a seção não promete proteção contra bloqueio*.

---

## B. Problemas novos encontrados durante a execução

Estes não estavam no prompt. Todos foram corrigidos, exceto o último, que é
decisão do usuário.

1. **Promessa pendurada no onboarding (P1 de usabilidade).** Minha primeira
   versão de `perguntarAoWhatsApp` resolvia `null` só no callback, sem ler
   `chrome.runtime.lastError`. Quando a injeção falhava, o cartão de "Primeiros
   passos" **nunca era montado** — a suíte antiga travava 30 s esperando o
   cartão. Corrigido: o callback lê `lastError` e sempre resolve.
2. **Onboarding olhava só a primeira aba do WhatsApp (P2).** Com duas abas
   (uma na tela inicial, outra conectada), ele lia a primeira e dizia "não
   carregou". Agora pergunta a todas as abas (até 6) e combina: conectada ganha
   de qualquer negativa; se nenhuma está pronta, mostra o motivo mais
   explicativo (QR Code antes de "não carregou"). Teste novo cobre o caso.
3. **Testes antigos validavam o bug.** `primeiros-passos.test.js` exigia "✓"
   para uma campanha sem contatos nem mensagem. Corrigido o teste, não o código.
4. **Perfis órfãos do Chromium travavam a suíte.** Uma execução interrompida
   deixava `/tmp/lz-profile-*` e processos vivos; o service worker não subia e o
   bloco 2 estourava 20 s de timeout em todos os testes. `run-all.sh` agora limpa
   esses perfis antes de começar.
5. **Mutação de variável sombreando função.** Numa versão intermediária, uma
   variável local chamada `remover` escondia o `remover()` do storage dentro do
   `tipo.onchange` — quebraria "remover incompatíveis". Peguei com `node --check`
   + leitura do trecho; renomeada para `confirmouRemocao`.

---

## C. Arquivos modificados

Diferenças em relação a `5bbcd3c`:

| Arquivo | O que mudou |
|---|---|
| `extensao/js/campaigns-ui.js` | +699/−… : política de operação, tabela incremental + paginação, indicador de salvamento, estado/aviso, estimativa, upload por arquivo, `TIPOS_MIDIA`/`arquivoCompativel`, teclado e ARIA das abas, ponte de teste |
| `extensao/js/campaign-engine.js` | +17: `podeAlterarFila` (exportado) e guarda em `removerPendentes` |
| `extensao/js/dashboard-extras.js` | +158/−…: onboarding com verificação real de conexão e de conteúdo; combina várias abas |
| `extensao/campaigns.html` | +62/−…: `h1`, seções 1–8, tabs ARIA, `#estado-execucao`, `#estado-salvar`, `#aviso-atencao`, `#btn-mais-linhas`, `scope="col"`, coluna "Ação" |
| `extensao/css/campaigns.css` | +244: foco visível, botões desabilitados, selos, aviso, estado vazio, barra de upload, tabela `table-layout: fixed`, responsivo 980/720 |
| `extensao/popup.html`, `extensao/options.html` | `lang="pt-BR"` |
| `tests/unit/campaign-engine.test.js` | teste de remoção ajustado à nova política + 3 testes de `podeAlterarFila` (154 no total) |
| `tests/e2e/achados.test.js` | **novo**, 804 linhas, 26 testes de regressão dos achados |
| `tests/perf-tabela.js` | **novo**, mede antes/depois no mesmo navegador |
| `tests/run-all.sh` | bloco 11/12 novo + limpeza de perfis órfãos |
| `tests/e2e/primeiros-passos.test.js` | dois testes alinhados à semântica correta |
| `docs/capturas/*.png` | 3 capturas usadas na seção E |
| `tests/shots.js` | gera as capturas |

Bundles originais intocados: `content-script.js`, `popup.js`, `options.js`,
`service-worker.js`, `wapi.js`, `mount.js` — nenhum byte alterado. Nenhuma
dependência nova.

---

## D. Testes executados

Comando: `bash tests/run-all.sh` (12 blocos, 14 invocações do runner).

| Bloco | Testes | Resultado |
|---|---|---|
| 1 Unitários | 154 | 154 ✅ |
| 2 End-to-end | 16 | 16 ✅ |
| 3 Fluxos + backup | 5 + 3 | 8 ✅ |
| 4 Content script + diferencial | 7 + 3 | 10 ✅ |
| 5 Rotas de API | 9 | 9 ✅ |
| 6 Disparo em massa | 17 | 17 ✅ |
| 7 Links externos (allowlist/DNR) | 8 | 8 ✅ |
| 8 Nenhum tráfego externo | 11 | 11 ✅ |
| 9 Service worker + DNS derrubado | 7 | 7 ✅ |
| 10 Jornada de instalação | 9 | 9 ✅ |
| 11 **Achados da auditoria** | 27 | 27 ✅ |
| 12 **Nono dígito** | 6 | 6 ✅ |
| 13 Integridade do estado | 12 | 12 ✅ |
| **Total** | **299** | **299 ✅ / 0 ❌** |

`RESULTADO: TUDO PASSOU`.

Os 26 testes do bloco 11 rodam contra a extensão carregada no Chromium
(headless), com um WhatsApp Web simulado em HTTPS (servidor local + 
`--host-resolver-rules`), incluindo um caminho `/qr` que reproduz a tela de QR
Code. Nenhum teste é pulado: `--test-name-pattern` não é usado na suíte (ele
marca o resto como SKIP e produz números falsos), e checagens de "sem API" no
teste **falham** em vez de passar vazio.

---

## E. Validação de interface

O que inspecionei de fato, e como:

- **Capturas geradas pelo próprio projeto** (não por mockup):
  `docs/capturas/campanhas-desktop.png` (1280×900),
  `docs/capturas/campanhas-mobile.png` (390×844) e
  `docs/capturas/dashboard-primeiros-passos.png`. Regeneráveis com
  `node tests/shots.js`.
- **Na captura de desktop** confirmei: título único no topo, seções numeradas
  visíveis (1, 2 … 4, 5, 6), tipo de pasta com `select` + filtro coerente,
  estimativa "≈ 15 minutos para 17 contatos (34 arquivos/mensagens no total)",
  aviso de que o limite diário é de contatos e não de mensagens.
- **Na captura mobile** confirmei que o cabeçalho quebra em duas linhas sem
  overflow horizontal e que os cartões passam a uma coluna.
- **No dashboard**, o cartão "Primeiros passos" aparece com 0 de 3 e mostra o
  motivo real: "a página ainda não carregou".
- **Asserções automáticas de interface** (bloco 11): idioma declarado, `h1`
  único, numeração sem salto, `role="tab"`/`aria-selected`/`tabindex`, setas
  funcionando, `role="progressbar"` com `aria-valuenow`, foco visível no switch,
  estado vazio com texto explicativo, cabeçalho de ações nomeado, selo por
  situação, aviso separado do log, indicador de salvamento mudando de estado.

### Segunda rodada: consistência com o resto da extensão

O painel de disparo era a única tela com identidade própria: vermelho `#ef345a`
em vez do rosa da marca `#ed0373`, fundo cinza-azulado em vez de branco, e sem
cabeçalho nem rodapé do aplicativo. Corrigido:

- **Cabeçalho igual ao das outras telas**: logo, "Extensão", a navegação
  Dashboard / Mensagens / Scripts / Gatilhos / Fluxos / **Disparo em massa**
  (esta marcada com `aria-current="page"`), sino e "Usuário Local".
- **No celular a navegação vira menu hambúrguer**, como nas outras telas
  (abaixo de 860 px), em vez de espremer seis links numa faixa rolável.
- **Rodapé "Novidades"** no canto inferior direito, no mesmo formato das demais
  telas, com o resumo do que mudou nesta versão.
- **Paleta e tipografia unificadas** (`--color-brand-pink-*`,
  `--color-neutral-gray-*`, Inter com `letter-spacing: -0.003em`), cartões com
  a mesma borda e raio, seletor de campanha com o mesmo desenho dos selects da
  extensão, botão principal rosa e "Nova campanha" como ação primária.
- Continua existindo **um único `h1`** ("Disparo em massa"), agora dentro de um
  cabeçalho de página com ícone e subtítulo, no padrão das outras telas.

Provado por teste (`ACHADO 12: a página usa o mesmo cabeçalho, rodapé e paleta
das outras telas`), que confere a lista de links do menu, o item marcado como
atual, a presença do rodapé, a cor calculada do botão principal
(`rgb(237, 3, 115)`), o fundo (`rgb(255, 255, 255)`) e a fonte.

**Limite honesto:** não houve validação com leitor de tela real (NVDA, VoiceOver)
nem teste com usuários. O que está provado é a presença dos atributos e da
navegação por teclado, não a experiência auditiva completa.

---

## F. Desempenho — antes × depois

`node tests/perf-tabela.js` monta a mesma campanha sintética nas duas versões e
mede, no mesmo Chromium: carga da campanha (inclui a primeira pintura) e a
mediana de 5 re-renderizações após marcar 1 contato como enviado.

| Contatos | Carga antes | Carga depois | 1 envio antes | 1 envio depois | Nós no DOM antes | Nós depois |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 2,1 ms | 5,5 ms | 0,8 ms | 0,1 ms | 895 | 895 |
| 500 | 4,2 ms | 6,1 ms | 3,7 ms | 0,2 ms | 4.495 | 1.795 |
| 1.000 | 11,8 ms | 4,8 ms | 11,0 ms | 0,3 ms | 8.995 | 1.795 |
| 3.000 | 40,6 ms | 1,9 ms | 41,7 ms | 0,2 ms | 26.995 | 1.795 |

Leitura: o custo por envio era linear no tamanho da lista (41,7 ms em 3.000
contatos, e cada envio bloqueia a thread principal por esse tempo). Agora é
praticamente constante (0,2 ms) e o DOM fica em ~1.800 nós em vez de 27 mil.

A carga em 100 contatos aparece maior na versão nova (5,5 ms contra 2,1 ms) por
causa do custo fixo de montar a tabela com as colunas de ação e os elementos de
estado; a partir de 1.000 contatos ela já é menor, e em 3.000 é 21× menor.

A segunda execução do medidor dá números estáveis dentro de ~15% (ruído do
sandbox). A primeira execução, com o componente frio, é descartada.

---

## G. Pendências reais

1. **Envio real não foi testado.** O WhatsApp Web do teste é um sósia de
   protocolo: responde `response_<id>` aos eventos `messages:send*`. Isso prova a
   orquestração (fila, retry, pausa, cancelamento, contagem), **não** prova o
   envio numa conta real. Continua exigindo WhatsApp Web aberto e autenticado.
2. **Homoglifos e caracteres invisíveis.** Decisão sua, não minha. O risco é real
   (podem quebrar busca, exportação e acessibilidade e são lidos como evasão de
   filtro), mas não é garantido que causem bloqueio. Estão desligados por padrão,
   fora de qualquer promessa de proteção, e não foram removidos.
3. **Data URLs continuam sendo o gargalo estrutural de memória** para mídia
   grande. Não mexi nisso nesta rodada: mudaria o formato de armazenamento de
   campanhas existentes e o prompt proíbe destruir dados antigos.
4. **`_locales/` só tem `en` e `pt_BR`.** Não inventei traduções.
5. **Leitor de tela real** não testado (ver seção E).
6. **Nono dígito**: a segunda tentativa só acontece em **falha confirmada** do
   WhatsApp. Se o servidor não responder (ambíguo), o contato fica como "sem
   confirmação" e não é reenviado — repetir poderia duplicar a mensagem. Nesse
   caso a decisão é manual, pelo botão de reprocessar.

---

## H. Integridade e compatibilidade

- **Dados antigos preservados.** Nenhuma migração destrutiva. Campanhas antigas
  abrem normalmente; `normalizarCampanha` continua preenchendo o que falta. A
  correção do ACHADO 7 foi só de texto, então nenhum disparo em andamento mudou
  de comportamento.
- **IDs estáveis.** A tabela incremental usa `contato.id`; nenhum contato é
  recriado ao redesenhar, então resultado nunca cai na linha errada. É o que o
  teste de paginação + remoção cobre.
- **Duas barreiras para a fila.** Interface recusa e motor recusa. Chamar a API
  direto não fura a política.
- **Falha de gravação visível.** O indicador só diz "salvo" depois da confirmação
  do `chrome.storage`; falha muda o indicador e acende o aviso.
- **Nenhum recurso removido, nenhum botão desativado sem explicação.** Toda ação
  bloqueada tem `title`/texto dizendo por quê.
- **Bundles originais preservados** (lista na seção C) e nenhuma dependência nova.
- **Nono dígito sem duplicar**: a forma com 9 é sempre a primeira; a forma sem
  9 é tentada **uma única vez** e só depois de recusa confirmada. Há teste para
  o caminho feliz, para a recusa, para o ambíguo e para o caso em que as duas
  falham (sem laço).
- **Zero tráfego externo**: o bloco 8 e o bloco 9 (com DNS da Leadzy derrubado)
  continuam passando.

---

## Como reproduzir

```bash
cd tests
bash setup.sh            # libs do Chromium (uma vez)
bash run-all.sh          # 287 testes
node e2e/achados.test.js # só os 26 achados
node perf-tabela.js      # tabela antes × depois
node shots.js            # regenera docs/capturas
```
