# Leadzy v4.0.4 — Análise técnica do pacote

> Fonte: `pmw8x6.zip` → extraído em `/home/user/extensao/` (43 arquivos, ~9,9 MB)
> Análise feita em 19/10/2026

---

## 1. Ficha técnica

| Campo | Valor |
|---|---|
| Nome | **Leadzy** |
| Versão | 4.0.4 |
| Manifest | **MV3** |
| Locale padrão | `pt_BR` (só tem a chave `extName` traduzida) |
| Permissões | `storage`, `unlimitedStorage`, `tabs`, `scripting` |
| Host permissions | `*://web.whatsapp.com/*` apenas |
| `externally_connectable` | `web.whatsapp.com` |
| `update_url` | `clients2.google.com/service/update2/crx` |
| `_metadata/verified_contents.json` | presente → **build oficial publicado na Chrome Web Store** |
| Analytics/telemetria | **nenhuma** (zero hits para sentry/posthog/mixpanel/gtag) |

O `update_url` + `_metadata` são a pista mais importante: **isso não é um build de desenvolvimento, é o artefato assinado que estava na loja.** Ou seja, foi desempacotado de um `.crx` instalado (ou baixado da CWS), não compilado localmente.

---

## 2. Mapa dos arquivos

```
extensao/
├── manifest.json                    # 1,5 KB — MV3, tudo declarado aqui
├── index.html                       # 797 B — RESÍDUO do Vue CLI (tem <%= BASE_URL %> cru, não é usado)
├── popup.html                       # 339 B — só <div id="app"> + popup.js/css
├── options.html                     # 351 B — só <div id="app"> + options.js/css
│
├── js/
│   ├── service-worker.js       50 KB   # orquestrador (legível-ish, minificado)
│   ├── content-script.js      3,3 MB   # ⚠️ o cérebro: SPA Vue 3 + motor de fluxos + injeção
│   ├── popup.js               2,4 MB   # MESMO bundle, entry point = popup
│   ├── options.js             2,4 MB   # MESMO bundle, entry point = options
│   ├── wapi.js                102 KB   # SDK que faz engenharia reversa do WhatsApp Web
│   ├── mount.js                10 KB   # loader/injetor do wapi.js (legível, comentado)
│   ├── importer.js            153 B    # faz `import('/js/wapi.js')`
│   ├── crm-bridge-content-script.js  2,2 KB # ponte postMessage ↔ service worker
│   ├── 772.8a9ea03b.js        758 KB   # chunk vendor (Vue, Pinia, zod, libs)
│   ├── 860.c68824e5.js         28 KB   # chunk compartilhado
│   └── 303.7fb54a53.js       445 B     # chunk: layout "whatsapp-dev"
│
├── css/
│   ├── content-script.css     371 KB   # Tailwind compilado + estilos injetados no WhatsApp
│   ├── popup.css              313 KB   # idem, para o popup
│   ├── options.css            291 KB
│   ├── icons.css               58 KB   # fonte de ícones
│   ├── styles.css             1,6 KB   # overrides manuais no DOM do WhatsApp (tem muito CSS comentado)
│   └── 303/772/860.css                 # CSS dos chunks
│
├── img/                                # logos, flags (br/us/es/it), login art
├── icons/                              # 16/32/48/128.png
├── fonts/                              # Inter variable (self-hosted)
└── _locales/{en,pt_BR}/messages.json
```

**Descoberta importante:** `popup.js`, `options.js` e `content-script.js` contêm **literalmente o mesmo código-base** — verifiquei por hash do bloco de i18n (md5 `d186def5…` idêntico nos três). São três *entry points* webpack do mesmo app. Consequência prática: **qualquer patch de string/UI precisa ser aplicado nos três arquivos** (ou em nenhum, se for só no content script), senão popup e options divergem entre si.

---

## 3. Arquitetura em uma imagem

