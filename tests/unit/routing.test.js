"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { routeMock, isLeadzyUrl, CONFIG } = require("../../extensao/js/local-bootstrap.js");

const API = "https://api-userv2.leadzy.com.br";
const AUDIO = "https://audio-converter.leadzy.com.br";

function body(res) {
  return JSON.parse(res.body);
}

test("detecção de host: só os domínios da Leadzy", () => {
  const sim = [
    `${API}/auth/me`,
    `${AUDIO}/convert`,
    "https://app.leadzy.com.br/dashboard",
    "https://bucket.leadzy.com.br/a.png",
    "https://leadzy.com.br/#planos",
    "https://www.leadzy.com.br/x",
    "http://api-userv2.leadzy.com.br/x",
  ];
  for (const u of sim) assert.ok(isLeadzyUrl(u), `deveria interceptar: ${u}`);

  const nao = [
    "https://evil.com/leadzy.com.br",
    "https://leadzy.com.br.evil.com/x",
    "https://notleadzy.com.br/x",
    "https://web.whatsapp.com/x",
    "https://api.whatsapp.com/send",
    "",
    null,
    undefined,
    "about:blank",
  ];
  for (const u of nao) assert.ok(!isLeadzyUrl(u), `NÃO deveria interceptar: ${u}`);
});

test("auth: login, me e logout", () => {
  const login = routeMock(`${API}/auth/login`, "POST", null);
  assert.strictEqual(login.status, 200);
  assert.strictEqual(body(login).access_token, CONFIG.token);

  const me = routeMock(`${API}/auth/me`, "GET", null);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(body(me).id, CONFIG.user.id);
  assert.ok(body(me).name.length > 0);

  const out = routeMock(`${API}/auth/logout`, "POST", null);
  assert.strictEqual(body(out).success, true);
});

test("plano libera CHAT e mantém CRM desligado", () => {
  const r = routeMock(`${API}/plan-features/product-lines`, "GET", null);
  const p = body(r);
  assert.strictEqual(p.hasChat, true);
  assert.strictEqual(p.hasCrm, false);
  assert.ok(Array.isArray(p.activeProducts));
});

test("assinatura ativa e distante do vencimento", () => {
  const r = routeMock(`${API}/subscriptions/active`, "GET", null);
  const subs = body(r);
  assert.ok(Array.isArray(subs) && subs.length > 0);
  assert.strictEqual(subs[0].status, "ACTIVE");
  assert.ok(new Date(subs[0].expiresAt).getFullYear() > 2090);
});

test("killswitches sempre desligados, anúncios sempre vazios", () => {
  for (const key of ["KILLSWITCH_EXTENSION_COLLECT_METRICS", "KILLSWITCH_EXTENSION_ANNOUNCEMENTS", "X"]) {
    const r = routeMock(`${API}/feature-flags/${key}`, "GET", null);
    assert.strictEqual(body(r).enabled, false);
  }
  const a = routeMock(`${API}/announcements/active?environment=production`, "GET", null);
  assert.deepStrictEqual(body(a), []);
});

test("rotas desconhecidas dos hosts deles não vazam para a rede", () => {
  // O conteúdo é irrelevante: o que importa é que nada saia para a internet.
  // A resposta agora é 501 explícito, nunca um falso sucesso.
  // "/notifications/abc/read" fica de fora: é rota mapeada de verdade
  ["/tags?search=x", "/settings/team", "/flows/123"].forEach((rota) => {
    const r = routeMock(`${API}${rota}`, "GET", null);
    assert.ok(r, `${rota} deveria ser interceptada`);
    assert.strictEqual(JSON.parse(r.body).success, false, `${rota} não pode simular sucesso`);
  });
});

test("rota mapeada continua respondendo normalmente", () => {
  // marcar notificação como lida é implementado localmente, então devolve ok
  const r = routeMock(`${API}/notifications/abc/read`, "PATCH", null);
  assert.strictEqual(JSON.parse(r.body).success, true);
  assert.strictEqual(r.status, 200);
});

test("toda resposta é JSON e nada devolve 401/500 do servidor real", () => {
  const caminhos = [
    ["/auth/me", "GET"],
    ["/auth/login", "POST"],
    ["/plan-features/product-lines", "GET"],
    ["/subscriptions/active", "GET"],
    ["/feature-flags/x", "GET"],
    ["/announcements/active", "GET"],
    ["/rota/inexistente", "GET"],
    ["/rota/inexistente", "POST"],
  ];
  for (const [p, m] of caminhos) {
    const r = routeMock(API + p, m, null);
    assert.ok(r.status === 200 || r.status === 501, `${m} ${p} respondeu ${r.status}`);
    if (r.body) assert.doesNotThrow(() => JSON.parse(r.body), `${m} ${p} não é JSON`);
    // 401 seria o servidor pedindo token; 500 seria erro dele
    assert.notStrictEqual(r.status, 401);
    assert.notStrictEqual(r.status, 500);
  }
});
