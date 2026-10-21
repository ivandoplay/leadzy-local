# O que dá para melhorar

> **STATUS: os itens 1.1 a 1.6, 2.1 e 2.2 foram implementados e testados.**
> O histórico da medição fica abaixo; o que segue pendente está marcado.
> Suíte: **215 testes, 9 blocos, tudo verde**.

## Feito nesta rodada

| Item | O que mudou | Prova |
|---|---|---|
| 1.1 Ritmo | espera com prazo absoluto (`Date.now`) | `e2e` — trava a thread 2 s e o intervalo continua em ~3000 ms |
| 1.2 Gravação | lote: a cada 10 envios ou 15 s; forçada ao pausar/parar | `e2e` — progresso salvo ao pausar |
| 1.3 *(parcial)* | trava de segurança substitui a validação prévia | ver observação abaixo |
| 1.4 Login | bloqueia início se o WhatsApp está no QR Code | `e2e` — 3 testes |
| 1.5 Memória | dataURL liberado após o envio (não antes: era uma afirmação minha sem código) | `e2e` — cache cai de 1 para 0 após enviar |
| 1.6 Rotação | Fisher-Yates por volta, sem repetir em sequência | `unit` — 3 testes |
| 1.7 | limite diário + pausa automática por falhas seguidas | `unit` 8 + `e2e` 3 |
| 2.1 | `crm-bridge-content-script.js` removido | zip: 58 arquivos, sem o arquivo |

**Bônus encontrado pelos testes:** um laço de disparo antigo continuava
dirigindo a campanha **nova** (o laço lia uma variável global). Agora cada laço
pertence a uma campanha e morre se ela mudar.

## Ainda pendente

- **1.3 Validação de número antes do envio** — o `wapi.js` tem
  `validatePhoneNumber`, mas ela não está no barramento de comandos. Expor
  exigiria editar o bundle, e o teste diferencial protege a integridade dele.
  Mitigado pela trava de falhas seguidas.
- **1.8** retomar após fechar o navegador, importar CSV, personalização `{{nome}}`
- **2.2** métricas reais no dashboard
- **2.3** locales `es` / `it`

---

Levantado lendo o código e **medindo** no Chromium. Cada item abaixo tem
evidência; o que eu não consegui medir está marcado como tal.

---

# PARTE 1 — Disparo em massa (o que acabamos de construir)

## 1.1 BUG REAL: o ritmo atrasa a cada travada da página

O intervalo é contado **de 250 em 250 ms**, somando ticks:

```js
var restante = ms;
setInterval(function () {
  restante -= 250;         // <- conta ticks, não tempo real
  if (restante <= 0) res();
}, 250);
```

Se a página travar 2 s (renderização, gravação no storage, GC, aba em segundo
plano), **esses 2 s não são contados** — o intervalo estica.

**Medido:**

| Algoritmo | Espera pedida | Com trava de 2 s no meio | Erro |
|---|---|---|---|
| Atual (conta ticks) | 5000 ms | **7000 ms** | +2000 ms |
| Prazo absoluto (`Date.now()`) | 5000 ms | 5000 ms | 0 ms |

Numa campanha de 500 mensagens isso acumula minutos de atraso. E em aba de
fundo o Chromium estrangula timers — nesse caso o atraso seria muito maior.

**Correção:** guardar o prazo absoluto e recalcular a cada passo.
É uma mudança de 6 linhas.

---

## 1.2 Gravação no storage a cada envio

Depois de **cada** mensagem o app salva a campanha inteira:

| Contatos | Tamanho do objeto | Tempo de gravação |
|---|---|---|
| 1.000 | 124 KB | ~50 ms |
| 3.000 | 371 KB | ~130 ms |
| 10.000 | **1.240 KB** | **429 ms** |

Numa campanha de 10 mil, isso é **1,2 GB de escrita** ao longo da execução e
meio segundo de travamento por envio — que, combinado com o item 1.1, ainda
atrasa o ritmo.

**Correção:** gravar a cada N envios (ou a cada 10 s) e sempre ao pausar/parar.
O progresso em memória não se perde no uso normal.

---

## 1.3 Não verifica se o número existe antes de enviar

O `wapi.js` **tem** a função certa:

```js
async validatePhoneNumber(e) {
  // usa WidFactory.createUserWidOrThrow + WAWebQueryExistsJob.queryExist
}
```

Mas ela **não está no barramento de comandos**. O barramento só registra:

```
SEND_TEXT_REQUEST · SEND_AUDIO_REQUEST · SEND_MEDIA_REQUEST
SEND_DOCUMENT_REQUEST · SIGNATURE_UPDATED · GET_LABELS_REQUEST
```

Consequência: número inexistente só descobre **na hora do envio**, queimando um
slot e aumentando o risco de bloqueio.

**Correção:** precisa de uma ponte a mais — um `validateNumber` no
`wapi.js` (ou um `VALIDATE_NUMBER_REQUEST` no barramento). É a única mudança
que exigiria tocar no bundle original, adicionando um handler ao lado dos outros.

---

## 1.4 Não checa se o WhatsApp está logado

Hoje o app só verifica se **existe uma aba** do WhatsApp. Se a aba estiver no QR
Code, o disparo começa e **todos** falham com erro genérico.

