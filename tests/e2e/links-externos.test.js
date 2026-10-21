"use strict";

/**
 * Prova de que nenhum link externo escapa.
 *
 * A auditoria estática achou 3 mecanismos que passavam pela guarda:
 *   1. <a href="https://www.leadzy.com.br" target="_blank">
 *   2. <a href="https://www.leadzy.com.br/whatsapp-suporte" target="_blank">
 *   3. <a> criada por JS + .click() -> api.whatsapp.com (suporte)
 *
 * Aqui cada um é reproduzido no navegador real, exatamente como o bundle faz,
 * e o teste FALHA se qualquer requisição ou aba nova sair.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { launch, sleep } = require("../lib/env");

let ctx, id;
let page;
let saidas = [];

function espionar(p) {
  p.on("request", (r) => {
    const u = r.url();
    if (!/^chrome-extension:|^data:|^blob:|^devtools:/.test(u)) {
      saidas.push(["REQ", u.slice(0, 100)]);
    }
  });
  p.on("popup", (novo) => saidas.push(["POPUP", novo.url()]));
  p.on("framenavigated", (f) => {
    const u = f.url();
    if (f === p.mainFrame() && !u.startsWith("chrome-extension://")) {
      saidas.push(["NAV", u.slice(0, 100)]);
    }
  });
}

before(async () => {
  const l = await launch();
  ctx = l.ctx;
  id = l.id;
});

after(async () => {
  if (ctx) await ctx.close();
});

async function novaPagina(rota = "#/dashboard") {
  const p = await ctx.newPage();
  espionar(p);
  await p.goto(`chrome-extension://${id}/options.html${rota}?t=${Date.now()}`, {
    waitUntil: "domcontentloaded",
  });
  await sleep(2400);
  return p;
}

/** Clica via eventos reais do mouse, como um usuário faria. */
async function clicarDeVerdade(p, seletor) {
  const el = p.locator(seletor).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ noWaitAfter: true, force: true }).catch(() => {});
  await sleep(900);
}

test("a guarda de clique está instalada na página", async () => {
  page = await novaPagina();
  const ativo = await page.evaluate(() => window.__LZ_CLICK_GUARD__ === true);
  assert.strictEqual(ativo, true, "guarda de clique não foi instalada");
});

test("clique em <a target=_blank> para leadzy não abre nada", async () => {
  saidas = [];
  page = await novaPagina();

  // injeta exatamente o que o bundle renderiza no modal
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "lz-teste-1";
    a.href = "https://www.leadzy.com.br";
    a.target = "_blank";
    a.textContent = "www.leadzy.com.br";
    document.body.appendChild(a);
  });
  await sleep(300);

  // o observador de suporte remove a âncora antes de qualquer clique
  const existe = await page.evaluate(() => !!document.querySelector("#lz-teste-1"));
  assert.strictEqual(existe, false, "o link de leadzy deveria ter sido removido do DOM");

  assert.deepStrictEqual(saidas, [], `saiu para fora: ${JSON.stringify(saidas)}`);
});

test("clique no link de suporte continua bloqueado mesmo sem o observador", async () => {
  saidas = [];
  page = await novaPagina();

  // desliga a remoção para exercitar só a guarda de clique
  await page.evaluate(() => {
    if (window.__LZ_SUPORTE_OBSERVER__) window.__LZ_SUPORTE_OBSERVER__.disconnect();
  });

  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "lz-teste-2";
    a.href = "https://www.leadzy.com.br/whatsapp-suporte";
    a.target = "_blank";
    a.textContent = "Falar com o suporte";
    document.body.appendChild(a);
  });
  await sleep(400);

  await clicarDeVerdade(page, "#lz-teste-2");

  assert.deepStrictEqual(saidas, [], `saiu para fora: ${JSON.stringify(saidas)}`);

  // aviso local apareceu em vez de navegar
  const aviso = await page.evaluate(() => !!document.querySelector("[data-lz-aviso]"));
  assert.strictEqual(aviso, true, "o aviso local não apareceu");
});

test("âncora de WhatsApp do suporte é removida do DOM", async () => {
  page = await novaPagina();
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "lz-teste-3";
    a.href = "https://api.whatsapp.com/send?phone=5511971907976&text=ajuda";
    document.body.appendChild(a);
  });
  await sleep(500);

  const existe = await page.evaluate(() => !!document.querySelector("#lz-teste-3"));
  assert.strictEqual(existe, false, "link de WhatsApp do suporte deveria ser removido");
});

test("âncora de WhatsApp de CONTATO é preservada (é função do produto)", async () => {
  page = await novaPagina();
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "lz-teste-4";
    a.href = "https://api.whatsapp.com/send?phone=5511999998888&text=oi";
    a.textContent = "abrir conversa";
    document.body.appendChild(a);
  });
  await sleep(600);

  const existe = await page.evaluate(() => !!document.querySelector("#lz-teste-4"));
  assert.strictEqual(existe, true, "a função de abrir conversa não pode ser removida");
});

test("o bloco de rede do manifest está ativo e com a regra carregada", async () => {
  page = await novaPagina();
  const regras = await page.evaluate(() =>
    chrome.declarativeNetRequest.getEnabledRulesets().catch(() => null)
  );
  assert.ok(Array.isArray(regras) && regras.includes("bloqueio-externo"), `rulesets: ${regras}`);
});

test("requisição direta para leadzy é bloqueada pelo Chrome (não só por JS)", async () => {
  page = await novaPagina();

  // usa fetch nativo (bypassando o shim do patch) para provar que a regra
  // declarativa do manifest age na camada de rede
  const resultado = await page.evaluate(async () => {
    const realFetch = window.__LZ_REAL_FETCH__ || fetch;
    try {
      await realFetch("https://app.leadzy.com.br/auth/me");
      return "passou";
    } catch (e) {
      return "bloqueado: " + String(e.message).slice(0, 60);
    }
  });

  assert.strictEqual(
    resultado.startsWith("bloqueado"),
    true,
    `a requisição deveria ter sido bloqueada pelo DNR, veio: ${resultado}`
  );
});

test("nenhuma saída em todas as telas", async () => {
  saidas = [];
  const rotas = ["#/dashboard", "#/messages", "#/scripts", "#/triggers", "#/flows", "#/flows/new"];
  for (const rota of rotas) {
    const p = await novaPagina(rota);
    await sleep(600);
    await p.close();
  }
  assert.deepStrictEqual(saidas, [], `saídas: ${JSON.stringify(saidas)}`);
});
