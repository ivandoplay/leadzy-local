"use strict";

/**
 * Regressão dos achados da auditoria de UI/UX e integridade.
 *
 * Cada teste corresponde a um ACHADO numerado do prompt de auditoria.
 * Todos rodam contra a extensão real no Chromium, com WhatsApp simulado.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env.js");

const PORT = 4712;

const PAGINA_WPP = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"></head>
<body>
  <div id="pane-side"></div>
  <div class="app-wrapper-web"></div>
  <script>
    window.__ENVIOS = [];
    ["messages:sendTextRequest", "messages:sendMediaRequest",
     "messages:sendAudioRequest", "messages:sendDocumentRequest"].forEach(function (nome) {
      window.addEventListener(nome, function (e) {
        var d = e.detail || {};
        window.__ENVIOS.push({ chatId: d.chatId, evento: nome, em: Date.now() });
        var espera = nome === "messages:sendTextRequest" ? 10 : (window.__ATRASO_MIDIA || 10);
        setTimeout(function () {
          window.dispatchEvent(new CustomEvent("response_" + d.correlationId, {
            detail: { success: true }
          }));
        }, espera);
      });
    });
  </script>
</body></html>`;

let server, ctx, id, page, wppPage;

before(async () => {
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(__dirname, "../certs/key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "../certs/cert.pem")),
    },
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (req.url && req.url.indexOf("/qr") === 0) {
        // WhatsApp esperando leitura do QR Code: sem #pane-side
        return res.end(
          '<!doctype html><html><body><div class="app-wrapper-web"><div id="app">' +
            '<canvas aria-label="Scan me"></canvas></div></div></body></html>'
        );
      }
      res.end(PAGINA_WPP);
    }
  );
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  ({ ctx, id } = await launch([
    `--host-resolver-rules=MAP web.whatsapp.com 127.0.0.1:${PORT}`,
    "--ignore-certificate-errors",
  ]));
});

after(async () => {
  if (ctx) await ctx.close();
  if (server) await new Promise((r) => server.close(r));
});

async function abrirWpp() {
  for (const p of ctx.pages()) {
    if (p.url().startsWith("https://web.whatsapp.com")) await p.close().catch(() => {});
  }
  await sleep(200);
  wppPage = await ctx.newPage();
  await wppPage.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  await sleep(900);
  return wppPage;
}

async function abrirCampanhas() {
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/campaigns.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const c = window.__LZ_CAMPANHA_UI__.getCampanha();
      return c && typeof c.id === "string" && !!document.getElementById("lista");
    },
    { timeout: 20000 }
  );
  await sleep(900);
  return page;
}

/** Zera o storage e deixa só a campanha indicada. */
async function isolarCampanha(campanha) {
  await page.evaluate(
    (c) =>
      new Promise((r) => {
        chrome.storage.local.clear(() => {
          if (!c) return r();
          const obj = {};
          obj["campaigns:" + c.id] = c;
          obj["campaigns:index"] = [c.id];
          chrome.storage.local.set(obj, r);
        });
      }),
    campanha
  );
}

async function montarCampanha(quantos, extras = {}) {
  await page.evaluate(
    ({ quantos, extras }) => {
      const C = window.LZCampanha;
      const c = window.__LZ_CAMPANHA_UI__.getCampanha();
      c.contatos = Array.from({ length: quantos }, (_, i) => ({
        id: "c" + i,
        indice: i,
        numero: "5511999" + String(200000 + i),
        bruto: "",
        status: C.ITEM.PENDENTE,
        tentativas: 0,
        erro: null,
        enviadoEm: null,
      }));
      c.texto = { modo: "fixo", textoFixo: extras.texto || "oi" };
      c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
      c.pastas = [];
      c.status = "rascunho";
      c.cursor = 0;
      c.protecoes = { pausarAposFalhas: 0, limiteDiario: 0 };
      c.ritmo = {
        intervaloMin: extras.intervalo || 0,
        intervaloMax: extras.intervalo || 0,
        loteMin: 100,
        loteMax: 100,
        pausaLoteMin: 0,
        pausaLoteMax: 0,
      };
      window.__LZ_CAMPANHA_UI__.setCampanha(c);
    },
    { quantos, extras }
  );
}

