"use strict";

/**
 * Auditoria de botões.
 *
 * Para cada rota: abre a página, enumera TODOS os elementos clicáveis, e clica
 * em cada um isoladamente (página recém-carregada). Registra:
 *   - requisições de rede para fora da extensão (fetch/XHR)
 *   - chamadas de window.open / navegação para fora
 *   - erros de página / console
 *
 * Saída: relatório em JSON + resumo no terminal.
 */

const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const ROTAS = [
  ["/", "raiz", "options.html"],
  ["#/dashboard", "dashboard", "options.html"],
  ["#/messages", "mensagens", "options.html"],
  ["#/scripts", "scripts", "options.html"],
  ["#/triggers", "gatilhos", "options.html"],
  ["#/flows", "fluxos", "options.html"],
  ["#/flows/new", "fluxos-novo", "options.html"],
  ["", "popup", "popup.html"],
];

const HOST_INTERNO = /^(chrome-extension:|data:|blob:|about:|chrome:|devtools:)/;

/** Instalado antes de qualquer script da página, em todos os frames. */
function hookWindow() {
  window.__audit = { opens: [], navs: [] };
  const realOpen = window.open;
  window.open = function (url, ...rest) {
    window.__audit.opens.push(String(url));
    return null; // não abre de verdade
  };
}

async function elementosClicaveis(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], [role="button"]')]
      .map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          i,
          tag: el.tagName,
          texto: (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60),
          classe: (el.className || "").toString().slice(0, 50),
          visivel: r.width > 1 && r.height > 1 && el.offsetParent !== null,
          desabilitado: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        };
      })
      .filter((e) => e.visivel && e.texto && !e.desabilitado)
  );
}

// Uma única aba reaproveitada (recarregada por clique). Criar uma aba por
// clique esgota a memória do navegador em páginas de ~3 MB de JS.
async function novaAba(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(hookWindow);
  return page;
}

async function carregar(page, id, rota, base) {
  const eventos = { requests: [], opens: [], navs: [], erros: [] };
  page._ev = eventos;

  const onReq = (r) => {
    const u = r.url();
    if (!HOST_INTERNO.test(u)) eventos.requests.push(u);
  };
  const onErr = (e) => eventos.erros.push("pageerror: " + e.message.slice(0, 140));
  const onCon = (m) => {
    if (m.type() === "error") eventos.erros.push("console: " + m.text().slice(0, 140));
  };

  page.on("request", onReq);
  page.on("pageerror", onErr);
  page.on("console", onCon);

  // Query única força recarga completa: navegação só de hash NÃO recarrega,
  // e o estado da SPA (e o __audit) vazaria de um clique para o outro.
  const arquivo = base || "options.html";
  const alvo = `chrome-extension://${id}/${arquivo}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}${rota === "/" ? "" : rota}`;
  await page.goto(alvo, { waitUntil: "domcontentloaded", timeout: 25000 });
  await sleep(2000);

  // remove listeners depois de capturar o clique
  page._cleanup = () => {
    page.off("request", onReq);
    page.off("pageerror", onErr);
    page.off("console", onCon);
  };
  return eventos;
}

(async () => {
  const { ctx, id } = await launch();
  const relatorio = [];
  const FILTRO = process.env.AUDIT_FILTRO || "";
  const ROTAS_ATIVAS = FILTRO ? ROTAS.filter((r) => r[1].includes(FILTRO)) : ROTAS;

  let page = await novaAba(ctx);

  // Descobre os elementos uma vez por rota
  const mapa = [];
  for (const [rota, nome, base] of ROTAS_ATIVAS) {
    await carregar(page, id, rota, base);
    const brutos = await elementosClicaveis(page);
    const vistos = new Set();
    const els = brutos.filter((e) => {
      const k = e.texto + "|" + e.classe;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    mapa.push({ rota, nome, base, els });
    console.log(`  ${nome}: ${els.length} botões`);
  }

  let total = 0;
  for (const { rota, nome, base, els } of mapa) {
    console.log(`\n== ${nome} (${rota}) ==`);
    for (const el of els) {
      total++;
      if (page.isClosed()) page = await novaAba(ctx);
      const eventos = await carregar(page, id, rota, base);
      try {
        const alvo = page.locator('button, a[href], [role="button"]').filter({ hasText: el.texto }).first();
        if ((await alvo.count()) === 0) continue;
        await alvo.click({ timeout: 3000, force: true }).catch(() => {});
        await sleep(1200);

        const audit = await page.evaluate(() => window.__audit || { opens: [], navs: [] });
        const urlAtual = page.url();
        if (!HOST_INTERNO.test(urlAtual)) eventos.navs.push(urlAtual);
        for (const o of audit.opens) {
          eventos.opens.push(o);
          // a URL aberta pode virar navegação do próprio painel
        }
      } catch (e) {
        const msg = e.message.split("\n")[0];
        // o popup fecha a própria aba depois de agir — não é erro
        if (!/closed|Target page/i.test(msg)) eventos.erros.push("click: " + msg.slice(0, 100));
      }

      const linha = {
        rota: nome,
        botao: el.texto,
        classe: el.classe,
        requests: [...new Set(eventos.requests)],
        opens: [...new Set(eventos.opens)],
        navs: [...new Set(eventos.navs)],
        erros: [...new Set(eventos.erros)],
      };
      relatorio.push(linha);
      if (!page.isClosed()) page._cleanup();
      const marca = linha.requests.length ? "REDE" : linha.opens.length ? "OPEN" : linha.erros.length ? "ERRO" : "ok";
      console.log(`   ${marca.padEnd(4)} ${el.texto.slice(0, 46)}`);
    }
  }

  await page.close().catch(() => {});
  await ctx.close();

  const saida = path.resolve(__dirname, "../auditoria-botoes.json");
  fs.writeFileSync(saida, JSON.stringify(relatorio, null, 2));

  // ---------------- resumo ----------------
  const comRede = relatorio.filter((r) => r.requests.length);
  const comOpen = relatorio.filter((r) => r.opens.length);
  const comNav = relatorio.filter((r) => r.navs.length);
  const comErro = relatorio.filter((r) => r.erros.length);

  console.log(`\nBotões auditados: ${total}\n`);
  console.log("=== BOTÕES QUE GERAM REQUISIÇÃO DE REDE ===");
  if (!comRede.length) console.log("  (nenhum)");
  for (const r of comRede) console.log(`  [${r.rota}] "${r.botao}" -> ${r.requests.join(", ")}`);

  console.log("\n=== BOTÕES QUE ABREM/Navegam PARA FORA ===");
  if (!comOpen.length) console.log("  (nenhum)");
  for (const r of comOpen) console.log(`  [${r.rota}] "${r.botao}" -> ${r.opens.join(", ")}`);

  console.log("\n=== NAVEGAÇÃO PARA FORA ===");
  if (!comNav.length) console.log("  (nenhum)");
  for (const r of comNav) console.log(`  [${r.rota}] "${r.botao}" -> ${r.navs.join(", ")}`);

  console.log(`\n=== BOTÕES COM ERRO (${comErro.length}) ===`);
  for (const r of comErro.slice(0, 25)) console.log(`  [${r.rota}] "${r.botao}": ${r.erros[0]}`);

  console.log(`\nRelatório completo: ${saida}`);
})().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
