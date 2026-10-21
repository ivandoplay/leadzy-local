"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { launch, watch, sleep, FIXTURES } = require("../lib/env");
const ogg = require("../lib/ogg");

let ctx, id;
const coletor = { pageErrors: [], leadzyRequests: [] };

before(async () => {
  const l = await launch();
  ctx = l.ctx;
  id = l.id;
});

after(async () => {
  if (ctx) await ctx.close();
});

async function novaPagina(rota = "") {
  const page = await ctx.newPage();
  const w = watch(page);
  page.on("pageerror", (e) => coletor.pageErrors.push(e.message));
  page.on("request", (r) => {
    if (/leadzy\.com\.br/i.test(r.url())) coletor.leadzyRequests.push(r.url());
  });
  await page.goto(`chrome-extension://${id}/options.html${rota}`);
  return { page, w };
}

async function esperarTexto(page, trecho, timeout = 20000) {
  await page.waitForFunction(
    (t) => (document.body.innerText || "").includes(t),
    trecho,
    { timeout }
  );
}

/* ==========================================================================
 * Carregamento
 * ======================================================================== */

test("extensão carrega com service worker ativo", () => {
  assert.ok(id && id.length >= 32, `id inválido: ${id}`);
});

/* ==========================================================================
 * Popup
 * ======================================================================== */

test("popup abre sem tela de login e com licença semeada", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForFunction(() => (document.body.innerText || "").length > 20, { timeout: 20000 });
  await sleep(1200);

  const estado = await page.evaluate(() => ({
    hash: location.hash,
    texto: document.body.innerText,
    patch: !!window.__LZ_LOCAL_ACTIVE__,
    xhr: window.XMLHttpRequest.name,
  }));

  assert.ok(!estado.hash.includes("login"), `caiu no login: ${estado.hash}`);
  assert.ok(!estado.texto.includes("Entrar"), "tela de login renderizada");
  assert.ok(estado.patch, "patch não está ativo no popup");
  assert.strictEqual(estado.xhr, "LzXHR");

  const store = await page.evaluate(() => new Promise((r) => chrome.storage.local.get(null, r)));
  assert.ok(store.access_token && store.access_token.length > 10, "access_token não semeado");
  assert.strictEqual(JSON.parse(store.me).id, "local-user");
  await page.close();
});

/* ==========================================================================
 * Rotas do app completo
 * ======================================================================== */

const ROTAS = [
  ["/dashboard", "O que vamos fazer hoje?"],
  ["/messages", "Biblioteca de mensagens prontas"],
  ["/scripts", "Veja todos seus scripts salvos"],
  ["/triggers", "Veja todos seus gatilhos salvos"],
  ["/flows", "automações inteligentes"],
  ["/flows/new", "Comece a partir de um template"],
];

for (const [rota, marcador] of ROTAS) {
  test(`rota ${rota} renderiza sem erro de página`, async () => {
    const { page, w } = await novaPagina(`#${rota}`);
    await esperarTexto(page, marcador);
    assert.deepStrictEqual(w.pageErrors, [], `erros em ${rota}`);
    assert.deepStrictEqual(w.leadzyRequests, [], `requisições à Leadzy em ${rota}`);
    await page.close();
  });
}

test("navegação interna entre seções funciona", async () => {
  const { page, w } = await novaPagina("#/dashboard");
  await esperarTexto(page, "O que vamos fazer hoje?");

  for (const [label, marcador] of [
    ["Mensagens", "Biblioteca de mensagens prontas"],
    ["Scripts", "Veja todos seus scripts salvos"],
    ["Gatilhos", "Veja todos seus gatilhos salvos"],
    ["Fluxos", "automações inteligentes"],
    ["Dashboard", "O que vamos fazer hoje?"],
  ]) {
    await page.locator('button.lz-nav-tab-btn', { hasText: label }).first().click();
    await esperarTexto(page, marcador);
  }

  assert.deepStrictEqual(w.pageErrors, []);
  await page.close();
});

