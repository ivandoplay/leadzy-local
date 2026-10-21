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

  /**
   * Lê o estado REAL de cada etapa.
   *
   * Duas armadilhas que existiam aqui:
   *  1. "existe aba do WhatsApp" não prova login — a aba pode estar no QR Code;
   *  2. "existe chave de campanha" não prova campanha configurada — a própria
   *     página de disparo cria um rascunho vazio ao abrir, o que marcava a
   *     etapa como concluída antes de o usuário fazer qualquer coisa.
   *
   * Para o WhatsApp, perguntamos à própria aba se ela está conectada (mesma
   * verificação usada antes de disparar). Para a campanha, exigimos conteúdo.
   */
  function lerEstado() {
    var estado = { wpp: false, wppMotivo: "", campanha: false, mensagem: false };

    var comAbas = new Promise(function (resolve) {
      try {
        chrome.tabs.query({}, function (abas) {
          resolve(abas || []);
        });
      } catch (e) {
        resolve([]);
      }
    });

    return comAbas
      .then(function (abas) {
        var abasWpp = (abas || []).filter(function (a) {
          return (a.url || "").indexOf("https://web.whatsapp.com") === 0 ||
                 (a.url || "").indexOf("https://web.whatsapp.com") !== -1;
        });

        if (!abasWpp.length) {
          estado.wppMotivo = "nenhuma aba do WhatsApp Web aberta";
          return estado;
        }

        // pergunta a cada aba se ela está de fato conectada
        return perguntarAosWhatsApps(
          abasWpp.map(function (a) {
            return a.id;
          })
        ).then(function (r) {
          estado.wpp = !!(r && r.conectado);
          estado.wppMotivo = estado.wpp ? "" : (r && r.motivo) || "não conectado";
          return estado;
        });
      })
      .then(function (e1) {
        var estadoFinal = e1;
        return new Promise(function (resolve) {
          try {
            chrome.storage.local.get(null, function (dados) {
              var d = dados || {};

              // campanha só conta se tiver contatos E conteúdo para enviar
              var chaves = Object.keys(d).filter(function (k) {
                return k.indexOf("campaigns:camp-") === 0;
              });
              estadoFinal.campanha = chaves.some(function (k) {
                var c = d[k];
                if (!c || !Array.isArray(c.contatos) || !c.contatos.length) return false;

                var temTexto = false;
                try {
                  temTexto = !!(
                    c.texto &&
                    ((c.texto.modo === "rotacao" &&
                      (c.texto.rotacao || []).some(function (t) {
                        return t && String(t).trim();
                      })) ||
                      (c.texto.textoFixo && String(c.texto.textoFixo).trim()))
                  );
                } catch (err) {}

                var temMidia = (c.pastas || []).some(function (p) {
                  return p && p.itens && p.itens.length;
                });

                return temTexto || temMidia;
              });

              var lista = d.messageList;
              estadoFinal.mensagem = !!(
                lista && (Array.isArray(lista) ? lista.length : true)
              );

              resolve(estadoFinal);
            });
          } catch (err) {
            resolve(estadoFinal);
          }
        });
      });
  }

  /** Injeta a checagem na aba do WhatsApp e devolve o resultado. */
  /**
   * Pergunta a todas as abas do WhatsApp Web e combina as respostas.
   *
   * Uma conta conectada vale mesmo que outra aba esteja parada no QR Code,
   * então "conectado" ganha de qualquer resposta negativa. Se nenhuma estiver
   * pronta, o motivo mais explicativo é o que o usuário vê.
   */
  function perguntarAosWhatsApps(tabIds) {
    var lista = (tabIds || []).slice(0, 6);
    if (!lista.length) return Promise.resolve(null);

    return Promise.all(lista.map(perguntarAoWhatsApp)).then(function (respostas) {
      var validas = respostas.filter(Boolean);
      if (!validas.length) return null;

      var conectada = validas.filter(function (r) {
        return r.conectado;
      })[0];
      if (conectada) return conectada;

      var ordem = ["o WhatsApp está pedindo QR Code", "não conectado"];
      for (var i = 0; i < ordem.length; i++) {
        var achou = validas.filter(function (r) {
          return r.motivo === ordem[i];
        })[0];
        if (achou) return achou;
      }
      return validas[0];
    });
  }

  function perguntarAoWhatsApp(tabId) {
    return new Promise(function (resolve) {
      if (!chrome.scripting || !chrome.scripting.executeScript) return resolve(null);

      chrome.scripting.executeScript(
        {
          target: { tabId: tabId },
          world: "MAIN",
          func: function () {
            var painel = document.querySelector("#pane-side");
            var app = document.querySelector(".app-wrapper-web");
            var qr =
              document.querySelector("canvas[aria-label]") ||
              document.querySelector("[data-ref]") ||
              document.querySelector(".qrcode");

            if (!app && !painel) {
              return { conectado: false, motivo: "a página ainda não carregou" };
            }
            if (!painel && qr) {
              return { conectado: false, motivo: "o WhatsApp está pedindo QR Code" };
            }
            if (!painel) {
              return { conectado: false, motivo: "não conectado" };
            }
            return { conectado: true };
          },
        },
        function (r) {
          // erro de injeção (aba fechada, página restrita) não pode travar o cartão
          void (chrome.runtime && chrome.runtime.lastError);
          var res = r && r[0] && r[0].result;
          resolve(res || null);
        }
      );
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
      var dica = p.dica;
      if (p.id === "wpp" && !feito && estado.wppMotivo) {
        dica = "Pendente: " + estado.wppMotivo + ".";
      }

      texto.innerHTML =
        '<div style="font-size:14px;color:' +
        (feito ? "#9ca3af" : "#1f2937") +
        ";text-decoration:" +
        (feito ? "line-through" : "none") +
        '">' +
        p.titulo +
        "</div>" +
        '<div style="font-size:12px;color:#9ca3af;margin-top:1px">' +
        dica +
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

  // Reavalia quando abas abrem/fecham ou mudam de URL: a etapa do WhatsApp
  // depende disso e antes só era checada no carregamento.
  try {
    chrome.tabs.onUpdated.addListener(function () {
      setTimeout(atualizarCartao, 800);
    });
    chrome.tabs.onRemoved.addListener(function () {
      setTimeout(atualizarCartao, 400);
    });
  } catch (e) {}

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
