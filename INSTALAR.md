# Leadzy local — instalação e uso

Versão sem login e sem servidor. O bundle original **não foi modificado**: toda a
mudança está em um arquivo novo, `js/local-bootstrap.js`.

Pacote pronto: **`/home/user/leadzy-local.zip`** (ou a pasta `/home/user/extensao/`)

---

## Instalar

1. Descompacte `leadzy-local.zip` em uma pasta que você não vá apagar.
2. Abra `chrome://extensions` (ou `edge://extensions`).
3. Ligue **Modo do desenvolvedor** (canto superior direito).
4. **Carregar sem compactação** → escolha a pasta descompactada.
5. Clique no ícone da extensão. Deve abrir direto no **Dashboard**.

Se aparecer a tela de login por um instante, ela se corrige sozinha em ~0,4 s
(auto-reparo) ou no próximo clique.

---

## O que foi mudado

| Arquivo | Mudança |
|---|---|
| `campaigns.html` + `js/campaign-*.js` + `css/campaigns.css` | **NOVOS.** Tela de disparo em massa |
| `rules/bloqueio-externo.json` | **NOVO.** Bloqueio de rede para `*.leadzy.com.br` (declarativeNetRequest) |
| `js/sw-guard.js` + `js/service-worker-local.js` | **NOVOS.** Guarda de rede do service worker |
| `js/local-bootstrap.js` | **NOVO.** Licença local + mocks de rede + conversor de áudio + bloqueio de navegação externa + guarda de imagem |
| `css/popup.css`, `css/options.css`, `css/content-script.css` | `@import` do Google Fonts trocado por `@font-face` local (Inter do próprio pacote) |
| `manifest.json` | adiciona o script acima no content script; remove `update_url`; remove `externally_connectable` |
| `popup.html` | carrega o script antes de `js/popup.js` |
| `options.html` | carrega o script antes de `js/options.js` |
| `_metadata/` | removido (assinatura da Chrome Web Store, não faz sentido aqui) |

Nenhum dos bundles (`popup.js`, `options.js`, `content-script.js`, `service-worker.js`,
`wapi.js`) foi tocado.

---

## Como a camada funciona

### 1. Licença local
Grava no `chrome.storage.local`:

```
access_token = "local-offline.leadzy.0000000000.local"
me           = { id, name, email, organization, ... }
```

O route guard do app só verifica **se existe** `access_token` — não valida JWT,
não chama API. Com as duas chaves, a SPA entra direto.

### 2. Interceptação de rede
`fetch` **e** `XMLHttpRequest` (o axios usa XHR) são interceptados para qualquer
host `*.leadzy.com.br`. Respostas locais:

| Rota | Resposta |
|---|---|
| `POST /auth/login` | token local + usuário |
| `GET /auth/me` | usuário local |
| `GET /plan-features/product-lines` | `{hasChat: true, hasCrm: false, isPro: true}` |
| `GET /subscriptions/active` | uma assinatura `ACTIVE` até 2099 |
| `GET /feature-flags/*` | `{enabled: false}` |
| `GET /announcements/active` | `[]` |
| `POST /convert` | áudio convertido localmente |
| qualquer outra rota | `[]` (GET) ou `{}` — nada sai do navegador |

### 3. Conversor de áudio (`/convert`)
O Chrome grava `audio/webm;codecs=opus`; o WhatsApp exige `audio/ogg;codecs=opus`.
Como o codec é o mesmo (Opus), o script **troca só o container** — extrai os
pacotes Opus do WebM e remonta em Ogg. **Sem recodificar, sem perda, sem WASM.**

Validado com ffmpeg: o PCM decodificado do Ogg gerado é **bit-idêntico** ao do
WebM de origem (diferença máxima = 0 amostras), com duração e canais corretos,
inclusive para WebM gravado ao vivo (clusters de tamanho desconhecido).

Se o áudio não for Opus (ex.: mp4/aac), devolve o original e avisa no console.

---

## Configuração

Tudo no topo de `js/local-bootstrap.js`:

```js
var CONFIG = {
  token: "...",
  user: { name: "Usuário Local", email: "local@localhost", ... },
  productLines: { hasChat: true, hasCrm: false, isPro: true, activeProducts: ["CHAT"] },
  subscriptions: [ ... ],
  convertMode: "remux",   // "remux" | "passthrough"
  debug: false,           // true = logs [LZ-LOCAL] no console
};
```

- **`hasCrm`** deixe `false`. O CRM chama `/tags`, `/settings/team` e
  `/notifications`, que não existem localmente.
- **`convertMode: "passthrough"`** devolve o áudio sem mexer — use para isolar
  problemas de conversão.
- **`debug: true`** mostra o que está sendo interceptado.

---

## Problemas comuns

**Cai na tela de login**
Confira `chrome.storage.local` (DevTools do popup → Application → Storage).
Deve ter `access_token`. Se não tiver, veja se `js/local-bootstrap.js` está no
`manifest.json` **antes** de `js/content-script.js` e no `popup.html` **antes**
de `js/popup.js`.

