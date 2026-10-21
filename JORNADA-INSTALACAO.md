# Jornada de instalação — o que mudou

Percorri a extensão como quem acabou de instalar: ícone → popup → dashboard →
cada menu → cada botão de criar. O que estava errado e o que foi corrigido.

---

## O que estava errado

### 1. O popup oferecia coisas que não existem

| Item | Problema |
|---|---|
| "Leadzy CRM" | Botão que dependia do servidor removido. Não faz nada. |
| "Leadzy Agentes" | Propaganda de um produto SaaS. |
| "Ver como funciona" | Link para fora. |

E o que **faltava**: nenhum caminho para o disparo em massa. Quem instalava
via um popup com 3 botões e nenhum deles levava ao recurso principal.

### 2. O dashboard abria numa tela morta

Instalação nova mostrava: saudação, seis contadores zerados, e **três
propagandas** (Tutoriais, Suporte, Materiais). Duas delas abrem o site da
Leadzy; a terceira também. Zero instrução de como começar.

Havia ainda um cartão "+1 / Adicionar membro" — convite para montar equipe,
numa extensão local de uso individual.

### 3. Bug meu, encontrado pelo teste

O primeiro "Primeiros passos" procurava o WhatsApp com
`url.indexOf("web.whatsapp.com") === 0`. A URL real começa com
`https://` — **nunca casava**. O passo ficava eternamente pendente mesmo com
o WhatsApp aberto.

---

## O que foi feito

### Popup (`js/popup-extras.js` — novo, 120 linhas)

Dois atalhos entre o logo e o status:

```
[ Disparo em massa ]  [ Configurações ]
```

E os três blocos que dependiam do SaaS ficam ocultos. O popup passou de
"3 botões, nenhum útil" para "2 botões, os dois certos".

### Dashboard (`js/dashboard-extras.js` — novo, 300 linhas)

No lugar das três propagandas entrou o cartão **Primeiros passos**, na coluna
que ficava vazia:

| Passo | Conclui quando | Botão |
|---|---|---|
| Abra o WhatsApp Web | existe aba `web.whatsapp.com` | Abrir WhatsApp |
| Crie uma campanha | existe campanha salva | Abrir disparo |
| Monte sua biblioteca | há mensagem em `messageList` | Ver mensagens |

O estado é lido de `chrome.tabs` + `chrome.storage.local`. Cada item tem marca
`○`/`✓`, e o contador sobe conforme você faz. Ao completar os três o cartão
muda para "Tudo pronto — sua extensão está configurada."

Nada disso trava: os menus originais seguem idênticos, e o cartão desaparece
quando você sai do dashboard.

---

## Testes

Novo bloco na suíte: `tests/e2e/primeiros-passos.test.js` — **9 testes**.

| Teste | Prova |
|---|---|
| popup mostra os 2 atalhos | nomes exatos, nessa ordem |
| popup não anuncia o SaaS | "Leadzy CRM" e "Agentes" com 0 px |
| "Disparo em massa" abre campanhas | aba `campaigns.html` existe |
| "Configurações" abre o dashboard | aba `options.html` existe |
| dashboard mostra o cartão | e as 3 propagandas sumiram |
| criar campanha marca o passo | contador vai para `1 de 3` |
| WhatsApp aberto conclui o passo | contador vai para `1 de 3` e o botão some |
| cartão não vaza para outros menus | ausente em `/messages` |
| nenhuma requisição externa | lista de URLs externas vazia |

O teste do WhatsApp abre uma aba real em `web.whatsapp.com` (servida
localmente) — não simula: verifica a URL de verdade pelo `chrome.tabs`.

**Suíte completa: 10 blocos, 224 testes, 0 falhas.**

---

## O que ainda dá para melhorar

Itens que vi e **não** mexi porque exigem decisão sua:

1. **A saudação diz "Usuário Local"** com um selo laranja que parece aviso de
   erro. Poderia ser neutro ("Olá") ou usar o nome que você definir.
2. **"Seus itens" mostra 0 mensagens** mesmo com itens na biblioteca — o
   contador do bundle lê de outro lugar. Não corrigi porque é o bundle.
3. **Falta um botão para abrir o WhatsApp direto do dashboard** — hoje só pelo
   popup. O cartão resolve isso enquanto os passos estiverem pendentes, mas
   some depois de concluídos.
4. **Sem `es`/`it` no `_locales`** — os textos existem, o registro na loja não.
