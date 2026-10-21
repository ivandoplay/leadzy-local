"use strict";

/**
 * Backup e restauração (.lzb) — ponta a ponta.
 *
 * Exporta pela interface, valida o arquivo gerado (é um ZIP com o conteúdo
 * esperado) e restaura em um perfil limpo, conferindo que os dados voltam.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { launch, sleep } = require("../lib/env");

const TMP = "/tmp/lz-backup-test";

let ctx, id;
let arquivoBackup = null;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const l = await launch();
  ctx = l.ctx;
  id = l.id;
});

after(async () => {
  if (ctx) await ctx.close();
});

async function abrirMenuBackup(page) {
  await page.goto(`chrome-extension://${id}/options.html#/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await sleep(2200);

  await page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const cands = [...document.querySelectorAll("button")].filter(
      (e) => vis(e) && (e.innerText || "").includes("Usuário Local")
    );
    const b = cands.sort((a, b) => a.innerText.length - b.innerText.length).pop();
    if (b) b.click();
  });
  await sleep(1400);

  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")]
      .filter((e) => (e.innerText || "").trim() === "Backup e restauração" && e.children.length <= 4)
      .pop();
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      if (n.tagName === "BUTTON" || n.getAttribute("role")) break;
      n = n.parentElement;
    }
    (n || el).click();
  });
  await sleep(2200);
}

test("cria dados e exporta backup pela interface", async () => {
  const page = await ctx.newPage();

  // 1 mensagem de texto
  await page.goto(`chrome-extension://${id}/options.html#/messages`, {
    waitUntil: "domcontentloaded",
  });
  await sleep(2400);
  await page.getByText("Adicionar nova mensagem").first().click();
  await sleep(1000);
  await page.locator('input[placeholder*="Boas-vindas"]').fill("Msg do backup");
  await page.locator('textarea[placeholder*="Digite aqui"]').fill("conteudo que precisa voltar");
  await page.getByRole("button", { name: "Salvar mensagem" }).click();
  await sleep(1600);

  await abrirMenuBackup(page);

  const textoModal = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  assert.match(textoModal, /Download de Backup/, "modal de backup não abriu");
  assert.match(textoModal, /Total de mensagens\s*1/, "o modal não contabilizou a mensagem");

  // baixa o arquivo
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByRole("button", { name: /Fazer Download/i }).click(),
  ]);

  arquivoBackup = path.join(TMP, download.suggestedFilename() || "backup.lzb");
  await download.saveAs(arquivoBackup);

  const st = fs.statSync(arquivoBackup);
  assert.ok(st.size > 100, `backup vazio: ${st.size} bytes`);
  assert.match(path.basename(arquivoBackup), /\.lzb$/, "extensão do arquivo não é .lzb");

  await page.close();
});

test("o arquivo .lzb é um ZIP válido e contém a mensagem", () => {
  assert.ok(arquivoBackup && fs.existsSync(arquivoBackup), "backup não foi gerado");

  const destino = path.join(TMP, "extraido");
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });

  // unzip falha se não for ZIP válido
  execFileSync("unzip", ["-qo", arquivoBackup, "-d", destino]);

  const arquivos = execFileSync("find", [destino, "-type", "f"]).toString().trim().split("\n").filter(Boolean);
  assert.ok(arquivos.length > 0, "zip vazio");

  const conteudo = arquivos.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  assert.ok(
    conteudo.includes("Msg do backup"),
    `a mensagem não está no backup. Conteúdo: ${conteudo.slice(0, 300)}`
  );
});

test("restaura o backup em um perfil limpo", async () => {
  assert.ok(arquivoBackup && fs.existsSync(arquivoBackup), "backup não foi gerado");

  // perfil novo, sem dados
  const l = await launch();
  const ctx2 = l.ctx;
  const id2 = l.id;

  try {
    const page = await ctx2.newPage();
    await page.goto(`chrome-extension://${id2}/options.html#/messages`, {
      waitUntil: "domcontentloaded",
    });
    await sleep(2600);

    const antes = await page.evaluate(
      () => new Promise((r) => chrome.storage.local.get(["messageList"], r))
    );
    assert.ok(
      !antes.messageList || JSON.parse(antes.messageList).length === 0,
      "o perfil novo não deveria ter mensagens"
    );

    // abre o modal de backup no perfil novo
    await page.goto(`chrome-extension://${id2}/options.html#/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    await sleep(2200);
    await page.evaluate(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const b = [...document.querySelectorAll("button")]
        .filter((e) => vis(e) && (e.innerText || "").includes("Usuário Local"))
        .pop();
      if (b) b.click();
    });
    await sleep(1400);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")]
        .filter((e) => (e.innerText || "").trim() === "Backup e restauração" && e.children.length <= 4)
        .pop();
      let n = el;
      for (let i = 0; i < 4 && n; i++) {
        if (n.tagName === "BUTTON" || n.getAttribute("role")) break;
        n = n.parentElement;
      }
      (n || el).click();
    });
    await sleep(2200);

    // a restauração fica na segunda aba do modal
    const aba = await page.evaluate(() => {
      const t = [...document.querySelectorAll("div.lz-btn-navigation-secondary")].filter((e) =>
        /Restaura/i.test(e.innerText || "")
      );
      if (!t.length) return false;
      t[0].click();
      return true;
    });
    assert.ok(aba, "aba de restauração não encontrada");
    await sleep(1400);

    // envia o arquivo
    const input = page.locator('input[type="file"]').first();
    assert.ok((await input.count()) > 0, "input de restauração não existe");
    await input.setInputFiles(arquivoBackup);
    await sleep(3000);

    // resumo do que foi encontrado no arquivo
    const resumo = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    assert.match(resumo, /Foram encontrados no backup/, "o arquivo não foi lido como backup válido");
    assert.match(resumo, /Total de mensagens\s*1/, "o backup não contém a mensagem esperada");

    // "Carregar e Substituir" -> confirmação
    await page.getByRole("button", { name: /Carregar e Substituir/i }).click();
    await sleep(1800);

    const confirmar = page.getByRole("button", { name: /Sim, substituir tudo/i });
    assert.ok((await confirmar.count()) > 0, "modal de confirmação da restauração não apareceu");
    await confirmar.first().click();
    await sleep(5000);

    // algumas versões pedem "Concluir" e recarregam a página
    const concluir = page.getByRole("button", { name: /Concluir|Finalizar/i });
    if (await concluir.count()) {
      await concluir.last().click().catch(() => {});
      await sleep(3500);
    }

    const depois = await page.evaluate(
      () => new Promise((r) => chrome.storage.local.get(["messageList"], r))
    );
    const lista = JSON.parse(depois.messageList || "[]");
    assert.ok(
      lista.some((m) => m.title === "Msg do backup"),
      `a mensagem não voltou. storage: ${JSON.stringify(lista).slice(0, 260)}`
    );

    // e aparece na interface
    await page.goto(`chrome-extension://${id2}/options.html#/messages`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => (document.body.innerText || "").includes("Msg do backup"),
      { timeout: 20000 }
    );

    await page.close();
  } finally {
    await ctx2.close();
  }
});
