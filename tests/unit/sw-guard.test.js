"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert");

const MODULO = require.resolve("../../extensao/js/sw-guard.js");

function carregar() {
  delete require.cache[MODULO];
  delete global.self;
  global.self = { fetch: async (u) => new Response("SAIU_PARA_A_REDE:" + u, { status: 200 }) };
  require(MODULO);
  return global.self;
}

before(() => carregar());
after(() => {
  delete global.self;
});

test("instala a flag e o detector de host", () => {
  const s = carregar();
  assert.strictEqual(s.__LZ_SW_GUARD__, true);
  assert.strictEqual(s.__LZ_SW_IS_LEADZY__("https://api-userv2.leadzy.com.br/x"), true);
  assert.strictEqual(s.__LZ_SW_IS_LEADZY__("https://leadzy.com.br.evil.com/x"), false);
  assert.strictEqual(s.__LZ_SW_IS_LEADZY__("https://web.whatsapp.com"), false);
});

test("não intercepta host externo", async () => {
  const s = carregar();
  const r = await s.fetch("https://exemplo.com/x");
  assert.match(await r.text(), /SAIU_PARA_A_REDE/);
});

test("responde as rotas da API localmente", async () => {
  const s = carregar();
  const caso = async (p, init) => (await s.fetch("https://api-userv2.leadzy.com.br" + p, init)).json();

  assert.strictEqual((await caso("/plan-features/product-lines")).hasChat, true);
  assert.strictEqual((await caso("/auth/me")).id, "local-user");
  assert.ok((await caso("/auth/login", { method: "POST" })).access_token.length > 10);
  assert.strictEqual((await caso("/feature-flags/x")).enabled, false);
  assert.deepStrictEqual(await caso("/announcements/active"), []);
  assert.deepStrictEqual(await caso("/rota/desconhecida"), []);
});

test("/convert no SW devolve 501 (não sai para a rede)", async () => {
  const s = carregar();
  const r = await s.fetch("https://audio-converter.leadzy.com.br/convert", { method: "POST" });
  assert.strictEqual(r.status, 501);
});

test("carregar duas vezes não re-embrulha", () => {
  const s = carregar();
  const primeiro = s.fetch;
  require(MODULO);
  assert.strictEqual(global.self.fetch, primeiro);
});
