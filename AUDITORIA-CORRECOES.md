# Auditoria externa — o que era verdade

Recebi uma revisão estática do repositório. Verifiquei **cada afirmação**
executando código, não lendo. O resultado abaixo separa o que era bug real,
o que era falso positivo e o que foi corrigido.

---

## Como verifiquei

Para cada suspeita escrevi uma sonda que reproduz o cenário:

```bash
node /tmp/auditoria-probe.js     # identidade por índice, validação, rotação
node /tmp/probe2.js              # DDI x nono dígito
```

E, depois da correção, um teste de regressão que **falha** se o bug voltar.

---

## Bugs confirmados e corrigidos

### 1. CSV desalinhado — CONFIRMADO

O cabeçalho declarava 5 colunas:

```
numero,status,enviado_em,erro,tentativas
```

e cada linha escrevia 6 valores:

```js
[campanha.contatos.indexOf(c), c.numero, c.status, c.enviadoEm, c.erro, c.tentativas]
```

Posição + 5 campos. No Excel, tudo saía deslocado uma coluna.

**Achado extra:** `indexOf(c)` dentro do `forEach` era **O(n²)** — exportar
10 mil contatos fazia 50 milhões de comparações.

**Corrigido:** cabeçalho com `#` e índice pela posição do laço.
Teste: `toda linha do CSV tem o mesmo número de colunas do cabeçalho`.

---

### 2. Identidade por índice — CONFIRMADO (o mais grave)

`marcarEnviado(campanha, indice)` e `marcarFalhou(campanha, indice)` localizavam
o contato **pela posição na lista**. Se a lista mudasse durante o envio, a
resposta caía no registro errado.

Reprodução executada:

```
enviando: 5511900000001 indice 0
apos remover, lista: [ '5511900000002', '5511900000003', '5511900000004' ]
marcou como enviado: 5511900000002
>>> ESPERADO: 5511900000001 | OBTIDO: 5511900000002  *** BUG ***
```

O contato que recebeu era marcado como pendente, e o vizinho que **não**
recebeu aparecia como enviado.

**Corrigido:** cada contato ganha um `id` estável. `buscarContato()` procura
por id e cai no índice só para compatibilidade com dados antigos.

---

### 3. Texto reenviado após falha de mídia — CONFIRMADO

`enviarContato()` encadeava todas as partes numa Promise só. Texto saía, áudio
falhava → o contato inteiro virava `falhou`. Ao reprocessar, `montarEnvio`
sorteava **outro** arquivo e remontava o texto — a pessoa recebia a mensagem
duas vezes.

**Corrigido:** o plano de envio é congelado em `contato.envio`, cada parte tem
status próprio, e o reprocessamento envia só o que falta.

Testes: `o plano de envio é congelado`, `reprocessar envia só a parte que falhou`.

---

### 4. Persistência silenciosa — CONFIRMADO

```js
chrome.storage.local.set(obj, function () {
  res();          // resolve sempre
});
```

Se a gravação falhasse (cota estourada), a interface continuava como se
tivesse salvo.

**Corrigido:** `ler`, `gravar` e `remover` checam `chrome.runtime.lastError` e
rejeitam. A interface mostra uma faixa vermelha:
"As últimas alterações NÃO foram salvas."

---

### 5. Campanha travada após recarregar — CONFIRMADO

`iniciarPagina()` carregava a campanha com `status: "executando"` e não
reconstruía o objeto de execução. A tela mostrava "Executando", e Pausar /
Cancelar dependiam de `execucao` — que era `null`. **Controles mortos.**

**Corrigido:** ao carregar, `normalizarCampanha()` transforma `executando` em
`pausada` + `interrompida`, e contato em `enviando` vira `desconhecido`.

---

### 6. Resultado ambíguo tratado como falha — CONFIRMADO

Timeout de 60 s sem resposta era marcado como `falhou`. Mas a mensagem pode ter
sido entregue — a confirmação é que se perdeu. Reprocessar duplicaria.

**Corrigido:** novo status `desconhecido`. Não conta como falha, não volta para
a fila no reprocessamento e aparece no aviso da tela.

---

### 7. Validação assimétrica de DDI — CONFIRMADO

```
5511234567890  ACEITO    (DDI, 11 dígitos, não começa com 9)
11234567890    RECUSADO  (mesmo número sem DDI)
```

O caminho com DDI não aplicava a regra do nono dígito que o caminho sem DDI
aplicava.

**Corrigido:** a mesma regra vale nos dois caminhos, com o mesmo motivo de erro.

---

### 8. Execuções concorrentes — CONFIRMADO

`iniciar()` fazia validação assíncrona antes de criar `execucao`. Quatro
cliques rápidos passavam todos pela checagem.

