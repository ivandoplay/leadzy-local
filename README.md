# Leadzy Local

Extensão de automação de WhatsApp Web rodando **100% local**: sem servidor, sem
login, sem telemetria. O pacote original da Chrome Web Store foi mantido
intacto e tudo que é novo entra como camada aditiva.

## O que é

A extensão original (Leadzy 4.0.4) dependia do backend `leadzy.com.br` para
autenticação, sincronização e execução dos disparos. Este projeto remove essa
dependência e mantém funcionando localmente o que tem função real:

- **Mensagens** — biblioteca de textos, áudios, imagens e arquivos
- **Scripts** — sequências de mensagens encadeadas
- **Gatilhos** — automação por palavra-chave
- **Fluxos** — automações em canvas
- **Disparo em massa** — campanhas com ritmo, rotação de texto e proteções

O que era só suporte ao SaaS (login, planos, tutoriais, anúncios, ponte para o
CRM externo) foi removido.

## Instalação

1. Baixe ou clone este repositório
2. Abra `chrome://extensions`
3. Ative o **Modo do desenvolvedor**
4. **Carregar sem compactação** → selecione a pasta `extensao/`

Não é necessário gerar `.crx`. A extensão funciona em qualquer navegador
baseado em Chromium (Chrome, Edge, Brave, Opera).

Requisitos: WhatsApp Web aberto e autenticado para qualquer operação de envio.

## Estrutura

```
extensao/           fonte carregada pelo Chrome
  js/local-bootstrap.js      núcleo: troca as chamadas de rede por local
  js/campaign-engine.js      motor puro do disparo (UMD, testável)
  js/campaigns-ui.js         interface + executor do disparo
  js/popup-extras.js         atalhos no popup
  js/dashboard-extras.js     cartão "primeiros passos"
  campaigns.html             página do disparo em massa

tests/
  unit/            159 testes, rodam sem navegador
  e2e/             140 testes em Chromium real
  run-all.sh        suíte completa (13 blocos)
  setup.sh          prepara Chromium e dependências

*.md                documentação de auditoria e decisões
pmw8x6.zip          pacote original, preservado para o teste diferencial
leadzy-local.zip    pacote pronto da versão atual (gerado a partir de extensao/)
```

## Testes

```bash
cd tests
./setup.sh        # baixa Chromium e dependências (~70 MB em tests/libs)
./run-all.sh      # roda tudo
```

> `tests/libs/` ocupa ~70 MB (bibliotecas do Chromium extraídas dos `.deb`).
> Ela **não é versionada** e o `setup.sh` a reconstrói — apague quando não
> estiver testando. Os 159 testes unitários rodam sem ela; só os end-to-end
> precisam dela.

Resultado atual: **13 blocos, 301 testes, 0 falhas**, ~15 minutos.

| Bloco | Testes | O que cobre |
|---|---|---|
| Unitários | 159 | motor de campanha, roteador, helpers |
| End-to-end | 16 | extensão carregada no Chromium |
| Fluxos + backup | 8 | criar, salvar, exportar, restaurar |
| Content script | 10 | injeção e diferencial contra o original |
| Rotas de API | 9 | rota desconhecida responde 501 |
| Disparo em massa | 17 | WhatsApp Web simulado, envio real |
| Links externos | 8 | allowlist e bloqueio via DNR |
| Auditoria de botões | 11 | nenhum tráfego externo |
| Service worker | 7 | prova com DNS da Leadzy derrubado |
| Jornada de instalação | 9 | popup, dashboard, primeiros passos |
| Achados da auditoria | 27 | fila, tabela, onboarding, mídia, acessibilidade |
| Nono dígito | 6 | com 9 e sem 9, nova tentativa só em falha confirmada |
| Integridade do estado | 12 | recarga, concorrência, falha parcial, memória |

Os testes abrem Chromium de verdade e fazem envios contra um sósia do
WhatsApp Web que fala o mesmo protocolo. Envio contra o WhatsApp real **não**
é testado automaticamente.

## Documentação

| Arquivo | Conteúdo |
|---|---|
| `INSTALAR.md` | passo a passo de instalação e uso |
| `STATUS.md` | estado atual, o que funciona, o que não e pendências |
| `TESTS.md` | inventário dos 301 testes, o que cada um prova e como rodar |
| `DISPARO-EM-MASSA.md` | especificação da feature de campanhas |
| `AUDITORIA-PROMPT.md` | os 13 achados da auditoria: verificação, correção, testes, antes × depois |

Os relatórios de auditoria das fases anteriores (`ANALISE-LEADZY`, `AUDITORIA-BOTOES`,
`AUDITORIA-CORRECOES`, `DEPENDENCIA-SERVIDOR`, `MAPA-ENDPOINTS`,
`VAZAMENTOS-RESTANTES`, `JORNADA-INSTALACAO`, `MELHORIAS`) cumpriram o papel e
saíram do repositório: o que ainda valia foi consolidado em `STATUS.md` e nos
testes que hoje garantem o comportamento. O texto integral continua no histórico
do git (`git log --diff-filter=D --name-only`).

## Limites conhecidos

- Disparo exige WhatsApp Web aberto e autenticado
- Envio automatizado viola os Termos de Uso do WhatsApp — risco de bloqueio é real
- Sem personalização por contato (`{{nome}}`); a rotação usa mensagens inteiras
- Validação prévia de número não é feita (a função existe no bundle, mas não
  está exposta no barramento de comandos)

## Aviso

O pacote original (`pmw8x6.zip`) é de propriedade da Leadzy. Este repositório
existe para uso próprio de quem tem autorização sobre o produto.
