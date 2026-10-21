# Todos os testes que existem (e os que precisam rodar)

Mapa completo da suíte. Tudo abaixo roda contra a extensão de verdade:
unitários sem navegador, e2e com o Chromium abrindo `extensao/` via
`--load-extension`. Nada é simulado em jsdom e nenhum teste é pulado.

```bash
cd tests
bash setup.sh        # uma vez: baixa Chromium e as libs (.deb extraídos)
bash run-all.sh      # roda TUDO, em ordem, ~13 min
```

Runner individual (o mesmo que o `run-all.sh` chama):

```bash
node --test unit/                                        # só unitários
node --test --test-concurrency=1 e2e/campanhas.test.js   # um arquivo e2e
```

> `--test-concurrency=1` é obrigatório nos e2e: cada arquivo sobe o seu próprio
> Chromium e uma porta própria. Rodar em paralelo faz os testes brigarem por
> porta e por perfil.
>
> Nunca use `--test-name-pattern`: ele marca o resto como **SKIP**, e a suíte
> passaria com números falsos.

---

## 1. Inventário por arquivo

### Unitários — sem navegador (`tests/unit/`)

| Arquivo | Testes | O que cobre |
|---|---:|---|
| `campaign-engine.test.js` | 89 | números (DDD real, celular com 9, duplicados, chatId), **nono dígito (`variantesNumero`)**, spintax (aninhado, desbalanceado, contagem), 3 modos de texto, rotação (embaralha sem perder item), homoglifos, invisíveis, plano de envio (lotes, intervalos, uma mídia por pasta), ciclo de vida (pausar/retomar/cancelar), **política da fila (`podeAlterarFila`)**, relatório e CSV |
| `allowlist.test.js` | 16 | quais URLs podem abrir e quais são bloqueadas; âncora interna, WhatsApp de contato (função) vs. WhatsApp do suporte (bloqueado); URL malformada falha fechada; inventário de rotas |
| `manifest.test.js` | 13 | MV3 válido, ordem dos scripts (patch antes do bundle), `update_url`/`externally_connectable` removidos, `_metadata` fora do pacote, regra de bloqueio de rede, fontes locais, nenhuma URL externa no CSS, permissões só ampliadas com justificativa, **bundles originais intactos** |
| `network-shim.test.js` | 16 | XHR e fetch interceptados para os hosts da Leadzy, host externo passa direto, POST não vira GET, `/convert` devolve Ogg, `window.open` bloqueado fora da allowlist |
| `remux.test.js` | 11 | CRC32 contra implementação independente e contra o ffmpeg, webm→ogg, entrada já Ogg intacta, arquivos corrompidos não explodem, determinismo |
| `routing.test.js` | 8 | auth, plano, killswitches, anúncios vazios, rota desconhecida não vaza para a rede, nada devolve 401/500 do servidor real |
| `sw-guard.test.js` | 5 | guarda no service worker, host externo ignorado, `/convert` responde 501 sem sair para a rede, re-embrulho evitado |

### End-to-end — Chromium real (`tests/e2e/`)

| Arquivo | Testes | O que cobre |
|---|---:|---|
| `extension.test.js` | 16 | extensão carrega com service worker, popup sem login, rotas `/dashboard /messages /scripts /triggers /flows`, criar mensagem/script/gatilho pela interface e sobreviver ao reload, `/convert` no navegador, tema escuro, zero tráfego para a Leadzy |
| `campanhas.test.js` | 17 | disparo completo contra um WhatsApp falso (mesmo barramento do wapi): contagem da lista, 3 modos, proteções, homoglifos/invisíveis no envio, falha registrada, mídia por pasta, pausar/retomar, remover pendente, item no menu, intervalo preciso, pausa após N falhas, QR Code bloqueia início, limite diário, gravação em lote |
| `achados.test.js` | 29 | **regressão dos 13 achados da auditoria** + consistência visual (cabeçalho, rodapé, paleta) — mapa na seção 2 |
| `nono-digito.test.js` | 6 | celular com e sem o nono dígito: uma tentativa quando funciona, segunda tentativa **só** em falha confirmada, sem repetir em ambíguo, sem laço quando as duas falham, fixo não ganha 9 inventado |
| `integridade.test.js` | 12 | campanha "executando" volta como interrompida, aviso na tela, ambíguo não reenviado sozinho, clique duplo em Iniciar gera uma execução, lista travada durante envio, resultado no contato certo, erro de gravação visível, CSV com cabeçalho, cancelar para as partes seguintes, dataURL liberado da memória |
| `primeiros-passos.test.js` | 9 | popup sem propaganda e com atalhos que funcionam; cartão "Primeiros passos" só marca etapa comprovada (campanha com conteúdo, WhatsApp realmente conectado) |
| `links-externos.test.js` | 8 | guarda de clique, `target=_blank` para Leadzy bloqueado, link de suporte bloqueado mesmo sem observador, âncora de contato preservada, bloqueio de rede do manifest ativo, nenhuma saída em todas as telas |
| `sem-rede.test.js` | 11 | menu do usuário e cards de ajuda sem tráfego, fontes do pacote (não do Google), imagens do bucket viram placeholder |
| `service-worker.test.js` | 7 | com **DNS da Leadzy derrubado**: fetch no SW e na página respondem local, interface carrega e navega, fontes acessíveis, licença semeada sem login |
| `rotas.test.js` | 9 | caminhada pela interface: nenhuma rota cai em fallback genérico, todas respondidas por mock explícito, feature-flags desligadas, escrita não chama API, rota desconhecida = 501 |
| `content-script.test.js` | 7 | injeção no mundo isolado, patch ativo, rotas respondidas localmente, licença semeada, mundo da página (MAIN) intacto |
| `fluxos.test.js` | 5 | templates de funil, criar fluxo em branco e salvar rascunho, fluxo reaparece após reload, menu de tipos de nó, simulador abre |
| `backup.test.js` | 3 | exportar `.lzb` pela interface, ZIP válido com a mensagem dentro, restaurar em perfil limpo |
| `differential.test.js` | 3 | original cai no login; original com token manual funciona; patch com a mesma interface e zero requisições à Leadzy |

