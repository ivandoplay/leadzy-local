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

  function ler(chaves) {
    return new Promise(function (res) {
      chrome.storage.local.get(chaves, function (d) {
        res(d || {});
      });
    });
  }

  function gravar(obj) {
    return new Promise(function (res) {
      chrome.storage.local.set(obj, function () {
        res();
      });
    });
  }

  function remover(chaves) {
    return new Promise(function (res) {
      chrome.storage.local.remove(chaves, function () {
        res();
      });
    });
  }

  function salvar() {
    if (!campanha) return Promise.resolve();
    campanha.atualizadaEm = new Date().toISOString();

    var obj = {};
    obj[PREFIXO_CAMPANHA + campanha.id] = campanha;
    obj[CHAVE_INDICE] = ids;

    return gravar(obj).then(function () {
      renderizarSeletor();
    });
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

  function salvarEmLote(forcar) {
    naoSalvos++;
    var agora = Date.now();
    if (forcar || naoSalvos >= 10 || agora - ultimoSalvamento > 15000) {
      naoSalvos = 0;
      ultimoSalvamento = agora;
      return salvar();
    }
    return Promise.resolve();
  }

  function enviarContato(contato) {
    var partes = C.montarEnvio(campanha, contato.indice);
    if (!partes.length) return Promise.reject(new Error("nada para enviar (texto e mídia vazios)"));

    var chatId = C.paraChatId(contato.numero);
    var cadeia = Promise.resolve();

    partes.forEach(function (parte) {
      cadeia = cadeia.then(function () {
        var payload = { tipo: parte.tipo, chatId: chatId, timeoutMs: 60000 };

        if (parte.tipo === "texto") {
          payload.conteudo = parte.conteudo;
          return injetarEnvio(payload).then(function (r) {
            if (!r.ok) throw new Error(r.erro);
          });
        }

        return lerMidia(parte.arquivo.id).then(function (dataUrl) {
          if (!dataUrl) {
            throw new Error("arquivo da pasta “" + parte.pastaNome + "” não encontrado");
          }
          payload.base64 = dataUrl.split(",")[1];
          payload.nomeArquivo = parte.arquivo.nome;
          return injetarEnvio(payload).then(function (r) {
            if (!r.ok) throw new Error(r.erro);
          });
        });
      });
    });

    return cadeia;
  }

  function iniciar() {
    if (!campanha) return;

    var v = C.validar(campanha);
    if (!v.ok) {
      alert("Não dá para iniciar:\n\n• " + v.erros.join("\n• "));
      return;
    }

    if (C.limiteDiarioAtingido(campanha)) {
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
        renderizar();
        naoSalvos = 0;
        salvar();
        log("Campanha finalizada.", "info");
        return;
      }

      C.marcarEnviando(campanha, contato.indice);
      renderizar();

      enviarContato(contato)
        .then(function () {
          if (!aindaVale()) return;
          C.marcarEnviado(campanha, contato.indice);
          log("Enviado para " + contato.numero, "ok");
        })
        .catch(function (e) {
          if (!aindaVale()) return;
          C.marcarFalhou(campanha, contato.indice, e && e.message);
          log("Falhou " + contato.numero + ": " + (e && e.message), "erro");
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

  function renderizarTabela() {
    var corpo = $("corpo-tabela");
    if (!corpo) return;
    corpo.innerHTML = "";
    if (!campanha) return;

    campanha.contatos.forEach(function (c) {
      var tr = document.createElement("tr");

      var tds = [
        String(c.indice + 1),
        c.numero,
        null, // status (com tag)
        c.enviadoEm ? new Date(c.enviadoEm).toLocaleString("pt-BR") : "—",
        c.erro || "—",
      ];

      tds.forEach(function (valor, i) {
        var td = document.createElement("td");
        if (i === 2) {
          var tag = document.createElement("span");
          tag.className = "status-tag st-" + c.status;
          tag.textContent = c.status;
          td.appendChild(tag);
        } else {
          td.textContent = valor;
        }
        tr.appendChild(td);
      });

      var tdAcao = document.createElement("td");
      if (c.status === "pendente" || c.status === "falhou") {
        var btn = document.createElement("button");
        btn.className = "btn btn-sec btn-pequeno";
        btn.textContent = "Remover";
        btn.onclick = function () {
          var n = C.removerPendentes(campanha, [c.numero]);
          if (n) {
            log("Removido da fila: " + c.numero, "info");
            renderizarTabela();
            renderizar();
            salvar();
          }
        };
        tdAcao.appendChild(btn);
      }
      tr.appendChild(tdAcao);

      corpo.appendChild(tr);
    });
  }

  function renderizarProgresso() {
    if (!campanha) return;

    var p = C.progresso(campanha);
    $("progresso-barra").style.width = p.percentual + "%";
    $("progresso-percentual").textContent = p.percentual + "%";
    $("c-enviados").textContent = p.enviados;
    $("c-falhas").textContent = p.falharam;
    $("c-pendentes").textContent = p.pendentes;
    $("c-total").textContent = p.total;

    var rotulo = {
      rascunho: "Aguardando início",
      executando: "Enviando…",
      pausada: "Pausado",
      finalizada: "Finalizada",
      cancelada: "Cancelada",
    }[campanha.status];

    $("progresso-texto").textContent = rotulo + " — " + p.processados + " de " + p.total;

    var stats = C.estatisticas(campanha);
    $("enviados-hoje").textContent = stats.enviadosHoje;
    $("limite-info").textContent = campanha.protecoes.limiteDiario
      ? "de " + campanha.protecoes.limiteDiario + " permitidas hoje"
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

    var texto = min < 60 ? min + " minutos" : (min / 60).toFixed(1) + " horas";
    $("estimativa").textContent = texto + " para " + pendentes + " mensagens";
  }

  function renderizarFormulario() {
    if (!campanha) return;

    $("nome").value = campanha.nome || "";

    // modo de texto
    document.querySelectorAll(".seg").forEach(function (b) {
      b.classList.toggle("ativo", b.dataset.modo === campanha.texto.modo);
    });
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
        pasta.tipo = tipo.value;
        salvarComDebounce();
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
      input.accept = pasta.tipo === "audio" ? "audio/*" : pasta.tipo === "imagem" ? "image/*" : "";
      input.onchange = function () {
        var arquivos = Array.prototype.slice.call(input.files || []);
        if (!arquivos.length) return;
        Promise.all(
          arquivos.map(function (f) {
            var id = novoId("m-");
            return arquivoParaDataUrl(f).then(function (dataUrl) {
              midiasCache[id] = dataUrl;
              var obj = {};
              obj[PREFIXO_MIDIA + id] = dataUrl;
              return gravar(obj).then(function () {
                pasta.itens.push({ id: id, nome: f.name, tamanho: f.size, tipo: pasta.tipo });
              });
            });
          })
        ).then(function () {
          renderizarPastas();
          salvar();
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
  }

  /* ==========================================================================
   * LIGAÇÕES DE EVENTOS
   * ======================================================================== */

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

    $("btn-reproc").onclick = function () {
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
      if (campanha && campanha.contatos.length) {
        if (!confirm("Criar uma campanha nova? A atual fica salva na lista.")) return;
      }
      criarNova();
    };

    $("btn-excluir").onclick = function () {
      if (!campanha) return;
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
      if (!id) return;
      carregar(id).then(function (c) {
        if (!c) return;
        campanha = c;
        execucao = null;
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
        campanha = c;
        campanha.contatos.forEach(function (x, i) {
          x.indice = i;
        });
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
      campanha = c;
      renderizarFormulario();
    },
    disparar: iniciar,
    analisarLista: analisarLista,
    pausar: pausar,
    retomar: retomar,
    cancelar: cancelar,
  };
})();