/* ===========================================================================
 * ACHADO 1 — troca de campanha durante a execução
 * ======================================================================== */

test("ACHADO 1: não dá para trocar de campanha durante o disparo", async () => {
  const wpp = await abrirWpp();
  await abrirCampanhas();
  await montarCampanha(6, { intervalo: 1 });

  // cria uma segunda campanha para tentar trocar
  const outraId = await page.evaluate(() => {
    return new Promise((r) => {
      chrome.storage.local.get(null, (d) => {
        const atual = window.__LZ_CAMPANHA_UI__.getCampanha();
        const outra = JSON.parse(JSON.stringify(atual));
        outra.id = "outra-campanha";
        outra.nome = "Outra";
        outra.status = "rascunho";
        const obj = { "campaigns:outra-campanha": outra };
        chrome.storage.local.set(obj, () => r("outra-campanha"));
      });
    });
  });

  await page.click("#btn-iniciar");
  await sleep(700);

  // tenta trocar pelo seletor
  page.once("dialog", (d) => d.accept());
  await page.evaluate(() => {
    const sel = document.getElementById("sel-campanha");
    sel.innerHTML += '<option value="outra-campanha">Outra</option>';
    sel.value = "outra-campanha";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(800);

  const depois = await page.evaluate(() => ({
    id: window.__LZ_CAMPANHA_UI__.getCampanha().id,
    status: window.__LZ_CAMPANHA_UI__.getCampanha().status,
  }));

  assert.notEqual(depois.id, outraId, "a campanha não pode ser trocada durante o disparo");
  assert.equal(depois.status, "executando", "o disparo continua sob controle");

  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await sleep(500);
  await wpp.close();
});

test("ACHADO 1: criar e excluir também são recusados durante o disparo", async () => {
  const wpp = await abrirWpp();
  await montarCampanha(5, { intervalo: 1 });
  await page.click("#btn-iniciar");
  await sleep(600);

  const antesId = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().id);

  let avisos = 0;
  const escuta = async (d) => {
    avisos++;
    await d.accept();
  };
  page.on("dialog", escuta);

  await page.click("#btn-nova").catch(() => {});
  await sleep(400);
  await page.click("#btn-excluir").catch(() => {});
  await sleep(400);

  page.off("dialog", escuta);

  const depoisId = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().id);

  assert.equal(depoisId, antesId, "nem criar nem excluir podem passar durante a execução");
  assert.ok(avisos >= 2, `as duas ações deviam explicar o bloqueio (avisos: ${avisos})`);

  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await sleep(400);
  await wpp.close();
});

test("ACHADO 1: depois de finalizar, trocar de campanha funciona", async () => {
  await montarCampanha(1);
  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    C.finalizar(c);
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });
  await sleep(300);

  const bloqueado = await page.evaluate(() => {
    const sel = document.getElementById("sel-campanha");
    return sel.disabled;
  });

  assert.equal(bloqueado, false, "fora de execução o seletor volta a funcionar");
});

/* ===========================================================================
 * ACHADO 3 — bloqueio da lista é único e coerente
 * ======================================================================== */

test("ACHADO 3: remover pendentes é recusado durante o disparo", async () => {
  const wpp = await abrirWpp();
  await montarCampanha(5, { intervalo: 1 });
  await page.click("#btn-iniciar");
  await sleep(600);

  const antes = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().contatos.length);

  page.once("dialog", (d) => d.accept());
  await page.click("#btn-limpar-pendentes").catch(() => {});
  await sleep(500);

  const depois = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().contatos.length);
  assert.equal(depois, antes, "a fila não pode encolher durante a execução");

  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await sleep(400);
  await wpp.close();
});

