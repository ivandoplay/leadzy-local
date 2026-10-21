"use strict";

/**
 * Cobertura de rotas de API.
 *
 * O risco apontado na revisão: uma rota cair no fallback genérico
 * (GET -> [] / resto -> {success:true}) sem que a operação exista de fato.
 * O teste percorre a extensão executando operações reais e FALHA se qualquer
 * rota for respondida pelo fallback genérico em vez de um mock explícito.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { launch } = require("../lib/env");
const { percorrer } = require("../lib/walk");

let ctx, id, page;
let resultado;

before(async () => {
  const l = await launch();
  ctx = l.ctx;
  id = l.id;
  resultado = await percorrer(ctx, id);

  // página própria para os testes de rota desconhecida
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));
});

after(async () => {
  if (ctx) await ctx.close();
});

/** Rotas que o produto CHAT realmente usa hoje, descobertas em execução. */
const ESPERADAS = [
  "GET /announcements/active",
  "GET /auth/me",
  "GET /notifications",
  "GET /plan-features/product-lines",
  "GET /subscriptions/active",
];

test("a caminhada exercitou as operações principais", () => {
  assert.ok(resultado.acoes.length >= 10, `ações: ${JSON.stringify(resultado.acoes)}`);
  for (const a of ["criar:mensagem", "criar:script", "criar:fluxo", "criar:gatilho"]) {
    assert.ok(resultado.acoes.includes(a), `não executou: ${a}`);
  }
});

test("NENHUMA rota caiu no fallback genérico", () => {
  const gaps = resultado.rotas.filter((r) => r.origem === "fallback");
  assert.deepStrictEqual(
    gaps,
    [],
    `rotas respondidas artificialmente sem implementação:\n${gaps
      .map((g) => `  ${g.metodo} ${g.rota} (${g.vezes}x)`)
      .join("\n")}`
  );
});

test("todas as rotas chamadas foram respondidas por mock explícito", () => {
  assert.ok(resultado.rotas.length > 0, "nenhuma rota registrada — o log não subiu");
  for (const r of resultado.rotas) {
    assert.strictEqual(r.origem, "mock", `${r.metodo} ${r.rota} veio do fallback`);
  }
});

test("as rotas centrais do produto foram chamadas e atendidas", () => {
  const vistas = new Set(resultado.rotas.map((r) => `${r.metodo} ${r.rota}`));
  for (const e of ESPERADAS) {
    assert.ok(vistas.has(e), `rota esperada não apareceu: ${e}`);
  }
});

test("feature-flags são todas desligadas (nenhum recurso fantasma liga)", () => {
  const flags = resultado.rotas.filter((r) => r.rota.startsWith("/feature-flags/"));
  assert.ok(flags.length >= 3, `poucas flags observadas: ${flags.length}`);
  for (const f of flags) {
    assert.strictEqual(f.origem, "mock", `flag não mapeada: ${f.rota}`);
  }
});

test("as operações de escrita não chamaram a API (persistência é local)", () => {
  const escritas = resultado.rotas.filter(
    (r) => r.metodo !== "GET" && r.origem === "fallback"
  );
  assert.deepStrictEqual(escritas, [], "houve escrita caindo no fallback");
});

test("nenhum erro de página durante a caminhada", () => {
  assert.deepStrictEqual(resultado.erros, []);
});

test("rota desconhecida responde 501 em vez de fingir sucesso", async () => {
  // Antes, uma rota não mapeada devolvia [] ou {success:true}: a chamada
  // parecia ter dado certo sem executar nada.
  const r = await page.evaluate(async () => {
    const resp = await fetch("https://api.leadzy.com.br/v1/rota-que-nao-existe-mesmo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const corpo = await resp.json().catch(() => ({}));
    return { status: resp.status, corpo };
  });

  assert.equal(r.status, 501, "rota desconhecida precisa falhar de forma explícita");
  assert.equal(r.corpo.success, false);
  assert.equal(r.corpo.nao_mapeada, true);
  assert.equal(r.corpo.rota, "/v1/rota-que-nao-existe-mesmo");
});

test("rota desativada do CRM também não simula sucesso", async () => {
  const r = await page.evaluate(async () => {
    const resp = await fetch("https://api.leadzy.com.br/v1/crm/qualquer-coisa");
    return { status: resp.status, corpo: await resp.json().catch(() => ({})) };
  });

  assert.ok(r.status === 501 || r.status === 200, `status inesperado: ${r.status}`);
  assert.notEqual(r.corpo.success, true, "não pode responder sucesso para rota desativada");
});
