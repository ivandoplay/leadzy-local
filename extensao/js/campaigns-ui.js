/* ============================================================================
 * Disparo em massa — interface e execução
 * ----------------------------------------------------------------------------
 * A lógica (números, spintax, homoglifos, ritmo, estado) está em
 * campaign-engine.js. Aqui fica só a ligação com a tela e com o WhatsApp.
 *
 * O envio usa o barramento de comandos que o wapi.js já tem dentro da aba do
 * WhatsApp Web:
 *     window.dispatchEvent(new CustomEvent("messages:sendTextRequest", ...))
 *     window.addEventListener("response_<correlationId>", ...)
 * Nada do bundle original é alterado.
 * ========================================================================== */

(function () {
  "use strict";

  var C = window.LZCampanha;
  var $ = function (id) {
    return document.getElementById(id);
  };

  /* ==========================================================================
   * ESTADO
   * ======================================================================== */

  var campanha = null;
  var ids = [];
  var midiasCache = Object.create(null); // itemId -> dataURL
  var execucao = null;
  var salvarTimer = null;

  var CHAVE_INDICE = "campaigns:index";
  var PREFIXO_CAMPANHA = "campaigns:";
  var PREFIXO_MIDIA = "campaigns:media:";

  function novoId(pre) {
    return pre + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  /* ==========================================================================
   * PERSISTÊNCIA
   * ======================================================================== */

  /**
   * Acesso ao storage que PROPAGA erro.
   *
   * As versões anteriores resolviam a Promise mesmo quando a gravação falhava
   * (cota estourada, disco cheio). A interface seguia como se tivesse salvo,
   * e a campanha em memória divergia do que estava persistido.
   */
  function falhaStorage(erro) {
    var e = new Error("não foi possível acessar o armazenamento: " + (erro && erro.message));
    e.storage = true;
    return e;
  }

  function ler(chaves) {
    return new Promise(function (res, rej) {
      try {
        chrome.storage.local.get(chaves, function (d) {
          var erro = chrome.runtime.lastError;
          if (erro) return rej(falhaStorage(erro));
          res(d || {});
        });
      } catch (e) {
        rej(falhaStorage(e));
      }
    });
  }

  function gravar(obj) {
    return new Promise(function (res, rej) {
      try {
        chrome.storage.local.set(obj, function () {
          var erro = chrome.runtime.lastError;
          if (erro) return rej(falhaStorage(erro));
          res();
        });
      } catch (e) {
        rej(falhaStorage(e));
      }
    });
  }

  function remover(chaves) {
    return new Promise(function (res, rej) {
      try {
        chrome.storage.local.remove(chaves, function () {
          var erro = chrome.runtime.lastError;
          if (erro) return rej(falhaStorage(erro));
          res();
        });
      } catch (e) {
        rej(falhaStorage(e));
      }
    });
  }

  function salvar() {
    if (!campanha) return Promise.resolve();
    campanha.atualizadaEm = new Date().toISOString();

    var obj = {};
    obj[PREFIXO_CAMPANHA + campanha.id] = campanha;
    obj[CHAVE_INDICE] = ids;

    marcarSalvar("salvando");

    return gravar(obj).then(
      function () {
        // limpa o aviso de erro: sem isto a faixa vermelha ficava na tela
        // mesmo depois de uma gravação bem-sucedida
        if (falhaSalvamento) {
          falhaSalvamento = false;
          renderizarAvisoSalvamento();
        }
        marcarSalvar("salvo");
        renderizarSeletor();
      },
      function (erro) {
        // não deixa a interface mentir: marca que o estado em memória está
        // à frente do que foi persistido
        falhaSalvamento = true;
        marcarSalvar("falhou");
        log("ERRO ao salvar: " + erro.message, "erro");
        renderizarAvisoSalvamento();
        throw erro;
      }
    );
  }

  function salvarComDebounce() {
    clearTimeout(salvarTimer);
    salvarTimer = setTimeout(function () {
      salvar();
    }, 400);
  }

  function carregar(id) {
    return ler([PREFIXO_CAMPANHA + id]).then(function (d) {
      return d[PREFIXO_CAMPANHA + id] || null;
    });
  }

  /* ==========================================================================
   * WHATSAPP — aba e barramento de comandos
   * ======================================================================== */

  /**
   * Injetada na aba do WhatsApp para saber se está realmente conectado.
   * Só checar "existe uma aba" não basta: se estiver no QR Code, o disparo
   * começa e todos os envios falham.
   */
  function verificarConexaoNoWhatsApp() {
    var painel = document.querySelector("#pane-side");
    var app = document.querySelector(".app-wrapper-web");
    var qr =
      document.querySelector("canvas[aria-label]") ||
      document.querySelector("[data-ref]") ||
      document.querySelector(".qrcode");

    if (!app && !painel) {
      return { conectado: false, motivo: "a página do WhatsApp ainda não carregou" };
    }
    if (!painel && qr) {
      return { conectado: false, motivo: "o WhatsApp está pedindo leitura do QR Code" };
    }
    if (!painel) {
      return { conectado: false, motivo: "o WhatsApp não está conectado" };
    }
    return { conectado: true };
  }

  /**
   * Injetada na MAIN world da aba do WhatsApp. Precisa ser autocontida:
   * não enxerga nada deste arquivo.
   */
  function enviarNoWhatsApp(p) {
    var EVENTOS = {
      texto: "messages:sendTextRequest",
      audio: "messages:sendAudioRequest",
      imagem: "messages:sendMediaRequest",
      documento: "messages:sendDocumentRequest",
    };

    var nomeEvento = EVENTOS[p.tipo];
    if (!nomeEvento) {
      return Promise.resolve({ ok: false, erro: "tipo não suportado: " + p.tipo });
    }

    var corr = "lz" + Date.now() + "-" + Math.floor(Math.random() * 1e9);

    return new Promise(function (resolve) {
      var temporizador = null;

      function limpar() {
        window.removeEventListener("response_" + corr, aoResponder);
        if (temporizador) clearTimeout(temporizador);
      }

      function aoResponder(e) {
        limpar();
        var r = e && e.detail;
        if (r && r.success) resolve({ ok: true });
        else resolve({ ok: false, erro: (r && (r.error || r.erro)) || "o WhatsApp recusou o envio" });
      }

      window.addEventListener("response_" + corr, aoResponder);

      temporizador = setTimeout(function () {
        limpar();
        resolve({ ok: false, erro: "tempo esgotado: o WhatsApp não respondeu em 60s" });
      }, p.timeoutMs || 60000);

      window.dispatchEvent(
        new CustomEvent(nomeEvento, {
          detail: {
            correlationId: corr,
            chatId: p.chatId,
            content: p.conteudo,
            contentBase64: p.base64,
            caption: p.legenda,
            fileName: p.nomeArquivo,
            isPtt: p.tipo === "audio",
            isForwarded: false,
          },
        })
      );
    });
  }

  /**
   * Escolhe a aba do WhatsApp mais provável de estar conectada.
   * O service worker cria uma aba do WhatsApp na instalação, então pode haver
   * mais de uma: preferimos a ativa e, entre as demais, a acessada por último.
   */
  function acharAbaWhatsApp() {
    return new Promise(function (res) {
      chrome.tabs.query({ url: "*://web.whatsapp.com/*" }, function (abas) {
        if (!abas || !abas.length) return res(null);

        var utilizaveis = abas.filter(function (t) {
          return t && t.id != null && !t.discarded;
        });
        if (!utilizaveis.length) return res(abas[0] || null);

        utilizaveis.sort(function (a, b) {
          if (a.active && !b.active) return -1;
          if (b.active && !a.active) return 1;
          return (b.lastAccessed || 0) - (a.lastAccessed || 0);
        });

        res(utilizaveis[0]);
      });
    });
  }

  function abrirWhatsApp() {
    return acharAbaWhatsApp().then(function (aba) {
      if (aba) return aba;
      return new Promise(function (res) {
        chrome.tabs.create({ url: "https://web.whatsapp.com", active: true }, function (nova) {
          res(nova);
        });
      });
    });
  }

  function garantirAbaWhatsApp() {
    return acharAbaWhatsApp().then(function (aba) {
      if (aba) return aba;
      return abrirWhatsApp().then(function (nova) {
        log("Abrindo a aba do WhatsApp. Faça login e inicie de novo.", "info");
        throw new Error("o WhatsApp Web precisa estar aberto e conectado");
      });
    });
  }

  function verificarConexao() {
    return garantirAbaWhatsApp().then(function (aba) {
      return chrome.scripting
        .executeScript({
          target: { tabId: aba.id },
          world: "MAIN",
          func: verificarConexaoNoWhatsApp,
        })
        .then(function (r) {
          var res = r && r[0] && r[0].result;
          return res || { conectado: false, motivo: "não foi possível inspecionar a aba" };
        })
        .catch(function (e) {
          return { conectado: false, motivo: "erro ao inspecionar a aba: " + (e && e.message) };
        });
    });
  }

  function injetarEnvio(payload) {
    return garantirAbaWhatsApp().then(function (aba) {
      return chrome.scripting
        .executeScript({
          target: { tabId: aba.id },
          world: "MAIN",
          args: [payload],
          func: enviarNoWhatsApp,
        })
        .then(function (resultados) {
          var r = resultados && resultados[0] && resultados[0].result;
          if (!r) return { ok: false, erro: "a extensão não conseguiu falar com a página do WhatsApp" };
          return r;
        })
        .catch(function (e) {
          return { ok: false, erro: "erro ao injetar na aba: " + (e && e.message) };
        });
    });
  }

  /* ==========================================================================
   * MÍDIA
   * ======================================================================== */

  function arquivoParaDataUrl(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        res(fr.result);
      };
      fr.onerror = function () {
        rej(fr.error);
      };
      fr.readAsDataURL(file);
    });
  }

  /** Extensões e MIME aceitos por tipo de pasta. */
  var TIPOS_MIDIA = {
    audio: {
      accept: "audio/*",
      mimes: /^audio\//,
      ext: /\.(ogg|opus|mp3|m4a|aac|wav|oga|weba|flac)$/i,
      rotulo: "áudio",
    },
    imagem: {
      accept: "image/*",
      mimes: /^image\//,
      ext: /\.(png|jpe?g|gif|webp|bmp|avif)$/i,
      rotulo: "imagem",
    },
    documento: {
      accept: ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip",
      mimes: /^(application\/(pdf|msword|vnd\.|zip|text\/)|text\/plain)/,
      ext: /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i,
      rotulo: "documento",
    },
  };

  /**
   * O arquivo combina com o tipo da pasta?
   *
   * O atributo accept do <input> é só um filtro visual: o usuário pode
   * escolher "todos os arquivos" e mandar qualquer coisa. Validamos o tipo
   * real aqui.
   */
  function arquivoCompativel(arquivo, tipoPasta) {
    var regra = TIPOS_MIDIA[tipoPasta];
    if (!regra) return true;

    var mime = String(arquivo.type || "");
    if (mime && regra.mimes.test(mime)) return true;
    // alguns sistemas não informam MIME; cai na extensão
    return regra.ext.test(arquivo.name || "");
  }

  function lerMidia(itemId) {
    if (midiasCache[itemId]) return Promise.resolve(midiasCache[itemId]);
    var chave = PREFIXO_MIDIA + itemId;
    return ler([chave]).then(function (d) {
      midiasCache[itemId] = d[chave] || null;
      return midiasCache[itemId];
    });
  }

  /* ==========================================================================
   * EXECUÇÃO
   * ======================================================================== */

  function log(texto, tipo) {
    var el = $("log");
    if (!el) return;
    var linha = document.createElement("div");
    linha.className = tipo ? "l-" + tipo : "";
    var h = new Date().toLocaleTimeString("pt-BR");
    linha.textContent = "[" + h + "] " + texto;
    el.appendChild(linha);
    el.scrollTop = el.scrollHeight;
    while (el.childNodes.length > 300) el.removeChild(el.firstChild);
  }

  /**
   * Espera com PRAZO ABSOLUTO.
   *
   * A versão anterior somava ticks de 250 ms. Se a página travasse (gravação
   * no storage, render, GC, aba em segundo plano), o tempo perdido não era
   * contado e o intervalo esticava. Medido: espera de 5 s com trava de 2 s
   * terminava em 7 s.
   *
   * Agora o prazo é fixo em Date.now(); cada tick recalcula o que falta.
   * Ao pausar, o prazo é empurrado para frente — o tempo parado não conta.
   */
  function esperar(ms, exec) {
    return new Promise(function (res) {
      var passo = 200;
      var fim = Date.now() + ms;

      function tick() {
        if (exec.cancelado) return res();

        if (exec.pausado) {
          fim += passo; // congela o relógio enquanto pausado
          return setTimeout(tick, passo);
        }

        var falta = fim - Date.now();
        if (falta <= 0) return res();
        setTimeout(tick, Math.min(falta, passo));
      }

      setTimeout(tick, Math.min(passo, ms));
    });
  }

  /* ---------- gravação em lote ---------- */
  // Salvar a campanha inteira após CADA envio custa caro: com 10 mil contatos
  // são 1,24 MB por gravação (~429 ms de travamento). Aqui gravamos a cada
  // N envios ou a cada 15 s, e sempre nos momentos que importam.
  var naoSalvos = 0;
  var ultimoSalvamento = 0;
  var falhaSalvamento = false;
  var preparando = false; // trava contra disparos concorrentes

  /**
   * Estamos no meio de uma operação?
   *
   * Cobre a preparação (verificação do WhatsApp, antes de a campanha virar
   * "executando") e a execução em si. Enquanto isto for verdade, trocar de
   * campanha, criar outra ou mexer na fila perderia o controle do que está
   * em andamento.
   */
  function emOperacao() {
    return preparando || (!!campanha && campanha.status === C.STATUS.EXECUTANDO);
  }

  /** Motivo legível para bloquear uma ação, ou null se pode. */
  function motivoBloqueio(acao) {
    if (preparando) {
      return "Aguarde: o disparo está sendo preparado. Não é possível " + acao + " agora.";
    }
    if (campanha && campanha.status === C.STATUS.EXECUTANDO) {
      return "O disparo está em andamento. Pause ou cancele antes de " + acao + ".";
    }
    return null;
  }

  /** Aplica bloqueio visual + textual num controle. */
  function aplicarBloqueio(el, acao) {
    if (!el) return;
    var motivo = motivoBloqueio(acao);
    el.disabled = !!motivo;
    el.setAttribute("aria-disabled", motivo ? "true" : "false");
    if (motivo) {
      el.title = motivo;
      el.classList.add("bloqueado");
    } else {
      el.removeAttribute("title");
      el.classList.remove("bloqueado");
    }
    return !motivo;
  }

  /** Recusa uma ação destrutiva durante a operação, explicando o motivo. */
  function recusarSeEmOperacao(acao) {
    var motivo = motivoBloqueio(acao);
    if (!motivo) return false;
    log(motivo, "erro");
    alert(motivo);
    return true;
  }
  var ultimoTentado = null; // guarda contra laço infinito

  /**
   * Grava o progresso quando a página está sendo fechada.
   *
   * A gravação em lote abre uma janela de até 10 envios em que a memória está
   * à frente do storage. Fechar a aba nesse intervalo perderia os resultados
   * mais recentes. pagehide é o último momento confiável para gravar.
   */
  function instalarSalvamentoAoSair() {
    if (typeof window === "undefined") return;

    var aoSair = function () {
      if (!campanha || naoSalvos === 0) return;
      naoSalvos = 0;
      // set() durante o unload: o serviço de storage aceita a chamada porque
      // ela é enfileirada no processo do navegador, não na página
      try {
        var obj = {};
        campanha.atualizadaEm = new Date().toISOString();
        obj[PREFIXO_CAMPANHA + campanha.id] = campanha;
        chrome.storage.local.set(obj);
      } catch (e) {}
    };

    window.addEventListener("pagehide", aoSair);
    window.addEventListener("beforeunload", aoSair);
  }

  /* --- indicador de persistência --------------------------------------- */
  //
  // O usuário precisa saber quando uma alteração está a caminho do disco.
  // Três estados: pendente, salvando, salvo. Nunca dizemos "salvo" antes de
  // o chrome.storage confirmar.

  var estadoSalvar = "salvo"; // pendente | salvando | salvo | falhou
  var salvoEm = null;

  function marcarSalvar(novo) {
    estadoSalvar = novo;
    if (novo === "salvo") salvoEm = new Date();
    renderizarIndicadorSalvar();
  }

  function renderizarIndicadorSalvar() {
    var el = $("estado-salvar");
    if (!el) return;

    var mapa = {
      pendente: ["pendente", "Alterações não salvas", "pendente"],
      salvando: ["salvando", "Salvando…", "salvando"],
      salvo: [
        "salvo",
        salvoEm ? "Salvo às " + salvoEm.toLocaleTimeString("pt-BR") : "Salvo",
        "salvo",
      ],
      falhou: ["falhou", "Não foi possível salvar", "falhou"],
    };

    var dado = mapa[estadoSalvar] || mapa.salvo;
    el.setAttribute("data-estado", dado[2]);
    el.textContent = dado[1];
    el.setAttribute("aria-live", "polite");
  }

  /** Faixa vermelha quando a última gravação falhou. */
  /** Explica o que aconteceu com uma campanha interrompida. */
  function anunciarRetomada(c) {
    if (!c || !c.interrompida) return;

    var ambiguos = c.contatos.filter(function (x) {
      return x.status === C.ITEM.DESCONHECIDO;
    }).length;

    var msg =
      "Esta campanha estava em execução quando a página foi fechada. " +
      "Ela foi colocada em pausa.";
    if (ambiguos) {
      msg +=
        " " +
        ambiguos +
        (ambiguos === 1 ? " contato ficou" : " contatos ficaram") +
        " SEM CONFIRMAÇÃO de envio — confira no WhatsApp antes de reprocessar.";
    }

    log(msg, "erro");

    var el = $("aviso-salvamento");
    if (el) {
      el.textContent = msg;
      el.classList.remove("oculto");
    }
  }

  /** Trava/libera o campo da lista conforme o disparo. */
  function travarLista(travada) {
    var campo = $("lista");
    if (!campo) return;
    campo.readOnly = travada;
    campo.title = travada
      ? "A lista fica travada enquanto o disparo está em andamento"
      : "";
    campo.style.opacity = travada ? "0.6" : "";
    campo.style.cursor = travada ? "not-allowed" : "";
  }

  function renderizarAvisoSalvamento() {
    var el = $("aviso-salvamento");
    if (!el) return;
    el.classList.toggle("oculto", !falhaSalvamento);
    if (falhaSalvamento) {
      el.textContent =
        "As últimas alterações NÃO foram salvas. O progresso em tela pode ser perdido se você fechar a página.";
    }
  }

  function salvarEmLote(forcar) {
    naoSalvos++;
    if (!falhaSalvamento) marcarSalvar("pendente");
    var agora = Date.now();
    if (forcar || naoSalvos >= 10 || agora - ultimoSalvamento > 15000) {
      naoSalvos = 0;
      ultimoSalvamento = agora;
      return salvar();
    }
    return Promise.resolve();
  }

  /**
   * Envia um contato, PARTE POR PARTE.
   *
   * Antes, a cadeia inteira era uma Promise só: se o texto saísse e o áudio
   * falhasse, o contato ficava "falhou" e o reprocessamento mandava o texto
   * de novo — a pessoa recebia duas vezes.
   *
   * Agora cada parte tem status próprio, só as que faltaram são reenviadas,
   * e o cancelamento é checado antes de cada uma.
   */
  function enviarContato(contato) {
    var plano = C.montarEnvio(campanha, contato);

    if (!plano.length) {
      return Promise.reject(new Error("nada para enviar (texto e mídia vazios)"));
    }

    var chatId = C.paraChatId(contato.numero);
    var pendentes = C.partesPendentes(contato);

    if (!pendentes.length) {
      // tudo já saiu antes: nada a reenviar
      return Promise.resolve({ repetido: true });
    }

    var cadeia = Promise.resolve();
    var problemas = []; // falhas confirmadas
    var ambiguas = []; // sem confirmação

    pendentes.forEach(function (parte) {
      cadeia = cadeia.then(function () {
        // cancelou? não começa a próxima parte
        if (execucao && execucao.cancelado) {
          throw Object.assign(new Error("cancelado pelo usuário"), { cancelado: true });
        }

        var payload = { tipo: parte.tipo, chatId: chatId, timeoutMs: 60000 };
        var envio;

        if (parte.tipo === "texto") {
          payload.conteudo = parte.conteudo;
          envio = injetarEnvio(payload);
        } else {
          envio = lerMidia(parte.arquivo.id).then(function (dataUrl) {
            if (!dataUrl) {
              throw new Error("arquivo da pasta “" + parte.pastaNome + "” não encontrado");
            }
            payload.base64 = dataUrl.split(",")[1];
            payload.nomeArquivo = parte.arquivo.nome;
            return injetarEnvio(payload);
          });
        }

        return envio.then(
          function (r) {
            if (!r.ok) {
              // timeout = não sabemos se chegou; o resto é falha confirmada
              var ambiguo = r.timeout || /sem resposta|timeout/i.test(String(r.erro || ""));
              C.marcarParte(contato, parte.chave, ambiguo ? C.ITEM.DESCONHECIDO : C.ITEM.FALHOU, r.erro);
              (ambiguo ? ambiguas : problemas).push(parte.chave + ": " + r.erro);
              return;
            }
            C.marcarParte(contato, parte.chave, C.ITEM.ENVIADO);

            // Libera o dataURL da memória. O arquivo continua no storage, então
            // uma nova tentativa simplesmente o relê. Sem isto, uma campanha
            // com 50 áudios de 2 MB deixava 100 MB presos na aba até fechá-la.
            if (parte.tipo !== "texto" && parte.arquivo) {
              delete midiasCache[parte.arquivo.id];
            }
          },
          function (e) {
            C.marcarParte(contato, parte.chave, C.ITEM.FALHOU, e && e.message);
            problemas.push(parte.chave + ": " + (e && e.message));
          }
        );
      });
    });

    return cadeia.then(function () {
      if (C.envioCompleto(contato)) return { ok: true };

      if (ambiguas.length) {
        var e2 = new Error(ambiguas.join(" | "));
        e2.ambiguo = true;
        throw e2;
      }
      if (problemas.length) throw new Error(problemas.join(" | "));

      return { ok: true };
    });
  }

  function iniciar() {
    if (!campanha) return;

    // Trava SÍNCRONA, antes de qualquer await.
    //
    // A verificação de conexão é assíncrona: sem esta trava, dois cliques
    // rápidos passavam ambos pela validação e iniciavam preparações paralelas.
    if (preparando || (execucao && campanha.status === C.STATUS.EXECUTANDO)) {
      log("Já existe um disparo em preparação ou em andamento.", "erro");
      return;
    }
    preparando = true;
    ultimoTentado = null;
    C.normalizarCampanha(campanha);

    var liberar = function () {
      preparando = false;
    };

    var v = C.validar(campanha);
    if (!v.ok) {
      liberar();
      alert("Não dá para iniciar:\n\n• " + v.erros.join("\n• "));
      return;
    }

    if (C.limiteDiarioAtingido(campanha)) {
      liberar();
      alert(
        "O limite diário já foi atingido (" +
          campanha.estatisticas.enviadosHoje +
          " de " +
          campanha.protecoes.limiteDiario +
          "). Ajuste o limite ou continue amanhã."
      );
      return;
    }

    garantirAbaWhatsApp()
      .then(function () {
        return verificarConexao();
      })
      .then(function (estado) {
        if (!estado.conectado) {
          throw new Error(
            "O WhatsApp não está pronto: " + estado.motivo + ". Faça login e tente de novo."
          );
        }

        liberar();
        execucao = {
          campanhaId: campanha.id,
          cancelado: false,
          pausado: false,
          enviadosNoLote: 0,
          loteAtual: 0,
        };
        C.iniciar(campanha);
        renderizar();
        salvar();
        log("Disparo iniciado com " + campanha.contatos.length + " contatos.", "info");
        laco();
      })
      .catch(function (e) {
        liberar();
        if (e && e.message) alert(e.message);
      });
  }

  function laco() {
    var exec = execucao;
    if (!exec) return;

    // O laço pertence a UMA campanha. Sem esta checagem, um laço antigo
    // (de uma campanha já trocada) continuaria enviando para a campanha nova.
    function aindaVale() {
      return execucao === exec && campanha && campanha.id === exec.campanhaId;
    }

    (function passo() {
      if (!aindaVale()) return;

      if (exec.cancelado) {
        log("Disparo cancelado.", "erro");
        C.cancelar(campanha);
        execucao = null;
        renderizar();
        naoSalvos = 0;
        salvar();
        return;
      }
      if (exec.pausado) {
        return setTimeout(passo, 300);
      }

      if (C.limiteDiarioAtingido(campanha)) {
        C.pausar(campanha);
        exec.pausado = true;
        log(
          "Limite diário atingido (" + campanha.estatisticas.enviadosHoje + "). Pausando.",
          "erro"
        );
        renderizar();
        salvar();
        return;
      }

      var contato = C.proximoPendente(campanha);
      if (!contato) {
        C.finalizar(campanha);
        execucao = null; // libera para uma próxima campanha
        renderizar();
        naoSalvos = 0;
        salvar();
        log("Campanha finalizada.", "info");
        return;
      }

      // id estável: se a lista for editada durante o envio, a resposta
      // continua caindo no contato certo
      // trava contra laço infinito: se o mesmo contato voltar a ser
      // escolhido sem que o status mude, algo está errado e paramos
      if (ultimoTentado === contato.id && contato.status === C.ITEM.PENDENTE) {
        C.marcarFalhou(campanha, contato, "o envio não alterou o estado do contato");
        log("Erro interno: o contato " + contato.numero + " não saiu da fila. Parando.", "erro");
        C.pausar(campanha);
        exec.pausado = true;
        renderizar();
        salvar();
        return;
      }
      ultimoTentado = contato.id;

      C.marcarEnviando(campanha, contato);
      renderizar();

      enviarContato(contato)
        .then(function () {
          if (!aindaVale()) return;
          C.marcarEnviado(campanha, contato);
          log("Enviado para " + contato.numero, "ok");
        })
        .catch(function (e) {
          if (!aindaVale()) return;

          if (e && e.cancelado) {
            // devolve à fila sem marcar falha
            contato.status = C.ITEM.PENDENTE;
            renderizar();
            return;
          }

          if (e && e.ambiguo) {
            // sem confirmação: não conta como falha nem como envio
            C.marcarDesconhecido(campanha, contato, e.message);
            log(
              "SEM CONFIRMAÇÃO para " + contato.numero + ": " + e.message + ". Não será reenviado sozinho.",
              "erro"
            );
          } else {
            C.marcarFalhou(campanha, contato, e && e.message);
            log("Falhou " + contato.numero + ": " + (e && e.message), "erro");
          }
        })
        .then(function () {
          if (!aindaVale()) return;
          renderizar();
          salvarEmLote();

          // trava de segurança: muitas falhas seguidas = algo errado
          if (C.devePausarPorFalhas(campanha)) {
            C.pausar(campanha);
            exec.pausado = true;
            log(
              campanha.estatisticas.falhasConsecutivas +
                " falhas seguidas — disparo pausado por segurança. Verifique o WhatsApp.",
              "erro"
            );
            renderizar();
            salvar();
            return;
          }

          exec.enviadosNoLote++;
          if (!exec.loteAtual) {
            exec.loteAtual = C.inteiroEntre(campanha.ritmo.loteMin, campanha.ritmo.loteMax);
          }

          var emLote = exec.enviadosNoLote >= exec.loteAtual;
          var ms;

          if (emLote) {
            ms = C.inteiroEntre(campanha.ritmo.pausaLoteMin, campanha.ritmo.pausaLoteMax) * 60000;
            exec.enviadosNoLote = 0;
            exec.loteAtual = 0;
            log("Lote concluído. Pausando por " + Math.round(ms / 60000) + " min.", "info");
          } else {
            ms = C.inteiroEntre(campanha.ritmo.intervaloMin, campanha.ritmo.intervaloMax) * 1000;
            log("Próximo em " + Math.round(ms / 1000) + "s.", "info");
          }

          esperar(ms, exec).then(passo);
        });
    })();
  }

  function pausar() {
    if (!execucao) return;
    execucao.pausado = true;
    C.pausar(campanha);
    naoSalvos = 0;
    log("Pausado.", "info");
    renderizar();
    salvar();
  }

  function retomar() {
    if (!execucao) return;
    execucao.pausado = false;
    C.retomar(campanha);
    naoSalvos = 0;
    log("Retomado.", "info");
    renderizar();
    salvar();
  }

  function cancelar(forcar) {
    if (!execucao && !forcar) return;
    if (!forcar && !confirm("Cancelar o disparo? Quem ainda não recebeu não vai receber.")) return;

    if (execucao) {
      execucao.cancelado = true;
      execucao.pausado = false;
    }
    if (campanha) {
      C.cancelar(campanha);
      renderizar();
      naoSalvos = 0;
      salvar();
    }
  }

  /* ==========================================================================
   * RENDERIZAÇÃO
   * ======================================================================== */

  function renderizarSeletor() {
    var sel = $("sel-campanha");
    if (!sel) return;
    var atual = campanha ? campanha.id : "";

    sel.innerHTML = "";
    if (!ids.length) {
      var vazio = document.createElement("option");
      vazio.textContent = "Nenhuma campanha salva";
      vazio.value = "";
      sel.appendChild(vazio);
      return;
    }

    var vistos = Object.create(null);
    ids.forEach(function (id) {
      if (vistos[id]) return;
      vistos[id] = true;
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    });

    // completar com o nome depois que carregar
    Promise.all(ids.map(carregar)).then(function (lista) {
      var mapa = {};
      lista.forEach(function (c) {
        if (c) mapa[c.id] = c.nome;
      });
      Array.prototype.forEach.call(sel.options, function (o) {
        if (mapa[o.value]) o.textContent = mapa[o.value];
      });
      sel.value = atual;
    });
  }

  /* --- tabela: atualização incremental -------------------------------- */
  //
  // Antes, cada renderização apagava o <tbody> inteiro e recriava todas as
  // linhas. Com 3.000 contatos isso é ~24 mil nós por envio, várias vezes por
  // minuto — o navegador engasga e o clique demora a responder.
  //
  // Agora as linhas são reaproveitadas: guardamos o <tr> de cada contato por
  // id e só reescrevemos o que mudou. A rolagem e o foco não se perdem.

  var LINHAS_POR_PAGINA = 200;
  var linhasVisiveis = LINHAS_POR_PAGINA;

  var linhasPorId = Object.create(null); // id do contato -> { tr, assinatura }
  var ordemDesenhada = []; // ids na ordem atual do DOM

  function assinaturaContato(c) {
    return [c.status, c.enviadoEm || "", c.erro || "", c.numero, emOperacao() ? "op" : "-"].join(
      "\u0001"
    );
  }

  function celulaStatus(c) {
    var tag = document.createElement("span");
    tag.className = "status-tag st-" + c.status;
    tag.textContent = rotuloStatus(c.status);
    return tag;
  }

  function rotuloStatus(status) {
    return (
      {
        pendente: "na fila",
        enviando: "enviando",
        enviado: "enviado",
        falhou: "falhou",
        pulado: "pulado",
        desconhecido: "sem confirmação",
      }[status] || status
    );
  }

  /** Cria a linha uma única vez. */
  function criarLinha(c, indice) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-contato", c.id);

    var tdNum = document.createElement("td");
    tdNum.className = "col-numero";

    var tdTel = document.createElement("td");
    tdTel.textContent = c.numero;

    var tdStatus = document.createElement("td");

    var tdData = document.createElement("td");
    tdData.className = "col-data";

    var tdErro = document.createElement("td");
    tdErro.className = "col-erro";

    var tdAcao = document.createElement("td");
    tdAcao.className = "col-acao";

    [tdNum, tdTel, tdStatus, tdData, tdErro, tdAcao].forEach(function (td) {
      tr.appendChild(td);
    });

    return {
      tr: tr,
      tdNum: tdNum,
      tdStatus: tdStatus,
      tdData: tdData,
      tdErro: tdErro,
      tdAcao: tdAcao,
      assinatura: null,
    };
  }

  /** Atualiza só o que mudou naquela linha. */
  function atualizarLinha(reg, c, indice) {
    var assinatura = assinaturaContato(c);
    if (reg.assinatura === assinatura) return false;

    reg.tdNum.textContent = String(indice + 1);

    reg.tdStatus.innerHTML = "";
    reg.tdStatus.appendChild(celulaStatus(c));

    reg.tdData.textContent = c.enviadoEm
      ? new Date(c.enviadoEm).toLocaleString("pt-BR")
      : "—";

    reg.tdErro.textContent = c.erro || "—";
    reg.tdErro.title = c.erro || "";

    // ação só existe para quem ainda pode sair da fila E fora de execução
    reg.tdAcao.innerHTML = "";
    if (!emOperacao() && (c.status === "pendente" || c.status === "falhou")) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sec btn-pequeno";
      btn.textContent = "Remover";
      btn.setAttribute("aria-label", "Remover " + c.numero + " da fila");
      btn.onclick = function () {
        if (recusarSeEmOperacao("remover contatos da fila")) return;
        var n = C.removerPendentes(campanha, [c.numero]);
        if (n) {
          log("Removido da fila: " + c.numero, "info");
          renderizar();
          salvar();
        }
      };
      reg.tdAcao.appendChild(btn);
    }

    reg.assinatura = assinatura;
    return true;
  }

  function renderizarTabela() {
    var corpo = $("corpo-tabela");
    if (!corpo) return;

    if (!campanha || !campanha.contatos.length) {
      linhasPorId = Object.create(null);
      ordemDesenhada = [];
      corpo.innerHTML = "";

      var vazio = document.createElement("tr");
      vazio.className = "linha-vazia";
      var td = document.createElement("td");
      td.colSpan = 6;
      td.innerHTML =
        '<div class="estado-vazio">' +
        "<b>Nenhum contato ainda</b>" +
        "<span>Cole os números na seção 1 para começar. " +
        "Cada número vira uma linha aqui, com o resultado do envio.</span>" +
        "</div>";
      vazio.appendChild(td);
      corpo.appendChild(vazio);
      atualizarBotaoMais();
      return;
    }

    var contatos = campanha.contatos;
    var limite = Math.min(contatos.length, linhasVisiveis);

    // remove a linha de "vazio" se existir
    var vazia = corpo.querySelector(".linha-vazia");
    if (vazia) vazia.remove();

    var fragmento = document.createDocumentFragment();
    var vistos = Object.create(null);

    for (var i = 0; i < limite; i++) {
      var c = contatos[i];
      var reg = linhasPorId[c.id];

      if (!reg) {
        reg = criarLinha(c, i);
        linhasPorId[c.id] = reg;
      }

      atualizarLinha(reg, c, i);
      vistos[c.id] = true;

      // só mexe no DOM se a posição mudou
      if (corpo.children[i] !== reg.tr) fragmento.appendChild(reg.tr);
    }

    if (fragmento.childNodes.length) corpo.appendChild(fragmento);

    // descarta linhas de contatos que não existem mais
    Object.keys(linhasPorId).forEach(function (id) {
      if (!vistos[id]) {
        var reg = linhasPorId[id];
        if (reg.tr.parentNode) reg.tr.parentNode.removeChild(reg.tr);
        delete linhasPorId[id];
      }
    });

    atualizarBotaoMais();
  }

  /** Mostra/oculta o botão "mostrar mais" conforme o tamanho da lista. */
  function atualizarBotaoMais() {
    var btn = $("btn-mais-linhas");
    if (!btn) return;

    var total = campanha ? campanha.contatos.length : 0;
    var restantes = total - linhasVisiveis;

    if (restantes > 0) {
      btn.classList.remove("oculto");
      btn.textContent =
        "Mostrar mais " +
        Math.min(LINHAS_POR_PAGINA, restantes) +
        " (faltam " +
        restantes +
        ")";
    } else {
      btn.classList.add("oculto");
    }
  }

  function renderizarProgresso() {
    if (!campanha) return;

    var p = C.progresso(campanha);
    $("progresso-barra").style.width = p.percentual + "%";
    var barra = $("progresso-barra");
    if (barra && barra.parentElement) {
      barra.parentElement.setAttribute("role", "progressbar");
      barra.parentElement.setAttribute("aria-valuemin", "0");
      barra.parentElement.setAttribute("aria-valuemax", "100");
      barra.parentElement.setAttribute("aria-valuenow", String(p.percentual));
      barra.parentElement.setAttribute(
        "aria-valuetext",
        p.processados + " de " + p.total + " contatos processados"
      );
      barra.parentElement.setAttribute("aria-label", "Progresso do disparo");
    }
    $("progresso-percentual").textContent = p.percentual + "%";
    $("c-enviados").textContent = p.enviados;
    $("c-falhas").textContent = p.falharam;
    $("c-pendentes").textContent = p.pendentes;
    $("c-total").textContent = p.total;

    // Estado principal: precisa cobrir preparação, interrupção e operações
    // sem confirmação — não só "executando".
    var ambiguos = campanha.contatos.filter(function (c) {
      return c.status === C.ITEM.DESCONHECIDO;
    }).length;

    var estado;
    if (preparando) {
      estado = { chave: "preparando", texto: "Preparando disparo…" };
    } else if (campanha.status === "executando") {
      estado = { chave: "executando", texto: "Enviando" };
    } else if (campanha.status === "pausada") {
      estado = { chave: "pausada", texto: "Pausado" };
    } else if (campanha.status === "finalizada") {
      estado = { chave: "finalizada", texto: "Finalizada" };
    } else if (campanha.status === "cancelada") {
      estado = { chave: "cancelada", texto: "Cancelada" };
    } else {
      estado = { chave: "rascunho", texto: "Aguardando início" };
    }

    var selo = $("estado-execucao");
    if (selo) {
      selo.setAttribute("data-estado", estado.chave);
      selo.textContent = estado.texto;
    }

    $("progresso-texto").textContent =
      estado.texto + " — " + p.processados + " de " + p.total + " contatos";

    // faixa de atenção: só aparece quando há algo exigindo decisão
    var atencao = $("aviso-atencao");
    if (atencao) {
      var avisos = [];
      if (ambiguos) {
        avisos.push(
          ambiguos +
            (ambiguos === 1
              ? " contato ficou sem confirmação de envio"
              : " contatos ficaram sem confirmação de envio") +
            ". Confira no WhatsApp antes de reprocessar — reenviar pode duplicar."
        );
      }
      if (campanha.interrompida) {
        avisos.push("A execução anterior foi interrompida (a página foi fechada).");
      }
      if (falhaSalvamento) {
        avisos.push("As últimas alterações não foram salvas.");
      }

      atencao.classList.toggle("oculto", !avisos.length);
      atencao.innerHTML = "";
      avisos.forEach(function (a) {
        var p = document.createElement("p");
        p.textContent = a;
        atencao.appendChild(p);
      });
    }

    var stats = C.estatisticas(campanha);
    $("enviados-hoje").textContent = stats.enviadosHoje;
    $("limite-info").textContent = campanha.protecoes.limiteDiario
      ? "de " + campanha.protecoes.limiteDiario + " permitidos hoje"
      : "(sem limite diário)";

    var rodando = campanha.status === "executando";
    var pausada = campanha.status === "pausada";

    $("btn-iniciar").classList.toggle("oculto", rodando || pausada);
    $("btn-pausar").classList.toggle("oculto", !rodando);
    $("btn-retomar").classList.toggle("oculto", !pausada);
    $("btn-cancelar").classList.toggle("oculto", !(rodando || pausada));
    $("btn-iniciar").disabled = rodando || pausada;
  }

  function estimar() {
    if (!campanha) return;
    var pendentes = campanha.contatos.filter(function (c) {
      return c.status === "pendente";
    }).length;

    if (!pendentes) {
      $("estimativa").textContent = "—";
      return;
    }

    var plano = C.planejarRitmo(pendentes, campanha.ritmo);
    var ms = C.duracaoEstimada(plano);
    var min = Math.round(ms / 60000);

    // quantas partes cada contato vai receber, de fato
    var umaAmostra = C.montarEnvio(campanha, campanha.contatos.filter(function (c) {
      return c.status === "pendente";
    })[0]);
    var partesPorContato = umaAmostra.length || 1;

    var duracao = min < 60 ? min + " minutos" : (min / 60).toFixed(1) + " horas";
    var texto = "≈ " + duracao + " para " + pendentes + " contatos";

    if (partesPorContato > 1) {
      texto += " (" + pendentes * partesPorContato + " arquivos/mensagens no total)";
    }

    $("estimativa").textContent = texto;
    $("estimativa").setAttribute(
      "title",
      "Estimativa aproximada: considera o intervalo entre contatos, os lotes e " +
        "as pausas. O tempo real varia com a velocidade do WhatsApp."
    );
  }

  function renderizarFormulario() {
    if (!campanha) return;

    $("nome").value = campanha.nome || "";

    // modo de texto
    sincronizarAbas(campanha.texto.modo);
    $("painel-fixo").classList.toggle("oculto", campanha.texto.modo !== "fixo");
    $("painel-spintax").classList.toggle("oculto", campanha.texto.modo !== "spintax");
    $("painel-rotacao").classList.toggle("oculto", campanha.texto.modo !== "rotacao");

    $("texto-fixo").value =
      campanha.texto.modo === "rotacao" ? "" : campanha.texto.textoFixo || "";
    $("texto-fixo").classList.toggle("oculto", campanha.texto.modo === "rotacao");

    renderizarRotacao();
    atualizarContadoresTexto();

    // proteções
    $("chk-homoglifos").checked = !!campanha.opcoes.homoglifos;
    $("homoglifos-opcoes").classList.toggle("oculto", !campanha.opcoes.homoglifos);
    $("range-homoglifos").value = campanha.opcoes.homoglifosIntensidade;
    $("val-homoglifos").textContent = campanha.opcoes.homoglifosIntensidade + "%";

    $("chk-invisiveis").checked = !!campanha.opcoes.invisiveis;
    $("invisiveis-opcoes").classList.toggle("oculto", !campanha.opcoes.invisiveis);
    $("range-invisiveis").value = campanha.opcoes.invisiveisQtd;
    $("val-invisiveis").textContent = campanha.opcoes.invisiveisQtd;
    $("chk-invisiveis-espaco").checked = !!campanha.opcoes.invisiveisComEspaco;

    // ritmo
    $("int-min").value = campanha.ritmo.intervaloMin;
    $("int-max").value = campanha.ritmo.intervaloMax;
    $("lote-min").value = campanha.ritmo.loteMin;
    $("lote-max").value = campanha.ritmo.loteMax;
    $("pausa-min").value = campanha.ritmo.pausaLoteMin;
    $("pausa-max").value = campanha.ritmo.pausaLoteMax;

    $("prot-falhas").value = campanha.protecoes.pausarAposFalhas;
    $("prot-limite").value = campanha.protecoes.limiteDiario;

    renderizarPastas();
    renderizarProgresso();
    renderizarTabela();
    estimar();
  }

  function renderizarRotacao() {
    var cont = $("rotacao-lista");
    if (!cont || !campanha) return;
    cont.innerHTML = "";

    var lista = campanha.texto.rotacao || [""];

    lista.forEach(function (texto, i) {
      var linha = document.createElement("div");
      linha.className = "rotacao-item";

      var ta = document.createElement("textarea");
      ta.className = "campo area";
      ta.rows = 2;
      ta.placeholder = "Mensagem " + (i + 1);
      ta.value = texto;
      ta.oninput = function () {
        campanha.texto.rotacao[i] = ta.value;
        atualizarContadoresTexto();
        salvarComDebounce();
      };

      var btn = document.createElement("button");
      btn.className = "btn btn-sec btn-perigo";
      btn.textContent = "×";
      btn.title = "Remover esta variação";
      btn.onclick = function () {
        campanha.texto.rotacao.splice(i, 1);
        if (!campanha.texto.rotacao.length) campanha.texto.rotacao = [""];
        renderizarRotacao();
        atualizarContadoresTexto();
        salvarComDebounce();
      };

      linha.appendChild(ta);
      linha.appendChild(btn);
      cont.appendChild(linha);
    });
  }

  function atualizarContadoresTexto() {
    if (!campanha) return;
    var total = 0;

    if (campanha.texto.modo === "rotacao") {
      total = (campanha.texto.rotacao || []).reduce(function (s, t) {
        return s + String(t || "").length;
      }, 0);
      var validas = (campanha.texto.rotacao || []).filter(function (t) {
        return String(t || "").trim();
      }).length;
      $("n-variacoes").textContent = validas;
    } else {
      total = String(campanha.texto.textoFixo || "").length;
      $("n-variacoes").textContent = C.contarSpintax(campanha.texto.textoFixo || "");
    }

    $("contador-caracteres").textContent = total + " caracteres";
  }

  function renderizarPastas() {
    var cont = $("pastas");
    if (!cont || !campanha) return;
    cont.innerHTML = "";

    $("sem-pastas").classList.toggle("oculto", (campanha.pastas || []).length > 0);

    (campanha.pastas || []).forEach(function (pasta) {
      var div = document.createElement("div");
      div.className = "pasta";

      var topo = document.createElement("div");
      topo.className = "pasta-topo";

      var nome = document.createElement("input");
      nome.type = "text";
      nome.className = "campo";
      nome.value = pasta.nome;
      nome.oninput = function () {
        pasta.nome = nome.value;
        salvarComDebounce();
      };

      var tipo = document.createElement("select");
      tipo.className = "campo";
      tipo.style.maxWidth = "130px";
      [
        ["audio", "Áudio"],
        ["imagem", "Imagem"],
        ["documento", "Documento"],
      ].forEach(function (par) {
        var o = document.createElement("option");
        o.value = par[0];
        o.textContent = par[1];
        if (pasta.tipo === par[0]) o.selected = true;
        tipo.appendChild(o);
      });
      tipo.onchange = function () {
        var tipoAnterior = pasta.tipo;
        pasta.tipo = tipo.value;

        // O filtro do seletor precisa acompanhar o novo tipo: sem isto o
        // usuário mudava de áudio para imagem e a janela continuava
        // filtrando por áudio.
        if (pasta._sincronizarAccept) pasta._sincronizarAccept();

        salvarComDebounce();

        // Arquivos que já estavam na pasta podem não servir mais.
        // Nada é apagado sem o usuário decidir.
        if (tipoAnterior !== pasta.tipo) {
          var incompatíveis = (pasta.itens || []).filter(function (it) {
            return it.tipo && it.tipo !== pasta.tipo;
          });

          if (incompatíveis.length) {
            renderizarPastas();
            var nomes = incompatíveis.map(function (i) {
              return i.nome;
            });
            var confirmouRemocao = confirm(
              "Esta pasta agora é de " +
                (TIPOS_MIDIA[pasta.tipo] || {}).rotulo +
                ", mas " +
                incompatíveis.length +
                " arquivo(s) foram adicionados como " +
                (TIPOS_MIDIA[incompatíveis[0].tipo] || {}).rotulo +
                ":\n\n" +
                nomes.join("\n") +
                "\n\nEles continuam salvos. Remover da pasta?"
            );
            if (confirmouRemocao) {
              var chaves = incompatíveis.map(function (it) {
                delete midiasCache[it.id];
                return PREFIXO_MIDIA + it.id;
              });
              pasta.itens = pasta.itens.filter(function (it) {
                return it.tipo === pasta.tipo;
              });
              remover(chaves).then(function () {
                renderizarPastas();
                salvar();
              });
              log(incompatíveis.length + " arquivo(s) incompatíveis removidos.", "info");
            }
          } else {
            renderizarPastas();
          }
        }
      };

      var rem = document.createElement("button");
      rem.className = "btn btn-sec btn-perigo btn-pequeno";
      rem.textContent = "Remover pasta";
      rem.onclick = function () {
        if (!confirm("Remover a pasta “" + pasta.nome + "” e seus arquivos?")) return;
        var chaves = pasta.itens.map(function (it) {
          delete midiasCache[it.id];
          return PREFIXO_MIDIA + it.id;
        });
        remover(chaves).then(function () {
          campanha.pastas = campanha.pastas.filter(function (p) {
            return p.id !== pasta.id;
          });
          renderizarPastas();
          salvar();
        });
      };

      topo.appendChild(nome);
      topo.appendChild(tipo);
      topo.appendChild(rem);

      var add = document.createElement("button");
      add.className = "btn btn-sec btn-pequeno";
      add.textContent = "+ Adicionar arquivos";

      var input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.className = "oculto";

      /** Sincroniza o filtro do seletor com o tipo ATUAL da pasta. */
      function sincronizarAccept() {
        var regra = TIPOS_MIDIA[pasta.tipo];
        input.accept = regra ? regra.accept : "";
        input.setAttribute(
          "aria-label",
          "Escolher " + (regra ? regra.rotulo : "arquivo") + " para a pasta " + pasta.nome
        );
      }
      sincronizarAccept();

      // mantém o filtro alinhado quando o tipo muda
      pasta._sincronizarAccept = sincronizarAccept;

      input.onchange = function () {
        var arquivos = Array.prototype.slice.call(input.files || []);
        input.value = ""; // permite reescolher o mesmo arquivo
        if (!arquivos.length) return;

        var barra = document.createElement("div");
        barra.className = "upload-progresso";
        barra.textContent = "Enviando 0 de " + arquivos.length + "…";
        chips.parentNode.insertBefore(barra, chips);

        var adicionados = [];
        var recusados = [];

        // Cada arquivo é tratado individualmente: uma falha não descarta
        // os que já foram gravados.
        var cadeia = Promise.resolve();

        arquivos.forEach(function (f, indice) {
          cadeia = cadeia.then(function () {
            barra.textContent =
              "Enviando " + (indice + 1) + " de " + arquivos.length + "… (" + f.name + ")";

            if (!arquivoCompativel(f, pasta.tipo)) {
              recusados.push({
                nome: f.name,
                motivo: "não é " + (TIPOS_MIDIA[pasta.tipo] || {}).rotulo,
              });
              return;
            }
            if (!f.size) {
              recusados.push({ nome: f.name, motivo: "arquivo vazio" });
              return;
            }

            var id = novoId("m-");
            return arquivoParaDataUrl(f).then(
              function (dataUrl) {
                if (!dataUrl) throw new Error("não foi possível ler o arquivo");
                var obj = {};
                obj[PREFIXO_MIDIA + id] = dataUrl;
                return gravar(obj).then(function () {
                  // só entra no cache e na lista depois de gravar com sucesso
                  midiasCache[id] = dataUrl;
                  pasta.itens.push({
                    id: id,
                    nome: f.name,
                    tamanho: f.size,
                    tipo: pasta.tipo,
                  });
                  adicionados.push(f.name);
                });
              },
              function (erro) {
                recusados.push({ nome: f.name, motivo: erro.message || "falha ao ler" });
              }
            );
          });
        });

        cadeia.then(function () {
          barra.remove();
          renderizarPastas();
          if (adicionados.length) salvar();

          if (adicionados.length) {
            log(
              adicionados.length +
                " arquivo(s) adicionado(s) em “" +
                pasta.nome +
                "”: " +
                adicionados.join(", "),
              "ok"
            );
          }
          if (recusados.length) {
            var detalhe = recusados
              .map(function (r) {
                return r.nome + " (" + r.motivo + ")";
              })
              .join("; ");
            log(
              recusados.length + " arquivo(s) NÃO adicionado(s): " + detalhe,
              "erro"
            );
            alert(
              recusados.length +
                " arquivo(s) não foram adicionados:\n\n" +
                detalhe +
                "\n\nOs demais foram salvos normalmente."
            );
          }
        });
      };

      add.onclick = function () {
        input.click();
      };

      var chips = document.createElement("div");
      chips.className = "pasta-arquivos";

      if (!pasta.itens.length) {
        var vazio = document.createElement("p");
        vazio.className = "vazio";
        vazio.textContent = "Nenhum arquivo nesta pasta.";
        chips.appendChild(vazio);
      }

      pasta.itens.forEach(function (item) {
        var chip = document.createElement("span");
        chip.className = "arquivo-chip";

        var txt = document.createElement("span");
        txt.textContent = item.nome;
        txt.title = item.nome;

        var x = document.createElement("button");
        x.textContent = "×";
        x.title = "Remover arquivo";
        x.onclick = function () {
          delete midiasCache[item.id];
          remover([PREFIXO_MIDIA + item.id]).then(function () {
            pasta.itens = pasta.itens.filter(function (i) {
              return i.id !== item.id;
            });
            renderizarPastas();
            salvar();
          });
        };

        chip.appendChild(txt);
        chip.appendChild(x);
        chips.appendChild(chip);
      });

      div.appendChild(topo);
      div.appendChild(add);
      div.appendChild(input);
      div.appendChild(chips);
      cont.appendChild(div);
    });
  }

  function renderizar() {
    renderizarProgresso();
    renderizarTabela();
    estimar();
    travarLista(!!(execucao && !execucao.cancelado));
  }

  /* ==========================================================================
   * LIGAÇÕES DE EVENTOS
   * ======================================================================== */

  /** Teclado nas abas: setas movem, Home/End vão às pontas. */
  function ligarTecladoAbas() {
    var abas = Array.prototype.slice.call(
      document.querySelectorAll(".segmentado [role='tab']")
    );
    if (!abas.length) return;

    abas.forEach(function (aba, i) {
      aba.addEventListener("keydown", function (ev) {
        var alvo = null;
        if (ev.key === "ArrowRight") alvo = abas[(i + 1) % abas.length];
        else if (ev.key === "ArrowLeft") alvo = abas[(i - 1 + abas.length) % abas.length];
        else if (ev.key === "Home") alvo = abas[0];
        else if (ev.key === "End") alvo = abas[abas.length - 1];

        if (!alvo) return;
        ev.preventDefault();
        alvo.click();
        alvo.focus();
      });
    });
  }

  /** Mantém aria-selected e tabindex coerentes com o modo ativo. */
  function sincronizarAbas(modoAtivo) {
    Array.prototype.forEach.call(
      document.querySelectorAll(".segmentado [role='tab']"),
      function (aba) {
        var ativo = aba.getAttribute("data-modo") === modoAtivo;
        aba.setAttribute("aria-selected", ativo ? "true" : "false");
        aba.setAttribute("tabindex", ativo ? "0" : "-1");
        aba.classList.toggle("ativo", ativo);
      }
    );
  }

  function ligarEventos() {
    $("nome").oninput = function () {
      campanha.nome = this.value;
      salvarComDebounce();
      renderizarSeletor();
    };

    $("btn-analisar").onclick = analisarLista;
    $("lista").oninput = function () {
      clearTimeout(window.__analisarTimer);
      window.__analisarTimer = setTimeout(analisarLista, 500);
    };

    document.querySelectorAll(".seg").forEach(function (b) {
      b.onclick = function () {
        campanha.texto.modo = b.dataset.modo;
        if (b.dataset.modo === "rotacao" && !(campanha.texto.rotacao || []).length) {
          campanha.texto.rotacao = [""];
        }
        renderizarFormulario();
        salvarComDebounce();
      };
    });

    $("texto-fixo").oninput = function () {
      campanha.texto.textoFixo = this.value;
      atualizarContadoresTexto();
      salvarComDebounce();
    };

    $("btn-add-rotacao").onclick = function () {
      campanha.texto.rotacao = (campanha.texto.rotacao || []).concat([""]);
      renderizarRotacao();
      salvarComDebounce();
    };

    $("chk-homoglifos").onchange = function () {
      campanha.opcoes.homoglifos = this.checked;
      $("homoglifos-opcoes").classList.toggle("oculto", !this.checked);
      salvarComDebounce();
    };
    $("range-homoglifos").oninput = function () {
      campanha.opcoes.homoglifosIntensidade = parseInt(this.value, 10);
      $("val-homoglifos").textContent = this.value + "%";
      salvarComDebounce();
    };

    $("chk-invisiveis").onchange = function () {
      campanha.opcoes.invisiveis = this.checked;
      $("invisiveis-opcoes").classList.toggle("oculto", !this.checked);
      salvarComDebounce();
    };
    $("range-invisiveis").oninput = function () {
      campanha.opcoes.invisiveisQtd = parseInt(this.value, 10);
      $("val-invisiveis").textContent = this.value;
      salvarComDebounce();
    };
    $("chk-invisiveis-espaco").onchange = function () {
      campanha.opcoes.invisiveisComEspaco = this.checked;
      salvarComDebounce();
    };

    [
      ["int-min", "intervaloMin"],
      ["int-max", "intervaloMax"],
      ["lote-min", "loteMin"],
      ["lote-max", "loteMax"],
      ["pausa-min", "pausaLoteMin"],
      ["pausa-max", "pausaLoteMax"],
    ].forEach(function (par) {
      $(par[0]).oninput = function () {
        campanha.ritmo[par[1]] = parseInt(this.value, 10) || 0;
        estimar();
        salvarComDebounce();
      };
    });

    $("prot-falhas").oninput = function () {
      campanha.protecoes.pausarAposFalhas = Math.max(0, parseInt(this.value, 10) || 0);
      salvarComDebounce();
    };

    $("prot-limite").oninput = function () {
      campanha.protecoes.limiteDiario = Math.max(0, parseInt(this.value, 10) || 0);
      renderizarProgresso();
      salvarComDebounce();
    };

    $("btn-add-pasta").onclick = function () {
      campanha.pastas = (campanha.pastas || []).concat([
        { id: novoId("p-"), nome: "Pasta " + (campanha.pastas.length + 1), tipo: "audio", itens: [] },
      ]);
      renderizarPastas();
      salvar();
    };

    $("btn-iniciar").onclick = iniciar;
    $("btn-pausar").onclick = pausar;
    $("btn-retomar").onclick = retomar;
    $("btn-cancelar").onclick = cancelar;

    $("btn-wpp").onclick = function () {
      abrirWhatsApp();
    };

    $("btn-csv").onclick = function () {
      var csv = C.relatorioCSV(campanha);
      var blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "relatorio-" + campanha.id + ".csv";
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 5000);
    };

    var mais = $("btn-mais-linhas");
    if (mais) {
      mais.onclick = function () {
        linhasVisiveis += LINHAS_POR_PAGINA;
        renderizarTabela();
      };
    }

    $("btn-reproc").onclick = function () {
      if (recusarSeEmOperacao("reprocessar falhas")) return;
      var n = C.reprocessarFalhas(campanha);
      if (!n) {
        alert("Não há falhas para reprocessar.");
        return;
      }
      log(n + " contato(s) voltaram para a fila.", "info");
      renderizar();
      salvar();
    };

    $("btn-limpar-pendentes").onclick = function () {
      if (recusarSeEmOperacao("remover contatos da fila")) return;
      var pendentes = campanha.contatos.filter(function (c) {
        return c.status === "pendente" || c.status === "falhou";
      }).length;
      if (!pendentes) {
        alert("Não há contatos pendentes.");
        return;
      }
      if (!confirm("Remover " + pendentes + " contato(s) que ainda não receberam?")) return;
      var n = C.removerPendentes(campanha);
      log(n + " contato(s) removidos da fila.", "info");
      renderizar();
      salvar();
    };

    $("btn-nova").onclick = function () {
      if (recusarSeEmOperacao("criar outra campanha")) return;
      if (campanha && campanha.contatos.length) {
        if (!confirm("Criar uma campanha nova? A atual fica salva na lista.")) return;
      }
      criarNova();
    };

    $("btn-excluir").onclick = function () {
      if (!campanha) return;
      if (recusarSeEmOperacao("excluir a campanha")) return;
      if (!confirm("Excluir a campanha “" + campanha.nome + "”?")) return;
      var chaves = [PREFIXO_CAMPANHA + campanha.id];
      (campanha.pastas || []).forEach(function (p) {
        p.itens.forEach(function (it) {
          chaves.push(PREFIXO_MIDIA + it.id);
        });
      });
      ids = ids.filter(function (i) {
        return i !== campanha.id;
      });
      remover(chaves).then(function () {
        campanha = null;
        iniciarNovaSeVazio();
      });
    };

    $("sel-campanha").onchange = function () {
      var id = this.value;

      // trocar de campanha no meio de uma execução abandonaria o laço ativo
      if (id !== (campanha && campanha.id) && recusarSeEmOperacao("trocar de campanha")) {
        this.value = campanha ? campanha.id : "";
        return;
      }
      if (!id) return;

      carregar(id).then(function (c) {
        if (!c) return;
        campanha = c;
        execucao = null;
        linhasVisiveis = LINHAS_POR_PAGINA;
        linhasPorId = Object.create(null);
        $("log").innerHTML = "";
        renderizarFormulario();
        $("lista").value = c.contatos
          .map(function (x) {
            return x.numero;
          })
          .join("\n");
        analisarLista();
        atualizarAvisoWhatsApp();
      });
    };
  }

  /* ==========================================================================
   * LISTA
   * ======================================================================== */

  function analisarLista() {
    var texto = $("lista").value;
    var r = C.lerLista(texto);

    $("resumo-lista").classList.toggle("oculto", r.total === 0);
    $("n-validos").textContent = r.validos.length;
    $("n-invalidos").textContent = r.invalidos.length;
    $("n-duplicados").textContent = r.duplicados;

    var det = $("det-invalidos");
    det.classList.toggle("oculto", r.invalidos.length === 0);

    var ul = $("lista-invalidos");
    ul.innerHTML = "";
    r.invalidos.slice(0, 200).forEach(function (inv) {
      var li = document.createElement("li");
      li.textContent = inv.entrada + " ";
      var m = document.createElement("span");
      m.className = "motivo";
      m.textContent = "(" + inv.motivo + ")";
      li.appendChild(m);
      ul.appendChild(li);
    });

    // Durante o disparo a lista NÃO pode ser reconstruída: isso reindexa os
    // contatos e a resposta de um envio em andamento cairia em outro registro.
    var emExecucao = execucao && !execucao.cancelado;
    if (campanha && emExecucao) {
      log("A lista está travada enquanto o disparo está em andamento.", "erro");
      return;
    }

    // atualiza os contatos da campanha preservando o status de quem já recebeu
    if (campanha) {
      var porNumero = {};
      campanha.contatos.forEach(function (c) {
        porNumero[c.numero] = c;
      });

      campanha.contatos = r.validos.map(function (v, i) {
        var existente = porNumero[v.numero];
        if (existente) {
          existente.indice = i;
          return existente;
        }
        return {
          indice: i,
          numero: v.numero,
          bruto: v.bruto,
          nome: "",
          status: C.ITEM.PENDENTE,
          tentativas: 0,
          erro: null,
          enviadoEm: null,
        };
      });
      campanha.cursor = 0;

      renderizar();
      salvarComDebounce();
    }
  }

  /* ==========================================================================
   * AVISO SOBRE O WHATSAPP
   * ======================================================================== */

  function atualizarAvisoWhatsApp() {
    acharAbaWhatsApp().then(function (aba) {
      var faixa = $("aviso-wpp");
      if (aba) {
        faixa.classList.add("oculto");
        return;
      }
      faixa.classList.remove("oculto");
      $("aviso-wpp-texto").textContent =
        "O WhatsApp Web precisa estar aberto e conectado para o disparo funcionar. " +
        "Clique em “Abrir WhatsApp” e faça login.";
    });
  }

  /* ==========================================================================
   * INICIALIZAÇÃO
   * ======================================================================== */

  function novaCampanha() {
    return C.criarCampanha({
      nome: "Campanha " + new Date().toLocaleDateString("pt-BR"),
      contatos: [],
      texto: { modo: "fixo", textoFixo: "", rotacao: [""] },
      opcoes: {
        homoglifos: false,
        homoglifosIntensidade: 100,
        invisiveis: false,
        invisiveisQtd: 4,
        invisiveisComEspaco: true,
      },
      ritmo: {
        intervaloMin: 20,
        intervaloMax: 45,
        loteMin: 8,
        loteMax: 12,
        pausaLoteMin: 5,
        pausaLoteMax: 10,
      },
      pastas: [],
    });
  }

  function criarNova() {
    campanha = novaCampanha();
    linhasVisiveis = LINHAS_POR_PAGINA;
    linhasPorId = Object.create(null);
    ids.push(campanha.id);
    $("lista").value = "";
    $("log").innerHTML = "";
    execucao = null;
    renderizarFormulario();
    analisarLista();
    salvar();
  }

  function iniciarNovaSeVazio() {
    if (!campanha) {
      criarNova();
      return;
    }
    renderizarFormulario();
  }

  function iniciarPagina() {
    ligarEventos();
    ligarTecladoAbas();
    renderizarIndicadorSalvar();
    instalarSalvamentoAoSair();

    ler([CHAVE_INDICE]).then(function (d) {
      ids = d[CHAVE_INDICE] || [];

      if (!ids.length) {
        criarNova();
        atualizarAvisoWhatsApp();
        return;
      }

      return carregar(ids[ids.length - 1]).then(function (c) {
        if (!c) {
          criarNova();
          atualizarAvisoWhatsApp();
          return;
        }
        // Reconcilia o que ficou do jeito que estava ao fechar a aba:
        // "executando" sem laço ativo vira pausada, e contato que estava
        // sendo enviado vira "desconhecido" (nunca reenviado sozinho).
        campanha = C.normalizarCampanha(c);
        anunciarRetomada(campanha);
        campanha.interrompida = false;
        $("lista").value = c.contatos
          .map(function (x) {
            return x.numero;
          })
          .join("\n");
        renderizarFormulario();
        analisarLista();
        renderizarSeletor();
        atualizarAvisoWhatsApp();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciarPagina);
  } else {
    iniciarPagina();
  }

  // exposto para os testes
  window.__LZ_CAMPANHA_UI__ = {
    enviarNoWhatsApp: enviarNoWhatsApp,
    getCampanha: function () {
      return campanha;
    },
    setCampanha: function (c) {
      campanha = C.normalizarCampanha(c);
      renderizarFormulario();
    },
    disparar: iniciar,
    analisarLista: analisarLista,
    pausar: pausar,
    retomar: retomar,
    cancelar: cancelar,
    // exposto para diagnóstico e testes de falha de armazenamento
    salvarAgora: salvar,
    // diagnóstico: carrega uma mídia e informa o tamanho do cache
    carregarMidia: function (id) {
      return lerMidia(id).then(function (d) {
        return { carregada: !!d, cache: Object.keys(midiasCache).length };
      });
    },
    // usado pelos testes de tipo de arquivo
    compativel: function (arquivo, tipoPasta) {
      return arquivoCompativel(arquivo, tipoPasta);
    },
    tamanhoCacheMidias: function () {
      return Object.keys(midiasCache).length;
    },
    // usado pelo medidor de desempenho da tabela
    renderizarTabela: renderizarTabela,
    renderizar: renderizar,
    estadoSalvamento: function () {
      return { falhou: falhaSalvamento, preparando: preparando };
    },
  };
})();
