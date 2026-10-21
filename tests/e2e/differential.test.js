"use strict";

/**
 * Teste diferencial.
 *
 * Prova que o patch muda EXATAMENTE UMA coisa: a necessidade de autenticar e de
 * falar com o servidor. Fora isso, o comportamento da interface é o mesmo do
 * pacote original.
 *
 * Como não dá para ter o servidor da Leadzy respondendo, a extensão original é
 * rodada com as requisições para *.leadzy.com.br ABORTADAS — que é justamente o
 * cenário "sem servidor".
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const fs0 = require("fs");
const path0 = require("path");
const { execFileSync } = require("child_process");

const ORIGINAL = "/tmp/lz-original";

/** Garante que o pacote original esteja extraído; se não, extrai do zip. */
function prepararOriginal() {
  if (fs0.existsSync(path0.join(ORIGINAL, "manifest.json"))) return true;

  const zip = path0.resolve(__dirname, "../../pmw8x6.zip");
  if (!fs0.existsSync(zip)) return false;

  fs0.rmSync(ORIGINAL, { recursive: true, force: true });
  fs0.mkdirSync(ORIGINAL, { recursive: true });
  execFileSync("unzip", ["-qo", zip, "-d", ORIGINAL]);
  return fs0.existsSync(path0.join(ORIGINAL, "manifest.json"));
}

const ME = {
  id: "manual",
  name: "Usuário Manual",
  email: "manual@localhost",
  organizationId: "org",
};

let ok = false;

before(() => {
  ok = prepararOriginal();
  if (!ok) console.warn("  AVISO: pmw8x6.zip ausente — o teste diferencial será pulado");
});

/** Abre a extensão original com a rede da Leadzy bloqueada. */
async function abrirOriginal() {
  const { ctx, id } = await launch({ ext: ORIGINAL });
  const pedidos = [];

  await ctx.route(/leadzy\.com\.br/, (route) => {
    pedidos.push(route.request().url());
    route.abort();
  });

  return { ctx, id, pedidos };
}

test("original: sem token, cai na tela de login", async (t) => {
  assert.ok(ok, "o pacote original precisa estar disponível (pmw8x6.zip)");
  const { ctx, id } = await abrirOriginal();
  try {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.waitForFunction(() => location.hash.includes("login") || (document.body.innerText || "").length > 0, {
      timeout: 25000,
    });
    await sleep(2500);
    assert.match(page.url(), /#\/login/, "original deveria exigir login");
  } finally {
    await ctx.close();
  }
});

test("original: com token manual e sem servidor, o app funciona", async (t) => {
  assert.ok(ok, "o pacote original precisa estar disponível (pmw8x6.zip)");
  const { ctx, id, pedidos } = await abrirOriginal();
  try {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await sleep(2500);

    // o passo que o patch automatiza
    await page.evaluate(
      ([token, me]) =>
        new Promise((r) =>
          chrome.storage.local.set({ access_token: token, me: JSON.stringify(me) }, r)
        ),
      ["token-manual-123456", ME]
    );
    await page.reload();
    await page.waitForFunction(() => location.hash.includes("dashboard"), { timeout: 25000 });
    await sleep(2500);

    const texto = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    assert.match(texto, /Usuário Manual/, "nome semeado não apareceu");
    assert.match(texto, /Dashboard/, "menu não renderizou");

    // e a prova de que o original SEMPRE tentou falar com o servidor
    assert.ok(pedidos.length > 0, "o original deveria ter tentado acessar a Leadzy");
  } finally {
    await ctx.close();
  }
});

test("patch: mesma interface, com zero requisições à Leadzy", async (t) => {
  assert.ok(ok, "o pacote original precisa estar disponível (pmw8x6.zip)");
  const { ctx, id } = await launch();
  const pedidos = [];
  try {
    const page = await ctx.newPage();
    page.on("request", (r) => {
      if (/leadzy\.com\.br/i.test(r.url())) pedidos.push(r.url());
    });

    await page.goto(`chrome-extension://${id}/options.html`);
    await page.waitForFunction(() => !!location.hash, { timeout: 25000 });
    await sleep(3000);

    const texto = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    assert.match(texto, /Dashboard/);
    assert.doesNotMatch(page.url(), /login/);
    assert.deepStrictEqual(pedidos, [], "o patch não pode falar com a Leadzy");
  } finally {
    await ctx.close();
  }
});
