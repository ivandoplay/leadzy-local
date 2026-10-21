/**
 * dashboard-extras.js — melhorias do dashboard (camada aditiva).
 *
 * options.js continua intacto. Este arquivo:
 *  - esconde o que depende do SaaS (anúncios, "Adicionar membro", "+1");
 *  - acrescenta o cartão "Primeiros passos", com estado ao vivo.
 *
 * O cartão existe porque, numa instalação nova, o dashboard mostrava uma tela
 * vazia com três propagandas e nenhuma instrução de como começar.
 */
(function () {
  "use strict";

  if (typeof document === "undefined") return;

  var soDashboard = function () {
    return /#\/dashboard/.test(location.hash) || !location.hash;
  };

  function url(p) {
    try {
      return chrome.runtime.getURL(p);
    } catch (e) {
      return p;
    }
  }

  function abrir(pagina) {
    var alvo = typeof pagina === "string" && pagina.charAt(0) === "#" ? pagina : url(pagina);
    if (alvo === pagina) {
      location.hash = pagina;
      return;
    }
    try {
      if (chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: alvo });
        return;
      }
    } catch (e) {}
    window.open(alvo, "_blank");
  }

  /* ------------------------------------------------------------------ *
   * 1. Esconder o que depende do SaaS
   * ------------------------------------------------------------------ */

  var ESCONDER = [
    "Tutoriais e FAQ",
    "Suporte e atendimento",
    "Nossos materiais",
    "Adicionar membro",
    "+1",
  ];

  // Onde os cartões de propaganda ficavam: é ali que o "Primeiros passos"
  // entra, aproveitando a coluna da direita em vez de deixá-la vazia.
  var colunaLivre = null;

  function esconderSaaS() {
    Array.prototype.forEach.call(document.querySelectorAll("h4,h3,p,span,button"), function (el) {
      var t = (el.textContent || "").trim();
      if (ESCONDER.indexOf(t) === -1) return;

      // sobe até o cartão (bloco com borda/fundo) sem subir demais
      var bloco = el;
      for (var i = 0; i < 4 && bloco.parentElement; i++) {
        var cls = String(bloco.className || "");
        if (/rounded-2xl|rounded-xl|card/.test(cls) || bloco.tagName === "BUTTON") break;
        bloco = bloco.parentElement;
      }
      if (!bloco || bloco === document.body) return;

      // guarda a coluna que vai ficar vazia
      var pai = bloco.parentElement;
      for (var k = 0; k < 3 && pai; k++) {
        if (/grid/.test(String(pai.className || "")) && pai.parentElement) {
          colunaLivre = pai;
          break;
        }
        pai = pai.parentElement;
      }

      bloco.style.display = "none";
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. Cartão "Primeiros passos"
   * ------------------------------------------------------------------ */

  var PASSOS = [
    {
      id: "wpp",
      titulo: "Abra o WhatsApp Web",
      dica: "O disparo usa a sua sessão. Precisa estar logado.",
      acao: "Abrir WhatsApp",
      aoClicar: function () {
        try {
          chrome.tabs.create({ url: "https://web.whatsapp.com" });
        } catch (e) {}
      },
    },
    {
      id: "campanha",
      titulo: "Crie uma campanha",
      dica: "Cole a lista de números e escreva a mensagem.",
      acao: "Abrir disparo",
      aoClicar: function () {
        abrir("campaigns.html");
      },
    },
    {
      id: "mensagem",
      titulo: "Monte sua biblioteca",
      dica: "Textos, áudios e imagens para reusar.",
      acao: "Ver mensagens",
      aoClicar: function () {
        abrir("#/messages");
      },
    },
  ];

  function lerEstado() {
    return new Promise(function (resolve) {
      var estado = { wpp: false, campanha: false, mensagem: false };

      try {
        chrome.tabs.query({}, function (abas) {
          estado.wpp = (abas || []).some(function (a) {
            // a URL é "https://web.whatsapp.com/..." — comparar o início com
            // o domínio puro nunca casava
            return (a.url || "").indexOf("https://web.whatsapp.com") !== -1;
          });
          resolve(estado);
        });
      } catch (e) {
        resolve(estado);
      }
    }).then(function (estado) {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get(null, function (dados) {
            var chaves = Object.keys(dados || {});
            estado.campanha = chaves.some(function (k) {
              return k.indexOf("campaigns:camp-") === 0;
            });
            var lista = dados && dados.messageList;
            estado.mensagem = !!(lista && (Array.isArray(lista) ? lista.length : true));
            resolve(estado);
          });
        } catch (e) {
          resolve(estado);
        }
      });
    });
  }

  function montarCartao(estado) {
    var cartao = document.createElement("section");
    cartao.setAttribute("data-lz-passos", "1");
    cartao.style.cssText = [
      "background:#fff",
      "border:1px solid #f0dbe6",
      "border-radius:16px",
      "padding:18px 20px",
      "margin:0 0 18px",
      "width:100%",
      "box-sizing:border-box",
    ].join(";");

    var feitos = PASSOS.filter(function (p) {
      return estado[p.id];
    }).length;
    var completo = feitos === PASSOS.length;

    var titulo = document.createElement("div");
    titulo.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px";
    titulo.innerHTML =
      '<strong style="font-size:16px;color:#1f2937">' +
      (completo ? "Tudo pronto" : "Primeiros passos") +
      "</strong>" +
      '<span style="font-size:13px;color:#9ca3af">' +
      feitos +
      " de " +
      PASSOS.length +
      "</span>";
    cartao.appendChild(titulo);

    var intro = document.createElement("p");
    intro.style.cssText = "margin:4px 0 14px;font-size:13px;color:#6b7280";
    intro.textContent = completo
      ? "Sua extensão está configurada. Bom disparo!"
      : "Três coisas e você está pronto para disparar.";
    cartao.appendChild(intro);

    PASSOS.forEach(function (p) {
      var feito = !!estado[p.id];

      var linha = document.createElement("div");
      linha.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid #f7f2f5";

      var marca = document.createElement("span");
      marca.style.cssText = [
        "flex:0 0 22px",
        "width:22px",
        "height:22px",
        "border-radius:50%",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "font-size:12px",
        "font-weight:600",
        feito ? "background:#dcfce7;color:#15803d" : "background:#f3f4f6;color:#9ca3af",
      ].join(";");
      marca.textContent = feito ? "✓" : "○";

      var texto = document.createElement("div");
      texto.style.cssText = "flex:1;min-width:0";
      texto.innerHTML =
        '<div style="font-size:14px;color:' +
        (feito ? "#9ca3af" : "#1f2937") +
        ";text-decoration:" +
        (feito ? "line-through" : "none") +
        '">' +
        p.titulo +
        "</div>" +
        '<div style="font-size:12px;color:#9ca3af;margin-top:1px">' +
        p.dica +
        "</div>";

      linha.appendChild(marca);
      linha.appendChild(texto);

      if (!feito) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = p.acao;
        b.style.cssText =
          "flex:0 0 auto;padding:6px 12px;font-size:13px;border-radius:8px;" +
          "border:1px solid #f0dbe6;background:#fff;color:#dc0a6b;cursor:pointer";
        b.addEventListener("click", p.aoClicar);
        linha.appendChild(b);
      }

      cartao.appendChild(linha);
    });

    return cartao;
  }

  /** Cabeçalho do dashboard, usado quando a coluna da direita não existe. */
  function acharCabecalho() {
    var alvo = null;
    Array.prototype.some.call(document.querySelectorAll("h1,h2,p"), function (el) {
      if ((el.textContent || "").trim() === "O que vamos fazer hoje?") {
        alvo = el;
        return true;
      }
      return false;
    });
    if (!alvo) return null;
    // sobe até o bloco da saudação e usa o que vem depois dele
    var bloco = alvo.parentElement && alvo.parentElement.parentElement;
    return bloco || alvo.parentElement;
  }

  var ultimoEstado = null;

  function atualizarCartao() {
    if (!soDashboard()) {
      var velho = document.querySelector("[data-lz-passos]");
      if (velho) velho.remove();
      return;
    }

    var ancora = colunaLivre || acharCabecalho();
    if (!ancora) return;

    lerEstado().then(function (estado) {
      var assinatura = JSON.stringify(estado);
      var existente = document.querySelector("[data-lz-passos]");

      if (existente && assinatura === ultimoEstado) return;
      ultimoEstado = assinatura;

      var novo = montarCartao(estado);
      if (existente) {
        existente.replaceWith(novo);
      } else if (colunaLivre) {
        colunaLivre.insertBefore(novo, colunaLivre.firstChild);
      } else if (ancora && ancora.parentElement) {
        ancora.parentElement.insertBefore(novo, ancora.nextSibling);
      }
    });
  }

  function aplicar() {
    esconderSaaS();
    atualizarCartao();
  }

  var tentativas = 0;
  var timer = setInterval(function () {
    tentativas++;
    aplicar();
    if (tentativas > 60) clearInterval(timer);
  }, 250);

  // reage à navegação entre menus
  window.addEventListener("hashchange", function () {
    setTimeout(aplicar, 300);
  });

  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    var pendente = null;
    new MutationObserver(function () {
      if (pendente) return;
      pendente = setTimeout(function () {
        pendente = null;
        esconderSaaS();
        atualizarCartao();
      }, 400);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", aplicar);
  } else {
    aplicar();
  }
})();
