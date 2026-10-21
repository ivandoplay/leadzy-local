"use strict";

/**
 * Percorre a extensão executando operações reais e devolve o log de rotas
 * registrado pelo local-bootstrap (window.__LZ_ROUTE_LOG__).
 *
 * Usado por tests/e2e/rotas.test.js
 * (regressão). Fica num arquivo só para os dois não divergirem.
 */

const { sleep } = require("./env");

const TELAS = ["#/dashboard", "#/messages", "#/scripts", "#/triggers", "#/flows", "#/flows/new"];

async function irPara(page, id, rota) {
  await page.goto(`chrome-extension://${id}/options.html${rota}?t=${Date.now()}`, {
    waitUntil: "domcontentloaded",
  });
  await sleep(2600);
}

async function abrirMenuUsuario(page) {
  const abriu = await page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const b = [...document.querySelectorAll("button")]
      .filter((e) => vis(e) && (e.innerText || "").includes("Usuário Local"))
      .pop();
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(1600);
  return abriu;
}

/**
 * Executa o roteiro completo. Devolve { acoes, rotas, agrupado }.
 */
async function percorrer(ctx, id) {
  const page = await ctx.newPage();
  const acoes = [];
  const erros = [];

  const onErr = (e) => erros.push(String(e.message).slice(0, 160));
  page.on("pageerror", onErr);

  // --- popup (pode fechar a própria aba)
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

  let p = page.isClosed() ? await ctx.newPage() : page;
  if (p !== page) {
    p.on("pageerror", onErr);
    // o log vive na página; reabre para semear
    await p.goto(`chrome-extension://${id}/options.html#/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await sleep(2000);
  }

  // --- todas as telas + menu do usuário
  for (const rota of TELAS) {
    await irPara(p, id, rota);
    acoes.push("tela:" + rota);
    await abrirMenuUsuario(p);
  }

  // --- criar mensagem
  await irPara(p, id, "#/messages");
  await p
    .getByText("Adicionar nova mensagem")
    .first()
    .click()
    .catch(() => {});
  await sleep(1200);
  await p.locator('input[placeholder*="Boas-vindas"]').fill("Msg auditoria").catch(() => {});
  await p.locator('textarea[placeholder*="Digite aqui"]').fill("conteudo").catch(() => {});
  await p
    .getByRole("button", { name: "Salvar mensagem" })
    .click()
    .catch(() => {});
  await sleep(1800);
  acoes.push("criar:mensagem");

  // --- criar script
  await irPara(p, id, "#/scripts");
  await p
    .getByText("Adicionar novo script")
    .first()
    .click()
    .catch(() => {});
  await sleep(1500);
  acoes.push("criar:script");

  // --- criar fluxo + etapa + salvar
  await irPara(p, id, "#/flows/new");
  await p
    .getByText("Criar fluxo em branco")
    .first()
    .click()
    .catch(() => {});
  await sleep(2800);
  await p
    .getByRole("button", { name: "Adicionar etapa" })
    .click()
    .catch(() => {});
  await sleep(1000);
  await p
    .getByRole("button", { name: "Salvar rascunho" })
    .first()
    .click()
    .catch(() => {});
  await sleep(2500);
  acoes.push("criar:fluxo");

  // --- gatilho
  await irPara(p, id, "#/triggers");
  await p
    .getByText("Adicionar novo gatilho")
    .first()
    .click()
    .catch(() => {});
  await sleep(1600);
  acoes.push("criar:gatilho");

  // --- backup
  await irPara(p, id, "#/dashboard");
  await abrirMenuUsuario(p);
  const abriuBackup = await p.evaluate(() => {
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

  const log = await p.evaluate(() => window.__LZ_ROUTE_LOG__ || []);

  // agrega
  const mapa = {};
  for (const r of log) {
    const k = `${r.m} ${r.p}`;
    if (!mapa[k]) mapa[k] = { metodo: r.m, rota: r.p, origem: r.origem, vezes: 0 };
    mapa[k].vezes++;
    if (r.origem === "fallback") mapa[k].origem = "fallback";
  }

  const rotas = Object.values(mapa).sort((a, b) => a.rota.localeCompare(b.rota));

  return { acoes, rotas, erros, page: p };
}

module.exports = { percorrer, TELAS };