test("ACHADO 3: o botão Remover da linha some durante o disparo", async () => {
  const wpp = await abrirWpp();
  await montarCampanha(4, { intervalo: 1 });
  await page.click("#btn-iniciar");
  await sleep(700);

  const botoes = await page.evaluate(() => {
    const linhas = document.querySelectorAll("#corpo-tabela tr[data-contato]");
    let remover = 0;
    linhas.forEach((tr) => {
      if (tr.querySelector("button")) remover++;
    });
    return { linhas: linhas.length, comRemover: remover };
  });

  assert.equal(botoes.comRemover, 0, "nenhuma linha pode oferecer remoção durante o envio");

  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await sleep(500);

  // cancelar marca os pendentes como pulados; a fila volta a aceitar um novo
  // contato, e esse novo contato precisa poder ser removido de novo
  const depois = await page.evaluate(() => {
    const ui = window.__LZ_CAMPANHA_UI__;
    const c = ui.getCampanha();
    c.contatos.push({ id: "novo-1", numero: "5511988887777", status: "pendente" });
    ui.setCampanha(c);
    return new Promise((r) =>
      setTimeout(() => {
        let remover = 0;
        document.querySelectorAll("#corpo-tabela tr[data-contato]").forEach((tr) => {
          if (tr.querySelector("button")) remover++;
        });
        r({
          remover,
          limparHabilitado: !document.getElementById("btn-limpar-pendentes").disabled,
        });
      }, 400)
    );
  });

  assert.ok(depois.remover > 0, "depois de cancelar, a administração da fila volta");
  assert.ok(depois.limparHabilitado, "o botão de limpar pendentes volta a funcionar");

  await wpp.close();
});

/* ===========================================================================
 * ACHADO 4 — filtro de arquivo acompanha o tipo da pasta
 * ======================================================================== */

test("ACHADO 4: trocar o tipo da pasta troca o filtro do seletor de arquivos", async () => {
  await abrirCampanhas();

  const r = await page.evaluate(async () => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.pastas = [{ id: "p1", nome: "Pasta teste", tipo: "audio", itens: [] }];
    c.contatos = [];
    window.__LZ_CAMPANHA_UI__.setCampanha(c);

    // espera a interface desenhar a pasta
    await new Promise((res) => setTimeout(res, 300));

    const select = document.querySelector(".pasta-tipo select, select.pasta-tipo");
    const input = document.querySelector('input[type="file"]');
    if (!input) return { erro: "seletor de arquivo não encontrado" };

    const acceptInicial = input.accept;

    const seletor =
      select ||
      Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.value === "audio")
      );

    if (!seletor) return { erro: "seletor de tipo não encontrado" };

    seletor.value = "imagem";
    seletor.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((res) => setTimeout(res, 400));

    const novoInput = document.querySelector('input[type="file"]');
    return { acceptInicial, acceptFinal: novoInput.accept };
  });

  assert.ok(!r.erro, r.erro || "");
  assert.equal(r.acceptInicial, "audio/*");
  assert.equal(r.acceptFinal, "image/*", "o filtro tem de acompanhar o novo tipo");
});

test("ACHADO 4: arquivo incompatível é recusado mesmo passando pelo filtro", async () => {
  const r = await page.evaluate(() => {
    // o accept é só visual: o usuário pode escolher "todos os arquivos"
    const pastaAudio = { tipo: "audio" };
    const audio = new File([new Uint8Array([1, 2, 3])], "musica.ogg", { type: "audio/ogg" });
    const imagem = new File([new Uint8Array([1, 2, 3])], "foto.png", { type: "image/png" });
    const desconhecido = new File([new Uint8Array([1, 2, 3])], "arquivo.bin", {
      type: "application/octet-stream",
    });

    const ui = window.__LZ_CAMPANHA_UI__;
    if (!ui.compativel) return { semApi: true };

    return {
      audio: ui.compativel(audio, "audio"),
      imagemEmPastaDeAudio: ui.compativel(imagem, "audio"),
      binario: ui.compativel(desconhecido, "audio"),
    };
  });

  assert.equal(r.semApi, undefined, "a validação precisa estar exposta para teste");
  assert.equal(r.audio, true);
  assert.equal(r.imagemEmPastaDeAudio, false, "imagem não entra em pasta de áudio");
  assert.equal(r.binario, false, "tipo desconhecido é recusado");
});

