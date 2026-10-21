# Suíte de verificação — Leadzy local

70 testes, divididos em quatro camadas. Os E2E rodam em **Chromium de verdade,
com a extensão carregada** (`--load-extension`), não em jsdom.

```bash
./setup.sh     # uma vez: instala chromium, libs do sistema, certificado
./run-all.sh   # roda tudo
```

Saída esperada:

```
 1/3  Unitários ............................. 45/45
 2/3  End-to-end (Chromium real) ............ 15/15
 3/3  Content script ........................  7/7
      Diferencial vs. extensão original .....  3/3
 RESULTADO: TUDO PASSOU
```

---

## Estrutura

```
tests/
├── setup.sh                  # prepara ambiente (npm, chromium, libs, cert)
├── run-all.sh                # roda as 4 camadas
├── lib/
│   ├── env.js                # launch() do Chromium com a extensão + watch()
│   └── ogg.js                # parser Ogg INDEPENDENTE (não compartilha código
│                              # com o patch — é o contraponto de verificação)
├── fixtures/
│   ├── mono.webm  stereo.webm  live.webm     # entradas
│   └── mono-ref.ogg ...                      # gabarito gerado pelo ffmpeg
├── unit/
│   ├── manifest.test.js      # integridade do pacote
│   ├── routing.test.js       # roteador de mocks
│   ├── remux.test.js         # conversão WebM→Ogg
│   └── network-shim.test.js  # fetch/XHR + semeadura
├── e2e/
│   ├── extension.test.js     # popup, rotas, criação de dados, /convert
│   ├── content-script.test.js# injeção no WhatsApp (mundo isolado)
│   └── differential.test.js  # patch vs. pacote original
├── certs/                    # TLS local para o teste do content script
└── libs/root/                # .so extraídos dos .deb (Chromium sem root)
```

---

## O que cada camada prova

### 1. Unitários (45)

**`manifest.test.js`**
- manifest é MV3 e válido
- `local-bootstrap.js` é o **primeiro** do `content_scripts`
- `popup.html` / `options.html` carregam o patch **antes** do bundle, e sem `defer`
- `update_url` e `externally_connectable` removidos; `_metadata` apagada
- permissões não foram ampliadas (`storage`, `unlimitedStorage`, `tabs`, `scripting`)
- todo arquivo referenciado existe
- **os 6 bundles originais estão byte a byte no tamanho original** (prova de que nada foi reescrito)

**`routing.test.js`**
- detecção de host: aceita `*.leadzy.com.br`, rejeita `leadzy.com.br.evil.com`, `notleadzy.com.br`, `evil.com/leadzy.com.br`
- as 6 rotas devolvem o esperado; rotas desconhecidas devolvem `[]`/`{}`
- **nenhuma resposta é 401/500** — o interceptor do axios chama `logout()` em 401, então isso é crítico

**`remux.test.js`**
- CRC32 conferido contra implementação **bit a bit independente**
- CRC conferido contra os CRCs gravados pelo **ffmpeg** (contraponto externo)
- para `mono`, `stereo` e `live`:
  - o Ogg gerado passa por um validador estrutural completo (capture pattern, versão, CRC de cada página, sequência, serial, granulepos monotônico, BOS/EOS)
  - **os pacotes Opus são byte a byte idênticos aos do ffmpeg** (`-c:a copy`)
  - duração e canais coerentes
- entrada já em Ogg passa intacta
- webm truncado, webm corrompido, mp4 e blob vazio **não lançam exceção**

**`network-shim.test.js`**
- semeia `access_token` + `me`
- carregar o módulo duas vezes não re-embrulha o XHR (idempotência)
- não lança quando `chrome.storage` não existe
- XHR com `responseType` json / text / blob / headers
- `/convert` devolve Ogg válido pelo shim
- host externo é delegado ao XHR/fetch real (não interceptamos o mundo)

### 2. End-to-end (15) — Chromium real

