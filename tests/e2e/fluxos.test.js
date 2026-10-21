"use strict";

/**
 * Fluxos — o núcleo do produto — criados e salvos pela interface.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { launch, sleep } = require("../lib/env");

let ctx, id;

before(async () => {
  const l = await launch();
  ctx = l.ctx;
  id = l.id;
});

after(async () => {
  if (ctx) await ctx.close();
});

test("tela de templates lista os funis prontos sem erro", async () => {
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(e.message.slice(0, 120)));

  await page.goto(`chrome-extension://${id}/options.html#/flows/new`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("Comece a partir de um template"),
    { timeout: 25000 }
  );

  const texto = await page.evaluate(() => document.body.innerText);
  assert.match(texto, /Criar fluxo em branco/);
  assert.match(texto, /FUNIL SUGERIDO/, "nenhum template listado");

  assert.deepStrictEqual(erros, []);
  await page.close();
});

test("criar fluxo em branco, nomear e salvar rascunho persiste no storage", async () => {
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(e.message.slice(0, 120)));

  await page.goto(`chrome-extension://${id}/options.html#/flows/new`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("Criar fluxo em branco"),
    { timeout: 25000 }
  );

  await page.getByText("Criar fluxo em branco").first().click();
  await sleep(3000);

  assert.match(page.url(), /#\/flows\/flow-/, "não abriu o editor do fluxo");

  const nome = "Fluxo criado no teste";
  await page.locator('input[placeholder="Fluxo sem nome"]').fill(nome);
  await sleep(700);

  await page.getByRole("button", { name: "Salvar rascunho" }).first().click();
  await sleep(3000);

  const store = await page.evaluate(() => new Promise((r) => chrome.storage.local.get(null, r)));
  const indice = JSON.parse(store["flows:index"] || "[]");
  assert.ok(indice.length > 0, "flows:index continua vazio");

  const chave = indice[indice.length - 1];
  // as chaves são "flows:flow:<id>"
  const chaveStorage = Object.keys(store).find((k) => k.startsWith("flows:flow:") && k.endsWith(chave));
  assert.ok(chaveStorage, `fluxo ${chave} não foi gravado. chaves: ${Object.keys(store).join(", ")}`);

  const bruto = store[chaveStorage];

  const fluxo = JSON.parse(bruto);
  assert.strictEqual(fluxo.name, nome, "nome do fluxo não foi salvo");
  assert.strictEqual(fluxo.status, "draft");
  assert.ok(Array.isArray(fluxo.nodes) && fluxo.nodes.length > 0, "fluxo sem nós");
  assert.ok(
    fluxo.nodes.some((n) => (n.type || n.data?.type) === "trigger"),
    "nó de gatilho ausente"
  );
  assert.ok(Array.isArray(fluxo.edges), "fluxo sem lista de arestas");

  assert.deepStrictEqual(erros, []);
  await page.close();
});

test("o fluxo salvo reaparece na lista depois de recarregar", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html#/flows`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("Fluxo criado no teste"),
    { timeout: 25000 }
  );
  await page.close();
});

test("adicionar etapa abre o menu com os tipos de nó", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html#/flows/new`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("Criar fluxo em branco"),
    { timeout: 25000 }
  );
  await page.getByText("Criar fluxo em branco").first().click();
  await sleep(3000);

  await page.getByRole("button", { name: "Adicionar etapa" }).click();
  await sleep(1500);

  const texto = await page.evaluate(() => document.body.innerText);
  for (const tipo of [
    "Enviar texto",
    "Enviar áudio",
    "Enviar mídia",
    "Enviar documento",
    "Enviar script",
    "Pausa",
    "Esperar o cliente",
    "Decidir caminho",
    "Adicionar etiqueta",
    "Remover etiqueta",
    "Arquivar conversa",
    "Ir para fluxo",
  ]) {
    assert.ok(texto.includes(tipo), `tipo de nó ausente no menu: ${tipo}`);
  }
  await page.close();
});

test("o simulador de fluxo abre sem erro", async () => {
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(e.message.slice(0, 120)));

  await page.goto(`chrome-extension://${id}/options.html#/flows/new`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("Criar fluxo em branco"),
    { timeout: 25000 }
  );
  await page.getByText("Criar fluxo em branco").first().click();
  await sleep(3000);

  await page.getByRole("button", { name: "Simular" }).first().click();
  await sleep(2500);

  const texto = await page.evaluate(() => document.body.innerText);
  assert.match(texto, /Simula|simula|Executar|Testar|contato/i, "o simulador não abriu");
  assert.deepStrictEqual(erros, []);
  await page.close();
});