/* ===========================================================================
 * ACHADO 6 — onboarding não marca etapa sem comprovação
 * ======================================================================== */

test("ACHADO 6: campanha vazia NÃO conclui a etapa", async () => {
  // isola: outras campanhas dos testes anteriores também contam
  await isolarCampanha({
    id: "camp-vazia",
    nome: "Rascunho",
    status: "rascunho",
    contatos: [],
    texto: { modo: "fixo", textoFixo: "" },
    pastas: [],
  });

  const dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  await sleep(3500);

  const texto = await dash.evaluate(() =>
    (document.querySelector("[data-lz-passos]") || {}).innerText || ""
  );

  assert.match(texto, /○\s*Crie uma campanha/, "registro vazio não é campanha configurada");
  await dash.close();
});

test("ACHADO 6: campanha com contatos e mensagem conclui a etapa", async () => {
  await isolarCampanha({
    id: "camp-pronta",
    nome: "Pronta",
    status: "rascunho",
    contatos: [{ id: "k1", numero: "5511999990001", status: "pendente" }],
    texto: { modo: "fixo", textoFixo: "olá" },
    pastas: [],
  });

  const dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  await sleep(3500);

  const texto = await dash.evaluate(() =>
    (document.querySelector("[data-lz-passos]") || {}).innerText || ""
  );

  assert.match(texto, /✓\s*Crie uma campanha/);
  await dash.close();
});

test("ACHADO 6: WhatsApp aberto no QR Code NÃO conclui a etapa", async () => {
  // fecha todas as abas e abre uma que está pedindo leitura do QR
  for (const p of ctx.pages()) {
    if (p.url().startsWith("https://web.whatsapp.com")) await p.close().catch(() => {});
  }
  const qr = await ctx.newPage();
  await qr.goto("https://web.whatsapp.com/qr", { waitUntil: "domcontentloaded" });
  await sleep(1200);

  const dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  await sleep(3500);

  const texto = await dash.evaluate(() =>
    (document.querySelector("[data-lz-passos]") || {}).innerText || ""
  );

  assert.match(texto, /○\s*Abra o WhatsApp Web/, "aba no QR Code não é WhatsApp pronto");
  assert.match(texto, /QR Code/, "a tela precisa dizer por que está pendente");

  await dash.close();
  await qr.close();
});


test("ACHADO 6: uma aba conectada basta, mesmo com outra parada no QR Code", async () => {
  // duas abas do WhatsApp: uma na tela inicial (sem pane-side) e outra pronta
  for (const p of ctx.pages()) {
    if (p.url().startsWith("https://web.whatsapp.com")) await p.close().catch(() => {});
  }
  const vazia = await ctx.newPage();
  await vazia.goto("https://web.whatsapp.com/vazia", { waitUntil: "domcontentloaded" });
  const pronta = await ctx.newPage();
  await pronta.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  await sleep(1000);

  await isolarCampanha(null);
  const dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
  await sleep(3500);

  const texto = await dash.evaluate(() =>
    (document.querySelector("[data-lz-passos]") || {}).innerText || ""
  );

  assert.match(texto, /✓\s*Abra o WhatsApp Web/, "aba conectada em qualquer aba conta");
  await dash.close();
  await vazia.close();
  await pronta.close();
});

/* ===========================================================================
 * ACHADO 7 — descrição da rotação corresponde ao motor
 * ======================================================================== */

