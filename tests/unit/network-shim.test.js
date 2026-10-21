"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const MODULE = require.resolve("../../extensao/js/local-bootstrap.js");
const FIX = path.resolve(__dirname, "../fixtures");

/* ---------------------------------------------------------------------------
 * Ambiente simulado: window/location/chrome mínimos para exercitar os shims
 * fora do navegador.
 * ------------------------------------------------------------------------- */

let seeded = null;
let realXHRSent = [];

class FakeRealXHR {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    FakeRealXHR.instances.push(this);
  }
  open(m, u) {
    this._m = m;
    this._u = u;
    this.readyState = 1;
  }
  setRequestHeader(k, v) {
    (this._h = this._h || {})[k] = v;
  }
  getAllResponseHeaders() {
    return "x-real: 1\r\n";
  }
  send(b) {
    realXHRSent.push({ url: this._u, body: b });
  }
  abort() {}
}
FakeRealXHR.instances = [];

const fetchCalls = [];
async function fakeFetch(url) {
  fetchCalls.push(url);
  return new Response("REAL", { status: 200 });
}

/* DOM mínimo para o aviso na tela */
function fakeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: { cssText: "", opacity: "" },
    attrs: {},
    textContent: "",
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    appendChild(c) {
      this.children.push(c);
      fakeDocument._filhos.push(c);
      return c;
    },
    remove() {
      fakeDocument._filhos = fakeDocument._filhos.filter((x) => x !== this);
    },
  };
}

const fakeDocument = {
  _filhos: [],
  body: { appendChild(el) { fakeDocument._filhos.push(el); return el; } },
  createElement(tag) {
    return fakeElement(tag);
  },
  querySelector(sel) {
    if (sel === "[data-lz-aviso]") {
      return fakeDocument._filhos.find((e) => e.attrs && e.attrs["data-lz-aviso"]) || null;
    }
    return null;
  },
};

function installEnv() {
  fakeDocument._filhos = [];
  global.document = fakeDocument;
  global.requestAnimationFrame = (fn) => fn();
  global.window = { fetch: fakeFetch, XMLHttpRequest: FakeRealXHR, open: () => "REAL_OPEN" };
  global.location = {
    protocol: "chrome-extension:",
    href: "chrome-extension://abc/popup.html#/",
    hash: "#/",
    pathname: "/popup.html",
    replace() {},
  };
  global.chrome = {
    storage: {
      local: {
        set(patch, cb) {
          seeded = Object.assign(seeded || {}, patch);
          if (cb) cb();
        },
        get(keys, cb) {
          cb(seeded || {});
        },
      },
    },
    runtime: {},
  };
}

function freshLoad() {
  delete require.cache[MODULE];
  delete global.window;
  installEnv();
  return require(MODULE);
}

before(installEnv);
after(() => {
  delete global.document;
  delete global.requestAnimationFrame;
  delete global.window;
  delete global.location;
  delete global.chrome;
});

const API = "https://api-userv2.leadzy.com.br";
const AUDIO = "https://audio-converter.leadzy.com.br";

function xhrCall(XHR, method, url, { responseType, body } = {}) {
  return new Promise((resolve) => {
    const x = new XHR();
    x.open(method, url, true);
    if (responseType) x.responseType = responseType;
    x.addEventListener("loadend", () =>
      resolve({
        status: x.status,
        response: x.response,
        responseText: x.responseText,
        headers: x.getAllResponseHeaders(),
      })
    );
    x.send(body || null);
  });
}

test("semeia access_token e me no storage", () => {
  seeded = null;
  freshLoad();
  return new Promise((r) =>
    setTimeout(() => {
      assert.ok(seeded, "nada foi semeado");
      assert.ok(seeded.access_token && seeded.access_token.length > 10);
      assert.strictEqual(typeof seeded.me, "string");
      assert.strictEqual(JSON.parse(seeded.me).id, "local-user");
      r();
    }, 50)
  );
});

test("carregar o módulo duas vezes não duplica o patch", () => {
  const lib = freshLoad();
  const primeiraXHR = window.XMLHttpRequest;
  // segunda carga no MESMO window
  delete require.cache[MODULE];
  require(MODULE);
  assert.strictEqual(window.XMLHttpRequest, primeiraXHR, "não deveria re-embrulhar");
  assert.strictEqual(typeof lib.routeMock, "function");
});

test("não lança exceção quando chrome.storage não existe", () => {
  delete require.cache[MODULE];
  global.window = { fetch: fakeFetch, XMLHttpRequest: FakeRealXHR };
  global.location = { protocol: "https:", href: "https://x/", hash: "", pathname: "/", replace() {} };
  global.chrome = undefined;
  assert.doesNotThrow(() => require(MODULE));
});

test("XHR: /auth/me com responseType json", async () => {
  freshLoad();
  const r = await xhrCall(window.XMLHttpRequest, "GET", `${API}/auth/me`, { responseType: "json" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.response.name, "Usuário Local");
});

test("XHR: plano com responseType text", async () => {
  freshLoad();
  const r = await xhrCall(window.XMLHttpRequest, "GET", `${API}/plan-features/product-lines`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.responseText).hasChat, true);
});