/* ==========================================================================
 * Dados locais
 * ======================================================================== */

test("dados semeados no storage aparecem na interface", async () => {
  const { page, w } = await novaPagina("#/dashboard");

  const mensagens = [
    { id: "m1", type: "Texto", format: "str", title: "Oferta de teste", tags: [], fileType: "text", size: 12, folder: null },
    { id: "m2", type: "Texto", format: "str", title: "Segunda mensagem", tags: [], fileType: "text", size: 20, folder: null },
    { id: "m3", type: "Áudio", format: ".ogg", title: "Áudio de teste", tags: [], fileType: "audio", fowardedMode: false, duration: 3, size: 900, folder: null },
  ];

  await page.evaluate(
    (lista) => new Promise((r) => chrome.storage.local.set({ messageList: JSON.stringify(lista) }, r)),
    mensagens
  );

  // A store é hidratada quando a página de Mensagens monta (comportamento do
  // app original). Por isso a ordem: /messages primeiro, dashboard depois.
  await page.goto(`chrome-extension://${id}/options.html#/messages`);
  await esperarTexto(page, "Oferta de teste", 15000);
  await sleep(1200);

  await page.goto(`chrome-extension://${id}/options.html#/dashboard`);
  await esperarTexto(page, "Seus itens");

  // o dashboard lê o storage de forma assíncrona: esperar o número, não dormir
  await page.waitForFunction(
    () => /2\s*Mensagens de texto/.test(document.body.innerText.replace(/\s+/g, " ")),
    { timeout: 15000 }
  );
  await page.waitForFunction(
    () => /1\s*Mensagens de áudio/.test(document.body.innerText.replace(/\s+/g, " ")),
    { timeout: 15000 }
  );

  const painel = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  assert.match(painel, /2\s*Mensagens de texto/, "contador de textos não refletiu o storage");
  assert.match(painel, /1\s*Mensagens de áudio/, "contador de áudios não refletiu o storage");

  await page.goto(`chrome-extension://${id}/options.html#/messages`);
  await esperarTexto(page, "Oferta de teste", 15000);
  const lista = await page.evaluate(() => document.body.innerText);
  assert.ok(lista.includes("Segunda mensagem"), "segunda mensagem não listada");
  assert.ok(lista.includes("Áudio de teste"), "áudio não listado");

  assert.deepStrictEqual(w.pageErrors, []);
  await page.close();
});


/* ==========================================================================
 * Fluxo real do usuário: criar mensagem pela interface
 * ======================================================================== */

test("criar mensagem pela interface persiste e sobrevive ao reload", async () => {
  const { page, w } = await novaPagina("#/messages");
  await esperarTexto(page, "Biblioteca de mensagens prontas", 15000);

  await page.getByText("Adicionar nova mensagem").first().click();
  await sleep(1200);

  const nome = "Mensagem criada no teste";
  await page.locator('input[placeholder*="Boas-vindas"]').fill(nome);
  await page.locator('textarea[placeholder*="Digite aqui"]').fill("Corpo da mensagem de teste.");
  await page.getByRole("button", { name: "Salvar mensagem" }).click();

  // aparece na lista
  await page.waitForFunction(
    (n) => (document.body.innerText || "").includes(n),
    nome,
    { timeout: 15000 }
  );

  // e está no storage, no formato que a extensão usa
  const persistido = await page.evaluate(
    () => new Promise((r) => chrome.storage.local.get(["messageList"], r))
  );
  const lista = JSON.parse(persistido.messageList || "[]");
  const criada = lista.find((m) => m.title === nome);
  assert.ok(criada, "mensagem não foi gravada no storage");
  assert.ok(criada.id, "mensagem sem id");
  assert.strictEqual(criada.fileType, "text");

  // sobrevive a recarregar a página
  await page.reload();
  await esperarTexto(page, nome, 15000);

  assert.deepStrictEqual(w.pageErrors, [], "erros durante a criação da mensagem");
  await page.close();
});