test("ACHADO 7: a descrição da rotação fala em embaralhar, não em ordem", async () => {
  await abrirCampanhas();
  const texto = await page.evaluate(() => {
    const painel = document.getElementById("painel-rotacao");
    return painel ? painel.innerText.toLowerCase() : "";
  });

  assert.match(texto, /embaralh/, "o motor embaralha: a descrição precisa dizer isso");
  assert.doesNotMatch(
    texto,
    /alterna entre elas,\s*na ordem/,
    "descrição antiga dizia 'na ordem'"
  );
});

/* ===========================================================================
 * ACHADO 8 — estados expressivos
 * ======================================================================== */

test("ACHADO 8: o estado da execução tem selo próprio por situação", async () => {
  await abrirCampanhas();
  await montarCampanha(2);

  const ler = () =>
    page.evaluate(() => {
      const el = document.getElementById("estado-execucao");
      return el ? { texto: el.textContent, estado: el.getAttribute("data-estado") } : null;
    });

  const rascunho = await ler();
  assert.equal(rascunho.estado, "rascunho");

  await page.evaluate(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.status = "pausada";
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  const pausada = await ler();
  assert.equal(pausada.estado, "pausada");
  assert.match(pausada.texto, /Pausado/i);
});

test("ACHADO 8: contato sem confirmação vira aviso visível, não só log", async () => {
  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    C.marcarDesconhecido(c, c.contatos[0], "sem resposta em 60s");
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });
  await sleep(400);

  const aviso = await page.evaluate(() => {
    const el = document.getElementById("aviso-atencao");
    return { visivel: el && !el.classList.contains("oculto"), texto: el ? el.innerText : "" };
  });

  assert.equal(aviso.visivel, true, "o aviso precisa sair do log");
  assert.match(aviso.texto, /sem confirmação/i);
  assert.match(aviso.texto, /duplicar/i, "explica o risco de reenviar");
});

/* ===========================================================================
 * ACHADO 9 — estimativa com semântica explícita
 * ======================================================================== */

test("ACHADO 9: a estimativa fala em contatos, não em mensagens", async () => {
  const r = await page.evaluate(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
    return document.getElementById("estimativa").textContent;
  });

  const semPendentes = r === "—" || r.trim() === "";
  assert.ok(
    semPendentes || /contatos/.test(r),
    `a estimativa precisa dizer 'contatos': "${r}"`
  );
});

test("ACHADO 9: com mídia, a estimativa mostra as partes", async () => {
  const r = await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [0, 1, 2, 3].map((i) => ({
      id: "e" + i,
      numero: "5511999" + (300000 + i),
      status: C.ITEM.PENDENTE,
      tentativas: 0,
      erro: null,
      enviadoEm: null,
    }));
    c.texto = { modo: "fixo", textoFixo: "oi" };
    c.pastas = [
      { id: "pa", nome: "A", tipo: "imagem", itens: [{ id: "m1", nome: "a.png", tipo: "imagem" }] },
    ];
    c.ritmo = { intervaloMin: 60, intervaloMax: 60, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
    return document.getElementById("estimativa").textContent;
  });

  assert.match(r, /4 contatos/, `esperado 4 contatos, veio: ${r}`);
  assert.match(r, /8/, "com 1 mídia por contato, são 8 partes no total");
});

/* ===========================================================================
 * ACHADO 10 — indicador de salvamento
 * ======================================================================== */

test("ACHADO 10: existe indicador de salvamento com estado explícito", async () => {
  const r = await page.evaluate(async () => {
    const el = document.getElementById("estado-salvar");
    const inicial = el ? el.getAttribute("data-estado") : null;

    await window.__LZ_CAMPANHA_UI__.salvarAgora();
    return { inicial, final: el.getAttribute("data-estado"), texto: el.textContent };
  });

  assert.ok(r.inicial, "o indicador precisa existir");
  assert.equal(r.final, "salvo", "depois de gravar, o estado é 'salvo'");
  assert.match(r.texto, /Salvo/);
});