- extensão carrega, service worker ativo
- **popup abre sem login** e com licença semeada; `__LZ_LOCAL_ACTIVE__` e `XMLHttpRequest.name === "LzXHR"`
- as 6 rotas (`/dashboard`, `/messages`, `/scripts`, `/triggers`, `/flows`, `/flows/new`) renderizam **sem nenhum `pageerror`**
- navegação clicando no menu entre as 5 seções
- dados semeados no storage aparecem na UI (contadores e lista)
- **criar mensagem pela interface** → persiste no storage → sobrevive ao reload
- **criar script pela interface** (escolhendo a mensagem, modal de confirmação) → `nameScript` + `scriptData` no storage
- **criar gatilho pela interface** (condição por palavra-chave, vínculo com o script, modal de confirmação) → `triggerRules[0].keywords` corretos e `scriptId` apontando para um script existente
- `/convert` no navegador: Ogg válido e pacotes idênticos ao gabarito
- **zero requisições para `*.leadzy.com.br` em toda a sessão**

### 3. Content script (7) — WhatsApp falso via TLS local

Sobe um servidor HTTPS com certificado próprio e mapeia `web.whatsapp.com`
para ele (`--host-resolver-rules`), porque o domínio está na lista HSTS e exige TLS.
Aí, via CDP, inspecionamos o **mundo isolado da extensão**:

- o content script é injetado no mundo isolado (nome `Leadzy`)
- o patch está ativo lá, `XMLHttpRequest` é o shim e `fetch` também
- `fetch` para a API da Leadzy **dentro do mundo isolado** devolve `local-user` e `hasChat: true`
- a licença foi semeada a partir do content script
- **o mundo da página (MAIN) continua intocado** — `XMLHttpRequest` original, sem vazamento de flag
- zero requisições para a Leadzy

### 4. Diferencial (3) — patch vs. original

Roda o **zip original** com as requisições para `*.leadzy.com.br` abortadas
(simulando "sem servidor"):

- original **sem token** → cai em `#/login` ✅ (prova que a autenticação bloqueava)
- original **com token colocado à mão** → o app funciona normalmente... e **tenta falar com o servidor** (`pedidos.length > 0`)
- patch → mesma interface, **zero requisições**

Conclusão verificada: o patch só automatiza o que o app já fazia offline. Não
altera comportamento, não desliga recurso, não reescreve lógica.

---

## O que esta suíte NÃO cobre

Sendo explícito para não haver "talvez":

| Não coberto | Por quê | Como ficar seguro |
|---|---|---|
| **Envio real de mensagem no WhatsApp** | precisa de conta WhatsApp real e do DOM real; o `wapi.js` faz hook no webpack deles | teste manual: conectar um número e enviar um texto + um áudio |
| **Motor de gatilho reagindo a mensagem real** | depende do content script rodando no WhatsApp real | idem: mandar "quero saber mais" de outro celular |
| **Gravação de áudio pelo microfone** | precisa de device de áudio | manual |
| **Montar fluxo no canvas** | interação de drag-and-drop no canvas | manual |
| **Backup / restore `.lzb`** | fluxo de upload de arquivo | manual |
| **`wapi.js` após atualização do WhatsApp** | depende de módulos internos que mudam sem aviso | não tem teste possível; quebra e precisa de conserto |

As três primeiras são **as únicas coisas que importam de verdade no uso diário**
— e todas dependem do WhatsApp real, não da camada que eu escrevi. A camada local
(auth, plano, conversão de áudio, isolamento de rede) está coberta ponta a ponta.

---

## Notas de implementação dos testes

- O mundo isolado da extensão aparece no CDP com o nome **`Leadzy`**, não com o id.
- O `onInstalled` do service worker abre/recarrega abas do WhatsApp e do options —
  o harness espera ~3,5 s e tenta a navegação até 4 vezes antes de assumir falha.
- Os contadores do dashboard só refletem o storage **depois** que a página de
  Mensagens monta (a store é hidratada ali). É comportamento do app original,
  não do patch — por isso a ordem dos testes é `/messages` → `/dashboard`.
- A saudação do dashboard varia com o horário ("Bom dia" / "Boa tarde" / "Boa noite"),
  então as asserções usam "O que vamos fazer hoje?".
- Os `.deb` das bibliotecas são baixados e extraídos localmente porque o sandbox
  não tem root; `libs/debs/` foi apagado depois da extração, `libs/root/` ficou.
