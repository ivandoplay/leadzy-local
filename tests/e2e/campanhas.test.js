"use strict";

/**
 * Disparo em massa — ponta a ponta.
 *
 * Sobe um WhatsApp Web falso (HTTPS, mapeado por DNS) que implementa o MESMO
 * barramento de comandos do wapi.js real:
 *     window.addEventListener("messages:sendTextRequest", ...)
 *     window.dispatchEvent(new CustomEvent("response_<id>", ...))
 *
 * Então abre a página de campanhas, configura tudo pela interface e dispara.
 * O teste falha se algum envio não chegar ao "WhatsApp".
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const PORT = 8444;

// Página que imita o barramento de comandos do wapi.
const PAGINA_WPP = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>WhatsApp</title></head>
<body>
  <div id="pane-side"></div>
  <div class="app-wrapper-web"><div class="two"></div></div>
  <script>
    window.__ENVIOS = [];
    var EVENTOS = {
      "messages:sendTextRequest": "texto",
      "messages:sendAudioRequest": "audio",
      "messages:sendMediaRequest": "imagem",
      "messages:sendDocumentRequest": "documento"
    };

    Object.keys(EVENTOS).forEach(function (nome) {
      window.addEventListener(nome, function (e) {
        var d = e.detail || {};
        var registro = {
          tipo: EVENTOS[nome],
          chatId: d.chatId,
          conteudo: d.content,
          base64: d.contentBase64 ? d.contentBase64.slice(0, 20) : null,
          tamanhoBase64: d.contentBase64 ? d.contentBase64.length : 0,
          arquivo: d.fileName,
          isPtt: d.isPtt,
          em: Date.now()
        };
        // simula um número que não existe no WhatsApp
        var soDigitos = String(d.chatId || "").replace(/@.*$/, "");
        var falhar = /0000$/.test(soDigitos);
        window.__ENVIOS.push(registro);
        setTimeout(function () {
          window.dispatchEvent(new CustomEvent("response_" + d.correlationId, {
            detail: falhar ? { success: false, error: "número não está no WhatsApp" } : { success: true }
          }));
        }, 20);
      });
    });
  </script>
</body></html>`;

let server, ctx, id, page, wppPage;
const saidas = [];

before(async () => {
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(__dirname, "../certs/key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "../certs/cert.pem")),
    },
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // /qr simula o WhatsApp esperando leitura do QR Code
      if (req.url && req.url.indexOf("/qr") === 0) {
        return res.end(
          `<!doctype html><html><body><div id="app"><canvas aria-label="Scan me!"></canvas></div></body></html>`
        );
      }
      res.end(PAGINA_WPP);
    }
  );
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const l = await launch([
    `--host-resolver-rules=MAP web.whatsapp.com 127.0.0.1:${PORT}`,
    "--ignore-certificate-errors",
  ]);
  ctx = l.ctx;
  id = l.id;
});

after(async () => {
  if (ctx) await ctx.close();
  if (server) await new Promise((r) => server.close(r));
});

/** Abre a aba do WhatsApp falso e deixa pronta. */
async function abrirWhatsAppFalso() {
  // O service worker cria uma aba do WhatsApp na instalação. Fechamos todas
  // antes de abrir a nossa, para o teste não enviar para a aba errada.
  for (const p of ctx.pages()) {
    if (p.url().startsWith("https://web.whatsapp.com")) await p.close().catch(() => {});
  }
  await sleep(300);

  wppPage = await ctx.newPage();
  await wppPage.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  await sleep(1500);
  return wppPage;
}

async function abrirCampanhas() {
  page = await ctx.newPage();
  page.on("request", (r) => {
    const u = r.url();
    if (/leadzy\.com\.br/i.test(u)) saidas.push(u);
  });
  await page.goto(`chrome-extension://${id}/campaigns.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });
  await sleep(600);
  return page;
}

const ENVIOS = () => wppPage.evaluate(() => window.__ENVIOS || []);

test("a página de disparo abre sem erro e sem rede externa", async () => {
  const erros = [];
  page = await ctx.newPage();
  page.on("pageerror", (e) => erros.push(e.message));
  await page.goto(`chrome-extension://${id}/campaigns.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });

  const titulo = await page.evaluate(() => document.querySelector("h2").textContent);
  assert.match(titulo, /lista de números/i);
  assert.deepStrictEqual(erros, []);
  assert.deepStrictEqual(saidas, []);
  await page.close();
});

