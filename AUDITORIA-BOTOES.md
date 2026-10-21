# Auditoria de botões e ligações com servidor

> Feita em Chromium real com a extensão carregada. Cada botão foi clicado
> isoladamente (página recarregada entre cliques) e cada requisição de rede foi
> registrada.

---

## Como foi feito

Três passadas complementares, todas em navegador de verdade:

| Passada | Método | Elementos |
|---|---|---|
| **Nível 1** | carrega cada rota, lista os clicáveis, clica em cada um isoladamente | **86 botões** |
| **Nível 2** | abre menus/modais e clica nos botões que aparecem dentro | **~60 botões** em 6 abridores |
| **Nominal** | itens que são `div`/`span` (menu do usuário, cards de ajuda) | **10 ações** |

Mais uma varredura estática de tudo que pode gerar tráfego: `axios`, `XHR`,
`fetch`, `window.open`, `chrome.tabs.create/update`, `WebSocket`, `EventSource`,
`sendBeacon`, `@import` de CSS e `src` de imagem.

---

## Resultado

### Antes

| # | Origem | O que fazia |
|---|---|---|
| 1 | `css/popup.css` | `@import` do **Google Fonts** — requisição externa a cada abertura |
| 2 | `css/options.css` | idem |
| 3 | `css/content-script.css` | idem (a cada página do WhatsApp) |
| 4 | `window.open` → `app.leadzy.com.br/settings/team` | "Adicionar membro" |
| 5 | `window.open` → `app.leadzy.com.br/deals` | "Leadzy CRM" e ações de negócio |
| 6 | `window.open` → `leadzy.com.br/#planos` | "Assinar" / upgrade |
| 7 | `window.open` → `.../auth/login`, `/auth/logout_user` | login/logout pelo site |
| 8 | `window.open` → `.../auth/forgot-password` | recuperar senha |
| 9 | `chrome.tabs.create` → `CRM_FRONTEND_URL/*` | foco/abertura do CRM |
| 10 | `leadzy.com.br/instalacao-tutorial` | central de ajuda |
| 11 | `leadzy.com.br/whatsapp-suporte` | suporte |
| 12 | `bucket.leadzy.com.br/announcement-images/*` | imagem do carrossel de novidades |

### Depois

- **Rede:** `0` requisições externas em **todas** as rotas e em **todos** os cliques.
- **Navegação:** `0` aberturas para fora.
- **Erros:** `0` `pageerror` / `console.error`.

| Verificação | Antes | Depois |
|---|---|---|
| Requisições a `fonts.googleapis.com` | toda abertura | **nenhuma** |
| Fontes Inter | baixadas do Google | **do pacote local** (`fonts/*.ttf`, `document.fonts.check` = true) |
| `window.open` para domínio Leadzy | abria | **bloqueado + aviso na tela** |
| `chrome.tabs.create/update` para Leadzy | abria aba | **bloqueado + aviso** |
| Imagem de `bucket.leadzy.com.br` | baixava | **placeholder local (SVG data URI)** |
| Requisições à API (`api-userv2`) | várias | **respondidas por mock local** |

---

## O que foi alterado

### 1. Fontes locais (`css/popup.css`, `options.css`, `content-script.css`)
Troca do `@import url(https://fonts.googleapis.com/...)` por `@font-face`
apontando para os dois TTFs Inter que **já vinham no pacote** (874 KB e 904 KB),
usando o eixo variável `font-weight: 100 900`.

### 2. Bloqueio de navegação externa (`js/local-bootstrap.js`, seção 7)
Intercepta `window.open`, `chrome.tabs.create` e `chrome.tabs.update`. Se a URL
for de `*.leadzy.com.br` (exceto o próprio WhatsApp Web), **não navega** e mostra
um aviso discreto no rodapé:

> *Este recurso fica no painel online da Leadzy e não está disponível no modo local.*

Cobre: CRM, planos/upgrade, login, logout, recuperação de senha, adicionar membro,
central de ajuda, suporte e materiais.

### 3. Guarda de imagem (`js/local-bootstrap.js`, seção 8)
`HTMLImageElement.src` e `srcset` são interceptados **antes** de o navegador
fazer a requisição: URL de `*.leadzy.com.br` vira um SVG transparente local com o
texto "imagem do servidor". Imagens de outros domínios passam normalmente.

### 4. `fonts/*` em `web_accessible_resources`
Para a fonte continuar carregando dentro da página do WhatsApp (content script).

---

## Configuração

Tudo em `js/local-bootstrap.js`:

```js
offlineLinks: "block",   // "block" (padrão) | "allow"
```

Com `"allow"`, os botões voltam a abrir as páginas da Leadzy — útil se em algum
momento você quiser acessar o painel online de propósito.

---

## Como isso está travado (testes)

O que antes era verificação manual virou teste permanente:
`tests/e2e/sem-rede.test.js` — **11 testes**, ~4 min.

- para cada uma das 8 telas: clica em **todos** os botões e falha se qualquer
  requisição sair, qualquer página abrir ou qualquer erro aparecer
- exige um **número mínimo de botões por tela** — se a UI quebrar e não renderizar,
  o teste falha em vez de passar vazio
- cobre também os itens de menu (`div`/`span`) e os cards de ajuda
- verifica que a fonte Inter carrega **do pacote** e que nada externo é baixado
- verifica que imagem do bucket é trocada por placeholder **sem requisição**

Complementos unitários:
- `bloquearNavegacaoExterna()` cobre os 5 domínios do produto e libera WhatsApp/externos
- CSS não contém nenhuma URL `http(s)` (teste que varre todos os arquivos de `css/`)
- manifesto não referencia Google Fonts e declara o `@font-face` local

---

## O que ainda não é local (e não tem como ser)

Estes botões continuam existindo e agora **avisam** em vez de navegar:

| Botão | Por quê |
|---|---|
| Leadzy CRM / Deals | o CRM é uma aplicação web inteira, roda nos servidores deles |
| Perfil e conta / Ajustes | dados de conta vivem na API |
| Assinar / Upgrade | envolve pagamento |
| Central de ajuda / Suporte / Materiais | conteúdo no site |
| Adicionar membro | gestão de equipe é server-side |
| Sair da conta | não há conta remota para sair — o aviso explica |

Se algum desses precisar funcionar de verdade no modo local, é implementação nova
(uma tela local equivalente), não um ajuste de configuração.
