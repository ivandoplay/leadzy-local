"use strict";

/**
 * Prova definitiva de que nada depende da rede.
 *
 * O navegador é iniciado com o DNS de *.leadzy.com.br apontando para uma porta
 * morta. Se qualquer requisição realmente tentasse sair, ela falharia. Como as
 * respostas continuam chegando, está provado que são locais.
 *
 * Também cobre o service worker, que é um contexto separado e não é alcançado
 * pelo patch das páginas.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { launch, sleep } = require("../lib/env");

const API = "https://api-userv2.leadzy.com.br";

let ctx, id, sw;

before(async () => {
  const l = await launch([
    // qualquer tentativa de sair para a Leadzy morre na porta 1
    "--host-resolver-rules=MAP *.leadzy.com.br 127.0.0.1:1, MAP leadzy.com.br 127.0.0.1:1",
    "--dns-prefetch-disable",
  ]);
  ctx = l.ctx;
  id = l.id;
  sw = l.sw;
  await sleep(1500);
});

after(async () => {
  if (ctx) await ctx.close();
});

test("o service worker sobe pela entrada protegida", () => {
  assert.match(sw.url(), /js\/service-worker-local\.js$/);
});

test("o guarda está instalado no service worker", async () => {
  const estado = await sw.evaluate(() => ({
    guard: !!self.__LZ_SW_GUARD__,
    isLeadzy: typeof self.__LZ_SW_IS_LEADZY__,
    fetchPatched: /leadzy|isLeadzy|resposta/.test(String(self.fetch)),
  }));
  assert.strictEqual(estado.guard, true, "guarda ausente no SW");
  assert.strictEqual(estado.isLeadzy, "function");
  assert.strictEqual(estado.fetchPatched, true, "fetch do SW não é o guarda");
});

test("fetch no service worker responde local mesmo com DNS morto", async () => {
  const r = await sw.evaluate(async (api) => {
    const plano = await fetch(`${api}/plan-features/product-lines`).then((x) => x.json());
    const me = await fetch(`${api}/auth/me`).then((x) => x.json());
    const login = await fetch(`${api}/auth/login`, { method: "POST" }).then((x) => x.json());
    const flags = await fetch(`${api}/feature-flags/QUALQUER`).then((x) => x.json());
    return { plano, me, login, flags };
  }, API);

  assert.strictEqual(r.plano.hasChat, true);
  assert.strictEqual(r.me.id, "local-user");
  assert.ok(r.login.access_token.length > 10);
  assert.strictEqual(r.flags.enabled, false);
});

test("fetch na página responde local mesmo com DNS morto", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html#/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await sleep(2000);

  const r = await page.evaluate(async (api) => {
    const plano = await fetch(`${api}/plan-features/product-lines`).then((x) => x.json());
    const me = await fetch(`${api}/auth/me`).then((x) => x.json());
    return { plano, me };
  }, API);

  assert.strictEqual(r.plano.hasChat, true);
  assert.strictEqual(r.me.id, "local-user");
  await page.close();
});

test("a interface carrega e navega com o DNS da Leadzy derrubado", async () => {
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(e.message.slice(0, 120)));

  await page.goto(`chrome-extension://${id}/options.html#/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("O que vamos fazer hoje?"),
    { timeout: 25000 }
  );

  for (const [label, marca] of [
    ["Mensagens", "Biblioteca de mensagens prontas"],
    ["Scripts", "Veja todos seus scripts salvos"],
    ["Gatilhos", "Veja todos seus gatilhos salvos"],
    ["Fluxos", "automações inteligentes"],
  ]) {
    await page.locator("button.lz-nav-tab-btn", { hasText: label }).first().click();
    await page.waitForFunction((t) => (document.body.innerText || "").includes(t), marca, {
      timeout: 20000,
    });
  }

  assert.deepStrictEqual(erros, [], "erros de página com DNS derrubado");
  await page.close();
});

test("as fontes Inter vêm do pacote e são acessíveis de fora", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  const r = await page.evaluate(async (extId) => {
    const url = `chrome-extension://${extId}/fonts/Inter-VariableFont_opsz,wght.cc27cf3f.ttf`;
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return { status: res.status, bytes: buf.byteLength };
  }, id);

  assert.strictEqual(r.status, 200, "fonte não é servida pela extensão");
  assert.ok(r.bytes > 500000, `fonte suspeita: ${r.bytes} bytes`);
  await page.close();
});

test("o store de licença está semeado sem nenhum login", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  const store = await page.evaluate(
    () => new Promise((r) => chrome.storage.local.get(["access_token", "me"], r))
  );
  assert.ok(store.access_token && store.access_token.length > 10);
  assert.strictEqual(JSON.parse(store.me).id, "local-user");
  await page.close();
});