```
┌─────────────────────────── web.whatsapp.com ───────────────────────────┐
│                                                                        │
│  content-script.js  (mundo isolado)                                    │
│   ├─ SPA Vue 3 montada dentro do WhatsApp (topbar, drawer, modais)     │
│   ├─ Motor de fluxos (FlowEngine) — roda no navegador, não no servidor  │
│   └─ injeta → mount.js → wapi.js  (mundo MAIN, dentro da página)       │
│                                    └─ hook no webpack interno do WPP:  │
│                                       Chat, Msg, Contact, Cmd,        │
│                                       MediaPrep, ComposeBox, Label     │
└───────────────▲────────────────────────────────┬───────────────────────┘
                │ chrome.runtime.sendMessage     │ fetch
                │                                ▼
┌───────────────┴───────────────┐   ┌────────────────────────────────────┐
│ service-worker.js             │   │ Backends Leadzy                    │
│  • estado da aba WhatsApp     │   │ api-userv2.leadzy.com.br  (CRM API)│
│  • fila de comandos pendentes │   │ audio-converter.leadzy.com.br      │
│  • abre chat / abre options   │   │ app.leadzy.com.br  (frontend/trial)│
│  • alarme de sync periódico   │   │ bucket.leadzy.com.br (imagens)     │
│  • onMessageExternal          │   └────────────────────────────────────┘
└───────────────────────────────┘
        ▲
        │  popup.html / options.html  (mesmo bundle Vue, rotas próprias)
```

### Como o `service-worker.js` funciona (está quase legível)

Máquina de estados simples:

- Estados: `NOT_OPEN` → `LOADING` → `READY` (constante `systemInitializationState` no `chrome.storage.local`).
- Comandos suportados (mensagens): `PING`, `PING_EXTENSION`, `OPEN_CHAT` / `OPEN_WHATSAPP_CHAT`, `OPEN_OPTIONS_PAGE`, `OPEN_BACKUP_MODAL`, `OPEN_FILE_HEALTH_CHECK_MODAL`, `RELOAD_WHATSAPP`, `INJECT_LIB_IN_WPP`, `INITIALIZE_METRICS_SYNC`, `AUTH_SUCCESS_NOTIFICATION`.
- Se o WhatsApp não está aberto: salva o comando em **fila de pendentes** (`savePendingCommand` / `getPendingCommands`, com `incrementRetries`) e cria a aba. Quando o content script emite `SYSTEM_READY`, dispara `processPendingCommands()`.
- `openChat()`: acha a aba → `pingContentScript()` → se pronto, `focusTab` + `executeOpenChatDirect`; se não, enfileira.
- Alarme periódico de sync (`SYNC_ALARM_NAME` / `SYNC_INTERVAL_MINUTES`).
- `chrome.runtime.onMessageExternal` ativo → o site Leadzy (em `web.whatsapp.com` via `externally_connectable`) consegue falar direto com a extensão.

---

## 4. O que a extensão faz de fato

Produto = **automação de atendimento/vendas no WhatsApp Web com "humanização"**.

Módulos da UI (rotas do Vue Router): `/dashboard`, `/messages`, `/scripts`, `/triggers`, `/flows`, `/flows/new`, `/flows/:id`, `/wpp`, `/login`.

### 4.1 Messages (biblioteca de mensagens)
Banco de mensagens reutilizáveis, em 4 tipos: **texto, áudio/PTT, mídia (foto/vídeo), documento**. Tem pastas, busca, preview, player de waveform próprio (`MessageWaveformPlayer`), gravador inline (`InlineAudioRecorder`), edição de legenda. É aqui que entra o pitch da extensão ("reenvie seus áudios prontos como se tivessem sido gravados na hora").

### 4.2 Scripts
Sequências ordenadas de mensagens (arrastar para reordenar), com preview.

### 4.3 Triggers (gatilhos)
Regras do tipo *palavra-chave → script*. A UI cobre: `é igual a`, `começa com`, `termina com`, `contém`, comparações numéricas ("(número) menor que"), `length_equals`. Flags relevantes: **"Não enviar para grupos"**, **"Não enviar para contatos salvos"**, espera máxima, telefone de teste (`TriggerTestPhone`), ativar/desativar, duplicar, backup.

### 4.4 Flows (o núcleo — construtor visual de automação)
Editor em canvas com nós e arestas (`ConversationCanvas`, `FlowSequenceBuilder`, `FlowSimulatorDrawer`, `FlowTemplatesPage`). **18 tipos de nó** encontrados no motor:

| Categoria | Nós |
|---|---|
| Envio | `sendText`, `sendAudio`, `sendMedia`, `sendDocument`, `sendScript` |
| Controle | `trigger`, `condition`, `delay`, `waitReply`, `end`, `goToFlow` |
| Dados | `setVariable`, `aiExtract` |
| **IA** | `aiReply`, `aiRouter` |
| WhatsApp | `addLabel`, `removeLabel`, `archive` |

O motor de execução vive **dentro do content script** (no navegador), com adaptadores (`adapters.sendAudio({chatId, messageId, showRecording})`). Persistência de execução em `chrome.storage.local` com eventos `execution:updated` / `execution:transitioned`, índice em `flows:index`, schemas validados com **zod** ("schema validation failed"), e `flows:examplesSeeded` (fluxos de exemplo são semeados automaticamente no primeiro uso).

