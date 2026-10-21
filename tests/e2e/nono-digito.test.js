"use strict";

/**
 * Nono dígito — a mesma linha em duas grafias.
 *
 * O número do usuário é 5586981638438 (com o 9), mas o WhatsApp dele responde
 * em 558681638438 (sem o 9). A regra implementada:
 *
 *   1. tenta sempre a forma COM o 9;
 *   2. se o WhatsApp recusar o número (falha confirmada), tenta SEM o 9,
 *      imediatamente, uma única vez;
 *   3. timeout/ambíguo NÃO repete — repetir duplicaria a mensagem.
 *
 * O WhatsApp falso abaixo recusa chatIds conforme o modo pedido, para provar
 * cada um dos três caminhos.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env");

const PORT = 4714;

const PAGINA_WPP = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"></head>
<body>
  <div id="pane-side"></div>
  <div class="app-wrapper-web"></div>
  <script>
    window.__ENVIOS = [];
    window.__MODO = "aceitar";

    // modos: aceitar | recusar-com-9 | recusar-sem-9 | ambiguo-com-9
    function decidir(chatId) {
      var d = String(chatId || "").replace(/@.*$/, "");
      var comNove = d.length === 13 && d.slice(4).charAt(0) === "9";
      if (window.__MODO === "recusar-com-9" && comNove) {
        return { success: false, error: "número não está no WhatsApp" };
      }
      if (window.__MODO === "ambiguo-com-9" && comNove) {
        // o motor trata isto como "não sabemos se chegou", não como recusa
        return { success: false, error: "sem resposta do WhatsApp (timeout)" };
      }
      if (window.__MODO === "recusar-sem-9" && !comNove) {
        return { success: false, error: "número não está no WhatsApp" };
      }
      return { success: true };
    }

    ["messages:sendTextRequest", "messages:sendMediaRequest",
     "messages:sendAudioRequest", "messages:sendDocumentRequest"].forEach(function (nome) {
      window.addEventListener(nome, function (e) {
        var d = e.detail || {};
        window.__ENVIOS.push({ chatId: d.chatId, evento: nome, em: Date.now() });

        setTimeout(function () {
          window.dispatchEvent(new CustomEvent("response_" + d.correlationId, {
            detail: decidir(d.chatId)
          }));
        }, 15);
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

beforeEach(async () => {
  for (const p of ctx.pages()) {
    if (p.url().startsWith("https://web.whatsapp.com")) await p.close().catch(() => {});
  }
  await sleep(200);
  wppPage = await ctx.newPage();
  await wppPage.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  await sleep(1200);

  if (page) await page.close().catch(() => {});
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/campaigns.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });
  await sleep(800);
});

/** Monta uma campanha com um contato só e o texto fixo. */
async function campanhaCom(numero) {
  await page.evaluate((numero) => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.id = "camp-nono";
    c.nome = "Nono dígito";
    c.contatos = [
      {
        id: "unico",
        indice: 0,
        numero: numero,
        bruto: numero,
        status: C.ITEM.PENDENTE,
        tentativas: 0,
        erro: null,
        enviadoEm: null,
      },
    ];
    c.texto = { modo: "fixo", textoFixo: "oi" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.pastas = [];
    c.status = "rascunho";
    c.cursor = 0;
    c.protecoes = { pausarAposFalhas: 0, limiteDiario: 0 };
    c.ritmo = {
      intervaloMin: 0,
      intervaloMax: 0,
      loteMin: 100,
      loteMax: 100,
      pausaLoteMin: 0,
      pausaLoteMax: 0,
    };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  }, numero);
}

const modo = (m) => wppPage.evaluate((m) => (window.__MODO = m), m);
const enviados = () => wppPage.evaluate(() => window.__ENVIOS || []);
const contato = () =>
  page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha().contatos[0]);

/* ========================================================================== */

test("número com 9 aceito: uma tentativa só, sem repetir", async () => {
  await modo("aceitar");
  await campanhaCom("5586981638438");
  await page.click("#btn-iniciar");
  await sleep(2500);

  const envios = await enviados();
  assert.equal(envios.length, 1, "não pode haver segunda tentativa quando a primeira funciona");
  assert.equal(envios[0].chatId, "5586981638438@c.us");

  const c = await contato();
  assert.equal(c.status, "enviado");
});

test("a forma com 9 é a PRIMEIRA tentativa mesmo quando o número foi digitado sem o 9", async () => {
  await modo("aceitar");
  await campanhaCom("558681638438");
  await page.click("#btn-iniciar");
  await sleep(2500);

  const envios = await enviados();
  assert.equal(envios.length, 1);
  assert.equal(envios[0].chatId, "5586981638438@c.us", "a forma canônica é tentada primeiro");
});

test("com 9 recusado: tenta sem o 9 imediatamente e entrega", async () => {
  await modo("recusar-com-9");
  await campanhaCom("5586981638438");
  await page.click("#btn-iniciar");
  await sleep(3000);

  const envios = await enviados();
  assert.equal(envios.length, 2, "exatamente duas tentativas");
  assert.equal(envios[0].chatId, "5586981638438@c.us", "primeira: com o 9");
  assert.equal(envios[1].chatId, "558681638438@c.us", "segunda: sem o 9");

  const c = await contato();
  assert.equal(c.status, "enviado", "a segunda tentativa entregou");
  assert.equal(c.erro || null, null);

  const log = await page.textContent("#log");
  assert.match(log, /Tentando 558681638438/, "o log precisa dizer que houve segunda tentativa");
});

test("resultado sem confirmação NÃO dispara a segunda tentativa (evita duplicar)", async () => {
  await modo("ambiguo-com-9");
  await campanhaCom("5586981638438");
  await page.click("#btn-iniciar");
  await sleep(4000);

  const envios = await enviados();
  assert.equal(envios.length, 1, "sem resposta não é recusa: não pode reenviar");

  const c = await contato();
  assert.equal(c.status, "desconhecido", "resultado sem confirmação tem status próprio");
});

test("as duas formas recusadas: falha registrada uma vez, sem laço", async () => {
  // recusa qualquer chatId
  await wppPage.evaluate(() => {
    window.__MODO = "aceitar";
    window.__ENVIOS.length = 0;
    const original = window.dispatchEvent.bind(window);
    window.dispatchEvent = function (ev) {
      if (String(ev.type || "").indexOf("response_") === 0) {
        ev.detail.success = false;
        ev.detail.error = "número não está no WhatsApp";
      }
      return original(ev);
    };
  });
  await campanhaCom("5586981638438");
  await page.click("#btn-iniciar");
  await sleep(3500);

  const envios = await enviados();
  assert.equal(envios.length, 2, "no máximo duas tentativas: com 9 e sem 9");

  const c = await contato();
  assert.equal(c.status, "falhou");
  assert.match(String(c.erro), /número não está no WhatsApp/);
});

test("fixo não ganha nono dígito inventado", async () => {
  await modo("aceitar");
  await campanhaCom("558633224455");
  await page.click("#btn-iniciar");
  await sleep(2500);

  const envios = await enviados();
  assert.equal(envios.length, 1);
  assert.equal(envios[0].chatId, "558633224455@c.us");
});
