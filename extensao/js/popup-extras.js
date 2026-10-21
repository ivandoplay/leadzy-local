/**
 * popup-extras.js — melhorias do popup (camada aditiva).
 *
 * O popup original (popup.js) não é editado: este arquivo só acrescenta o que
 * falta e esconde o que não funciona sem servidor.
 *
 * O que faz:
 *  - acrescenta "Disparo em massa" e "Configurações" (as duas ações úteis);
 *  - esconde o botão "Leadzy CRM" e o anúncio "Leadzy Agentes", que apontam
 *    para o SaaS e não têm função local.
 *
 * As âncoras são as classes do próprio popup (.popup-shell, .status-overview,
 * .secondary-actions, .product-spotlight), que são estáveis.
 */
(function () {
  "use strict";

  if (typeof document === "undefined") return;

  function abrirEmAba(pagina) {
    var alvo;
    try {
      alvo = chrome.runtime.getURL(pagina);
    } catch (e) {
      alvo = pagina;
    }
    try {
      if (chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: alvo });
        return;
      }
    } catch (e) {}
    window.open(alvo, "_blank");
  }

  /** Botão no mesmo estilo dos que já existem no popup. */
  function botao(texto, primario, aoClicar) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = texto;
    b.setAttribute("data-lz-extra", "1");

    var modelo = document.querySelector(".popup-primary-action");
    b.className = modelo ? modelo.className : "lz-btn-primary";

    if (!primario) {
      b.className = b.className.replace("lz-btn-primary", "");
      b.style.background = "#fff";
      b.style.color = "#dc0a6b";
      b.style.border = "1px solid #f0c3d8";
    }

    b.style.flex = "1";
    b.style.height = "36px";
    b.style.borderRadius = "8px";
    b.style.fontSize = "13px";
    b.style.cursor = "pointer";

    b.addEventListener("click", aoClicar);
    return b;
  }

  /** Esconde o que só existe para vender o SaaS. */
  function limparSaaS() {
    var alvos = [".secondary-actions", ".product-spotlight"];
    alvos.forEach(function (sel) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
        el.style.display = "none";
      });
    });
  }

  /** Põe os atalhos entre o cabeçalho e o status. */
  function instalarAtalhos() {
    var shell = document.querySelector(".popup-shell");
    if (!shell) return false;
    if (shell.querySelector("[data-lz-atalhos]")) return true;

    var caixa = document.createElement("div");
    caixa.setAttribute("data-lz-atalhos", "1");
    caixa.style.cssText = "display:flex;gap:8px;padding:10px 0 4px;width:100%";

    caixa.appendChild(
      botao("Disparo em massa", true, function () {
        abrirEmAba("campaigns.html");
      })
    );
    caixa.appendChild(
      botao("Configurações", false, function () {
        abrirEmAba("options.html");
      })
    );

    var status = shell.querySelector(".status-overview");
    shell.insertBefore(caixa, status || shell.firstChild);
    return true;
  }

  function aplicar() {
    instalarAtalhos();
    limparSaaS();
  }

  var tentativas = 0;
  var timer = setInterval(function () {
    tentativas++;
    aplicar();
    if (tentativas > 40) clearInterval(timer);
  }, 150);

  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    new MutationObserver(function () {
      instalarAtalhos();
      limparSaaS();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", aplicar);
  } else {
    aplicar();
  }
})();