**Total esperado: 301 testes** (159 unitários + 142 end-to-end).
O número final só vale o que o `run-all.sh` imprimir.

---

## 2. Onde cada achado da auditoria é provado

| Achado | Testes |
|---|---|
| 1 — troca/criação/exclusão de campanha durante o disparo | `achados`: 3 testes + `unit`: 3 de `podeAlterarFila` |
| 2 — tabela incremental | medido em `node perf-tabela.js` (antes × depois), ver `AUDITORIA-PROMPT.md` §F |
| 3 — bloqueio da fila | `achados`: 2 + `integridade`: lista travada, cancelar libera |
| 4 — `accept` acompanha o tipo + validação real | `achados`: 2 |
| 5 — upload rastreável | `achados` (tipo) + `campanhas` (mídia por pasta persiste) |
| 6 — onboarding só com prova | `achados`: 4 + `primeiros-passos`: 4 |
| 7 — texto da rotação = comportamento | `achados`: 1 + `unit` (rotação embaralha) |
| 8 — estado / aviso / log separados | `achados`: 2 + `integridade`: 2 |
| 9 — estimativa por contato e partes | `achados`: 2 |
| 10 — indicador de salvamento | `achados`: 2 + `integridade`: 2 |
| 11 — estado vazio e coluna de ações | `achados`: 2 |
| 12 — HTML/ARIA/foco/idioma/hierarquia | `achados`: 5 + 1 de consistência visual + 2 de tema escuro e contraste |
| 13 — nomenclatura das travas | `achados`: 1 |

---

## 3. Como cada camada funciona (para saber o que o teste realmente prova)

- **WhatsApp falso**: servidor HTTPS local + `--host-resolver-rules=MAP
  web.whatsapp.com 127.0.0.1:PORT` + `--ignore-certificate-errors`. A página
  escuta `messages:sendTextRequest` / `sendMediaRequest` / `sendAudioRequest` /
  `sendDocumentRequest` e responde `response_<correlationId>`, exatamente como o
  `wapi.js`. Portas reservadas: 4712 (achados), 4714 (nono dígito), 8444
  (campanhas).
- **Falha vs. ambíguo**: `success:false` = falha confirmada; ausência de
  resposta = ambíguo. Essa distinção é o que autoriza (ou não) a segunda
  tentativa do nono dígito e o reenvio automático.
- **DNS derrubado**: `service-worker.test.js` bloqueia a resolução da Leadzy e
  prova que a interface continua funcionando offline.
- **CSV, backup e relatório** são validados abrindo o arquivo gerado, não
  inspecionando código.

---

## 4. Checklist de execução (o que rodar, na ordem)

```bash
cd tests

# 1. preparar (uma vez por máquina/sessão)
bash setup.sh

# 2. suíte completa — 13 blocos
bash run-all.sh
#    esperado: "RESULTADO: TUDO PASSOU"

# 3. medição de desempenho da tabela (não é teste, é número)
node perf-tabela.js

# 4. capturas para conferência visual
node shots.js
```

Se um bloco falhar, o `run-all.sh` imprime o resumo por bloco no final, no
formato `RESULTADO: FALHOU (unit=… campanhas=… achados=… nono=…)` — o campo
diferente de `0` é o culpado.

---

## 5. O que a suíte NÃO cobre (limites honestos)

| Item | Por quê |
|---|---|
| Envio com WhatsApp real | exige número autenticado. O protocolo é testado contra um sósia que fala o mesmo barramento; o comportamento do servidor real, não |
| QR Code / pareamento de verdade | só o estado da tela é simulado |
| Leitor de tela (NVDA/VoiceOver) | os atributos ARIA e o teclado são testados; a experiência auditiva não |
| Mídia grande (dezenas de MB) | o limite de memória por Data URL é estrutural e conhecido |
| Bloqueio de conta pelo WhatsApp | não é observável de dentro da extensão |