test("criar campanha, colar lista e conferir a contagem", async () => {
  await abrirCampanhas();

  await page.fill("#nome", "Teste E2E");
  await page.fill(
    "#lista",
    ["(11) 99999-0001", "(11) 99999-0002", "(11) 99999-0003", "123", "(11) 99999-0001"].join("\n")
  );
  await page.click("#btn-analisar");
  await sleep(700);

  assert.strictEqual(await page.textContent("#n-validos"), "3");
  assert.strictEqual(await page.textContent("#n-invalidos"), "1");
  assert.strictEqual(await page.textContent("#n-duplicados"), "1");
});

test("os três modos de texto funcionam na interface", async () => {
  // fixo
  await page.click('.seg[data-modo="fixo"]');
  await page.fill("#texto-fixo", "Mensagem fixa");
  await sleep(200);

  // spintax: contador de variações
  await page.click('.seg[data-modo="spintax"]');
  await page.fill("#texto-fixo", "{Oi|Olá} {tudo bem|beleza}?");
  await sleep(300);
  assert.strictEqual(await page.textContent("#n-variacoes"), "4");

  // rotação
  await page.click('.seg[data-modo="rotacao"]');
  await sleep(300);
  const itens = await page.locator(".rotacao-item textarea").count();
  assert.ok(itens >= 1, "deveria ter ao menos um campo de rotação");
});

test("proteções são configuráveis e persistem no storage", async () => {
  // o input é visualmente escondido atrás do switch; o usuário clica no label
  await page.locator("#chk-homoglifos").check({ force: true });
  await sleep(200);
  await page.locator("#chk-invisiveis").check({ force: true });
  await sleep(200);

  const visivel = await page.locator("#invisiveis-opcoes").isVisible();
  assert.strictEqual(visivel, true, "as opções deveriam aparecer ao ligar o switch");

  await page.fill("#range-invisiveis", "6");
  await page.dispatchEvent("#range-invisiveis", "input");
  await sleep(700);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  assert.strictEqual(c.opcoes.homoglifos, true);
  assert.strictEqual(c.opcoes.invisiveis, true);
  assert.strictEqual(c.opcoes.invisiveisQtd, 6);
});

test("dispara de verdade e aplica homoglifos e invisíveis", async () => {
  const wpp = await abrirWhatsAppFalso();

  // campanha mínima e rápida: 3 contatos, sem espera
  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();

    c.contatos = ["5511999990001", "5511999990002", "5511999990003"].map((n, i) => ({
      indice: i,
      numero: n,
      bruto: n,
      nome: "",
      status: C.ITEM.PENDENTE,
      tentativas: 0,
      erro: null,
      enviadoEm: null,
    }));
    c.texto = { modo: "fixo", textoFixo: "Promocao especial pra voce" };
    c.opcoes = {
      homoglifos: true,
      homoglifosIntensidade: 100,
      invisiveis: true,
      invisiveisQtd: 4,
      invisiveisComEspaco: true,
    };
    c.ritmo = { intervaloMin: 0, intervaloMax: 0, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    c.pastas = [];

    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  await page.click("#btn-iniciar");
  await page.waitForFunction(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    return c && (c.status === "finalizada" || c.contatos.every((x) => x.status !== "pendente"));
  }, { timeout: 60000 });

  const enviados = await ENVIOS();
  assert.strictEqual(enviados.length, 3, `esperava 3 envios, veio ${enviados.length}`);

  assert.deepStrictEqual(
    enviados.map((e) => e.chatId).sort(),
    ["5511999990001@c.us", "5511999990002@c.us", "5511999990003@c.us"]
  );

  // homoglifos mudaram o texto
  assert.notStrictEqual(enviados[0].conteudo, "Promocao especial pra voce");
  assert.strictEqual(enviados[0].conteudo.length, "Promocao especial pra voce".length + 4);

  // invisíveis no final
  const cauda = enviados[0].conteudo.slice(-4);
  for (const ch of cauda) {
    assert.ok(
      ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u200A", "\u2009", "\u2063"].includes(ch),
      `esperava invisível, veio U+${ch.codePointAt(0).toString(16)}`
    );
  }

  // duas mensagens nunca saem iguais
  assert.notStrictEqual(enviados[0].conteudo, enviados[1].conteudo);

  // a finalização acontece logo depois do último envio
  await page.waitForFunction(
    () => window.__LZ_CAMPANHA_UI__.getCampanha().status === "finalizada",
    { timeout: 20000 }
  );

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  assert.strictEqual(c.status, "finalizada");
  assert.strictEqual(c.contatos.filter((x) => x.status === "enviado").length, 3);

  await wpp.close();
});

