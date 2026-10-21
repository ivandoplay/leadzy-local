"use strict";

/**
 * Auditoria profunda: botões que só existem DENTRO de menus e modais.
 *
 * Estratégia: para cada "abridor" (avatar do usuário, Novidades, botões de
 * criar/importar, ações do popup), carrega a página, clica no abridor, e então
 * clica em cada botão que apareceu, registrando rede / abertura externa / erro.
 */

const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const HOST_INTERNO = /^(chrome-extension:|data:|blob:|about:|chrome:|devtools:)/;

// [página, rota, texto do abridor, rótulo]
const TODOS = [
  ["options", "#/dashboard", "Adicionar membro", "dashboard/adicionar-membro"],
  ["options", "#/dashboard", "Usuário Local", "dashboard/menu-usuario"],
  ["options", "#/messages", "Importar", "mensagens/importar"],
  ["options", "#/messages", "Novidades", "mensagens/novidades"],
  ["options", "#/scripts", "Adicionar novo script", "scripts/novo"],
  ["options", "#/triggers", "Adicionar novo gatilho", "gatilhos/novo"],
  ["options", "#/flows", "Modelos prontos", "fluxos/modelos"],
  ["popup", "", "Leadzy CRM", "popup/crm"],
  ["popup", "", "Ver como funciona", "popup/ver-como-funciona"],
  ["popup", "", "Ir para o WhatsApp", "popup/whatsapp"],
];

// AUDIT_FILTRO=popup roda só os casos cujo rótulo casa com o filtro
const F = process.env.AUDIT_FILTRO || "";
const CASOS = F ? TODOS.filter((c) => c[3].includes(F)) : TODOS;

function hook() {
  window.__audit = { opens: [] };
  const real = window.open;
  window.open = function (url) {
    window.__audit.opens.push(String(url));
    return null;
  };
}

async function pagina(ctx, id, qual) {
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  await p.addInitScript(hook);
  return p;
}

async function ir(page, id, qual, rota) {
  const base = qual === "popup" ? "popup.html" : "options.html";
  const q = `?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const alvo = `chrome-extension://${id}/${base}${q}${rota || ""}`;
  await page.goto(alvo, { waitUntil: "domcontentloaded", timeout: 25000 });
  await sleep(2200);
}

async function clicaveis(page) {
  try {
    return await page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"]')]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          texto: (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 55),
          visivel: r.width > 1 && r.height > 1 && el.offsetParent !== null,
          desabilitado: el.disabled === true,
        };
      })
      .filter((e) => e.visivel && e.texto && !e.desabilitado)
    );
  } catch {
    return [];
  }
}

function monitorar(page) {
  const ev = { requests: [], opens: [], erros: [] };
  page.on("request", (r) => {
    const u = r.url();
    if (!HOST_INTERNO.test(u)) ev.requests.push(u);
  });
  page.on("pageerror", (e) => ev.erros.push("pageerror: " + e.message.slice(0, 120)));
  page.on("console", (m) => {
    if (m.type() === "error") ev.erros.push("console: " + m.text().slice(0, 120));
  });
  return ev;
}

(async () => {
  const { ctx, id } = await launch();
  const saida = [];
  let total = 0;

  for (const [qual, rota, abridor, rotulo] of CASOS) {
    console.log(`\n== ${rotulo}  (abridor: "${abridor.replace(/\n/g, " ")}") ==`);
    try {
    const page = await pagina(ctx, id, qual);
    await ir(page, id, qual, rota);

    // abre o menu/modal
    const opener = page.locator("button, a, [role=button]").filter({ hasText: abridor }).first();
    if ((await opener.count()) === 0) {
      console.log("   (abridor não encontrado)");
      await page.close();
      continue;
    }
    await opener.click({ timeout: 5000 }).catch(() => {});
    await sleep(1600);

    const depois = await clicaveis(page);
    const vistos = new Set();
    const internos = depois.filter((e) => {
      if (e.texto === abridor.replace(/\n/g, " ")) return false;
      if (vistos.has(e.texto)) return false;
      vistos.add(e.texto);
      return true;
    });

    console.log(`   ${internos.length} botões dentro`);

    for (const alvo of internos.slice(0, 18)) {
      total++;
      await ir(page, id, qual, rota);

      if (page.isClosed()) { console.log("   (aba fechou, pulando)"); break; }
      const ev = monitorar(page);
      const op = page.locator("button, a, [role=button]").filter({ hasText: abridor }).first();
      await op.click({ timeout: 5000 }).catch(() => {});
      await sleep(1100);

      const b = page.locator("button, a, [role=button], [role=menuitem]").filter({ hasText: alvo.texto }).first();
      if (await b.count()) {
        await b.click({ timeout: 4000, force: true }).catch(() => {});
        await sleep(1100);
      }

      const audit = await page.evaluate(() => window.__audit || { opens: [] }).catch(() => ({ opens: [] }));
      const linha = {
        caso: rotulo,
        abridor: abridor.replace(/\n/g, " "),
        botao: alvo.texto,
        requests: [...new Set(ev.requests)],
        opens: [...new Set([...ev.opens, ...audit.opens])],
        erros: [...new Set(ev.erros)],
      };
      saida.push(linha);

      const marca = linha.requests.length ? "REDE" : linha.opens.length ? "OPEN" : linha.erros.length ? "ERRO" : " ok ";
      console.log(`   ${marca.padEnd(5)} ${alvo.texto.slice(0, 50)}`);
    }

    await page.close().catch(() => {});
    } catch (e) {
      console.log("   (caso abortado: " + e.message.split("\n")[0].slice(0, 90) + ")");
    }
    // grava parcial a cada caso
    fs.writeFileSync(path.resolve(__dirname, "../auditoria-modos.json"), JSON.stringify(saida, null, 2));
  }

  await ctx.close();

  const arquivo = path.resolve(__dirname, "../auditoria-modos.json");
  fs.writeFileSync(arquivo, JSON.stringify(saida, null, 2));

  const rede = saida.filter((r) => r.requests.length);
  const opens = saida.filter((r) => r.opens.length);
  const erros = saida.filter((r) => r.erros.length);

  console.log(`\n\nBotões auditados (nível 2): ${total}`);
  console.log("\n=== COM REQUISIÇÃO DE REDE ===");
  console.log(rede.length ? rede.map((r) => `  [${r.caso}] "${r.botao}" -> ${r.requests.join(", ")}`).join("\n") : "  (nenhum)");
  console.log("\n=== QUE ABREM/Navegam PARA FORA ===");
  console.log(opens.length ? opens.map((r) => `  [${r.caso}] "${r.botao}" -> ${r.opens.join(", ")}`).join("\n") : "  (nenhum)");
  console.log(`\n=== COM ERRO (${erros.length}) ===`);
  console.log(erros.length ? erros.slice(0, 20).map((r) => `  [${r.caso}] "${r.botao}": ${r.erros[0]}`).join("\n") : "  (nenhum)");
  console.log(`\nRelatório: ${arquivo}`);
})().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