**Correção:** antes de iniciar, procurar `.app-wrapper-web` + ausência do QR.
Se não estiver conectado, avisar "faça login no WhatsApp" em vez de queimar a lista.

---

## 1.5 Mídia carregada inteira na memória

Cada áudio/imagem vira dataURL e fica num cache que **nunca é liberado**:

```js
midiasCache[itemId] = dataUrl; // 1 por arquivo, para sempre
```

50 áudios de 2 MB = **100 MB de RAM** parados. Num notebook modesto, a aba
começa a engasgar.

**Correção:** liberar depois de enviar (ou guardar em IndexedDB e ler sob demanda).

---

## 1.6 Rotação previsível

```js
base = lista[indice % lista.length]; // A, B, C, A, B, C...
```

Sempre a mesma ordem. Quem olhar o histórico vê um ciclo perfeito — que é
justamente o padrão que sistemas anti-spam procuram.

**Correção:** embaralhar a cada volta (evitando repetir a anterior).

---

## 1.7 Faltam proteções que o mercado tem

| Recurso | Situação |
|---|---|
| Limite diário de mensagens | não existe |
| Aquecimento de número novo | não existe |
| Retry automático em falha transitória | não existe (só manual) |
| Detecção de bloqueio em tempo real | não existe |
| Pausa automática se muitas falhas seguidas | não existe |

O item do meio é o mais barato e o mais útil: **se 5 envios seguidos falharem,
pausar sozinho** em vez de queimar a lista inteira. Hoje ele continuaria
tentando os 500 contatos.

---

## 1.8 Detalhes menores

- **Não retoma após fechar o navegador.** O progresso é salvo, mas o laço só
  volta clicando em Iniciar.
- **Sem importar arquivo.** Só cola texto. Um `.csv`/`.txt` seria trivial.
- **Timeout fixo de 60 s** — áudio grande em conexão lenta pode estourar.
- **Sem personalização** (`{{nome}}`). Você não pediu, mas o motor já tem
  variáveis no fluxo — seria reaproveitar.
- **Tabela renderiza tudo** (10 mil contatos = 10 mil linhas, 177 ms). Aceitável
  hoje; com 50 mil travaria.

---

# PARTE 2 — Sistema existente

## 2.1 Código morto com risco de segurança

`js/crm-bridge-content-script.js` — **nunca é carregado** (não está no manifest),
mas o conteúdo é preocupante:

```js
window.addEventListener("message", async e => {
  if (e.source !== window) return;
  if (isValid(o)) {
    const r = await chrome.runtime.sendMessage(o.command); // repassa QUALQUER comando
  }
});
```

É a ponte que deixava o site da Leadzy mandar comandos para a extensão — o
mecanismo `externally_connectable`, que a gente **removeu** do manifest. O
arquivo ficou esquecido.

**Recomendação: apagar.** Nunca roda hoje; e se alguém reinserir no manifest sem
querer, abre um buraco.

## 2.2 Métricas do dashboard mostram zero para sempre

"Conversas humanizadas" e "horas de áudio" vêm do `syncMetrics`, que é um stub
que devolve `"Sync desabilitado"`. Os contadores nunca sobem.

**Dá para consertar de verdade:** os envios reais já passam pela extensão.
Dava para contar localmente e mostrar número verdadeiro em vez de zero.

## 2.3 Idioma

A interface tem traduções completas em **espanhol** (13.102 ocorrências) e
**italiano** (8.035) — os 4 bandeirinhas existem. Mas o `_locales/` só tem
`en` e `pt_BR`, então **o nome e a descrição da extensão** na loja só aparecem
nesses dois.

**Recomendação:** criar `_locales/es` e `_locales/it` (2 arquivos, ~5 linhas cada).

## 2.4 O menu "Disparo em massa" é injetado clonando o DOM

```js
var btn = modelo.cloneNode(false);  // clone do botão Dashboard
nav.appendChild(span);
```

Funciona, mas se o Vue re-renderizar a barra, o item pode piscar ou duplicar.
Tenho um `MutationObserver` que repõe — na prática estável, mas é o ponto mais
frágil da integração visual.

**Alternativa mais sólida:** colocar um botão flutuante ou uma seção própria no
topo, em vez de disputar espaço com o roteador do Vue.

---

# O que eu faria primeiro

| # | Item | Esforço | Ganho |
|---|---|---|---|
| 1 | Corrigir o ritmo (prazo absoluto) | ~15 min | bug real, medido |
| 2 | Pausa automática após N falhas seguidas | ~30 min | proteção contra ban |
| 3 | Gravar no storage em lote | ~20 min | tira 429 ms de travamento |
| 4 | Verificar login do WhatsApp antes de iniciar | ~20 min | evita queimar a lista |
| 5 | Apagar o código morto | ~2 min | fecha buraco de segurança |
| 6 | Embaralhar a rotação | ~10 min | menos padrão detectável |
| 7 | Limite diário | ~1 h | a proteção que mais falta |
| 8 | Validar número antes de enviar | ~1 h | exige ponte no wapi |

Os cinco primeiros somam menos de uma hora e resolvem tudo o que é bug ou risco.

Me diz quais quer que eu faça — ou se prefere que eu faça os cinco primeiros
de uma vez.
