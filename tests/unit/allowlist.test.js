"use strict";

/**
 * Allowlist de navegação.
 *
 * Depois da auditoria estática, a regra passou a ser de allowlist: só
 * chrome-extension:, web.whatsapp.com e api.whatsapp.com/send (para telefone
 * de contato) podem ser abertos. Todo o resto é bloqueado.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

/* ---------------------------------------------------------------------------
 * Ambiente mínimo. O módulo se protege com typeof, então basta o necessário.
 * ------------------------------------------------------------------------- */

global.window = {
  location: { protocol: "chrome-extension:", href: "chrome-extension://abc/options.html", hash: "" },
  addEventListener() {},
  requestAnimationFrame(f) {
    setImmediate(f);
  },
  open() {
    throw new Error("window.open real não deveria ser chamado neste teste");
  },
};
global.location = global.window.location;
global.requestAnimationFrame = global.window.requestAnimationFrame;
global.URL = URL;

const MOD = require.resolve("../../extensao/js/local-bootstrap.js");
const lz = require(MOD);

const permitida = lz.urlPermitida;
const bloqueia = lz.deveBloquear;

/* ---------------------------------------------------------------------------
 * O que DEVE passar
 * ------------------------------------------------------------------------- */

test("aceita páginas internas da extensão", () => {
  for (const u of [
    "chrome-extension://abc/options.html#/dashboard",
    "chrome-extension://abc/popup.html",
    "about:blank",
    "data:text/plain,oi",
    "blob:chrome-extension://abc/123",
    "javascript:void(0)",
  ]) {
    assert.strictEqual(permitida(u), true, `deveria permitir: ${u}`);
  }
});

test("aceita links vazios e âncoras internas (navegação da SPA)", () => {
  for (const u of ["", null, undefined, "#", "#/messages", "#/flows/new"]) {
    assert.strictEqual(permitida(u), true, `deveria permitir: ${String(u)}`);
    assert.strictEqual(bloqueia(u), false);
  }
});

test("aceita o WhatsApp Web (é o produto)", () => {
  assert.strictEqual(permitida("https://web.whatsapp.com"), true);
  assert.strictEqual(permitida("https://web.whatsapp.com/"), true);
  assert.strictEqual(bloqueia("https://web.whatsapp.com/"), false);
});

test("aceita abrir conversa de um contato (função real do produto)", () => {
  const contato = "https://api.whatsapp.com/send?phone=5511999998888&text=oi";
  assert.strictEqual(permitida(contato), true, "conversa de contato precisa continuar funcionando");
  assert.strictEqual(bloqueia(contato), false);

  // variações reais usadas pelo bundle
  assert.strictEqual(permitida("https://api.whatsapp.com/send?phone=5511999998888&text=%20"), true);
  assert.strictEqual(permitida("https://api.whatsapp.com/send?phone=5511999998888"), true);
});

/* ---------------------------------------------------------------------------
 * O que DEVE ser bloqueado — os 3 vazamentos encontrados na auditoria
 * ------------------------------------------------------------------------- */

test("bloqueia as duas âncoras de leadzy (target=_blank)", () => {
  for (const u of [
    "https://www.leadzy.com.br",
    "https://www.leadzy.com.br/whatsapp-suporte",
    "https://leadzy.com.br/instalacao-tutorial",
    "https://leadzy.com.br/#planos",
    "https://app.leadzy.com.br/deals",
    "https://bucket.leadzy.com.br/announcement-images/x.png",
    "https://api-userv2.leadzy.com.br/auth/me",
  ]) {
    assert.strictEqual(permitida(u), false, `deveria bloquear: ${u}`);
    assert.strictEqual(bloqueia(u), true);
  }
});

test("bloqueia link de WhatsApp para o número do suporte da Leadzy", () => {
  const suporte = "https://api.whatsapp.com/send?phone=5511971907976&text=ajuda";
  assert.strictEqual(permitida(suporte), false, "suporte não é função do produto");
  assert.strictEqual(bloqueia(suporte), true);
  assert.deepStrictEqual(lz.SUPORTE_WHATSAPP, ["5511971907976"]);
});

test("bloqueia domínios que não estão na allowlist", () => {
  for (const u of [
    "https://evil.example.com",
    "http://localhost:3000",
    "https://google.com",
    "https://web.whatsapp.com.evil.com", // sufixo disfarçado
    "https://api.whatsapp.com/outra-coisa",
    "https://cdn.whatsapp.net/x.jpg",
  ]) {
    assert.strictEqual(permitida(u), false, `deveria bloquear: ${u}`);
  }
});

test("não confunde subdomínio falso com o host permitido", () => {
  assert.strictEqual(permitida("https://web.whatsapp.com.evil.com"), false);
  assert.strictEqual(permitida("https://x.web.whatsapp.com"), false, "só o host exato");
});