test("ACHADO 10: falha de gravação muda o indicador", async () => {
  const r = await page.evaluate(async () => {
    const original = chrome.storage.local.set;
    chrome.storage.local.set = function (obj, cb) {
      Object.defineProperty(chrome.runtime, "lastError", {
        configurable: true,
        get: () => ({ message: "QUOTA" }),
      });
      if (cb) cb();
    };

    let texto = null;
    try {
      await window.__LZ_CAMPANHA_UI__.salvarAgora();
    } catch (e) {}
    texto = document.getElementById("estado-salvar").getAttribute("data-estado");

    chrome.storage.local.set = original;
    delete chrome.runtime.lastError;
    return texto;
  });

  assert.equal(r, "falhou", "o indicador precisa refletir a falha");
});

/* ===========================================================================
 * ACHADO 11 — relatório: estado vazio e ações contextuais
 * ======================================================================== */

test("ACHADO 11: campanha sem contatos mostra estado vazio explicativo", async () => {
  await page.evaluate(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [];
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });
  await sleep(400);

  const r = await page.evaluate(() => {
    const vazio = document.querySelector("#corpo-tabela .estado-vazio");
    return { existe: !!vazio, texto: vazio ? vazio.innerText : "" };
  });

  assert.equal(r.existe, true, "o relatório vazio precisa explicar o que fazer");
  assert.match(r.texto, /Cole os números/i);
});

test("ACHADO 11: a coluna de ações tem nome acessível", async () => {
  const r = await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("#tabela-contatos thead th"));
    return ths.map((th) => ({ texto: th.textContent.trim(), escopo: th.getAttribute("scope") }));
  });

  const acao = r[r.length - 1];
  assert.equal(acao.texto, "Ação", "a última coluna não pode ficar sem nome");
  assert.ok(
    r.every((x) => x.escopo === "col"),
    "todas as colunas precisam de scope=col"
  );
});

/* ===========================================================================
 * ACHADO 12 — semântica e acessibilidade
 * ======================================================================== */

