# Disparo em massa — o que foi construído

Tela nova: **Disparo em massa**. Abre pelo menu da página de Configurações
(item novo "Disparo em massa") ou direto em `chrome-extension://<id>/campaigns.html`.

---

## 1. O que ele faz

### Lista de números
- Cola em qualquer formato: `(11) 99999-8888`, `+55 11 99999-8888`, `11 99999-8888`,
  um por linha, ou vários por vírgula / ponto-e-vírgula / pipe / espaço.
- Valida DDD real (26, 23, 25, 30 não existem), exige 9 no celular.
- **Nono dígito**: celular brasileiro circula em duas grafias (`5586981638438`
  e `558681638438`). A primeira tentativa é sempre com o 9; se o WhatsApp
  recusar o número, o envio tenta sem o 9 na hora, uma única vez. Resultado sem
  resposta (ambíguo) **não** repete, para não duplicar a mensagem.
- Mostra **quantos válidos, quantos inválidos (com o motivo) e quantos duplicados**.
- Duplicados e inválidos nunca entram na fila.

### Mensagem — 3 modos
| Modo | Como funciona |
|---|---|
| **Fixa** | todos recebem o mesmo texto |
| **Spintax** | `{Oi\|Olá}, {tudo bem\|beleza}?` — sorteia uma opção por envio; mostra quantas variações existem (aqui: 4) |
| **Rotação** | você escreve N mensagens completas; o sistema alterna na ordem, sem repetir em sequência |

### Proteções anti-bloqueio (cada uma com liga/desliga)
**Homoglifos** — troca letras latinas por caracteres de outros alfabetos
visualmente idênticos (о cirílico no lugar de o). O texto continua legível,
mas o hash muda. Tem controle de intensidade (10–100%) e **não corrompe URLs**.

**Caracteres invisíveis** — cola de 1 a 12 caracteres de largura zero no fim.
Inclui a opção de **espaços finos** (hair space / thin space): a pessoa sente o
espaço ao digitar, mas não vê nada.

### Áudio e mídia por pasta
Você cria pastas e joga arquivos dentro. **Por envio, o sistema escolhe um
arquivo de cada pasta.** Duas pastas de áudio → dois áudios na mesma mensagem.
Mesma regra para imagens.

### Ritmo
- **Intervalo entre mensagens**: mín–máx em segundos → sorteia um valor na faixa
- **Mensagens por lote**: mín–máx → sorteia o tamanho do lote
- **Pausa entre lotes**: mín–máx em minutos → sorteia a pausa
- Mostra o **tempo estimado** antes de começar

### Controles
Iniciar · Pausar · Retomar · Cancelar · barra de progresso · contadores
(enviados / falhas / na fila / total) · log ao vivo com horário.

### Edição durante a campanha
- **Remover número** ainda não enviado (botão na linha da tabela, ou
  "Remover não enviados" para limpar a fila toda).
- **Editar texto, fotos, pastas e ritmo** a qualquer momento — vale para quem
  ainda não recebeu; quem já recebeu não muda.
- Contatos já enviados **nunca** são removidos.

### Relatório
Tabela por contato (número, status, hora do envio, erro), exportação **CSV**
(abre no Excel, já com BOM e escape de vírgula/aspas) e **reprocessar falhas**
(devolve os que falharam para a fila).

---

## 2. Como foi integrado (sem tocar nos bundles)

O `wapi.js` já expõe um **barramento de comandos** dentro da aba do WhatsApp:

```js
window.dispatchEvent(new CustomEvent("messages:sendTextRequest", {
  detail: { correlationId, chatId, content }
}));
window.addEventListener("response_" + correlationId, ...)
```

A tela de campanhas injeta uma função na **MAIN world** da aba do WhatsApp via
`chrome.scripting.executeScript` e usa exatamente esse barramento —
`messages:sendTextRequest`, `sendAudioRequest`, `sendMediaRequest`,
`sendDocumentRequest`. **Nenhum arquivo original foi alterado.**

Arquivos novos:
| Arquivo | Papel |
|---|---|
| `campaigns.html` | a tela |
| `css/campaigns.css` | estilos (fonte Inter local) |
| `js/campaign-engine.js` | lógica pura: números, spintax, homoglifos, invisíveis, ritmo, estado, relatório |
| `js/campaigns-ui.js` | interface + execução + ponte com o WhatsApp |
| `js/local-bootstrap.js` (seção 9) | item de menu "Disparo em massa" na página de Configurações |

---

## 3. Testes

**299 testes, 0 falhas, 13 blocos.** (`TESTS.md` tem o inventário completo)

Para o disparo especificamente:

**`tests/unit/campaign-engine.test.js` — 55 testes**
Números (formato, DDD, duplicados, inválidos), spintax (aninhado, desbalanceado,
contagem de variações), homoglifos (intensidade, URL intacta, mesmo comprimento),
invisíveis (quantidade, tipo de caractere, limites), ritmo (faixas, lotes,
cobertura exata dos contatos), pastas (uma mídia de cada), estado (pausar/cancelar/
retomar, remover pendentes sem tocar em enviados), relatório e CSV (escape).

**`tests/e2e/campanhas.test.js` — 11 testes**
Sobe um WhatsApp Web falso (HTTPS + DNS mapeado) que implementa o **mesmo
barramento do wapi**, e dispara de verdade:

- a tela abre sem erro e sem rede externa
- lista misturada conta certo (3 válidos, 1 inválido, 1 duplicado)
- os 3 modos de texto funcionam na interface
- as proteções persistem no storage
- **dispara e o "WhatsApp" recebe**: 3 envios, chatIds corretos, texto com
  homoglifos (mesmo comprimento + 4 invisíveis), e duas mensagens nunca iguais
- falha de envio é registrada com o motivo e pode ser reprocessada
- 2 pastas de áudio → **2 áudios** enviados, como PTT
- pausar para o envio de verdade; retomar continua
- remover pendente não afeta quem já recebeu
- o item de menu aparece em Configurações
- zero requisição para a Leadzy em todo o fluxo

---

## 4. O que NÃO foi testado (e por quê)

| Item | Situação |
|---|---|
| Envio com **WhatsApp real** | precisa de número autenticado. O protocolo (barramento) está testado contra um WhatsApp falso que fala exatamente o mesmo protocolo — mas o comportamento do WhatsApp de verdade, não |
| **Número que não existe** | o wapi trata; aqui simulamos a falha. A mensagem de erro real vem dele |
| **Risco de ban** | disparo em massa viola os termos do WhatsApp. As proteções reduzem a chance, não eliminam |
| Mídia muito grande | o áudio/imagem vai em base64 pela ponte; arquivos de dezenas de MB podem ficar lentos |
| Retomar após **fechar o navegador** | o progresso é salvo no storage a cada envio; a campanha volta como "executando" mas o laço só retoma ao clicar em Iniciar |

---

## 5. Um alerta honesto

O WhatsApp bane contas por disparo em massa. O que esta ferramenta faz para
reduzir a chance: intervalos aleatórios, lotes com pausa, variação de texto,
homoglifos, invisíveis, mídia variada por pasta.

O que **não** existe: aquecimento de número, limite diário automático, detecção
de bloqueio em tempo real, rotação de chip. Se for usar em volume alto, o risco
é seu e é real. Recomendo testar com 10–20 números primeiro e acompanhar.
