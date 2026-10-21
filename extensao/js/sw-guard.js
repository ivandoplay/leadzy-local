/* ============================================================================
 * Guarda de rede do service worker
 * ----------------------------------------------------------------------------
 * O local-bootstrap.js roda nas páginas (popup/options/content script), mas o
 * service worker é um contexto separado e NÃO é alcançado por ele. Este arquivo
 * fecha essa lacuna: qualquer fetch para *.leadzy.com.br feito a partir do
 * service worker é respondido localmente.
 *
 * Hoje o service worker não faz nenhuma chamada de rede (o sync de métricas é
 * um stub que devolve "desabilitado"), mas isso pode mudar. Com este guarda,
 * não muda nada para fora mesmo se mudar.
 * ========================================================================== */

(function () {
  "use strict";

  var G = typeof self !== "undefined" ? self : globalThis;
  if (G.__LZ_SW_GUARD__) return;
  G.__LZ_SW_GUARD__ = true;

  var HOST_RE = /(^|\.)leadzy\.com\.br$/i;

  var TOKEN = "local-offline.leadzy.0000000000.local";

  function isLeadzy(url) {
    if (!url) return false;
    try {
      return HOST_RE.test(new URL(url, "https://localhost/").hostname);
    } catch (e) {
      return false;
    }
  }

  function json(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      statusText: status && status >= 400 ? "Error" : "OK",
      headers: { "Content-Type": "application/json" },
    });
  }

  function resposta(url, method) {
    var path;
    try {
      path = new URL(url, "https://localhost/").pathname;
    } catch (e) {
      return json({});
    }

    if (path === "/auth/login") {
      return json({ access_token: TOKEN, token: TOKEN });
    }
    if (path === "/auth/me" || path === "/users/me" || path === "/me") {
      return json({
        id: "local-user",
        name: "Usuário Local",
        email: "local@localhost",
        organizationId: "local-org",
        status: "ACTIVE",
      });
    }
    if (path === "/plan-features/product-lines") {
      return json({ hasChat: true, hasCrm: false, isPro: true, activeProducts: ["CHAT"] });
    }
    if (path === "/subscriptions" || path === "/subscriptions/active") {
      return json([
        { id: "local-sub", status: "ACTIVE", plan: "CHAT", expiresAt: "2099-12-31T23:59:59.000Z" },
      ]);
    }
    if (path.indexOf("/feature-flags/") === 0) {
      return json({ enabled: false });
    }
    if (path === "/announcements/active") {
      return json([]);
    }
    if (path.indexOf("/notifications") === 0) {
      return json([]);
    }
    if (path === "/convert") {
      // No service worker não há DOM/Blob de áudio para remuxar com segurança:
      // devolve 501 para o chamador cair no fallback em vez de sair para a rede.
      return json({ error: "conversão não disponível no service worker" }, 501);
    }
    if ((method || "GET").toUpperCase() === "GET") return json([]);
    return json({ success: true });
  }

  var realFetch = G.fetch;
  if (typeof realFetch === "function") {
    G.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      if (!isLeadzy(url)) return realFetch.apply(this, arguments);

      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var r = resposta(url, method);
      // nunca deixa a requisição sair; devolve uma resposta local
      return Promise.resolve(r);
    };
  }

  // Service workers não têm XMLHttpRequest, mas se algum polyfill criar um,
  // ele passaria por aqui.
  if (typeof G.XMLHttpRequest === "undefined") {
    function Bloqueado() {
      throw new Error("XMLHttpRequest não está disponível no service worker");
    }
    G.XMLHttpRequest = Bloqueado;
  }

  G.__LZ_SW_IS_LEADZY__ = isLeadzy;
})();
