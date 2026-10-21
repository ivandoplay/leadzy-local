"use strict";

/**
 * Auditoria nominal das ações que não são <button>: itens do menu do usuário,
 * cards de ajuda do dashboard, notificações e novidades.
 *
 * Cada ação é executada em página nova; registra rede, window.open e erros.
 */

const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const HOST_INTERNO = /^(chrome-extension:|data:|blob:|about:|chrome:|devtools:)/;

const ACOES = [
  // [rota, abridor (null = já visível), alvo, rótulo]
  ["#/dashboard", "Usuário Local", "Perfil e conta", "menu/perfil"],
  ["#/dashboard", "Usuário Local", "Ajustes e configurações", "menu/ajustes"],
  ["#/dashboard", "Usuário Local", "Backup e restauração", "menu/backup"],
  ["#/dashboard", "Usuário Local", "Verificação de arquivos", "menu/verificacao"],
  ["#/dashboard", "Usuário Local", "Sair da minha conta", "menu/sair"],
  ["#/dashboard", "Usuário Local", "Tema claro", "menu/tema"],
  ["#/dashboard", null, "Tutoriais e FAQ", "dashboard/tutoriais"],
  ["#/dashboard", null, "Suporte e atendimento", "dashboard/suporte"],
  ["#/dashboard", null, "Nossos materiais", "dashboard/materiais"],
  ["#/messages", null, "Novidades", "mensagens/novidades"],
];

function hook() {
  window.__audit = { opens: [] };
  const real = window.open;
  window.open = function (url) {
    window.__audit.opens.push(String(url));
    return null;
  };
}

async function ir(page, id, rota) {
  const q = `?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`chrome-extension://${id}/options.html${q}${rota}`, {
    waitUntil: "domcontentloaded",
    timeout: 25000,
  });
  await sleep(2400);
}

/** Clica no elemento cujo texto casa, mesmo sendo div. Em duas etapas:
 *  abre o menu, espera o Vue renderizar, depois clica no item. */
async function clicarPorTexto(page, texto, abridor) {
  const norm = `(s) => (s || "").replace(/\\s+/g, " ").trim()`;

  if (abridor) {
    const abriu = await page.evaluate(
      ({ abridor }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const visivel = (e) => e && e.offsetParent !== null && e.getBoundingClientRect().width > 1;
        // prefere <button>: um <div> interno com o mesmo texto não abre o menu
        const cands = [...document.querySelectorAll("button, [role=button], div")].filter(
          (e) => visivel(e) && norm(e.innerText).includes(abridor)
        );
        const botoes = cands.filter((e) => e.tagName === "BUTTON" || e.getAttribute("role") === "button");
        const ab = (botoes.length ? botoes : cands).sort(
          (a, b) => norm(a.innerText).length - norm(b.innerText).length
        )[0];
        if (!ab) return false;
        ab.click();
        return true;
      },
      { abridor }
    );
    if (!abriu) return "abridor não encontrado";
    await sleep(1500); // menu renderiza de forma assíncrona
  }

  return page.evaluate(
    ({ texto }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const visivel = (e) => e && e.offsetParent !== null && e.getBoundingClientRect().width > 1;

      const alvo = [...document.querySelectorAll("*")]
        .filter((e) => {
          if (!visivel(e)) return false;
          const t = norm(e.innerText);
          if (t !== texto && !(t.includes(texto) && t.length < texto.length + 40)) return false;
          return e.children.length <= 4;
        })
        .pop();

      if (!alvo) return "alvo não encontrado";
      // clica no ancestral clicável mais próximo
      let n = alvo;
      for (let i = 0; i < 4 && n; i++) {
        if (n.tagName === "BUTTON" || n.getAttribute("role") || n.onclick) break;
        n = n.parentElement;
      }
      (n || alvo).click();
      return "ok";
    },
    { texto }
  );
}

(async () => {
  const { ctx, id } = await launch();
  const saida = [];

  for (const [rota, abridor, alvo, rotulo] of ACOES) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(6000);
    await page.addInitScript(hook);

    const ev = { requests: [], opens: [], erros: [] };
    page.on("request", (r) => {
      if (!HOST_INTERNO.test(r.url())) ev.requests.push(r.url());
    });
    page.on("pageerror", (e) => ev.erros.push("pageerror: " + e.message.slice(0, 120)));
    page.on("console", (m) => {
      if (m.type() === "error") ev.erros.push("console: " + m.text().slice(0, 120));
    });

    await ir(page, id, rota);
    const r = await clicarPorTexto(page, alvo, abridor).catch((e) => "erro: " + e.message.slice(0, 60));
    await sleep(1500);

    const audit = await page.evaluate(() => window.__audit || { opens: [] }).catch(() => ({ opens: [] }));
    const linha = {
      rotulo,
      rota,
      abridor,
      alvo,
      resultado: r,
      requests: [...new Set(ev.requests)],
      opens: [...new Set([...ev.opens, ...audit.opens])],
      erros: [...new Set(ev.erros)],
    };
    saida.push(linha);

    const marca = linha.requests.length ? "REDE" : linha.opens.length ? "OPEN" : linha.erros.length ? "ERRO" : r === "ok" ? " ok " : " ?  ";
    console.log(`  ${marca.padEnd(5)} ${rotulo.padEnd(26)} ${r}`);

    if (!page.isClosed()) await page.close().catch(() => {});
  }

  await ctx.close();

  const arquivo = path.resolve(__dirname, "../auditoria-acoes.json");
  fs.writeFileSync(arquivo, JSON.stringify(saida, null, 2));

  const rede = saida.filter((s) => s.requests.length);
  const opens = saida.filter((s) => s.opens.length);
  const erros = saida.filter((s) => s.erros.length);

  console.log("\n=== REDE ===");
  console.log(rede.length ? rede.map((s) => `  ${s.rotulo}: ${s.requests.join(", ")}`).join("\n") : "  (nenhum)");
  console.log("\n=== ABRE PARA FORA ===");
  console.log(opens.length ? opens.map((s) => `  ${s.rotulo}: ${s.opens.join(", ")}`).join("\n") : "  (nenhum)");
  console.log("\n=== ERROS ===");
  console.log(erros.length ? erros.map((s) => `  ${s.rotulo}: ${s.erros[0]}`).join("\n") : "  (nenhum)");
})().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