### 4.5 Dashboard
Métricas: mensagens enviadas, scripts executados, horas de áudio, "conversas humanizadas", total de scripts/gatilhos, distribuição por tipo de mensagem. Mais: carrossel de anúncios remoto (imagens puxadas de `bucket.leadzy.com.br/announcement-images/...`), help center, trial.

### 4.6 Licenciamento
Há `subscription`, `gracePeriod`, `trial`, `plan_features/product-lines` e a mensagem *"Funcionalidade disponível no plano Chat"*. O gate é **server-side** (a API responde o plano) — ou seja, não é um `if` local que dá pra contornar editando o bundle de forma limpa. Carrega `LzButtonIconLeaked`… e um modal `GracePeriodModal`.

### 4.7 Camada WhatsApp (`wapi.js`) — a parte mais frágil
Não usa a API oficial. Faz *hook* no webpack interno do WhatsApp Web para pegar módulos privados:

- `Chat` (`getModelsArray`, `getActive`), `Msg` (`get`, `on`, `off`), `Contact`, `Label`, `Cmd` (`on`/`off`, `archiveChat`), `ComposeBox` (`setTextContent`), `MediaPrep` (`prepRawMedia`, `sendToChat`, `waitForPrep`), `OpaqueData`, `UserPrefs`, `ProfilePicThumb`, `WidFactory`, `msgFindQuery`, `MsgKey`, `WAWebQueryExistsJob`.
- Tem fallbacks e mensagens de erro do tipo *"Módulo 'Chat' mudou, Chat.getModelsArray não existe!"* — ou seja, **quebra sempre que o WhatsApp muda o bundle**. É por isso que existe `RELOAD_WHATSAPP` e `INJECT_LIB_IN_WPP`.
- Também gera waveform de áudio e usa `MediaPrep` para *reenviar* áudio como se fosse PTT nativo.

---

## 5. Configuração de ambiente (achado útil)

Existe um enum de ambiente com três valores:

```js
{ DEVELOPMENT: "development", HOMOLOG: "homolog", PRODUCTION: "production" }
const o = a.PRODUCTION;              // ← valor fixo no bundle

DEVELOPMENT: { CRM_BACKEND_URL: "http://localhost:3000",
               CRM_FRONTEND_URL: "http://localhost:5173",
               AUDIO_CONVERTER_URL: "http://localhost:4000" }
PRODUCTION:  { CRM_BACKEND_URL: "https://api-userv2.leadzy.com.br",
               CRM_FRONTEND_URL: "https://app.leadzy.com.br",
               AUDIO_CONVERTER_URL: "https://audio-converter.leadzy.com.br" }
```

Também fixos: `SUPPORT_WHATSAPP: "5511971907976"`, `HELP_CENTER: "https://leadzy.com.br/instalacao-tutorial"`, e o trial em `https://app.leadzy.com.br/dashboard?modal=trial-activation`.

Nota: `HOMOLOG` está declarado no enum mas **não tem bloco de URLs** — se alguém setar homolog, `n.CRM_BACKEND_URL` estoura em `undefined`.

---

## 6. Estado do código-fonte

**Não existe `src/` neste pacote.** É 100% saída de webpack: nomes de módulos numéricos (`54487`, `71689`), identificadores de 1–2 letras, sem sourcemaps (o `map` não vem no zip). Não há `package.json`/lockfile. Recompilar do zero é impossível a partir daqui.

Achados de qualidade que valem nota:
- `index.html` é lixo de template Vue CLI (`<%= htmlWebpackPlugin.options.title %>` não substituído) e não é referenciado pelo manifest.
- `_metadata/verified_contents.json` e `update_url` vão ficar inconsistentes assim que qualquer byte do pacote mudar (inofensivo em modo unpacked, mas o arquivo vira ruído).
- Os três bundles de UI são duplicatas de ~2,4 MB cada → o pacote carrega ~7 MB de JS redundante.

---

## 7. Onde dá pra mexer (mapa de esforço)

### 🟢 Fácil — sem tocar em minificado

