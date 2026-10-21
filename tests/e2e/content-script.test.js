"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const PORT = 8443;

// Página mínima que imita o suficiente do WhatsApp Web. O objetivo não é rodar
// o WhatsApp, e sim provar que:
//   1. os dois content scripts são injetados no mundo isolado da extensão
//   2. o patch está ativo nesse mundo
//   3. o mundo da página (MAIN) continua intocado
//   4. nada sai para os servidores da Leadzy
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>WhatsApp</title></head>
<body>
  <div id="app">
    <div id="pane-side"></div>
    <div id="main"></div>
    <div contenteditable="true" id="compose"></div>
  </div>
  <script>window.__PAGE_XHR_NAME = XMLHttpRequest.name;</script>
</body></html>`;

let server, ctx, id, page, cdp;
let contextos = [];
const leadzyRequests = [];

before(async () => {
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(__dirname, "../certs/key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "../certs/cert.pem")),
    },
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGINA);
    }
  );
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const l = await launch([
    // WhatsApp está na lista HSTS: https é obrigatório, e mapeamos a porta 443
    // (e qualquer outra) para o nosso servidor local.
    `--host-resolver-rules=MAP web.whatsapp.com 127.0.0.1:${PORT}`,
    "--ignore-certificate-errors",
  ]);
  ctx = l.ctx;
  id = l.id;

  // No onInstalled o service worker abre/recarrega abas do WhatsApp e do
  // options.html. Deixamos isso acontecer antes de navegar.
  await sleep(3500);
  for (const p of ctx.pages()) await p.close().catch(() => {});

  page = await ctx.newPage();
  page.on("request", (r) => {
    if (/leadzy\.com\.br/i.test(r.url())) leadzyRequests.push(r.url());
  });

  cdp = await ctx.newCDPSession(page);
  cdp.on("Runtime.executionContextCreated", (e) => contextos.push(e.context));
  await cdp.send("Runtime.enable");

  // A primeira navegação pode ser abortada por um reload disparado pelo SW.
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    try {
      await page.goto(`https://web.whatsapp.com:${PORT}/`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      break;
    } catch (e) {
      if (tentativa === 3) throw e;
      await sleep(1000);
    }
  }
  await sleep(4000);
});

after(async () => {
  if (ctx) await ctx.close();
  if (server) await new Promise((r) => server.close(r));
});

/** Recoleta os contextos vivos (um reload invalida os ids antigos). */
async function contextosVivos() {
  contextos = [];
  await cdp.send("Runtime.disable");
  await cdp.send("Runtime.enable");
  await sleep(300);
  return contextos;
}

async function mundoIsolado() {
  const lista = await contextosVivos();
  // O mundo isolado da extensão aparece com o nome do manifest ("Leadzy");
  // o Playwright cria um mundo próprio (__playwright_utility_world_*).
  const alvo = lista.find(
    (c) =>
      c.auxData &&
      c.auxData.type === "isolated" &&
      !String(c.name).startsWith("__playwright")
  );
  assert.ok(
    alvo,
    `mundo isolado não encontrado. contextos: ${lista
      .map((c) => JSON.stringify({ n: c.name, t: c.auxData && c.auxData.type }))
      .join(", ")}`
  );
  return alvo;
}

async function evalNo(expression, contextId) {
  const r = await cdp.send("Runtime.evaluate", {
    contextId,
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

test("a página falsa do WhatsApp carregou", async () => {
  const t = await page.title();
  assert.strictEqual(t, "WhatsApp");
  assert.strictEqual(await page.evaluate(() => !!document.getElementById("pane-side")), true);
});

test("o content script é injetado no mundo isolado da extensão", async () => {
  const alvo = await mundoIsolado();
  assert.strictEqual(alvo.name, "Leadzy", "nome do mundo isolado mudou");
  assert.strictEqual(alvo.auxData.type, "isolated");
});

test("o patch está ativo no mundo isolado", async () => {
  const alvo = await mundoIsolado();
  assert.strictEqual(await evalNo("!!window.__LZ_LOCAL_ACTIVE__", alvo.id), true);
  assert.strictEqual(await evalNo("window.XMLHttpRequest.name", alvo.id), "LzXHR");
  assert.match(await evalNo("String(window.fetch)", alvo.id), /isLeadzyUrl/, "fetch não é o shim");
});

test("no mundo isolado, as rotas da Leadzy são respondidas localmente", async () => {
  const alvo = await mundoIsolado();
  const r = await evalNo(
    `(async () => {
       const a = await fetch("https://api-userv2.leadzy.com.br/auth/me").then(r => r.json());
       const p = await fetch("https://api-userv2.leadzy.com.br/plan-features/product-lines").then(r => r.json());
       return { id: a.id, hasChat: p.hasChat };
     })()`,
    alvo.id
  );
  assert.strictEqual(r.id, "local-user");
  assert.strictEqual(r.hasChat, true);
});

test("o licenciamento foi semeado a partir do content script", async () => {
  const alvo = await mundoIsolado();
  const store = await evalNo(
    `new Promise(r => chrome.storage.local.get(["access_token","me"], r))`,
    alvo.id
  );
  assert.ok(store.access_token && store.access_token.length > 10);
  assert.strictEqual(JSON.parse(store.me).id, "local-user");
});

test("o mundo da página (MAIN) NÃO foi alterado", async () => {
  const r = await page.evaluate(() => ({
    xhr: window.__PAGE_XHR_NAME,
    lz: typeof window.__LZ_LOCAL_ACTIVE__,
  }));
  assert.notStrictEqual(r.xhr, "LzXHR", "o XHR da página foi embrulhado — não deveria");
  assert.strictEqual(r.lz, "undefined", "a flag do patch vazou para a página");
});

test("nenhuma requisição saiu para *.leadzy.com.br", () => {
  assert.deepStrictEqual(leadzyRequests, []);
});