test("URL relativa é resolvida contra a página antes de decidir", () => {
  // relativo resolve para chrome-extension:// -> permitido
  assert.strictEqual(permitida("/options.html#/messages"), true);

  // protocolo-relativo numa página chrome-extension: resolve para
  // chrome-extension://leadzy.com.br/x, que não é um id de extensão válido:
  // não vira uma requisição https. O que importa é não sair para a rede.
  const resolvido = lz.resolverUrl("//leadzy.com.br/x");
  assert.ok(
    resolvido.startsWith("chrome-extension://"),
    `não deveria virar http(s): ${resolvido}`
  );
  assert.strictEqual(/^https?:/.test(resolvido), false);
});

test("URL malformada é bloqueada (falha fechada)", () => {
  assert.strictEqual(permitida("https://"), false);
});

test("resolverUrl devolve string vazia para âncoras internas", () => {
  assert.strictEqual(lz.resolverUrl("#/dashboard"), "");
  assert.strictEqual(lz.resolverUrl(""), "");
  assert.strictEqual(lz.resolverUrl(null), "");
});

/* ---------------------------------------------------------------------------
 * Cobertura de rotas: nenhuma rota conhecida pode cair no fallback genérico.
 * A lista abaixo é o inventário estático extraído dos bundles.
 * ------------------------------------------------------------------------- */

const INVENTARIO = [
  // usadas em execução (ver tests/auditoria-rotas.json)
  "GET /announcements/active",
  "GET /auth/me",
  "GET /notifications",
  "GET /plan-features/product-lines",
  "GET /subscriptions/active",
  "GET /subscriptions",
  "GET /feature-flags/release_extension_flows",
  "GET /feature-flags/killswitch_extension_trigger",
  // infraestrutura
  "POST /auth/login",
  "GET /auth/logout",
  "GET /health",
  "PATCH /notifications/abc/read",
  // CRM desativado (hasCrm: false)
  "GET /deals",
  "GET /deals/1",
  "POST /deals/1/change-stage",
  "GET /contacts",
  "POST /contacts/search",
  "GET /contacts/1/profile-photo",
  "GET /tickets",
  "POST /tickets/1/notes",
  "GET /tasks",
  "GET /pipelines/1",
  "GET /products",
  "GET /remarketing-logs",
  "POST /remarketing-logs/1/pause",
  "GET /connected-numbers",
  "GET /settings/team",
  "GET /settings/personal",
  "GET /trial/check-crm-eligibility",
];

function chamar(metodo, rota) {
  global.window.__LZ_ROUTE_LOG__ = [];
  const r = lz.routeMock("https://api-userv2.leadzy.com.br" + rota, metodo, null);
  const ultimo = global.window.__LZ_ROUTE_LOG__[global.window.__LZ_ROUTE_LOG__.length - 1];
  return { resposta: r, origem: ultimo && ultimo.origem };
}

test("nenhuma rota do inventário cai no fallback genérico", () => {
  const gaps = [];
  for (const item of INVENTARIO) {
    const [metodo, rota] = item.split(" ");
    const { origem } = chamar(metodo, rota);
    if (origem !== "mock") gaps.push(item);
  }
  assert.deepStrictEqual(gaps, [], `rotas sem tratamento explícito:\n${gaps.join("\n")}`);
});

test("rota desconhecida ainda é respondida (app não trava) mas fica marcada", () => {
  const { origem } = chamar("GET", "/rota-que-nao-existe/abc");
  assert.strictEqual(origem, "fallback", "rota desconhecida deve ser registrada como fallback");
});

const corpo = (metodo, rota) => JSON.parse(chamar(metodo, rota).resposta.body);

test("/health responde 200 para o conversor local ser usado", () => {
  const { resposta } = chamar("GET", "/health");
  assert.strictEqual(resposta.status, 200);
  assert.strictEqual(corpo("GET", "/health").status, "ok");
});

test("/notifications devolve lista vazia (não há servidor de notificações)", () => {
  assert.deepStrictEqual(corpo("GET", "/notifications"), []);
});

test("rotas do CRM são declaradas indisponíveis, não simuladas", () => {
  // Antes esta rota respondia [] e {success:true}: parecia ter funcionado.
  // Agora responde 501 com marcação explícita — quem chamar sabe que não existe.
  ["GET", "POST"].forEach((m) => {
    const c = corpo(m, "/deals");
    assert.strictEqual(c.success, false, `${m} /deals não pode dizer que deu certo`);
    assert.strictEqual(c.local, true);
    assert.strictEqual(c.desativada, true);
    assert.strictEqual(c.rota, "/deals");
  });

  assert.strictEqual(corpo("GET", "/contacts").success, false);
  assert.strictEqual(corpo("GET", "/settings/team").success, false);
});
