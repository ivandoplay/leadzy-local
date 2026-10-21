# Vazamentos de link — auditoria estática e correção

> **STATUS: RESOLVIDO.** Os 3 vazamentos abaixo foram fechados na versão
> atual. Os testes `tests/unit/allowlist.test.js` (11) e
> `tests/e2e/links-externos.test.js` (8) provam cada um. O texto original da
> auditoria fica registrado para histórico.

Levantamento feito **só por leitura de código** (nenhum clique), conforme pedido.
Escopo: todo o `js/` + HTML + CSS do pacote `extensao/`.

---

## Resposta curta

**Sim, ainda existem 3 mecanismos que abrem site externo.** Nenhum deles é
`window.open` — é justamente por isso que passaram pela minha auditoria e pela
minha guarda.

| # | Mecanismo | Alvo | Minha guarda cobre? |
|---|---|---|---|
| 1 | `<a href="...">` com `target="_blank"` | `https://www.leadzy.com.br` | ❌ **não** |
| 2 | `<a href="...">` com `target="_blank"` | `https://www.leadzy.com.br/whatsapp-suporte` | ❌ **não** |
| 3 | `<a>` criada por JS + `.click()` | `https://api.whatsapp.com/send?phone=...` | ❌ **não** |

**Por que a guarda não pega:** ela intercepta `window.open`, `chrome.tabs.create`,
`chrome.tabs.update` e `img.src`. Ela **nunca interceptou cliques em `<a>` nem
`location.assign`**. Link em `<a>` não passa por `window.open` — vai direto no
motor de navegação do Chrome.

**Segundo furo:** a função `bloquearNavegacaoExterna()` filtra por
`isLeadzyUrl(url)`, ou seja `/(^|\.)leadzy\.com\.br$/`. Qualquer host que não seja
leadzy passa — `api.whatsapp.com` inclusive.

**Terceiro furo (por que a auditoria de cliques não pegou):** os dois `<a>` de
leadzy vivem dentro do modal *"número não registrado"*, e o `api.whatsapp` só
dispara no **segundo clique** (abrir modal → clicar "Enviar"). Minha auditoria
clicava uma vez e apertava Escape — nunca chegou ao segundo nível.

---

## 1. As duas âncoras de leadzy (as que você viu)

Ambas no mesmo componente — modal de **"número não registrado"**. Presente em
**dois bundles**: `772.8a9ea03b.js` e `content-script.js` (código duplicado).

```js
// linha ~710431 do chunk 772
Gy = {
  href: "https://www.leadzy.com.br/whatsapp-suporte",
  target: "_blank",
  class: "text-sm text-secondary hover:underline"
}
// renderizado como:
Lk("a", Gy, $t("help.contactSupport"))      // <- "Falar com o suporte"

// logo abaixo, no mesmo modal:
Lk("a", {
  href: "https://www.leadzy.com.br",
  target: "_blank",
  class: "text-sm text-gray-400 hover:underline"
}, " www.leadzy.com.br ")                    // <- texto do link
```

| Onde | Bundle | Texto do link | Destino |
|---|---|---|---|
| Modal "número não registrado" | `772.8a9ea03b.js` | "Falar com o suporte" | `www.leadzy.com.br/whatsapp-suporte` |
| Modal "número não registrado" | `772.8a9ea03b.js` | "www.leadzy.com.br" | `www.leadzy.com.br` |
| Modal "número não registrado" | `content-script.js` | idem | idem |

`target="_blank"` → abre aba nova, nunca aparece nos meus listeners de
navegação da página atual. Foi por isso que passou.

---

## 2. As 5 âncoras de `api.whatsapp.com`

Todas no mesmo padrão: `document.createElement("a")` → `.href = ...` →
`.click()` → `.remove()`. Não usam `window.open`.

| # | Componente | Gatilho na tela | Alvo |
|---|---|---|---|
| 1 | helper `openWhatsAppChat(e,t)` | genérico, chamado por vários | `api.whatsapp.com/send?phone=<num>&text=<msg>` |
| 2 | `ContactSearchResultCard` | botão "iniciar conversa" num contato | `...?phone=<num>&text=%20` |
| 3 | lista de contatos/deals (`DealCardFilterList`) | clicar num contato com telefone | `...?phone=<num>&text=%20` |
| 4 | `SupportRequestModal` | "Enviar" da solicitação de suporte | `...?phone=5511971907976&text=<descrição>` |
| 5 | `HelpModal` | "Sugerir funcionalidade" | `...?phone=5511971907976&text=<sugestão>` |

