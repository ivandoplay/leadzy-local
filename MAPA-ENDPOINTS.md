# Mapa de dependências por endpoint

Resposta direta ao ponto levantado na revisão: **o fallback genérico existia e
era um risco real**. Este documento mostra o que foi medido, o que foi corrigido
e como cada rota está classificada hoje.

Método: instrumentei o `routeMock` para registrar **toda** rota exercitada em
execução (`window.__LZ_ROUTE_LOG__`), percorri a extensão com operações reais e
cruzei com o inventário estático dos bundles.

```
tests/audit/rotas.js        relatório manual  -> tests/auditoria-rotas.json
tests/e2e/rotas.test.js     regressão (7 testes, falha se aparecer fallback)
```

---

## 1. Resultado da medição

| Métrica | Antes | Depois |
|---|---|---|
| Rotas de API no código (inventário estático) | 45 | 45 |
| Rotas realmente chamadas em execução | 10 | 10 |
| Respondidas por mock explícito | 9 | **10** |
| **Caíram no fallback genérico** | **1** (`/notifications`) | **0** |
| Rotas no inventário sem tratamento explícito | 34 | **0** |

O roteiro exercitado (`tests/lib/walk.js`): abrir o popup, as 6 telas, menu do
usuário, criar mensagem, criar script, criar fluxo com etapa e salvar rascunho,
criar gatilho, abrir o modal de backup.

---

## 2. Classificação por rota

### A) Implementada localmente, persistência verificada

Nenhuma destas depende de escrita no servidor: os dados vivem em
`chrome.storage.local`, e isso está coberto por teste ponta a ponta.

| Rota | Método | Resposta local | Teste que prova |
|---|---|---|---|
| `/auth/me` | GET | usuário local | `e2e/extension.test.js` (popup sem login) |
| `/auth/login` | POST | token local | `e2e/extension.test.js` |
| `/auth/logout` | GET | `{success:true}` | — |
| `/plan-features/product-lines` | GET | `hasChat:true, hasCrm:false` | `e2e/extension.test.js`, `e2e/service-worker.test.js` |
| `/subscriptions`, `/subscriptions/active` | GET | assinatura local sem expiração | `e2e/extension.test.js` |
| `/convert` | POST | remux WebM/Opus → Ogg/Opus, feito no navegador | `e2e/extension.test.js` |
| `/health` | GET | `{status:"ok"}` — o conversor local está no ar | `unit/allowlist.test.js` |
| `/notifications` | GET | `[]` — sem servidor não há notificação | `unit/allowlist.test.js` |
| `/notifications/:id/read` | PATCH | `{success:true}` — não há o que marcar | `unit/allowlist.test.js` |

**Sobre a preocupação do `{success:true}`:** verifiquei que as operações de
escrita do produto (salvar mensagem, script, gatilho, fluxo, restaurar backup)
**não fazem nenhuma chamada de API**. Elas gravam direto no storage. O teste
`e2e/rotas.test.js` → "as operações de escrita não chamaram a API" confirma isso
em execução. Então não existe o cenário "interface acha que salvou, mas não
persistiu" — a persistência nunca passa pela camada de rede.

Prova adicional de persistência real:
- `e2e/fluxos.test.js` — cria fluxo, salva rascunho e confere o objeto no storage
- `e2e/backup.test.js` — exporta `.lzb`, valida o ZIP e **restaura em perfil limpo**

### B) Desativada intencionalmente (CRM / painel)

`hasCrm: false`. Estas rotas existem no bundle, mas nada as chama: os botões que
as disparariam abrem aba no painel web, e isso está bloqueado em três camadas.
Se alguma aparecer, é respondida no formato que o app espera e marcada como
desativada — nunca como "não mapeada".

`/deals` · `/deals/:id` · `/deals/:id/{change-stage,lost,notes,products,reopen,tags,won}`
`/contacts` · `/contacts/:id` · `/contacts/:id/profile-photo` · `/contacts/search`
`/tickets` · `/tickets/:id` · `/tickets/:id/{change-stage,close,notes,reopen,tags}`
`/tasks` · `/tasks/:id` · `/pipelines/:id` · `/products`
`/remarketing-logs` · `/remarketing-logs/:id/{cancel,conclude,pause,resume}`
`/connected-numbers` · `/settings/team` · `/settings/personal`
`/trial/check-crm-eligibility`
`/purchase` (só usada com `window.open`, bloqueado)

### C) Desligadas por feature-flag

`/feature-flags/*` → sempre `{enabled:false}`. Confirmado em execução: 5 flags
consultadas (`release_extension_flows`, `killswitch_extension_trigger`,
`killswitch_extension_announcements`, `killswitch_extension_collect_metrics`,
`release_crm_gradual_launch`), todas respondidas explicitamente.

### D) Respondida artificialmente sem implementar a operação

**Nenhuma.** Era o grupo que a revisão apontava como o mais preocupante; depois
das correções ele está vazio, e há teste que falha se voltar a ter item.

---

## 3. O que mudou no código

| Arquivo | Mudança |
|---|---|
| `js/local-bootstrap.js` | `routeMock` dividido em `routeMock` (registra) + `routeMockInterno`; helper `explicito()` marca as respostas reais; `/health`, `/notifications` e `PATCH /notifications/:id/read` implementados; `PREFIXOS_DESATIVADOS` para o CRM |
| `js/sw-guard.js` | mesmo tratamento de `/notifications` no service worker |
| `manifest.json` | `homepage_url` removido (era o único metadado apontando para o site deles) |
| `index.html` | **removido** — template webpack morto, não referenciado pelo manifest, era a última referência a `fonts.googleapis.com` |
| `tests/lib/walk.js` | roteiro compartilhado entre auditoria e teste |
| `tests/e2e/rotas.test.js` | 7 testes de regressão |
| `tests/unit/allowlist.test.js` | +5 testes com o inventário estático completo (29 rotas) |

O fallback genérico **continua existindo** como rede de segurança — é melhor
devolver algo do que travar o app. A diferença é que agora ele é **observável**:
qualquer rota que cair nele fica registrada com `origem:"fallback"`, e
`e2e/rotas.test.js` falha com a lista das rotas não mapeadas.

---

## 4. O que ainda não está coberto por esta medição

Honestidade sobre o alcance:

| Área | Situação |
|---|---|
| Rotas usadas **somente dentro do WhatsApp real** | não exercitadas (o content script não monta UI sem o WhatsApp autenticado). Se alguma existir, aparecerá como `origem:"fallback"` no log ao rodar com WhatsApp de verdade |
| Rotas do CRM | desativadas por `hasCrm:false`; se o produto CRM for ligado algum dia, precisam de implementação real |
| `update_url` | removido; não há atualização automática (é intencional) |

Para inspecionar em qualquer instalação: abra o DevTools de `options.html` e rode
`window.__LZ_ROUTE_LOG__`. Qualquer entrada com `origem:"fallback"` é uma rota
que o app chamou e não tem tratamento dedicado.
