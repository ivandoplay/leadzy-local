"use strict";

/**
 * Jornada de quem acabou de instalar a extensão.
 *
 * Cobre o caminho que a pessoa realmente percorre:
 *   instala -> clica no ícone (popup) -> acha o disparo -> dashboard ->
 *   cartão "Primeiros passos" -> ação concluída aparece marcada.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, sleep } = require("../lib/env.js");

let ctx, id, page;

before(async () => {
  ({ ctx, id } = await launch());
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
});

after(async () => {
  if (ctx) await ctx.close();
});

/* ===========================================================================
 * POPUP — primeiro contato depois de instalar
 * ======================================================================== */

test("popup: abre sem erro e mostra os atalhos úteis", async () => {
  await page.setViewportSize({ width: 420, height: 620 });
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "load" });
  await sleep(2000);

  const atalhos = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-lz-atalhos] button")).map((b) => b.textContent.trim())
  );

  assert.deepEqual(atalhos, ["Disparo em massa", "Configurações"]);
});

test("popup: não anuncia o SaaS nem oferece botão que não funciona", async () => {
  const resto = await page.evaluate(() => {
    const visivel = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return {
      crm: Array.from(document.querySelectorAll("button,a"))
        .filter((e) => (e.textContent || "").trim() === "Leadzy CRM")
        .filter(visivel).length,
      agentes: !!Array.from(document.querySelectorAll(".product-spotlight"))
        .filter(visivel).length,
      textoVisivel: document.body.innerText,
    };
  });

  assert.equal(resto.crm, 0, "o botão 'Leadzy CRM' aponta para o SaaS e não tem função local");
  assert.equal(resto.agentes, false, "o anúncio 'Leadzy Agentes' não deve aparecer");
  assert.doesNotMatch(resto.textoVisivel, /Agentes/i);
});

test("popup: 'Disparo em massa' abre a página de campanhas", async () => {
  await page.click('[data-lz-atalhos] button:has-text("Disparo em massa")');
  await sleep(1500);

  const url = await page.evaluate(
    () =>
      new Promise((r) => {
        chrome.tabs.query({}, (abas) =>
          r((abas || []).filter((a) => (a.url || "").includes("campaigns.html")).length)
        );
      })
  );

  assert.ok(url >= 1, "deveria haver uma aba campaigns.html aberta");
});

test("popup: 'Configurações' abre o dashboard", async () => {
  await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "load" });
  await sleep(1800);
  await page.click('[data-lz-atalhos] button:has-text("Configurações")');
  await sleep(1200);

  const abas = await page.evaluate(
    () =>
      new Promise((r) => {
        chrome.tabs.query({}, (lista) =>
          r((lista || []).filter((a) => (a.url || "").includes("options.html")).length)
        );
      })
  );

  assert.ok(abas >= 1, "deveria haver uma aba options.html aberta");
});

/* ===========================================================================
 * DASHBOARD — cartão "Primeiros passos"
 * ======================================================================== */

test("dashboard: mostra 'Primeiros passos' em vez de propaganda", async () => {
  await page.setViewportSize({ width: 1280, height: 900 });

  // instalação limpa: a página de campanhas cria um rascunho ao abrir, então
  // limpamos o storage antes de conferir o estado inicial do dashboard
  await page.evaluate(() => new Promise((r) => chrome.storage.local.clear(r)));
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  await sleep(3500);

  const info = await page.evaluate(() => {
    const cartao = document.querySelector("[data-lz-passos]");
    const visivel = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return {
      existe: !!cartao,
      texto: cartao ? cartao.innerText.replace(/\n+/g, " | ") : "",
      passos: cartao ? cartao.querySelectorAll("button").length : 0,
      corpo: document.body.innerText,
      membro: visivel(".product-spotlight"),
    };
  });

  assert.ok(info.existe, "o cartão 'Primeiros passos' deveria estar na tela");
  assert.match(info.texto, /Primeiros passos/);
  assert.match(info.texto, /[0-3] de 3/);
  assert.match(info.texto, /WhatsApp/);
  assert.match(info.texto, /campanha/i);
  // acabamos de limpar o storage: o passo da campanha tem de estar pendente
  assert.match(info.texto, /○ \| Crie uma campanha/, "campanha limpa volta a ficar pendente");
  assert.ok(info.passos >= 1, "todo passo pendente tem um botão de ação");

  assert.doesNotMatch(info.corpo, /Tutoriais e FAQ/);
  assert.doesNotMatch(info.corpo, /Suporte e atendimento/);
  assert.doesNotMatch(info.corpo, /Nossos materiais/);
  assert.doesNotMatch(info.corpo, /Adicionar membro/);
});

test("dashboard: criar uma campanha marca o passo como concluído", async () => {
  await page.evaluate(
    () =>
      new Promise((r) => {
        chrome.storage.local.set(
          {
            "campaigns:camp-teste": {
              id: "camp-teste",
              nome: "Minha campanha",
              contatos: [],
              status: "rascunho",
            },
          },
          r
        );
      })
  );

  // o cartão reavalia sozinho
  await page.waitForFunction(
    () => {
      const c = document.querySelector("[data-lz-passos]");
      return c && /1 de 3/.test(c.innerText);
    },
    { timeout: 15000 }
  );

  const texto = await page.evaluate(() =>
    document.querySelector("[data-lz-passos]").innerText.replace(/\n+/g, " | ")
  );

  assert.match(texto, /1 de 3/);
  assert.match(texto, /✓/, "o passo concluído ganha marca de visto");
});

test("dashboard: WhatsApp Web aberto conclui o primeiro passo", async () => {
  // abre uma aba de verdade em web.whatsapp.com (servida localmente)
  await ctx.route("https://web.whatsapp.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><div id=pane-side></div></body></html>",
    })
  );

  const wpp = await ctx.newPage();
  await wpp.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded" });
  await sleep(800);

  // estado conhecido: só a aba do WhatsApp, nada mais
  await page.evaluate(() => new Promise((r) => chrome.storage.local.clear(r)));
  await page.reload({ waitUntil: "load" });

  await page.waitForFunction(
    () => {
      const c = document.querySelector("[data-lz-passos]");
      return c && /1 de 3/.test(c.innerText);
    },
    { timeout: 20000 }
  );

  const texto = await page.evaluate(() =>
    document.querySelector("[data-lz-passos]").innerText.replace(/\n+/g, " | ")
  );

  assert.match(texto, /1 de 3/);
  // o passo do WhatsApp ficou concluído e perdeu o botão de ação
  assert.match(texto, /✓ \| Abra o WhatsApp Web/);
  assert.doesNotMatch(texto, /Abrir WhatsApp/, "passo concluído não mostra mais a ação");

  await wpp.close();
  await ctx.unroute("https://web.whatsapp.com/**");
});

test("dashboard: cartão não atrapalha os outros menus", async () => {
  await page.click('text="Mensagens"');
  await sleep(1500);

  const apareceu = await page.evaluate(() => !!document.querySelector("[data-lz-passos]"));
  assert.equal(apareceu, false, "o cartão é do dashboard, não das outras telas");

  await page.click('text="Dashboard"').catch(() => {});
  await sleep(1200);
});

test("dashboard: nenhuma requisição para fora da extensão", async () => {
  const externos = [];
  const escuta = (req) => {
    const u = req.url();
    if (!u.startsWith("chrome-extension://") && !u.startsWith("data:")) externos.push(u);
  };
  page.on("request", escuta);

  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  await sleep(3000);

  page.off("request", escuta);
  assert.deepEqual(externos, [], "o dashboard não pode depender de nada externo");
});