Ocorrências por arquivo: `772.8a9ea03b.js` = 5, `content-script.js` = 5,
`popup.js` = 0, `options.js` = 0.

**Nuance importante:** os itens 1–3 são uma função real do produto (abrir
conversa no WhatsApp com um contato). O 4 e o 5 são canais de suporte da Leadzy
disfarçados de WhatsApp — o número `5511971907976` é o suporte deles.

---

## 3. O que a guarda **realmente** bloqueia hoje

Verificado por leitura, arquivo por arquivo:

| Sink | Onde | Status |
|---|---|---|
| `window.open(...)` | popup (26), options (25), content-script (35), chunk 772 (8) | ✅ bloqueado |
| `chrome.tabs.create({url})` | content-script, service-worker | ✅ bloqueado (páginas) |
| `chrome.tabs.update(id,{url})` | idem | ✅ bloqueado (páginas) |
| `img.src` / `srcset` do bucket | todas as telas | ✅ trocado por placeholder |
| `location.assign` / `location.replace` / `location.href=` | só a lib **FileSaver** | ✅ irrelevante — recebe `blob:` / `data:` de download |
| `<a href target=_blank>` | **modais** | ❌ **passa** |
| `<a>` + `.click()` | **modais e lista de contatos** | ❌ **passa** |

---

## 4. Lista completa de URLs externas no pacote

Cada uma com o mecanismo que a dispara:

### Bloqueadas (via `window.open` / `tabs.create` / `img.src`)
```
https://www.leadzy.com.br                                   (window.open)
https://leadzy.com.br/#planos                               (window.open)
https://leadzy.com.br/instalacao-tutorial                   (window.open, HELP_CENTER)
https://leadzy.com.br/whatsapp-suporte                      (window.open)
https://leadzy.com.br/materiais                             (window.open)
https://leadzy.com.br/marketing-digital/guia-boas-praticas-remarketing/
https://app.leadzy.com.br                                   (CRM_FRONTEND_URL)
https://app.leadzy.com.br/dashboard?modal=trial-activation
https://app.leadzy.com.br/purchase
https://app.leadzy.com.br/purchase?upgrade=crm
https://app.leadzy.com.br/deals
https://app.leadzy.com.br/contacts/<id>
https://app.leadzy.com.br/tickets?...
https://app.leadzy.com.br/settings/personal
https://app.leadzy.com.br/settings/account
https://app.leadzy.com.br/settings/plans
https://app.leadzy.com.br/settings/connected-numbers
https://app.leadzy.com.br/settings/team
https://app.leadzy.com.br/auth/logout_user
https://app.leadzy.com.br/auth/forgot-password
https://bucket.leadzy.com.br/announcement-images/...        (img.src)
```

### **NÃO bloqueadas**
```
https://www.leadzy.com.br                                   (<a target=_blank>)
https://www.leadzy.com.br/whatsapp-suporte                  (<a target=_blank>)
https://api.whatsapp.com/send?phone=...                     (<a>.click())
```

### Esperadas / liberadas de propósito
```
https://web.whatsapp.com       (é o produto)
https://api-userv2.leadzy.com.br (+ audio-converter)  -> só aparecem como
                                constante de config; o fetch é interceptado
https://github.com/zloirock/core-js  -> comentário de licença no bundle, não abre nada
http://www.w3.org/2000/svg     -> namespace de SVG, não é requisição
```

---

## 5. Resumo do que ainda falta fechar

1. Interceptar **clique em `<a>`** (capture-phase, no `document`) e
   `location.assign/replace` — cobre os 2 links de leadzy e as 5 âncoras de WhatsApp.
2. Trocar `isLeadzyUrl()` por uma **allowlist**: só `chrome-extension://` passa.
3. Os botões "Falar com o suporte" e "www.leadzy.com.br" deveriam mostrar o aviso
   local, igual aos outros, em vez de simplesmente não funcionar.
4. Rever os 3 botões de "abrir conversa no WhatsApp" — decisão sua se continuam
   abrindo `api.whatsapp.com` (é função legítima) ou se também avisam.

Aguardo seu próximo passo.
