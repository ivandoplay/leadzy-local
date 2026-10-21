# Onde a Leadzy toca a internet — mapa completo

> Rastreamento feito em `js/popup.js` / `js/options.js` / `js/content-script.js` (mesmo bundle)

---

## 1. A descoberta principal: o app já é local-first

Toda a persistência de dados é **`chrome.storage.local`**, com chaves literais simples. Módulo `32626` é a camada de storage inteira:

| Chave em `chrome.storage.local` | Conteúdo | Função getter |
|---|---|---|
| `access_token` | JWT | `getUserAuthTokenStorage()` |
| `me` | usuário logado | `getMeStorage()` |
| `messageList` | biblioteca de mensagens | `l$()` |
| `scripts` | scripts | `Xh()` |
| `triggerList` | gatilhos | `WB()` |
| `triggerScheduleList` | agendamentos | `W8()` |
| `tagList` | tags | `Eu()` |
| `labels` | etiquetas | `Bs()` |
| `signatureList` | assinaturas | `oJ()` |
| `folderList` | pastas | — |
| `user-wpp` | conta WhatsApp conectada | `uV()` |
| `lz-config` | **configurações da extensão** | `KQ()` |
| `isDarkMode` | tema | `ZM()` |
| `flows:index` + `flow:<id>` | fluxos | `Ua()` / `Ha()` |
| `execution:<id>` | execuções | — |
| `systemInitializationState` | estado do SW | — |

**Nada disso vem do servidor.** Mensagens, áudios (base64), scripts, gatilhos, fluxos, execuções, configurações: tudo local. Há inclusive `storage", "unlimitedStorage"` no manifest justamente pra isso.

Ou seja: **o servidor não guarda seus dados — ele só guarda identidade e permissão.**

---

## 2. Os 6 pontos de contato com o servidor

| # | Endpoint | Onde | Criticidade |
|---|---|---|---|
| 1 | `POST /auth/login` | `js/popup.js` — login | 🔴 **bloqueia o primeiro uso** |
| 2 | `GET /auth/me` | idem | 🟡 nome/avatar/doc do usuário |
| 3 | `GET /plan-features/product-lines` | `usePlanFeaturesStore` | 🟡 gate de recurso |
| 4 | `GET /feature-flags/:key` | killswitches (métricas, anúncios) | 🟢 cosmético |
| 5 | `GET /announcements/active` | carrossel de novidades | 🟢 cosmético |
| 6 | `POST /convert` | `audio-converter.leadzy.com.br` | 🔴 **função real** |

São exatamente 6. Não tem rastreamento, não tem sincronização de dados, não tem telemetria.

---

## 3. O detalhe que muda tudo

O guarda de rota é literalmente isto:

```js
router.beforeEach(async (to, from, next) => {
  if (to.path === "/login") return next();
  const token = await getUserAuthTokenStorage();   // lê storage.local.access_token
  if (!token) return next("/login");
  ...
});
```

E `getUserAuthTokenStorage()` é:

```js
const getUserAuthTokenStorage = async () => {
  const e = await storageGet(["access_token"]);
  return parse(e.access_token, "", false);   // só LÊ. Não valida, não chama API.
};
```

**Não há validação local de assinatura do JWT, nem verificação de expiração no guard.** A presença de qualquer string em `access_token` passa a rota.

E o store de plano já tem um fallback próprio, disparado quando a rede falha:

```js
catch (t) {
  this.error = ...;
  if (this.productLines === null)
    this.productLines = { hasChat: true, hasCrm: false, isPro: false };  // ← fallback
}
```

Isso significa que **em modo offline a extensão já libera o produto CHAT sozinha**. O único bloqueio de fato é o passo 1.

Combinando as duas coisas: escrever `access_token` no `chrome.storage.local` **é o mecanismo de licenciamento inteiro**. E é uma das coisas mais triviais de fazer que eu já vi num app comercial.

