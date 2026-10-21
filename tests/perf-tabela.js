"use strict";

/**
 * Mede o custo da tabela de contatos nas duas versões da interface.
 *
 *   node perf-tabela.js            # tabela comparativa
 *   node perf-tabela.js --json     # só o JSON
 *
 * A versão "antes" é a de HEAD (5bbcd3c), que remontava a tabela inteira a
 * cada envio. A versão "depois" é a do workspace, com atualização incremental
 * por linha e paginação de 200 contatos. As duas rodam no mesmo Chromium, com
 * a mesma campanha sintética, para a comparação ser justa.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, sleep, EXT } = require("./lib/env.js");

const VOLUMES = [100, 500, 1000, 3000];
const EXT_ANTES = process.env.LZ_EXT_ANTES || path.join(os.tmpdir(), "ext-antes");

/** Cria uma cópia da extensão com a campanhas-ui.js de HEAD, se necessário. */
function prepararAntes() {
  if (fs.existsSync(path.join(EXT_ANTES, "js", "campaigns-ui.js"))) return EXT_ANTES;

  const { execSync } = require("child_process");
  const repo = path.resolve(__dirname, "..");
  const antigo = execSync("git show HEAD:extensao/js/campaigns-ui.js", {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  execSync(`rm -rf ${JSON.stringify(EXT_ANTES)}`);
  fs.cpSync(EXT, EXT_ANTES, { recursive: true });
  // a versão antiga não expunha a tabela; a exposição serve só para medir
  const comPonte = antigo.replace(
    "    estadoSalvamento: function () {",
    "    renderizarTabela: renderizarTabela,\n    estadoSalvamento: function () {"
  );
  if (comPonte === antigo) throw new Error("não achei a ponte na versão antiga");
  fs.writeFileSync(path.join(EXT_ANTES, "js", "campaigns-ui.js"), comPonte);
  return EXT_ANTES;
}

async function medir(ext, rotulo) {
  const { ctx, id } = await launch({ ext });
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/campaigns.html`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__LZ_CAMPANHA_UI__, { timeout: 20000 });
  await sleep(1000);

  const linhas = [];

  for (const n of VOLUMES) {
    const r = await page.evaluate(async (quantos) => {
      const C = window.LZCampanha;
      const ui = window.__LZ_CAMPANHA_UI__;
      const base = ui.getCampanha();

      const c = JSON.parse(JSON.stringify(base));
      c.id = "perf-" + quantos;
      c.nome = "Perf " + quantos;
      c.contatos = Array.from({ length: quantos }, (_, i) => ({
        id: "perf" + i,
        indice: i,
        numero: "5511999" + String(100000 + i),
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

      // carga completa da campanha (inclui a primeira pintura da tabela)
      const t0 = performance.now();
      ui.setCampanha(c);
      const carga = performance.now() - t0;

      // o que acontece a cada envio: marca 1 contato e redesenha
      const amostras = [];
      for (let k = 0; k < 5; k++) {
        const alvo = ui.getCampanha().contatos[k];
        C.marcarEnviado(ui.getCampanha(), alvo);
        const t1 = performance.now();
        ui.renderizarTabela();
        amostras.push(performance.now() - t1);
      }
      amostras.sort((a, b) => a - b);

      // custo de rolar/entrar na página com a tabela montada
      const nos = document.querySelectorAll("#corpo-tabela *").length;

      return {
        carga: +carga.toFixed(1),
        porEnvio: +amostras[2].toFixed(2),
        nos,
      };
    }, n);

    linhas.push({ contatos: n, ...r });
  }

  await ctx.close();
  return { rotulo, linhas };
}

(async () => {
  prepararAntes();

  const antes = await medir(EXT_ANTES, "antes");
  const depois = await medir(EXT, "depois");

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ antes, depois }, null, 2));
    return;
  }

  const par = (n) => {
    const a = antes.linhas.find((l) => l.contatos === n);
    const d = depois.linhas.find((l) => l.contatos === n);
    return { n, a, d };
  };

  console.log("contatos | carga antes | carga depois | envio antes | envio depois | nós antes | nós depois");
  console.log("---------+-------------+--------------+-------------+--------------+-----------+-----------");
  for (const n of VOLUMES) {
    const { a, d } = par(n);
    console.log(
      `${String(n).padStart(8)} | ${String(a.carga).padStart(11)} | ${String(d.carga).padStart(12)} | ` +
        `${String(a.porEnvio).padStart(11)} | ${String(d.porEnvio).padStart(12)} | ` +
        `${String(a.nos).padStart(9)} | ${String(d.nos).padStart(9)}`
    );
  }
  console.log("\nvalores em ms; carga = setCampanha + primeira pintura;");
  console.log("envio = mediana de 5 re-renderizações após marcar 1 contato como enviado.");
})();