**Corrigido:** trava síncrona (`preparando`) antes de qualquer `await`.
Teste: `vários cliques em Iniciar produzem uma única execução`.

---

### 9. Edição da lista durante o envio — CONFIRMADO

`analisarLista()` reconstruía `campanha.contatos` a qualquer digitação e
zerava o cursor.

**Corrigido:** durante a execução o campo fica `readOnly`, com cursor
`not-allowed` e tooltip, e `analisarLista()` recusa reconstruir a fila.

---

### 10. Rotas desconhecidas simulando sucesso — CONFIRMADO

O fallback devolvia `[]` para GET e `{success:true}` para o resto.

**Medido antes de mexer:** naveguei todos os menus + popup. Só **1 rota** é
interceptada em uso normal (`/feature-flags/killswitch_extension_trigger`, que
é mapeada). O fallback **nunca** é atingido — então trocar por erro é seguro.

**Corrigido:** HTTP 501 com `{success:false, nao_mapeada:true, rota}`.

---

## Falso positivo

### Reprocessar falhas duplicando mídia

O auditor levantou que `_ordem` da rotação poderia apontar para índice
inexistente se a lista de textos mudasse. Testei removendo um texto no meio da
rotação: **não reproduziu** — a ordem já era reconstruída quando esvaziava.

Mesmo assim endureci: a rotação agora guarda uma assinatura do conteúdo e
invalida a ordem quando os textos mudam. Há teste para isso.

### Reordenar a lista

Reordenar sozinho **não** quebrava, porque os objetos eram preservados e o
índice recalculado dava o mesmo valor. O que quebrava era **remover** um
contato — esse caso está coberto pelo item 2.

---

## O que eu não corrigi, e por quê

### Cache de mídia: uma afirmação minha que era falsa

Ao revisar esta auditoria de novo, conferi a linha do `MELHORIAS.md` que dizia
"cache de mídia liberado por campanha". **Não era verdade** — o cache só era
limpo ao *excluir* o arquivo, nunca após o envio. Documentei algo que não
existia.

Corrigido agora: o dataURL sai da memória assim que a parte é confirmada, e o
arquivo continua no storage. Teste: `o dataURL é liberado da memória depois de
enviado` (cache 1 → 0, e o arquivo permanece).

### Homoglifos e caracteres invisíveis

O auditor recomenda remover as "proteções anti-bloqueio", argumentando que
servem para escapar de antispam e prejudicam acessibilidade.

**Não removi** porque foi um requisito explícito seu. Mas registro o ponto dele
como legítimo: essas transformações não aumentam a entregabilidade de forma
comprovada e têm custo real (a mensagem deixa de ser pesquisável e o leitor de
tela lê os caracteres trocados).

Elas continuam **desligadas por padrão**. Se quiser, removo em 10 minutos.

### Validação prévia de número

Continua não feita. O `wapi.js` tem `validatePhoneNumber`, mas expor exigiria
editar o bundle — o teste diferencial protege a integridade dele.

### Limite diário: contatos ou mensagens?

O contador soma **contatos concluídos**, não mensagens individuais. Um contato
com texto + 2 mídias conta 1.

**Agora está escrito na tela:** o campo passou a se chamar "Limite de contatos
por dia", o contador diz "contatos concluídos" e há uma nota explicando que um
contato conta 1 mesmo recebendo texto e áudio.

---

## Suíte depois das correções

**11 blocos, 258 testes, 0 falhas.**

| Bloco | Antes | Agora |
|---|---|---|
| Unitários | 139 | **151** |
| End-to-end | 16 | 16 |
| Fluxos + backup | 8 | 8 |
| Content script | 10 | 10 |
| Rotas de API | 7 | **9** |
| Disparo em massa | 17 | 17 |
| Links externos | 8 | 8 |
| Auditoria de botões | 11 | 11 |
| Service worker | 7 | 7 |
| Jornada de instalação | 9 | 9 |
| **Integridade do estado** | — | **12** |

Tempo total: ~11,5 minutos.


---

## Segunda passagem

Esta auditoria foi enviada de novo, idêntica. Reconferi os 11 pontos no código
atual e fechei o que ainda faltava:

| Item | Situação | O que fiz |
|---|---|---|
| 5. Peso das mídias | **era falso na minha doc** | libero o dataURL após o envio; testado |
| F. Cancelar no meio de mídias | corrigido, mas **sem teste** | teste com mídia lenta provando que a última parte não começa |
| J. Definição do limite diário | pendente | rótulo e nota na interface |
| K. Janela da gravação em lote | parcial | gravação em `pagehide`/`beforeunload` |

Os outros sete já estavam corrigidos com teste de regressão desde a primeira
passagem.
