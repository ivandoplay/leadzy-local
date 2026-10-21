"use strict";

const path = require("path");
const { chromium } = require("playwright");

const EXT = path.resolve(__dirname, "../../extensao");
const FIXTURES = path.resolve(__dirname, "../fixtures");
const LIBDIR = path.resolve(__dirname, "../libs/root/usr/lib/x86_64-linux-gnu");

// Chromium precisa das libs extraídas dos .deb (sem root no sandbox).
if (!process.env.LD_LIBRARY_PATH || !process.env.LD_LIBRARY_PATH.includes(LIBDIR)) {
  process.env.LD_LIBRARY_PATH = [LIBDIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

/**
 * Resolve o binário do Chromium.
 *
 * O diretório /opt/playwright/browsers é read-only neste sandbox e pode conter
 * uma revisão diferente da que a versão instalada do Playwright espera. Nesse
 * caso ele tenta baixar e falha com EACCES. Se já houver um chromium utilizável
 * no PATH de browsers, usamos direto via executablePath.
 */
function resolverChromium() {
  if (process.env.LZ_CHROMIUM_PATH) return process.env.LZ_CHROMIUM_PATH;

  const bases = (process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/playwright/browsers")
    .split(":")
    .filter(Boolean);

  const fs = require("fs");
  for (const base of bases) {
    let entradas;
    try {
      entradas = fs.readdirSync(base);
    } catch (e) {
      continue;
    }
    // prefere a revisão mais alta disponível
    const builds = entradas
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => parseInt(b.split("-")[1], 10) - parseInt(a.split("-")[1], 10));

    for (const b of builds) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const bin = path.join(base, b, rel);
        if (fs.existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

const CHROMIUM_BIN = resolverChromium();

async function launch(opts = []) {
  // aceita array de args (compat) ou { args, ext }
  const { args: extraArgs = [], ext = EXT } = Array.isArray(opts) ? { args: opts } : opts;
  const profile = `/tmp/lz-profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(CHROMIUM_BIN ? { executablePath: CHROMIUM_BIN } : { channel: "chromium" }),
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--no-sandbox",
      ...extraArgs,
    ],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const id = new URL(sw.url()).host;

  return { ctx, id, sw };
}

/** Coleta erros de página e qualquer requisição que tente sair para a Leadzy. */
function watch(page) {
  const pageErrors = [];
  const leadzyRequests = [];
  const failedRequests = [];

  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("request", (r) => {
    if (/leadzy\.com\.br/i.test(r.url())) leadzyRequests.push(r.url());
  });
  page.on("requestfailed", (r) => {
    if (/leadzy\.com\.br/i.test(r.url())) leadzyRequests.push(r.url() + " (failed)");
    else failedRequests.push(r.url());
  });

  return { pageErrors, leadzyRequests, failedRequests };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { EXT, FIXTURES, launch, watch, sleep };