**Áudio sai como arquivo, não como mensagem de voz**
Significa que o WhatsApp recusou o Ogg. Ligue `debug: true` e veja no console se
aparece `remux falhou`. O motivo mais comum é áudio original em mp4/aac (aí o
remux não se aplica) ou mais de 1 canal.

**Modal "número não registrado"**
A lista de números fica em `chrome.storage.local["user-wpp"]`. Se aparecer,
cadastre o número pela própria interface — é gravado localmente, sem servidor.

**Não quero mais / quero voltar ao original**
Apague `js/local-bootstrap.js`, remova a linha dele do `manifest.json` e as tags
`<script>` do `popup.html`/`options.html`. Ou reinstale o zip original.

---

## Limites conhecidos

- **Atualizações**: sem `update_url`, a extensão não se atualiza sozinha — e é
  bom assim, senão a loja sobrescreveria esta versão. Se a Leadzy lançar uma
  versão nova, o patch precisa ser reaplicado do zero.
- **WhatsApp**: a automação continua dependendo de hook nos módulos internos do
  WhatsApp Web (`wapi.js`). Quando o WhatsApp muda o bundle, quebra — e agora
  não há atualização automática para consertar.
- **`wapi.js` não foi tocado** e continua sendo a peça mais frágil do conjunto.
- Este pacote não envia nada para fora, mas também não recebe as correções de
  segurança que a Leadzy publicaria.

---

## Verificações que rodei

**301 testes automatizados, nenhum pulado, nenhum falhando.** Os E2E rodam em Chromium real com a
extensão carregada (`--load-extension`), não em jsdom. A suíte completa está em
`/home/user/tests/` — rode com `./run-all.sh`.

| Camada | Testes | O que cobre |
|---|---|---|
| Unitários | **151** | manifest, roteador de mocks, remux de áudio, shims de rede, guarda do SW, bloqueio de links |
| E2E (Chromium) | **16** | popup, 6 rotas, navegação, criação de mensagem/script/gatilho pela UI, `/convert` |
| Content script | **7** | injeção no mundo isolado do WhatsApp, isolamento do mundo da página |
| Diferencial | **3** | patch vs. pacote original (comprova que só a autenticação mudou) |
| **Fluxos** | **5** | templates, criar fluxo, nomear, salvar rascunho no storage, 12 tipos de nó, simulador |
| **Backup / restauração** | **3** | exporta `.lzb`, valida o ZIP, restaura em perfil limpo e confere os dados |
| **Disparo em massa** | **17** | lista, 3 modos de texto, proteções, pastas, pausa/retomada |
| **Cobertura de rotas** | **7** | nenhuma rota cai no fallback genérico |
| **Links externos** | **8** | `<a target=_blank>`, âncoras de suporte e DNR, no navegador real |
| Botões / rede | **11** | clica em **todos** os botões de **todas** as telas e falha se algo sair para fora |
| **Service worker + DNS morto** | **7** | roda tudo com o DNS da Leadzy apontando para porta morta |

### Destaques

- **Os 6 bundles originais estão byte a byte com o tamanho original** — teste
  automático de que nada foi reescrito.
- **Remux de áudio:** os pacotes Opus do Ogg gerado são **byte a byte idênticos**
  ao gabarito produzido pelo ffmpeg (`-c:a copy`), em três arquivos diferentes
  (mono, estéreo, e WebM gravado ao vivo com clusters de tamanho desconhecido).
  O Ogg gerado ainda passa por um validador estrutural completo escrito de forma
  independente (CRC, sequência, serial, granulepos, BOS/EOS).
- **Isolamento de rede:** nenhuma requisição sai para `*.leadzy.com.br` — verificado
  em toda a sessão de testes, no popup, no options e no mundo isolado do content script.
- **Mundo da página intocado:** o `XMLHttpRequest` do WhatsApp não é embrulhado;
  o patch vive só no mundo isolado da extensão.
- **Teste diferencial:** a extensão original, sem servidor, cai em `#/login`.
  Colocando o token à mão, o app funciona — mas **tenta falar com o servidor**.
  O patch entrega a mesma interface com **zero requisições**. É a prova de que
  o patch não altera comportamento: só automatiza o que o app já fazia offline.

### O que a suíte NÃO cobre

Para não haver "talvez", o que depende do WhatsApp real fica de fora:

| Não coberto | Como validar |
|---|---|
| Envio real de mensagem (texto/áudio) | manual: conectar um número e enviar |
| Gatilho reagindo a mensagem real | manual: mandar "quero saber mais" de outro celular |
| Gravação pelo microfone | manual |
| Montar fluxo arrastando nós no canvas | manual |
| Backup / restore `.lzb` | manual |

Essas cinco dependem do WhatsApp real ou de interação física — não da camada que
foi escrita aqui. A camada local (auth, plano, conversão de áudio, isolamento de
rede) está coberta ponta a ponta pelos 301 testes.

> Para o detalhamento honesto do que está e do que não está completo, veja
> **`STATUS.md`**.

### Auditoria de botões

86 botões (nível 1) + ~60 dentro de menus/modais (nível 2) + 10 itens que não são
`<button>` — **todos clicados em Chromium real**. Resultado: **zero requisições
externas, zero aberturas para fora, zero erros**. É o bloco 8 do `tests/run-all.sh`.
