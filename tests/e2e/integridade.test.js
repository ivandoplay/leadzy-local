"use strict";

/**
 * Integridade do estado durante o disparo.
 *
 * Estes testes existem por causa de uma auditoria externa que apontou riscos
 * de corrupção de estado: execução concorrente, edição da lista durante o
 * envio, falha parcial de mídia, recarga da página e erro de armazenamento.
 * Cada teste aqui reproduz um desses cenários de ponta a ponta.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { launch, sleep } = require("../lib/env.js");

const PORT = 4711;

const PAGINA_WPP = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"></head>
<body>
  <div id="pane-side"></div>
  <div class="app-wrapper-web"></div>
  <script>
    window.__ENVIOS = [];
    // todos os tipos: sem os eventos de mídia, um envio de imagem fica
    // esperando resposta até o timeout de 60s
    ["messages:sendTextRequest", "messages:sendMediaRequest",
     "messages:sendAudioRequest", "messages:sendDocumentRequest"].forEach(function (nome) {
      window.addEventListener(nome, function (e) {
        var d = e.detail || {};
        window.__ENVIOS.push({ chatId: d.chatId, evento: nome, em: Date.now() });
        // mídia pode ser atrasada para simular envio lento
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
  await sleep(1000);
  return wppPage;
}

async function abrirCampanhas() {
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/campaigns.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });

  // espera o carregamento do storage terminar. Sem isto, mexer nos dados
  // antes disso faz a campanha salva sobrescrever o que o teste montou.
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

/** Monta uma campanha com N contatos prontos para enviar. */
async function montarCampanha(quantos, extras = {}) {
  await page.evaluate(
    ({ quantos, extras }) => {
      const C = window.LZCampanha;
      const c = window.__LZ_CAMPANHA_UI__.getCampanha();
      c.contatos = Array.from({ length: quantos }, (_, i) => ({
        indice: i,
        numero: "5511999" + String(100000 + i),
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

const enviadosNoWpp = () => wppPage.evaluate(() => (window.__ENVIOS || []).length);

/* ===========================================================================
 * 1. Recarga com campanha em execução
 * ======================================================================== */

test("campanha 'executando' salva na máquina volta como interrompida, não travada", async () => {
  await abrirCampanhas();

  // simula o que fica no storage quando a aba morre no meio do disparo
  await page.evaluate(() => {
    return new Promise((r) => {
      chrome.storage.local.set(
        {
          "campaigns:camp-morta": {
            id: "camp-morta",
            nome: "Interrompida",
            status: "executando",
            cursor: 1,
            contatos: [
              { numero: "5511999990001", status: "enviado", enviadoEm: new Date().toISOString() },
              { numero: "5511999990002", status: "enviando" },
              { numero: "5511999990003", status: "pendente" },
            ],
            texto: { modo: "fixo", textoFixo: "oi" },
            opcoes: {},
            pastas: [],
            ritmo: { intervaloMin: 1, intervaloMax: 2, loteMin: 5, loteMax: 5, pausaLoteMin: 1, pausaLoteMax: 1 },
          },
          "campaigns:index": ["camp-morta"],
        },
        r
      );
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });
  await sleep(1500);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());

  assert.equal(c.status, "pausada", "não pode continuar dizendo 'executando'");
  assert.equal(c.contatos[0].status, "enviado", "quem já saiu continua enviado");
  assert.equal(c.contatos[1].status, "desconhecido", "envio interrompido é ambíguo");
  assert.equal(c.contatos[2].status, "pendente", "quem não começou continua na fila");
  assert.ok(c.contatos.every((x) => x.id), "contatos antigos ganham id");
});

test("a tela avisa sobre a interrupção e sobre o contato sem confirmação", async () => {
  const aviso = await page.evaluate(() => {
    const el = document.getElementById("aviso-salvamento");
    return { visivel: !el.classList.contains("oculto"), texto: el.innerText };
  });

  assert.equal(aviso.visivel, true, "deveria haver aviso na tela");
  assert.match(aviso.texto, /fechada/i);
  assert.match(aviso.texto, /SEM CONFIRMAÇÃO/i);
});

test("o contato ambíguo não é reenviado sozinho ao retomar", async () => {
  const wpp = await abrirWpp();

  await page.evaluate(() => {
    // só o contato pendente pode sair
    window.__LZ_CAMPANHA_UI__.retomar();
  });
  await sleep(3500);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  const numerosEnviados = await wpp.evaluate(() =>
    (window.__ENVIOS || []).map((e) => String(e.chatId).replace(/@.*$/, ""))
  );

  assert.ok(
    !numerosEnviados.includes("5511999990002"),
    "o contato sem confirmação NÃO pode ser reenviado automaticamente"
  );
  assert.equal(c.contatos[1].status, "desconhecido");

  await wpp.close();
});

/* ===========================================================================
 * 2. Concorrência
 * ======================================================================== */

test("vários cliques em Iniciar produzem uma única execução", async () => {
  const wpp = await abrirWpp();
  await montarCampanha(3);

  // quatro cliques seguidos, sem esperar
  await page.evaluate(() => {
    const b = document.getElementById("btn-iniciar");
    for (let i = 0; i < 4; i++) b.click();
  });
  await sleep(5000);

  const enviados = await enviadosNoWpp();
  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());

  assert.equal(enviados, 3, `cada contato deve sair uma vez só (saiu ${enviados})`);
  assert.equal(
    c.contatos.filter((x) => x.status === "enviado").length,
    3,
    "todos devem ficar marcados como enviados"
  );

  await wpp.close();
});

/* ===========================================================================
 * 3. Edição da lista durante o envio
 * ======================================================================== */

test("a lista fica travada enquanto o disparo está em andamento", async () => {
  const wpp = await abrirWpp();
  await montarCampanha(5, { intervalo: 1 });

  await page.click("#btn-iniciar");
  await sleep(800);

  const travada = await page.evaluate(() => {
    const campo = document.getElementById("lista");
    return { readOnly: campo.readOnly, cursor: campo.style.cursor };
  });

  assert.equal(travada.readOnly, true, "o campo deve ficar somente leitura");
  assert.equal(travada.cursor, "not-allowed");

  // tentar reescrever a lista não pode reconstruir os contatos
  const antes = await page.evaluate(() =>
    window.__LZ_CAMPANHA_UI__.getCampanha().contatos.map((x) => x.numero)
  );

  await page.evaluate((numeros) => {
    const campo = document.getElementById("lista");
    campo.value = numeros.slice(0, 2).join("\n");
    campo.dispatchEvent(new Event("input", { bubbles: true }));
  }, antes);
  await sleep(800);

  const depois = await page.evaluate(() =>
    window.__LZ_CAMPANHA_UI__.getCampanha().contatos.map((x) => x.numero)
  );

  assert.deepEqual(depois, antes, "a fila não pode mudar durante a execução");

  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await sleep(500);
  await wpp.close();
});

test("depois de cancelar, a lista volta a aceitar edição", async () => {
  const travada = await page.evaluate(() => document.getElementById("lista").readOnly);
  assert.equal(travada, false, "cancelar deve liberar o campo");
});

/* ===========================================================================
 * 4. Identidade do contato durante o envio
 * ======================================================================== */

test("resultado do envio fica no contato certo mesmo com a lista mexida", async () => {
  const wpp = await abrirWpp();
  await montarCampanha(3, { intervalo: 1 });

  await page.click("#btn-iniciar");
  await sleep(600);

  // mexe na estrutura por dentro, do jeito que uma edição faria
  await page.evaluate(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.contatos = [c.contatos[2], c.contatos[0], c.contatos[1]];
    c.contatos.forEach((x, i) => (x.indice = i));
  });

  await sleep(4000);

  const c = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.getCampanha());
  const enviados = c.contatos.filter((x) => x.status === "enviado");

  assert.equal(enviados.length, 3, "os três devem ser marcados como enviados");
  assert.equal(new Set(enviados.map((x) => x.id)).size, 3, "sem duplicar nem perder ninguém");

  await wpp.close();
});

/* ===========================================================================
 * 5. Falha de armazenamento
 * ======================================================================== */

test("erro ao gravar aparece na tela em vez de passar batido", async () => {
  await abrirCampanhas();
  await montarCampanha(1);

  const r = await page.evaluate(async () => {
    const original = chrome.storage.local.set;

    // simula cota estourada: o Chrome define lastError ANTES de chamar o cb
    chrome.storage.local.set = function (obj, cb) {
      Object.defineProperty(chrome.runtime, "lastError", {
        configurable: true,
        get: () => ({ message: "QUOTA_BYTES quota exceeded" }),
      });
      if (cb) cb();
    };

    const saida = {};
    try {
      await window.__LZ_CAMPANHA_UI__.salvarAgora();
      saida.resolveu = true;
    } catch (e) {
      saida.rejeitou = e.message;
    }

    saida.estado = window.__LZ_CAMPANHA_UI__.estadoSalvamento();
    const el = document.getElementById("aviso-salvamento");
    saida.aviso = { visivel: !el.classList.contains("oculto"), texto: el.innerText };

    chrome.storage.local.set = original;
    delete chrome.runtime.lastError;
    return saida;
  });

  // a gravação não pode "dar certo" quando falhou
  assert.equal(r.resolveu, undefined, "a Promise não pode resolver numa falha");
  assert.match(r.rejeitou, /armazenamento/i);
  assert.equal(r.estado.falhou, true, "o estado interno precisa registrar a falha");

  assert.equal(r.aviso.visivel, true, "o usuário precisa saber que não salvou");
  assert.match(r.aviso.texto, /NÃO foram salvas/i);
});

test("depois de uma gravação bem-sucedida o aviso some", async () => {
  const r = await page.evaluate(async () => {
    await window.__LZ_CAMPANHA_UI__.salvarAgora();
    const el = document.getElementById("aviso-salvamento");
    return {
      estado: window.__LZ_CAMPANHA_UI__.estadoSalvamento(),
      visivel: !el.classList.contains("oculto"),
    };
  });

  assert.equal(r.estado.falhou, false);
  assert.equal(r.visivel, false, "o aviso de erro não pode ficar na tela para sempre");
});

/* ===========================================================================
 * 6. CSV
 * ======================================================================== */

test("o CSV exportado bate com o cabeçalho", async () => {
  const csv = await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    C.marcarEnviado(c, c.contatos[0]);
    return C.relatorioCSV(c);
  });

  const linhas = csv.split("\n");
  assert.equal(linhas[0], "#,numero,status,enviado_em,erro,tentativas");
  assert.equal(linhas.length, 2);
  assert.match(linhas[1], /^0,5511\d+,enviado,/);
});

/* ===========================================================================
 * 7. Cancelamento no meio de uma sequência de partes
 * ======================================================================== */

test("cancelar impede o envio das partes seguintes do mesmo contato", async () => {
  const wpp = await abrirWpp();
  await abrirCampanhas();

  // duas pastas de mídia: o contato tem 3 partes (texto + 2 mídias)
  await page.evaluate(async () => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();

    // mídias pequenas gravadas direto no storage
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await new Promise((r) =>
      chrome.storage.local.set(
        {
          "campaigns:media:m1": png,
          "campaigns:media:m2": png,
        },
        r
      )
    );

    c.pastas = [
      { id: "pa", nome: "Fotos A", tipo: "imagem", itens: [{ id: "m1", nome: "a.png", tipo: "imagem" }] },
      { id: "pb", nome: "Fotos B", tipo: "imagem", itens: [{ id: "m2", nome: "b.png", tipo: "imagem" }] },
    ];
    c.contatos = [
      {
        indice: 0,
        numero: "5511999000111",
        bruto: "",
        status: C.ITEM.PENDENTE,
        tentativas: 0,
        erro: null,
        enviadoEm: null,
      },
    ];
    c.texto = { modo: "fixo", textoFixo: "primeira parte" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.status = "rascunho";
    c.cursor = 0;
    c.protecoes = { pausarAposFalhas: 0, limiteDiario: 0 };
    c.ritmo = { intervaloMin: 1, intervaloMax: 1, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  // mídia lenta: dá tempo de cancelar no meio da sequência
  await wpp.evaluate(() => {
    window.__ATRASO_MIDIA = 1500;
  });

  await page.click("#btn-iniciar");
  await sleep(500); // texto já saiu; a primeira mídia está no ar
  await page.evaluate(() => window.__LZ_CAMPANHA_UI__.cancelar(true));
  await sleep(2500);

  const plano = await page.evaluate(() => {
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    return c.contatos[0].envio.map((p) => ({ chave: p.chave, status: p.status }));
  });

  const texto = plano.find((p) => p.chave === "texto");
  assert.equal(texto.status, "enviado", "o que já saiu continua enviado");

  const naoIniciadas = plano.filter((p) => p.status === "pendente");
  assert.equal(
    naoIniciadas.length,
    1,
    `a segunda mídia não pode ter começado depois do cancelamento (pendentes: ${naoIniciadas.length})`
  );
  assert.strictEqual(naoIniciadas[0].chave, "midia:pb", "devia sobrar justamente a última parte");

  const envios = await wpp.evaluate(() => (window.__ENVIOS || []).length);
  assert.ok(envios <= 2, `não pode enviar a última parte depois do cancelamento (saíram ${envios})`);

  await wpp.close();
});

/* ===========================================================================
 * 8. Memória
 * ======================================================================== */

test("o dataURL é liberado da memória depois de enviado", async () => {
  const wpp = await abrirWpp();
  await abrirCampanhas();

  // 1. coloca uma mídia no storage e carrega para o cache
  const carregada = await page.evaluate(async () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await new Promise((r) => chrome.storage.local.set({ "campaigns:media:mem1": png }, r));
    return window.__LZ_CAMPANHA_UI__.carregarMidia("mem1");
  });

  assert.equal(carregada.carregada, true, "a mídia deveria carregar do storage");
  assert.equal(carregada.cache, 1, "depois de carregar, ela está na memória");

  // 2. envia a mídia numa campanha
  await page.evaluate(() => {
    const C = window.LZCampanha;
    const c = window.__LZ_CAMPANHA_UI__.getCampanha();
    c.pastas = [
      {
        id: "pm",
        nome: "Uma foto",
        tipo: "imagem",
        itens: [{ id: "mem1", nome: "x.png", tipo: "imagem" }],
      },
    ];
    c.contatos = [
      { numero: "5511999000333", bruto: "", status: C.ITEM.PENDENTE, tentativas: 0, erro: null, enviadoEm: null },
    ];
    c.texto = { modo: "fixo", textoFixo: "" };
    c.opcoes = { homoglifos: false, invisiveis: false, invisiveisQtd: 0 };
    c.status = "rascunho";
    c.cursor = 0;
    c.protecoes = { pausarAposFalhas: 0, limiteDiario: 0 };
    c.ritmo = { intervaloMin: 0, intervaloMax: 0, loteMin: 100, loteMax: 100, pausaLoteMin: 0, pausaLoteMax: 0 };
    window.__LZ_CAMPANHA_UI__.setCampanha(c);
  });

  await page.click("#btn-iniciar");
  await page.waitForFunction(
    () => {
      const c = window.__LZ_CAMPANHA_UI__.getCampanha();
      return c && c.status === "finalizada";
    },
    { timeout: 30000 }
  );

  const depois = await page.evaluate(() => window.__LZ_CAMPANHA_UI__.tamanhoCacheMidias());

  assert.equal(depois, 0, `o dataURL deveria sair da memória após o envio (sobrou ${depois})`);

  // o arquivo continua no storage: dá para reenviar sem perder nada
  const aindaNoStorage = await page.evaluate(() =>
    new Promise((r) =>
      chrome.storage.local.get(["campaigns:media:mem1"], (d) => r(!!d["campaigns:media:mem1"]))
    )
  );
  assert.equal(aindaNoStorage, true, "liberar memória não pode apagar o arquivo");

  await wpp.close();
});