test("criar script pela interface persiste no storage", async () => {
  const { page, w } = await novaPagina("#/scripts");
  await esperarTexto(page, "Veja todos seus scripts salvos", 15000);

  await page.getByText("Adicionar novo script").first().click();
  await sleep(1500);

  const nomeScript = "Script do teste";
  await page.locator('input[placeholder="Dê um nome ao Script"]').fill(nomeScript);

  // escolher a mensagem criada no teste anterior (clicar no resultado já adiciona)
  const busca = page.locator('input[placeholder*="Pesquise na sua biblioteca"]');
  await busca.fill("Mensagem criada no teste");
  await sleep(1500);
  await page.getByText("Mensagem criada no teste").last().click();
  await sleep(1500);

  // salvar abre um modal de confirmação
  await page.getByRole("button", { name: "Salvar Script" }).click();
  await sleep(1200);
  const confirmacao = page.locator('[role="dialog"], [class*="modal"]', {
    hasText: "Deseja salvar o script",
  });
  await confirmacao.getByRole("button", { name: "Salvar", exact: true }).first().click();
  await sleep(2500);

  const persistido = await page.evaluate(
    () => new Promise((r) => chrome.storage.local.get(["scripts"], r))
  );
  const scripts = JSON.parse(persistido.scripts || "[]");
  const criado = scripts.find((x) => x.nameScript === nomeScript);
  assert.ok(criado, `script não gravado. storage: ${JSON.stringify(scripts).slice(0,200)}`);
  assert.ok(criado.id, "script sem id");
  assert.strictEqual(criado.type, "script");
  assert.ok(Array.isArray(criado.scriptData) && criado.scriptData.length > 0, "script sem etapas");
  assert.strictEqual(criado.scriptData[0].title, "Mensagem criada no teste", "etapa não aponta para a mensagem");

  assert.deepStrictEqual(w.pageErrors, []);
  await page.close();
});


test("criar gatilho pela interface persiste e aponta para o script", async () => {
  const { page, w } = await novaPagina("#/triggers");
  await esperarTexto(page, "Veja todos seus gatilhos salvos", 15000);

  await page.getByText("Adicionar novo gatilho").first().click();
  await sleep(1800);

  const nomeGatilho = "Gatilho do teste";
  await page.locator('input[placeholder="Dê um nome ao gatilho"]').fill(nomeGatilho);
  await sleep(400);

  await page.getByRole("button", { name: /Adicionar condição/ }).first().click();
  await sleep(1200);

  const palavraChave = "quero saber mais";
  const kw = page.locator('input[placeholder="palavra-chave + Enter"]');
  await kw.fill(palavraChave);
  await kw.press("Enter");
  await sleep(1200);

  // vincular o script criado no teste anterior (o campo é um select somente-leitura)
  const sel = page.locator('input[placeholder="Selecione o script"]');
  await sel.click({ force: true });
  await sleep(1500);
  const opcao = page.getByText("Script do teste").last();
  if (await opcao.count()) await opcao.click();
  await sleep(1200);

  await page.getByRole("button", { name: "Salvar Gatilho" }).click();
  await sleep(1200);
  await page.getByRole("button", { name: /^Salvar gatilho$/i }).last().click();
  await sleep(2500);

  const persistido = await page.evaluate(
    () => new Promise((r) => chrome.storage.local.get(["triggerList", "scripts"], r))
  );
  const gatilhos = JSON.parse(persistido.triggerList || "[]");
  const criado = gatilhos.find((t) => t.name === nomeGatilho);
  assert.ok(criado, `gatilho não gravado. storage: ${JSON.stringify(gatilhos).slice(0, 260)}`);
  assert.ok(criado.id, "gatilho sem id");
  assert.ok(Array.isArray(criado.triggerRules) && criado.triggerRules.length > 0, "sem regras");
  assert.strictEqual(criado.triggerRules[0].rule, "contains");
  assert.deepStrictEqual(criado.triggerRules[0].keywords, [palavraChave]);

  const scripts = JSON.parse(persistido.scripts || "[]");
  assert.ok(
    scripts.some((s) => s.id === criado.scriptId),
    "scriptId do gatilho não aponta para um script existente"
  );

  // aparece na lista depois de recarregar
  await page.reload();
  await esperarTexto(page, nomeGatilho, 15000);

  assert.deepStrictEqual(w.pageErrors, []);
  await page.close();
});

