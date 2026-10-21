"use strict";

/**
 * Regressão: NENHUM clique pode gerar tráfego externo.
 *
 * Este é o teste que substitui "acho que está local". Ele clica em todos os
 * botões de todas as telas e falha se qualquer requisição sair para fora da
 * extensão, se algo abrir uma página externa ou se der erro de página.
 *
 * Custo: ~4 min (por isso fica separado da suíte rápida).
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { launch, sleep } = require("../lib/env");

const HOST_INTERNO = /^(chrome-extension:|data:|blob:|about:|chrome:|devtools:)/;

// Rotas raspadas + número mínimo de botões que esperamos encontrar.
// O mínimo serve de alarme: se a UI quebrar e não renderizar, o teste falha
// em vez de "passar" por não ter clicado em nada.
const ROTAS = [
  ["/", "raiz", "options.html", 3],
  ["#/dashboard", "dashboard", "options.html", 3],
  ["#/messages", "mensagens", "options.html", 5],
  ["#/scripts", "scripts", "options.html", 3],
  ["#/triggers", "gatilhos", "options.html", 3],
  ["#/flows", "fluxos", "options.html", 3],
  ["#/flows/new", "fluxos-novo", "options.html", 3],
  ["", "popup", "popup.html", 2],
];

// Ações que não são <button> (itens de menu em div/span, cards de ajuda).
const ACOES = [
  ["#/dashboard", "Usuário Local", "Perfil e conta"],
  ["#/dashboard", "Usuário Local", "Ajustes e configurações"],
  ["#/dashboard", "Usuário Local", "Backup e restauração"],
  ["#/dashboard", "Usuário Local", "Verificação de arquivos"],
  ["#/dashboard", "Usuário Local", "Sair da minha conta"],
  ["#/dashboard", null, "Tutoriais e FAQ"],
  ["#/dashboard", null, "Suporte e atendimento"],
  ["#/dashboard", null, "Nossos materiais"],
];

let ctx, id;

before(async () => {
  const l = await launch();
  ctx = l.ctx;
  id = l.id;
});

after(async () => {
  if (ctx) await ctx.close();
});

function hook() {
  window.__audit = { opens: [] };
  const real = window.open;
  window.open = function (url) {
    window.__audit.opens.push(String(url));
    return null;
  };
}

async function abrir(page, rota, base) {
  await page.addInitScript(hook);
  const q = `?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(`chrome-extension://${id}/${base}${q}${rota === "/" ? "" : rota}`, {
    waitUntil: "domcontentloaded",
    timeout: 25000,
  });
  await sleep(2000);
}

async function clicaveis(page) {
  return page.evaluate(() =>
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
}

/** Rede + aberturas externas de um único clique. */
async function espiar(page, fn) {
  const vistos = { requests: [], opens: [], erros: [] };

  const onReq = (r) => {
    if (!HOST_INTERNO.test(r.url())) vistos.requests.push(r.url());
  };
  const onErr = (e) => vistos.erros.push(e.message.slice(0, 120));
  const onCon = (m) => {
    if (m.type() === "error") vistos.erros.push(m.text().slice(0, 120));
  };

  page.on("request", onReq);
  page.on("pageerror", onErr);
  page.on("console", onCon);

  try {
    await fn();
    await sleep(1100);
    const audit = await page.evaluate(() => window.__audit || { opens: [] }).catch(() => ({ opens: [] }));
    vistos.opens.push(...audit.opens);
  } finally {
    page.off("request", onReq);
    page.off("pageerror", onErr);
    page.off("console", onCon);
  }
  return vistos;
}