test("falha de envio é registrada no relatório com o motivo", async () => {
  const wpp = await abrirWhatsAppFalso();

  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [
      { indice: 0, numero: "5511999991111", bruto: "", status: C.ITEM.PENDENTE, tentativas: 0, erro: null, enviadoEm: null },
      { indice: 1, numero: "551199990000", bruto: "", status: C.ITEM.PENDENTE, tentativas: 0, erro: null, enviadoEm: null },
    ];
    c.status = "rascunho";
    c.cursor = 0;
    c.ritmo = { intervaloMin: 0, intervaloMax: 0, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  await page.click("#btn-iniciar");
  await page.waitForFunction(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    return c && c.contatos.every((x) => x.status !== "pendente" && x.status !== "enviando");
  }, { timeout: 60000 });

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  const falhou = c.contatos.find((x) => x.status === "falhou");
  assert.ok(falhou, "deveria haver um contato com falha");
  assert.match(falhou.erro, /não está no WhatsApp/);

  // reprocessar devolve para a fila
  const reprocessados = await page.evaluate(() => window.LZCampanha.reprocessarFalhas(window.__LZ_CAMPANHA_UI__.getCampanha()));
  assert.strictEqual(reprocessados, 1);

  await wpp.close();
});

test("mídia por pasta: envia um arquivo de CADA pasta", async () => {
  const wpp = await abrirWhatsAppFalso();

  // cria duas pastas com conteúdo simulado direto no storage
  await page.evaluate(async () => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();

    function dataUrl(texto) {
      return "data:audio/ogg;base64," + btoa(texto);
    }

    const itens = {
      "campaigns:media:t1": dataUrl("AAA"),
      "campaigns:media:t2": dataUrl("BBB"),
      "campaigns:media:t3": dataUrl("CCC"),
    };
    await new Promise((r) => chrome.storage.local.set(itens, r));

    c.pastas = [
      { id: "p1", nome: "Audio A", tipo: "audio", itens: [{ id: "t1", nome: "a1.ogg" }, { id: "t2", nome: "a2.ogg" }] },
      { id: "p2", nome: "Audio B", tipo: "audio", itens: [{ id: "t3", nome: "b1.ogg" }] },
    ];
    c.texto = { modo: "fixo", textoFixo: "Segue os audios" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.contatos = [
      { indice: 0, numero: "5511999992222", bruto: "", status: C.ITEM.PENDENTE, tentativas: 0, erro: null, enviadoEm: null },
    ];
    c.status = "rascunho";
    c.cursor = 0;
    c.ritmo = { intervaloMin: 0, intervaloMax: 0, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  await page.click("#btn-iniciar");
  await page.waitForFunction(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    return c && c.contatos.every((x) => x.status !== "pendente" && x.status !== "enviando");
  }, { timeout: 60000 });

  const enviados = await ENVIOS();
  const audios = enviados.filter((e) => e.tipo === "audio");

  assert.strictEqual(audios.length, 2, `esperava 2 áudios (um por pasta), veio ${audios.length}`);
  assert.ok(audios.every((a) => a.tamanhoBase64 > 0), "áudio foi enviado sem conteúdo");
  assert.ok(audios.every((a) => a.isPtt === true), "áudio deveria ir como mensagem de voz");

  await wpp.close();
});

test("pausar e retomar interrompem e retomam o disparo", async () => {
  const wpp = await abrirWhatsAppFalso();

  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = Array.from({ length: 3 }, (_, i) => ({
      indice: i,
      numero: "55119999933" + String(i).padStart(2, "0"),
      bruto: "",
      status: C.ITEM.PENDENTE,
      tentativas: 0,
      erro: null,
      enviadoEm: null,
    }));
    c.texto = { modo: "fixo", textoFixo: "oi" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.pastas = [];
    c.status = "rascunho";
    c.cursor = 0;
    // intervalo alto para dar tempo de pausar
    c.ritmo = { intervaloMin: 5, intervaloMax: 5, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  await page.click("#btn-iniciar");
  await sleep(2500); // primeiro já foi, está esperando o segundo

  await page.click("#btn-pausar");
  await sleep(300);
  const statusPausado = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().status);
  assert.strictEqual(statusPausado, "pausada");

  const enviadosAoPausar = (await ENVIOS()).length;

  await sleep(2000);
  const enviadosDepois = (await ENVIOS()).length;
  assert.strictEqual(enviadosDepois, enviadosAoPausar, "não deveria enviar nada enquanto pausado");

  await page.click("#btn-retomar");
  await page.waitForFunction(
    (n) => {
      const c = window.__LZ_CAMPANHA_UI__.getCampanha();
      return c.contatos.filter((x) => x.status === "enviado").length > n;
    },
    enviadosAoPausar,
    { timeout: 30000 }
  );

  const final = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().status);
  assert.ok(["executando", "finalizada"].includes(final));

  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await wpp.close();
});

test("remover contato pendente não afeta quem já recebeu", async () => {
  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [
      { indice: 0, numero: "5511999994401", bruto: "", status: C.ITEM.ENVIADO, tentativas: 1, erro: null, enviadoEm: new Date().toISOString() },
      { indice: 1, numero: "5511999994402", bruto: "", status: C.ITEM.PENDENTE, tentativas: 0, erro: null, enviadoEm: null },
    ];
    c.status = "rascunho";
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  const antes = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().contatos.length);

  // remove pela tabela (botão da linha pendente)
  const linhas = page.locator("#corpo-tabela tr");
  const total = await linhas.count();
  assert.ok(total >= 2);

  const resultado = await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    const rem = C.removerPendentes(c, ["5511999994402"]);
    return { rem, restantes: c.contatos.length };
  });

  assert.strictEqual(resultado.rem, 1);
  assert.strictEqual(resultado.restantes, antes - 1);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  assert.strictEqual(c.contatos[0].numero, "5511999994401");
  assert.strictEqual(c.contatos[0].status, "enviado");
});

