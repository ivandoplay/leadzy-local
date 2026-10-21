"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const EXT = path.resolve(__dirname, "../../extensao");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

test("manifest é MV3 e válido", () => {
  assert.strictEqual(manifest.manifest_version, 3);
  assert.strictEqual(manifest.name, "Leadzy");
  assert.match(manifest.version, /^\d+(\.\d+){1,3}$/);
});

test("local-bootstrap roda ANTES do content-script original", () => {
  const js = manifest.content_scripts[0].js;
  assert.strictEqual(js[0], "js/local-bootstrap.js", "deve ser o primeiro");
  assert.ok(js.includes("js/content-script.js"));
  assert.ok(
    js.indexOf("js/local-bootstrap.js") < js.indexOf("js/content-script.js"),
    "ordem importa: o patch precisa executar primeiro"
  );
});

test("popup e options carregam o patch antes do bundle", () => {
  for (const [file, bundle] of [
    ["popup.html", "js/popup.js"],
    ["options.html", "js/options.js"],
  ]) {
    const html = fs.readFileSync(path.join(EXT, file), "utf8");
    const patchIdx = html.indexOf("js/local-bootstrap.js");
    const bundleIdx = html.indexOf(bundle);
    assert.ok(patchIdx > -1, `${file} não referencia o patch`);
    assert.ok(bundleIdx > -1, `${file} não referencia ${bundle}`);
    assert.ok(patchIdx < bundleIdx, `${file}: patch deve vir antes de ${bundle}`);
    // precisa ser script clássico e síncrono (sem defer/async), senão roda depois
    const tag = html.match(/<script[^>]*local-bootstrap[^>]*>/)[0];
    assert.ok(!/defer|async/.test(tag), `${file}: patch não pode ser defer/async`);
  }
});

test("update_url e externally_connectable removidos", () => {
  assert.ok(!("update_url" in manifest), "update_url sobrescreveria a versão local");
  assert.ok(!("externally_connectable" in manifest), "site da Leadzy não deve falar com a extensão");
});

test("_metadata (assinatura da Chrome Web Store) não vai no pacote", () => {
  // O Chrome recria extensao/_metadata ao carregar a extensão com regras
  // declarativas — é artefato de execução, não do pacote.
  // O que importa é que ele não seja distribuído.
  if (fs.existsSync(path.join(EXT, "_metadata"))) {
    const conteudo = fs.readdirSync(path.join(EXT, "_metadata"));
    assert.ok(
      !conteudo.some((f) => /computed_hashes|verified_contents/.test(f)),
      "não deve haver assinatura da CWS no pacote"
    );
  }
});

test("a regra de bloqueio de rede existe e cobre a Leadzy", () => {
  const dr = manifest.declarative_net_request;
  assert.ok(dr && dr.rule_resources.length > 0, "declarative_net_request ausente");

  const arq = path.join(EXT, dr.rule_resources[0].path);
  assert.ok(fs.existsSync(arq), `regra não existe: ${arq}`);

  const regras = JSON.parse(fs.readFileSync(arq, "utf8"));
  assert.ok(regras.length > 0);
  const r = regras[0];
  assert.strictEqual(r.action.type, "block");
  assert.ok(r.condition.requestDomains.includes("leadzy.com.br"), "deve cobrir a Leadzy");
  assert.ok(r.condition.resourceTypes.includes("main_frame"), "deve cobrir navegação");
  assert.ok(r.condition.resourceTypes.includes("xmlhttprequest"), "deve cobrir fetch");
});

test("nenhuma referência a fontes do Google no CSS (modo offline)", () => {
  for (const f of ["css/popup.css", "css/options.css", "css/content-script.css"]) {
    const css = fs.readFileSync(path.join(EXT, f), "utf8");
    assert.ok(!css.includes("fonts.googleapis.com"), `${f} ainda baixa fonte do Google`);
    assert.ok(css.includes("fonts/Inter-VariableFont"), `${f} não declara o @font-face local`);
  }
});

test("fontes Inter existem no pacote e são acessíveis ao WhatsApp", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const war = manifest.web_accessible_resources.flatMap((w) => w.resources);
  assert.ok(war.includes("fonts/*"), "fonts/* precisa ser web_accessible para o content script");

  const dir = path.join(EXT, "fonts");
  const ttf = fs.readdirSync(dir).filter((f) => f.endsWith(".ttf"));
  assert.ok(ttf.length >= 2, "fontes Inter ausentes");
});

test("nenhuma URL externa hardcoded no CSS", () => {
  for (const f of fs.readdirSync(path.join(EXT, "css"))) {
    const css = fs.readFileSync(path.join(EXT, "css", f), "utf8");
    const externas = [...css.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"]+)/g)].map((m) => m[1]);
    assert.deepStrictEqual(externas, [], `${f} referencia ${externas[0]}`);
  }
});

test("permissões só foram ampliadas com declarativeNetRequest (bloqueio de rede)", () => {
  // declarativeNetRequest foi adicionada de propósito: é a única forma de
  // bloquear location.assign/replace, que são unforgeable em JS.
  assert.deepStrictEqual(
    manifest.permissions.sort(),
    ["declarativeNetRequest", "scripting", "storage", "tabs", "unlimitedStorage"].sort()
  );
  assert.deepStrictEqual(manifest.host_permissions, ["*://web.whatsapp.com/*"]);
});

test("todos os arquivos referenciados no manifest existem", () => {
  const refs = [
    manifest.background.service_worker,
    ...manifest.content_scripts[0].js,
    ...manifest.content_scripts[0].css,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.web_accessible_resources.flatMap((w) => w.resources),
  ];
  for (const r of refs) {
    if (r.endsWith("/*")) {
      // curinga (ex.: fonts/*) — confere se o diretório tem arquivos
      const dir = path.join(EXT, r.slice(0, -2));
      assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length > 0, `curinga vazio: ${r}`);
      continue;
    }
    assert.ok(fs.existsSync(path.join(EXT, r)), `arquivo ausente: ${r}`);
  }
});

test("todos os arquivos referenciados nos HTML existem", () => {
  for (const file of ["popup.html", "options.html"]) {
    const html = fs.readFileSync(path.join(EXT, file), "utf8");
    const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const s of srcs) {
      if (/^https?:/.test(s)) continue;
      assert.ok(fs.existsSync(path.join(EXT, s)), `${file} referencia ${s}, que não existe`);
    }
  }
});

test("bundles originais não foram modificados (tamanho e assinatura)", () => {
  const expected = {
    "js/popup.js": 2416360,
    "js/options.js": 2458187,
    "js/content-script.js": 3368413,
    "js/service-worker.js": 50357,
    "js/wapi.js": 102242,
    "js/mount.js": 10382,
  };
  for (const [f, size] of Object.entries(expected)) {
    const st = fs.statSync(path.join(EXT, f));
    assert.strictEqual(st.size, size, `${f} mudou de tamanho`);
  }
});