| Alvo | Arquivo | Como |
|---|---|---|
| Nome/descrição/versão/autor | `manifest.json` | edição direta. Se for repassar na loja, precisa de novo ID |
| Ícones | `icons/*.png` | substituir os 4 tamanhos |
| Logos | `img/logo-leadzy-white.svg`, `logo-leadzy-dark.svg`, `leadzy-chat-logo.svg`, `login-image.png`, `login-leadzy-extension.webp` | trocar mantendo o mesmo nome |
| Estilos injetados no WhatsApp | `css/styles.css` | é o único CSS "escrito à mão" (1,6 KB, com bastante coisa comentada) |
| Tradução do nome | `_locales/*/messages.json` | só tem `extName` |

### 🟡 Médio — patch cirúrgico em string minificada

- **Textos da interface.** Boa notícia: as strings i18n estão em **PT/ES/IT/EN num objeto literal legível** dentro dos bundles (ex.: `"sendAudio":{"name":"Enviar áudio","description":"Áudio / PTT"}`). Dá pra localizar e substituir com segurança usando regex + contagem de ocorrências.
  ⚠️ **Aplicar nos três arquivos** (`popup.js`, `options.js`, `content-script.js`), senão as telas divergem.
- **Endpoints / trocar `PRODUCTION` por um backend próprio.** É o bloco de config visto na seção 5 — troca localizada, mas depois **autenticação, plano e trial vão falhar**, porque quem responde é a API deles (`/auth/login`, `/auth/me`, `/plan-features/product-lines`, `/messages`).
- **`service-worker.js`**: já está quase legível (`==t.type&&e.tab?.id&&…`). Dá pra editar lógica de fila/estado com cuidado.
- **`crm-bridge-content-script.js`** e **`importer.js`**: legíveis, edição direta.
- **`mount.js`**: legível e comentado — é o melhor ponto de entrada se você quiser mudar *como* a lib é injetada.

### 🔴 Difícil — mexer em comportamento de UI/fluxo

- Qualquer alteração no Vue app (adicionar campo, mudar layout, novo nó de fluxo, nova rota): o código está minificado em 2–3 MB, sem sourcemap, dentro de closures. É viável via edição de string + teste manual, mas **cada mudança é frágil e não reproduzível**.
- `wapi.js`: 102 KB minificado e dependente do bundle do WhatsApp. Mexer aqui é o maior risco de quebrar tudo.
- `css/content-script.css`, `popup.css`, `options.css`: são **Tailwind compilado** com escopo `data-v-*`. Alterar classes existentes funciona; criar componente novo não.

### Estratégia que eu recomendaria para mudanças grandes

Como não dá pra rebuildar, o caminho sustentável é **camada de override**, não edição do bundle:

1. Um `css/override.css` declarado depois no manifest para sobrescrever aparência.
2. Um content script próprio (`js/meu-patch.js`) declarado **depois** do `content-script.js` no `content_scripts[0].js`, que roda no mesmo mundo isolado e pode:
   - trocar textos via `MutationObserver` no DOM da SPA,
   - interceptar `fetch`/`XMLHttpRequest` para redirecionar `api-userv2.leadzy.com.br` ao seu backend,
   - substituir logos e ícones em runtime.
3. Isso mantém o bundle original intacto (fácil de reverter e de atualizar quando a Leadzy lançar versão nova) e concentra todo o seu código em arquivos legíveis e versionáveis.

---

## 8. Antes de publicar/repassar

- **Legal:** é um artefato proprietário da Leadzy, com marca, logo e backend de terceiros. Redistribuir, publicar na loja ou revender com outro nome esbarra em direito autoral/marca; apontar para a API deles sem autorização esbarra nos ToS. Uso local/estudo, ou com autorização do titular, é o cenário seguro.
- **Técnico:** a automação depende de hook em módulos internos do WhatsApp → viola os Termos de Serviço do WhatsApp e a conta pode ser banida. A própria extensão tenta mitigar ("não enviar para grupos", delays, `showRecording`), mas o risco é inerente.
- **Chrome:** em modo "Carregar sem compactação" o `update_url` é ignorado (bom). Para empacotar como `.crx` de novo você precisa de uma chave privada — e o ID muda em relação ao original.

---

## 9. Próximo passo

Diga o que quer mudar e eu já ataco nessa ordem de preferência:

1. Se for **visual/branding/textos** → faço um script Python de patch idempotente, com verificação de "1 ocorrência por alvo", aplicado aos três bundles, e te entrego o zip pronto.
2. Se for **funcionalidade nova** → construo como content script separado + CSS de override, sem tocar no bundle.
3. Se for **backend próprio** → monto o shim de `fetch` e o mapa de endpoints (`/auth/login`, `/auth/me`, `/messages`, `/plan-features/product-lines`) que você precisa responder.