test("ACHADO 12: todas as páginas declaram português", async () => {
  for (const arquivo of ["campaigns.html", "popup.html", "options.html"]) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${id}/${arquivo}`, { waitUntil: "domcontentloaded" });
    await sleep(600);
    const lang = await p.evaluate(() => document.documentElement.lang);
    await p.close();
    assert.match(lang, /^pt/i, `${arquivo} declara lang="${lang}"`);
  }
});

test("ACHADO 12: a página tem um h1 e a numeração não salta", async () => {
  await abrirCampanhas();

  const r = await page.evaluate(() => ({
    h1: Array.from(document.querySelectorAll("h1")).map((h) => h.textContent.trim()),
    h2: Array.from(document.querySelectorAll("h2")).map((h) => h.textContent.trim()),
  }));

  assert.deepEqual(r.h1, ["Disparo em massa"], "deve existir exatamente um h1");

  const numeros = r.h2
    .map((t) => {
      const m = t.match(/^(\d+)[ab]?\./);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => n !== null);

  for (let i = 1; i < numeros.length; i++) {
    assert.equal(
      numeros[i],
      numeros[i - 1] + 1,
      `numeração saltou de ${numeros[i - 1]} para ${numeros[i]}: ${JSON.stringify(r.h2)}`
    );
  }
});

test("ACHADO 12: as abas têm semântica ARIA e navegação por teclado", async () => {
  const abas = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".segmentado [role='tab']")).map((b) => ({
      id: b.id,
      selecionada: b.getAttribute("aria-selected"),
      controla: b.getAttribute("aria-controls"),
      tabindex: b.getAttribute("tabindex"),
    }))
  );

  assert.equal(abas.length, 3);
  assert.ok(abas.every((a) => a.controla), "cada aba aponta para o seu painel");
  assert.equal(
    abas.filter((a) => a.selecionada === "true").length,
    1,
    "só uma aba selecionada por vez"
  );

  // seta para a direita muda de aba
  await page.focus("#aba-fixo");
  await page.keyboard.press("ArrowRight");
  await sleep(400);

  const depois = await page.evaluate(() => ({
    modo: window.__LZ_CAMPANHA_UI__.getCampanha().texto.modo,
    selecionada: document.getElementById("aba-spintax").getAttribute("aria-selected"),
  }));

  assert.equal(depois.modo, "spintax", "a seta precisa trocar o modo");
  assert.equal(depois.selecionada, "true");
});

test("ACHADO 12: a barra de progresso é um progressbar acessível", async () => {
  const r = await page.evaluate(() => {
    const barra = document.getElementById("progresso-barra");
    const pai = barra.parentElement;
    return {
      role: pai.getAttribute("role"),
      min: pai.getAttribute("aria-valuemin"),
      max: pai.getAttribute("aria-valuemax"),
      now: pai.getAttribute("aria-valuenow"),
      texto: pai.getAttribute("aria-valuetext"),
    };
  });

  assert.equal(r.role, "progressbar");
  assert.equal(r.min, "0");
  assert.equal(r.max, "100");
  assert.ok(r.now !== null, "aria-valuenow precisa acompanhar o progresso");
  assert.ok(r.texto, "um leitor de tela precisa da versão em texto");
});

test("ACHADO 12: o switch tem foco visível", async () => {
  const r = await page.evaluate(() => {
    const chk = document.getElementById("chk-homoglifos");
    chk.focus();
    const estilo = getComputedStyle(document.querySelector(".switch-linha .switch"));
    return { focado: document.activeElement === chk };
  });
  assert.equal(r.focado, true, "o checkbox escondido ainda precisa receber foco");
});

/* ===========================================================================
 * ACHADO 13 — nomenclatura honesta
 * ======================================================================== */

test("ACHADO 13: a seção não promete proteção contra bloqueio", async () => {
  const r = await page.evaluate(() => {
    const secoes = Array.from(document.querySelectorAll("h2")).map((h) => h.textContent);
    const corpo = document.body.innerText;
    return { secoes, corpo };
  });

  assert.ok(
    !r.secoes.some((t) => /anti-bloqueio/i.test(t)),
    "o título não pode prometer proteção: " + JSON.stringify(r.secoes)
  );

  assert.match(
    r.corpo,
    /não protegem\s+sua conta|não protegem sua conta/i,
    "a tela precisa dizer que as opções não protegem a conta"
  );
});

test("ACHADO 12: a página usa o mesmo cabeçalho, rodapé e paleta das outras telas", async () => {
  await abrirCampanhas();

  const r = await page.evaluate(() => {
    const topo = document.querySelector(".app-topo");
    const nav = document.querySelector(".app-nav");
    const links = nav ? Array.from(nav.querySelectorAll("a")).map((a) => a.textContent.trim()) : [];
    const ativo = nav ? nav.querySelector('[aria-current="page"]') : null;
    const rodape = document.querySelector(".rodape-novidades");
    const primario = document.querySelector("#btn-nova");
    const corpo = getComputedStyle(document.body);
    return {
      temTopo: !!topo,
      links,
      ativo: ativo ? ativo.textContent.trim() : null,
      temRodape: !!rodape,
      rodapeTexto: rodape ? rodape.innerText.trim() : "",
      corPrimaria: primario ? getComputedStyle(primario).backgroundColor : null,
      fundo: corpo.backgroundColor,
      fonte: corpo.fontFamily,
    };
  });

  assert.ok(r.temTopo, "a página precisa do cabeçalho do app");
  assert.deepEqual(r.links, [
    "Dashboard",
    "Mensagens",
    "Scripts",
    "Gatilhos",
    "Fluxos",
    "Disparo em massa",
  ]);
  assert.equal(r.ativo, "Disparo em massa", "a seção atual fica marcada no menu");

  assert.ok(r.temRodape, "a página precisa do rodapé que as outras telas têm");
  assert.match(r.rodapeTexto, /Novidades/);

  // mesma família de cor da marca das outras telas (antes era #ef345a, um
  // vermelho que não existia em lugar nenhum do app). É pink-700 e não
  // pink-600 porque o branco sobre pink-600 fica em 4,32:1, abaixo do AA.
  assert.equal(r.corPrimaria, "rgb(220, 0, 96)", "o botão principal usa o rosa da marca");
  assert.equal(r.fundo, "rgb(255, 255, 255)", "o fundo é branco, como no resto da extensão");
  assert.match(r.fonte, /Inter/);
});

/* ===========================================================================
 * ACHADO 12 (continuação) — tema escuro e contraste
 * ======================================================================== */

/** Luminância relativa e razão de contraste do WCAG. */
function contraste(corA, corB) {
  const partes = (c) => c.match(/[\d.]+/g).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const a = lum(partes(corA));
  const b = lum(partes(corB));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("ACHADO 12: a página segue o tema escuro escolhido no app", async () => {
  await abrirCampanhas();

  const claro = await page.evaluate(() => ({
    classe: document.documentElement.className,
    fundo: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(claro.classe.includes("dark"), false);
  assert.equal(claro.fundo, "rgb(255, 255, 255)");

  // é esta a chave que o menu do usuário grava nas outras telas
  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ isDarkMode: true }, r)));
  await sleep(600);

  const escuro = await page.evaluate(() => ({
    classe: document.documentElement.className,
    fundo: getComputedStyle(document.body).backgroundColor,
    cartao: getComputedStyle(document.querySelector(".card")).backgroundColor,
    texto: getComputedStyle(document.body).color,
  }));

  assert.equal(escuro.classe.includes("dark"), true, "a classe dark tem de ser aplicada");
  assert.equal(escuro.fundo, "rgb(25, 26, 28)", "mesmo fundo das outras telas no escuro");
  assert.equal(escuro.texto, "rgb(241, 242, 243)");

  // e sobrevive ao recarregar
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });
  await sleep(700);

  const aposReload = await page.evaluate(() => ({
    classe: document.documentElement.className,
    fundo: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(aposReload.classe.includes("dark"), true, "o tema tem de persistir no reload");
  assert.equal(aposReload.fundo, "rgb(25, 26, 28)");

  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ isDarkMode: false }, r)));
  await sleep(300);
});

test("ACHADO 12: texto e controles passam no contraste mínimo AA nos dois temas", async () => {
  await abrirCampanhas();

  for (const escuro of [false, true]) {
    await page.evaluate((d) => new Promise((r) => chrome.storage.local.set({ isDarkMode: d }, r)), escuro);
    await sleep(500);

    const c = await page.evaluate(() => {
      const g = (sel, prop) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el)[prop] : null;
      };
      return {
        fundo: g("body", "backgroundColor"),
        texto: g("body", "color"),
        cartao: g(".card", "backgroundColor"),
        titulo: g(".card h2", "color"),
        dica: g(".dica", "color"),
        campoFundo: g(".campo", "backgroundColor"),
        campoTexto: g(".campo", "color"),
        primarioFundo: g(".btn-primario", "backgroundColor"),
        primarioTexto: g(".btn-primario", "color"),
      };
    });

    const tema = escuro ? "escuro" : "claro";
    assert.ok(contraste(c.texto, c.fundo) >= 4.5, `texto/fundo no tema ${tema}`);
    assert.ok(contraste(c.titulo, c.cartao) >= 4.5, `título no tema ${tema}`);
    assert.ok(contraste(c.dica, c.cartao) >= 4.5, `texto de apoio no tema ${tema}`);
    assert.ok(contraste(c.campoTexto, c.campoFundo) >= 4.5, `texto do campo no tema ${tema}`);
    assert.ok(contraste(c.primarioTexto, c.primarioFundo) >= 4.5, `botão principal no tema ${tema}`);
  }

  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ isDarkMode: false }, r)));
  await sleep(300);
});