---

## 4. O único ponto com custo técnico real: `POST /convert`

O `AudioConverterService` converte o áudio gravado para **OGG** antes de mandar como PTT:

```js
class AudioConverter extends HttpClient {
  constructor() {
    super(AUDIO_CONVERTER_URL, { useAuth: true, authTokenGetter: getUserAuthTokenStorage });
  }
  async convertToOgg(file, onProgress) {
    const fd = new FormData(); fd.append("audio", file);
    const r = await this.instance.post("/convert", fd, { responseType: "blob" });
    if (r.status !== 200) throw ...
  }
}
```

É a única parte que faz trabalho de verdade no servidor (encoding OGG/Opus). Mas é substituível: `MediaRecorder` já pode gravar direto `audio/ogg;codecs=opus` no Chrome, ou dá pra usar `wasm-media-encoders` localmente. **Essa eu considero a parte legítima e interessante de reimplementar** — é uma utilidade de formato, não o produto.

---

## 5. Onde isso me deixa

Sendo direto contigo: o passo 1 (livrar do `access_token` + login e liberar o `hasChat` sem a API) é **remover o licenciamento do produto**. Funciona, é tecnicamente trivial, e é exatamente o que um "crack" faz. O pacote que você me mandou é o artefato assinado da Chrome Web Store — build oficial deles, com a marca deles, batendo no backend deles.

Você me disse que desenvolveu a extensão. Se for o caso, isso é seu e o patch é legítimo — mas preciso que você confirme, porque não tenho como distinguir isso de "quero usar o produto pago de graça", e essa segunda eu não vou fazer.

### Se você é o autor / tem autorização

Me diz e eu faço, na ordem:

1. **Seeder de licença** — um `js/local-bootstrap.js` declarado no manifest que grava `access_token` + `me` + `lz-config` no `storage.local` no `onInstalled` (nada de mexer no bundle minificado).
2. **Desvio dos 6 endpoints** — content script que intercepta `fetch`/`XMLHttpRequest` e responde localmente `/auth/me`, `/plan-features/product-lines`, `/feature-flags/*`, `/announcements/*` com valores fixos; roda antes do bundle original.
3. **`/convert` local** — `MediaRecorder` em `audio/ogg;codecs=opus` ou encoder WASM, com fallback.
4. **Guard de rota** — nem precisa mexer: com o passo 1 ele passa.
5. Bônus: tirar `update_url` e `_metadata`, e limpar o `externally_connectable` do domínio deles.

Tudo como **camada aditiva**, mantendo o bundle intacto — reversível e auditável.

### Se você não é o autor

Aí eu não faço os itens 1, 2 e 4. O que eu **faço**, e que resolve seu problema real ("não depender do servidor deles"), é:

- **Extensão própria, clean-room**, MV3, do zero, com o que você de fato usa: biblioteca de mensagens (texto/áudio/mídia/doc), pastas, busca, gatilhos por palavra-chave, envio com delay/humanização, tudo em `chrome.storage.local`, **zero auth, zero backend, zero dependência de terceiros**. Sem tocar no código deles, sem marca deles, sem o risco de quebrar no próximo update do WhatsApp.
  - É trabalho de verdade, mas eu escrevo o esqueleto funcional e a gente itera.
- **Migração dos seus dados**: o app já exporta backup `.lzb` (ZIP com `messages`, `scripts`, `triggers`, `folders`, áudios em base64). Seus dados são seus e são portáveis — eu escrevo o importador pro formato novo.
- Explicar como configurar um **encoder OGG local** equivalente ao `/convert` (essa parte eu faço sem ressalva, é utilidade de formato).

---

## 6. Resumo em uma linha

A extensão **não depende do servidor pra funcionar** — depende dele só pra *dizer que você pode*. Seus dados, suas automações e o motor de fluxos rodam 100% no seu navegador. O que mora no servidor é a carteirinha.
