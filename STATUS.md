# Status: o que está completo e o que não está

Resposta direta às duas perguntas:
**"todas as funcionalidades estão completas?"** e
**"não redireciona mais para nenhum servidor ou site externo?"**

---

## 1. Redirecionamento / rede

### Provado com o DNS da Leadzy derrubado

O teste `tests/e2e/service-worker.test.js` inicia o Chromium com:

```
--host-resolver-rules=MAP *.leadzy.com.br 127.0.0.1:1, MAP leadzy.com.br 127.0.0.1:1
```

Porta 1 não escuta nada. **Se qualquer requisição realmente tentasse sair, ela
falharia.** Resultado:

| Verificação | Com DNS morto |
|---|---|
| Popup abre no dashboard | ✅ |
| 6 telas renderizam | ✅ |
| Navegação entre seções | ✅ |
| `fetch` para a API (página) | ✅ responde local |
| `fetch` para a API (service worker) | ✅ responde local |
| Fontes Inter | ✅ carregam do pacote |
| `/convert` (áudio) | ✅ funciona local |
| Erros de página | ✅ zero |

### Link `<a>` e navegação — fechados em 3 camadas

A auditoria estática achou 3 vazamentos que passavam pela guarda antiga
(ela só cobria `window.open`/`tabs.*`). Correção em camadas:

| Camada | O que cobre | Arquivo |
|---|---|---|
| **Rede (DNR)** | *qualquer* requisição para `*.leadzy.com.br`, de qualquer contexto — link, img, iframe, form, `location.assign` | `rules/bloqueio-externo.json` + `permissions.declarativeNetRequest` |
| **Guarda de clique** | impede a navegação e mostra o aviso local em vez da tela de erro | `local-bootstrap.js` (capture-phase em `click`/`auxclick`/`submit`) |
| **Remoção** | apaga do DOM os links de suporte que não têm versão local | `local-bootstrap.js` (MutationObserver) |

Por que DNR: `location.assign`, `replace` e `href` são **unforgeable** — testei e
não dá para sobrescrever em JS. Só uma regra no nível da rede barra isso.

**Allowlist** (antes era o contrário — bloqueava só Leadzy, então qualquer
outro domínio passava):

| Destino | Decisão |
|---|---|
| `chrome-extension:`, `data:`, `blob:`, `about:`, `#/rota` | ✅ liberado |
| `web.whatsapp.com` | ✅ liberado (é o produto) |
| `api.whatsapp.com/send?phone=<contato>` | ✅ **função preservada** — abrir conversa com um contato |
| `api.whatsapp.com/send?phone=5511971907976` | ❌ removido — é o suporte deles |
| `www.leadzy.com.br`, `/whatsapp-suporte` | ❌ removidos do DOM |
| qualquer outro domínio | ❌ bloqueado |

### Superfície de rede fechada

| Contexto | Protegido por | Testado |
|---|---|---|
| Popup / Options | `fetch` + `XMLHttpRequest` no `local-bootstrap.js` | ✅ |
| Content script (WhatsApp) | mesmo patch, mundo isolado | ✅ |
| **Service worker** | `js/sw-guard.js` (novo) | ✅ |
| `window.open` | interceptado | ✅ |
| `chrome.tabs.create` / `update` | interceptado | ✅ |
| `<img src>` / `srcset` | interceptado antes da requisição | ✅ |
| `<a href target=_blank>` | guarda de clique + remoção + DNR | ✅ |
| `location.assign/replace/href` | regra DNR (não dá para interceptar em JS) | ✅ |
| CSS `@import` / `url()` | removidos / locais | ✅ |
| `WebSocket` / `EventSource` / `sendBeacon` | **não existem** no código | ✅ (varredura) |
| Sync de métricas (a cada 30 min) | é um **stub** que devolve "desabilitado" | ✅ |

### As únicas conexões externas que restam

| Destino | Por quê | Dá para remover? |
|---|---|---|
| `web.whatsapp.com` | é o produto — a extensão automatiza o WhatsApp Web | não, sem perder a função |
| CDN do WhatsApp (`mmg.whatsapp.net` etc.) | mídia que o próprio WhatsApp baixa | não, é o WhatsApp |
| `fonts.googleapis.com` | **removido** | — |

> Importante: quando alguém abre o WhatsApp Web, essa página **obviamente** fala
> com os servidores do WhatsApp. Isso não é a extensão, é o WhatsApp.

### Auditoria de cliques

- **86 botões** nas 8 telas (nível 1)
- **~60 botões** dentro de menus e modais (nível 2)
- **10 itens** que são `div`/`span` (menu do usuário, cards de ajuda)