for (const [rota, nome, base, minimo] of ROTAS) {
  test(`nenhum botão de ${nome} gera tráfego externo`, async () => {
    let page = await ctx.newPage();
    page.setDefaultTimeout(6000);
    await abrir(page, rota, base);

    const botoes = await clicaveis(page);
    assert.ok(
      botoes.length >= minimo,
      `${nome}: só ${botoes.length} botões encontrados (esperado >= ${minimo}) — a tela renderizou?`
    );

    const problemas = [];
    const vistos = new Set();

    for (const b of botoes) {
      const chave = b.texto;
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      if (page.isClosed()) page = await ctx.newPage(), page.setDefaultTimeout(6000);
      await abrir(page, rota, base);

      const r = await espiar(page, async () => {
        const el = page.locator('button, a[href], [role="button"]').filter({ hasText: b.texto }).first();
        if ((await el.count()) > 0) await el.click({ timeout: 3500, force: true }).catch(() => {});
      });

      if (r.requests.length) problemas.push(`"${b.texto}" pediu ${r.requests[0]}`);
      if (r.opens.length) problemas.push(`"${b.texto}" abriu ${r.opens[0]}`);
      if (r.erros.length) problemas.push(`"${b.texto}" erro: ${r.erros[0]}`);
    }

    if (!page.isClosed()) await page.close();
    assert.deepStrictEqual(problemas, [], `${nome}: ${problemas.join(" | ")}`);
  });
}

test("itens do menu do usuário e cards de ajuda não geram tráfego", async () => {
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  const problemas = [];

  for (const [rota, abridor, alvo] of ACOES) {
    await abrir(page, rota, "options.html");

    const r = await espiar(page, async () => {
      if (abridor) {
        await page.evaluate((ab) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const vis = (e) => e && e.offsetParent !== null && e.getBoundingClientRect().width > 1;
          const cands = [...document.querySelectorAll("button, [role=button]")].filter(
            (e) => vis(e) && norm(e.innerText).includes(ab)
          );
          const el = cands.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length)[0];
          if (el) el.click();
        }, abridor);
        await sleep(1500);
      }
      const achou = await page.evaluate((t) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const vis = (e) => e && e.offsetParent !== null && e.getBoundingClientRect().width > 1;
        const cands = [...document.querySelectorAll("*")].filter(
          (e) => vis(e) && norm(e.innerText) === t && e.children.length <= 4
        );
        const el = cands.pop();
        if (!el) return false;
        let n = el;
        for (let i = 0; i < 4 && n; i++) {
          if (n.tagName === "BUTTON" || n.getAttribute("role")) break;
          n = n.parentElement;
        }
        (n || el).click();
        return true;
      }, alvo);
      return achou;
    });

    if (r.requests.length) problemas.push(`${alvo}: pediu ${r.requests[0]}`);
    if (r.opens.length) problemas.push(`${alvo}: abriu ${r.opens[0]}`);
    if (r.erros.length) problemas.push(`${alvo}: erro ${r.erros[0]}`);
  }

  if (!page.isClosed()) await page.close();
  assert.deepStrictEqual(problemas, [], problemas.join(" | "));
});

test("fontes carregam do pacote local, não do Google", async () => {
  const page = await ctx.newPage();
  const externas = [];
  page.on("request", (r) => {
    if (!HOST_INTERNO.test(r.url())) externas.push(r.url());
  });

  await abrir(page, "#/dashboard", "options.html");
  const info = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      inter: document.fonts.check("500 16px Inter"),
      familias: [...document.fonts].map((f) => f.family),
    };
  });

  assert.ok(info.inter, "a fonte Inter não carregou");
  assert.ok(info.familias.some((f) => /Inter/i.test(f)), "nenhum @font-face de Inter registrado");
  assert.deepStrictEqual(externas, [], "fontes ou recursos externos foram baixados");
  await page.close();
});

test("imagens do bucket.leadzy viram placeholder e não são baixadas", async () => {
  const page = await ctx.newPage();
  const externas = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!HOST_INTERNO.test(u)) externas.push(u);
  });

  await abrir(page, "#/dashboard", "options.html");

  const r = await page.evaluate(() => {
    const bucket = new Image();
    bucket.src = "https://bucket.leadzy.com.br/announcement-images/teste.webp";
    const externa = new Image();
    externa.src = "https://exemplo.com/foto.png";
    return { bucket: bucket.src, externa: externa.src };
  });

  await sleep(600);
  assert.ok(r.bucket.startsWith("data:image/svg"), `imagem do bucket não foi trocada: ${r.bucket.slice(0, 60)}`);
  assert.strictEqual(r.externa, "https://exemplo.com/foto.png", "imagem de fora não deve ser afetada");
  assert.ok(
    !externas.some((u) => /bucket\.leadzy/.test(u)),
    "o navegador tentou baixar a imagem do bucket"
  );
  await page.close();
});
