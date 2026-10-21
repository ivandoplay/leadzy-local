"use strict";

/**
 * Auditoria de cobertura de rotas.
 *
 * Percorre o app (popup + todas as telas de options), executa operações reais
 * de criação/edição/salvamento e registra CADA rota que o código original
 * tentou chamar. Depois cruza com o que o local-bootstrap responde de forma
 * explícita e o que caiu no fallback genérico.
 *
 * Saída: tests/auditoria-rotas.json
 */

const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const ROTAS = [
  "#/dashboard",
  "#/messages",
  "#/scripts",
  "#/triggers",
  "#/flows",
  "#/flows/new",
];

async function coletarLog(page) {
  return page.evaluate(() => window.__LZ_ROUTE_LOG__ || []);
}

async function irPara(page, id, rota) {
  await page.goto(`chrome-extension://${id}/options.html${rota}?t=${Date.now()}`, {
    waitUntil: "domcontentloaded",
  });
  await sleep(2600);
}

/** Abre menus para forçar o carregamento de dados preguiçosos. */
async function abrirMenus(page) {
  const clicou = await page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const b = [...document.querySelectorAll("button")]
      .filter((e) => vis(e) && (e.innerText || "").includes("Usuário Local"))
      .pop();
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(1600);
  return clicou;
}

async function criarMensagem(page) {
  const abriu = await page.evaluate(() =>
    !![...document.querySelectorAll("*")].find(
      (e) => (e.innerText || "").trim() === "Adicionar nova mensagem"
    )
  );
  if (!abriu) return false;
  await page.getByText("Adicionar nova mensagem").first().click().catch(() => {});
  await sleep(1200);
  await page
    .locator('input[placeholder*="Boas-vindas"]')
    .fill("Msg auditoria")
    .catch(() => {});
  await page
    .locator('textarea[placeholder*="Digite aqui"]')
    .fill("conteudo")
    .catch(() => {});
  await page
    .getByRole("button", { name: "Salvar mensagem" })
    .click()
    .catch(() => {});
  await sleep(1800);
  return true;
}

async function criarScript(page) {
  await page
    .getByText("Adicionar novo script")
    .first()
    .click()
    .catch(() => {});
  await sleep(1400);
  return true;
}

async function criarFluxo(page, id) {
  await page
    .getByText("Criar fluxo em branco")
    .first()
    .click()
    .catch(() => {});
  await sleep(2800);
  await page
    .getByRole("button", { name: "Adicionar etapa" })
    .click()
    .catch(() => {});
  await sleep(1000);
  await page
    .getByRole("button", { name: "Salvar rascunho" })
    .first()
    .click()
    .catch(() => {});
  await sleep(2500);
}

(async () => {
  const { ctx, id } = await launch();
  let page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(e.message.slice(0, 160)));

  const acoes = [];

  // ----- popup (ele pode fechar a própria aba: tratar como normal)
  try {
    await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    acoes.push("popup:aberto");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].filter(
        (e) => e.offsetParent && /whatsapp|abrir|começar/i.test(e.innerText || "")
      )[0];
      if (b) b.click();
    });
    await sleep(1500);
  } catch (e) {
    acoes.push("popup:fechou-sozinho");
  }
  if (page.isClosed()) page = await ctx.newPage();

  // ----- telas
  for (const rota of ROTAS) {
    await irPara(page, id, rota);
    acoes.push("tela:" + rota);
    await abrirMenus(page);
  }

  // ----- operações reais
  await irPara(page, id, "#/messages");
  if (await criarMensagem(page)) acoes.push("criar:mensagem");

  await irPara(page, id, "#/scripts");
  await criarScript(page);
  acoes.push("criar:script");

  await irPara(page, id, "#/flows/new");
  await criarFluxo(page, id);
  acoes.push("criar:fluxo");

  // ----- operações extras: backup, saúde de arquivos, gatilhos
  await irPara(page, id, "#/triggers");
  await page.getByText("Adicionar novo gatilho").first().click().catch(() => {});
  await sleep(1600);
  acoes.push("criar:gatilho");

  await irPara(page, id, "#/dashboard");
  await abrirMenus(page);
  const abriuBackup = await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")]
      .filter((e) => (e.innerText || "").trim() === "Backup e restauração" && e.children.length <= 4)
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
  await sleep(2400);
  if (abriuBackup) acoes.push("abrir:backup");

  // ----- coleta
  const log = await coletarLog(page);

  // agrega
  const mapa = {};
  for (const r of log) {
    const k = `${r.m} ${r.p}`;
    if (!mapa[k]) mapa[k] = { metodo: r.m, rota: r.p, origem: r.origem, vezes: 0 };
    mapa[k].vezes++;
    // fallback tem precedência: se alguma vez caiu no genérico, é gap
    if (r.origem === "fallback") mapa[k].origem = "fallback";
  }

  const lista = Object.values(mapa).sort((a, b) => a.rota.localeCompare(b.rota));
  const fallbacks = lista.filter((r) => r.origem === "fallback");

  const saida = {
    geradoEm: new Date().toISOString(),
    acoesExecutadas: acoes,
    totalRotasDistintas: lista.length,
    mocksExplicitos: lista.filter((r) => r.origem === "mock").length,
    fallbacksGenericos: fallbacks.length,
    rotas: lista,
    gaps: fallbacks,
    errosDePagina: erros,
  };

  fs.writeFileSync(
    path.resolve(__dirname, "../auditoria-rotas.json"),
    JSON.stringify(saida, null, 2)
  );

  console.log("ações executadas:", acoes.length);
  console.log("rotas distintas chamadas:", lista.length);
  console.log("  respondidas por mock explícito:", saida.mocksExplicitos);
  console.log("  caíram no fallback genérico:", saida.fallbacksGenericos);
  console.log("\n--- ROTAS ---");
  for (const r of lista) {
    console.log(`  [${r.origem === "mock" ? "MOCK    " : "FALLBACK"}] ${r.metodo} ${r.rota}  (${r.vezes}x)`);
  }
  if (erros.length) console.log("\nerros de página:", erros);

  await ctx.close();
})().catch((e) => {
  console.error("FALHOU:", e.message);
  process.exit(1);
});