Resultado: **0 requisições externas, 0 aberturas para fora, 0 erros.**

Isso virou teste permanente (`e2e/sem-rede.test.js`, 11 testes): clica em todos os
botões de todas as telas e **falha** se qualquer coisa sair. Ele também exige um
número mínimo de botões por tela, para não passar vazio se a UI quebrar.

---

## 2. Completude funcional

### Funciona 100% local (sem servidor, sem login)

| Recurso | Estado |
|---|---|
| Biblioteca de mensagens (texto, áudio, mídia, arquivo) | ✅ completo |
| Pastas, busca, filtros, ordenação | ✅ completo |
| Player de áudio + waveform, gravador inline | ✅ completo |
| Scripts (sequências de mensagens, reordenar) | ✅ completo |
| Gatilhos (palavra-chave, condições, ativar/duplicar) | ✅ completo |
| Fluxos (canvas, 18 tipos de nó, simulador, templates) | ✅ completo |
| Backup e restauração (`.lzb`) | ✅ completo — exportar, validar e restaurar testados ponta a ponta |
| Verificação de arquivos corrompidos | ✅ completo |
| Tema claro/escuro, idioma (4), zoom | ✅ completo |
| Conversão de áudio para Ogg/Opus | ✅ **local** (era o servidor deles) |
| Envio no WhatsApp | ⚠️ depende do WhatsApp real |
| Métricas do dashboard | ⚠️ contadores locais sim; "conversas humanizadas"/"horas de áudio" vêm do sync (stub) |

### Não existe local (por decisão, não por falha)

Estes botões continuam na interface, mas **não navegam** — mostram um aviso:
*"Este recurso fica no painel online da Leadzy e não está disponível no modo local."*

| Recurso | Por que não tem versão local |
|---|---|
| Leadzy CRM (deals, kanban, pipelines) | é uma aplicação web inteira, roda no servidor deles |
| Perfil e conta | dados de conta vivem na API |
| Ajustes e configurações | idem |
| Assinar / upgrade de plano | envolve pagamento |
| Adicionar membro (equipe) | gestão de equipe é server-side |
| Central de ajuda, suporte, materiais | conteúdo no site deles |

**Isto não é "faltando alguma coisa" — é a fronteira do que dá para localizar.**
Replicar essas telas significa escrever a aplicação do zero, não ajustar configuração.

---

## 3. O que eu NÃO consigo garantir (e por quê)

Sejamos explícitos sobre o que está fora do alcance dos testes:

| Item | Por que não é testável aqui | Risco real |
|---|---|---|
| **Botões da UI injetada dentro do WhatsApp** | o content script só monta a interface quando o WhatsApp real está autenticado (no meu WhatsApp falso, `0` elementos `lz-` são criados) | baixo: esses botões rodam no **mesmo mundo isolado** já protegido; o patch é anterior a eles |
| **`wapi.js` com o WhatsApp real** | depende de módulos internos do bundle do WhatsApp | **alto**: quando o WhatsApp muda, quebra — e sem `update_url` não vem correção automática |
| Envio real de mensagem / áudio | precisa de conta WhatsApp real | médio |
| Gatilho reagindo a mensagem real | idem | médio |
| Gravação por microfone | precisa de device de áudio | baixo |

Traduzindo: a **camada local** (auth, plano, rede, conversão) está coberta ponta a
ponta por 100 testes. A **integração com o WhatsApp** não tem como ser
automatizada aqui — e é a única parte que pode quebrar sozinha, por mudança deles.

---

## 4. Resumo em uma linha

- **Redirecionamento:** fechado. Provado com o DNS da Leadzy morto — nada quebra.
- **Funcionalidade:** tudo que é do produto (mensagens, scripts, gatilhos, fluxos,
  backup, áudio) está completo e local. Os painéis web deles (CRM, conta, planos,
  suporte) não foram replicados — agora avisam em vez de navegar.
- **Risco residual:** a integração com o WhatsApp Web, que nenhum teste daqui
  alcança e que depende de o WhatsApp não mudar.

---

## 5. Suíte de testes

**256 testes, 0 pulados, 0 falhando.** `cd tests && ./run-all.sh` (~7 min)

| Camada | Testes |
|---|---|
| Unitários | 151 |
| End-to-end (Chromium real) | 16 |
| Links externos (allowlist + DNR) | 8 |
| Cobertura de rotas de API | 7 |
| **Disparo em massa** | **17** | WhatsApp Web simulado com o mesmo protocolo do wapi |
| Fluxos | 5 |
| Backup / restauração | 3 |
| Content script | 7 |
| Diferencial vs. original | 3 |
| Auditoria de botões | 11 |
| Service worker + DNS morto | 7 |