test("o item de menu aparece na página de configurações", async () => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/options.html#/dashboard`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(
    () => !!document.querySelector("[data-lz-disparo]"),
    { timeout: 20000 }
  );
  const texto = await p.textContent("[data-lz-disparo] button");
  assert.match(texto, /Disparo em massa/);
  await p.close();
});

test("nenhuma requisição para a Leadzy durante todo o fluxo", async () => {
  assert.deepStrictEqual(saidas, [], `saiu para fora: ${JSON.stringify(saidas)}`);
});


/* ===========================================================================
 * MELHORIAS: ritmo preciso, travas de segurança, conexão
 * ======================================================================== */

test("o intervalo entre envios é preciso mesmo com a página travada", async () => {
  const wpp = await abrirWhatsAppFalso();

  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [0, 1].map((i) => ({
      indice: i,
      numero: "55119999955" + String(i).padStart(2, "0"),
      bruto: "",
      status: C.ITEM.PENDENTE,
      tentativas: 0,
      erro: null,
      enviadoEm: null,
    }));
    c.texto = { modo: "fixo", textoFixo: "ping" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.pastas = [];
    c.status = "rascunho";
    c.cursor = 0;
    c.protecoes = { pausarAposFalhas: 0, limiteDiario: 0 };
    // 3 s de intervalo
    c.ritmo = { intervaloMin: 3, intervaloMax: 3, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  await page.click("#btn-iniciar");

  // trava a thread principal por 2 s logo depois do primeiro envio
  await sleep(400);
  await page.evaluate(() => {
    const fim = Date.now() + 2000;
    while (Date.now() < fim) {
      /* trava de propósito */
    }
  });

  await page.waitForFunction(
    () => {
      const c = window.__LZ_CAMPANHA_UI__.getCampanha();
      return c.contatos.filter((x) => x.status === "enviado").length >= 2;
    },
    { timeout: 30000 }
  );

  const marcas = await ENVIOS();
  const dois = marcas.filter((e) => e.tipo === "texto").slice(-2);
  const intervalo = dois[1].em - dois[0].em;

  // com o bug antigo (conta ticks) seriam ~5000 ms
  assert.ok(
    intervalo >= 2800 && intervalo <= 4200,
    `intervalo fora do esperado: ${intervalo}ms (pedido 3000ms)`
  );

  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await wpp.close();
});

test("pausa sozinho depois de N falhas seguidas", async () => {
  const wpp = await abrirWhatsAppFalso();

  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    // todos terminam em 0000 -> o WhatsApp falso responde falha
    c.contatos = Array.from({ length: 6 }, (_, i) => ({
      indice: i,
      numero: "551199900000",
      bruto: "",
      status: C.ITEM.PENDENTE,
      tentativas: 0,
      erro: null,
      enviadoEm: null,
    }));
    // números distintos para não virarem duplicata
    c.contatos.forEach((x, i) => {
      x.numero = "5511999" + String(100000 + i) + "0000";
    });
    c.texto = { modo: "fixo", textoFixo: "oi" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.pastas = [];
    c.status = "rascunho";
    c.cursor = 0;
    c.protecoes = { pausarAposFalhas: 3, limiteDiario: 0 };
    c.ritmo = { intervaloMin: 0, intervaloMax: 0, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  await page.click("#btn-iniciar");

  await page.waitForFunction(
    () => {
      const c = window.__LZ_CAMPANHA_UI__.getCampanha();
      return c.status === "pausada";
    },
    { timeout: 30000 }
  );

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  assert.strictEqual(c.estatisticas.falhasConsecutivas, 3);
  assert.strictEqual(
    c.contatos.filter((x) => x.status === "pendente").length,
    3,
    "deveria sobrar metade da lista sem queimar"
  );

  await wpp.close();
});

test("não inicia se o WhatsApp está pedindo QR Code", async () => {
  // fecha as abas boas e abre a tela de QR
  for (const p of ctx.pages()) {
    if (p.url().startsWith("https://web.whatsapp.com")) await p.close().catch(() => {});
  }
  await sleep(300);
  const qrPage = await ctx.newPage();
  await qrPage.goto("https://web.whatsapp.com/qr", { waitUntil: "domcontentloaded" });
  await sleep(1200);

  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [
      { indice: 0, numero: "5511999997700", bruto: "", status: C.ITEM.PENDENTE, tentativas: 0, erro: null, enviadoEm: null },
    ];
    c.texto = { modo: "fixo", textoFixo: "oi" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.pastas = [];
    c.status = "rascunho";
    c.cursor = 0;
    c.ritmo = { intervaloMin: 0, intervaloMax: 0, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  // captura o alerta
  let mensagem = null;
  page.once("dialog", async (d) => {
    mensagem = d.message();
    await d.accept();
  });

  await page.click("#btn-iniciar");
  await sleep(3000);

  assert.ok(mensagem, "deveria avisar que o WhatsApp não está pronto");
  assert.match(mensagem, /QR Code|não está pronto/i);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  assert.strictEqual(c.status, "rascunho", "não pode ter começado");
  assert.strictEqual(c.contatos[0].status, "pendente", "nenhum contato pode ser queimado");

  await qrPage.close();
});

test("limite diário impede iniciar quando já foi atingido", async () => {
  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [
      { indice: 0, numero: "5511999998800", bruto: "", status: C.ITEM.PENDENTE, tentativas: 0, erro: null, enviadoEm: null },
    ];
    c.status = "rascunho";
    c.protecoes = { pausarAposFalhas: 5, limiteDiario: 2 };
    c.estatisticas = { dia: C.hoje(), enviadosHoje: 2, falhasConsecutivas: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  let mensagem = null;
  page.once("dialog", async (d) => {
    mensagem = d.message();
    await d.accept();
  });

  await page.click("#btn-iniciar");
  await sleep(1500);

  assert.ok(mensagem, "deveria avisar sobre o limite diário");
  assert.match(mensagem, /limite diário/i);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  assert.strictEqual(c.status, "rascunho");
});

test("as travas aparecem na interface e persistem", async () => {
  await page.fill("#prot-falhas", "7");
  await page.dispatchEvent("#prot-falhas", "input");
  await page.fill("#prot-limite", "150");
  await page.dispatchEvent("#prot-limite", "input");
  await sleep(800);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  assert.strictEqual(c.protecoes.pausarAposFalhas, 7);
  assert.strictEqual(c.protecoes.limiteDiario, 150);
});

test("o progresso é salvo mesmo gravando em lote", async () => {
  // grava a cada 10 envios; ao pausar, grava na hora
  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    for (let i = 0; i < 3; i++) {
      if (c.contatos[i]) {
        c.contatos[i].status = C.ITEM.ENVIADO;
        c.contatos[i].enviadoEm = new Date().toISOString();
      }
    }
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  // dispara um salvamento forçado pelo caminho normal (pausar grava)
  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.pausar());
  await sleep(1200);

  const salvo = await page.evaluate(
    () =>
      new Promise((r) => {
        chrome.storage.local.get(null, (d) => {
          const chave = Object.keys(d).find((k) => k.startsWith("campaigns:camp-"));
          r(chave ? JSON.parse(JSON.stringify(d[chave])).contatos.length : -1);
        });
      })
  );

  assert.ok(salvo > 0, "a campanha precisa estar no storage");
});