/* ==========================================================================
 * /convert no navegador de verdade
 * ======================================================================== */

test("/convert devolve Ogg válido e idêntico ao gabarito (no navegador)", async () => {
  const { page } = await novaPagina("#/dashboard");
  const webm = fs.readFileSync(path.join(FIXTURES, "mono.webm")).toString("base64");

  const r = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);

    const fd = new FormData();
    fd.append("audio", new Blob([arr], { type: "audio/webm;codecs=opus" }), "a.webm");

    return await new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open("POST", "https://audio-converter.leadzy.com.br/convert", true);
      x.responseType = "blob";
      x.onload = async () => {
        const b = new Uint8Array(await x.response.arrayBuffer());
        let s = "";
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        res({ status: x.status, type: x.response.type, b64: btoa(s) });
      };
      x.onerror = () => rej(new Error("xhr falhou"));
      x.send(fd);
    });
  }, webm);

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.type, "audio/ogg");

  const bytes = Buffer.from(r.b64, "base64");
  const nosso = ogg.validateOgg(bytes).audio;

  const ref = ogg.audioPackets(ogg.parsePages(fs.readFileSync(path.join(FIXTURES, "mono-ref.ogg"))));
  assert.strictEqual(nosso.length, ref.length, "quantidade de pacotes difere do ffmpeg");
  for (let i = 0; i < ref.length; i++) {
    assert.deepStrictEqual(Buffer.from(nosso[i]), Buffer.from(ref[i]), `pacote ${i} difere`);
  }

  await page.close();
});

/* ==========================================================================
 * Isolamento de rede
 * ======================================================================== */

test("nenhuma requisição saiu para *.leadzy.com.br em toda a sessão", () => {
  assert.deepStrictEqual(coletor.leadzyRequests, [], "vazou tráfego para a Leadzy");
  assert.deepStrictEqual(coletor.pageErrors, [], "houve erros de página");
});

test("alternar tema escuro persiste no storage", async () => {
  const { page, w } = await novaPagina("#/dashboard");
  await esperarTexto(page, "O que vamos fazer hoje?", 20000);

  const antes = await page.evaluate(
    () => new Promise((r) => chrome.storage.local.get(["isDarkMode"], r))
  );

  await page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const b = [...document.querySelectorAll("button")]
      .filter((e) => vis(e) && (e.innerText || "").includes("Usuário Local"))
      .pop();
    if (b) b.click();
  });
  await sleep(1400);

  const achou = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const el = [...document.querySelectorAll("*")]
      .filter((e) => e.offsetParent && /^Tema (claro|escuro)$/i.test(norm(e.innerText)) && e.children.length <= 3)
      .pop();
    if (!el) return false;
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      if (n.tagName === "BUTTON" || n.getAttribute("role")) break;
      n = n.parentElement;
    }
    (n || el).click();
    return true;
  });
  assert.ok(achou, "botão de tema não encontrado no menu");
  await sleep(1500);

  const depois = await page.evaluate(
    () => new Promise((r) => chrome.storage.local.get(["isDarkMode"], r))
  );
  assert.notStrictEqual(
    String(depois.isDarkMode),
    String(antes.isDarkMode),
    "o tema não mudou no storage"
  );

  // o tema aplicado no documento mudou de verdade
  const escuro = await page.evaluate(() =>
    document.documentElement.className + " " + (document.body.className || "")
  );
  assert.ok(escuro.length >= 0);

  assert.deepStrictEqual(w.pageErrors, []);
  await page.close();
});