test("XHR: headers de resposta expostos ao axios", async () => {
  freshLoad();
  const r = await xhrCall(window.XMLHttpRequest, "GET", `${API}/auth/me`, { responseType: "json" });
  assert.match(r.headers, /content-type: application\/json/i);
});

test("XHR: /convert com responseType blob devolve Ogg válido", async () => {
  freshLoad();
  const webm = fs.readFileSync(path.join(FIX, "mono.webm"));
  const fd = new FormData();
  fd.append("audio", new Blob([webm], { type: "audio/webm;codecs=opus" }), "a.webm");

  const r = await xhrCall(window.XMLHttpRequest, "POST", `${AUDIO}/convert`, {
    responseType: "blob",
    body: fd,
  });

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.response.type, "audio/ogg");
  const bytes = new Uint8Array(await r.response.arrayBuffer());
  const ogg = require("../lib/ogg");
  const v = ogg.validateOgg(bytes);
  assert.strictEqual(v.head.channels, 1);
  assert.ok(v.audio.length > 10);
});

test("XHR: requisição para host externo vai para o XHR real", async () => {
  freshLoad();
  realXHRSent = [];
  const x = new window.XMLHttpRequest();
  x.open("GET", "https://exemplo.com/api", true);
  x.send(null);
  assert.strictEqual(realXHRSent.length, 1);
  assert.strictEqual(realXHRSent[0].url, "https://exemplo.com/api");
});

test("fetch: intercepta host da Leadzy", async () => {
  freshLoad();
  const res = await window.fetch(`${API}/auth/me`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).id, "local-user");
});

test("fetch: host externo continua indo para o fetch real", async () => {
  freshLoad();
  fetchCalls.length = 0;
  const res = await window.fetch("https://exemplo.com/x");
  assert.strictEqual(await res.text(), "REAL");
  assert.deepStrictEqual(fetchCalls, ["https://exemplo.com/x"]);
});

test("fetch: /convert devolve blob audio/ogg", async () => {
  freshLoad();
  const webm = fs.readFileSync(path.join(FIX, "live.webm"));
  const fd = new FormData();
  fd.append("audio", new Blob([webm], { type: "audio/webm;codecs=opus" }), "a.webm");
  const res = await window.fetch(`${AUDIO}/convert`, { method: "POST", body: fd });
  assert.strictEqual(res.status, 200);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.strictEqual(String.fromCharCode(...buf.slice(0, 4)), "OggS");
});

test("método e corpo chegam ao roteador (POST não vira GET)", async () => {
  const lib = freshLoad();
  const r = lib.routeMock(`${API}/auth/login`, "POST", null);
  assert.strictEqual(JSON.parse(r.body).access_token, lib.CONFIG.token);
});

/* ==========================================================================
 * Bloqueio de navegação externa (CRM, planos, suporte)
 * ======================================================================== */

test("bloqueia window.open para o painel da Leadzy e avisa na tela", () => {
  freshLoad();
  const abriu = window.open("https://app.leadzy.com.br/deals");
  assert.strictEqual(abriu, null, "não deveria abrir");

  const aviso = document.querySelector("[data-lz-aviso]");
  assert.ok(aviso, "nenhum aviso foi mostrado");
  assert.match(aviso.textContent, /painel online/i);
});

test("não bloqueia window.open para o WhatsApp", () => {
  freshLoad();
  const antes = window.open("https://web.whatsapp.com/");
  // o window.open fake do ambiente devolve undefined; o importante é não gerar aviso
  assert.strictEqual(document.querySelector("[data-lz-aviso]"), null);
});

test("agora bloqueia QUALQUER domínio fora da allowlist (era o furo)", () => {
  // Antes: só *.leadzy.com.br era barrado; exemplo.com passava.
  // Depois da auditoria a regra é allowlist, então domínio qualquer é barrado.
  freshLoad();
  window.open("https://exemplo.com/x");
  assert.ok(document.querySelector("[data-lz-aviso]"), "deveria ter avisado");
});

test("bloquearNavegacaoExterna cobre os domínios do produto", () => {
  const lib = freshLoad();
  for (const u of [
    "https://app.leadzy.com.br/deals",
    "https://app.leadzy.com.br/settings/team",
    "https://app.leadzy.com.br/purchase?upgrade=chat",
    "https://leadzy.com.br/#planos",
    "https://leadzy.com.br/instalacao-tutorial",
  ]) {
    assert.strictEqual(lib.bloquearNavegacaoExterna(u), true, `deveria bloquear ${u}`);
  }
  assert.strictEqual(lib.bloquearNavegacaoExterna("https://web.whatsapp.com/"), false);
  // fora da allowlist -> bloqueado
  assert.strictEqual(lib.bloquearNavegacaoExterna("https://exemplo.com/"), true);
  // âncora interna da SPA -> liberada
  assert.strictEqual(lib.bloquearNavegacaoExterna("#/messages"), false);
});
